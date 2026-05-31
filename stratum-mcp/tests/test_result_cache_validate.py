"""STRAT-WORKFLOW-RESUME S3: validator eligibility for `cache: true`.

Two gates (both enforced; passing Gate 1 does not exempt Gate 2):
  Gate 1 — necessary: step.function set AND fn.mode == "compute".
  Gate 2 — additional: reject even a compute function step if it is an
           iteration loop (max_iterations/exit_criterion/score_expr),
           an accumulator (accumulate), or a routing step (next).
"""
import pytest

from stratum_mcp.errors import IRSemanticError
from stratum_mcp.spec import parse_and_validate


def _flow(steps_block, *, extra_fns="", research_extra="", version="0.2"):
    return f"""
version: "{version}"
contracts:
  Out:
    value: {{type: string}}
functions:
  research:
    mode: compute
    intent: "Research a value"
    input: {{topic: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]{research_extra}
  approve:
    mode: gate
    intent: "Human approves"
    input: {{topic: {{type: string}}}}
    output: Out{extra_fns}
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
{steps_block}
"""


def _expect_reject(steps_block, **kw):
    with pytest.raises(IRSemanticError):
        parse_and_validate(_flow(steps_block, **kw))


# --- Gate 1: must be a compute function step ---------------------------------

def test_accept_compute_function_step():
    """A plain compute function step with cache:true is accepted."""
    spec = parse_and_validate(_flow(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        cache: true\n"
    ))
    assert spec.flows["main"].steps[0].cache is True


def test_reject_cache_on_gate_step():
    _expect_reject(
        "      - id: s\n"
        "        function: approve\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        cache: true\n"
    )


def test_reject_cache_on_inline_step():
    _expect_reject(
        "      - id: s\n"
        "        intent: \"inline\"\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        output_schema: {type: object}\n"
        "        cache: true\n"
    )


def test_reject_cache_on_parallel_dispatch_step():
    _expect_reject(
        "      - id: s\n"
        "        type: parallel_dispatch\n"
        "        source: \"$.input.topic\"\n"
        "        intent_template: \"do {item}\"\n"
        "        cache: true\n",
        version="0.3",
    )


# --- Gate 2: even a compute function step is rejected if ... ------------------

def test_reject_cache_on_iteration_loop_step():
    _expect_reject(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        max_iterations: 3\n"
        "        cache: true\n"
    )


def test_reject_cache_on_accumulator_step():
    _expect_reject(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        max_iterations: 3\n"
        "        accumulate: \"$.steps.s.output\"\n"
        "        cache: true\n"
    )


def test_reject_cache_on_routing_step():
    _expect_reject(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        next: s2\n"
        "        cache: true\n"
        "      - id: s2\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
    )


# --- Function-level cache:true must be gated identically (no bypass) ---------

def test_reject_function_level_cache_on_routing_step():
    """A `cache: true` on the FUNCTION must not let a routing step slip through:
    cache_enabled is step.cache OR fn.cache, so the validator gates the OR."""
    _expect_reject(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n"
        "        next: s2\n"
        "      - id: s2\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n",
        research_extra="\n    cache: true",  # research function declares cache:true
    )


def test_reject_function_level_cache_on_gate_step():
    """A gate function carrying cache:true is rejected (Gate 1: not compute)."""
    _expect_reject(
        "      - id: s\n"
        "        function: approve\n"
        "        inputs: {topic: \"$.input.topic\"}\n",
        extra_fns="\n    cache: true",  # appended to the `approve` gate function
    )


def test_accept_function_level_cache_on_plain_compute_step():
    """Function-level cache:true on an ordinary compute step is accepted."""
    spec = parse_and_validate(_flow(
        "      - id: s\n"
        "        function: research\n"
        "        inputs: {topic: \"$.input.topic\"}\n",
        research_extra="\n    cache: true",
    ))
    assert spec.functions["research"].cache is True
