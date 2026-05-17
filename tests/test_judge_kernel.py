"""Tests for stratum.judge.kernel — end-to-end orchestration."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum.judge import staging as staging_mod
from stratum.judge.errors import (
    BudgetExceededError,
    EmptyPredicateListError,
    StakesPredicateMismatchError,
)
from stratum.judge.kernel import (
    _build_summary,
    _findings_from_predicates,
    _next_turn_index,
    run_judge,
)
from stratum.judge.result import (
    BudgetCaps,
    Evidence,
    Predicate,
    PredicateResult,
    TierRecord,
)


@pytest.fixture
def isolated_judge_root(tmp_path, monkeypatch):
    root = tmp_path / "judge"
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", root)
    return root


@pytest.fixture
def workspace(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


def _t2_resp(verdict="met", confidence=9, predicate_id="p", evidence=None, reason="ok"):
    return json.dumps({
        "predicate_id": predicate_id,
        "verdict": verdict,
        "confidence": confidence,
        "reason": reason,
        "evidence": evidence or [],
    })


# ---------------------------------------------------------------------------
# Input validation.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_predicates_raises(isolated_judge_root, workspace):
    with pytest.raises(EmptyPredicateListError):
        await run_judge(
            flow_id="F", step_id="S", predicates=[],
            artifacts={}, modified_files=[], stakes="default",
            budget=None, workspace_root=workspace,
            stratum_agent_run=AsyncMock(), ctx=None,
        )


@pytest.mark.asyncio
async def test_paranoid_stakes_accepted(isolated_judge_root, workspace):
    """STRAT-JUDGE v2 slice 1: paranoid no longer raises. A deterministic
    predicate is T1-terminal, so T3 is never reached and no agent runs —
    the point here is purely that paranoid is now an accepted stakes."""
    p = Predicate(id="d", type="deterministic", statement="True")
    res = await run_judge(
        flow_id="F", step_id="S", predicates=[p],
        artifacts={}, modified_files=[], stakes="paranoid",
        budget=None, workspace_root=workspace,
        stratum_agent_run=AsyncMock(), ctx=None,
    )
    assert res.stakes == "paranoid"


@pytest.mark.asyncio
async def test_cheap_stakes_rejects_nondet(isolated_judge_root, workspace):
    p = Predicate(id="v", type="verified", statement="anything")
    with pytest.raises(StakesPredicateMismatchError):
        await run_judge(
            flow_id="F", step_id="S", predicates=[p],
            artifacts={}, modified_files=[], stakes="cheap",
            budget=None, workspace_root=workspace,
            stratum_agent_run=AsyncMock(), ctx=None,
        )


# ---------------------------------------------------------------------------
# Golden flows.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_all_predicates_met_t1_only(isolated_judge_root, workspace):
    preds = [
        Predicate(id="d1", type="deterministic", statement="len('abc') == 3"),
        Predicate(id="d2", type="deterministic", statement="max(1,2) == 2"),
    ]
    result = await run_judge(
        flow_id="F1", step_id="S1", predicates=preds,
        artifacts={"x": "hello"}, modified_files=[],
        stakes="default", budget=None,
        workspace_root=workspace, stratum_agent_run=AsyncMock(), ctx=None,
    )
    assert result.met is True
    assert result.clean is True
    assert result.findings == []
    assert result.meta["agent_type"] == "judge"
    assert result.meta["model_id"] is None
    assert len(result.predicates) == 2
    for pr in result.predicates:
        assert pr.verdict == "met"


@pytest.mark.asyncio
async def test_mixed_predicates_one_not_met(isolated_judge_root, workspace):
    preds = [
        Predicate(id="d1", type="deterministic", statement="len('abc') == 3"),
        Predicate(id="v1", type="verified", statement="tests pass"),
        Predicate(id="v2", type="verified", statement="no leaks"),
    ]
    fake_run = AsyncMock(side_effect=[
        _t2_resp(predicate_id="v1", verdict="met", confidence=9),
        _t2_resp(predicate_id="v2", verdict="not_met", confidence=10, reason="leak found"),
    ])
    result = await run_judge(
        flow_id="F2", step_id="S2", predicates=preds,
        artifacts={"out": "stuff"}, modified_files=[],
        stakes="default", budget=None,
        workspace_root=workspace, stratum_agent_run=fake_run, ctx=None,
    )
    assert result.met is False
    assert result.clean is False
    must_fix = [f for f in result.findings if f["severity"] == "must-fix"]
    assert len(must_fix) == 1
    assert must_fix[0]["lens"] == "judge"
    # T2 ran → meta.agent_type=claude.
    assert result.meta["agent_type"] == "claude"
    assert result.meta["model_id"] == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_ambiguous_when_confidence_below_gate(isolated_judge_root, workspace):
    """T2 returns met@5 against applied_gate=7 → downgrade to ambiguous."""
    preds = [
        Predicate(id="v1", type="verified", statement="x", applied_gate=7),
    ]
    fake_run = AsyncMock(return_value=_t2_resp(predicate_id="v1", verdict="met", confidence=5))
    result = await run_judge(
        flow_id="F3", step_id="S3", predicates=preds,
        artifacts={}, modified_files=[],
        stakes="default", budget=None,
        workspace_root=workspace, stratum_agent_run=fake_run, ctx=None,
    )
    assert result.met is False
    assert result.predicates[0].verdict == "ambiguous"
    assert any(f["severity"] == "should-fix" for f in result.findings)


# ---------------------------------------------------------------------------
# Budget enforcement.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_turn_budget_rejects_at_entry(isolated_judge_root, workspace, monkeypatch):
    """If prospective turn > max_turns, raise before any staging."""
    monkeypatch.setattr(
        "stratum.judge.kernel._next_turn_index",
        lambda flow_id, step_id: 5,
    )
    p = Predicate(id="d", type="deterministic", statement="True")
    with pytest.raises(BudgetExceededError):
        await run_judge(
            flow_id="F", step_id="S", predicates=[p],
            artifacts={}, modified_files=[],
            stakes="default",
            budget=BudgetCaps(max_turns=3),
            workspace_root=workspace, stratum_agent_run=AsyncMock(), ctx=None,
        )
    # Nothing was staged.
    assert not (isolated_judge_root / "F").exists()


@pytest.mark.asyncio
async def test_wall_clock_budget_enforced_per_predicate(isolated_judge_root, workspace, monkeypatch):
    """Force elapsed > cap after first predicate via monkeypatched time."""
    import stratum.judge.kernel as kernel_mod
    ticks = iter([1000.0, 1000.0, 1010.0])   # start, after p1, after p2
    monkeypatch.setattr(kernel_mod.time, "time", lambda: next(ticks))
    preds = [
        Predicate(id="d1", type="deterministic", statement="True"),
        Predicate(id="d2", type="deterministic", statement="True"),
    ]
    with pytest.raises(BudgetExceededError):
        await run_judge(
            flow_id="Fw", step_id="Sw", predicates=preds,
            artifacts={}, modified_files=[],
            stakes="default",
            budget=BudgetCaps(max_wall_clock_s=1.0),
            workspace_root=workspace, stratum_agent_run=AsyncMock(), ctx=None,
        )


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------


def test_findings_from_predicates_severity_mapping():
    prs = [
        PredicateResult(
            id="a", type="deterministic", statement="s", verdict="met",
            confidence=10, applied_gate=7, evidence=[],
            tier_history=[TierRecord(tier="T1", verdict="met", confidence=10, reason="")],
        ),
        PredicateResult(
            id="b", type="verified", statement="s", verdict="not_met",
            confidence=10, applied_gate=7, evidence=[],
            tier_history=[TierRecord(tier="T2", verdict="not_met", confidence=10, reason="bad")],
        ),
        PredicateResult(
            id="c", type="verified", statement="s", verdict="ambiguous",
            confidence=5, applied_gate=7, evidence=[],
            tier_history=[TierRecord(tier="T2", verdict="met", confidence=5, reason="meh")],
        ),
    ]
    findings = _findings_from_predicates(prs)
    assert len(findings) == 2
    by_id_severity = {(f["severity"]) for f in findings}
    assert by_id_severity == {"must-fix", "should-fix"}
    for f in findings:
        assert f["lens"] == "judge"


def test_build_summary_includes_agent_type():
    pr = PredicateResult(
        id="a", type="deterministic", statement="s", verdict="met",
        confidence=10, applied_gate=7, evidence=[],
        tier_history=[TierRecord(tier="T1", verdict="met", confidence=10, reason="")],
    )
    s = _build_summary(met=True, prs=[pr], degraded=False, agent_type="judge")
    assert "judge" in s
    assert "1/1 predicates met" in s
    assert "degraded_judged=false" in s


def test_next_turn_index_no_flow_returns_one():
    """When stratum_mcp.executor is unavailable or no flow exists, return 1."""
    assert _next_turn_index("nonexistent-flow-id-xyz", "step") == 1
