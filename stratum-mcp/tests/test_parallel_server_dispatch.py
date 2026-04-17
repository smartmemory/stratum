"""Tests for T13 — server-side parallel dispatch MCP tools.

Covers ``stratum_parallel_start`` / ``stratum_parallel_poll`` and the shared
``_evaluate_parallel_results`` helper. The legacy ``stratum_parallel_done``
path MUST stay byte-identical — those tests live in
``tests/integration/test_parallel_executor.py`` and are not duplicated here.
"""
from __future__ import annotations

import asyncio
import textwrap
from typing import Any

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
import stratum_mcp.server as server_mod
from stratum_mcp.executor import (
    ParallelTaskState,
    _flows,
    get_current_step_info,
    process_step_result,
)
from stratum_mcp.server import (
    _evaluate_parallel_results,
    stratum_parallel_done,
    stratum_parallel_poll,
    stratum_parallel_start,
    stratum_plan,
    stratum_step_done,
)


# ---------------------------------------------------------------------------
# Spec fixtures
# ---------------------------------------------------------------------------

_SPEC_NONE = textwrap.dedent("""\
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
            agent: claude
            isolation: none
            require: all
            intent_template: "Do: {desc}"
            depends_on: [analyze]
""")


_SPEC_BRANCH = textwrap.dedent("""\
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
            agent: claude
            isolation: branch
            require: all
            intent_template: "Do: {desc}"
            depends_on: [analyze]
""")


_SPEC_DEFER = textwrap.dedent("""\
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
            agent: claude
            isolation: none
            require: all
            defer_advance: true
            intent_template: "Do: {desc}"
            depends_on: [analyze]
""")


_SPEC_INLINE_ONLY = textwrap.dedent("""\
    version: "0.3"
    contracts:
      Ping:
        ok: {type: boolean}
    functions:
      ping:
        mode: infer
        intent: "Ping"
        input: {}
        output: Ping
    flows:
      main:
        input: {}
        steps:
          - id: only
            function: ping
            inputs: {}
""")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _dispatch_to_parallel(spec: str, num_tasks: int = 3) -> str:
    """Plan a flow, complete analyze with a task graph of size ``num_tasks``.

    Returns the ``flow_id`` now poised at the parallel_dispatch step.
    """
    result = await stratum_plan(spec=spec, flow="main", inputs={}, ctx=None)
    flow_id = result["flow_id"]
    task_graph = {
        "tasks": [
            {"id": f"t{i}", "desc": f"task {i}", "files_owned": [f"f{i}.py"], "depends_on": []}
            for i in range(1, num_tasks + 1)
        ]
    }
    await stratum_step_done(flow_id, "analyze", task_graph, ctx=None)
    return flow_id




# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

async def test_start_returns_ack_and_tasks(monkeypatch):
    # Stub the executor so no real connectors spawn.
    async def fake_run(self):
        # Mark all tasks complete with a minimal result so poll can advance.
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = ts.started_at or _time.time()
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run)

    flow_id = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=3)
    try:
        resp = await stratum_parallel_start(
            flow_id=flow_id, step_id="execute", ctx=None,
        )
        assert resp["status"] == "started"
        assert resp["flow_id"] == flow_id
        assert resp["step_id"] == "execute"
        assert resp["task_count"] == 3
        assert resp["tasks"] == ["t1", "t2", "t3"]

        # Wait for the stubbed run to finish so cleanup is clean.
        task = server_mod._RUNNING_EXECUTORS.get((flow_id, "execute"))
        if task is not None:
            await task
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


async def test_start_rejects_isolation_branch():
    flow_id = await _dispatch_to_parallel(_SPEC_BRANCH, num_tasks=2)
    try:
        resp = await stratum_parallel_start(
            flow_id=flow_id, step_id="execute", ctx=None,
        )
        assert "error" in resp
        assert "T2-F5-BRANCH" in str(resp["error"])
        # FlowState unchanged — no parallel_tasks entries.
        state = _flows[flow_id]
        assert state.parallel_tasks == {}
        # No registered executor task.
        assert (flow_id, "execute") not in server_mod._RUNNING_EXECUTORS
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


async def test_start_rejects_when_step_not_parallel_dispatch():
    result = await stratum_plan(
        spec=_SPEC_INLINE_ONLY, flow="main", inputs={}, ctx=None,
    )
    flow_id = result["flow_id"]
    try:
        resp = await stratum_parallel_start(
            flow_id=flow_id, step_id="only", ctx=None,
        )
        assert "error" in resp
        assert (flow_id, "only") not in server_mod._RUNNING_EXECUTORS
    finally:
        _flows.pop(flow_id, None)


# ---------------------------------------------------------------------------
# poll
# ---------------------------------------------------------------------------

async def test_poll_before_start_returns_error():
    flow_id = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    try:
        resp = await stratum_parallel_poll(
            flow_id=flow_id, step_id="execute", ctx=None,
        )
        assert "error" in resp
        assert "not dispatched" in str(resp["error"]).lower() \
            or "not started" in str(resp["error"]).lower()
    finally:
        _flows.pop(flow_id, None)


