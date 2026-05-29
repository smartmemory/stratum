"""STRAT-WORKFLOW-BUDGET — S2: FlowState.budget_state creation + persistence.

budget_state is initialized from the flow's run budget, round-trips through
persist/restore, and is absent (None) for legacy flows and budget-less flows.
"""
import json

import pytest

from stratum_mcp.spec import parse_and_validate
from stratum_mcp.executor import (
    create_flow_state,
    persist_flow,
    restore_flow,
    init_budget_state,
)


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


@pytest.fixture
def flows_dir(tmp_path, monkeypatch):
    import stratum_mcp.executor as ex
    monkeypatch.setattr(ex, "_FLOWS_DIR", tmp_path / "flows")
    return tmp_path / "flows"


def test_create_flow_state_populates_budget_from_spec():
    ir = _spec("    budget: {ms: 600000, max_agent_dispatches: 20, max_tokens: 500000}\n")
    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "build", {"feature": "x"}, raw_spec=ir)
    assert state.budget_state is not None
    assert state.budget_state["caps"]["max_agent_dispatches"] == 20
    assert state.budget_state["caps"]["max_tokens"] == 500000
    assert state.budget_state["caps"]["ms"] == 600000
    assert state.budget_state["consumed"] == {
        "wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0,
    }


def test_budgetless_flow_has_none_budget_state():
    spec = parse_and_validate(_spec(""))
    state = create_flow_state(spec, "build", {"feature": "x"}, raw_spec=_spec(""))
    assert state.budget_state is None


def test_usd_only_budget_yields_no_ledger():
    """usd has nothing to enforce server-side → no ledger."""
    assert init_budget_state(_budget(usd=5.0)) is None


def test_round_trip_persist_restore(flows_dir):
    ir = _spec("    budget: {max_tokens: 100000}\n")
    spec = parse_and_validate(ir)
    state = create_flow_state(spec, "build", {"feature": "x"}, raw_spec=ir)
    state.budget_state["consumed"]["tokens"] = 4242
    persist_flow(state)
    loaded = restore_flow(state.flow_id)
    assert loaded.budget_state["caps"]["max_tokens"] == 100000
    assert loaded.budget_state["consumed"]["tokens"] == 4242


def test_legacy_payload_missing_budget_state_restores_none(flows_dir):
    spec = parse_and_validate(_spec(""))
    state = create_flow_state(spec, "build", {"feature": "x"}, raw_spec=_spec(""))
    persist_flow(state)
    path = flows_dir / f"{state.flow_id}.json"
    payload = json.loads(path.read_text())
    payload.pop("budget_state", None)
    path.write_text(json.dumps(payload))
    loaded = restore_flow(state.flow_id)
    assert loaded is not None
    assert loaded.budget_state is None


def _budget(**kw):
    from stratum_mcp.spec import IRBudgetDef
    return IRBudgetDef(**kw)
