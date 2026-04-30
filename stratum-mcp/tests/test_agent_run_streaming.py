"""Producer-side streaming tests for stratum_agent_run (STRAT-DEDUP-AGENTRUN-V3)."""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator, Optional

import pytest

from stratum_mcp.connectors import AgentConnector
from stratum_mcp.events import INTERNAL_RESULT_KIND, ConnectorEvent
from stratum_mcp import server as server_mod
from stratum_mcp.server import (
    stratum_agent_run,
    stratum_cancel_agent_run,
    _AGENT_RUN_TASKS,
)


class _FakeStreamingConnector(AgentConnector):
    def __init__(self, events: list[ConnectorEvent]):
        self._events = events

    async def run(self, prompt, **_ignored) -> AsyncIterator[dict]:
        # Not exercised when stream_events() exists.
        if False:
            yield {}
        return

    async def stream_events(self, prompt, **_ignored) -> AsyncIterator[ConnectorEvent]:
        for ev in self._events:
            yield ev


class _FakeLegacyConnector(AgentConnector):
    """Connector with only run() — no stream_events."""

    def __init__(self, events: list[dict]):
        self._events = events

    async def run(self, prompt, **_ignored) -> AsyncIterator[dict]:
        for ev in self._events:
            yield ev


class FakeCtx:
    def __init__(self) -> None:
        self.calls: list[tuple[int, str]] = []

    async def report_progress(self, progress: int, message: str) -> None:
        self.calls.append((progress, message))


def _install_streaming(monkeypatch, events):
    captured: dict[str, Any] = {}

    def _factory(agent_type, model_id, cwd, **kwargs):
        captured["agent_type"] = agent_type
        captured["model_id"] = model_id
        captured["cwd"] = cwd
        captured.update(kwargs)
        return _FakeStreamingConnector(events)

    monkeypatch.setattr(server_mod, "_make_agent_connector", _factory)
    return captured


def _install_legacy(monkeypatch, events):
    def _factory(agent_type, model_id, cwd, **kwargs):
        return _FakeLegacyConnector(events)

    monkeypatch.setattr(server_mod, "_make_agent_connector", _factory)


@pytest.mark.asyncio
async def test_streaming_emits_envelopes_in_order(monkeypatch):
    events = [
        ConnectorEvent(kind="agent_started", metadata={"agent": "claude"}),
        ConnectorEvent(kind="tool_use_summary", metadata={"tool": "Read"}),
        ConnectorEvent(kind="agent_relay", metadata={"text": "hi", "role": "assistant"}),
        ConnectorEvent(kind=INTERNAL_RESULT_KIND, metadata={"content": "final answer"}),
    ]
    _install_streaming(monkeypatch, events)
    ctx = FakeCtx()

    result = await stratum_agent_run(prompt="hi", ctx=ctx, type="claude")

    assert len(ctx.calls) == 3
    assert [c[0] for c in ctx.calls] == [0, 1, 2]
    parsed = [json.loads(c[1]) for c in ctx.calls]
    assert [p["kind"] for p in parsed] == [
        "agent_started",
        "tool_use_summary",
        "agent_relay",
    ]
    cid = result["correlation_id"]
    for p in parsed:
        assert p["schema_version"] == "0.2.6"
        assert p["flow_id"] == cid
        assert p["step_id"] == "_agent_run"
        assert "task_id" not in p


@pytest.mark.asyncio
async def test_streaming_returns_final_text_and_correlation_id(monkeypatch):
    events = [
        ConnectorEvent(kind="agent_relay", metadata={"text": "ignored", "role": "assistant"}),
        ConnectorEvent(kind=INTERNAL_RESULT_KIND, metadata={"content": "final answer"}),
    ]
    _install_streaming(monkeypatch, events)
    ctx = FakeCtx()

    result = await stratum_agent_run(prompt="hi", ctx=ctx, type="claude")
    assert result["text"] == "final answer"
    assert isinstance(result["correlation_id"], str) and result["correlation_id"]


@pytest.mark.asyncio
async def test_consumer_supplied_correlation_id(monkeypatch):
    events = [ConnectorEvent(kind=INTERNAL_RESULT_KIND, metadata={"content": "ok"})]
    _install_streaming(monkeypatch, events)
    ctx = FakeCtx()

    result = await stratum_agent_run(
        prompt="hi", ctx=ctx, type="claude", correlation_id="custom-id"
    )
    assert result["correlation_id"] == "custom-id"


@pytest.mark.asyncio
async def test_legacy_connector_no_progress_emitted(monkeypatch):
    _install_legacy(
        monkeypatch,
        [
            {"type": "result", "content": "done"},
        ],
    )
    ctx = FakeCtx()

    result = await stratum_agent_run(prompt="hi", ctx=ctx, type="claude")
    assert ctx.calls == []
    assert result["text"] == "done"


@pytest.mark.asyncio
async def test_extended_kwargs_forwarded_to_factory(monkeypatch):
    events = [ConnectorEvent(kind=INTERNAL_RESULT_KIND, metadata={"content": "ok"})]
    captured = _install_streaming(monkeypatch, events)
    ctx = FakeCtx()

    await stratum_agent_run(
        prompt="hi",
        ctx=ctx,
        type="claude",
        modelID="claude-x",
        allowed_tools=["Read"],
        disallowed_tools=["Bash"],
        thinking={"type": "adaptive"},
        effort="high",
    )
    assert captured["agent_type"] == "claude"
    assert captured["model_id"] == "claude-x"
    assert captured["allowed_tools"] == ["Read"]
    assert captured["disallowed_tools"] == ["Bash"]
    assert captured["thinking"] == {"type": "adaptive"}
    assert captured["effort"] == "high"


@pytest.mark.asyncio
async def test_cancel_agent_run_cancels_task():
    cid = "cancel-test-id"

    async def _fake_long_op() -> None:
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            raise

    task = asyncio.create_task(_fake_long_op())
    _AGENT_RUN_TASKS[cid] = task
    try:
        result = await stratum_cancel_agent_run(correlation_id=cid, ctx=None)
        assert result == {"status": "cancelled", "correlation_id": cid}
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        _AGENT_RUN_TASKS.pop(cid, None)


@pytest.mark.asyncio
async def test_cancel_agent_run_unknown_id_returns_not_found():
    result = await stratum_cancel_agent_run(
        correlation_id="does-not-exist", ctx=None
    )
    assert result == {"status": "not_found", "correlation_id": "does-not-exist"}


def test_claude_connector_accepts_thinking_and_effort():
    from stratum_mcp.connectors.claude import ClaudeConnector

    c = ClaudeConnector(thinking={"type": "adaptive"}, effort="high")
    assert c._thinking == {"type": "adaptive"}
    assert c._effort == "high"
