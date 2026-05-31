"""STRAT-WORKFLOW-RESUME S8: golden end-to-end result-cache behavior.

Drives a 4-step chained compute flow at the executor level (get_current_step_info
→ process_step_result), with the cache redirected to a tmp dir. Asserts:

  * identical re-run → all 4 steps hit (zero dispatches), recorded cache_hit=True;
  * editing a later step's function intent → earlier steps still hit (prefix
    property), the edited step re-dispatches;
  * changing a flow input consumed by step 1 → the whole chain misses (cascade);
  * STRATUM_DISABLE_RESULT_CACHE=1 → every step misses (kill switch);
  * a hit dispatches no agent (the budget guarantee — debit happens only on
    dispatch).
"""
import json

import pytest

from stratum_mcp import result_cache
from stratum_mcp.executor import (
    create_flow_state,
    get_current_step_info,
    persist_flow,
    process_step_result,
    restore_flow,
)
from stratum_mcp.spec import parse_and_validate


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    """Redirect the content-addressed cache to a tmp dir and reset the env."""
    d = tmp_path / "cache" / "results"
    monkeypatch.setattr(result_cache, "_cache_dir", lambda: d)
    monkeypatch.delenv("STRATUM_DISABLE_RESULT_CACHE", raising=False)
    return d


def _spec(s3_intent="Step three"):
    # Four chained compute steps, each its own function so a single function's
    # intent can be edited in isolation. All steps opt into caching.
    return f"""
version: "0.2"
contracts:
  Out:
    value: {{type: string}}
functions:
  f1:
    mode: compute
    intent: "Step one"
    input: {{topic: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]
  f2:
    mode: compute
    intent: "Step two"
    input: {{prev: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]
  f3:
    mode: compute
    intent: "{s3_intent}"
    input: {{prev: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]
  f4:
    mode: compute
    intent: "Step four"
    input: {{prev: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
      - id: s1
        function: f1
        inputs: {{topic: "$.input.topic"}}
        cache: true
      - id: s2
        function: f2
        inputs: {{prev: "$.steps.s1.output.value"}}
        depends_on: [s1]
        cache: true
      - id: s3
        function: f3
        inputs: {{prev: "$.steps.s2.output.value"}}
        depends_on: [s2]
        cache: true
      - id: s4
        function: f4
        inputs: {{prev: "$.steps.s3.output.value"}}
        depends_on: [s3]
        cache: true
"""


def _produce(step_id, inputs):
    """Deterministic agent stand-in: output is a pure function of (step, inputs)."""
    return {"value": f"{step_id}|{json.dumps(inputs, sort_keys=True)}"}


def _drive(state, producer=_produce):
    """Run the flow to completion, returning the list of dispatched step ids."""
    dispatched = []
    while True:
        info = get_current_step_info(state)
        if info is None:
            break
        assert info["status"] == "execute_step", info
        sid = info["step_id"]
        dispatched.append(sid)
        status, violations = process_step_result(state, sid, producer(sid, info["inputs"]))
        assert status == "ok", (sid, status, violations)
    return dispatched


def _run(ir, topic="alpha", producer=_produce):
    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "main", {"topic": topic}, raw_spec=ir)
    return state, _drive(state, producer)


def test_first_run_dispatches_all_then_rerun_all_hit():
    ir = _spec()
    state1, d1 = _run(ir)
    assert d1 == ["s1", "s2", "s3", "s4"]

    state2, d2 = _run(ir)
    assert d2 == []  # every step served from cache, zero dispatches

    # All four records are cache hits, and the outputs match the first run.
    assert [r.cache_hit for r in state2.records] == [True, True, True, True]
    assert all(r.cache_key for r in state2.records)
    assert state2.step_outputs == state1.step_outputs


def test_edit_late_step_intent_keeps_prefix_hits():
    ir = _spec()
    _run(ir)  # populate

    # Edit step 3's function intent. Steps 1-2 keys are unchanged → they hit.
    # Step 3's fn fingerprint changed → it re-dispatches. Step 4's input (s3's
    # output) is unchanged by the deterministic producer → s4 still hits.
    edited = _spec(s3_intent="Step three — REVISED")
    _, d = _run(edited)
    assert "s1" not in d and "s2" not in d
    assert "s3" in d


def test_change_flow_input_misses_whole_chain():
    ir = _spec()
    _run(ir, topic="alpha")  # populate

    # A different flow input changes s1's resolved input → s1 misses → its output
    # changes → cascades through every downstream step.
    _, d = _run(ir, topic="BETA")
    assert d == ["s1", "s2", "s3", "s4"]


def test_kill_switch_forces_all_miss(monkeypatch):
    ir = _spec()
    _run(ir)  # populate

    monkeypatch.setenv("STRATUM_DISABLE_RESULT_CACHE", "1")
    _, d = _run(ir)
    assert d == ["s1", "s2", "s3", "s4"]


def test_hit_run_records_no_dispatch_budget_guarantee():
    ir = _spec()
    _run(ir)  # populate
    state, d = _run(ir)
    # No execute_step dispatch was yielded → no agent ran → nothing to debit.
    assert d == []
    assert all(r.cache_hit for r in state.records)


def test_failing_ensure_is_not_cached(cache_dir):
    # f1's ensure requires a non-empty value; an empty result fails it and must
    # never be written to the cache. The eventual passing result is the only
    # thing cached.
    ir = _spec()
    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "main", {"topic": "alpha"}, raw_spec=ir)

    info = get_current_step_info(state)
    assert info["step_id"] == "s1"
    # First attempt fails ensure (empty value), retries remain.
    status, _ = process_step_result(state, "s1", {"value": ""})
    assert status == "ensure_failed"
    # Nothing cached yet: a fresh run would still have to dispatch s1.
    assert not list(cache_dir.glob("*.json"))

    # Second attempt passes; now (and only now) it is cached.
    status, _ = process_step_result(state, "s1", {"value": "ok"})
    assert status == "ok"
    assert list(cache_dir.glob("*.json"))


def test_cache_hit_records_round_trip_through_persist(tmp_path, monkeypatch):
    # cache_hit / cache_key on StepRecord must survive persist → restore so the
    # audit of a resumed flow still shows replays (blueprint K2).
    monkeypatch.setattr("stratum_mcp.executor._FLOWS_DIR", tmp_path / "flows")
    ir = _spec()
    _run(ir)  # populate the cache

    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "main", {"topic": "alpha"}, raw_spec=ir)
    _drive(state)  # all cache hits
    assert [r.cache_hit for r in state.records] == [True, True, True, True]
    persist_flow(state)

    restored = restore_flow(state.flow_id)
    assert restored is not None
    assert [r.cache_hit for r in restored.records] == [True, True, True, True]
    assert all(r.cache_key for r in restored.records)
