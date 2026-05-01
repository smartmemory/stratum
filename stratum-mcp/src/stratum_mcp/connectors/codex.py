"""CodexConnector — spawns `codex exec --json` directly for each prompt.

Ported from compose/server/connectors/codex-connector.js (commit f552c7f,
2026-04-18). Replaces the previous opencode-backed implementation, which was
left in place when the JS side migrated and caused `stratum_agent_run type="codex"`
to hang indefinitely against a subprocess that could no longer authenticate.

Uses the OpenAI Codex CLI (`codex`, installed via `npm i -g @openai/codex` or
`brew install codex`). Auth: run `codex login` once, or set ``OPENAI_API_KEY``.

Model IDs take the form ``<model>`` or ``<model>/<effort>`` where effort is one
of ``minimal|low|medium|high|xhigh``. The effort suffix is split off and passed
as ``-c model_reasoning_effort="<effort>"``.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import time
from typing import Any, AsyncIterator, Optional

from ..events import INTERNAL_RESULT_KIND, ConnectorEvent
from .base import AgentConnector, Event, inject_schema

CODEX_MODEL_IDS: frozenset[str] = frozenset(
    {
        "gpt-5.4",
        "gpt-5.4/low",
        "gpt-5.4/medium",
        "gpt-5.4/high",
        "gpt-5.4/xhigh",
        "gpt-5.2-codex",
        "gpt-5.2-codex/low",
        "gpt-5.2-codex/medium",
        "gpt-5.2-codex/high",
        "gpt-5.2-codex/xhigh",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-max/low",
        "gpt-5.1-codex-max/medium",
        "gpt-5.1-codex-max/high",
        "gpt-5.1-codex-max/xhigh",
        "gpt-5.1-codex",
        "gpt-5.1-codex/low",
        "gpt-5.1-codex/medium",
        "gpt-5.1-codex/high",
        "gpt-5.1-codex-mini",
        "gpt-5.1-codex-mini/medium",
        "gpt-5.1-codex-mini/high",
    }
)

_DEFAULT_MODEL_ID = os.environ.get("CODEX_MODEL", "gpt-5.4")
_AGENT_NAME = "codex"

# Cross-provider creds to scrub from codex's env. OPENAI_API_KEY is NOT scrubbed:
# codex uses it as a fallback when OAuth credentials are absent.
_CODEX_SCRUB_VARS = ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE")

_AUTH_ERROR_MARKERS = (
    "rate limit",
    "rate_limit",
    "quota",
    "insufficient_quota",
    "unauthorized",
    "401",
    "403",
    "authentication",
    "not logged in",
    "login required",
    "billing",
    "exceeded",
)

STALL_TIMEOUT_SECONDS = 120
STALL_CHECK_INTERVAL_SECONDS = 30


def _resolve_stdout_limit() -> int:
    """Buffer ceiling for the codex subprocess StreamReader.

    The asyncio default of 64 KiB is too small for codex's ``--json`` preamble:
    its first line includes the resolved model config, sandbox profile, cwd,
    and the full prompt echo, which routinely exceeds 64 KiB and triggers
    ``LimitOverrunError`` before any agent event is yielded
    (STRAT-MCP-CHUNK-SIZE).
    """
    raw = os.environ.get("STRATUM_CODEX_STREAM_LIMIT_BYTES")
    if raw:
        try:
            value = int(raw)
        except ValueError:
            value = 4 * 1024 * 1024
    else:
        value = 4 * 1024 * 1024
    return max(value, 64 * 1024)


_CODEX_STDOUT_LIMIT = _resolve_stdout_limit()
_CHUNK_OVERRUN_HINT = (
    "codex stdout exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES "
    f"(current limit {_CODEX_STDOUT_LIMIT} bytes). Raise the env knob and retry."
)


def _is_limit_error(exc: BaseException) -> bool:
    """asyncio.StreamReader.readline() wraps LimitOverrunError as ValueError
    in Python 3.12+, preserving the original message. Match on either path."""
    if isinstance(exc, asyncio.LimitOverrunError):
        return True
    msg = str(exc).lower()
    return "chunk" in msg and "limit" in msg


def _assert_codex_model(model_id: str) -> None:
    if model_id not in CODEX_MODEL_IDS:
        supported = ", ".join(sorted(CODEX_MODEL_IDS))
        raise ValueError(
            f"CodexConnector: '{model_id}' is not a supported Codex model.\n"
            f"Supported models: {supported}"
        )


class CodexConnector(AgentConnector):
    """Spawns the `codex` CLI directly per prompt."""

    def __init__(
        self, *, model_id: str = _DEFAULT_MODEL_ID, cwd: Optional[str] = None
    ):
        _assert_codex_model(model_id)
        self._default_model_id = model_id
        self._cwd = cwd or os.getcwd()
        self._proc: Optional[asyncio.subprocess.Process] = None

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,  # ignored — codex is always OpenAI
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,  # unused
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[Event]:
        if self._proc is not None:
            raise RuntimeError(
                f"{_AGENT_NAME}: run() already active. Call interrupt() first."
            )

        resolved_model_id = model_id or self._default_model_id
        _assert_codex_model(resolved_model_id)
        resolved_cwd = cwd or self._cwd
        actual_prompt = inject_schema(prompt, schema) if schema else prompt

        base_model, _, effort = resolved_model_id.partition("/")

        yield {
            "type": "system",
            "subtype": "init",
            "agent": _AGENT_NAME,
            "model": resolved_model_id,
        }

        args = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-m",
            base_model,
            "-C",
            resolved_cwd,
        ]
        if effort:
            args.extend(["-c", f'model_reasoning_effort="{effort}"'])
        args.append("-")  # read prompt from stdin

        clean_env = dict(env) if env is not None else dict(os.environ)
        for var in _CODEX_SCRUB_VARS:
            clean_env.pop(var, None)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                "codex",
                *args,
                cwd=resolved_cwd,
                env=clean_env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_CODEX_STDOUT_LIMIT,
            )
        except FileNotFoundError:
            yield {
                "type": "error",
                "message": (
                    f"{_AGENT_NAME}: codex binary not found on PATH. "
                    "Install with: npm i -g @openai/codex  (or: brew install codex)"
                ),
            }
            return
        proc = self._proc

        assert proc.stdin is not None
        proc.stdin.write(actual_prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        text_parts: list[str] = []
        stderr_chunks: list[bytes] = []
        last_event_at = time.monotonic()

        async def _drain_stderr() -> None:
            assert proc.stderr is not None
            while True:
                chunk = await proc.stderr.readline()
                if not chunk:
                    break
                stderr_chunks.append(chunk)
                text = chunk.decode("utf-8", errors="replace")
                lower = text.lower()
                if any(marker in lower for marker in _AUTH_ERROR_MARKERS):
                    sys.stderr.write(
                        f"\n⚠ {_AGENT_NAME}: {text.strip()}\n"
                        "  → Check login: codex login status\n"
                        "  → Re-auth:    codex login\n\n"
                    )

        async def _stall_warn() -> None:
            while proc.returncode is None:
                await asyncio.sleep(STALL_CHECK_INTERVAL_SECONDS)
                silent = int(time.monotonic() - last_event_at)
                if silent >= STALL_TIMEOUT_SECONDS:
                    sys.stderr.write(
                        f"\n⚠ {_AGENT_NAME}: no response for {silent}s — "
                        "may be stalled or rate-limited\n"
                    )

        stderr_task = asyncio.create_task(_drain_stderr())
        stall_task = asyncio.create_task(_stall_warn())

        try:
            assert proc.stdout is not None
            overrun = False
            while True:
                try:
                    line_bytes = await proc.stdout.readline()
                except (asyncio.LimitOverrunError, ValueError) as exc:
                    if not _is_limit_error(exc):
                        raise
                    overrun = True
                    break
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                last_event_at = time.monotonic()

                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                for envelope_event in _translate_codex_event(event, resolved_model_id):
                    if envelope_event.get("type") == "assistant":
                        content = envelope_event.get("content")
                        if content:
                            text_parts.append(content)
                    yield envelope_event

            if overrun:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                await proc.wait()
                yield {
                    "type": "error",
                    "message": _CHUNK_OVERRUN_HINT,
                }
                return

            exit_code = await proc.wait()

            if exit_code != 0 and not text_parts:
                stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")
                yield {
                    "type": "error",
                    "message": stderr_text or f"codex exited with code {exit_code}",
                }
            else:
                full_text = "".join(text_parts)
                if full_text:
                    yield {"type": "result", "content": full_text}
                yield {
                    "type": "system",
                    "subtype": "complete",
                    "agent": _AGENT_NAME,
                }
        finally:
            stall_task.cancel()
            stderr_task.cancel()
            for t in (stall_task, stderr_task):
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            self._proc = None

    async def stream_events(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[ConnectorEvent]:
        # NOTE: parallel duplication of the codex JSONL driver from run();
        # marked for cleanup under STRAT-DEDUP-AGENTRUN-V3.
        if self._proc is not None:
            raise RuntimeError(
                f"{_AGENT_NAME}: stream_events() already active. Call interrupt() first."
            )

        resolved_model_id = model_id or self._default_model_id
        _assert_codex_model(resolved_model_id)
        resolved_cwd = cwd or self._cwd
        actual_prompt = inject_schema(prompt, schema) if schema else prompt

        base_model, _, effort = resolved_model_id.partition("/")

        args = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-m",
            base_model,
            "-C",
            resolved_cwd,
        ]
        if effort:
            args.extend(["-c", f'model_reasoning_effort="{effort}"'])
        args.append("-")

        clean_env = dict(env) if env is not None else dict(os.environ)
        for var in _CODEX_SCRUB_VARS:
            clean_env.pop(var, None)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                "codex",
                *args,
                cwd=resolved_cwd,
                env=clean_env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=_CODEX_STDOUT_LIMIT,
            )
        except FileNotFoundError:
            raise RuntimeError(
                f"{_AGENT_NAME}: codex binary not found on PATH. "
                "Install with: npm i -g @openai/codex  (or: brew install codex)"
            )
        proc = self._proc
        assert proc.stdin is not None
        proc.stdin.write(actual_prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        text_parts: list[str] = []
        stderr_chunks: list[bytes] = []

        async def _drain_stderr() -> None:
            assert proc.stderr is not None
            while True:
                chunk = await proc.stderr.readline()
                if not chunk:
                    break
                stderr_chunks.append(chunk)

        stderr_task = asyncio.create_task(_drain_stderr())
        try:
            assert proc.stdout is not None
            agent_started_yielded = False
            while True:
                try:
                    line_bytes = await proc.stdout.readline()
                except (asyncio.LimitOverrunError, ValueError) as exc:
                    if not _is_limit_error(exc):
                        raise
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    raise RuntimeError(
                        f"{_AGENT_NAME}: {_CHUNK_OVERRUN_HINT}"
                    ) from exc
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                etype = event.get("type")

                if etype == "thread.started" and not agent_started_yielded:
                    agent_started_yielded = True
                    yield ConnectorEvent(
                        kind="agent_started",
                        metadata={
                            "agent": _AGENT_NAME,
                            "model": resolved_model_id,
                            "prompt_chars": len(prompt),
                        },
                    )
                    continue

                if etype == "item.completed" and event.get("item"):
                    item = event["item"]
                    itype = item.get("type")
                    if itype == "agent_message":
                        text = item.get("text") or ""
                        if text:
                            text_parts.append(text)
                            yield ConnectorEvent(
                                kind="agent_relay",
                                metadata={"text": text, "role": "assistant"},
                            )
                    elif itype == "command_execution":
                        cmd = item.get("command")
                        if cmd is None:
                            cmd = (item.get("input") or {}).get("command") or ""
                        cmd_s = str(cmd)
                        summary = cmd_s if len(cmd_s) <= 80 else cmd_s[:77] + "..."
                        exit_code = item.get("exit_code")
                        ok = exit_code == 0 if exit_code is not None else True
                        yield ConnectorEvent(
                            kind="tool_use_summary",
                            metadata={
                                "tool": "bash",
                                "summary": summary,
                                "ok": bool(ok),
                                "duration_ms": int(item.get("duration_ms") or 0),
                            },
                        )
                    elif itype == "reasoning":
                        text = item.get("text") or ""
                        if text:
                            yield ConnectorEvent(
                                kind="agent_relay",
                                metadata={"text": text, "role": "system"},
                            )
                    elif itype == "file_change":
                        path = item.get("path") or ""
                        yield ConnectorEvent(
                            kind="tool_use_summary",
                            metadata={
                                "tool": "edit",
                                "summary": f"edit {path}"[:80],
                                "ok": True,
                                "duration_ms": 0,
                            },
                        )
                elif etype == "turn.completed" and event.get("usage"):
                    u = event["usage"]
                    yield ConnectorEvent(
                        kind="step_usage",
                        metadata={
                            "input_tokens": u.get("input_tokens") or 0,
                            "output_tokens": u.get("output_tokens") or 0,
                            "cache_creation_input_tokens": 0,
                            "cache_read_input_tokens": u.get("cached_input_tokens") or 0,
                            "cost_usd": 0,
                            "model": resolved_model_id,
                        },
                    )
                elif etype == "error":
                    raise RuntimeError(event.get("message") or "codex error")

            exit_code = await proc.wait()
            if exit_code != 0 and not text_parts:
                stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")
                raise RuntimeError(
                    stderr_text or f"codex exited with code {exit_code}"
                )
            full_text = "".join(text_parts)
            if full_text:
                yield ConnectorEvent(
                    kind=INTERNAL_RESULT_KIND,
                    metadata={"content": full_text},
                )
        finally:
            stderr_task.cancel()
            try:
                await stderr_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._proc = None

    def interrupt(self) -> None:
        """Send SIGTERM to the running codex subprocess. Idempotent."""
        proc = self._proc
        if proc is None:
            return
        if proc.returncode is not None:
            return
        try:
            proc.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            return

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None


def _translate_codex_event(event: dict, resolved_model_id: str) -> list[Event]:
    """Map a `codex exec --json` event to zero or more envelope events.

    Event shapes from codex:
        {"type": "thread.started", "thread_id": "..."}
        {"type": "turn.started"}
        {"type": "item.started" | "item.updated" | "item.completed", "item": {...}}
        {"type": "turn.completed", "usage": {input_tokens, cached_input_tokens, output_tokens}}
        {"type": "error", "message": "..."}
    """
    etype = event.get("type")

    if etype == "item.completed" and event.get("item"):
        item = event["item"]
        itype = item.get("type")

        if itype == "agent_message":
            text = item.get("text") or ""
            if text:
                return [{"type": "assistant", "content": text}]
            return []

        if itype == "command_execution":
            cmd = item.get("command")
            if cmd is None:
                cmd = (item.get("input") or {}).get("command") or ""
            events: list[Event] = [
                {"type": "tool_use", "tool": "bash", "input": {"command": cmd}}
            ]
            out = item.get("aggregated_output") or item.get("output") or ""
            if out:
                short = out[:77] + "..." if len(out) > 80 else out
                events.append(
                    {
                        "type": "tool_use_summary",
                        "summary": short,
                        "output": str(out)[:2048],
                    }
                )
            return events

        if itype == "file_change":
            return [
                {
                    "type": "tool_use",
                    "tool": "edit",
                    "input": {"path": item.get("path") or ""},
                }
            ]

        if itype == "reasoning":
            text = item.get("text") or ""
            if text:
                return [{"type": "assistant", "content": text}]
            return []

        return []

    if etype == "turn.completed" and event.get("usage"):
        u = event["usage"]
        return [
            {
                "type": "usage",
                "input_tokens": u.get("input_tokens") or 0,
                "output_tokens": u.get("output_tokens") or 0,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": u.get("cached_input_tokens") or 0,
                "cost_usd": 0,
                "model": resolved_model_id,
            }
        ]

    if etype == "error":
        return [{"type": "error", "message": event.get("message") or "codex error"}]

    return []
