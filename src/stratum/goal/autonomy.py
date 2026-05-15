"""STRAT-GOAL v1: Autonomy gate resolution.

``resolve_autonomy(workspace_cwd, caller_dict, *, smart_memory_search_callable)``
reads SmartMemory for per-workspace calibration data, merges with caller-supplied
overrides, and returns the three-class autonomy map::

    {"deterministic": bool, "verified": bool, "judged": bool}

Priority: caller_dict > SmartMemory > all-False default.

Architecture compliance:
- No top-level SmartMemory import (DI-only — architecture.md cross-cutting rule).
- SmartMemory callable is injected; None skips the SM tier entirely.
- SmartMemory call has a 2-second timeout; failures fall through silently.
- 60-second in-process LRU keyed by (workspace_cwd, sm_callable identity).
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)

_AUTONOMY_KEYS = ("deterministic", "verified", "judged")
_DEFAULT_AUTONOMY: dict[str, bool] = {k: False for k in _AUTONOMY_KEYS}
_SM_TIMEOUT_S = 2.0

# ---------------------------------------------------------------------------
# In-process LRU cache
# ---------------------------------------------------------------------------

# Cache entry: (resolved_map, expiry_monotonic)
_cache: dict[str, tuple[dict[str, bool], float]] = {}
_CACHE_TTL_S = 60.0


def _cache_key(workspace_cwd: str | None, sm_callable: Any) -> str:
    """Stable cache key from workspace cwd + callable identity."""
    cwd_part = workspace_cwd or ""
    sm_part = str(id(sm_callable)) if sm_callable is not None else "none"
    return f"{cwd_part}::{sm_part}"


def _cache_get(key: str) -> dict[str, bool] | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    resolved, expiry = entry
    if time.monotonic() > expiry:
        del _cache[key]
        return None
    return resolved


def _cache_set(key: str, resolved: dict[str, bool]) -> None:
    _cache[key] = (resolved, time.monotonic() + _CACHE_TTL_S)


def clear_autonomy_cache() -> None:
    """Clear the in-process autonomy cache. Intended for tests."""
    _cache.clear()


# ---------------------------------------------------------------------------
# SmartMemory read
# ---------------------------------------------------------------------------

async def _sm_with_timeout(
    workspace_cwd: str | None,
    sm_callable: Callable,
    timeout_s: float,
) -> dict[str, bool]:
    """Call sm_callable with timeout; return parsed autonomy map or {} on failure."""
    try:
        coro = sm_callable(
            query="goal autonomy calibration",
            expertise=True,
            top_k=20,
        )
        # Support both async and sync callables
        if asyncio.iscoroutine(coro):
            results = await asyncio.wait_for(coro, timeout=timeout_s)
        else:
            # Sync callable — run in executor to honour the timeout
            loop = asyncio.get_event_loop()
            results = await asyncio.wait_for(
                loop.run_in_executor(None, functools.partial(
                    sm_callable,
                    query="goal autonomy calibration",
                    expertise=True,
                    top_k=20,
                )),
                timeout=timeout_s,
            )
    except asyncio.TimeoutError:
        log.warning(
            "SmartMemory autonomy calibration timed out after %.1fs; "
            "falling back to caller dict / advisory default.",
            timeout_s,
        )
        return {}
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "SmartMemory autonomy calibration failed: %s; "
            "falling back to caller dict / advisory default.",
            exc,
        )
        return {}

    return _parse_sm_results(results)


def _parse_sm_results(results: Any) -> dict[str, bool]:
    """Extract autonomy map from SmartMemory expertise results.

    SmartMemory search(expertise=True) returns a dict keyed by EXPERTISE_TYPES
    buckets. We read the ``"learned"`` bucket and filter for items whose
    metadata.schema == "goal_autonomy_calibration.v1".

    Expected calibration item shape (written by STRAT-GOAL v2):
    {
      "memory_type": "learned",
      "metadata": {
        "schema": "goal_autonomy_calibration.v1",
        "deterministic": {"autonomous": true, ...},
        "verified":      {"autonomous": false, ...},
        "judged":        {"autonomous": false, ...},
      }
    }
    """
    if not isinstance(results, dict):
        return {}

    learned = results.get("learned", [])
    if not isinstance(learned, list):
        return {}

    autonomy: dict[str, bool] = {}
    for item in learned:
        if not isinstance(item, dict):
            continue
        metadata = item.get("metadata", {})
        if not isinstance(metadata, dict):
            continue
        if metadata.get("schema") != "goal_autonomy_calibration.v1":
            continue
        # Found a calibration record — project the three classes
        for key in _AUTONOMY_KEYS:
            class_config = metadata.get(key, {})
            if isinstance(class_config, dict) and "autonomous" in class_config:
                autonomy[key] = bool(class_config["autonomous"])
        # Use the first matching record
        if autonomy:
            break

    return autonomy


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

async def resolve_autonomy(
    workspace_cwd: Optional[str],
    caller_dict: Optional[dict[str, Any]],
    *,
    smart_memory_search_callable: Optional[Callable] = None,
) -> dict[str, bool]:
    """Return {deterministic, verified, judged} autonomy map.

    Priority order: caller_dict > SmartMemory > all-False default.

    Parameters
    ----------
    workspace_cwd:
        Filesystem path of the workspace. Used as cache key.
    caller_dict:
        Per-call autonomy override from the MCP tool invocation. Keys must be
        a subset of {deterministic, verified, judged}; unknown keys are ignored.
        None or empty dict means "no override".
    smart_memory_search_callable:
        Injected SmartMemory search function. Signature::

            async search(query: str, *, expertise: bool, top_k: int) -> dict

        When None, the SmartMemory tier is skipped entirely (safe default).

    Returns
    -------
    dict mapping each autonomy class to bool. All classes default False.
    """
    cache_key = _cache_key(workspace_cwd, smart_memory_search_callable)
    cached = _cache_get(cache_key)
    if cached is not None:
        log.debug("autonomy cache hit for workspace=%r", workspace_cwd)
        # Still apply caller overrides on top of cached SM result
        resolved = dict(cached)
        if caller_dict:
            for key in _AUTONOMY_KEYS:
                if key in caller_dict:
                    resolved[key] = bool(caller_dict[key])
        return resolved

    # Start from safe default
    resolved: dict[str, bool] = dict(_DEFAULT_AUTONOMY)

    # Tier 2: SmartMemory (wins over default)
    if smart_memory_search_callable is not None:
        sm_layer = await _sm_with_timeout(
            workspace_cwd, smart_memory_search_callable, timeout_s=_SM_TIMEOUT_S
        )
        for key in _AUTONOMY_KEYS:
            if key in sm_layer:
                resolved[key] = sm_layer[key]

    # Cache the SM-resolved (pre-caller-override) map so subsequent calls within
    # 60s skip the SM round-trip. Caller overrides are applied after cache read.
    _cache_set(cache_key, dict(resolved))

    # Tier 1: caller override (wins over SmartMemory)
    if caller_dict:
        for key in _AUTONOMY_KEYS:
            if key in caller_dict:
                resolved[key] = bool(caller_dict[key])

    return resolved
