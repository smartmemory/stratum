"""Tests for STRAT-GUARD store (S1) + fingerprint (S2)."""

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum_mcp.guard import store, fingerprint
from stratum_mcp.guard.errors import LedgerCorrupt, ResourceIdMismatch
from stratum_mcp.guard.store import GuardRegistry, LedgerEntry


@pytest.fixture
def guards_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "GUARDS_DIR", tmp_path / "guards")
    store._locks.clear()
    yield tmp_path / "guards"
    store._locks.clear()


def _reg(rid="compose:FEAT-1"):
    return GuardRegistry(
        resource_id=rid,
        graph={"a": ["b"], "b": ["c"], "c": []},
        edge_predicates={"a->b": [{"id": "p1", "type": "deterministic", "statement": "server_file_exists('x')"}]},
        initial="a",
        terminal=["c"],
        stakes={},
        checksum="deadbeef",
        current_state="a",
    )


# ---- fingerprint (S2) ----------------------------------------------------- #


def test_checksum_stable_across_key_order():
    g1 = {"a": ["b"], "b": []}
    g2 = {"b": [], "a": ["b"]}
    ep1 = {"a->b": [{"id": "p", "type": "deterministic", "statement": "x"}]}
    c1 = fingerprint.guard_checksum(g1, ep1, ["b"], {})
    c2 = fingerprint.guard_checksum(g2, ep1, ["b"], {})
    assert c1 == c2


def test_checksum_changes_when_predicate_changes():
    g = {"a": ["b"], "b": []}
    ep1 = {"a->b": [{"id": "p", "type": "deterministic", "statement": "x"}]}
    ep2 = {"a->b": [{"id": "p", "type": "deterministic", "statement": "y"}]}
    assert fingerprint.guard_checksum(g, ep1, [], {}) != fingerprint.guard_checksum(g, ep2, [], {})


def test_checksum_changes_when_stake_weakened():
    g = {"a": ["b"], "b": []}
    ep = {"a->b": []}
    assert fingerprint.guard_checksum(g, ep, [], {"a->b": "paranoid"}) != fingerprint.guard_checksum(
        g, ep, [], {"a->b": "default"}
    )


# ---- registry IO (S1) ----------------------------------------------------- #


def test_registry_roundtrip(guards_dir):
    reg = _reg()
    store.persist_registry(reg)
    loaded = store._load_registry_raw(reg.resource_id)
    assert loaded is not None
    assert loaded.graph == reg.graph
    assert loaded.initial == "a"


def test_resource_id_with_colon_uses_hash_dir(guards_dir):
    reg = _reg("compose:FEAT-1")
    store.persist_registry(reg)
    # dir name is a hash, not a slug containing ':'
    children = list(guards_dir.iterdir())
    assert len(children) == 1
    assert ":" not in children[0].name
    assert len(children[0].name) == 32


def test_resource_id_mismatch_detected(guards_dir):
    reg = _reg("compose:FEAT-1")
    store.persist_registry(reg)
    # Corrupt the stored raw id (simulate a hash collision sharing a dir)
    path = store.resource_dir("compose:FEAT-1") / "registry.json"
    payload = json.loads(path.read_text())
    payload["resource_id"] = "compose:OTHER"
    path.write_text(json.dumps(payload))
    with pytest.raises(ResourceIdMismatch):
        store._load_registry_raw("compose:FEAT-1")


# ---- ledger (S1) ---------------------------------------------------------- #


def _append(rid, frm, to, outcome="applied", **kw):
    e = LedgerEntry(ts_ms=1, from_state=frm, to_state=to, outcome=outcome, kind="transition", **kw)
    return store.append_ledger(rid, e)


def test_ledger_append_and_chain(guards_dir):
    rid = "r1"
    store.persist_registry(_reg(rid))
    d1 = _append(rid, "a", "b")
    d2 = _append(rid, "b", "c")
    entries = store.read_ledger(rid)
    assert len(entries) == 2
    assert entries[0].entry_digest == d1
    assert entries[1].prev_digest == d1
    assert entries[1].entry_digest == d2
    assert store.verify_chain(entries) is True


def test_ledger_interior_tamper_raises(guards_dir):
    rid = "r2"
    store.persist_registry(_reg(rid))
    _append(rid, "a", "b")
    _append(rid, "b", "c")
    path = store._ledger_path(rid)
    lines = path.read_text().splitlines()
    # tamper with the FIRST (interior) line's to_state
    obj = json.loads(lines[0])
    obj["to_state"] = "z"
    lines[0] = json.dumps(obj)
    path.write_text("\n".join(lines) + "\n")
    with pytest.raises(LedgerCorrupt):
        store.read_ledger(rid)


def test_ledger_torn_tail_recovers(guards_dir):
    rid = "r3"
    store.persist_registry(_reg(rid))
    _append(rid, "a", "b")
    _append(rid, "b", "c")
    path = store._ledger_path(rid)
    # simulate a torn final line (partial write)
    with open(path, "a") as f:
        f.write('{"ts_ms": 1, "from_state": "c", "to_st')  # no newline, truncated
    entries = store.read_ledger(rid)
    assert len(entries) == 2  # torn tail dropped, recovered to last durable
    assert entries[-1].to_state == "c"


def test_current_state_from_ledger(guards_dir):
    rid = "r4"
    store.persist_registry(_reg(rid))
    assert store.load_registry(rid).current_state == "a"
    _append(rid, "a", "b")
    assert store.load_registry(rid).current_state == "b"
    _append(rid, "b", "c", outcome="refused")  # refused does not move state
    assert store.load_registry(rid).current_state == "b"


def test_current_state_survives_stale_cache(guards_dir):
    """Crash recovery: ledger head wins over a stale registry.current_state cache."""
    rid = "r5"
    reg = _reg(rid)
    store.persist_registry(reg)
    _append(rid, "a", "b")
    # registry cache still says 'a' (crash before cache rewrite)
    raw = store._load_registry_raw(rid)
    assert raw.current_state == "a"
    # but load_registry derives from ledger head
    assert store.load_registry(rid).current_state == "b"


def test_idempotency_lookup(guards_dir):
    rid = "r6"
    store.persist_registry(_reg(rid))
    _append(rid, "a", "b", idempotency_key="k1", payload_digest="pd1")
    found = store.find_by_idempotency_key(rid, "k1")
    assert found is not None and found.payload_digest == "pd1"
    assert store.find_by_idempotency_key(rid, "nope") is None


# ---- locking (S1) --------------------------------------------------------- #


def test_inprocess_lock_serializes(guards_dir):
    rid = "r7"
    store.persist_registry(_reg(rid))
    order = []

    async def worker(tag, delay):
        async with store.resource_lock(rid):
            order.append(f"{tag}-enter")
            await asyncio.sleep(delay)
            order.append(f"{tag}-exit")

    async def main():
        await asyncio.gather(worker("A", 0.05), worker("B", 0.0))

    asyncio.run(main())
    # whichever entered first must exit before the other enters (no interleave)
    assert order in (
        ["A-enter", "A-exit", "B-enter", "B-exit"],
        ["B-enter", "B-exit", "A-enter", "A-exit"],
    )


def test_resource_id_validation(guards_dir):
    with pytest.raises(ValueError):
        store.resource_dir("")
    with pytest.raises(ValueError):
        store.resource_dir("..")
    with pytest.raises(ValueError):
        store.resource_dir("a\x00b")
