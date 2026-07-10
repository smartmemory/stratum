"""Single source of truth for which Codex model Stratum talks to by default.

Every other Codex-model reference in the codebase imports from here instead of
hardcoding a model string, so bumping the default or adding a new model is a
one-file change:

    stratum_mcp/connectors/codex.py   -> CODEX_MODEL_IDS, DEFAULT_CODEX_MODEL
    stratum_mcp/connectors/factory.py -> DEFAULT_CODEX_MODEL (re-exported via codex.py)
    stratum/judge/verifier.py         -> DEFAULT_CODEX_MODEL (as T3_DEFAULT_MODEL)

Pricing is NOT consolidated here — ``stratum_mcp/pricing.py`` and Compose's own
``lib/experiment-pricing.js`` / ``compose-lab/lib/pricing.py`` carry independent
USD-per-model tables (different data, and the JS pricing file can't import
Python). When you add a model here, add a matching price row in those three
files too, or the new model silently prices as $0.

## To bump the default model or add a new one

1. Add the new model id (and its ``/low|medium|high|xhigh`` effort variants, if
   it supports reasoning-effort tiers) to ``CODEX_MODEL_IDS`` below.
2. Change ``_FALLBACK_DEFAULT`` to the new default id, OR set the ``CODEX_MODEL``
   env var (which always wins — no code change needed for a temporary override).
3. Add a price row for the new base model id to:
   - ``stratum-mcp/src/stratum_mcp/pricing.py`` (``MODEL_PRICING``)
   - ``compose/lib/experiment-pricing.js``
   - ``compose-lab/lib/pricing.py``
4. Update the human-readable docs:
   - ``compose/docs/configuration.md`` (the `CODEX_MODEL` env var row)
   - ``compose/docs/agents.md`` (the "Supported models" / default line)
5. The allowlist is advisory, not enforced (``codex.py: _assert_codex_model``
   warns on an unrecognized model but never blocks — codex CLI itself is the
   authority on which models actually exist). So step 1 is about keeping this
   file an accurate, greppable inventory, not a hard gate.
"""
from __future__ import annotations

import os

CODEX_MODEL_IDS: frozenset[str] = frozenset(
    {
        "gpt-5.6-sol",
        "gpt-5.6-sol/low",
        "gpt-5.6-sol/medium",
        "gpt-5.6-sol/high",
        "gpt-5.6-sol/xhigh",
        "gpt-5.6-terra",
        "gpt-5.6-terra/low",
        "gpt-5.6-terra/medium",
        "gpt-5.6-terra/high",
        "gpt-5.6-terra/xhigh",
        "gpt-5.5",
        "gpt-5.5/low",
        "gpt-5.5/medium",
        "gpt-5.5/high",
        "gpt-5.5/xhigh",
        "gpt-5.4",
        "gpt-5.4/low",
        "gpt-5.4/medium",
        "gpt-5.4/high",
        "gpt-5.4/xhigh",
        "gpt-5.3-codex-spark",
        "gpt-5.3-codex-spark/low",
        "gpt-5.3-codex-spark/medium",
        "gpt-5.3-codex-spark/high",
        "gpt-5.3-codex-spark/xhigh",
        "gpt-5.2-codex",
        "gpt-5.2-codex/low",
        "gpt-5.2-codex/medium",
        "gpt-5.2-codex/high",
        "gpt-5.2-codex/xhigh",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-max/low",
        "gpt-5.1-codex-max/medium",
        "gpt-5.1-codex-max/high",
        "gpt-5.1-codex-max/xhigh",
        "gpt-5.1-codex",
        "gpt-5.1-codex/low",
        "gpt-5.1-codex/medium",
        "gpt-5.1-codex/high",
        "gpt-5.1-codex-mini",
        "gpt-5.1-codex-mini/medium",
        "gpt-5.1-codex-mini/high",
    }
)

# Code-level fallback when CODEX_MODEL is unset. The env var always wins.
# Terra (balanced tier, ~gpt-5.5 quality at half the price); effort pinned to
# /high explicitly (not xhigh, and not inherited from ~/.codex/config.toml)
# per user preference. Sol stays in the allowlist for hard adversarial passes.
_FALLBACK_DEFAULT = "gpt-5.6-terra/high"

DEFAULT_CODEX_MODEL = os.environ.get("CODEX_MODEL", _FALLBACK_DEFAULT)
