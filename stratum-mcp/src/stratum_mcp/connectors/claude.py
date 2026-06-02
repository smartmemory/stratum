"""ClaudeConnector — wraps claude-agent-sdk query().

Port of compose/server/connectors/claude-sdk-connector.js:13-175 (T2-F5).
Preserves the Node envelope shape so the MCP tool contract stays stable.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator, Optional

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    query,
)
from claude_agent_sdk.types import (
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from ..events import INTERNAL_RESULT_KIND, ConnectorEvent
from .base import SENSITIVE_ENV_VARS, AgentConnector, Event, inject_schema

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")

# STRAT-PAR-STREAM-TOOLDETAIL: cap raw tool input / result text surfaced on the
# stream. The raw input is already visible to the agent + host, so v1 size-caps
# only (no secret redaction — documented residual in the design doc).
_TOOL_DETAIL_CAP = 2048


class ClaudeConnector(AgentConnector):
    """Wraps claude_agent_sdk.query(). Matches the Node ClaudeSDKConnector."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        cwd: Optional[str] = None,
        allowed_tools: Optional[list[str]] = None,
        disallowed_tools: Optional[list[str]] = None,
        thinking: Optional[dict] = None,
        effort: Optional[str] = None,
    ):
        self._model = model
        self._cwd = cwd or os.getcwd()
        self._allowed_tools = allowed_tools
        self._disallowed_tools = disallowed_tools
        self._thinking = thinking
        # `effort` accepted for API parity with codex tier; claude-agent-sdk has
        # no effort parameter, so this is a no-op for claude (matches JS behavior).
        self._effort = effort
        self._active = False

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,  # unused for claude
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,  # use __init__ allowed_tools instead
        env: Optional[dict[str, str]] = None,
        thinking: Optional[dict] = None,
        effort: Optional[str] = None,
    ) -> AsyncIterator[Event]:
        """Run a prompt against the Claude agent SDK.

        Args:
            env: Optional environment mapping used as the baseline for the
                SDK options. When ``None``, inherits ``os.environ``. Regardless
                of source, :data:`SENSITIVE_ENV_VARS` are always scrubbed from
                the env handed to the SDK (defense-in-depth).
        """
        if self._active:
            raise RuntimeError("ClaudeConnector: run() already active")

        actual_prompt = inject_schema(prompt, schema) if schema else prompt
        active_model = model_id or self._model
        active_cwd = cwd or self._cwd

        clean_env = dict(env) if env is not None else dict(os.environ)
        for var in SENSITIVE_ENV_VARS:
            clean_env.pop(var, None)

        options_kwargs: dict[str, Any] = {
            "cwd": active_cwd,
            "model": active_model,
            "permission_mode": "acceptEdits",
            "env": clean_env,
        }
        # Match Node's tools logic (claude-sdk-connector.js:47-59):
        # - explicit allow-list → use it, optional disallow-list alongside
        # - only disallow-list → claude_code preset + disallow-list
        # - neither → claude_code preset (full Claude Code toolset)
        if self._allowed_tools is not None:
            options_kwargs["allowed_tools"] = self._allowed_tools
            if self._disallowed_tools is not None:
                options_kwargs["disallowed_tools"] = self._disallowed_tools
        else:
            options_kwargs["tools"] = {"type": "preset", "preset": "claude_code"}
            if self._disallowed_tools is not None:
                options_kwargs["disallowed_tools"] = self._disallowed_tools

        active_thinking = thinking if thinking is not None else self._thinking
        if active_thinking is not None:
            options_kwargs["thinking"] = active_thinking

        options = ClaudeAgentOptions(**options_kwargs)

        self._active = True
        try:
            yield {
                "type": "system",
                "subtype": "init",
                "agent": "claude",
                "model": active_model,
            }
            async for msg in query(prompt=actual_prompt, options=options):
                for event in _normalize(msg, active_model):
                    yield event
            yield {"type": "system", "subtype": "complete", "agent": "claude"}
        except Exception as err:  # noqa: BLE001 — match Node's broad catch
            yield {"type": "error", "message": str(err)}
        finally:
            self._active = False

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
        thinking: Optional[dict] = None,
        effort: Optional[str] = None,
    ) -> AsyncIterator[ConnectorEvent]:
        # NOTE: parallel duplication of the SDK driver from run(); marked for
        # cleanup under STRAT-DEDUP-AGENTRUN-V3. Each connector instance is
        # single-use (self._active flag), so run() and stream_events() are
        # never invoked concurrently against the same instance.
        if self._active:
            raise RuntimeError("ClaudeConnector: stream_events() already active")

        actual_prompt = inject_schema(prompt, schema) if schema else prompt
        active_model = model_id or self._model
        active_cwd = cwd or self._cwd

        clean_env = dict(env) if env is not None else dict(os.environ)
        for var in SENSITIVE_ENV_VARS:
            clean_env.pop(var, None)

        options_kwargs: dict[str, Any] = {
            "cwd": active_cwd,
            "model": active_model,
            "permission_mode": "acceptEdits",
            "env": clean_env,
        }
        if self._allowed_tools is not None:
            options_kwargs["allowed_tools"] = self._allowed_tools
            if self._disallowed_tools is not None:
                options_kwargs["disallowed_tools"] = self._disallowed_tools
        else:
            options_kwargs["tools"] = {"type": "preset", "preset": "claude_code"}
            if self._disallowed_tools is not None:
                options_kwargs["disallowed_tools"] = self._disallowed_tools

        active_thinking = thinking if thinking is not None else self._thinking
        if active_thinking is not None:
            options_kwargs["thinking"] = active_thinking

        options = ClaudeAgentOptions(**options_kwargs)

        self._active = True
        try:
            yield ConnectorEvent(
                kind="agent_started",
                metadata={
                    "agent": "claude",
                    "model": active_model,
                    "prompt_chars": len(prompt),
                },
            )
            final_text: Optional[str] = None
            async for msg in query(prompt=actual_prompt, options=options):
                if isinstance(msg, AssistantMessage):
                    for block in msg.content:
                        if isinstance(block, TextBlock) and block.text:
                            yield ConnectorEvent(
                                kind="agent_relay",
                                metadata={"text": block.text, "role": "assistant"},
                            )
                        elif isinstance(block, ToolUseBlock):
                            # STRAT-PAR-STREAM-TOOLDETAIL: enrich the tool CALL
                            # event with raw (size-capped) input + a tool_use_id
                            # so consumers can recover input.file_path and
                            # correlate with the tool_result event. tool/summary/
                            # ok/duration_ms retained for back-compat.
                            yield ConnectorEvent(
                                kind="tool_use_summary",
                                metadata={
                                    "tool": block.name,
                                    "summary": _short_input_summary(block.input or {}),
                                    "ok": True,
                                    "duration_ms": 0,
                                    "input": _capped_tool_input(block.input or {}),
                                    "tool_use_id": block.id,
                                },
                            )
                elif isinstance(msg, UserMessage):
                    # STRAT-PAR-STREAM-TOOLDETAIL: the SDK delivers tool RESULTS
                    # as ToolResultBlocks inside a UserMessage. Emit a tool_result
                    # event per block with ok (= not is_error) + size-capped
                    # output, correlated to the call via tool_use_id. content may
                    # be a string OR a list of content blocks — coerce safely.
                    content = msg.content
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, ToolResultBlock):
                                yield ConnectorEvent(
                                    kind="tool_result",
                                    metadata={
                                        "tool_use_id": block.tool_use_id,
                                        "ok": not getattr(block, "is_error", False),
                                        "output": _cap_text(
                                            _tool_result_text(block.content)
                                        ),
                                    },
                                )
                elif isinstance(msg, ResultMessage):
                    if msg.result:
                        final_text = msg.result
                    if msg.usage:
                        yield ConnectorEvent(
                            kind="step_usage",
                            metadata={
                                "input_tokens": msg.usage.get("input_tokens", 0) or 0,
                                "output_tokens": msg.usage.get("output_tokens", 0) or 0,
                                "cache_creation_input_tokens": msg.usage.get(
                                    "cache_creation_input_tokens", 0
                                ) or 0,
                                "cache_read_input_tokens": msg.usage.get(
                                    "cache_read_input_tokens", 0
                                ) or 0,
                                "model": active_model,
                            },
                        )
            if final_text is not None:
                yield ConnectorEvent(
                    kind=INTERNAL_RESULT_KIND,
                    metadata={"content": final_text},
                )
        finally:
            self._active = False

    def interrupt(self) -> None:
        """No-op. Claude's SDK has no cancel API today — asyncio cancellation
        still unwinds the coroutine but the in-flight network call is not
        propagated. Tracked for follow-up as T2-F5-CLAUDE-CANCEL.
        """

    @property
    def is_running(self) -> bool:
        return self._active


