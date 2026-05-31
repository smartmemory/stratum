"""STRAT-WORKFLOW-BG: server-driven background flow execution (v1 linear driver).

Drives the _background_flow_advance loop with stratum_agent_run stubbed to a
deterministic structured result, and asserts: autonomous linear advance to
complete (zero consumer step_done), gate pause + resume, handoff at a parallel
step, dispatch-error halt, budget halt, ownership guard, and cancel-vs-resumable
semantics.
"""
import asyncio
import json

import pytest

from stratum_mcp import server as srv
from stratum_mcp.executor import (
    create_flow_state,
    persist_flow,
    restore_flow,
)
from stratum_mcp.spec import parse_and_validate


@pytest.fixture
def flows_dir(tmp_path, monkeypatch):
    import stratum_mcp.executor as ex
    monkeypatch.setattr(ex, "_FLOWS_DIR", tmp_path / "flows")
    return tmp_path / "flows"


@pytest.fixture(autouse=True)
def _clean_bg(monkeypatch):
    srv._BG_FLOWS.clear()
    srv._flows.clear()
    monkeypatch.setattr(srv, "_BG_SHUTTING_DOWN", False)
    yield
    srv._BG_FLOWS.clear()
    srv._flows.clear()


def _good_agent_run(*, fail_steps=None):
    """Build a fake stratum_agent_run that returns a structured result honoring
    the requested schema. `fail_steps` names step prompts whose result is bad."""
    fail_steps = fail_steps or set()

    async def fake(prompt, ctx, type="claude", context=None, schema=None,
                   correlation_id=None, cwd=None, **kw):
        if any(f in prompt for f in fail_steps):
            return {"text": "oops", "parseError": "no json"}
        if schema and schema.get("properties"):
            result = {k: f"out::{k}" for k in schema["properties"]}
        else:
            result = {"value": "out"}
        return {"text": json.dumps(result), "result": result}

    return fake


def _linear_spec(n=3):
    fns = "\n".join(
        f"""  f{i}:
    mode: compute
    intent: "Step {i}"
    input: {{x: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]"""
        for i in range(1, n + 1)
    )
    steps = "\n".join(
        f"""      - id: s{i}
        function: f{i}
        inputs: {{x: "$.input.topic"}}"""
        for i in range(1, n + 1)
    )
    return f"""
version: "0.2"
contracts:
  Out:
    value: {{type: string}}
functions:
{fns}
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
{steps}
"""


def _make_flow(ir):
    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "main", {"topic": "alpha"}, raw_spec=ir)
    srv._flows[state.flow_id] = state
    persist_flow(state)
    return state


async def _drive_to_done(flow_id):
    resp = await srv.stratum_flow_run_bg(flow_id=flow_id, ctx=None)
    task = srv._BG_FLOWS.get(flow_id)
    if task is not None:
        await task
    return resp


# --- S1: persistence round-trip --------------------------------------------

def test_bg_fields_round_trip(flows_dir):
    state = _make_flow(_linear_spec(2))
    state.flow_mode = "server_driven"
    state.bg_status = "paused_gate"
    state.bg_pause_reason = "gate:s2"
    persist_flow(state)
    restored = restore_flow(state.flow_id)
    assert restored.flow_mode == "server_driven"
    assert restored.bg_status == "paused_gate"
    assert restored.bg_pause_reason == "gate:s2"


def test_bg_fields_default_on_legacy(flows_dir):
    state = _make_flow(_linear_spec(1))
    restored = restore_flow(state.flow_id)
    assert restored.flow_mode == "consumer_turn"
    assert restored.bg_status is None


# --- S3/S6: autonomous linear advance --------------------------------------

@pytest.mark.asyncio
async def test_autonomous_linear_advance_to_complete(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run())
    state = _make_flow(_linear_spec(3))
    await _drive_to_done(state.flow_id)
    assert state.bg_status == "complete"
    assert state.flow_mode == "server_driven"
    assert state.current_idx == 3
    # One StepRecord per step, all server-driven, zero consumer step_done calls.
    assert [r.step_id for r in state.records] == ["s1", "s2", "s3"]


