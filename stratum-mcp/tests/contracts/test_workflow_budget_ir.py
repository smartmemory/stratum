"""STRAT-WORKFLOW-BUDGET — S1: IR extension for flow-execution-wide budget axes.

The flow-level `budget:` block (existing `{ms, usd}`) gains optional
`max_agent_dispatches` and `max_tokens`. Existing specs and budget-less flows
must be unaffected; the run budget must be covered by the spec checksum.
"""
import pytest

from stratum_mcp.spec import parse_and_validate
from stratum_mcp.executor import compute_spec_checksum


def _spec(budget_block: str = "") -> str:
    return f"""
version: "0.2"
contracts:
  Out:
    v: {{type: string}}
functions:
  work:
    mode: infer
    intent: "Do it"
    input: {{feature: {{type: string}}}}
    output: Out
flows:
  build:
    input: {{feature: {{type: string}}}}
    output: Out
{budget_block}    steps:
      - id: s1
        function: work
        inputs: {{feature: "$.input.feature"}}
"""


def test_flow_budget_parses_run_wide_axes():
    ir = _spec(
        "    budget: {ms: 1800000, usd: 5.0, max_agent_dispatches: 50, max_tokens: 2000000}\n"
    )
    spec = parse_and_validate(ir)
    b = spec.flows["build"].budget
    assert b is not None
    assert b.ms == 1800000
    assert b.usd == 5.0
    assert b.max_agent_dispatches == 50
    assert b.max_tokens == 2000000


def test_existing_ms_usd_budget_unaffected():
    """A spec with only the legacy {ms, usd} shape still parses; new axes None."""
    ir = _spec("    budget: {ms: 5000, usd: 1.5}\n")
    spec = parse_and_validate(ir)
    b = spec.flows["build"].budget
    assert b.ms == 5000 and b.usd == 1.5
    assert b.max_agent_dispatches is None
    assert b.max_tokens is None


def test_budgetless_flow_has_no_budget():
    spec = parse_and_validate(_spec(""))
    assert spec.flows["build"].budget is None


def test_run_budget_only_axes_parse():
    """Run-wide axes without ms/usd are valid (token/dispatch-only ceiling)."""
    ir = _spec("    budget: {max_agent_dispatches: 10, max_tokens: 100000}\n")
    spec = parse_and_validate(ir)
    b = spec.flows["build"].budget
    assert b.ms is None and b.usd is None
    assert b.max_agent_dispatches == 10 and b.max_tokens == 100000


def test_negative_dispatches_rejected():
    ir = _spec("    budget: {max_agent_dispatches: 0}\n")
    with pytest.raises(Exception):
        parse_and_validate(ir)


def test_unknown_budget_key_still_rejected():
    """additionalProperties:False must still hold after the extension."""
    ir = _spec("    budget: {max_widgets: 5}\n")
    with pytest.raises(Exception):
        parse_and_validate(ir)


def test_run_budget_covered_by_checksum():
    """Changing a run-budget axis must change the spec checksum (STRAT-IMMUTABLE)."""
    s_no = parse_and_validate(_spec(""))
    s_50 = parse_and_validate(_spec("    budget: {max_agent_dispatches: 50}\n"))
    s_99 = parse_and_validate(_spec("    budget: {max_agent_dispatches: 99}\n"))
    ck_no = compute_spec_checksum(s_no.flows["build"], s_no)
    ck_50 = compute_spec_checksum(s_50.flows["build"], s_50)
    ck_99 = compute_spec_checksum(s_99.flows["build"], s_99)
    assert ck_no != ck_50
    assert ck_50 != ck_99
