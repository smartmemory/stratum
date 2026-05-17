"""STRAT-JUDGE-POSTMORTEM v2.2 #4 — replay harness."""

from __future__ import annotations

import json

from stratum.judge.postmortem.replay import (
    _holdout,
    replay_candidate,
    run_replay,
    score,
)


class _FakeJudge:
    """Returns a fixed verdict for every predicate."""

    def __init__(self, verdict="met", conf=0.9):
        self._v, self._c = verdict, conf

    def judge(self, statement, request_text, claim_text, work_summary):
        return self._v, self._c, "fake"


class _FakeDecomposer:
    def __init__(self, preds):
        self._preds = preds

    def decompose(self, request_text, work_summary):
        from stratum.judge.postmortem.decompose import DecomposeResult
        return DecomposeResult(predicates=list(self._preds),
                               applied=bool(self._preds))


def _P(pid, typ, stmt):
    from stratum.judge.result import Predicate
    return Predicate(id=pid, type=typ, statement=stmt, applied_gate=7)


def _rec(cid, label, preds=None, tools=("Edit",)):
    r = {
        "candidate_id": cid,
        "label": label,
        "request_text": "do the thing",
        "claim_text": "Done. The thing is done.",
        "work_tool_uses": [{"name": t, "line": 1} for t in tools],
        "post_claim_events": [],
    }
    if preds is not None:
        r["predicates"] = preds
    return r


# --- holdout -----------------------------------------------------------------

def test_holdout_deterministic_and_process_stable():
    a = _holdout("alpha:L1")
    assert a == _holdout("alpha:L1")  # stable across calls (sha1, not hash())
    # roughly 1-in-5 over a spread of ids
    n = sum(_holdout(f"c{i}:L{i}") for i in range(200))
    assert 20 <= n <= 60


# --- routing / tiers ---------------------------------------------------------

def test_deterministic_tool_predicate_is_T1():
    rec = _rec("c1", "true_met", tools=("Edit",))
    res = replay_candidate(rec, _FakeJudge("not_met"),
                           _FakeDecomposer([_P("p1", "deterministic", "the Edit tool ran")]))
    pr = res.predicate_results[0]
    assert pr.deciding_tier == "T1" and pr.verdict == "met"  # tool present, judge NOT consulted


def test_t1_respects_moment_of_claim_not_post_claim_tools():
    """A 'did Bash run' predicate must NOT be met from post-claim Bash
    activity — that's evidence the agent didn't have at claim time."""
    rec = _rec("cmoc", "true_met", tools=("Edit",))  # Bash only AFTER claim
    rec["post_claim_events"] = [{"kind": "tool_use", "tool_name": "Bash"}]
    res = replay_candidate(rec, _FakeJudge("met"),
                           _FakeDecomposer([_P("p1", "deterministic", "the Bash tool ran")]))
    pr = res.predicate_results[0]
    assert pr.deciding_tier == "T1" and pr.verdict == "not_met"  # not credited from post-claim


def test_deterministic_needs_fs_is_unreplayable():
    rec = _rec("c2", "true_met")
    res = replay_candidate(rec, _FakeJudge(),
                           _FakeDecomposer([_P("p1", "deterministic", "the migration row count equals 42")]))
    assert res.predicate_results[0].deciding_tier == "unreplayable"
    assert res.scored is False and res.reason == "all_unreplayable"


def test_verified_with_transcript_evidence_is_T2_not_T1():
    rec = _rec("c3", "true_met", tools=("Bash",))
    rec["post_claim_events"] = [{"kind": "tool_result", "text": "12 passed"}]
    res = replay_candidate(rec, _FakeJudge("met"),
                           _FakeDecomposer([_P("p1", "verified", "the tests pass")]))
    pr = res.predicate_results[0]
    assert pr.deciding_tier == "T2"  # decided by judge, never relabelled T1


