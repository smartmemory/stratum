"""STRAT-WORKFLOW-BUDGET-DOLLARS — usd promoted to an enforced run-budget axis.

Covers the two surfaces that newly enforce dollars:
  * server-dispatched ``stratum_agent_run`` (token cost crosses a ``usd`` cap);
  * consumer-reported ``usage`` on ``stratum_step_done`` (the common sequential
    path), charged across all outcomes after validation, with a retry-storm halt.
Plus unpriced-model degradation under a ``usd`` cap.
"""
from __future__ import annotations

import logging
from typing import AsyncIterator
from unittest.mock import MagicMock

import pytest

from stratum_mcp import server as server_mod
from stratum_mcp.connectors import AgentConnector
from stratum_mcp.server import stratum_agent_run, stratum_plan, stratum_step_done, _flows
from stratum_mcp.run_budget import BUDGET_EXHAUSTED
import stratum_mcp.pricing as pricing


# inline-step flow: result dict is whatever the consumer reports; ensure gates "ok"
def _ir(budget_block: str) -> str:
    return f"""
version: "0.2"
flows:
  build:
    input: {{}}
{budget_block}    steps:
      - id: s1
        intent: "Do the thing"
        agent: claude
        ensure:
          - "result.done == True"
        retries: 5
"""


@pytest.fixture
def flows_dir(tmp_path, monkeypatch):
    import stratum_mcp.executor as ex
    monkeypatch.setattr(ex, "_FLOWS_DIR", tmp_path / "flows")
    return tmp_path / "flows"


@pytest.fixture(autouse=True)
def _fresh_warn_state():
    pricing._warned_models.clear()
    yield


# A $3-per-1M-input event under claude-sonnet-4-6 pricing.
_USAGE_3USD = {"input_tokens": 1_000_000, "output_tokens": 0, "model": "claude-sonnet-4-6"}


class _PricedUsageConnector(AgentConnector):
    """Emits a usage event carrying a model id (no cost_usd) so dollars derive."""
    def __init__(self, model: str, input_tokens: int):
        self._model = model
        self._tokens = input_tokens

    async def run(self, prompt, **_ig) -> AsyncIterator[dict]:
        yield {"type": "usage", "input_tokens": self._tokens, "output_tokens": 0,
               "cost_usd": 0, "model": self._model}
        yield {"type": "assistant", "content": "done"}
        yield {"type": "result", "content": "done"}


# --- server-dispatched: usd enforced via token cost ------------------------

@pytest.mark.asyncio
async def test_agent_run_exhausts_usd_via_token_cost(flows_dir, monkeypatch):
    ir = _ir("    budget: {usd: 1.00}\n")
    plan = await stratum_plan(ir, "build", {}, MagicMock())
    state = _flows[plan["flow_id"]]
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _PricedUsageConnector("claude-sonnet-4-6", 1_000_000))
    try:
        await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
    finally:
        _flows.pop(state.flow_id, None)
    # 1M input tokens @ $3/1M = $3 > $1 cap → terminal
    assert state.budget_state["consumed"]["dollars"] == pytest.approx(3.0)
    assert state.terminal_status == BUDGET_EXHAUSTED


@pytest.mark.asyncio
async def test_unpriced_model_under_usd_cap_does_not_trip_and_warns(
    flows_dir, monkeypatch, caplog
):
    ir = _ir("    budget: {usd: 0.01}\n")
    plan = await stratum_plan(ir, "build", {}, MagicMock())
    state = _flows[plan["flow_id"]]
    monkeypatch.setattr(server_mod, "_make_agent_connector",
                        lambda *a, **k: _PricedUsageConnector("mystery-model-x", 9_000_000))
    with caplog.at_level(logging.WARNING):
        try:
            await stratum_agent_run(prompt="hi", ctx=None, correlation_id=state.flow_id)
        finally:
            _flows.pop(state.flow_id, None)
    # unpriced → $0 → never trips the usd cap
    assert state.budget_state["consumed"]["dollars"] == 0.0
    assert state.terminal_status != BUDGET_EXHAUSTED
    assert any("mystery-model-x" in r.message for r in caplog.records)


# --- consumer-reported usage on stratum_step_done --------------------------

@pytest.mark.asyncio
async def test_step_done_consumer_usage_debits_dollars(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 100.0}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    await stratum_step_done(state.flow_id, "s1", {"done": True}, ctx, usage=_USAGE_3USD)
    assert state.budget_state["consumed"]["dollars"] == pytest.approx(3.0)
    assert state.budget_state["consumed"]["tokens"] == 1_000_000
    # consumer steps are not server-dispatched agents
    assert state.budget_state["consumed"]["dispatches"] == 0


