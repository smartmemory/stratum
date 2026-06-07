"""STRAT-LEARN-INLINE — S2 inline-sidecar writer tests."""

import json
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum.judge.inline_learn import PatchCandidate
from stratum.judge.postmortem.corpus import (
    INLINE_SCHEMA_VERSION,
    append_inline_candidates,
    inline_sidecar_path,
)


def mk_cand(pid="p1"):
    return PatchCandidate(
        fix_target="durable", target_kind="memory",
        target_path=".claude/memory/MEMORY.md", patch_type="edit",
        rationale="r", suggested_change="add a note", source_finding="f",
        predicate_id=pid, predicate_type="judged", confidence=8,
    )


def _rows(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def test_append_writes_inline_schema_no_label(tmp_path):
    path = inline_sidecar_path(tmp_path)
    n = append_inline_candidates(path, [mk_cand()], flow_id="f1",
                                 step_id="s1", turn=1, project="proj")
    assert n == 1
    rows = _rows(path)
    assert len(rows) == 1
    r = rows[0]
    assert r["origin"] == "inline"
    assert r["_schema_version"] == INLINE_SCHEMA_VERSION
    assert "label" not in r  # never the replay ground-truth contract
    assert r["candidate_id"] == "inline:f1:s1:p1:1"
    assert r["inline_patch"]["target_path"] == ".claude/memory/MEMORY.md"


def test_append_idempotent_on_turn_scoped_id(tmp_path):
    path = inline_sidecar_path(tmp_path)
    kw = dict(flow_id="f1", step_id="s1", turn=1, project="p")
    assert append_inline_candidates(path, [mk_cand()], **kw) == 1
    assert append_inline_candidates(path, [mk_cand()], **kw) == 0  # dup skipped
    assert len(_rows(path)) == 1


def test_distinct_turns_are_distinct_rows(tmp_path):
    path = inline_sidecar_path(tmp_path)
    append_inline_candidates(path, [mk_cand()], flow_id="f1", step_id="s1",
                             turn=1, project="p")
    append_inline_candidates(path, [mk_cand()], flow_id="f1", step_id="s1",
                             turn=2, project="p")
    rows = _rows(path)
    assert {r["candidate_id"] for r in rows} == {
        "inline:f1:s1:p1:1", "inline:f1:s1:p1:2"}


def test_empty_candidates_is_noop(tmp_path):
    path = inline_sidecar_path(tmp_path)
    assert append_inline_candidates(path, [], flow_id="f", step_id="s",
                                    turn=1, project="p") == 0
    assert not path.exists()


def test_concurrent_appends_no_loss(tmp_path):
    path = inline_sidecar_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    def worker(pid):
        append_inline_candidates(path, [mk_cand(pid=pid)], flow_id="f1",
                                 step_id="s1", turn=1, project="p")

    threads = [threading.Thread(target=worker, args=(f"p{i}",)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    rows = _rows(path)
    assert {r["predicate_id"] for r in rows} == {f"p{i}" for i in range(8)}
    assert len(rows) == 8
