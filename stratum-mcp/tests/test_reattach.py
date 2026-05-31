"""T2-F5-RESUME S4 — restart classify + ReattachReader runtime.

classify_interrupted_parallel_tasks turns a live, identity-matched codex
durable task into `reparenting` (else `failed`); ReattachReader tails the
durable stream to a terminal state WITHOUT being the child's parent, and
reproduces the per-task accounting the _run_one finalizer owns (review #4).
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field

import pytest

from stratum_mcp.executor import ParallelTaskState
from stratum_mcp.parallel_exec import (
    RESUME_INTERRUPTED_ERROR,
    ReattachReader,
    classify_interrupted_parallel_tasks,
)
from stratum_mcp.connectors.codex import T2F5_DONE_SENTINEL
from stratum_mcp.proc_identity import proc_start_time

# asyncio_mode = "auto" → async tests run without explicit marks.


@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget_state: dict | None = None


def _budgeted():
    return FakeFlowState(budget_state={
        "caps": {"max_tokens": 100000},
        "consumed": {"wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0},
    })


def _reader(state, **kw):
    """ReattachReader with a no-op persist (FakeFlowState isn't a real FlowState)."""
    kw.setdefault("persist_callable", lambda s: None)
    return ReattachReader(state, "s1", "t1", **kw)


def _write_flow(tmp_path, flow_id, tasks: dict) -> None:
    (tmp_path).mkdir(parents=True, exist_ok=True)
    payload = {"flow_id": flow_id, "parallel_tasks": tasks}
    (tmp_path / f"{flow_id}.json").write_text(json.dumps(payload))


# --------------------------------------------------------------------------
# classify
# --------------------------------------------------------------------------

def test_classify_live_identity_match_to_reparenting(tmp_path):
    pid = os.getpid()  # this process is alive; use its real start time
    _write_flow(tmp_path, "f1", {
        "t1": {"state": "running", "reparentable": True, "child_pid": pid,
               "proc_start_time": proc_start_time(pid),
               "stream_path": "/tmp/x.jsonl"},
    })
    classify_interrupted_parallel_tasks(tmp_path)
    payload = json.loads((tmp_path / "f1.json").read_text())
    assert payload["parallel_tasks"]["t1"]["state"] == "reparenting"


def test_classify_dead_pid_to_failed(tmp_path):
    _write_flow(tmp_path, "f1", {
        "t1": {"state": "running", "reparentable": True, "child_pid": 999999,
               "proc_start_time": "whenever", "stream_path": "/tmp/x.jsonl"},
    })
    classify_interrupted_parallel_tasks(tmp_path)
    t1 = json.loads((tmp_path / "f1.json").read_text())["parallel_tasks"]["t1"]
    assert t1["state"] == "failed"
    assert t1["error"] == RESUME_INTERRUPTED_ERROR


def test_classify_pid_reuse_mismatch_to_failed(tmp_path):
    pid = os.getpid()  # alive, but persisted start time deliberately wrong
    _write_flow(tmp_path, "f1", {
        "t1": {"state": "running", "reparentable": True, "child_pid": pid,
               "proc_start_time": "Mon Jan  1 00:00:00 2001",
               "stream_path": "/tmp/x.jsonl"},
    })
    classify_interrupted_parallel_tasks(tmp_path)
    t1 = json.loads((tmp_path / "f1.json").read_text())["parallel_tasks"]["t1"]
    assert t1["state"] == "failed"


def test_classify_non_reparentable_running_to_failed(tmp_path):
    """A claude (non-reparentable) running task keeps today's failed behavior."""
    _write_flow(tmp_path, "f1", {
        "t1": {"state": "running", "reparentable": False},
        "t2": {"state": "complete"},  # untouched
    })
    classify_interrupted_parallel_tasks(tmp_path)
    tasks = json.loads((tmp_path / "f1.json").read_text())["parallel_tasks"]
    assert tasks["t1"]["state"] == "failed"
    assert tasks["t2"]["state"] == "complete"


# --------------------------------------------------------------------------
# ReattachReader
# --------------------------------------------------------------------------

def _durable_stream(tmp_path, *, rc=0, with_result=True, with_usage=True,
                    error=False, sentinel=True) -> str:
    lines = [json.dumps({"type": "thread.started", "thread_id": "t"})]
    if error:
        lines.append(json.dumps({"type": "error", "message": "model refused"}))
    if with_result:
        lines.append(json.dumps({"type": "item.completed",
                                 "item": {"type": "agent_message", "text": "42"}}))
    if with_usage:
        lines.append(json.dumps({"type": "turn.completed",
                                 "usage": {"input_tokens": 30, "output_tokens": 10}}))
    if sentinel:
        lines.append(json.dumps({T2F5_DONE_SENTINEL: rc}))
    p = tmp_path / "stream.jsonl"
    p.write_text("\n".join(lines) + "\n")
    return str(p)


def _reparenting_task(stream_path, *, started_at=1000.0, worktree=None,
                      stderr_path=None) -> ParallelTaskState:
    return ParallelTaskState(
        task_id="t1", state="reparenting", started_at=started_at,
        child_pid=999999,  # dead — sentinel present, so liveness isn't consulted
        stream_path=stream_path, stderr_path=stderr_path,
        proc_start_time="x", reparentable=True, worktree_path=worktree,
    )


async def test_reattach_complete_and_accounting_parity(tmp_path):
    stream = _durable_stream(tmp_path, rc=0)
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream)
    persisted = []
    reader = ReattachReader(state, "s1", "t1",
                            persist_callable=lambda s: persisted.append(True))
    await reader.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.result == "42"
    # accounting parity (review #4)
    assert ts.finished_at is not None
    assert ts.elapsed_s is not None and ts.elapsed_s > 0
    assert ts.tokens == 40            # 30 in + 10 out
    assert ts.dispatch_debited is True
    assert state.budget_state["consumed"]["dispatches"] == 1
    assert state.budget_state["consumed"]["tokens"] == 40
    assert persisted, "reader must persist at terminal"
    # durable stream file removed at terminal
    assert not os.path.exists(stream)