@pytest.mark.asyncio
async def test_bad_dispatch_halts_error(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run(fail_steps={"Step 2"}))
    state = _make_flow(_linear_spec(3))
    await _drive_to_done(state.flow_id)
    assert state.bg_status == "error"
    assert "s2" in (state.bg_pause_reason or "")
    # s1 completed; s2 consumed real (persisted) attempts then exhausted retries
    # → recorded as the failed step; s3 never reached.
    assert [r.step_id for r in state.records] == ["s1", "s2"]
    assert state.attempts.get("s2", 0) >= 1  # durable attempt accounting
    assert state.terminal_status is None  # resumable


# --- S3: gate pause / resume ------------------------------------------------

def _gate_spec():
    return """
version: "0.2"
contracts:
  Out:
    value: {type: string}
functions:
  work:
    mode: compute
    intent: "Work"
    input: {x: {type: string}}
    output: Out
    ensure: ["len(result.value) > 0"]
  approve:
    mode: gate
    intent: "Approve"
    input: {x: {type: string}}
    output: Out
flows:
  main:
    input: {topic: {type: string}}
    output: Out
    steps:
      - id: s1
        function: work
        inputs: {x: "$.input.topic"}
      - id: g
        function: approve
        inputs: {x: "$.input.topic"}
        on_approve: s3
        on_revise: s1
        on_kill: null
      - id: s3
        function: work
        inputs: {x: "$.input.topic"}
"""


@pytest.mark.asyncio
async def test_gate_pauses_loop(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run())
    state = _make_flow(_gate_spec())
    await _drive_to_done(state.flow_id)
    assert state.bg_status == "paused_gate"
    assert "g" in (state.bg_pause_reason or "")
    assert state.terminal_status is None  # resumable for gate resolution
    # s1 ran; the gate stopped the loop before s3.
    assert [r.step_id for r in state.records] == ["s1"]


# --- S3: handoff at a parallel step ----------------------------------------

def _parallel_spec():
    return """
version: "0.3"
contracts:
  Out:
    value: {type: string}
functions:
  work:
    mode: compute
    intent: "Work"
    input: {x: {type: string}}
    output: Out
    ensure: ["len(result.value) > 0"]
flows:
  main:
    input: {topic: {type: string}}
    output: Out
    steps:
      - id: s1
        function: work
        inputs: {x: "$.input.topic"}
      - id: fan
        type: parallel_dispatch
        source: "$.input.topic"
        intent_template: "do {item}"
        depends_on: [s1]
"""


@pytest.mark.asyncio
async def test_handoff_at_parallel_step(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run())
    state = _make_flow(_parallel_spec())
    await _drive_to_done(state.flow_id)
    assert state.bg_status == "handoff:parallel_dispatch"
    assert state.terminal_status is None  # resumable; consumer runs the parallel step


# --- S3: budget halt --------------------------------------------------------

@pytest.mark.asyncio
async def test_budget_exhausted_halts(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run())
    state = _make_flow(_linear_spec(3))
    # Pre-exhaust the run budget so the loop's hard-stop gate trips immediately.
    state.budget_state = {
        "caps": {"max_agent_dispatches": 1},
        "consumed": {"wall_s": 0.0, "dispatches": 5, "tokens": 0, "dollars": 0.0},
    }
    await _drive_to_done(state.flow_id)
    assert state.bg_status == "budget_exhausted"
    assert state.terminal_status == srv.BUDGET_EXHAUSTED


# --- S4: tools + ownership guard -------------------------------------------

@pytest.mark.asyncio
async def test_run_bg_not_found(flows_dir):
    resp = await srv.stratum_flow_run_bg(flow_id="nope", ctx=None)
    assert resp["status"] == "not_found"


@pytest.mark.asyncio
async def test_poll_reports_complete(flows_dir, monkeypatch):
    monkeypatch.setattr(srv, "stratum_agent_run", _good_agent_run())
    state = _make_flow(_linear_spec(2))
    await _drive_to_done(state.flow_id)
    poll = await srv.stratum_flow_bg_poll(flow_id=state.flow_id, ctx=None)
    assert poll["status"] == "complete"
    assert poll["steps_completed"] == 2
    assert poll["total_steps"] == 2


