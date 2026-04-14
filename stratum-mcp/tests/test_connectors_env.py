"""Tests for AgentConnector.run() env parameter and SENSITIVE_ENV_VARS (T2-F5-ENFORCE T2).

These tests pin the public contract of the base connector:
  - run() accepts a keyword-only `env` parameter that defaults to None
  - SENSITIVE_ENV_VARS is a tuple with the exact expected shape

Concrete-connector scrubbing behavior (claude/codex/opencode honoring the env
baseline + scrubbing SENSITIVE_ENV_VARS) is T5 and is tested separately.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Optional

import pytest

from stratum_mcp.connectors.base import AgentConnector, SENSITIVE_ENV_VARS


async def _collect(agen):
    return [event async for event in agen]


class _StubConnector(AgentConnector):
    """Trivial subclass that records run() kwargs and yields one event."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[dict]:
        self.calls.append(
            {
                "prompt": prompt,
                "schema": schema,
                "model_id": model_id,
                "provider_id": provider_id,
                "cwd": cwd,
                "tools": tools,
                "env": env,
            }
        )
        yield {"type": "system", "subtype": "complete"}


@pytest.mark.asyncio
async def test_run_accepts_env_kwarg():
    """run() must accept env={...} and still work with no env kwarg (legacy callers)."""
    conn = _StubConnector()

    # With env kwarg — should not raise TypeError
    events_with_env = await _collect(conn.run(prompt="hi", env={"FOO": "bar"}))
    assert len(events_with_env) == 1

    # Without env kwarg — legacy call path
    events_without_env = await _collect(conn.run(prompt="hi"))
    assert len(events_without_env) == 1

    # Verify both calls recorded with correct env values
    assert len(conn.calls) == 2
    assert conn.calls[0]["env"] == {"FOO": "bar"}
    assert conn.calls[1]["env"] is None


def test_sensitive_env_vars_tuple_shape():
    """SENSITIVE_ENV_VARS is a tuple with exactly these four names in this order."""
    assert isinstance(SENSITIVE_ENV_VARS, tuple)
    assert SENSITIVE_ENV_VARS == (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDECODE",
    )
