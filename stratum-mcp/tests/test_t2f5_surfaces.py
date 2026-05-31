"""T2-F5-RESUME S5 — `reparenting` treated as non-terminal/in-flight everywhere.

Enumerates the state-surface special-cases (mirroring how -ROUTE threaded
`skipped`): start-reject, advance terminal gate, poll summary/all_terminal,
resume poll-not-dispatch, require/item counts, and streams cleanup.
"""
from __future__ import annotations

import textwrap

import pytest

import stratum_mcp.server as server_mod
from stratum_mcp.executor import (
    ParallelTaskState,
    _flows,
    delete_persisted_flow,
    flow_streams_dir,
)
import stratum_mcp.executor as executor_mod
from stratum_mcp.server import (
    _resolve_dispatch_tasks,
    stratum_parallel_advance,
    stratum_parallel_poll,
    stratum_parallel_start,
    stratum_plan,
    stratum_resume,
    stratum_step_done,
)

_SPEC = textwrap.dedent("""\
    version: "0.3"
    contracts:
      TaskGraph:
        tasks: {type: array}
    flows:
      main:
        input: {}
        steps:
          - id: analyze
            type: decompose
            agent: claude
            intent: "Break down"
            output_contract: TaskGraph
          - id: execute
            type: parallel_dispatch
            source: "$.steps.analyze.output.tasks"
            agent: codex
            isolation: none
            require: all
            defer_advance: true
            intent_template: "Do: {desc}"
            depends_on: [analyze]
""")


async def _dispatch_to_parallel(num_tasks=2) -> str:
    result = await stratum_plan(spec=_SPEC, flow="main", inputs={}, ctx=None)
    flow_id = result["flow_id"]
    task_graph = {"tasks": [
        {"id": f"t{i}", "desc": f"task {i}", "files_owned": [f"f{i}.py"], "depends_on": []}
        for i in range(1, num_tasks + 1)
    ]}
    await stratum_step_done(flow_id, "analyze", task_graph, ctx=None)
    return flow_id


def _seed_reparenting(state, tid="t1"):
    state.parallel_tasks[tid] = ParallelTaskState(
        task_id=tid, state="reparenting", started_at=1.0,
        child_pid=999999, stream_path="/tmp/nonexistent.jsonl",
        reparentable=True,
    )


async def test_start_rejects_when_reparenting(monkeypatch):
    server_mod._REATTACH_READERS.clear()
    flow_id = await _dispatch_to_parallel()
    state = _flows[flow_id]
    _seed_reparenting(state)
    res = await stratum_parallel_start(flow_id, "execute", ctx=None)
    assert res.get("error") == "already_started"


async def test_advance_blocked_when_reparenting(monkeypatch):
    server_mod._REATTACH_READERS.clear()
    flow_id = await _dispatch_to_parallel()
    state = _flows[flow_id]
    # one terminal, one reparenting → not all terminal
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1", state="complete",
                                                   result={"ok": True})
    _seed_reparenting(state, "t2")
    res = await stratum_parallel_advance(flow_id, "execute", "clean", ctx=None)
    assert res.get("error") == "tasks_not_terminal"


async def test_poll_counts_reparenting_and_does_not_advance(monkeypatch, tmp_path):
    server_mod._REATTACH_READERS.clear()
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")
    flow_id = await _dispatch_to_parallel()
    state = _flows[flow_id]
    state.parallel_tasks["t1"] = ParallelTaskState(task_id="t1", state="complete",
                                                   result={"ok": True})
    _seed_reparenting(state, "t2")
    res = await stratum_parallel_poll(flow_id, "execute", ctx=_FakeCtx())
    assert res["summary"]["reparenting"] == 1
    # reparenting is not terminal → no advance, no terminal outcome
    assert res["can_advance"] is False
    assert res["outcome"] is None
    # did not advance (still on execute)
    assert state.ordered_steps[state.current_idx].id == "execute"


async def test_resume_returns_in_progress_when_reparenting(monkeypatch, tmp_path):
    server_mod._REATTACH_READERS.clear()
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")
    flow_id = await _dispatch_to_parallel()
    state = _flows[flow_id]
    _seed_reparenting(state, "t1")
    state.parallel_tasks["t2"] = ParallelTaskState(task_id="t2", state="complete")
    res = await stratum_resume(flow_id, ctx=None)
    assert res["status"] == "parallel_in_progress"
    assert res["step_id"] == "execute"
    # a reader was started for the reparenting task
    assert (flow_id, "t1") in server_mod._REATTACH_READERS
    # cleanup the in-flight reader (stream file doesn't exist → it will fail fast,
    # but cancel to be safe)
    rk = (flow_id, "t1")
    server_mod._REATTACH_READERS[rk].cancel()


def test_delete_persisted_flow_removes_streams_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")
    sdir = flow_streams_dir("flowZ")
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "t1.jsonl").write_text("{}\n")
    assert sdir.exists()
    delete_persisted_flow("flowZ")
    assert not sdir.exists()
    assert not (tmp_path / "flows" / "flowZ").exists()


# --- require/item counts treat reparenting as in-flight ---

def test_require_unsatisfiable_reparenting_not_failed():
    from stratum_mcp.parallel_exec import ParallelExecutor
    from dataclasses import dataclass, field

    @dataclass
    class S:
        flow_id: str = "f"
        cwd: str = ""
        parallel_tasks: dict = field(default_factory=dict)
        terminal_status: str | None = None
        budget_state: dict | None = None

    state = S()
    tasks = [{"id": "t1"}, {"id": "t2"}]
    ex = ParallelExecutor(
        state=state, step_id="s1", tasks=tasks, max_concurrent=2,
        isolation="none", task_timeout=30, agent="codex",
        intent_template="x", task_reasoning_template=None, require="all",
    )
    state.parallel_tasks["t1"].state = "reparenting"
    state.parallel_tasks["t2"].state = "complete"
    # require=all: a reparenting (in-flight) task is NOT a failure → satisfiable
    assert ex._require_unsatisfiable() is False


class _FakeCtx:
    async def report_progress(self, *a, **k):
        return None
