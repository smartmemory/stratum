"""Integration tests for the iteration accumulator + loop-until-dry (STRAT-WORKFLOW-IMPERATIVE).

Covers:
  - IR parse/validate: accumulate requires max_iterations; accumulate_key requires accumulate;
    dunder guards; gate-step rejection.
  - Dedup across iterations (default whole-item key) + accumulator exposed to exit_criterion.
  - Custom accumulate_key dedup; non-hashable key result canonicalized.
  - Loop-until-dry: exit_criterion 'dry_streak >= K' exits on K consecutive zero-new rounds.
  - accumulate_error freezes dry_streak (extraction bug never manufactures a dry exit).
  - Per-item key eval failure → identity fallback.
  - Authoritative output merge in process_step_result (after validation).
  - Persist/restore + checkpoint round-trip of iteration_accumulator.
  - Spec checksum covers accumulate/accumulate_key (tamper detection).
"""
import textwrap

import pytest

from stratum_mcp.executor import (
    _flows,
    compute_spec_checksum,
    create_flow_state,
    get_current_step_info,
    process_step_result,
    start_iteration,
    report_iteration,
    persist_flow,
    restore_flow,
    delete_persisted_flow,
    commit_checkpoint,
    revert_checkpoint,
)
from stratum_mcp.spec import IRSemanticError, parse_and_validate


def _acc_spec(exit_criterion="dry_streak >= 2", accumulate_key=None, max_iterations=10):
    key_line = f"                accumulate_key: \"{accumulate_key}\"\n" if accumulate_key else ""
    return textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            findings: {type: array}
        functions:
          work:
            mode: infer
            intent: "Find things"
            input: {}
            output: Out
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
                max_iterations: %d
                exit_criterion: "%s"
                accumulate: "result.findings"
%s""") % (max_iterations, exit_criterion, key_line)


@pytest.fixture(autouse=True)
def _cleanup():
    _flows.clear()
    yield
    _flows.clear()


def _new_state(spec_yaml):
    spec = parse_and_validate(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    _flows[state.flow_id] = state
    return state


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def test_accumulate_requires_max_iterations():
    bad = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            findings: {type: array}
        functions:
          work: {mode: infer, intent: "x", input: {}, output: Out}
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
                accumulate: "result.findings"
""")
    with pytest.raises(IRSemanticError, match="accumulate but no max_iterations"):
        parse_and_validate(bad)


def test_accumulate_key_requires_accumulate():
    bad = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            findings: {type: array}
        functions:
          work: {mode: infer, intent: "x", input: {}, output: Out}
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
                max_iterations: 3
                accumulate_key: "item.id"
""")
    with pytest.raises(IRSemanticError, match="accumulate_key but no accumulate"):
        parse_and_validate(bad)


def test_accumulate_dunder_guard():
    bad = _acc_spec().replace('accumulate: "result.findings"',
                              'accumulate: "result.__class__"')
    with pytest.raises(IRSemanticError, match="dunder"):
        parse_and_validate(bad)


def test_accumulate_rejected_on_parallel_dispatch_step():
    bad = textwrap.dedent("""\
        version: "0.3"
        flows:
          main:
            input: {}
            steps:
              - id: s1
                type: parallel_dispatch
                source: "$.input.items"
                agent: claude
                intent_template: "process {{task}}"
                max_iterations: 3
                accumulate: "result.findings"
""")
    with pytest.raises(IRSemanticError, match="accumulate"):
        parse_and_validate(bad)


def test_accumulate_rejected_on_gate_step():
    bad = textwrap.dedent("""\
        version: "0.2"
        functions:
          gate_fn: {mode: gate}
        flows:
          main:
            input: {}
            steps:
              - id: g1
                function: gate_fn
                max_iterations: 3
                accumulate: "result.findings"
                on_approve: ~
                on_kill: ~
