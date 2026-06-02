"""Guard persistence + concurrency + tamper-evident ledger (S1).

Layout (mirrors ``~/.stratum/flows/``)::

    ~/.stratum/guards/<hash(resource_id)>/registry.json   # checksummed policy + initial + cache of current_state
    ~/.stratum/guards/<hash(resource_id)>/ledger.jsonl     # hash-chained, append-only, fsync'd
    ~/.stratum/guards/<hash(resource_id)>/.lock            # flock sidecar (cross-process)

Key correctness properties (see blueprint Trust boundary + S1):
  * The *ledger* is the source of truth for ``current_state`` — ``registry.json``'s
    copy is a best-effort cache. The durable, fsync'd ledger append is the commit point.
  * ``read_ledger`` tolerates a torn trailing line (crash mid-append → recover to last
    durable entry) but treats an interior chain break as tampering (``LedgerCorrupt``).
  * Per-resource serialization uses BOTH an in-process ``asyncio.Lock`` (coroutine
    safety, like ``parallel_exec``) AND a cross-process ``fcntl.flock`` (separate OS
    processes). Blocking ``flock`` is acquired via ``asyncio.to_thread`` so the event
    loop is never blocked.
  * The resource dir is named by ``sha256(resource_id)`` (collision-proof vs slugs);
    the raw id is stored and verified on load.
"""

from __future__ import annotations

import asyncio
import dataclasses
import fcntl
import hashlib
import json
import os
import re
import tempfile
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from ..result_cache import canonical_json
from .errors import LedgerCorrupt, ResourceIdMismatch

# Module global so tests can ``monkeypatch.setattr(store, "GUARDS_DIR", tmp_path)``
# (mirrors executor._FLOWS_DIR). Read at call time via _guards_root().
GUARDS_DIR: Path = Path.home() / ".stratum" / "guards"

_STATE_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

# In-process per-resource locks. Keyed by raw resource_id. Mirrors the per-flow
# asyncio.Lock pattern in parallel_exec.py.
_locks: dict[str, asyncio.Lock] = {}


def _guards_root() -> Path:
    return GUARDS_DIR


def _resource_hash(resource_id: str) -> str:
    return hashlib.sha256(resource_id.encode("utf-8")).hexdigest()[:32]


def _validate_resource_id(resource_id: str) -> None:
    if not isinstance(resource_id, str) or not resource_id:
        raise ValueError("resource_id must be a non-empty string")
    if "\x00" in resource_id:
        raise ValueError("resource_id must not contain NUL")
    if resource_id in (".", ".."):
        raise ValueError("resource_id cannot be '.' or '..'")


def resource_dir(resource_id: str) -> Path:
    """Collision-proof directory for a resource. Raw id stored in registry.json
    and verified on load, so a (vanishingly unlikely) hash prefix collision can
    never silently share state — it surfaces as ResourceIdMismatch."""
    _validate_resource_id(resource_id)
    return _guards_root() / _resource_hash(resource_id)


def is_valid_state_name(name: str) -> bool:
    return isinstance(name, str) and bool(_STATE_NAME_RE.match(name))


# --------------------------------------------------------------------------- #
# Dataclasses
# --------------------------------------------------------------------------- #


@dataclass
class GuardRegistry:
    """The registered, checksummed policy for one guarded resource."""

    resource_id: str
    graph: dict[str, list[str]]
    edge_predicates: dict[str, list[dict[str, Any]]]
    initial: str
    terminal: list[str] = field(default_factory=list)
    stakes: dict[str, str] = field(default_factory=dict)
    checksum: str = ""
    graph_version: int = 1
    workspace_root: Optional[str] = None
    # Non-authoritative cache; ledger head is the source of truth.
    current_state: str = ""

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GuardRegistry":
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class LedgerEntry:
    """One append-only transition/deviation record. ``entry_digest`` is the
    receipt token (returned to callers as ``ledger_ref``)."""

    ts_ms: int
    from_state: str
    to_state: str
    outcome: str  # "applied" | "refused" | "deviation" | "review_clean" | "graph_version"
    kind: str  # "transition" | "deviation" | "graph_version"
    resolved_by: str = "agent"
    idempotency_key: Optional[str] = None
    payload_digest: Optional[str] = None
    rationale: Optional[str] = None
    # The full JudgeResult-shaped verdict for this attempt — stored so an
    # idempotent replay returns the ORIGINAL decision, not a synthesized one.
    verdict: Optional[dict] = None
    prev_digest: str = ""
    entry_digest: str = ""

    def core(self) -> dict[str, Any]:
        """The digested payload — every field EXCEPT entry_digest."""
        d = dataclasses.asdict(self)
        d.pop("entry_digest", None)
        return d

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "LedgerEntry":
        known = {f.name for f in dataclasses.fields(cls)}
        return cls(**{k: v for k, v in d.items() if k in known})