async def test_reattach_failure_no_sentinel(tmp_path):
    # content but no sentinel + dead pid → child died incomplete → failed
    stream = _durable_stream(tmp_path, sentinel=False)
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream)
    reader = _reader(state)
    await reader.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert ts.error == RESUME_INTERRUPTED_ERROR
    # dispatch still accounted once even on failure
    assert ts.dispatch_debited is True
    assert state.budget_state["consumed"]["dispatches"] == 1


async def test_reattach_error_event_to_failed(tmp_path):
    stream = _durable_stream(tmp_path, rc=0, error=True)
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream)
    reader = _reader(state)
    await reader.run()
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert "model refused" in ts.error


async def test_reattach_rc_nonzero_no_result_fails_from_stderr(tmp_path):
    stream = _durable_stream(tmp_path, rc=2, with_result=False)
    errp = tmp_path / "stream.err"
    errp.write_text("boom from codex")
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream, stderr_path=str(errp))
    reader = _reader(state)
    await reader.run()
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert "boom from codex" in ts.error


async def test_reattach_removes_worktree(tmp_path, monkeypatch):
    import stratum_mcp.parallel_exec as pe
    removed = []
    monkeypatch.setattr(pe, "remove_worktree", lambda p: removed.append(str(p)))
    wt = str(tmp_path / "wt")
    stream = _durable_stream(tmp_path, rc=0)
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream, worktree=wt)
    reader = _reader(state)
    await reader.run()
    assert removed == [wt]


async def test_reattach_noop_if_not_reparenting(tmp_path):
    state = _budgeted()
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1", state="complete")
    reader = _reader(state)
    await reader.run()  # no error, no change
    assert state.parallel_tasks["t1"].state == "complete"


async def test_reattach_cascade_kills_siblings_on_require_all_failure(tmp_path, monkeypatch):
    """Codex review #3: after a restart there is no executor to cascade-cancel,
    so a reader that finalizes its task `failed` under require=all must kill the
    sibling reparented children's groups (killpg) — their readers then fail them.
    We spy on os.killpg to test the cascade DECISION deterministically (the
    killpg-actually-kills-the-wrapper behavior is covered by S1's interrupt test).
    """
    import stratum_mcp.parallel_exec as pe
    killed = []
    monkeypatch.setattr(pe.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(pe.os, "killpg", lambda pgid, sig: killed.append(pgid))
    monkeypatch.setattr(pe, "pid_alive", lambda pid: True)

    stream = _durable_stream(tmp_path, rc=1, with_result=False)  # → failed
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream)
    state.parallel_tasks["t2"] = ParallelTaskState(
        task_id="t2", state="reparenting", reparentable=True,
        child_pid=55555, proc_start_time="x",
        stream_path=str(tmp_path / "sib.jsonl"),
    )
    reader = _reader(state, require="all", sibling_task_ids=["t1", "t2"])
    await reader.run()

    assert state.parallel_tasks["t1"].state == "failed"
    # require=all + a failure → sibling t2's group (pid 55555) was killpg'd
    assert 55555 in killed


async def test_reattach_no_cascade_when_require_satisfiable(tmp_path, monkeypatch):
    """A successful completion under require=all does NOT cascade-kill siblings."""
    import stratum_mcp.parallel_exec as pe
    killed = []
    monkeypatch.setattr(pe.os, "getpgid", lambda pid: pid)
    monkeypatch.setattr(pe.os, "killpg", lambda pgid, sig: killed.append(pgid))
    monkeypatch.setattr(pe, "pid_alive", lambda pid: True)

    stream = _durable_stream(tmp_path, rc=0)  # → complete
    state = _budgeted()
    state.parallel_tasks["t1"] = _reparenting_task(stream)
    state.parallel_tasks["t2"] = ParallelTaskState(
        task_id="t2", state="reparenting", reparentable=True, child_pid=55555)
    reader = _reader(state, require="all", sibling_task_ids=["t1", "t2"])
    await reader.run()

    assert state.parallel_tasks["t1"].state == "complete"
    assert killed == [], "no failure yet → require=all still satisfiable → no cascade"


async def test_ensure_reattach_readers_single_flight(tmp_path):
    """Two poll-driven calls start exactly one reader per reparenting task."""
    import stratum_mcp.server as srv

    # No sentinel + a LIVE pid → the reader stays in-flight (tailer keeps polling),
    # so we can observe single-flight before it terminates.
    stream = _durable_stream(tmp_path, sentinel=False)
    state = _budgeted()
    ts = _reparenting_task(stream)
    ts.child_pid = os.getpid()  # alive
    state.parallel_tasks["t1"] = ts

    srv._REATTACH_READERS.clear()
    started1 = srv._ensure_reattach_readers(state, "s1", ["t1"])
    started2 = srv._ensure_reattach_readers(state, "s1", ["t1"])
    assert started1 == ["t1"]
    assert started2 == [], "single-flight: a live reader is not replaced"

    key = (state.flow_id, "t1")
    assert key in srv._REATTACH_READERS
    # cleanup: cancel the in-flight reader (it never reached terminal)
    srv._REATTACH_READERS[key].cancel()
    try:
        await srv._REATTACH_READERS[key]
    except asyncio.CancelledError:
        pass
    srv._REATTACH_READERS.clear()
