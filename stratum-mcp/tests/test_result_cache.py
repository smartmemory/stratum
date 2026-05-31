"""STRAT-WORKFLOW-RESUME S1: result_cache module -- content-addressed store."""
import json
import os

import pytest

from stratum_mcp import result_cache as rc


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    """Redirect the cache dir to a temp path (patch _cache_dir at the seam)."""
    d = tmp_path / "cache" / "results"
    monkeypatch.setattr(rc, "_cache_dir", lambda: d)
    return d


def _put(key="k1", output=None, **kw):
    output = {"text": "hello"} if output is None else output
    defaults = dict(
        flow_name="main", step_id="s1",
        spec_checksum="abc", source_flow_id="flow-1",
    )
    defaults.update(kw)
    rc.result_cache_put(key, output, **defaults)


def test_put_then_get_roundtrip(cache_dir):
    _put(key="k1", output={"text": "hello", "n": 3})
    assert rc.result_cache_get("k1") == {"text": "hello", "n": 3}


def test_get_miss_when_absent(cache_dir):
    assert rc.result_cache_get("nope") is None


def test_get_empty_key_is_miss(cache_dir):
    assert rc.result_cache_get("") is None


def test_corrupt_file_is_miss(cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    (cache_dir / "bad.json").write_text("{ not json")
    assert rc.result_cache_get("bad") is None


def test_version_skew_is_miss(cache_dir):
    _put(key="k1")
    p = cache_dir / "k1.json"
    rec = json.loads(p.read_text())
    rec["cache_version"] = rc.CACHE_VERSION + 1
    p.write_text(json.dumps(rec))
    assert rc.result_cache_get("k1") is None


def test_key_mismatch_is_miss(cache_dir):
    _put(key="k1")
    p = cache_dir / "k1.json"
    rec = json.loads(p.read_text())
    rec["key"] = "different"
    p.write_text(json.dumps(rec))
    assert rc.result_cache_get("k1") is None


def test_atomic_write_leaves_no_tmp(cache_dir):
    _put(key="k1")
    leftover = [p.name for p in cache_dir.iterdir() if p.name.endswith(".tmp")]
    assert leftover == []
    assert (cache_dir / "k1.json").exists()


def test_canonical_json_sorted_and_compact():
    s = rc.canonical_json({"b": 1, "a": 2})
    assert s == '{"a":2,"b":1}'


def test_canonical_json_non_serializable_returns_none():
    assert rc.canonical_json({1, 2, 3}) is None  # a set is not JSON-serializable


def test_put_empty_key_is_noop(cache_dir):
    rc.result_cache_put("", {"x": 1}, flow_name="m", step_id="s",
                        spec_checksum="c", source_flow_id="f")
    assert not cache_dir.exists() or list(cache_dir.glob("*.json")) == []


def test_cache_disabled_env(monkeypatch):
    monkeypatch.delenv(rc._DISABLE_ENV, raising=False)
    assert rc.cache_disabled() is False
    monkeypatch.setenv(rc._DISABLE_ENV, "1")
    assert rc.cache_disabled() is True
    monkeypatch.setenv(rc._DISABLE_ENV, "0")
    assert rc.cache_disabled() is False
    monkeypatch.setenv(rc._DISABLE_ENV, "true")
    assert rc.cache_disabled() is True


def test_evict_removes_old_keeps_fresh(cache_dir):
    _put(key="old")
    _put(key="fresh")
    old_path = cache_dir / "old.json"
    ancient = os.path.getmtime(cache_dir / "fresh.json") - 100 * 86400
    os.utime(old_path, (ancient, ancient))
    rc.evict(max_age_days=30, max_entries=1000)
    assert not old_path.exists()
    assert (cache_dir / "fresh.json").exists()


def test_evict_enforces_max_entries(cache_dir):
    for i in range(5):
        _put(key=f"k{i}")
    rc.evict(max_age_days=10000, max_entries=2)
    remaining = list(cache_dir.glob("*.json"))
    assert len(remaining) == 2
