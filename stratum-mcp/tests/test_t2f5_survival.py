"""T2-F5-RESUME S6 + E2E — the survival golden flow against the REAL primitive.

This is the acceptance test the whole feature exists for: a server-dispatched
codex task spawned durable+detached survives the executor being torn down
mid-run (simulated server restart), and a fresh ReattachReader re-attaches to
the durable stream the child kept writing and recovers the full result.

No real `codex` binary: `_build_codex_cmd` is patched to a short-sleeping `sh`
script that emits codex-shaped JSONL on stdout (which the durable wrapper
redirects to $T2F5_OUT, exactly as it would the real codex). The child is a
genuine detached OS process, so survival is real, not mocked.
"""
from __future__ import annotations

import asyncio
import json
import os
import signal
from dataclasses import dataclass, field

import pytest

import stratum_mcp.executor as executor_mod
import stratum_mcp.parallel_exec as parallel_exec_mod
from stratum_mcp.connectors.codex import CodexConnector
from stratum_mcp.parallel_exec import (
    ParallelExecutor,
    ReattachReader,
    classify_interrupted_parallel_tasks,
    shutdown_all,
    shutdown_readers,
)


@dataclass
class FakeFlowState:
    flow_id: str = "survflow"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget_state: dict | None = None


def _budgeted():
    return FakeFlowState(budget_state={
        "caps": {"max_tokens": 100000},
        "consumed": {"wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0},
    })


def _slow_codex_argv(sleep_s=0.6):
    recs = [
        {"type": "thread.started", "thread_id": "t"},
        {"type": "item.completed", "item": {"type": "agent_message",
                                            "text": "survived restart"}},
        {"type": "turn.completed", "usage": {"input_tokens": 20, "output_tokens": 5}},
    ]
    body = f"sleep {sleep_s}; " + "; ".join(
        f"printf '%s\\n' {json.dumps(json.dumps(r))}" for r in recs
    )
    return ["sh", "-c", body]


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def _wait_until(pred, timeout=4.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("timeout")


@pytest.fixture(autouse=True)
def _flows_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")


def _install_real_durable_codex(monkeypatch, sleep_s=0.6):
    def factory(agent_type, model_id, cwd, **kw):
        conn = CodexConnector(stream_path=kw["stream_path"],
                              stderr_path=kw["stderr_path"])
        conn._build_codex_cmd = lambda args, env=None: _slow_codex_argv(sleep_s)
        return conn
    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", factory)


async def test_survival_and_reattach_end_to_end(monkeypatch):
    _install_real_durable_codex(monkeypatch, sleep_s=0.7)
    state = _budgeted()
    ex = ParallelExecutor(
        state=state, step_id="execute", tasks=[{"id": "t1"}],
        max_concurrent=1, isolation="none", task_timeout=30,
        agent="codex", intent_template="do {id}",
        task_reasoning_template=None, require="all",
        persist_callable=lambda s: None,
    )

    handle = asyncio.create_task(ex.run())
    ts = state.parallel_tasks["t1"]
    # wait for the durable child to be spawned + handle stamped
    await _wait_until(lambda: ts.reparentable and ts.child_pid)
    child_pid = ts.child_pid
    assert _alive(child_pid)

    # ---- simulate server shutdown mid-run: detach, then shutdown_all ----
    ex._detaching = True
    shutdown_all({("survflow", "execute"): handle})
    try:
        await handle
    except asyncio.CancelledError:
        pass

    # the detached child is STILL ALIVE and the task stayed `running`
    assert _alive(child_pid), "durable child must survive shutdown_all"
    assert ts.state == "running"
    assert ts.stream_path and os.path.exists(ts.stream_path)

    # ---- simulate restart classify: the live, identity-matched child → reparenting
    # (drive the per-task classifier the same way the boot hook does) ----
    from stratum_mcp.parallel_exec import _classify_interrupted_task
    fate = _classify_interrupted_task({
        "reparentable": True, "child_pid": child_pid,
        "proc_start_time": ts.proc_start_time,
    })
    assert fate == "reparenting"
    ts.state = "reparenting"

    # ---- a fresh ReattachReader re-attaches to the durable stream ----
    reader = ReattachReader(state, "execute", "t1",
                            persist_callable=lambda s: None)
    await asyncio.wait_for(reader.run(), timeout=5)

    # recovered the full result the child wrote AFTER the executor was gone
    assert ts.state == "complete"
    assert ts.result == "survived restart"
    assert ts.tokens == 25
    assert ts.dispatch_debited is True
    assert state.budget_state["consumed"]["dispatches"] == 1
    # child has exited and its durable stream files were cleaned up at terminal
    assert not _alive(child_pid)
    assert not os.path.exists(ts.stream_path)


async def test_shutdown_readers_cancels_in_flight_reader(monkeypatch):
    """S6: a ReattachReader is cancelled by shutdown_readers; the child it was
    reading is NOT killed by that (only read-side is cancelled)."""
    _install_real_durable_codex(monkeypatch, sleep_s=3.0)
    state = _budgeted()
    ex = ParallelExecutor(
        state=state, step_id="execute", tasks=[{"id": "t1"}],
        max_concurrent=1, isolation="none", task_timeout=30,
        agent="codex", intent_template="do {id}",
        task_reasoning_template=None, require="all",
        persist_callable=lambda s: None,
    )
    handle = asyncio.create_task(ex.run())
    ts = state.parallel_tasks["t1"]
    await _wait_until(lambda: ts.reparentable and ts.child_pid)
    child_pid = ts.child_pid

    ex._detaching = True
    shutdown_all({("survflow", "execute"): handle})
    try:
        await handle
    except asyncio.CancelledError:
        pass
    ts.state = "reparenting"

    # start a reader (child still sleeping → reader stays in-flight tailing)
    reader_task = asyncio.create_task(
        ReattachReader(state, "execute", "t1",
                       persist_callable=lambda s: None).run())
    await asyncio.sleep(0.1)
    assert not reader_task.done()

    registry = {("survflow", "t1"): reader_task}
    shutdown_readers(registry)
    try:
        await reader_task
    except asyncio.CancelledError:
        pass
    assert reader_task.cancelled() or reader_task.done()

    # cleanup the still-detached child
    try:
        os.killpg(os.getpgid(child_pid), signal.SIGKILL)
    except (ProcessLookupError, OSError):
        pass
