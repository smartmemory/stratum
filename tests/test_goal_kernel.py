"""Tests for stratum.goal — Phase A foundations + Phase C orchestrator.

test_error_hierarchy: A1 errors
TestAutonomy: C1 autonomy
TestOrchestrator: C2 orchestrator mode matrix
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ---------------------------------------------------------------------------
# A1: Error hierarchy
# ---------------------------------------------------------------------------

class TestErrorHierarchy:
    def test_goal_error_is_base_exception(self):
        from stratum.goal.errors import GoalError
        assert issubclass(GoalError, Exception)

    def test_all_subclasses_inherit_goal_error(self):
        from stratum.goal.errors import (
            GoalError,
            GoalImmutabilityError,
            GoalNotFoundError,
            WorkerTypeNotSupportedError,
            NoPendingDecisionError,
            ArtifactExtractionError,
        )
        for cls in [
            GoalImmutabilityError,
            GoalNotFoundError,
            WorkerTypeNotSupportedError,
            NoPendingDecisionError,
            ArtifactExtractionError,
        ]:
            assert issubclass(cls, GoalError), f"{cls.__name__} must inherit GoalError"

    def test_each_subclass_is_catchable_as_goal_error(self):
        from stratum.goal.errors import (
            GoalError,
            GoalImmutabilityError,
            GoalNotFoundError,
            WorkerTypeNotSupportedError,
            NoPendingDecisionError,
            ArtifactExtractionError,
        )
        for cls in [
            GoalImmutabilityError,
            GoalNotFoundError,
            WorkerTypeNotSupportedError,
            NoPendingDecisionError,
            ArtifactExtractionError,
        ]:
            instance = cls("test message")
            assert isinstance(instance, GoalError)
            assert isinstance(instance, Exception)

    def test_star_import_exports_all_errors(self):
        """from stratum.goal.errors import * must surface all 6 error classes."""
        import importlib
        mod = importlib.import_module("stratum.goal.errors")
        names = dir(mod)
        expected = [
            "GoalError",
            "GoalImmutabilityError",
            "GoalNotFoundError",
            "WorkerTypeNotSupportedError",
            "NoPendingDecisionError",
            "ArtifactExtractionError",
        ]
        for name in expected:
            assert name in names, f"{name} not exported from stratum.goal.errors"

    def test_error_messages_are_preserved(self):
        from stratum.goal.errors import (
            GoalImmutabilityError,
            WorkerTypeNotSupportedError,
        )
        e1 = GoalImmutabilityError("predicate hash mismatch")
        assert "predicate hash mismatch" in str(e1)

        e2 = WorkerTypeNotSupportedError("codex not supported in driven mode")
        assert "codex not supported" in str(e2)

    def test_distinct_classes_not_interchangeable(self):
        from stratum.goal.errors import (
            GoalImmutabilityError,
            GoalNotFoundError,
        )
        e = GoalImmutabilityError("x")
        assert not isinstance(e, GoalNotFoundError)


# alias for backward compat with plan.md test-id
test_error_hierarchy = TestErrorHierarchy


# ---------------------------------------------------------------------------
# C1: Autonomy module (TestAutonomy — plan.md cases a-f)
# ---------------------------------------------------------------------------

class TestAutonomy:
    """Tests for stratum.goal.autonomy.resolve_autonomy."""

    def setup_method(self):
        """Clear the in-process cache before each test."""
        from stratum.goal.autonomy import clear_autonomy_cache
        clear_autonomy_cache()

    @pytest.mark.asyncio
    async def test_a_caller_only_no_sm_returns_merged_map(self):
        """(a) caller_dict only, no SM → merged map with caller values."""
        from stratum.goal.autonomy import resolve_autonomy

        result = await resolve_autonomy(
            workspace_cwd="/workspace",
            caller_dict={"deterministic": True, "verified": False, "judged": False},
            smart_memory_search_callable=None,
        )
        assert result == {"deterministic": True, "verified": False, "judged": False}

    @pytest.mark.asyncio
    async def test_b_sm_only_returns_parsed_map(self):
        """(b) SM only, no caller_dict → parsed from SM results."""
        from stratum.goal.autonomy import resolve_autonomy

        async def fake_sm(**kwargs):
            return {
                "learned": [
                    {
                        "memory_type": "learned",
                        "metadata": {
                            "schema": "goal_autonomy_calibration.v1",
                            "deterministic": {"autonomous": True, "confirmed_count": 10},
                            "verified":      {"autonomous": False, "confirmed_count": 2},
                            "judged":        {"autonomous": False, "confirmed_count": 0},
                        },
                    }
                ]
            }

        result = await resolve_autonomy(
            workspace_cwd="/workspace",
            caller_dict=None,
            smart_memory_search_callable=fake_sm,
        )
        assert result == {"deterministic": True, "verified": False, "judged": False}

    @pytest.mark.asyncio
    async def test_c_caller_wins_over_sm_conflict(self):
        """(c) caller > SM: caller override wins when both specify a key."""
        from stratum.goal.autonomy import resolve_autonomy

        async def fake_sm(**kwargs):
            return {
                "learned": [
                    {
                        "metadata": {
                            "schema": "goal_autonomy_calibration.v1",
                            "deterministic": {"autonomous": False},
                            "verified":      {"autonomous": True},
                            "judged":        {"autonomous": False},
                        }
                    }
                ]
            }

        result = await resolve_autonomy(
            workspace_cwd="/workspace",
            caller_dict={"deterministic": True},  # overrides SM's False
            smart_memory_search_callable=fake_sm,
        )
        # caller wins on deterministic; SM wins on verified (True)
        assert result["deterministic"] is True
        assert result["verified"] is True
        assert result["judged"] is False

    @pytest.mark.asyncio
    async def test_d_sm_unavailable_falls_back_to_caller(self):
        """(d) SM raises → fall through to caller_dict."""
        from stratum.goal.autonomy import resolve_autonomy

        async def broken_sm(**kwargs):
            raise RuntimeError("SmartMemory unavailable")

        result = await resolve_autonomy(
            workspace_cwd="/workspace",
            caller_dict={"judged": True},
            smart_memory_search_callable=broken_sm,
        )
        assert result["judged"] is True
        assert result["deterministic"] is False
        assert result["verified"] is False

    @pytest.mark.asyncio
    async def test_e_sm_timeout_falls_back_to_default(self):
        """(e) SM hangs past 2s → falls back to all-False default (+ caller)."""
        from stratum.goal.autonomy import resolve_autonomy, _SM_TIMEOUT_S

        async def slow_sm(**kwargs):
            await asyncio.sleep(_SM_TIMEOUT_S + 1)
            return {}

        result = await resolve_autonomy(
            workspace_cwd="/slow-workspace",
            caller_dict=None,
            smart_memory_search_callable=slow_sm,
        )
        # All default False — SM timed out
        assert result == {"deterministic": False, "verified": False, "judged": False}

    @pytest.mark.asyncio
    async def test_f_sixty_second_cache_avoids_second_sm_call(self):
        """(f) 60s cache: second resolve_autonomy call skips SM."""
        from stratum.goal.autonomy import resolve_autonomy

        call_count = 0

        async def counting_sm(**kwargs):
            nonlocal call_count
            call_count += 1
            return {
                "learned": [
                    {
                        "metadata": {
                            "schema": "goal_autonomy_calibration.v1",
                            "deterministic": {"autonomous": True},
                            "verified":      {"autonomous": False},
                            "judged":        {"autonomous": False},
                        }
                    }
                ]
            }

        # First call
        r1 = await resolve_autonomy("/ws", None, smart_memory_search_callable=counting_sm)
        # Second call — same workspace and same callable
        r2 = await resolve_autonomy("/ws", None, smart_memory_search_callable=counting_sm)

        assert call_count == 1, "SM should only be called once; second hit should use cache"
        assert r1 == r2

    @pytest.mark.asyncio
    async def test_all_classes_default_false_when_no_sources(self):
        """Default: all three classes False when SM is None and caller_dict is None."""
        from stratum.goal.autonomy import resolve_autonomy

        result = await resolve_autonomy(
            workspace_cwd=None,
            caller_dict=None,
            smart_memory_search_callable=None,
        )
        assert result == {"deterministic": False, "verified": False, "judged": False}

    @pytest.mark.asyncio
    async def test_sm_wrong_schema_ignored(self):
        """SM results with wrong schema key are ignored; defaults apply."""
        from stratum.goal.autonomy import resolve_autonomy

        async def wrong_schema_sm(**kwargs):
            return {
                "learned": [
                    {
                        "metadata": {
                            "schema": "some_other_schema.v1",
                            "deterministic": {"autonomous": True},
                        }
                    }
                ]
            }

        result = await resolve_autonomy(
            workspace_cwd="/ws",
            caller_dict=None,
            smart_memory_search_callable=wrong_schema_sm,
        )
        assert result == {"deterministic": False, "verified": False, "judged": False}


# ---------------------------------------------------------------------------
# C2: Orchestrator mode matrix
# ---------------------------------------------------------------------------

def _make_judge_result(met: bool, predicate_ids: list[str] | None = None):
    """Build a minimal JudgeResult stub for testing."""
    from stratum.judge.result import (
        BudgetConsumed, JudgeKernelMeta, JudgeResult, Predicate,
        PredicateResult, TierRecord,
    )
    pids = predicate_ids or ["p1"]
    verdict = "met" if met else "not_met"
    preds = [
        PredicateResult(
            id=pid,
            type="deterministic",
            statement=f"predicate {pid}",
            verdict=verdict,
            confidence=9 if met else 3,
            applied_gate=7,
            evidence=[],
            tier_history=[
                TierRecord(tier="T1", verdict=verdict, confidence=9 if met else 3, reason="stub")
            ],
        )
        for pid in pids
    ]
    return JudgeResult(
        clean=met, met=met, summary="stub",
        findings=[] if met else [{"predicate_id": p, "verdict": verdict, "reason": "stub"} for p in pids],
        meta={"agent_type": "judge", "model_id": "stub"},
        stakes="default",
        predicates=preds,
        budget_consumed=BudgetConsumed(turns=1),
        judge_kernel_meta=JudgeKernelMeta(),
    )


def _make_predicates(ids: list[str] | None = None, pred_type: str = "deterministic"):
    from stratum.judge.result import Predicate
    pids = ids or ["p1"]
    return [Predicate(id=pid, type=pred_type, statement=f"stmt {pid}", applied_gate=7) for pid in pids]


class TestOrchestrator:
    """Comprehensive mode matrix for C2 run_goal.

    Matrix: {shadow-driven, shadow-observed, advisory, autonomous}
         × {worker-met-judge-met, worker-success-judge-not-met,
            worker-failure-then-success, all-worker-failures,
            budget-exhausted}
    """

    # ------------------------------------------------------------------
    # Shadow-driven
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_shadow_driven_worker_met_judge_met(self, tmp_path):
        """shadow-driven: judge met on turn 1 → would_have_decided='met'."""
        from stratum.goal.orchestrator import run_goal

        judge_result = _make_judge_result(met=True)
        predicates = _make_predicates()

        worker_call_count = 0

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal worker_call_count
            worker_call_count += 1
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return judge_result

        async def fake_gate_resolve(**kwargs):
            return {}

        result = await run_goal(
            goal_id="test-shadow-met",
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=fake_gate_resolve,
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 5},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "met"
        assert result.would_have_decided == "met"
        assert result.turns_run >= 1

    @pytest.mark.asyncio
    async def test_shadow_driven_judge_not_met_then_budget_exhausted(self, tmp_path):
        """shadow-driven: judge never met → budget_exhausted with would_have_decided='not_met'."""
        from stratum.goal.orchestrator import run_goal

        judge_result = _make_judge_result(met=False)
        predicates = _make_predicates()

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return judge_result

        result = await run_goal(
            goal_id="test-shadow-not-met",
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 2},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "budget_exhausted"
        assert result.would_have_decided == "not_met"

    @pytest.mark.asyncio
    async def test_shadow_driven_zero_turns_no_would_have_decided(self, tmp_path):
        """shadow-driven, all worker failures: would_have_decided omitted (PRD M5)."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()
        call_count = 0

        async def always_failing_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal call_count
            call_count += 1
            raise RuntimeError("worker down")

        result = await run_goal(
            goal_id="test-shadow-zero-turns",
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=always_failing_worker,
            run_judge_callable=AsyncMock(),
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 3, "max_worker_failures": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "budget_exhausted"
        assert result.would_have_decided is None  # no turns ran (PRD M5)

    # ------------------------------------------------------------------
    # Shadow-observed
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_shadow_observed_skips_worker(self, tmp_path):
        """shadow-observed: worker is never dispatched; judge runs on observed_artifacts."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()
        worker_dispatched = False

        async def spy_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal worker_dispatched
            worker_dispatched = True
            return ("", "cid")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=True)

        result = await run_goal(
            goal_id="test-shadow-observed",
            predicates=predicates,
            mode="shadow",
            shadow_source="observed",
            dispatch_worker_callable=spy_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt=None,
            artifact_contract=None,
            observed_artifacts={"artifact1": "content"},
            observed_modified_files=[],
            budget={"max_turns": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert not worker_dispatched, "shadow-observed must never dispatch the worker"
        assert result.would_have_decided == "met"

    # ------------------------------------------------------------------
    # Advisory
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_advisory_met_returns_awaiting_decision(self, tmp_path):
        """advisory: judge met → status=awaiting_decision (human gate required)."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=True)

        gate_resolve_calls = []

        async def fake_gate_resolve(**kwargs):
            gate_resolve_calls.append(kwargs)
            return {}

        result = await run_goal(
            goal_id="test-advisory-awaiting",
            predicates=predicates,
            mode="advisory",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=fake_gate_resolve,
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 5},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "awaiting_decision"
        # Advisory mode does NOT auto-approve; gate resolve should NOT be called
        assert len(gate_resolve_calls) == 0

    @pytest.mark.asyncio
    async def test_advisory_not_met_loops_then_budget_exhausted(self, tmp_path):
        """advisory: judge never met → loops until budget_exhausted."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()
        turn_count = 0

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal turn_count
            turn_count += 1
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=False)

        result = await run_goal(
            goal_id="test-advisory-budget",
            predicates=predicates,
            mode="advisory",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "budget_exhausted"
        assert turn_count == 3

    # ------------------------------------------------------------------
    # Autonomous
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    async def test_autonomous_all_auto_bind(self, tmp_path):
        """autonomous: all predicates whitelisted → auto-approve, status=met."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=True)

        gate_calls = []

        async def fake_gate_resolve(**kwargs):
            gate_calls.append(kwargs)
            return {}

        result = await run_goal(
            goal_id="test-autonomous-auto",
            predicates=predicates,
            mode="autonomous",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=fake_gate_resolve,
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            autonomy={"deterministic": True, "verified": True, "judged": True},
            budget={"max_turns": 5},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "met"
        # Autonomous auto-approve: gate_resolve was called with outcome="approve"
        assert any(c.get("outcome") == "approve" for c in gate_calls)

    @pytest.mark.asyncio
    async def test_autonomous_mixed_mode_awaits_human(self, tmp_path):
        """autonomous: some classes not whitelisted → awaiting_decision."""
        from stratum.goal.orchestrator import run_goal

        # Two predicates: one deterministic (whitelisted), one judged (not)
        from stratum.judge.result import Predicate
        predicates = [
            Predicate(id="p-det", type="deterministic", statement="det pred", applied_gate=7),
            Predicate(id="p-jud", type="judged", statement="judged pred", applied_gate=7),
        ]

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            from stratum.judge.result import (
                BudgetConsumed, JudgeKernelMeta, JudgeResult, PredicateResult, TierRecord,
            )
            preds = [
                PredicateResult(
                    id="p-det", type="deterministic", statement="det", verdict="met",
                    confidence=9, applied_gate=7, evidence=[],
                    tier_history=[TierRecord("T1", "met", 9, "ok")],
                ),
                PredicateResult(
                    id="p-jud", type="judged", statement="jud", verdict="met",
                    confidence=9, applied_gate=7, evidence=[],
                    tier_history=[TierRecord("T2", "met", 9, "ok")],
                ),
            ]
            return JudgeResult(
                clean=True, met=True, summary="all met",
                findings=[], meta={"agent_type": "judge", "model_id": "stub"},
                stakes="default", predicates=preds,
                budget_consumed=BudgetConsumed(turns=1),
                judge_kernel_meta=JudgeKernelMeta(),
            )

        gate_calls = []

        async def fake_gate_resolve(**kwargs):
            gate_calls.append(kwargs)
            return {}

        result = await run_goal(
            goal_id="test-autonomous-mixed",
            predicates=predicates,
            mode="autonomous",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=fake_gate_resolve,
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            # Only deterministic is whitelisted; judged is not
            autonomy={"deterministic": True, "verified": False, "judged": False},
            budget={"max_turns": 5},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "awaiting_decision"
        # No auto-approve since mixed mode
        assert not any(c.get("outcome") == "approve" for c in gate_calls)

    @pytest.mark.asyncio
    async def test_autonomous_budget_exhausted(self, tmp_path):
        """autonomous: budget exhausted without met → budget_exhausted."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=False)

        result = await run_goal(
            goal_id="test-autonomous-budget",
            predicates=predicates,
            mode="autonomous",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            autonomy={"deterministic": True},
            budget={"max_turns": 2},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "budget_exhausted"

    @pytest.mark.asyncio
    async def test_worker_failure_then_success(self, tmp_path):
        """Worker fails twice then succeeds → goal continues and judge runs."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates()
        attempt = 0

        async def flaky_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal attempt
            attempt += 1
            if attempt <= 2:
                raise RuntimeError(f"worker failed attempt {attempt}")
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        judge_count = 0

        async def fake_judge(**kwargs):
            nonlocal judge_count
            judge_count += 1
            return _make_judge_result(met=True)

        result = await run_goal(
            goal_id="test-flaky-worker",
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=flaky_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 5, "max_worker_failures": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "met"
        assert judge_count == 1

    @pytest.mark.asyncio
    async def test_predicate_outcomes_populated(self, tmp_path):
        """GoalResult.predicate_outcomes contains one entry per predicate."""
        from stratum.goal.orchestrator import run_goal

        predicates = _make_predicates(["p1", "p2"])

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        async def fake_judge(**kwargs):
            return _make_judge_result(met=True, predicate_ids=["p1", "p2"])

        result = await run_goal(
            goal_id="test-outcomes",
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=fake_judge,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        assert len(result.predicate_outcomes) == 2
        ids = {po.id for po in result.predicate_outcomes}
        assert ids == {"p1", "p2"}

    @pytest.mark.asyncio
    async def test_immutability_check_on_resume(self, tmp_path):
        """Resuming with different predicates raises GoalImmutabilityError."""
        from stratum.goal.orchestrator import run_goal
        from stratum.goal.errors import GoalImmutabilityError

        predicates_v1 = _make_predicates(["p1"])
        predicates_v2 = _make_predicates(["p1", "p2"])  # different

        async def fake_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", "cid-1")

        # First call — establish state
        await run_goal(
            goal_id="test-immutable",
            predicates=predicates_v1,
            mode="advisory",
            shadow_source="driven",
            dispatch_worker_callable=fake_worker,
            run_judge_callable=AsyncMock(return_value=_make_judge_result(met=False)),
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="do the task",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 1},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )

        # Second call with different predicates — must raise
        with pytest.raises(GoalImmutabilityError):
            await run_goal(
                goal_id="test-immutable",
                predicates=predicates_v2,
                mode="advisory",
                shadow_source="driven",
                dispatch_worker_callable=fake_worker,
                run_judge_callable=AsyncMock(return_value=_make_judge_result(met=False)),
                stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
                stratum_gate_resolve_callable=AsyncMock(return_value={}),
                smart_memory_search_callable=None,
                ctx=None,
                prompt="do the task",
                artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
                budget={"max_turns": 1},
                goal_state_root=tmp_path / "goal",
                flow_state_root=tmp_path / "flows",
            )


# ---------------------------------------------------------------------------
# Finding 1 regression: dispatch_worker_callable call shape (server wiring)
# ---------------------------------------------------------------------------

class TestDispatchWorkerCallableWiring:
    """Finding 1: verify the orchestrator's call shape matches dispatch_worker signature.

    The orchestrator calls: dispatch_worker_callable(prompt, worker_spec, corr_id, ctx=ctx)
    dispatch_worker has signature: (stratum_agent_run_callable, prompt, worker_spec, corr_id, *, ctx)

    The fix binds stratum_agent_run via functools.partial so the resulting
    partial's first positional arg is prompt (not stratum_agent_run_callable).
    """

    @pytest.mark.asyncio
    async def test_partial_wired_callable_accepts_orchestrator_call_shape(self):
        """functools.partial(dispatch_worker, mock_sar) accepts (prompt, ws, cid, ctx=ctx)."""
        import functools
        from stratum.goal.worker import dispatch_worker
        from unittest.mock import AsyncMock

        mock_sar = AsyncMock(return_value={"text": "hello", "correlation_id": "c1"})
        wired = functools.partial(dispatch_worker, mock_sar)

        text, cid = await wired("my prompt", {"type": "claude"}, "c1", ctx=None)
        assert text == "hello"
        assert cid == "c1"
        # stratum_agent_run (mock_sar) was called with the correct kwargs
        assert mock_sar.called
        call_kwargs = mock_sar.call_args.kwargs
        assert call_kwargs.get("prompt") == "my prompt"

    @pytest.mark.asyncio
    async def test_partial_passes_through_worker_spec_fields(self):
        """Worker spec fields are forwarded verbatim by the partial-wired callable."""
        import functools
        from stratum.goal.worker import dispatch_worker
        from unittest.mock import AsyncMock

        captured: dict = {}

        async def mock_sar(**kwargs):
            captured.update(kwargs)
            return {"text": "out", "correlation_id": "cid"}

        wired = functools.partial(dispatch_worker, mock_sar)
        await wired(
            "prompt text",
            {"type": "claude", "model_id": "claude-sonnet-4-6", "cwd": "/ws"},
            "cid",
            ctx=None,
        )
        assert captured.get("model_id") == "claude-sonnet-4-6"
        assert captured.get("cwd") == "/ws"


# ---------------------------------------------------------------------------
# Finding 5 regression: validate_worker_spec called in run_goal
# ---------------------------------------------------------------------------

class TestValidateWorkerSpecEnforced:
    """Finding 5: run_goal must call validate_worker_spec and raise on codex + driven mode."""

    @pytest.mark.asyncio
    async def test_codex_advisory_raises_worker_type_not_supported(self, tmp_path):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.orchestrator import run_goal
        from stratum.judge.result import Predicate
        from unittest.mock import AsyncMock

        p = Predicate(id="p1", type="deterministic", statement="true", applied_gate=7)
        with pytest.raises(WorkerTypeNotSupportedError):
            await run_goal(
                goal_id="validate-codex-advisory",
                predicates=[p],
                mode="advisory",
                shadow_source="driven",
                worker_spec={"type": "codex"},
                dispatch_worker_callable=AsyncMock(return_value=("text", "cid")),
                run_judge_callable=AsyncMock(),
                stratum_agent_run_callable=AsyncMock(),
                stratum_gate_resolve_callable=AsyncMock(),
                ctx=None,
                budget={"max_turns": 1},
                goal_state_root=tmp_path / "goal",
                flow_state_root=tmp_path / "flows",
            )

    @pytest.mark.asyncio
    async def test_codex_autonomous_raises_worker_type_not_supported(self, tmp_path):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.orchestrator import run_goal
        from stratum.judge.result import Predicate
        from unittest.mock import AsyncMock

        p = Predicate(id="p1", type="deterministic", statement="true", applied_gate=7)
        with pytest.raises(WorkerTypeNotSupportedError):
            await run_goal(
                goal_id="validate-codex-autonomous",
                predicates=[p],
                mode="autonomous",
                shadow_source="driven",
                worker_spec={"type": "codex"},
                dispatch_worker_callable=AsyncMock(return_value=("text", "cid")),
                run_judge_callable=AsyncMock(),
                stratum_agent_run_callable=AsyncMock(),
                stratum_gate_resolve_callable=AsyncMock(),
                ctx=None,
                budget={"max_turns": 1},
                goal_state_root=tmp_path / "goal",
                flow_state_root=tmp_path / "flows",
            )

    @pytest.mark.asyncio
    async def test_codex_shadow_driven_raises_worker_type_not_supported(self, tmp_path):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.orchestrator import run_goal
        from stratum.judge.result import Predicate
        from unittest.mock import AsyncMock

        p = Predicate(id="p1", type="deterministic", statement="true", applied_gate=7)
        with pytest.raises(WorkerTypeNotSupportedError):
            await run_goal(
                goal_id="validate-codex-shadow-driven",
                predicates=[p],
                mode="shadow",
                shadow_source="driven",
                worker_spec={"type": "codex"},
                dispatch_worker_callable=AsyncMock(return_value=("text", "cid")),
                run_judge_callable=AsyncMock(),
                stratum_agent_run_callable=AsyncMock(),
                stratum_gate_resolve_callable=AsyncMock(),
                ctx=None,
                budget={"max_turns": 1},
                goal_state_root=tmp_path / "goal",
                flow_state_root=tmp_path / "flows",
            )


# ---------------------------------------------------------------------------
# Finding 6 regression: shadow-observed status derived from judge verdict
# ---------------------------------------------------------------------------

class TestShadowObservedStatusDerivedFromJudge:
    """Finding 6: _observed_shadow_path must map status from judge, not hardcode 'met'."""

    @pytest.mark.asyncio
    async def test_shadow_observed_not_met_returns_not_met_status(self, tmp_path):
        """When judge says not met, shadow-observed should return status='not_met'."""
        from stratum.goal.orchestrator import run_goal
        from stratum.judge.result import Predicate
        from unittest.mock import AsyncMock

        p = Predicate(id="p1", type="deterministic", statement="file_exists('nope.txt')", applied_gate=7)

        not_met_judge = _make_judge_result(met=False)

        result = await run_goal(
            goal_id="shadow-obs-not-met",
            predicates=[p],
            mode="shadow",
            shadow_source="observed",
            observed_artifacts={"output": "no artifact"},
            observed_modified_files=[],
            dispatch_worker_callable=AsyncMock(return_value=("text", "cid")),
            run_judge_callable=AsyncMock(return_value=not_met_judge),
            stratum_agent_run_callable=AsyncMock(),
            stratum_gate_resolve_callable=AsyncMock(),
            ctx=None,
            budget={"max_turns": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )
        assert result.status == "not_met", (
            f"shadow-observed with not-met judge should return 'not_met', got '{result.status}'"
        )
        assert result.would_have_decided == "not_met"

    @pytest.mark.asyncio
    async def test_shadow_observed_met_returns_met_status(self, tmp_path):
        """When judge says met, shadow-observed should return status='met'."""
        from stratum.goal.orchestrator import run_goal
        from stratum.judge.result import Predicate
        from unittest.mock import AsyncMock

        p = Predicate(id="p1", type="deterministic", statement="true", applied_gate=7)

        met_judge = _make_judge_result(met=True)

        result = await run_goal(
            goal_id="shadow-obs-met",
            predicates=[p],
            mode="shadow",
            shadow_source="observed",
            observed_artifacts={"output": "artifact text"},
            observed_modified_files=[],
            dispatch_worker_callable=AsyncMock(return_value=("text", "cid")),
            run_judge_callable=AsyncMock(return_value=met_judge),
            stratum_agent_run_callable=AsyncMock(),
            stratum_gate_resolve_callable=AsyncMock(),
            ctx=None,
            budget={"max_turns": 3},
            goal_state_root=tmp_path / "goal",
            flow_state_root=tmp_path / "flows",
        )
        assert result.status == "met"
        assert result.would_have_decided == "met"


# ---------------------------------------------------------------------------
# Regression: Finding 1 — resumed goals must not double-count budget
# ---------------------------------------------------------------------------

class TestResumedBudgetRegression:
    """Regression for Codex round-2 Finding 1.

    Prior to the fix, ``turns_already_run = len(state.turns)`` was added to
    ``state.round`` in the loop guard.  A goal with ``round=1`` and one prior
    turn was treated as having consumed 2 turns, cutting remaining budget ~in
    half across resumes.

    Fix: ``state.round`` is the single source of truth.  The loop guard is
    simply ``while state.round < max_turns``.
    """

    @pytest.mark.asyncio
    async def test_resumed_goal_runs_exactly_remaining_turns(self, tmp_path):
        """GoalState with round=1 and max_turns=3 must run exactly 2 more turns."""
        from stratum.goal.orchestrator import run_goal
        from stratum.goal.state import (
            GoalState,
            TurnRecord,
            ArtifactSpec,
            compute_predicates_hash,
            persist_goal_state,
        )

        goal_id = "resume-budget-regression-01"

        predicates = _make_predicates()
        pred_dicts = [
            {"id": p.id, "type": p.type, "statement": p.statement, "applied_gate": p.applied_gate}
            for p in predicates
        ]

        # Pre-seed a GoalState that looks like 1 turn already ran.
        prior_turn = TurnRecord(
            turn=1,
            agent_correlation_id="prior-cid",
            duration_ms=100,
            worker_text="prior worker text",
            judge_result_summary={"met": False},
        )
        existing_state = GoalState(
            goal_id=goal_id,
            mode="shadow",
            predicates=pred_dicts,
            predicates_hash=compute_predicates_hash(pred_dicts),
            artifact_contract=[ArtifactSpec(name="artifact1", required=True)],
            turns=[prior_turn],
            round=1,                # canonical counter already at 1
        )
        goal_root = tmp_path / "goal"
        persist_goal_state(existing_state, root=goal_root)

        judge_not_met = _make_judge_result(met=False)
        turns_dispatched = 0

        async def counting_worker(prompt, worker_spec, correlation_id, *, ctx=None):
            nonlocal turns_dispatched
            turns_dispatched += 1
            nonce = prompt.split("===ARTIFACT-")[1].split(":")[0] if "===ARTIFACT-" in prompt else "x"
            return (f"===ARTIFACT-{nonce}:artifact1===\ncontent\n===END===", f"cid-{turns_dispatched}")

        async def always_not_met(**kwargs):
            return judge_not_met

        result = await run_goal(
            goal_id=goal_id,
            predicates=predicates,
            mode="shadow",
            shadow_source="driven",
            dispatch_worker_callable=counting_worker,
            run_judge_callable=always_not_met,
            stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "x"}),
            stratum_gate_resolve_callable=AsyncMock(return_value={}),
            smart_memory_search_callable=None,
            ctx=None,
            prompt="resume test",
            artifact_contract=[{"name": "artifact1", "required": True, "description": ""}],
            budget={"max_turns": 3},
            goal_state_root=goal_root,
            flow_state_root=tmp_path / "flows",
        )

        assert result.status == "budget_exhausted"
        # With the fix: round starts at 1, loop runs while round < 3 → 2 iterations.
        # Without the fix (double-count): round=1 + len(turns)=1 = 2 ≥ 2 → 0 iterations.
        assert turns_dispatched == 2, (
            f"Expected exactly 2 more turns on resume (rounds 1→2→3), "
            f"but worker was called {turns_dispatched} time(s). "
            f"Double-count bug would cause 0 turns."
        )