@pytest.mark.asyncio
async def test_step_done_refused_while_bg_owned(flows_dir, monkeypatch):
    # Hold the dispatch so the BG task stays live while we race a step_done.
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(prompt, ctx, **kw):
        started.set()
        await release.wait()
        return {"text": "{}", "result": {"value": "v"}}

    monkeypatch.setattr(srv, "stratum_agent_run", slow)
    state = _make_flow(_linear_spec(2))
    await srv.stratum_flow_run_bg(flow_id=state.flow_id, ctx=None)
    task = srv._BG_FLOWS.get(state.flow_id)
    await asyncio.wait_for(started.wait(), timeout=2)

    resp = await srv.stratum_step_done(
        flow_id=state.flow_id, step_id="s1", result={"value": "x"}, ctx=None
    )
    assert resp["status"] == "bg_owned"

    release.set()
    await task


# --- S5: cancel (terminal) vs shutdown drain (resumable) -------------------

@pytest.mark.asyncio
async def test_explicit_cancel_is_terminal(flows_dir, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(prompt, ctx, **kw):
        started.set()
        await release.wait()
        return {"text": "{}", "result": {"value": "v"}}

    monkeypatch.setattr(srv, "stratum_agent_run", slow)
    state = _make_flow(_linear_spec(2))
    await srv.stratum_flow_run_bg(flow_id=state.flow_id, ctx=None)
    await asyncio.wait_for(started.wait(), timeout=2)

    resp = await srv.stratum_flow_cancel_bg(flow_id=state.flow_id, ctx=None)
    assert resp["status"] == "cancelled"
    assert state.bg_status == "cancelled"
    assert state.terminal_status == "cancelled"


@pytest.mark.asyncio
async def test_connector_exception_finalizes_error(flows_dir, monkeypatch):
    async def boom(prompt, ctx, **kw):
        raise RuntimeError("connector blew up")

    monkeypatch.setattr(srv, "stratum_agent_run", boom)
    state = _make_flow(_linear_spec(2))
    await _drive_to_done(state.flow_id)
    # The unexpected error leaves a durable, resumable error snapshot — not an
    # orphaned `running` flow.
    assert state.bg_status == "error"
    assert state.terminal_status is None
    assert state.flow_id not in srv._BG_FLOWS


@pytest.mark.asyncio
async def test_resume_refused_while_bg_owned(flows_dir, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(prompt, ctx, **kw):
        started.set()
        await release.wait()
        return {"text": "{}", "result": {"value": "v"}}

    monkeypatch.setattr(srv, "stratum_agent_run", slow)
    state = _make_flow(_linear_spec(2))
    await srv.stratum_flow_run_bg(flow_id=state.flow_id, ctx=None)
    task = srv._BG_FLOWS.get(state.flow_id)
    await asyncio.wait_for(started.wait(), timeout=2)

    resp = await srv.stratum_resume(flow_id=state.flow_id, ctx=None)
    assert resp["status"] == "bg_owned"

    release.set()
    await task


@pytest.mark.asyncio
async def test_explicit_cancel_authoritative_under_shutdown_race(flows_dir, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(prompt, ctx, **kw):
        started.set()
        await release.wait()
        return {"text": "{}", "result": {"value": "v"}}

    monkeypatch.setattr(srv, "stratum_agent_run", slow)
    state = _make_flow(_linear_spec(2))
    await srv.stratum_flow_run_bg(flow_id=state.flow_id, ctx=None)
    task = srv._BG_FLOWS.get(state.flow_id)
    await asyncio.wait_for(started.wait(), timeout=2)

    # Shutdown flag is set, but an explicit per-flow cancel must still win.
    monkeypatch.setattr(srv, "_BG_SHUTTING_DOWN", True)
    srv._BG_CANCEL_REQUESTED.add(state.flow_id)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert state.bg_status == "cancelled"
    assert state.terminal_status == "cancelled"


@pytest.mark.asyncio
async def test_shutdown_drain_is_resumable(flows_dir, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow(prompt, ctx, **kw):
        started.set()
        await release.wait()
        return {"text": "{}", "result": {"value": "v"}}

    monkeypatch.setattr(srv, "stratum_agent_run", slow)
    state = _make_flow(_linear_spec(2))
    await srv.stratum_flow_run_bg(flow_id=state.flow_id, ctx=None)
    task = srv._BG_FLOWS.get(state.flow_id)
    await asyncio.wait_for(started.wait(), timeout=2)

    # Simulate a shutdown drain: flag set BEFORE cancel.
    monkeypatch.setattr(srv, "_BG_SHUTTING_DOWN", True)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    # Resumable: not terminalized, current_idx intact at the un-finished step.
    assert state.terminal_status is None
    assert state.bg_status == "running"