def _short_input_summary(inp: dict, limit: int = 80) -> str:
    if isinstance(inp, dict) and len(inp) == 1:
        only_val = next(iter(inp.values()))
        if isinstance(only_val, str):
            s = only_val
            return s if len(s) <= limit else s[: limit - 3] + "..."
    try:
        s = json.dumps(inp)
    except (TypeError, ValueError):
        s = str(inp)
    return s if len(s) <= limit else s[: limit - 3] + "..."


def _cap_text(s: str, limit: int = _TOOL_DETAIL_CAP) -> str:
    """Size-cap a string for the stream so the emitted value stays within
    ``limit`` characters INCLUDING the truncation marker. Over-cap → keep a
    prefix and append ``"…[truncated N chars]"`` (N = chars dropped).

    STRAT-PAR-STREAM-TOOLDETAIL Decision 4 (character-based cap, ~2 KiB ASCII).
    """
    if len(s) <= limit:
        return s
    # Reserve room for the marker using len(s) as an upper bound on the dropped
    # count, so kept + marker is guaranteed <= limit (its digit count can only
    # shrink for the real, smaller dropped value).
    keep = max(0, limit - len(f"…[truncated {len(s)} chars]"))
    dropped = len(s) - keep
    return s[:keep] + f"…[truncated {dropped} chars]"


