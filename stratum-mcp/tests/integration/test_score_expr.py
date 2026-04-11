"""Integration tests for score_expr iteration scoring."""
import textwrap

import pytest

from stratum_mcp.spec import parse_and_validate, IRSemanticError


def test_score_expr_accepted_with_max_iterations():
    """score_expr is valid when max_iterations is present."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 10
                score_expr: "result.score"
    """)
    spec = parse_and_validate(spec_yaml)
    step = spec.flows["main"].steps[0]
    assert step.score_expr == "result.score"


def test_score_expr_rejected_without_max_iterations():
    """score_expr requires max_iterations."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                score_expr: "result.score"
    """)
    with pytest.raises(IRSemanticError, match="score_expr.*max_iterations"):
        parse_and_validate(spec_yaml)


def test_score_expr_rejected_on_gate_step():
    """Gate steps must not have score_expr."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        functions:
          review:
            mode: gate
            intent: "Review"
        flows:
          main:
            input: {}
            steps:
              - id: g1
                function: review
                on_approve: ~
                on_revise: g1
                on_kill: ~
                score_expr: "result.score"
    """)
    with pytest.raises(IRSemanticError, match="(?i)gate.*score_expr|score_expr.*gate"):
        parse_and_validate(spec_yaml)


def test_score_expr_rejected_with_dunder():
    """score_expr must not contain dunder attributes."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                score_expr: "result.__class__"
    """)
    with pytest.raises(IRSemanticError, match="dunder"):
        parse_and_validate(spec_yaml)


def test_score_expr_without_exit_criterion_is_valid():
    """score_expr works with just max_iterations, no exit_criterion needed."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 10
                score_expr: "result.score"
    """)
    spec = parse_and_validate(spec_yaml)
    step = spec.flows["main"].steps[0]
    assert step.score_expr == "result.score"
    assert step.exit_criterion is None


from stratum_mcp.executor import (
    compile_score_expr,
    compile_ensure,
    EnsureCompileError,
)


# --- compile_score_expr tests ---

def test_compile_score_expr_extracts_numeric():
    """score_expr evaluates to a float."""
    fn = compile_score_expr("result.score")
    assert fn({"score": 0.87}) == 0.87


def test_compile_score_expr_int_is_valid():
    """Integer scores are valid."""
    fn = compile_score_expr("result.count")
    assert fn({"count": 42}) == 42


def test_compile_score_expr_rejects_bool():
    """Boolean results are rejected even though bool is int subclass."""
    fn = compile_score_expr("result.done")
    with pytest.raises(EnsureCompileError, match="non-numeric|bool"):
        fn({"done": True})


def test_compile_score_expr_rejects_string():
    """String results are rejected."""
    fn = compile_score_expr("result.name")
    with pytest.raises(EnsureCompileError, match="non-numeric"):
        fn({"name": "hello"})


def test_compile_score_expr_rejects_dunder():
    """Dunder attributes are blocked at compile time."""
    with pytest.raises(EnsureCompileError, match="dunder"):
        compile_score_expr("result.__class__.__name__")


def test_compile_score_expr_expression():
    """score_expr can be an expression, not just attribute access."""
    fn = compile_score_expr("len(result.items) / result.total")
    assert fn({"items": [1, 2, 3], "total": 10}) == 0.3


def test_compile_ensure_with_extra_locals():
    """exit_criterion can access best_score, prior_scores, iteration."""
    fn = compile_ensure("best_score > 0.9")
    assert fn({"v": "x"}, best_score=0.95, prior_scores=[0.5, 0.7], iteration=3) is True
    assert fn({"v": "x"}, best_score=0.5, prior_scores=[0.3], iteration=2) is False


def test_compile_ensure_without_extra_locals():
    """Existing callers still work with just result."""
    fn = compile_ensure("result.v == 'done'")
    assert fn({"v": "done"}) is True
    assert fn({"v": "nope"}) is False


