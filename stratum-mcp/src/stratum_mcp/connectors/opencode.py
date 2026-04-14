"""OpencodeConnector — spawns `opencode run --format json` for each prompt.

Port of compose/server/connectors/opencode-connector.js:21-195 (T2-F5).
Model-agnostic base for any non-Anthropic agent running through opencode.
Subclasses (e.g. CodexConnector) constrain to specific provider/model sets.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any, AsyncIterator, Optional

from .base import SENSITIVE_ENV_VARS, AgentConnector, Event, inject_schema

RATE_LIMIT_MARKERS = (
    "rate limit",
    "rate_limit",
    "quota",
    "insufficient_quota",
    "unauthorized",
    "401",
    "403",
    "authentication",
    "auth",
    "billing",
    "exceeded",
    "capacity",
)

STALL_TIMEOUT_SECONDS = 120
STALL_CHECK_INTERVAL_SECONDS = 30


class OpencodeConnector(AgentConnector):
    """Spawns `opencode run --format json` per prompt."""

    def __init__(
        self,
        *,
        provider_id: str,
        model_id: str,
        cwd: Optional[str] = None,
        agent_name: str = "opencode",
    ):
        self._default_provider_id = provider_id
        self._default_model_id = model_id
        self._cwd = cwd or os.getcwd()
        self._agent_name = agent_name
        self._proc: Optional[asyncio.subprocess.Process] = None

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,  # unused
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[Event]:
        """Spawn `opencode run` for the prompt.

        Args:
            env: Optional environment mapping used as the baseline for the
                spawned subprocess. When ``None``, inherits ``os.environ``.
                Regardless of source, :data:`SENSITIVE_ENV_VARS` are always
                scrubbed from the env handed to the subprocess.
        """
        if self._proc is not None:
            raise RuntimeError(f"{self._agent_name}: run() already active")

        resolved_provider = provider_id or self._default_provider_id
        resolved_model = model_id or self._default_model_id
        resolved_cwd = cwd or self._cwd
        actual_prompt = inject_schema(prompt, schema) if schema else prompt

        yield {
            "type": "system",
            "subtype": "init",
            "agent": self._agent_name,
            "model": f"{resolved_provider}/{resolved_model}",
        }

        clean_env = dict(env) if env is not None else dict(os.environ)
        for var in SENSITIVE_ENV_VARS:
            clean_env.pop(var, None)

        try:
            self._proc = await asyncio.create_subprocess_exec(
                "opencode",
                "run",
                "-m",
                f"{resolved_provider}/{resolved_model}",
                "--format",
                "json",
                actual_prompt,
                cwd=resolved_cwd,
                env=clean_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            yield {
                "type": "error",
                "message": (
                    f"{self._agent_name}: opencode binary not found on PATH. "
                    "Install with: brew install opencode"
                ),
            }
            return
        proc = self._proc

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
                lower = chunk.decode("utf-8", errors="replace").lower()
                if any(marker in lower for marker in RATE_LIMIT_MARKERS):
                    sys.stderr.write(
                        f"\n⚠ {self._agent_name}: "
                        f"{chunk.decode('utf-8', 'replace').strip()}\n"
                    )
                    sys.stderr.write("  → Check account: opencode auth status\n")
                    sys.stderr.write("  → Switch account: opencode auth login\n\n")

        async def _stall_warn() -> None:
            while proc.returncode is None:
                await asyncio.sleep(STALL_CHECK_INTERVAL_SECONDS)
                silent = int(time.monotonic() - last_event_at)
                if silent >= STALL_TIMEOUT_SECONDS:
                    sys.stderr.write(
                        f"\n⚠ {self._agent_name}: no response for {silent}s — "
                        f"may be stalled or rate-limited\n"
                    )

        stderr_task = asyncio.create_task(_drain_stderr())
        stall_task = asyncio.create_task(_stall_warn())

        try:
            assert proc.stdout is not None
            while True:
                line_bytes = await proc.stdout.readline()
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

                for envelope_event in _translate_opencode_event(event, resolved_model):
                    if envelope_event.get("type") == "assistant":
                        content = envelope_event.get("content")
                        if content:
                            text_parts.append(content)
                    yield envelope_event

            exit_code = await proc.wait()

            if exit_code != 0 and not text_parts:
                stderr_text = b"".join(stderr_chunks).decode("utf-8", errors="replace")
                yield {
                    "type": "error",
                    "message": stderr_text or f"opencode exited with code {exit_code}",
                }
            else:
                full_text = "".join(text_parts)
                if full_text:
                    yield {"type": "result", "content": full_text}
                yield {
                    "type": "system",
                    "subtype": "complete",
                    "agent": self._agent_name,
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

    def interrupt(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass

    @property
    def is_running(self) -> bool:
        return self._proc is not None and self._proc.returncode is None


def _translate_opencode_event(event: dict, resolved_model: str) -> list[Event]:
    """Turn an opencode JSON event into zero or more envelope events.

    Separated from run() so the subprocess loop stays readable and the
    translation logic can be unit-tested directly.
    """
    etype = event.get("type")

    if etype == "text":
        text = (event.get("part") or {}).get("text") or ""
        if text:
            return [{"type": "assistant", "content": text}]
        return []

    if etype == "tool_use":
        part = event.get("part") or {}
        state = part.get("state") or {}
        input_ = state.get("input") or {}
        tool = part.get("tool") or ("bash" if input_.get("command") else "unknown")
        events: list[Event] = [
            {"type": "tool_use", "tool": tool, "input": input_}
        ]
        output = state.get("output")
        if isinstance(output, str) and output:
            short = output[:77] + "..." if len(output) > 80 else output
            events.append(
                {"type": "tool_use_summary", "summary": short, "output": output[:2048]}
            )
        return events

    if etype == "step_finish":
        part = event.get("part") or {}
        cost = part.get("cost")
        tokens = part.get("tokens") or {}
        if cost is None and not tokens:
            return []
        return [
            {
                "type": "usage",
                "input_tokens": tokens.get("input") or 0,
                "output_tokens": tokens.get("output") or 0,
                "cache_creation_input_tokens": tokens.get("cache_write") or 0,
                "cache_read_input_tokens": tokens.get("cache_read") or 0,
                "cost_usd": cost or 0,
                "model": resolved_model,
            }
        ]

    return []