def _capped_tool_input(inp: Any) -> Any:
    """Surface the raw tool ``input`` on the stream, size-capped.

    Shallow: under-cap dicts pass through unchanged so a consumer can read
    ``input.file_path`` structurally (STRAT-PAR-STREAM-TOOLDETAIL Decision 1).
    Over-cap inputs collapse to the capped JSON string with a truncation marker.
    """
    if not isinstance(inp, dict):
        inp = {} if inp is None else inp
    try:
        serialized = json.dumps(inp)
    except (TypeError, ValueError):
        serialized = str(inp)
    if len(serialized) <= _TOOL_DETAIL_CAP:
        # Return the raw dict (not the JSON string) so structural access works.
        return inp
    return _cap_text(serialized)


def _tool_result_text(content: Any) -> str:
    """Coerce a ToolResultBlock's ``content`` (str | list[dict|block] | None)
    into a single string. STRAT-PAR-STREAM-TOOLDETAIL Decision 2."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                # SDK content blocks are {"type": "text", "text": "..."} etc.
                text = item.get("text")
                parts.append(text if isinstance(text, str) else json.dumps(item))
            else:
                text = getattr(item, "text", None)
                parts.append(text if isinstance(text, str) else str(item))
        return "\n".join(parts)
    return str(content)


def _normalize(msg: Any, active_model: str) -> list[Event]:
    """Convert an SDK message into zero or more envelope events.

    SDK usage fields are plain dicts (type: dict[str, Any] | None). AssistantMessage
    has `content` (list of blocks) and optional `usage`. ResultMessage has `result`
    (final text) and optional `usage`.

    STRAT-PAR-STREAM-TOOLDETAIL note: this non-streaming `run()` path already
    surfaces the full raw `input` on its `tool_use` event (uncapped) and feeds the
    legacy Node-envelope consumer, NOT parallel_dispatch. The tool-detail
    enrichment (tool_use_id + tool_result) lives only on the streaming
    `stream_events()` loop, which is what feeds parallel_dispatch. Left
    unenriched here to keep the run() envelope contract stable.
    """
    if isinstance(msg, AssistantMessage):
        events: list[Event] = []
        for block in msg.content:
            if isinstance(block, TextBlock) and block.text:
                events.append({"type": "assistant", "content": block.text})
            elif isinstance(block, ToolUseBlock):
                events.append(
                    {
                        "type": "tool_use",
                        "tool": block.name,
                        "input": block.input or {},
                    }
                )
        return events

    if isinstance(msg, ResultMessage):
        events: list[Event] = []
        if msg.result:
            events.append({"type": "result", "content": msg.result})
        if msg.usage:
            events.append(
                {
                    "type": "usage",
                    "input_tokens": msg.usage.get("input_tokens", 0) or 0,
                    "output_tokens": msg.usage.get("output_tokens", 0) or 0,
                    "cache_creation_input_tokens": msg.usage.get(
                        "cache_creation_input_tokens", 0
                    )
                    or 0,
                    "cache_read_input_tokens": msg.usage.get(
                        "cache_read_input_tokens", 0
                    )
                    or 0,
                    "model": active_model,
                }
            )
        return events

    return []
