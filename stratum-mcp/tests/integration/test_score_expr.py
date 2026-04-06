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