def test_compile_ensure_prior_scores_max():
    """max() works on prior_scores for plateau detection."""
    fn = compile_ensure("len(prior_scores) >= 2 and best_score == max(prior_scores[-2:])")
    # Plateau: best hasn't improved
    assert fn({"v": "x"}, best_score=0.8, prior_scores=[0.8, 0.8], iteration=3) is True
    # Still improving
    assert fn({"v": "x"}, best_score=0.9, prior_scores=[0.7, 0.8], iteration=3) is False


# --- iteration_best lifecycle tests ---

from stratum_mcp.executor import (
    _flows,
    create_flow_state,
    get_current_step_info,
    process_step_result,
    start_iteration,
    report_iteration,
    abort_iteration,
    persist_flow,
    restore_flow,
    delete_persisted_flow,
    commit_checkpoint,
    revert_checkpoint,
    _clear_from,
)
from stratum_mcp.spec import parse_and_validate as pv


_SCORED_SPEC = textwrap.dedent("""\
    version: "0.2"
    contracts:
      Out:
        score: {type: number}
        v: {type: string}
    functions:
      work:
        mode: infer
        intent: "Produce output"
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
            max_iterations: 10
            score_expr: "result.score"
            exit_criterion: "best_score > 0.9"
""")


@pytest.fixture(autouse=True)
def _cleanup():
    _flows.clear()
    yield
    _flows.clear()


def _make_scored_state():
    spec = pv(_SCORED_SPEC)
    state = create_flow_state(spec, "main", {}, raw_spec=_SCORED_SPEC)
    get_current_step_info(state)
    return state


def test_iteration_best_persists_and_restores():
    """iteration_best survives persist/restore cycle."""
    state = _make_scored_state()
    state.iteration_best["s1"] = {"score": 0.85, "iteration": 2, "result": {"score": 0.85, "v": "good"}}
    persist_flow(state)
    restored = restore_flow(state.flow_id)
    assert restored is not None
    assert restored.iteration_best["s1"]["score"] == 0.85
    assert restored.iteration_best["s1"]["iteration"] == 2
    delete_persisted_flow(state.flow_id)


def test_iteration_best_cleared_by_clear_from():
    """_clear_from removes iteration_best for affected steps."""
    state = _make_scored_state()
    state.iteration_best["s1"] = {"score": 0.85, "iteration": 2, "result": {"score": 0.85, "v": "good"}}
    _clear_from(state, 0)
    assert "s1" not in state.iteration_best


def test_iteration_best_in_checkpoint():
    """iteration_best is included in checkpoint snapshot/restore."""
    state = _make_scored_state()
    state.iteration_best["s1"] = {"score": 0.85, "iteration": 2, "result": {"score": 0.85, "v": "good"}}
    commit_checkpoint(state, "before_change")
    state.iteration_best["s1"]["score"] = 0.99
    assert revert_checkpoint(state, "before_change")
    assert state.iteration_best["s1"]["score"] == 0.85
    delete_persisted_flow(state.flow_id)


def test_score_tracked_across_iterations():
    """Each iteration records a score and best is tracked."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"score": 0.5, "v": "a"})
    assert r1["outcome"] == "continue"

    r2 = report_iteration(state, "s1", {"score": 0.8, "v": "b"})
    assert r2["outcome"] == "continue"

    # Check iteration history has scores
    history = state.iterations["s1"]
    assert history[0]["score"] == 0.5
    assert history[1]["score"] == 0.8

    # Check best tracking
    assert state.iteration_best["s1"]["score"] == 0.8
    assert state.iteration_best["s1"]["iteration"] == 2
    assert state.iteration_best["s1"]["result"] == {"score": 0.8, "v": "b"}


def test_exit_criterion_with_best_score():
    """exit_criterion can use best_score to exit."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"score": 0.5, "v": "a"})
    assert r1["outcome"] == "continue"

    # This should trigger exit: best_score (0.95) > 0.9
    r2 = report_iteration(state, "s1", {"score": 0.95, "v": "b"})
    assert r2["outcome"] == "exit_success"
    assert r2["best_score"] == 0.95
    assert r2["best_iteration"] == 2
    assert r2["final_result"] == {"score": 0.95, "v": "b"}


