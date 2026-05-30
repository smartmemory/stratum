"""STRAT-WORKFLOW-BUDGET — flow-execution-wide budget accounting.

Pure helpers (no IO, no locks, no executor import) for the run-wide budget ledger
carried on ``FlowState.budget_state``. Callers own persistence and the per-flow
lock; these functions only read/mutate the in-memory ledger and parse connector
usage events. See docs/features/STRAT-WORKFLOW-BUDGET/design.md.

Terminology: a *workflow* is the authored definition, a *flow* is the executable
DAG, and a *flow execution* (the thing budgeted here) is one run of it.
"""
from __future__ import annotations

import math
from typing import Any

from .pricing import cost_from_tokens, is_priced

# Terminal status set on a FlowState whose run budget is exhausted. Sits
# alongside "killed" everywhere the flow state machine special-cases terminality.
BUDGET_EXHAUSTED = "budget_exhausted"


def nonneg_int(x: Any) -> int:
    """Coerce to a non-negative int; unparseable/negative → 0.

    Budget accounting must never break flow execution or let a bad value credit
    the ledger back, so a non-numeric or negative token count degrades to 0.
    """
    try:
        v = int(x)
    except (TypeError, ValueError):
        return 0
    return v if v > 0 else 0


def nonneg_float(x: Any) -> float:
    """Coerce to a non-negative finite float; unparseable/negative/NaN/inf → 0.0.

    Critically, a NaN must never reach the ledger: ``nan >= cap`` is always
    False, so a single poisoned dollar value would disable ``usd`` enforcement
    for the rest of the run.
    """
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v) or v < 0.0:
        return 0.0
    return v


def accumulate_usage(acc: dict[str, Any], event: Any) -> dict[str, Any]:
    """Fold one connector event into a running ``{tokens, dollars}`` accumulator.

    Handles both connector shapes:
      * Claude ``run()``/stream → a dict ``{"type": "usage", "input_tokens", ...}``.
      * Codex stream → a ``ConnectorEvent`` with ``kind == "step_usage"`` and a
        ``metadata`` dict carrying ``{"type": "usage", ...}``.
    Only *billed* tokens count (input + output); cache tokens are excluded.
    Non-usage events are ignored (returns ``acc`` unchanged).

    STRAT-WORKFLOW-BUDGET-DOLLARS: connectors emit token counts + a ``model`` id
    but no ``cost_usd`` (codex hardcodes 0, claude omits it). Dollars are derived
    from the static pricing table: trust a positive reported ``cost_usd`` if
    present (future-proofs a connector that starts reporting real cost), else
    price input/output separately via ``cost_from_tokens``. An unpriced model
    contributes ``$0`` and is tagged into ``acc["unpriced_models"]`` so the debit
    site can warn (the cap is in scope there, not here).
    """
    meta = _usage_metadata(event)
    if meta is None:
        return acc
    in_tok = nonneg_int(meta.get("input_tokens"))
    out_tok = nonneg_int(meta.get("output_tokens"))
    acc["tokens"] = acc.get("tokens", 0) + in_tok + out_tok
    cost = nonneg_float(meta.get("cost_usd"))
    if cost <= 0.0:
        model = meta.get("model") or ""
        cost = cost_from_tokens(model, in_tok, out_tok)
        # Only tag a real (hashable, non-empty) string id — a malformed model
        # still prices as $0 above, it just isn't named in the warning set.
        if isinstance(model, str) and model and not is_priced(model):
            acc.setdefault("unpriced_models", set()).add(model)
    acc["dollars"] = acc.get("dollars", 0.0) + cost
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
    ``wall_s >= ms/1000``), ``max_agent_dispatches``, ``max_tokens``, and ``usd``
    (STRAT-WORKFLOW-BUDGET-DOLLARS — dollars derived from token counts via the
    static pricing table; unpriced models under-count). Unbudgeted flows never
    exhaust.
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
    usd = caps.get("usd")
    if usd is not None and consumed["dollars"] >= usd:
        return True
    return False
