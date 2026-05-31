"""T2-F5-RESUME S3 — executor wiring in ParallelExecutor._run_one.

Covers the three executor-side behaviors that turn a codex durable-stream
connector into a reparentable task:
  - the `durable_spawned` handle handoff stamps the reparent handle on the task
    state and persists it BEFORE any codex output (review #2);
  - the dispatch debit is charged once and marked `dispatch_debited` so a
    re-attach never double-charges the dispatch;
  - detach-don't-kill: on a shutdown cancel (`_detaching=True`) a reparentable
    task is left `running`, NOT interrupted, NOT worktree-removed — while a
    non-reparentable task keeps today's interrupt+terminalize.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

import stratum_mcp.executor as executor_mod
import stratum_mcp.parallel_exec as parallel_exec_mod
from stratum_mcp.events import INTERNAL_RESULT_KIND, ConnectorEvent
from stratum_mcp.parallel_exec import ParallelExecutor

pytestmark = pytest.mark.asyncio


@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget_state: dict | None = None


@pytest.fixture(autouse=True)
def _flows_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")


def _budgeted():
    return FakeFlowState(budget_state={
        "caps": {"max_tokens": 100000},
        "consumed": {"wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0},
    })


class DurableCodexStub:
    """Stub codex durable-stream connector: emits durable_spawned, then a usage
    event + result. Optionally hangs after the handoff (to test detach)."""

    def __init__(self, *, child_pid=4242, hang=False, tokens=50):
        self.child_pid = child_pid
        self.hang = hang
        self.tokens = tokens
        self.interrupted = 0
        self._stream_path = "/tmp/streams/x.jsonl"

    async def stream_events(self, prompt, *, cwd=None, env=None, **kw):
        yield ConnectorEvent(kind="durable_spawned", metadata={
            "child_pid": self.child_pid,
            "stream_path": "/tmp/streams/x.jsonl",
            "stderr_path": "/tmp/streams/x.err",
            "proc_start_time": "Sat May 31 09:00:00 2026",
        })
        if self.hang:
            await asyncio.sleep(3600)
        yield ConnectorEvent(kind="step_usage", metadata={
            "input_tokens": self.tokens, "output_tokens": 0,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
            "cost_usd": 0, "model": "gpt-5.4",
        })
        yield ConnectorEvent(kind=INTERNAL_RESULT_KIND, metadata={"content": "done"})

    def interrupt(self):
        self.interrupted += 1


class ClaudeHangStub:
    """Non-reparentable stub: hangs in run(), records interrupts."""

    def __init__(self):
        self.interrupted = 0

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        await asyncio.sleep(3600)
        yield {"type": "result", "output": "never"}

    def interrupt(self):
        self.interrupted += 1


def _install_factory(monkeypatch, conn):
    def factory(agent_type, model_id, cwd, **kwargs):
        return conn
    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", factory)


def _executor(tasks, state, *, agent="codex", isolation="none",
              persist_callable=None):
    return ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=3,
        isolation=isolation,
        task_timeout=30,
        agent=agent,
        intent_template="run {id}",
        task_reasoning_template=None,
        require="all",
        persist_callable=persist_callable or (lambda s: None),
    )


async def _wait_until(pred, timeout=3.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met within timeout")


# --------------------------------------------------------------------------
# durable_spawned handoff — stamp + persist BEFORE output
# --------------------------------------------------------------------------

async def test_durable_spawned_stamps_handle_and_persists_before_output(monkeypatch):
    snapshots: list[dict] = []

    def persist(s):
        ts = s.parallel_tasks["t1"]
        snapshots.append({
            "reparentable": ts.reparentable,
            "child_pid": ts.child_pid,
            "stream_path": ts.stream_path,
            "result": ts.result,
            "state": ts.state,
        })

    _install_factory(monkeypatch, DurableCodexStub())
    state = _budgeted()
    ex = _executor([{"id": "t1"}], state, persist_callable=persist)
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.reparentable is True
    assert ts.child_pid == 4242
    assert ts.stream_path == "/tmp/streams/x.jsonl"
    assert ts.stderr_path == "/tmp/streams/x.err"
    assert ts.proc_start_time == "Sat May 31 09:00:00 2026"
    assert ts.state == "complete"

    # The handoff persist (reparentable=True, result=None) happened BEFORE the
    # result was produced.
    handoff = next(s for s in snapshots if s["reparentable"])
    assert handoff["child_pid"] == 4242
    assert handoff["result"] is None


async def test_codex_task_gets_durable_stream_path(monkeypatch):
    """_run_one computes a per-task stream_path under the flow streams dir and
    threads it into the codex factory call."""
    seen = {}

    def factory(agent_type, model_id, cwd, **kwargs):
        seen["agent_type"] = agent_type
        seen["stream_path"] = kwargs.get("stream_path")
        seen["stderr_path"] = kwargs.get("stderr_path")
        return DurableCodexStub()

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", factory)
    state = _budgeted()
    state.flow_id = "flowABC"
    ex = _executor([{"id": "task7"}], state)
    await ex.run()

    assert seen["agent_type"] == "codex"
    assert seen["stream_path"].endswith("flowABC/streams/task7.jsonl")
    assert seen["stderr_path"].endswith("flowABC/streams/task7.err")


# --------------------------------------------------------------------------
# budget: one dispatch, dispatch_debited set
# --------------------------------------------------------------------------

async def test_live_complete_charges_one_dispatch_and_marks_debited(monkeypatch):
    _install_factory(monkeypatch, DurableCodexStub(tokens=50))
    state = _budgeted()
    ex = _executor([{"id": "t1"}], state)
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.dispatch_debited is True
    assert state.budget_state["consumed"]["dispatches"] == 1
    assert state.budget_state["consumed"]["tokens"] == 50


async def test_debit_guarded_by_dispatch_debited(monkeypatch):
    """If a task somehow re-enters the finalizer with dispatch_debited already
    set (the re-attach case), the dispatch is NOT charged again."""
    _install_factory(monkeypatch, DurableCodexStub(tokens=50))
    state = _budgeted()
    # pre-charge: simulate a re-attach having already debited the dispatch
    state.budget_state["consumed"]["dispatches"] = 1
    ex = _executor([{"id": "t1"}], state)
    # seed the task with dispatch_debited=True before run
    from stratum_mcp.executor import ParallelTaskState
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1", dispatch_debited=True)
    await ex.run()

    # still exactly one dispatch — the live finalizer respected the marker
    assert state.budget_state["consumed"]["dispatches"] == 1


# --------------------------------------------------------------------------
# detach-don't-kill (review #1)
# --------------------------------------------------------------------------

async def test_detach_leaves_reparentable_running_not_killed(monkeypatch):
    conn = DurableCodexStub(hang=True)
    _install_factory(monkeypatch, conn)
    state = _budgeted()
    persisted = []
    ex = _executor([{"id": "t1"}], state,
                   persist_callable=lambda s: persisted.append(
                       s.parallel_tasks["t1"].state))

    sem = asyncio.Semaphore(3)
    handle = asyncio.create_task(ex._run_one(sem, {"id": "t1"}))
    ts = state.parallel_tasks["t1"]
    await _wait_until(lambda: ts.reparentable)

    # shutdown: mark detaching, then cancel the task
    ex._detaching = True
    handle.cancel()
    with pytest.raises(asyncio.CancelledError):
        await handle

    assert ts.state == "running", "reparentable task must stay running on detach"
    assert conn.interrupted == 0, "must NOT interrupt the durable child"
    assert ts.reparentable is True
    # handle persisted, dispatch NOT debited live (re-attach reader will charge)
    assert ts.dispatch_debited is False
    assert state.budget_state["consumed"]["dispatches"] == 0


async def test_detach_does_not_remove_worktree(monkeypatch):
    conn = DurableCodexStub(hang=True)
    _install_factory(monkeypatch, conn)
    removed = []
    monkeypatch.setattr(parallel_exec_mod, "create_worktree",
                        lambda fid, tid, cwd: __import__("pathlib").Path(f"/tmp/wt/{tid}"))
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree",
                        lambda p: removed.append(p))
    state = _budgeted()
    ex = _executor([{"id": "t1"}], state, isolation="worktree")

    sem = asyncio.Semaphore(3)
    handle = asyncio.create_task(ex._run_one(sem, {"id": "t1"}))
    ts = state.parallel_tasks["t1"]
    await _wait_until(lambda: ts.reparentable)
    ex._detaching = True
    handle.cancel()
    with pytest.raises(asyncio.CancelledError):
        await handle

    assert removed == [], "detached task's worktree must NOT be removed (child uses it)"
    assert ts.state == "running"


async def test_non_reparentable_still_killed_on_detach(monkeypatch):
    """A claude (non-reparentable) task on shutdown keeps today's behavior:
    interrupted + terminalized, even with _detaching=True."""
    conn = ClaudeHangStub()
    _install_factory(monkeypatch, conn)
    state = _budgeted()
    ex = _executor([{"id": "t1"}], state, agent="claude")

    sem = asyncio.Semaphore(3)
    handle = asyncio.create_task(ex._run_one(sem, {"id": "t1"}))
    ts = state.parallel_tasks["t1"]
    await _wait_until(lambda: ts.state == "running")
    ex._detaching = True
    handle.cancel()
    with pytest.raises(asyncio.CancelledError):
        await handle

    assert ts.state == "cancelled"
    assert conn.interrupted >= 1
    assert ts.reparentable is False