def test_best_result_selected_on_exit_max():
    """On max iterations, best result is returned, not last."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 3
                score_expr: "result.score"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    report_iteration(state, "s1", {"score": 0.3, "v": "a"})
    report_iteration(state, "s1", {"score": 0.9, "v": "best"})  # This is the best
    r3 = report_iteration(state, "s1", {"score": 0.4, "v": "worst"})  # Last but not best

    assert r3["outcome"] == "exit_max"
    assert r3["final_result"] == {"score": 0.9, "v": "best"}
    assert r3["best_score"] == 0.9
    assert r3["best_iteration"] == 2


def test_prior_scores_available_in_exit_criterion():
    """exit_criterion can reference prior_scores and iteration."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 10
                score_expr: "result.score"
                exit_criterion: "iteration >= 3"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    r1 = report_iteration(state, "s1", {"score": 0.5, "v": "a"})
    assert r1["outcome"] == "continue"
    r2 = report_iteration(state, "s1", {"score": 0.6, "v": "b"})
    assert r2["outcome"] == "continue"
    r3 = report_iteration(state, "s1", {"score": 0.7, "v": "c"})
    assert r3["outcome"] == "exit_success"  # iteration == 3


def test_ties_keep_earlier_result():
    """When scores tie, the earlier result is kept."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    report_iteration(state, "s1", {"score": 0.8, "v": "first"})
    report_iteration(state, "s1", {"score": 0.8, "v": "second"})  # Tie

    assert state.iteration_best["s1"]["result"]["v"] == "first"
    assert state.iteration_best["s1"]["iteration"] == 1


def test_score_stagnation_fires_without_exit_criterion():
    """Score-based stagnation fires when score_expr is set but no exit_criterion."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 20
                score_expr: "result.score"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    # Best score on iteration 1
    report_iteration(state, "s1", {"score": 0.8, "v": "best"})
    # 3 more that don't improve
    report_iteration(state, "s1", {"score": 0.5, "v": "worse1"})
    report_iteration(state, "s1", {"score": 0.6, "v": "worse2"})
    r = report_iteration(state, "s1", {"score": 0.7, "v": "worse3"})

    assert r["outcome"] == "exit_stagnation"
    assert r["best_score"] == 0.8
    assert r["final_result"]["v"] == "best"


def test_score_stagnation_suppressed_with_exit_criterion():
    """When exit_criterion is present alongside score_expr, default stagnation is suppressed."""
    state = _make_scored_state()  # Has exit_criterion: "best_score > 0.9"
    start_iteration(state, "s1")

    # Best on iter 1, then 3 non-improving — should NOT trigger stagnation
    report_iteration(state, "s1", {"score": 0.5, "v": "best"})
    report_iteration(state, "s1", {"score": 0.3, "v": "a"})
    report_iteration(state, "s1", {"score": 0.4, "v": "b"})
    r = report_iteration(state, "s1", {"score": 0.2, "v": "c"})

    assert r["outcome"] == "continue"  # NOT exit_stagnation


def test_fingerprint_stagnation_not_used_with_score_expr():
    """With score_expr, fingerprint stagnation never fires even if results are identical."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 20
                score_expr: "result.score"
                exit_criterion: "best_score > 0.99"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    # 3 identical results — would trigger fingerprint stagnation without score_expr
    for _ in range(3):
        r = report_iteration(state, "s1", {"score": 0.5, "v": "same"})

    # Should continue because stagnation is suppressed (exit_criterion is present)
    assert r["outcome"] == "continue"


def test_score_error_logged_and_loop_continues():
    """score_expr eval failure doesn't crash the loop."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    # First iteration: score works
    report_iteration(state, "s1", {"score": 0.5, "v": "a"})

    # Second iteration: result has no 'score' field — score_expr fails
    r = report_iteration(state, "s1", {"v": "no_score"})

    assert r["outcome"] == "continue"
    history = state.iterations["s1"]
    assert history[1]["score"] is None
    assert "score_error" in history[1]
    # Best is still from iteration 1
    assert state.iteration_best["s1"]["score"] == 0.5