@pytest.mark.asyncio
async def test_step_done_consumer_usage_exhausts_usd(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 1.00}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    res = await stratum_step_done(state.flow_id, "s1", {"done": True}, ctx, usage=_USAGE_3USD)
    assert res["status"] == BUDGET_EXHAUSTED
    assert state.terminal_status == BUDGET_EXHAUSTED


@pytest.mark.asyncio
async def test_step_done_charges_on_ensure_failure(flows_dir):
    """Failed/retrying consumer work is not free (no retry-storm bypass)."""
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 100.0}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    res = await stratum_step_done(state.flow_id, "s1", {"done": False}, ctx, usage=_USAGE_3USD)
    assert res["status"] == "ensure_failed"          # still retrying, not complete
    assert state.budget_state["consumed"]["dollars"] == pytest.approx(3.0)  # charged anyway


@pytest.mark.asyncio
async def test_step_done_retry_storm_halts_on_cap(flows_dir):
    """An ensure-failed attempt whose usage crosses the cap halts immediately."""
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 1.00}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    res = await stratum_step_done(state.flow_id, "s1", {"done": False}, ctx, usage=_USAGE_3USD)
    # exhaustion overrides the retry routing
    assert res["status"] == BUDGET_EXHAUSTED
    assert state.terminal_status == BUDGET_EXHAUSTED


@pytest.mark.asyncio
async def test_step_done_prepriced_usage_shape(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 100.0}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    await stratum_step_done(state.flow_id, "s1", {"done": True}, ctx,
                            usage={"tokens": 1234, "dollars": 0.42})
    assert state.budget_state["consumed"]["dollars"] == pytest.approx(0.42)
    assert state.budget_state["consumed"]["tokens"] == 1234


@pytest.mark.asyncio
async def test_step_done_without_usage_unchanged(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 1.00}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    res = await stratum_step_done(state.flow_id, "s1", {"done": True}, ctx)
    assert res.get("status") not in (BUDGET_EXHAUSTED,)   # completes normally
    assert state.budget_state["consumed"]["dollars"] == 0.0


@pytest.mark.asyncio
async def test_step_done_malformed_usage_does_not_crash_or_corrupt(flows_dir):
    """A bad usage payload must not raise after the step was accepted, nor poison
    the ledger (budget accounting never breaks flow execution)."""
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 1.00}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    res = await stratum_step_done(
        state.flow_id, "s1", {"done": True}, ctx,
        usage={"input_tokens": 1000, "output_tokens": 0, "model": [1, 2, 3]},
    )
    # non-string model degrades to $0; step completed normally, no crash
    assert res.get("status") != BUDGET_EXHAUSTED
    assert state.budget_state["consumed"]["dollars"] == 0.0
    assert state.budget_state["consumed"]["tokens"] == 1000

    # also: unparseable pre-priced shape degrades to zero without raising
    plan2 = await stratum_plan(_ir("    budget: {usd: 1.00}\n"), "build", {}, ctx)
    state2 = _flows[plan2["flow_id"]]
    res2 = await stratum_step_done(state2.flow_id, "s1", {"done": True}, ctx,
                                   usage={"tokens": "abc", "dollars": [1, 2]})
    assert res2.get("status") != BUDGET_EXHAUSTED
    assert state2.budget_state["consumed"]["dollars"] == 0.0
    assert state2.budget_state["consumed"]["tokens"] == 0


@pytest.mark.asyncio
async def test_step_done_negative_usage_does_not_credit_budget(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir("    budget: {usd: 100.0}\n"), "build", {}, ctx)
    state = _flows[plan["flow_id"]]
    await stratum_step_done(state.flow_id, "s1", {"done": True}, ctx,
                            usage={"tokens": -999, "dollars": -50.0})
    # negatives clamped — can't credit the ledger back
    assert state.budget_state["consumed"]["dollars"] == 0.0
    assert state.budget_state["consumed"]["tokens"] == 0


@pytest.mark.asyncio
async def test_step_done_usage_on_unbudgeted_flow_is_noop(flows_dir):
    ctx = MagicMock()
    plan = await stratum_plan(_ir(""), "build", {}, ctx)   # no budget block
    flow_id = plan["flow_id"]
    state = _flows[flow_id]
    assert state.budget_state is None
    # reporting usage must not crash on an unbudgeted flow
    res = await stratum_step_done(flow_id, "s1", {"done": True}, ctx, usage=_USAGE_3USD)
    assert res.get("status") != BUDGET_EXHAUSTED
