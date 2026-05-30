"""STRAT-WORKFLOW-BUDGET-DOLLARS — token→USD pricing for the MCP path.

``stratum-mcp`` has no ``litellm`` dependency (that lives only in the library
executor), so run-budget dollar enforcement uses this static, hand-maintained
table instead. Prices are **approximate** USD per 1M tokens and are a best-effort
ceiling estimator, *not* billing. Patch a stale price or add a model without a
release via the ``STRATUM_MODEL_PRICING_JSON`` env var (a JSON object merged over
the built-in table).

Pure pricing helpers — ``cost_from_tokens`` / ``is_priced`` do no logging so they
stay freely testable; ``_maybe_warn_unpriced`` is the single logging point,
called from the budget debit sites where the ``usd`` cap is in scope.
See docs/features/STRAT-WORKFLOW-BUDGET-DOLLARS/design.md.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

# USD per 1M tokens, by BASE model id (codex /effort suffix stripped).
MODEL_PRICING: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-opus-4-8": {"input": 15.0, "output": 75.0},
    "claude-opus-4-7": {"input": 15.0, "output": 75.0},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0},
    "gpt-5.4": {"input": 1.25, "output": 10.0},
    "gpt-5.2-codex": {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex-max": {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex": {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex-mini": {"input": 0.25, "output": 2.0},
}

_ENV_VAR = "STRATUM_MODEL_PRICING_JSON"

# Memoized effective table (built-in merged with the env override) and the set of
# base models already warned about, so the warning fires once per model id.
_table_cache: dict[str, dict[str, float]] | None = None
_warned_models: set[str] = set()


def _base_model(model: Any) -> str:
    """Strip a codex /effort suffix: 'gpt-5.4/high' -> 'gpt-5.4'.

    Tolerates non-string / falsy ids (untyped consumer-reported usage) → "" so
    a malformed model never raises in the pricing path; it just prices as $0.
    """
    if not isinstance(model, str):
        return ""
    return model.split("/", 1)[0]


def _load_env_override() -> dict[str, dict[str, float]]:
    """Parse STRATUM_MODEL_PRICING_JSON into validated entries.

    Malformed JSON or non-object payloads degrade to ``{}`` (built-in table only,
    never a crash). Each entry must carry numeric ``input``/``output`` rates or it
    is skipped.
    """
    raw = os.environ.get(_ENV_VAR)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("%s is not valid JSON; ignoring (using built-in prices)", _ENV_VAR)
        return {}
    if not isinstance(parsed, dict):
        logger.warning("%s must be a JSON object; ignoring", _ENV_VAR)
        return {}
    out: dict[str, dict[str, float]] = {}
    for model, rates in parsed.items():
        if not isinstance(rates, dict):
            continue
        try:
            inp = float(rates["input"])
            outp = float(rates["output"])
        except (KeyError, TypeError, ValueError):
            continue
        out[model] = {"input": inp, "output": outp}
    return out


def _pricing_table() -> dict[str, dict[str, float]]:
    """Effective table: built-in prices with the env override merged on top."""
    global _table_cache
    if _table_cache is None:
        merged = dict(MODEL_PRICING)
        merged.update(_load_env_override())
        _table_cache = merged
    return _table_cache


def is_priced(model: str) -> bool:
    return _base_model(model) in _pricing_table()


def cost_from_tokens(model: str, input_tokens: int, output_tokens: int) -> float:
    """USD for one usage event. Prices input/output separately (different rates).

    Unknown / unpriced model -> ``0.0`` (degrade silently; a missing price must
    never block a flow — it just under-counts). Callers that enforce a ``usd``
    cap should pair this with ``_maybe_warn_unpriced`` to surface the gap.
    """
    rates = _pricing_table().get(_base_model(model))
    if rates is None:
        return 0.0
    return (input_tokens / 1_000_000.0) * rates["input"] + (
        output_tokens / 1_000_000.0
    ) * rates["output"]


def _maybe_warn_unpriced(model: str, has_usd_cap: bool) -> None:
    """Warn once per unpriced base model when a ``usd`` cap is in effect.

    No-op for priced models, empty ids, or flows without a ``usd`` cap (an
    unpriced model only matters when dollars are being enforced).
    """
    if not has_usd_cap or not model or is_priced(model):
        return
    base = _base_model(model)
    if not base or base in _warned_models:  # non-string/empty id → nothing to name
        return
    _warned_models.add(base)
    logger.warning(
        "STRAT-WORKFLOW-BUDGET-DOLLARS: no price for model %r; "
        "usd cap under-counts its cost as $0 "
        "(set %s to add it)",
        base,
        _ENV_VAR,
    )