""")
    with pytest.raises(IRSemanticError):
        parse_and_validate(bad)


# ---------------------------------------------------------------------------
# Dedup + accumulator exposed to exit_criterion
# ---------------------------------------------------------------------------

def test_dedup_default_whole_item_key():
    state = _new_state(_acc_spec(exit_criterion="accumulated_count >= 3"))
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"findings": [{"id": 1}, {"id": 2}]})
    assert r1["new_count"] == 2
    assert r1["outcome"] == "continue"

    # id:1 and id:2 are dups; id:3 is new → count reaches 3 → exit on accumulated_count
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1}, {"id": 2}, {"id": 3}]})
    assert r2["new_count"] == 1
    assert r2["outcome"] == "exit_success"
    assert r2["accumulated_count"] == 3
    assert {f["id"] for f in r2["accumulated"]} == {1, 2, 3}


def test_custom_accumulate_key_dedups_by_field():
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 1", accumulate_key="item.id"))
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"findings": [{"id": 1, "note": "a"}]})
    assert r1["new_count"] == 1
    # same id, different note → still a duplicate by key → zero new → dry_streak 1 → exit
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1, "note": "b"}]})
    assert r2["new_count"] == 0
    assert r2["outcome"] == "exit_success"
    assert r2["accumulated_count"] == 1


def test_non_hashable_key_result_canonicalized():
    # accumulate_key returns a list (unhashable) — must be canonicalized, not crash.
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 1", accumulate_key="item.tags"))
    start_iteration(state, "s1")
    r1 = report_iteration(state, "s1", {"findings": [{"tags": ["a", "b"]}]})
    assert r1["new_count"] == 1
    r2 = report_iteration(state, "s1", {"findings": [{"tags": ["a", "b"]}]})
    assert r2["new_count"] == 0
    assert r2["outcome"] == "exit_success"


# ---------------------------------------------------------------------------
# Loop-until-dry
# ---------------------------------------------------------------------------

def test_loop_until_dry_exits_on_k_zero_new_rounds():
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 2"))
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"findings": [{"id": 1}]})
    assert (r1["new_count"], r1["dry_streak"], r1["outcome"]) == (1, 0, "continue")
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1}, {"id": 2}]})
    assert (r2["new_count"], r2["dry_streak"], r2["outcome"]) == (1, 0, "continue")
    r3 = report_iteration(state, "s1", {"findings": [{"id": 2}]})  # all dup
    assert (r3["new_count"], r3["dry_streak"], r3["outcome"]) == (0, 1, "continue")
    r4 = report_iteration(state, "s1", {"findings": []})            # dry again
    assert (r4["new_count"], r4["dry_streak"]) == (0, 2)
    assert r4["outcome"] == "exit_success"
    assert {f["id"] for f in r4["accumulated"]} == {1, 2}


def test_loop_until_dry_not_preempted_by_stagnation():
    # dry_streak threshold (5) larger than _STAGNATION_WINDOW (3): identical empty rounds
    # must NOT exit as stagnation before the governed dry threshold is reached.
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 5", max_iterations=20))
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}]})  # new → dry 0
    last = None
    for _ in range(5):  # five identical empty (dry) rounds
        last = report_iteration(state, "s1", {"findings": []})
    assert last["dry_streak"] == 5
    assert last["outcome"] == "exit_success"   # not exit_stagnation


def test_dry_streak_resets_on_new_item():
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 2"))
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}]})       # dry 0
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1}]})  # dry 1
    assert r2["dry_streak"] == 1
    r3 = report_iteration(state, "s1", {"findings": [{"id": 9}]})  # new → reset
    assert r3["dry_streak"] == 0
    assert r3["outcome"] == "continue"


# ---------------------------------------------------------------------------
# Error handling: accumulate_error freezes dry_streak (Decision 5)
# ---------------------------------------------------------------------------

def test_accumulate_error_does_not_manufacture_dry_exit():
    # findings is a string, not a list → accumulate_error every round. Vary the payload so
    # fingerprint-stagnation doesn't mask the point: dry_streak must never advance.
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 1", max_iterations=3))
    start_iteration(state, "s1")
    outcomes = []
    for i in range(3):
        r = report_iteration(state, "s1", {"findings": f"oops-not-a-list-{i}"})
        outcomes.append(r)
    # dry_streak frozen at 0 and never exit_success — a broken extractor can't fake dryness.
    for r in outcomes:
        assert r["dry_streak"] == 0
        assert r["new_count"] is None
        assert "accumulate_error" in r
        assert r["outcome"] != "exit_success"
    assert outcomes[-1]["outcome"] == "exit_max"


def test_per_item_key_failure_identity_fallback():
    # One item lacks the keyed field → that item dedups by identity, not crash/freeze.
    state = _new_state(_acc_spec(exit_criterion="accumulated_count >= 5", accumulate_key="item.id"))
    start_iteration(state, "s1")
    r1 = report_iteration(state, "s1", {"findings": [{"id": 1}, {"name": "x"}]})
    assert r1["new_count"] == 2          # id:1 by key, {name:x} by identity
    assert "accumulate_error" not in r1
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1}, {"name": "x"}]})
    assert r2["new_count"] == 0          # both dedup


# ---------------------------------------------------------------------------
# Authoritative output merge
# ---------------------------------------------------------------------------

def test_process_step_result_merges_accumulated_into_output():
    state = _new_state(_acc_spec(exit_criterion="dry_streak >= 1"))
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}, {"id": 2}]})
    report_iteration(state, "s1", {"findings": [{"id": 1}]})  # dry → exit
    assert state.iteration_outcome["s1"] == "exit_success"

    status, violations = process_step_result(state, "s1", {"findings": [{"id": 1}]})
    assert status == "ok", violations
    out = state.step_outputs["s1"]
    assert out["accumulated_count"] == 2
    assert {f["id"] for f in out["accumulated"]} == {1, 2}
    # accumulator cleared once folded into the authoritative output
    assert "s1" not in state.iteration_accumulator


def test_accumulator_cleared_on_ensure_failure_onfail_route():
    # The ensure-failure terminal path must clear the accumulator like the other
    # terminal paths, so an on_fail back-edge can't inherit a stale dedupe set.
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            ok: {type: boolean}
            findings: {type: array}
        functions:
          work:
            mode: infer
            intent: "find"
            input: {}
            output: Out
            ensure: ["result.ok == True"]
            retries: 1
          recover:
            mode: infer
            intent: "recover"
            input: {}
            output: Out
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
                max_iterations: 5
                exit_criterion: "dry_streak >= 1"
                accumulate: "result.findings"
                on_fail: recover
              - id: recover
                function: recover
                inputs: {}
""")
    state = _new_state(spec_yaml)
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"ok": True, "findings": [{"id": 1}]})
    report_iteration(state, "s1", {"ok": True, "findings": [{"id": 1}]})  # dry → exit
    assert state.iteration_accumulator["s1"]["items"]  # populated

    # Final result fails the ensure → on_fail route at max_retries → accumulator cleared.
    status, _ = process_step_result(state, "s1", {"ok": False, "findings": []})
    assert status == "on_fail_routed"
    assert "s1" not in state.iteration_accumulator