async def test_poll_mid_flight_reports_progress(monkeypatch):
    """While tasks pause on an Event, poll reports running > 0.
    After the Event fires and tasks settle, poll returns the final state.
    """
    gate = asyncio.Event()

    async def fake_run(self):
        import time as _time
        # Mark all tasks running, then wait on the gate.
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "running"
            ts.started_at = _time.time()
        self._persist_callable(self.state)
        await gate.wait()
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run)

    flow_id = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=3)
    try:
        await stratum_parallel_start(flow_id=flow_id, step_id="execute", ctx=None)
        # Let the fake_run advance to "running".
        for _ in range(20):
            await asyncio.sleep(0.01)
            running = sum(
                1 for ts in _flows[flow_id].parallel_tasks.values()
                if ts.state == "running"
            )
            if running > 0:
                break

        mid = await stratum_parallel_poll(
            flow_id=flow_id, step_id="execute", ctx=None,
        )
        assert mid["summary"]["running"] >= 1
        assert mid["can_advance"] is False
        assert mid["outcome"] is None

        gate.set()
        # Wait for the executor task to finish.
        task = server_mod._RUNNING_EXECUTORS.get((flow_id, "execute"))
        if task is not None:
            await task

        final = await stratum_parallel_poll(
            flow_id=flow_id, step_id="execute", ctx=None,
        )
        assert final["summary"]["complete"] == 3
        assert final["summary"]["running"] == 0
        assert final["can_advance"] is True
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


async def test_poll_after_completion_is_idempotent(monkeypatch):
    async def fake_run(self):
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = _time.time()
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run)

    flow_id = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    try:
        # Install the process_step_result spy AFTER the analyze-step advance so
        # the counter only reflects the parallel-step advance(s).
        advance_calls = {"count": 0}
        orig_psr = server_mod.process_step_result

        def spy_psr(state, step_id, result):
            advance_calls["count"] += 1
            return orig_psr(state, step_id, result)

        monkeypatch.setattr(server_mod, "process_step_result", spy_psr)

        await stratum_parallel_start(flow_id=flow_id, step_id="execute", ctx=None)
        task = server_mod._RUNNING_EXECUTORS.get((flow_id, "execute"))
        if task is not None:
            await task

        r1 = await stratum_parallel_poll(flow_id=flow_id, step_id="execute", ctx=None)
        r2 = await stratum_parallel_poll(flow_id=flow_id, step_id="execute", ctx=None)
        r3 = await stratum_parallel_poll(flow_id=flow_id, step_id="execute", ctx=None)

        assert r1["can_advance"] is True
        # Counts identical across polls.
        assert r1["summary"] == r2["summary"] == r3["summary"]
        # process_step_result invoked at most once for the parallel step.
        assert advance_calls["count"] <= 1, (
            f"expected <=1 advance, got {advance_calls['count']}"
        )
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


# ---------------------------------------------------------------------------
# shared helper
# ---------------------------------------------------------------------------

async def test_evaluate_parallel_results_shared_across_done_and_poll():
    """Two FlowStates at the same parallel step: one given consumer-supplied
    task_results (done path), one assembled from state.parallel_tasks (poll
    path). Calling the shared helper on both MUST return identical
    (can_advance, outcome).
    """
    fid_a = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    fid_b = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    try:
        state_a = _flows[fid_a]
        state_b = _flows[fid_b]
        step_a = state_a.ordered_steps[state_a.current_idx]
        step_b = state_b.ordered_steps[state_b.current_idx]

        # done-style: consumer-supplied task_results.
        done_results = [
            {"task_id": "t1", "result": {"ok": True}, "status": "complete"},
            {"task_id": "t2", "result": {"ok": True}, "status": "complete"},
        ]

        # poll-style: seeded ParallelTaskState → convert to task_results shape.
        import time as _time
        for tid in ("t1", "t2"):
            ts = ParallelTaskState(task_id=tid)
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = _time.time()
            ts.finished_at = _time.time()
            state_b.parallel_tasks[tid] = ts
        poll_results = [
            {"task_id": tid, "result": ts.result,
             "status": "complete" if ts.state == "complete" else "failed"}
            for tid, ts in state_b.parallel_tasks.items()
        ]

        can_a, out_a = _evaluate_parallel_results(state_a, step_a, done_results)
        can_b, out_b = _evaluate_parallel_results(state_b, step_b, poll_results)

        assert can_a == can_b
        # Compare the aggregate (the payload handed to process_step_result).
        assert out_a["aggregate"]["outcome"] == out_b["aggregate"]["outcome"]
        assert out_a["aggregate"]["completed"] == out_b["aggregate"]["completed"]
        assert out_a["aggregate"]["failed"] == out_b["aggregate"]["failed"]
        assert out_a["require_satisfied"] == out_b["require_satisfied"]
    finally:
        _flows.pop(fid_a, None)
        _flows.pop(fid_b, None)