def test_verified_without_transcript_evidence_is_unreplayable():
    rec = _rec("c3b", "true_met", tools=("Bash",))  # no post_claim tool_result
    res = replay_candidate(rec, _FakeJudge("met"),
                           _FakeDecomposer([_P("p1", "verified", "the tests pass")]))
    assert res.predicate_results[0].deciding_tier == "unreplayable"
    assert res.scored is False and res.reason == "all_unreplayable"


# --- empty predicates --------------------------------------------------------

def test_zero_predicates_is_unscorable_never_true_met():
    rec = _rec("c4", "false_met")
    res = replay_candidate(rec, _FakeJudge("met"), _FakeDecomposer([]))
    assert res.scored is False
    assert res.reason == "no_predicates"
    assert res.predicted_label is None  # NOT 'true_met' from all([])


# --- scoring -----------------------------------------------------------------

def test_false_met_counted():
    # ground says false_met; judge says everything met → predicted true_met → false-met error
    rec = _rec("c5", "false_met", preds=[{"id": "p1", "type": "judged", "statement": "s"}])
    res = replay_candidate(rec, _FakeJudge("met"), _FakeDecomposer([]))
    sc = score([res])
    assert sc.false_met == 1 and sc.false_not_met == 0 and sc.n_scored == 1


def test_false_not_met_counted():
    rec = _rec("c6", "true_met", preds=[{"id": "p1", "type": "judged", "statement": "s"}])
    res = replay_candidate(rec, _FakeJudge("not_met"), _FakeDecomposer([]))
    sc = score([res])
    assert sc.false_not_met == 1 and sc.false_met == 0


def test_abstention_excluded_from_precision():
    # mixed verdicts → predicted ambiguous → abstention, not error/pass
    rec = _rec("c7", "true_met", preds=[
        {"id": "p1", "type": "judged", "statement": "a"},
        {"id": "p2", "type": "judged", "statement": "b"},
    ])

    class Mixed:
        def __init__(self):
            self.n = 0

        def judge(self, *a, **k):
            self.n += 1
            return ("met", 0.9, "x") if self.n == 1 else ("ambiguous", 0.3, "y")

    res = replay_candidate(rec, Mixed(), _FakeDecomposer([]))
    sc = score([res])
    assert sc.n_abstained == 1 and sc.n_scored == 0
    assert sc.coverage == 0.0  # no scored, all abstained


def test_ambiguous_ground_excluded():
    rec = _rec("c8", "ambiguous", preds=[{"id": "p1", "type": "judged", "statement": "s"}])
    sc = score([replay_candidate(rec, _FakeJudge("met"), _FakeDecomposer([]))])
    assert sc.n_scored == 0 and sc.false_met == 0


def test_holdout_caveat_present_when_small():
    recs = [_rec(f"c{i}", "true_met", preds=[{"id": "p1", "type": "judged", "statement": "s"}])
            for i in range(3)]
    results = [replay_candidate(r, _FakeJudge("met"), _FakeDecomposer([])) for r in recs]
    sc = score(results)
    assert "smoke coverage only" in sc.holdout_caveat


# --- end-to-end --------------------------------------------------------------

def test_run_replay_writes_scorecard(tmp_path):
    corpus = tmp_path / "candidates.jsonl"
    corpus.write_text("\n".join(json.dumps(r) for r in [
        _rec("e1", "false_met", preds=[{"id": "p1", "type": "judged", "statement": "s"}]),
        _rec("e2", "true_met", preds=[{"id": "p1", "type": "judged", "statement": "s"}]),
        _rec("e3", "ambiguous", preds=[{"id": "p1", "type": "judged", "statement": "s"}]),
    ]))
    sc = run_replay(corpus, _FakeJudge("met"), _FakeDecomposer([]))
    assert sc.n_candidates == 3
    assert sc.schema_version == "1.0"
    out = corpus.parent / "replay-scorecard.json"
    assert out.exists()
    blob = json.loads(out.read_text())
    assert "scorecard" in blob and "candidates" in blob
    assert blob["scorecard"]["false_met"] == 1  # e1: ground false_met, judge all-met
