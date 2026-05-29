"""STRAT-WORKFLOW-BUDGET — flow-execution-wide budget accounting.

Pure helpers (no IO, no locks, no executor import) for the run-wide budget ledger
carried on ``FlowState.budget_state``. Callers own persistence and the per-flow
lock; these functions only read/mutate the in-memory ledger and parse connector
usage events. See docs/features/STRAT-WORKFLOW-BUDGET/design.md.

Terminology: a *workflow* is the authored definition, a *flow* is the executable
DAG, and a *flow execution* (the thing budgeted here) is one run of it.
"""
from __future__ import annotations

from typing import Any

# Terminal status set on a FlowState whose run budget is exhausted. Sits
# alongside "killed" everywhere the flow state machine special-cases terminality.
BUDGET_EXHAUSTED = "budget_exhausted"


def accumulate_usage(acc: dict[str, Any], event: Any) -> dict[str, Any]:
    """Fold one connector event into a running ``{tokens, dollars}`` accumulator.

    Handles both connector shapes:
      * Claude ``run()``/stream → a dict ``{"type": "usage", "input_tokens", ...}``.
      * Codex stream → a ``ConnectorEvent`` with ``kind == "step_usage"`` and a
        ``metadata`` dict carrying ``{"type": "usage", ...}``.
    Only *billed* tokens count (input + output); cache tokens are excluded.
    Non-usage events are ignored (returns ``acc`` unchanged).
    """
    meta = _usage_metadata(event)
    if meta is None:
        return acc
    acc["tokens"] = acc.get("tokens", 0) + int(meta.get("input_tokens") or 0) + int(
        meta.get("output_tokens") or 0
    )
    acc["dollars"] = acc.get("dollars", 0.0) + float(meta.get("cost_usd") or 0.0)
    return acc


def _usage_metadata(event: Any) -> dict | None:
    """Return the usage payload dict if ``event`` is a usage event, else None.

    ConnectorEvents signal usage via ``kind == "step_usage"`` (both claude and
    codex stream_events use this; only codex additionally stamps
    ``metadata["type"] == "usage"``, so we key on ``kind``, not the type stamp).
    Plain ``run()`` dict events signal usage via ``type == "usage"``.
    """
    # Streaming: ConnectorEvent with .kind / .metadata
    kind = getattr(event, "kind", None)
    if kind is not None:
        if kind == "step_usage":
            meta = getattr(event, "metadata", None)
            return meta if isinstance(meta, dict) else None
        return None
    # run()/plain dict event
    if isinstance(event, dict) and event.get("type") == "usage":
        return event
    return None


def new_usage_acc() -> dict[str, Any]:
    return {"tokens": 0, "dollars": 0.0}


def debit_budget(
    state: Any,
    *,
    dispatches: int = 0,
    tokens: int = 0,
    wall_s: float = 0.0,
    dollars: float = 0.0,
) -> None:
    """Charge consumption against ``state.budget_state``. No-op when unbudgeted.

    Pure synchronous mutation — atomic between asyncio awaits, so concurrent
    fan-out tasks cannot interleave mid-update. The caller persists.
    """
    bs = getattr(state, "budget_state", None)
    if not bs:
        return
    consumed = bs["consumed"]
    consumed["dispatches"] += int(dispatches)
    consumed["tokens"] += int(tokens)
    consumed["wall_s"] += float(wall_s)
    consumed["dollars"] += float(dollars)


def budget_exhausted(state: Any) -> bool:
    """True when any *enforced* axis has reached or exceeded its cap.

    Enforced axes: ``ms`` (wall-clock, compute-seconds — compared as
    ``wall_s >= ms/1000``), ``max_agent_dispatches``, ``max_tokens``. ``usd`` is
    recorded-not-enforced and never trips. Unbudgeted flows never exhaust.
    """
    bs = getattr(state, "budget_state", None)
    if not bs:
        return False
    caps = bs["caps"]
    consumed = bs["consumed"]
    ms = caps.get("ms")
    if ms is not None and consumed["wall_s"] >= ms / 1000.0:
        return True
    max_disp = caps.get("max_agent_dispatches")
    if max_disp is not None and consumed["dispatches"] >= max_disp:
        return True
    max_tok = caps.get("max_tokens")
    if max_tok is not None and consumed["tokens"] >= max_tok:
        return True
    return False