# ---------------------------------------------------------------------------
# T2-F5-DEFER-ADVANCE: defer_advance sentinel tests
# ---------------------------------------------------------------------------


async def test_poll_with_defer_advance_returns_awaiting_consumer_advance(monkeypatch):
    """defer_advance:true — poll on terminal emits sentinel, no auto-advance."""
    async def fake_run(self):
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = _time.time()
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run)

    flow_id = await _dispatch_to_parallel(_SPEC_DEFER, num_tasks=2)
    state = _flows[flow_id]
    try:
        await stratum_parallel_start(flow_id=flow_id, step_id="execute", ctx=None)
        task = server_mod._RUNNING_EXECUTORS.get((flow_id, "execute"))
        if task is not None:
            await task

        result = await stratum_parallel_poll(flow_id=flow_id, step_id="execute", ctx=None)

        assert result["outcome"] is not None
        assert result["outcome"]["status"] == "awaiting_consumer_advance"
        assert "aggregate" in result["outcome"]
        # Flow must NOT have advanced.
        cur_step = state.ordered_steps[state.current_idx]
        assert cur_step.id == "execute", "flow advanced unexpectedly"
        # Executor registry entry must still be present.
        assert (flow_id, "execute") in server_mod._RUNNING_EXECUTORS
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


async def test_poll_without_defer_advance_auto_advances_as_before(monkeypatch):
    """Regression: steps without defer_advance auto-advance as today."""
    async def fake_run(self):
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = _time.time()
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run)

    flow_id = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    state = _flows[flow_id]
    step_idx_before = state.current_idx
    try:
        await stratum_parallel_start(flow_id=flow_id, step_id="execute", ctx=None)
        task = server_mod._RUNNING_EXECUTORS.get((flow_id, "execute"))
        if task is not None:
            await task

        result = await stratum_parallel_poll(flow_id=flow_id, step_id="execute", ctx=None)

        assert result["outcome"] is not None
        assert result["outcome"].get("status") != "awaiting_consumer_advance"
        # Flow must have advanced past the parallel step.
        assert state.current_idx > step_idx_before
        # Executor registry entry must be gone.
        assert (flow_id, "execute") not in server_mod._RUNNING_EXECUTORS
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id, "execute"), None)
        _flows.pop(flow_id, None)


async def test_awaiting_consumer_advance_status_unique_to_defer_path(monkeypatch):
    """The sentinel status must not be emitted by any other poll outcome path."""
    gate = asyncio.Event()

    async def fake_run_inflight(self):
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "running"
            ts.started_at = _time.time()
        self._persist_callable(self.state)
        await gate.wait()
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run_inflight)

    flow_id_inflight = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    try:
        await stratum_parallel_start(flow_id=flow_id_inflight, step_id="execute", ctx=None)
        # Wait until at least one task is running.
        for _ in range(20):
            await asyncio.sleep(0.01)
            if any(ts.state == "running" for ts in _flows[flow_id_inflight].parallel_tasks.values()):
                break

        mid = await stratum_parallel_poll(flow_id=flow_id_inflight, step_id="execute", ctx=None)
        assert mid["outcome"] is None  # in-flight: no outcome yet
        gate.set()
        task = server_mod._RUNNING_EXECUTORS.get((flow_id_inflight, "execute"))
        if task is not None:
            await task

        final = await stratum_parallel_poll(flow_id=flow_id_inflight, step_id="execute", ctx=None)
        assert final["outcome"] is not None
        assert final["outcome"].get("status") != "awaiting_consumer_advance"
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id_inflight, "execute"), None)
        _flows.pop(flow_id_inflight, None)

    # Already-advanced path returns "already_advanced", not the sentinel.
    async def fake_run_complete(self):
        import time as _time
        for t in self.tasks:
            ts = self.state.parallel_tasks[t["id"]]
            ts.state = "complete"
            ts.result = {"ok": True}
            ts.started_at = _time.time()
            ts.finished_at = _time.time()
        self._persist_callable(self.state)

    monkeypatch.setattr(parallel_exec_mod.ParallelExecutor, "run", fake_run_complete)

    flow_id_aa = await _dispatch_to_parallel(_SPEC_NONE, num_tasks=2)
    try:
        await stratum_parallel_start(flow_id=flow_id_aa, step_id="execute", ctx=None)
        task = server_mod._RUNNING_EXECUTORS.get((flow_id_aa, "execute"))
        if task is not None:
            await task

        r1 = await stratum_parallel_poll(flow_id=flow_id_aa, step_id="execute", ctx=None)
        r2 = await stratum_parallel_poll(flow_id=flow_id_aa, step_id="execute", ctx=None)

        assert r1["outcome"].get("status") != "awaiting_consumer_advance"
        assert r2["outcome"]["status"] == "already_advanced"
    finally:
        server_mod._RUNNING_EXECUTORS.pop((flow_id_aa, "execute"), None)
        _flows.pop(flow_id_aa, None)
