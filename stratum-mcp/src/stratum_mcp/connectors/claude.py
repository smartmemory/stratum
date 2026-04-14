"""ClaudeConnector — wraps claude-agent-sdk query().

Port of compose/server/connectors/claude-sdk-connector.js:13-175 (T2-F5).
Preserves the Node envelope shape so the MCP tool contract stays stable.
"""
from __future__ import annotations

import os
from typing import Any, AsyncIterator, Optional

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    query,
)
from claude_agent_sdk.types import TextBlock, ToolUseBlock

from .base import SENSITIVE_ENV_VARS, AgentConnector, Event, inject_schema

DEFAULT_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")


class ClaudeConnector(AgentConnector):
    """Wraps claude_agent_sdk.query(). Matches the Node ClaudeSDKConnector."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        cwd: Optional[str] = None,
        allowed_tools: Optional[list[str]] = None,
        disallowed_tools: Optional[list[str]] = None,
    ):
        self._model = model
        self._cwd = cwd or os.getcwd()
        self._allowed_tools = allowed_tools
        self._disallowed_tools = disallowed_tools
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

    def interrupt(self) -> None:
        """No-op. Claude's SDK has no cancel API today — asyncio cancellation
        still unwinds the coroutine but the in-flight network call is not
        propagated. Tracked for follow-up as T2-F5-CLAUDE-CANCEL.
        """

    @property
    def is_running(self) -> bool:
        return self._active


def _normalize(msg: Any, active_model: str) -> list[Event]:
    """Convert an SDK message into zero or more envelope events.

    SDK usage fields are plain dicts (type: dict[str, Any] | None). AssistantMessage
    has `content` (list of blocks) and optional `usage`. ResultMessage has `result`
    (final text) and optional `usage`.
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
