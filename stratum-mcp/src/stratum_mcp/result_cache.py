"""STRAT-WORKFLOW-RESUME: content-addressed result cache for flow steps.

A cache entry maps a content-addressed key (derived from the flow name, step id,
spec checksum, and the step's resolved input) to a previously-validated step
``output`` dict. When a flow is re-run or resumed, an unchanged prefix step can
return its cached result instantly instead of re-dispatching the agent.

Soundness boundary (enforced by the validator, not here): only opt-in,
side-effect-free ``compute`` function steps are ever cached. This module is a
dumb content-addressed key->value store; it makes no eligibility decisions.

Store layout: ``~/.stratum/cache/results/<key>.json`` (a sibling of
``~/.stratum/flows/``), so entries are shared across flow_ids and across
sessions -- that is what lets a *new* run of the same workflow hit. The directory
root is read at call time so tests can redirect ``Path.home()``/the seam.

Failure policy: **best-effort, never wrong.** Any read error, corrupt record, or
version skew is treated as a miss (returns ``None``); the caller falls back to a
normal dispatch. Writes are atomic (tmp + ``os.replace``); a non-serializable
value degrades to "no key" upstream and is never written.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

# Bump whenever the record format or key composition changes -- forces a clean
# miss across an upgrade (old records fail the version check -> treated as miss).
CACHE_VERSION: int = 1

_DISABLE_ENV = "STRATUM_DISABLE_RESULT_CACHE"
_MAX_AGE_ENV = "STRATUM_CACHE_MAX_AGE_DAYS"
_MAX_ENTRIES_ENV = "STRATUM_CACHE_MAX_ENTRIES"

_DEFAULT_MAX_AGE_DAYS = 30
_DEFAULT_MAX_ENTRIES = 2000

# Sample eviction roughly 1/_EVICT_SAMPLE writes so it is never on the hot path
# but also never dead code.
_EVICT_SAMPLE = 50
_write_counter = 0


def _cache_dir() -> Path:
    """Return the cache directory, reading ``Path.home()`` at call time.

    ~/.stratum/cache/results -- a sibling of ~/.stratum/flows so cache entries are
    independent of any single flow's lifecycle.
    """
    return Path.home() / ".stratum" / "cache" / "results"


def cache_disabled() -> bool:
    """True when the kill switch env var is set to a truthy value."""
    val = os.environ.get(_DISABLE_ENV, "")
    return val.strip().lower() not in ("", "0", "false", "no")


def canonical_json(value: Any) -> str | None:
    """Deterministic JSON encoding for use in a cache key.

    Sorted keys, compact separators. Returns ``None`` for any value that is not
    JSON-serializable (the caller then forces a miss rather than caching against
    an unstable key). Never raises.
    """
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return None


def _key_path(key: str) -> Path:
    return _cache_dir() / f"{key}.json"


def result_cache_get(key: str) -> dict | None:
    """Return the cached ``output`` dict for ``key``, or ``None`` on any miss.

    A miss is: file absent, unreadable, unparsable, key mismatch, or a
    ``cache_version`` other than the current ``CACHE_VERSION``. Never raises.
    """
    if not key:
        return None
    path = _key_path(key)
    try:
        if not path.exists():
            return None
        record = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict):
        return None
    if record.get("cache_version") != CACHE_VERSION:
        return None
    if record.get("key") != key:
        return None
    if "output" not in record:
        return None
    return record["output"]


def result_cache_put(
    key: str,
    output: Any,
    *,
    flow_name: str,
    step_id: str,
    spec_checksum: str,
    source_flow_id: str,
) -> None:
    """Atomically write a cache record for ``key``. Best-effort (never raises).

    Only call this for a step whose result has already passed schema + guardrails
    + ensure validation. Writes via a temp file + ``os.replace`` so a concurrent
    reader never sees a partial record; identical-bytes concurrent writers under
    content-addressing make last-writer-wins safe.
    """
    if not key:
        return
    record = {
        "key": key,
        "cache_version": CACHE_VERSION,
        "flow_name": flow_name,
        "step_id": step_id,
        "spec_checksum": spec_checksum,
        "output": output,
        "created_at": _now_iso(),
        "source_flow_id": source_flow_id,
    }
    try:
        body = json.dumps(record, indent=2)
    except (TypeError, ValueError):
        # Output not serializable -- caller should have forced a miss already;
        # defensively skip rather than raise.
        return
    cdir = _cache_dir()
    try:
        cdir.mkdir(parents=True, exist_ok=True)
        path = cdir / f"{key}.json"
        tmp = cdir / f".{key}.{os.getpid()}.tmp"
        tmp.write_text(body)
        os.replace(tmp, path)
    except OSError:
        return
    _maybe_evict()


def _now_iso() -> str:
    # Wall-clock for TTL/GC only -- never part of the key.
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _maybe_evict() -> None:
    global _write_counter
    _write_counter += 1
    if _write_counter % _EVICT_SAMPLE != 0:
        return
    try:
        evict()
    except Exception:
        pass


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def evict(*, max_age_days: int | None = None, max_entries: int | None = None) -> None:
    """GC the cache by age then by count. Best-effort; never touches the read path.

    Removes records older than ``max_age_days`` (by file mtime), then, if more
    than ``max_entries`` remain, removes the oldest by mtime until at most
    ``max_entries`` remain. A swept key is at worst a future miss, never a
    corruption.
    """
    if max_age_days is None:
        max_age_days = _env_int(_MAX_AGE_ENV, _DEFAULT_MAX_AGE_DAYS)
    if max_entries is None:
        max_entries = _env_int(_MAX_ENTRIES_ENV, _DEFAULT_MAX_ENTRIES)
    cdir = _cache_dir()
    if not cdir.exists():
        return
    try:
        entries = [p for p in cdir.glob("*.json") if p.is_file()]
    except OSError:
        return
    now = time.time()
    cutoff = now - max_age_days * 86400
    survivors: list[Path] = []
    for p in entries:
        mtime = _safe_mtime(p)
        if mtime and mtime < cutoff:
            try:
                p.unlink()
            except OSError:
                pass
        else:
            survivors.append(p)
    if len(survivors) > max_entries:
        survivors.sort(key=_safe_mtime)
        for p in survivors[: len(survivors) - max_entries]:
            try:
                p.unlink()
            except OSError:
                pass


def _safe_mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0
