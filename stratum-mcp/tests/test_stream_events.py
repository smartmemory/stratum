"""Tests for STRAT-PAR-STREAM producer side."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import patch

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
from stratum_mcp.connectors import ClaudeConnector, CodexConnector
from stratum_mcp.events import (
    INTERNAL_RESULT_KIND,
    BuildStreamEvent,
    ConnectorEvent,
    TaskSeqCounter,
    now_iso,
)
from stratum_mcp.executor import ParallelTaskState
from stratum_mcp.parallel_exec import ParallelExecutor


# ---------------------------------------------------------------------------
# events.py
# ---------------------------------------------------------------------------


def test_now_iso_ends_in_z():
    s = now_iso()
    assert s.endswith("Z")
    assert "T" in s


def test_build_stream_event_to_json_round_trip():
    ev = BuildStreamEvent(
        flow_id="f1",
        step_id="execute",
        task_id="t1",
        seq=3,
        ts="2026-04-26T00:00:00.000Z",
        kind="agent_relay",
        metadata={"text": "hello", "role": "assistant"},
    )
    obj = json.loads(ev.to_json())
    assert obj["schema_version"] == "0.2.6"
    assert obj["flow_id"] == "f1"
    assert obj["step_id"] == "execute"
    assert obj["task_id"] == "t1"
    assert obj["seq"] == 3
    assert obj["kind"] == "agent_relay"
    assert obj["metadata"] == {"text": "hello", "role": "assistant"}


def test_build_stream_event_omits_task_id_when_none():
    ev = BuildStreamEvent(
        flow_id="f1",
        step_id="s",
        task_id=None,
        seq=0,
        ts="2026-04-26T00:00:00.000Z",
        kind="agent_started",
        metadata={},
    )
    obj = json.loads(ev.to_json())
    assert "task_id" not in obj


def test_task_seq_counter_monotonic_per_key():
    c = TaskSeqCounter()
    assert c.next("f", "s", "a") == 0
    assert c.next("f", "s", "a") == 1
    assert c.next("f", "s", "a") == 2


def test_task_seq_counter_independent_across_keys():
    c = TaskSeqCounter()
    assert c.next("f", "s", "a") == 0
    assert c.next("f", "s", "b") == 0
    assert c.next("f", "s", "a") == 1
    assert c.next("f", "s2", "a") == 0


# ---------------------------------------------------------------------------
# Claude stream_events translation
# ---------------------------------------------------------------------------


class _FakeTextBlock:
    def __init__(self, text):
        self.text = text


class _FakeToolUseBlock:
    def __init__(self, name, input_):
        self.name = name
        self.input = input_


class _FakeAssistantMessage:
    def __init__(self, content):
        self.content = content


class _FakeResultMessage:
    def __init__(self, result=None, usage=None):
        self.result = result
        self.usage = usage


async def _async_gen(items):
    for item in items:
        yield item


async def _collect(agen):
    return [ev async for ev in agen]


@pytest.mark.asyncio
async def test_claude_stream_events_translation():
    msgs = [
        _FakeAssistantMessage([_FakeTextBlock("hi there")]),
        _FakeAssistantMessage([_FakeToolUseBlock("Read", {"file_path": "/tmp/x"})]),
        _FakeResultMessage(result="done"),
    ]
    with patch(
        "stratum_mcp.connectors.claude.query", return_value=_async_gen(msgs)
    ), patch(
        "stratum_mcp.connectors.claude.AssistantMessage", _FakeAssistantMessage
    ), patch(
        "stratum_mcp.connectors.claude.ResultMessage", _FakeResultMessage
    ), patch(
        "stratum_mcp.connectors.claude.TextBlock", _FakeTextBlock
    ), patch(
        "stratum_mcp.connectors.claude.ToolUseBlock", _FakeToolUseBlock
    ):
        conn = ClaudeConnector(model="claude-test")
        events = await _collect(conn.stream_events("ping"))
    kinds = [e.kind for e in events]
    assert kinds[0] == "agent_started"
    assert events[0].metadata == {
        "agent": "claude",
        "model": "claude-test",
        "prompt_chars": 4,
    }
    assert "agent_relay" in kinds
    relay = next(e for e in events if e.kind == "agent_relay")
    assert relay.metadata == {"text": "hi there", "role": "assistant"}
    assert "tool_use_summary" in kinds
    tus = next(e for e in events if e.kind == "tool_use_summary")
    assert tus.metadata["tool"] == "Read"
    assert tus.metadata["ok"] is True
    assert tus.metadata["duration_ms"] == 0
    assert tus.metadata["summary"] == "/tmp/x"
    assert events[-1].kind == INTERNAL_RESULT_KIND
    assert events[-1].metadata == {"content": "done"}


# ---------------------------------------------------------------------------
# Codex stream_events translation
# ---------------------------------------------------------------------------


class _FakeStream:
    def __init__(self, lines: list[bytes]):
        self._lines = list(lines)

    async def readline(self):
        if not self._lines:
            return b""
        return self._lines.pop(0)


class _FakeProc:
    def __init__(self, stdout_lines: list[bytes], exit_code: int = 0):
        self.stdin = _FakeStdin()
        self.stdout = _FakeStream(stdout_lines)
        self.stderr = _FakeStream([])
        self._exit_code = exit_code
        self.returncode = None

    async def wait(self):
        self.returncode = self._exit_code
        return self._exit_code


class _FakeStdin:
    def write(self, data):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


@pytest.mark.asyncio
async def test_codex_stream_events_translation():
    lines = [
        json.dumps({"type": "thread.started", "thread_id": "abc"}).encode() + b"\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "hello"},
            }
        ).encode()
        + b"\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "type": "command_execution",
                    "command": "ls -la",
                    "exit_code": 0,
                    "duration_ms": 42,
                },
            }
        ).encode()
        + b"\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"type": "file_change", "path": "/tmp/x.py"},
            }
        ).encode()
        + b"\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"type": "reasoning", "text": "thinking"},
            }
        ).encode()
        + b"\n",
        b"",
    ]
    proc = _FakeProc(lines, exit_code=0)

    async def _fake_create(*args, **kwargs):
        return proc

    with patch(
        "stratum_mcp.connectors.codex.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = CodexConnector(model_id="gpt-5.4")
        events = await _collect(conn.stream_events("hi"))
    kinds = [e.kind for e in events]
    assert kinds[0] == "agent_started"
    assert events[0].metadata == {
        "agent": "codex",
        "model": "gpt-5.4",
        "prompt_chars": 2,
    }
    relay = next(e for e in events if e.kind == "agent_relay" and e.metadata.get("role") == "assistant")
    assert relay.metadata == {"text": "hello", "role": "assistant"}
    bash = next(e for e in events if e.kind == "tool_use_summary" and e.metadata["tool"] == "bash")
    assert bash.metadata == {
        "tool": "bash",
        "summary": "ls -la",
        "ok": True,
        "duration_ms": 42,
    }
    edit = next(e for e in events if e.kind == "tool_use_summary" and e.metadata["tool"] == "edit")
    assert edit.metadata["summary"] == "edit /tmp/x.py"
    reasoning = next(
        e for e in events if e.kind == "agent_relay" and e.metadata.get("role") == "system"
    )
    assert reasoning.metadata == {"text": "thinking", "role": "system"}
    assert events[-1].kind == INTERNAL_RESULT_KIND
    assert events[-1].metadata == {"content": "hello"}


# ---------------------------------------------------------------------------
# parallel_exec envelope minting
# ---------------------------------------------------------------------------


@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)


class FakeCtx:
    def __init__(self, raise_on_call: bool = False):
        self.calls: list[dict] = []
        self.raise_on_call = raise_on_call

    async def report_progress(self, *, progress, message):
        self.calls.append({"progress": progress, "message": message})
        if self.raise_on_call:
            raise RuntimeError("broken pipe")


class StubStreamingConnector:
    def __init__(self, events: list[ConnectorEvent], result: Any = None):
        self._events = list(events)
        self._result = result
        self.interrupted = 0

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        yield {"type": "result", "output": self._result}

    async def stream_events(self, prompt, *, cwd=None, env=None, **kw):
        for ev in self._events:
            yield ev
        if self._result is not None:
            yield ConnectorEvent(
                kind=INTERNAL_RESULT_KIND, metadata={"content": self._result}
            )

    def interrupt(self):
        self.interrupted += 1


def _install_stub(monkeypatch, connectors: list):
    it = iter(connectors)

    def _factory(connector_type, model_id, cwd):
        return next(it)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", _factory)
    monkeypatch.setattr(parallel_exec_mod, "create_worktree", lambda *a, **kw: None)
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree", lambda *a, **kw: None)


@pytest.mark.asyncio
async def test_run_one_emits_envelopes(monkeypatch):
    state = FakeFlowState()
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1")
    conn = StubStreamingConnector(
        events=[
            ConnectorEvent(kind="agent_relay", metadata={"text": "hi", "role": "assistant"}),
            ConnectorEvent(
                kind="tool_use_summary",
                metadata={"tool": "Read", "summary": "x", "ok": True, "duration_ms": 0},
            ),
            ConnectorEvent(kind="agent_relay", metadata={"text": "bye", "role": "assistant"}),
        ],
        result="done",
    )
    _install_stub(monkeypatch, [conn])
    ctx = FakeCtx()
    ex = ParallelExecutor(
        state=state,
        step_id="execute",
        tasks=[{"id": "t1"}],
        max_concurrent=1,
        isolation="none",
        task_timeout=10,
        agent="claude",
        intent_template="prompt",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
        ctx=ctx,
    )
    await ex.run()
    assert state.parallel_tasks["t1"].state == "complete"
    assert state.parallel_tasks["t1"].result == "done"
    # STRAT-PAR-STREAM v2: events go to executor.events queue (drained by poll
    # under its own ctx). agent_started comes from the connector — _run_one no
    # longer mints a synthetic. Stub yields 3 connector events + result sentinel.
    drained = []
    while not ex.events.empty():
        drained.append(ex.events.get_nowait())
    assert len(drained) == 3
    seqs = [e.seq for e in drained]
    assert seqs == [0, 1, 2]
    assert drained[0].kind == "agent_relay"
    assert drained[0].task_id == "t1"
    assert drained[1].kind == "tool_use_summary"
    assert drained[2].kind == "agent_relay"
    for e in drained:
        assert e.schema_version == "0.2.6"
        assert e.flow_id == "f1"
        assert e.step_id == "execute"


@pytest.mark.asyncio
async def test_run_one_queue_overflow_drops_oldest(monkeypatch):
    """When the event queue overflows, oldest envelopes are dropped and the
    task still completes. STRAT-PAR-STREAM bounded buffer behavior."""
    state = FakeFlowState()
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1")
    burst = [
        ConnectorEvent(kind="agent_relay", metadata={"text": f"e{i}", "role": "assistant"})
        for i in range(5)
    ]
    conn = StubStreamingConnector(events=burst, result="r")
    _install_stub(monkeypatch, [conn])
    ex = ParallelExecutor(
        state=state,
        step_id="execute",
        tasks=[{"id": "t1"}],
        max_concurrent=1,
        isolation="none",
        task_timeout=10,
        agent="claude",
        intent_template="prompt",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
    )
    # Shrink the queue to force overflow.
    ex.events = asyncio.Queue(maxsize=2)
    await ex.run()
    assert state.parallel_tasks["t1"].state == "complete"
    assert state.parallel_tasks["t1"].result == "r"
    # Queue still bounded; task still finished.
    assert ex.events.qsize() <= 2
