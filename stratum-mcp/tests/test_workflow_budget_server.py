"""STRAT-WORKFLOW-BUDGET — S6/S7: stratum_agent_run debit/gate + terminal surfacing.

Covers: server-dispatched agent_run debits a budgeted flow only when attributed;
the pre-dispatch gate halts an exhausted flow; _flow_status / _build_audit_snapshot
/ stratum_resume surface budget_exhausted; the contract enums admit it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import AsyncIterator

import pytest

from stratum_mcp import server as server_mod
from stratum_mcp.connectors import AgentConnector
from stratum_mcp.server import (
    stratum_agent_run,
    stratum_resume,
    _flow_status,
    _build_audit_snapshot,
    _flow_budget_hard_stop,
    _flows,
)
from stratum_mcp.spec import parse_and_validate
from stratum_mcp.executor import create_flow_state, persist_flow
from stratum_mcp.run_budget import BUDGET_EXHAUSTED


def _spec(budget_block):
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


class _UsageConnector(AgentConnector):
    def __init__(self, tokens):
        self._tokens = tokens

    async def run(self, prompt, **_ig) -> AsyncIterator[dict]:
        yield {"type": "usage", "input_tokens": self._tokens, "output_tokens": 0,
               "cost_usd": 0.0}
        yield {"type": "assistant", "content": "done"}
        yield {"type": "result", "content": "done"}


@pytest.fixture
def flows_dir(tmp_path, monkeypatch):
    import stratum_mcp.executor as ex
    monkeypatch.setattr(ex, "_FLOWS_DIR", tmp_path / "flows")
    return tmp_path / "flows"


def _budgeted_flow(caps_block):
    ir = _spec(caps_block)
    spec = parse_and_validate(ir)
    return create_flow_state(spec, "build", {"feature": "x"}, raw_spec=ir)


# --- S6: agent_run debit + gate --------------------------------------------

@pytest.mark.asyncio
async def test_attributed_agent_run_debits_flow(flows_dir, monkeypatch):
    state = _budgeted_flow("    budget: {max_tokens: 100000}\n")
    _flows[state.flow_id] = state
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _UsageConnector(700))
    try:
        await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
    finally:
        _flows.pop(state.flow_id, None)
    assert state.budget_state["consumed"]["tokens"] == 700
    assert state.budget_state["consumed"]["dispatches"] == 1


class _ErrorConnector(AgentConnector):
    """Emits a usage event, then raises — exercises the finally-debit path."""
    async def run(self, prompt, **_ig) -> AsyncIterator[dict]:
        yield {"type": "usage", "input_tokens": 300, "output_tokens": 0}
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_failed_dispatch_still_debits(flows_dir, monkeypatch):
    """A connector error must NOT make the dispatch free (finally-debit)."""
    state = _budgeted_flow("    budget: {max_agent_dispatches: 100}\n")
    _flows[state.flow_id] = state
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _ErrorConnector())
    try:
        with pytest.raises(RuntimeError):
            await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
    finally:
        _flows.pop(state.flow_id, None)
    # dispatch + partial usage charged despite the error
    assert state.budget_state["consumed"]["dispatches"] == 1
    assert state.budget_state["consumed"]["tokens"] == 300


@pytest.mark.asyncio
async def test_agent_run_marks_terminal_when_debit_crosses_cap(flows_dir, monkeypatch):
    state = _budgeted_flow("    budget: {max_tokens: 500}\n")
    _flows[state.flow_id] = state
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _UsageConnector(600))
    try:
        await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
    finally:
        _flows.pop(state.flow_id, None)
    # the debit crossed the cap → flow marked terminal durably
    assert state.terminal_status == BUDGET_EXHAUSTED


@pytest.mark.asyncio
async def test_unattributed_agent_run_does_not_debit(flows_dir, monkeypatch):
    state = _budgeted_flow("    budget: {max_tokens: 100000}\n")
    _flows[state.flow_id] = state
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _UsageConnector(700))
    try:
        # no correlation_id → un-attributed → no debit
        await stratum_agent_run(prompt="hi", ctx=None)
    finally:
        _flows.pop(state.flow_id, None)
    assert state.budget_state["consumed"]["tokens"] == 0


@pytest.mark.asyncio
async def test_predispatch_gate_halts_exhausted_flow(flows_dir, monkeypatch):
    state = _budgeted_flow("    budget: {max_tokens: 100}\n")
    state.budget_state["consumed"]["tokens"] = 100  # already exhausted
    _flows[state.flow_id] = state
    dispatched = {"called": False}

    def _factory(*a, **k):
        dispatched["called"] = True
        return _UsageConnector(50)

    monkeypatch.setattr(server_mod, "_make_agent_connector", _factory)
    try:
        res = await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
    finally:
        _flows.pop(state.flow_id, None)
    assert res["status"] == BUDGET_EXHAUSTED
    assert dispatched["called"] is False  # gated before dispatch
    assert state.terminal_status == BUDGET_EXHAUSTED


# --- S7: terminal surfacing -------------------------------------------------

def test_flow_status_reports_budget_exhausted():
    state = _budgeted_flow("    budget: {max_tokens: 100}\n")
    state.terminal_status = BUDGET_EXHAUSTED
    assert _flow_status(state) == BUDGET_EXHAUSTED


def test_audit_snapshot_surfaces_budget_state_and_status():
    state = _budgeted_flow("    budget: {max_tokens: 100}\n")
    state.terminal_status = BUDGET_EXHAUSTED
    snap = _build_audit_snapshot(state)
    assert snap["status"] == BUDGET_EXHAUSTED
    assert snap["budget_state"]["caps"]["max_tokens"] == 100


@pytest.mark.asyncio
async def test_resume_refuses_exhausted_flow(flows_dir):
    state = _budgeted_flow("    budget: {max_tokens: 100}\n")
    state.terminal_status = BUDGET_EXHAUSTED
    _flows[state.flow_id] = state
    try:
        res = await stratum_resume(flow_id=state.flow_id, ctx=None)
    finally:
        _flows.pop(state.flow_id, None)
    assert res["status"] == BUDGET_EXHAUSTED


def test_hard_stop_returns_terminal_payload_when_exhausted():
    state = _budgeted_flow("    budget: {max_agent_dispatches: 1}\n")
    state.budget_state["consumed"]["dispatches"] = 1
    stop = _flow_budget_hard_stop(state)
    assert stop is not None
    assert stop["status"] == BUDGET_EXHAUSTED
    assert state.terminal_status == BUDGET_EXHAUSTED


def test_hard_stop_none_when_within_budget():
    state = _budgeted_flow("    budget: {max_agent_dispatches: 10}\n")
    assert _flow_budget_hard_stop(state) is None


def test_contract_enums_admit_budget_exhausted():
    root = Path(__file__).resolve().parents[1] / "contracts"
    for name in ("flow-state.v1.schema.json", "query-flows.v1.schema.json"):
        data = json.loads((root / name).read_text())
        # find the status enum anywhere in the schema
        text = json.dumps(data)
        assert "budget_exhausted" in text, f"{name} missing budget_exhausted"
