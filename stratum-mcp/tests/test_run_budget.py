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


def test_dollars_never_trips():
    s = _State({"usd": 0.01, "max_tokens": 1000})
    debit_budget(s, dollars=999.0, tokens=10)
    assert not budget_exhausted(s)


def test_unbudgeted_never_exhausted():
    class Bare:
        budget_state = None
    assert not budget_exhausted(Bare())


def test_terminal_constant():
    assert BUDGET_EXHAUSTED == "budget_exhausted"