def test_score_bool_rejected():
    """Boolean score is treated as error."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            done: {type: boolean}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                score_expr: "result.done"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    r = report_iteration(state, "s1", {"done": True})
    assert r["outcome"] == "continue"
    assert state.iterations["s1"][0]["score"] is None
    assert "score_error" in state.iterations["s1"][0]


def test_abort_includes_best_result():
    """abort_iteration returns best_result when score_expr is present."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    report_iteration(state, "s1", {"score": 0.8, "v": "good"})
    report_iteration(state, "s1", {"score": 0.5, "v": "meh"})

    r = abort_iteration(state, "s1", "user cancelled")
    assert r["status"] == "iteration_aborted"
    assert r["best_result"] == {"score": 0.8, "v": "good"}
    assert r["best_score"] == 0.8


def test_abort_without_scores_returns_null_best():
    """abort_iteration with no successful scores returns null best_result."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                score_expr: "result.nonexistent"
    """)
    spec = pv(spec_yaml)
    state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
    get_current_step_info(state)
    start_iteration(state, "s1")

    # Score will fail (no 'nonexistent' field)
    report_iteration(state, "s1", {"v": "a"})

    r = abort_iteration(state, "s1", "giving up")
    assert r["best_result"] is None
    assert r["best_score"] is None


def test_process_step_result_substitutes_best():
    """process_step_result uses iteration_best result for validation and storage."""
    state = _make_scored_state()
    start_iteration(state, "s1")

    # First report: high score triggers exit (best_score > 0.9)
    r1 = report_iteration(state, "s1", {"score": 0.95, "v": "best"})
    assert r1["outcome"] == "exit_success"

    # Call process_step_result with a different result (simulating caller passing last)
    status, violations = process_step_result(state, "s1", {"score": 0.3, "v": "last"})
    assert status == "ok"

    # step_outputs should have the BEST result, not the last
    assert state.step_outputs["s1"]["v"] == "best"
    assert state.step_outputs["s1"]["score"] == 0.95

    # iteration_best should be consumed
    assert "s1" not in state.iteration_best


# --- E2E golden flow via MCP tools ---

import asyncio
from stratum_mcp.server import (
    stratum_plan,
    stratum_step_done,
    stratum_iteration_start,
    stratum_iteration_report,
    stratum_iteration_abort,
    stratum_audit,
)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_e2e_scored_iteration_via_mcp():
    """Full lifecycle: plan -> start_iteration -> report (with scoring) -> step_done."""
    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            score: {type: number}
            v: {type: string}
        functions:
          work:
            mode: infer
            intent: "Produce output"
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
                max_iterations: 10
                score_expr: "result.score"
                exit_criterion: "best_score > 0.9"
    """)

    # Plan
    plan_r = _run(stratum_plan(spec_yaml, "main", {}, ctx=None))
    assert plan_r["status"] == "execute_step"
    flow_id = plan_r["flow_id"]

    # Start iteration
    start_r = _run(stratum_iteration_start(flow_id, "s1", ctx=None))
    assert start_r["status"] == "iteration_started"

    # Iteration 1: low score
    r1 = _run(stratum_iteration_report(flow_id, "s1", {"score": 0.5, "v": "attempt1"}, ctx=None))
    assert r1["outcome"] == "continue"

    # Iteration 2: best score
    r2 = _run(stratum_iteration_report(flow_id, "s1", {"score": 0.95, "v": "attempt2"}, ctx=None))
    assert r2["outcome"] == "exit_success"
    assert r2["best_score"] == 0.95
    assert r2["final_result"]["v"] == "attempt2"

    # Step done with best result
    done_r = _run(stratum_step_done(flow_id, "s1", r2["final_result"], ctx=None))
    assert done_r["status"] == "complete"

    # Audit should show score in iteration history
    audit_r = _run(stratum_audit(flow_id, ctx=None))
    iterations = audit_r.get("iterations", {}).get("s1", [])
    assert len(iterations) == 2
    assert iterations[0]["score"] == 0.5
    assert iterations[1]["score"] == 0.95

    delete_persisted_flow(flow_id)
