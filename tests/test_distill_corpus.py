"""STRAT-DISTILL S1 — AssetCandidate + sidecar writer tests (TDD)."""
from __future__ import annotations

import json
import threading
from pathlib import Path

from stratum.judge.distill.candidate import AssetCandidate
from stratum.judge.postmortem.corpus import (
    DISTILL_SCHEMA_VERSION,
    append_distill_candidates,
    distill_sidecar_path,
    inline_sidecar_path,
)


def _cand(cluster_id: str = "c1", kind: str = "skill", name: str = "foo") -> AssetCandidate:
    return AssetCandidate(
        asset_kind=kind,
        asset_name=name,
        target_path=f"skills/{name}/SKILL.md",
        trigger_pattern="do foo",
        rationale="recurred 3x across 2 sessions",
        suggested_content="1. step one\n2. step two",
        evidence_session_ids=("S1", "S2"),
        cluster_id=cluster_id,
        confidence=80,
    )


def test_asset_candidate_to_dict_shape():
    d = _cand().to_dict()
    assert d["patch_type"] == "create"
    assert d["asset_kind"] == "skill"
    assert d["asset_name"] == "foo"
    assert d["cluster_id"] == "c1"
    assert d["evidence_session_ids"] == ["S1", "S2"]
    assert d["confidence"] == 80


def test_patch_type_locked_to_create():
    assert _cand().patch_type == "create"


def test_append_writes_distill_envelope(tmp_path):
    p = distill_sidecar_path(tmp_path)
    assert append_distill_candidates(p, [_cand("c1")], project="proj") == 1
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    assert len(rows) == 1
    r = rows[0]
    assert r["origin"] == "distill"
    assert DISTILL_SCHEMA_VERSION == "distill-1.0"
    assert r["_schema_version"] == "distill-1.0"
    assert r["candidate_id"] == "distill:c1"
    assert r["distill_candidate"]["patch_type"] == "create"


def test_idempotent_on_cluster_id(tmp_path):
    p = distill_sidecar_path(tmp_path)
    assert append_distill_candidates(p, [_cand("c1")], project="x") == 1
    assert append_distill_candidates(p, [_cand("c1")], project="x") == 0
    rows = [l for l in p.read_text().splitlines() if l.strip()]
    assert len(rows) == 1


def test_dedup_within_batch(tmp_path):
    p = distill_sidecar_path(tmp_path)
    assert append_distill_candidates(p, [_cand("a"), _cand("b"), _cand("a")], project="x") == 2


def test_empty_is_noop(tmp_path):
    p = distill_sidecar_path(tmp_path)
    assert append_distill_candidates(p, [], project="x") == 0
    assert not p.exists()


def test_concurrent_appends_no_loss(tmp_path):
    p = distill_sidecar_path(tmp_path)

    def worker(i: int):
        append_distill_candidates(p, [_cand(f"c{i}")], project="x")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rows = [l for l in p.read_text().splitlines() if l.strip()]
    assert len(rows) == 8


def test_other_sidecars_untouched(tmp_path):
    p = distill_sidecar_path(tmp_path)
    append_distill_candidates(p, [_cand("c1")], project="x")
    assert not inline_sidecar_path(tmp_path).exists()
    assert not (tmp_path / ".stratum" / "postmortem" / "candidates.jsonl").exists()