def compute_entry_digest(entry_core: dict[str, Any], prev_digest: str) -> str:
    canonical = canonical_json(entry_core)
    if canonical is None:
        raise ValueError("ledger entry is not JSON-serializable")
    return hashlib.sha256((canonical + prev_digest).encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Atomic write (self-contained copy of migrate._atomic_write)
# --------------------------------------------------------------------------- #


def _atomic_write(path: Path, content: str) -> None:
    """Write content to path atomically via tempfile + fsync + os.replace()."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, delete=False, suffix=".tmp", encoding="utf-8"
    )
    try:
        tmp.write(content)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
# Registry IO
# --------------------------------------------------------------------------- #


def registry_exists(resource_id: str) -> bool:
    return (resource_dir(resource_id) / "registry.json").exists()


def persist_registry(reg: GuardRegistry) -> None:
    path = resource_dir(reg.resource_id) / "registry.json"
    _atomic_write(path, json.dumps(reg.to_dict(), indent=2, sort_keys=True))


def _load_registry_raw(resource_id: str) -> Optional[GuardRegistry]:
    path = resource_dir(resource_id) / "registry.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    reg = GuardRegistry.from_dict(payload)
    if reg.resource_id != resource_id:
        raise ResourceIdMismatch(
            f"registry stores resource_id {reg.resource_id!r} but {resource_id!r} requested"
        )
    return reg


def load_registry(resource_id: str) -> Optional[GuardRegistry]:
    """Load policy from registry.json and set ``current_state`` from the ledger
    head (source of truth). Raises LedgerCorrupt on interior chain break."""
    reg = _load_registry_raw(resource_id)
    if reg is None:
        return None
    entries = read_ledger(resource_id)
    reg.current_state = current_state_from_ledger(entries, reg.initial)
    return reg


# --------------------------------------------------------------------------- #
# Ledger
# --------------------------------------------------------------------------- #


def _ledger_path(resource_id: str) -> Path:
    return resource_dir(resource_id) / "ledger.jsonl"


def read_ledger(resource_id: str) -> list[LedgerEntry]:
    """Read + chain-verify the ledger.

    Torn-tail recovery: if the FINAL line fails to parse or breaks the chain (an
    interrupted append), it is dropped and we recover to the last durable entry.
    A chain break at any NON-final line is genuine tampering → LedgerCorrupt.
    """
    path = _ledger_path(resource_id)
    if not path.exists():
        return []
    raw_lines = [ln for ln in path.read_text().splitlines() if ln.strip()]
    entries: list[LedgerEntry] = []
    prev = ""
    for idx, line in enumerate(raw_lines):
        is_last = idx == len(raw_lines) - 1
        try:
            obj = json.loads(line)
            entry = LedgerEntry.from_dict(obj)
        except (json.JSONDecodeError, TypeError, KeyError):
            if is_last:
                break  # torn trailing line — recover
            raise LedgerCorrupt(f"ledger line {idx} is not valid JSON (interior)")
        expected = compute_entry_digest(entry.core(), prev)
        if entry.entry_digest != expected or entry.prev_digest != prev:
            if is_last:
                break  # interrupted append of the final entry — recover
            raise LedgerCorrupt(
                f"ledger chain broken at line {idx} (interior tampering)"
            )
        entries.append(entry)
        prev = entry.entry_digest
    return entries


def verify_chain(entries: list[LedgerEntry]) -> bool:
    prev = ""
    for entry in entries:
        if entry.prev_digest != prev:
            return False
        if entry.entry_digest != compute_entry_digest(entry.core(), prev):
            return False
        prev = entry.entry_digest
    return True


def append_ledger(resource_id: str, entry: LedgerEntry) -> str:
    """Durably append a hash-chained entry. Caller MUST hold the resource lock.

    Returns the entry_digest (the receipt token / ledger_ref).
    """
    entries = read_ledger(resource_id)
    prev = entries[-1].entry_digest if entries else ""
    entry.prev_digest = prev
    entry.entry_digest = compute_entry_digest(entry.core(), prev)

    path = _ledger_path(resource_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = canonical_json(entry.to_dict())
    if line is None:
        raise ValueError("ledger entry is not JSON-serializable")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    try:
        os.write(fd, (line + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return entry.entry_digest


def find_by_idempotency_key(
    resource_id: str, key: Optional[str]
) -> Optional[LedgerEntry]:
    if not key:
        return None
    for entry in reversed(read_ledger(resource_id)):
        if entry.idempotency_key == key:
            return entry
    return None


def current_state_from_ledger(entries: list[LedgerEntry], initial: str) -> str:
    """The current state is the to_state of the last entry that moved state."""
    for entry in reversed(entries):
        if entry.outcome in ("applied", "deviation"):
            return entry.to_state
    return initial


# --------------------------------------------------------------------------- #
# Locking (in-process asyncio.Lock + cross-process fcntl.flock)
# --------------------------------------------------------------------------- #


def _get_inproc_lock(resource_id: str) -> asyncio.Lock:
    lock = _locks.get(resource_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[resource_id] = lock
    return lock


@asynccontextmanager
async def resource_lock(resource_id: str):
    """Serialize all access to one resource across coroutines AND OS processes.

    The blocking ``flock`` is acquired on a worker thread so the event loop keeps
    running. The in-process ``asyncio.Lock`` prevents two coroutines in THIS
    process from both holding distinct fds that flock would (on some platforms)
    consider compatible, and gives fair coroutine ordering.
    """
    inproc = _get_inproc_lock(resource_id)
    await inproc.acquire()
    rdir = resource_dir(resource_id)
    rdir.mkdir(parents=True, exist_ok=True)
    lock_path = rdir / ".lock"
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        await asyncio.to_thread(fcntl.flock, fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            await asyncio.to_thread(fcntl.flock, fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)
        inproc.release()
