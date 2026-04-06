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