# ---------------------------------------------------------------------------
# Persistence + checkpoint round-trip
# ---------------------------------------------------------------------------

def test_accumulator_persist_restore_roundtrip():
    state = _new_state(_acc_spec())
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}, {"id": 2}]})
    persist_flow(state)
    restored = restore_flow(state.flow_id)
    try:
        acc = restored.iteration_accumulator["s1"]
        assert acc["dry_streak"] == 0
        assert {f["id"] for f in acc["items"]} == {1, 2}
        assert len(acc["seen"]) == 2
    finally:
        delete_persisted_flow(state.flow_id)


def test_accumulator_checkpoint_revert():
    state = _new_state(_acc_spec())
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}]})
    commit_checkpoint(state, "cp")
    report_iteration(state, "s1", {"findings": [{"id": 2}, {"id": 3}]})
    assert len(state.iteration_accumulator["s1"]["items"]) == 3
    assert revert_checkpoint(state, "cp")
    assert len(state.iteration_accumulator["s1"]["items"]) == 1


def test_accumulate_without_exit_criterion_runs_to_max():
    # No exit_criterion: the loop accumulates and exits at max_iterations.
    state = _new_state(_acc_spec(exit_criterion="False", max_iterations=2))
    start_iteration(state, "s1")
    report_iteration(state, "s1", {"findings": [{"id": 1}]})
    r2 = report_iteration(state, "s1", {"findings": [{"id": 2}]})
    assert r2["outcome"] == "exit_max"
    assert {f["id"] for f in r2["accumulated"]} == {1, 2}


def test_accumulate_with_score_expr_combined():
    # accumulate + score_expr together: exit_criterion sees BOTH accumulator and score kwargs.
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            findings: {type: array}
            score: {type: number}
        functions:
          work:
            mode: infer
            intent: "find+score"
            input: {}
            output: Out
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
                max_iterations: 5
                score_expr: "result.score"
                exit_criterion: "dry_streak >= 1 and best_score >= 0.5"
                accumulate: "result.findings"
""")
    state = _new_state(spec_yaml)
    start_iteration(state, "s1")
    # new item, score below threshold → continue
    r1 = report_iteration(state, "s1", {"findings": [{"id": 1}], "score": 0.4})
    assert r1["outcome"] == "continue"
    # dry round AND best_score now >= 0.5 → both conditions met → exit
    r2 = report_iteration(state, "s1", {"findings": [{"id": 1}], "score": 0.9})
    assert r2["dry_streak"] == 1
    assert r2["best_score"] == 0.9
    assert r2["outcome"] == "exit_success"
    assert r2["accumulated_count"] == 1


# ---------------------------------------------------------------------------
# Tamper detection
# ---------------------------------------------------------------------------

def test_spec_checksum_covers_accumulate():
    spec_a = parse_and_validate(_acc_spec())
    spec_b = parse_and_validate(_acc_spec().replace(
        'accumulate: "result.findings"', 'accumulate: "result.items"'))
    csum_a = compute_spec_checksum(spec_a.flows["main"], spec_a)
    csum_b = compute_spec_checksum(spec_b.flows["main"], spec_b)
    assert csum_a != csum_b
