"""STRAT-WORKFLOW-BUDGET — S3/S4: pure budget helpers.

Usage accumulation (both connector shapes), debit, and exhaustion logic.
"""
from dataclasses import dataclass
from typing import Any

from stratum_mcp.run_budget import (
    accumulate_usage,
    new_usage_acc,
    debit_budget,
    budget_exhausted,
    BUDGET_EXHAUSTED,
)


@dataclass
class _Ev:
    kind: str
    metadata: dict


class _State:
    def __init__(self, caps):
        self.budget_state = {
            "caps": caps,
            "consumed": {"wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0},
        }


# --- usage accumulation -----------------------------------------------------

def test_accumulate_codex_stream_shape():
    acc = new_usage_acc()
    ev = _Ev(kind="step_usage", metadata={"type": "usage", "input_tokens": 100,
                                          "output_tokens": 50, "cost_usd": 0})
    accumulate_usage(acc, ev)
    assert acc["tokens"] == 150


def test_accumulate_claude_stream_shape_without_type_stamp():
    """Claude stream_events emits kind=step_usage with NO metadata['type']."""
    acc = new_usage_acc()
    ev = _Ev(kind="step_usage", metadata={"input_tokens": 10, "output_tokens": 7})
    accumulate_usage(acc, ev)
    assert acc["tokens"] == 17


def test_accumulate_run_dict_shape():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 3, "output_tokens": 4,
                           "cost_usd": 0.12})
    assert acc["tokens"] == 7
    assert acc["dollars"] == 0.12


def test_cache_tokens_excluded():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 5, "output_tokens": 5,
                           "cache_read_input_tokens": 9999,
                           "cache_creation_input_tokens": 9999})
    assert acc["tokens"] == 10


def test_non_usage_events_ignored():
    acc = new_usage_acc()
    accumulate_usage(acc, _Ev(kind="agent_relay", metadata={"text": "hi"}))
    accumulate_usage(acc, {"type": "result", "content": "x"})
    assert acc == {"tokens": 0, "dollars": 0.0}


# --- dollars computed from tokens (STRAT-WORKFLOW-BUDGET-DOLLARS) -----------

def test_dollars_computed_from_tokens_when_cost_absent():
    """Connectors emit token counts + model but no cost_usd → price it."""
    from stratum_mcp.pricing import cost_from_tokens
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 1_000_000,
                           "output_tokens": 500_000, "model": "claude-sonnet-4-6"})
    assert acc["tokens"] == 1_500_000
    assert acc["dollars"] == cost_from_tokens("claude-sonnet-4-6", 1_000_000, 500_000)
    assert acc["dollars"] > 0.0


def test_reported_cost_usd_trusted_over_computed():
    """A connector that reports a positive cost_usd is trusted, not overridden."""
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 1_000_000,
                           "output_tokens": 0, "model": "claude-sonnet-4-6",
                           "cost_usd": 0.01})
    assert acc["dollars"] == 0.01  # trusted, not the ~$3 the table would compute


def test_codex_effort_model_priced():
    """codex model ids carry a /effort suffix — priced as the base model."""
    from stratum_mcp.pricing import cost_from_tokens
    acc = new_usage_acc()
    ev = _Ev(kind="step_usage", metadata={"input_tokens": 1_000_000,
                                          "output_tokens": 0, "cost_usd": 0,
                                          "model": "gpt-5.4/high"})
    accumulate_usage(acc, ev)
    assert acc["dollars"] == cost_from_tokens("gpt-5.4", 1_000_000, 0)


def test_unpriced_model_contributes_zero_dollars_and_is_tagged():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 1_000_000,
                           "output_tokens": 0, "model": "mystery-model"})
    assert acc["dollars"] == 0.0
    assert "mystery-model" in acc.get("unpriced_models", set())


def test_priced_model_not_tagged_unpriced():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 1000,
                           "output_tokens": 0, "model": "claude-sonnet-4-6"})
    assert not acc.get("unpriced_models")


def test_negative_reported_cost_clamped_to_zero():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 0, "output_tokens": 0,
                           "cost_usd": -5.0})
    assert acc["dollars"] == 0.0


def test_nan_reported_cost_does_not_poison_ledger():
    """A NaN cost must not slip in — `nan >= cap` is always False (never trips)."""
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 0, "output_tokens": 0,
                           "cost_usd": float("nan")})
    assert acc["dollars"] == 0.0  # sanitized, not NaN


def test_negative_token_counts_clamped():
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": -100, "output_tokens": -50,
                           "model": "claude-sonnet-4-6"})
    assert acc["tokens"] == 0
    assert acc["dollars"] == 0.0


def test_unhashable_model_does_not_raise():
    """A malformed (unhashable) model id from a connector event must not crash
    accumulation when tagging unpriced models."""
    acc = new_usage_acc()
    accumulate_usage(acc, {"type": "usage", "input_tokens": 100, "output_tokens": 0,
                           "model": {"unhashable": "dict"}})
    assert acc["tokens"] == 100
    assert acc["dollars"] == 0.0
    assert not acc.get("unpriced_models")


# --- debit + exhaustion -----------------------------------------------------

def test_debit_accumulates():
    s = _State({"max_tokens": 1000})
    debit_budget(s, dispatches=1, tokens=300, wall_s=2.5, dollars=0.01)
    debit_budget(s, dispatches=1, tokens=200, wall_s=1.0)
    c = s.budget_state["consumed"]
    assert c == {"wall_s": 3.5, "dispatches": 2, "tokens": 500, "dollars": 0.01}


def test_debit_noop_when_unbudgeted():
    class Bare:
        budget_state = None
    debit_budget(Bare(), tokens=100)  # must not raise


def test_tokens_axis_trips():
    s = _State({"max_tokens": 500})
    debit_budget(s, tokens=499)
    assert not budget_exhausted(s)
    debit_budget(s, tokens=1)
    assert budget_exhausted(s)


def test_dispatch_axis_trips():
    s = _State({"max_agent_dispatches": 3})
    for _ in range(2):
        debit_budget(s, dispatches=1)
    assert not budget_exhausted(s)
    debit_budget(s, dispatches=1)
    assert budget_exhausted(s)


def test_wall_clock_axis_trips_ms_to_seconds():
    s = _State({"ms": 3000})  # 3 seconds
    debit_budget(s, wall_s=2.9)
    assert not budget_exhausted(s)
    debit_budget(s, wall_s=0.2)
    assert budget_exhausted(s)


def test_dollars_axis_trips():
    """STRAT-WORKFLOW-BUDGET-DOLLARS: usd is now an enforced axis."""
    s = _State({"usd": 1.00})
    debit_budget(s, dollars=0.99)
    assert not budget_exhausted(s)
    debit_budget(s, dollars=0.02)
    assert budget_exhausted(s)


def test_dollars_axis_independent_of_tokens():
    """A usd-only cap trips on dollars even when no token cap is set."""
    s = _State({"usd": 0.50})
    debit_budget(s, dollars=0.60, tokens=999999)
    assert budget_exhausted(s)


def test_unbudgeted_never_exhausted():
    class Bare:
        budget_state = None
    assert not budget_exhausted(Bare())


def test_terminal_constant():
    assert BUDGET_EXHAUSTED == "budget_exhausted"
