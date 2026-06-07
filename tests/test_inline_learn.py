"""STRAT-LEARN-INLINE — S1 pure classify + emit tests."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest

from stratum.judge.inline_learn import (
    DEFAULT_MEMORY_PATH,
    InlineLearnConfig,
    PatchCandidate,
    build_candidate,
    classify_fix_target,
    emit_candidates,
)
from stratum.judge.result import JudgeResult, PredicateResult, TierRecord


def mk_pr(ptype, verdict="not_met", reason="", conf=8, pid="p1",
          stmt="the error message is actionable"):
    return PredicateResult(
        id=pid, type=ptype, statement=stmt, verdict=verdict,
        confidence=conf, applied_gate=7, evidence=[],
        tier_history=[TierRecord(tier="T2", verdict=verdict,
                                 confidence=conf, reason=reason)],
    )


def mk_result(predicates, met=False):
    return JudgeResult(
        clean=met, summary="s", findings=[], meta={}, met=met,
        predicates=predicates,
    )


# --- classify_fix_target ----------------------------------------------------

@pytest.mark.parametrize("ptype,reason,expected", [
    ("judged", "too vague", "durable"),
    ("verified", "tests failed", "step-local"),
    ("deterministic", "ensure raised: TimeoutError", "transient"),
    ("deterministic", "exit code 1; file missing", "step-local"),
    ("judged", "", "durable"),
])
def test_classify_table(ptype, reason, expected):
    assert classify_fix_target(mk_pr(ptype, reason=reason)) == expected


# --- build_candidate --------------------------------------------------------

def test_build_candidate_defaults_to_memory_note():
    cand = build_candidate(mk_pr("judged", reason="not specific enough"))
    assert isinstance(cand, PatchCandidate)
    assert cand.target_kind == "memory"
    assert cand.target_path == DEFAULT_MEMORY_PATH == ".claude/memory/MEMORY.md"
    assert cand.patch_type == "edit"
    assert cand.fix_target == "durable"
    # described intent only — no literal old->new diff fields
    d = cand.to_dict()
    assert "old_string" not in d and "new_string" not in d
    assert "suggested_change" in d and d["suggested_change"]


def test_build_candidate_skill_target_when_finding_names_skill():
    pr = mk_pr("judged", stmt="the stratum-debug skill should cite evidence")
    cand = build_candidate(pr)
    assert cand.target_kind == "skill"
    assert cand.target_path.endswith("SKILL.md")


# --- emit_candidates --------------------------------------------------------

@pytest.mark.asyncio
async def test_emit_disabled_returns_empty():
    res = mk_result([mk_pr("judged")])
    assert await emit_candidates(res, InlineLearnConfig(enabled=False)) == []


@pytest.mark.asyncio
async def test_emit_only_durable_not_met():
    res = mk_result([
        mk_pr("judged", verdict="not_met", pid="p1"),     # durable -> candidate
        mk_pr("verified", verdict="not_met", pid="p2"),   # step-local -> none
        mk_pr("judged", verdict="met", pid="p3"),         # not must-fix -> skip
    ])
    cands = await emit_candidates(res, InlineLearnConfig(enabled=True))
    assert [c.predicate_id for c in cands] == ["p1"]


@pytest.mark.asyncio
async def test_emit_llm_classifier_fail_open_to_heuristic():
    async def boom(**kwargs):
        raise RuntimeError("llm down")

    res = mk_result([mk_pr("judged", verdict="not_met", pid="p1")])
    cfg = InlineLearnConfig(enabled=True, classifier="llm")
    cands = await emit_candidates(res, cfg, agent_run=boom)
    # heuristic fallback still classifies judged -> durable
    assert [c.predicate_id for c in cands] == ["p1"]


@pytest.mark.asyncio
async def test_emit_llm_classifier_honors_response():
    async def says_steplocal(**kwargs):
        return {"text": "step-local"}

    res = mk_result([mk_pr("judged", verdict="not_met", pid="p1")])
    cfg = InlineLearnConfig(enabled=True, classifier="llm")
    cands = await emit_candidates(res, cfg, agent_run=says_steplocal)
    assert cands == []  # LLM overrode heuristic durable -> step-local
