"""T2-F5-ENFORCE T8/T9: FlowState.parallel_tasks, FlowState.cwd, ParallelTaskState dataclass.

Covers:
- Default values for new fields.
- persist_flow / restore_flow round-trip of parallel_tasks (dict[str, ParallelTaskState])
  and cwd.
- stratum_plan captures os.getcwd() on flow creation.
"""
from __future__ import annotations

import pytest
from unittest.mock import MagicMock

import stratum_mcp.executor as executor_mod
from stratum_mcp.executor import (
    FlowState,
    ParallelTaskState,
    create_flow_state,
    persist_flow,
    restore_flow,
)
from stratum_mcp.server import stratum_plan, _flows
from stratum_mcp.spec import parse_and_validate


SIMPLE_IR = """
version: "0.1"
contracts:
  Out:
    value: {type: string}
functions:
  extract:
    mode: infer
    intent: "Extract a value"
    input: {text: {type: string}}
    output: Out
    retries: 2
flows:
  run:
    input: {text: {type: string}}
    output: Out
    steps:
      - id: s1
        function: extract
        inputs: {text: "$.input.text"}
"""


@pytest.fixture(autouse=True)
def patch_flows_dir(tmp_path, monkeypatch):
    """Redirect persistence I/O to a temp directory for each test."""
    monkeypatch.setattr(executor_mod, "_FLOWS_DIR", tmp_path / "flows")
    yield tmp_path / "flows"


# ---------------------------------------------------------------------------
# Default values
# ---------------------------------------------------------------------------

def test_parallel_tasks_default_empty():
    """FlowState created via create_flow_state starts with empty parallel_tasks and cwd=''."""
    spec = parse_and_validate(SIMPLE_IR)
    state = create_flow_state(spec, "run", {"text": "hi"}, raw_spec=SIMPLE_IR)
    assert state.parallel_tasks == {}
    assert state.cwd == ""


def test_parallel_task_state_defaults():
    """ParallelTaskState has the contract-specified defaults for all fields."""
    t = ParallelTaskState(task_id="t1")
    assert t.task_id == "t1"
    assert t.state == "pending"
    assert t.started_at is None
    assert t.finished_at is None
    assert t.result is None
    assert t.error is None
    assert t.cert_violations is None
    assert t.worktree_path is None


# ---------------------------------------------------------------------------
# Persistence round-trip
# ---------------------------------------------------------------------------

def test_flowstate_round_trip_persists_parallel_tasks(patch_flows_dir):
    """parallel_tasks serializes to JSON and deserializes back to ParallelTaskState instances."""
    spec = parse_and_validate(SIMPLE_IR)
    state = create_flow_state(spec, "run", {"text": "hi"}, raw_spec=SIMPLE_IR)
    state.parallel_tasks = {
        "t1": ParallelTaskState(
            task_id="t1",
            state="complete",
            started_at=1.0,
            finished_at=2.5,
            result={"ok": True},
            worktree_path="/tmp/wt/t1",
        ),
        "t2": ParallelTaskState(
            task_id="t2",
            state="failed",
            error="boom",
            cert_violations=["missing:file.txt"],
        ),
    }
    state.cwd = "/some/working/dir"

    persist_flow(state)
    loaded = restore_flow(state.flow_id)

    assert loaded is not None
    # Must reconstitute as ParallelTaskState, NOT dict.
    assert isinstance(loaded.parallel_tasks, dict)
    assert set(loaded.parallel_tasks.keys()) == {"t1", "t2"}
    assert isinstance(loaded.parallel_tasks["t1"], ParallelTaskState)
    assert isinstance(loaded.parallel_tasks["t2"], ParallelTaskState)

    t1 = loaded.parallel_tasks["t1"]
    assert t1.task_id == "t1"
    assert t1.state == "complete"
    assert t1.started_at == 1.0
    assert t1.finished_at == 2.5
    assert t1.result == {"ok": True}
    assert t1.worktree_path == "/tmp/wt/t1"

    t2 = loaded.parallel_tasks["t2"]
    assert t2.state == "failed"
    assert t2.error == "boom"
    assert t2.cert_violations == ["missing:file.txt"]

    assert loaded.cwd == "/some/working/dir"


def test_flowstate_round_trip_empty_parallel_tasks(patch_flows_dir):
    """Legacy flows with no parallel_tasks still round-trip cleanly."""
    spec = parse_and_validate(SIMPLE_IR)
    state = create_flow_state(spec, "run", {"text": "hi"}, raw_spec=SIMPLE_IR)

    persist_flow(state)
    loaded = restore_flow(state.flow_id)

    assert loaded is not None
    assert loaded.parallel_tasks == {}
    assert loaded.cwd == ""


def test_restore_flow_handles_missing_parallel_tasks_field(patch_flows_dir):
    """Persisted flows from before this feature land (no parallel_tasks/cwd keys) still restore."""
    import json
    spec = parse_and_validate(SIMPLE_IR)
    state = create_flow_state(spec, "run", {"text": "hi"}, raw_spec=SIMPLE_IR)
    persist_flow(state)

    # Simulate pre-feature payload: strip new keys from the JSON.
    path = patch_flows_dir / f"{state.flow_id}.json"
    payload = json.loads(path.read_text())
    payload.pop("parallel_tasks", None)
    payload.pop("cwd", None)
    path.write_text(json.dumps(payload))

    loaded = restore_flow(state.flow_id)
    assert loaded is not None
    assert loaded.parallel_tasks == {}
    assert loaded.cwd == ""


# ---------------------------------------------------------------------------
# stratum_plan captures cwd
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cwd_set_on_plan(patch_flows_dir, monkeypatch):
    """stratum_plan snapshots os.getcwd() onto state.cwd at flow creation."""
    monkeypatch.setattr("stratum_mcp.server.os.getcwd", lambda: "/some/path")
    ctx = MagicMock()

    plan = await stratum_plan(SIMPLE_IR, "run", {"text": "hi"}, ctx)
    flow_id = plan["flow_id"]

    state = _flows[flow_id]
    assert state.cwd == "/some/path"

    # Persisted value matches.
    loaded = restore_flow(flow_id)
    assert loaded is not None
    assert loaded.cwd == "/some/path"
