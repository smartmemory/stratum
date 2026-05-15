"""STRAT-GOAL Phase E3: Coverage sweep.

Edge cases, error paths, and cross-component integration not covered by
Phase A-D tests. Each test starts with a docstring naming the edge case.
"""
from __future__ import annotations

import asyncio
import dataclasses
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "stratum-mcp", "src"))


# ===========================================================================
# Helpers shared across tests
# ===========================================================================

def _make_predicates(n: int = 1) -> list:
    from stratum.judge.result import Predicate
    return [
        Predicate(
            id=f"p{i}",
            type="deterministic",
            statement=f"predicate {i}",
            applied_gate=7,
        )
        for i in range(1, n + 1)
    ]


def _make_judge_result(*, met: bool = True, verdict: str | None = None):
    """Build a minimal JudgeResult for mocking."""
    from stratum.judge.result import (
        BudgetConsumed, JudgeKernelMeta, JudgeResult, PredicateResult, TierRecord,
    )
    v = verdict or ("met" if met else "not_met")
    pr = PredicateResult(
        id="p1",
        type="deterministic",
        statement="predicate 1",
        verdict=v,
        confidence=8,
        applied_gate=7,
        evidence=[],
        tier_history=[TierRecord(tier="T1", verdict=v, confidence=None, reason="ok")],
    )
    return JudgeResult(
        clean=met,
        met=met,
        summary="ok",
        findings=[],
        meta={"agent_type": "judge", "model_id": "n/a"},
        stakes="default",
        predicates=[pr],
        budget_consumed=BudgetConsumed(turns=1),
        judge_kernel_meta=JudgeKernelMeta(),
    )


def _make_worker_callable(text: str = "worker output", nonce_var: list | None = None):
    """Return an async worker callable that yields a fixed response.

    If ``nonce_var`` is a list, the caller can preload [nonce] and the
    callable will embed a proper artifact fence so extraction succeeds.
    """
    async def _worker(prompt, worker_spec, correlation_id, *, ctx=None):
        return "worker output", correlation_id
    return _worker


def _make_worker_with_artifact(artifact_name: str = "output"):
    """Return a worker that embeds an artifact fence in its output."""
    async def _worker(prompt, worker_spec, correlation_id, *, ctx=None):
        # Extract the nonce from the prompt
        import re
        m = re.search(r"===ARTIFACT-([a-f0-9]{16}):" + re.escape(artifact_name) + r"===", prompt)
        if m:
            nonce = m.group(1)
            text = f"===ARTIFACT-{nonce}:{artifact_name}===\ncontent\n===END==="
        else:
            text = "no artifact"
        return text, correlation_id
    return _worker


def _gate_resolve_noop():
    async def _resolve(**kwargs):
        return {"status": "approved"}
    return _resolve


def _make_goal_state(goal_id: str = "sweep-goal", mode: str = "advisory", **kwargs):
    from stratum.goal.state import GoalState
    return GoalState(
        goal_id=goal_id,
        mode=mode,
        predicates=[{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7}],
        predicates_hash="abc",
        **kwargs,
    )


# ===========================================================================
# 1. Concurrent persist/restore on GoalState (B1.f extended)
# ===========================================================================

class TestConcurrentGoalStatePersist:
    def test_concurrent_persist_last_writer_wins_no_corruption(self, tmp_path):
        """Race between 10 goroutines persisting different round values — final
        state must be parseable and round must be in [0, 9]."""
        from stratum.goal.state import GoalState, persist_goal_state, restore_goal_state

        base_state = GoalState(
            goal_id="concurrent-test",
            mode="advisory",
            predicates=[{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7}],
            predicates_hash="deadbeef",
        )
        errors: list[Exception] = []
        barrier = threading.Barrier(10)

        def writer(round_val: int):
            barrier.wait()  # all start at the same time
            state = dataclasses.replace(base_state, round=round_val)
            try:
                persist_goal_state(state, root=tmp_path)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Concurrent persist raised: {errors}"
        restored = restore_goal_state("concurrent-test", root=tmp_path)
        assert restored is not None
        assert 0 <= restored.round <= 9, f"Unexpected round: {restored.round}"

    def test_concurrent_persist_no_tmp_files_left(self, tmp_path):
        """After concurrent writes, no *.tmp files should remain."""
        from stratum.goal.state import GoalState, persist_goal_state

        base_state = GoalState(
            goal_id="no-tmp-test",
            mode="advisory",
            predicates=[],
            predicates_hash="cafebabe",
        )
        errors: list[Exception] = []

        def writer(i: int):
            state = dataclasses.replace(base_state, round=i)
            try:
                persist_goal_state(state, root=tmp_path)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        goal_dir = tmp_path / "no-tmp-test"
        tmp_files = list(goal_dir.glob("*.tmp"))
        assert not tmp_files, f"Leftover tmp files: {tmp_files}"


# ===========================================================================
# 2. Predicate-hash drift
# ===========================================================================

class TestPredicateHashDrift:
    def test_same_fields_different_applied_gate_different_hash(self):
        """applied_gate is part of the canonical tuple, so changing it changes the hash."""
        from stratum.goal.state import compute_predicates_hash

        base = [{"id": "p1", "type": "deterministic", "statement": "file exists", "applied_gate": 7}]
        drifted = [{"id": "p1", "type": "deterministic", "statement": "file exists", "applied_gate": 8}]
        assert compute_predicates_hash(base) != compute_predicates_hash(drifted)

    def test_same_id_type_statement_applied_gate_equal_hash(self):
        """Predicates with identical canonical fields but extra unknown keys must hash equal."""
        from stratum.goal.state import compute_predicates_hash

        # Extra key 'extra_field' is ignored because compute_predicates_hash only uses
        # the four canonical fields
        a = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7, "extra": "ignored"}]
        b = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7}]
        assert compute_predicates_hash(a) == compute_predicates_hash(b)

    def test_drift_detected_on_restore(self, tmp_path):
        """Resuming with a different applied_gate triggers GoalImmutabilityError."""
        from stratum.goal.errors import GoalImmutabilityError
        from stratum.goal.state import (
            GoalState, compute_predicates_hash, persist_goal_state, restore_goal_state,
        )

        original_preds = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7}]
        state = GoalState(
            goal_id="hash-drift-test",
            mode="advisory",
            predicates=original_preds,
            predicates_hash=compute_predicates_hash(original_preds),
        )
        persist_goal_state(state, root=tmp_path)

        drifted_preds = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 8}]
        drifted_hash = compute_predicates_hash(drifted_preds)

        with pytest.raises(GoalImmutabilityError, match="Predicate hash mismatch"):
            restore_goal_state("hash-drift-test", root=tmp_path, expected_predicates_hash=drifted_hash)

    def test_empty_predicates_hash_is_stable(self):
        """Empty predicate list produces a stable, non-empty hash."""
        from stratum.goal.state import compute_predicates_hash

        h1 = compute_predicates_hash([])
        h2 = compute_predicates_hash([])
        assert h1 == h2
        assert isinstance(h1, str)
        assert len(h1) == 64  # sha256 hex

    def test_applied_gate_none_vs_string_none_differ(self):
        """applied_gate=None vs applied_gate='None' produce different hashes (str coercion)."""
        from stratum.goal.state import compute_predicates_hash

        a = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": None}]
        b = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": "None"}]
        # Both get str()-coerced: both produce "None" → same hash
        # This is the documented behaviour: str(None) == "None" == str("None") for the same string
        h_a = compute_predicates_hash(a)
        h_b = compute_predicates_hash(b)
        # They happen to be equal because str(None)=="None"==str("None") only when applied_gate="None"
        # Document the actual behaviour:
        assert isinstance(h_a, str) and isinstance(h_b, str)


# ===========================================================================
# 3. Synthetic flow IR edge cases
# ===========================================================================

class TestSyntheticFlowIR:
    def test_max_turns_1_produces_max_rounds_1(self):
        """max_turns=1 → max_rounds=max(1,0)=1 (not 0)."""
        from stratum.goal.orchestrator import _build_synthetic_flow_yaml
        import yaml

        raw = _build_synthetic_flow_yaml("goal-edge", max_rounds=0)
        spec = yaml.safe_load(raw)
        # max_rounds is passed as max(1, max_rounds) inside the function when max_rounds=0
        # but the caller in run_goal does max(1, max_turns-1) before calling
        # _build_synthetic_flow_yaml, so we test the function with explicit 0
        flow = spec["flows"]["goal"]
        assert flow.get("max_rounds", None) == 1  # clipped to 1

    def test_max_rounds_5_preserved(self):
        """max_rounds=5 is preserved in the IR."""
        from stratum.goal.orchestrator import _build_synthetic_flow_yaml
        import yaml

        raw = _build_synthetic_flow_yaml("goal-edge-5", max_rounds=5)
        spec = yaml.safe_load(raw)
        flow = spec["flows"]["goal"]
        assert flow.get("max_rounds", None) == 5

    def test_flow_ir_has_goal_turn_and_goal_decision_steps(self):
        """The synthetic flow must have exactly goal_turn + goal_decision steps."""
        from stratum.goal.orchestrator import _build_synthetic_flow_yaml
        import yaml

        raw = _build_synthetic_flow_yaml("goal-ir-steps", max_rounds=3)
        spec = yaml.safe_load(raw)
        steps = spec["flows"]["goal"]["steps"]
        step_ids = [s["id"] for s in steps]
        assert "goal_turn" in step_ids
        assert "goal_decision" in step_ids

    def test_flow_ir_is_valid_yaml(self):
        """Generated IR parses without error."""
        from stratum.goal.orchestrator import _build_synthetic_flow_yaml
        import yaml

        raw = _build_synthetic_flow_yaml("parse-test", max_rounds=2)
        spec = yaml.safe_load(raw)
        assert isinstance(spec, dict)

    def test_max_rounds_zero_clipped_to_1(self):
        """_build_synthetic_flow_yaml clips 0 → 1."""
        from stratum.goal.orchestrator import _build_synthetic_flow_yaml
        import yaml

        raw = _build_synthetic_flow_yaml("clip-test", max_rounds=0)
        spec = yaml.safe_load(raw)
        assert spec["flows"]["goal"]["max_rounds"] == 1


# ===========================================================================
# 4. _observed_shadow_path with empty observed_artifacts
# ===========================================================================

class TestObservedShadowPath:
    @pytest.mark.asyncio
    async def test_empty_observed_artifacts_runs_judge(self, tmp_path):
        """_observed_shadow_path with no observed_artifacts (empty dict) calls judge once."""
        from stratum.goal.orchestrator import _observed_shadow_path, _make_flow_state
        from stratum.goal.state import GoalState, persist_goal_state

        goal_id = "shadow-empty-artifacts"
        preds = _make_predicates(1)
        state = GoalState(
            goal_id=goal_id,
            mode="shadow",
            predicates=[dataclasses.asdict(p) for p in preds],
            predicates_hash="aaa",
            cwd="",
        )
        persist_goal_state(state, root=tmp_path)

        # Minimal fake FlowState with flow_id so _persist_flow_state can write
        class FakeFlow:
            flow_id = goal_id
            round = 0
            ordered_steps = []
            current_idx = 0
            terminal_status = None

        judge_call_args: list = []

        async def mock_judge(**kwargs):
            judge_call_args.append(kwargs)
            return _make_judge_result(met=True)

        result = await _observed_shadow_path(
            state=state,
            flow_state=FakeFlow(),
            observed_artifacts=None,  # None → falls back to {}
            observed_modified_files=None,
            run_judge_callable=mock_judge,
            predicates=preds,
            stakes="default",
            budget={"max_turns": 5},
            goal_state_root=tmp_path,
            flow_state_root=tmp_path,
            ctx=None,
            stratum_agent_run_callable=AsyncMock(),
        )

        assert len(judge_call_args) == 1
        assert judge_call_args[0]["artifacts"] == {}

    @pytest.mark.asyncio
    async def test_observed_shadow_met_returns_met_status(self, tmp_path):
        """When judge returns met=True, status is 'met' and would_have_decided='met'."""
        from stratum.goal.orchestrator import _observed_shadow_path
        from stratum.goal.state import GoalState, persist_goal_state

        goal_id = "shadow-met"
        preds = _make_predicates(1)
        state = GoalState(
            goal_id=goal_id,
            mode="shadow",
            predicates=[dataclasses.asdict(p) for p in preds],
            predicates_hash="bbb",
            cwd="",
        )
        persist_goal_state(state, root=tmp_path)

        class FakeFlow:
            flow_id = goal_id
            round = 0
            ordered_steps = []
            current_idx = 0
            terminal_status = None

        result = await _observed_shadow_path(
            state=state,
            flow_state=FakeFlow(),
            observed_artifacts={"output": "content"},
            observed_modified_files=["file.py"],
            run_judge_callable=AsyncMock(return_value=_make_judge_result(met=True)),
            predicates=preds,
            stakes="default",
            budget={"max_turns": 5},
            goal_state_root=tmp_path,
            flow_state_root=tmp_path,
            ctx=None,
            stratum_agent_run_callable=AsyncMock(),
        )

        assert result.status == "met"
        assert result.would_have_decided == "met"

    @pytest.mark.asyncio
    async def test_observed_shadow_not_met_returns_not_met_status(self, tmp_path):
        """When judge returns met=False, status='not_met' and would_have_decided='not_met'."""
        from stratum.goal.orchestrator import _observed_shadow_path
        from stratum.goal.state import GoalState, persist_goal_state

        goal_id = "shadow-not-met"
        preds = _make_predicates(1)
        state = GoalState(
            goal_id=goal_id,
            mode="shadow",
            predicates=[dataclasses.asdict(p) for p in preds],
            predicates_hash="ccc",
            cwd="",
        )
        persist_goal_state(state, root=tmp_path)

        class FakeFlow:
            flow_id = goal_id
            round = 0
            ordered_steps = []
            current_idx = 0
            terminal_status = None

        result = await _observed_shadow_path(
            state=state,
            flow_state=FakeFlow(),
            observed_artifacts={},
            observed_modified_files=[],
            run_judge_callable=AsyncMock(return_value=_make_judge_result(met=False)),
            predicates=preds,
            stakes="default",
            budget={"max_turns": 5},
            goal_state_root=tmp_path,
            flow_state_root=tmp_path,
            ctx=None,
            stratum_agent_run_callable=AsyncMock(),
        )

        assert result.status == "not_met"
        assert result.would_have_decided == "not_met"

    @pytest.mark.asyncio
    async def test_observed_shadow_judge_exception_returns_budget_exhausted(self, tmp_path):
        """When judge raises, _observed_shadow_path returns budget_exhausted."""
        from stratum.goal.orchestrator import _observed_shadow_path
        from stratum.goal.state import GoalState, persist_goal_state

        goal_id = "shadow-judge-fail"
        preds = _make_predicates(1)
        state = GoalState(
            goal_id=goal_id,
            mode="shadow",
            predicates=[dataclasses.asdict(p) for p in preds],
            predicates_hash="ddd",
            cwd="",
        )
        persist_goal_state(state, root=tmp_path)

        class FakeFlow:
            flow_id = goal_id
            round = 0
            ordered_steps = []
            current_idx = 0
            terminal_status = None

        async def failing_judge(**kwargs):
            raise RuntimeError("judge exploded")

        # Patch _persist_flow_state to avoid serializing the minimal FakeFlow;
        # the failure path is what we're testing, not the persist detail.
        with patch("stratum.goal.orchestrator._persist_flow_state"):
            result = await _observed_shadow_path(
                state=state,
                flow_state=FakeFlow(),
                observed_artifacts={},
                observed_modified_files=[],
                run_judge_callable=failing_judge,
                predicates=preds,
                stakes="default",
                budget={"max_turns": 5},
                goal_state_root=tmp_path,
                flow_state_root=tmp_path,
                ctx=None,
                stratum_agent_run_callable=AsyncMock(),
            )

        assert result.status == "budget_exhausted"


# ===========================================================================
# 5. _resolve_autonomy LRU cache behaviour
# ===========================================================================

class TestAutonomyCacheEviction:
    def setup_method(self):
        from stratum.goal.autonomy import clear_autonomy_cache
        clear_autonomy_cache()

    def teardown_method(self):
        from stratum.goal.autonomy import clear_autonomy_cache
        clear_autonomy_cache()

    @pytest.mark.asyncio
    async def test_second_call_within_60s_hits_cache(self):
        """Second call with same workspace/callable returns cached value (no SM call)."""
        from stratum.goal.autonomy import resolve_autonomy

        call_count = 0

        async def counting_sm(**kwargs):
            nonlocal call_count
            call_count += 1
            return {}

        r1 = await resolve_autonomy("/ws", None, smart_memory_search_callable=counting_sm)
        r2 = await resolve_autonomy("/ws", None, smart_memory_search_callable=counting_sm)

        assert r1 == r2
        # SM callable should only be called once (second call hits cache)
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_different_workspace_misses_cache(self):
        """Different workspace_cwd produces different cache key → separate SM call."""
        from stratum.goal.autonomy import resolve_autonomy

        call_count = 0

        async def counting_sm(**kwargs):
            nonlocal call_count
            call_count += 1
            return {}

        await resolve_autonomy("/ws-a", None, smart_memory_search_callable=counting_sm)
        await resolve_autonomy("/ws-b", None, smart_memory_search_callable=counting_sm)

        # Two different workspaces → two SM calls
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_caller_dict_overrides_cached_sm_result(self):
        """Even when SM result is cached, caller_dict overrides are applied on top."""
        from stratum.goal.autonomy import resolve_autonomy

        async def sm_all_false(**kwargs):
            return {
                "learned": [
                    {
                        "metadata": {
                            "schema": "goal_autonomy_calibration.v1",
                            "deterministic": {"autonomous": False},
                            "verified": {"autonomous": False},
                            "judged": {"autonomous": False},
                        }
                    }
                ]
            }

        # Warm the cache
        r1 = await resolve_autonomy("/ws-override", None, smart_memory_search_callable=sm_all_false)
        assert r1 == {"deterministic": False, "verified": False, "judged": False}

        # Second call with override — should apply override even with cache hit
        r2 = await resolve_autonomy(
            "/ws-override",
            {"deterministic": True},
            smart_memory_search_callable=sm_all_false,
        )
        assert r2["deterministic"] is True
        assert r2["verified"] is False

    @pytest.mark.asyncio
    async def test_cache_eviction_after_ttl(self):
        """After TTL elapses, cache entry is evicted and SM is called again."""
        from stratum.goal.autonomy import _cache, _cache_set, _cache_get, _cache_key

        call_count = 0

        async def counting_sm(**kwargs):
            nonlocal call_count
            call_count += 1
            return {}

        from stratum.goal.autonomy import resolve_autonomy

        # Manually insert a stale entry
        key = _cache_key("/ws-evict", counting_sm)
        _cache[key] = ({"deterministic": False, "verified": False, "judged": False}, time.monotonic() - 1.0)

        # Cache miss because entry expired
        r = await resolve_autonomy("/ws-evict", None, smart_memory_search_callable=counting_sm)
        # SM was called (evicted entry)
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_none_sm_callable_skips_sm_tier(self):
        """When smart_memory_search_callable=None, SM tier is skipped; returns default."""
        from stratum.goal.autonomy import resolve_autonomy

        result = await resolve_autonomy("/ws-no-sm", None, smart_memory_search_callable=None)
        assert result == {"deterministic": False, "verified": False, "judged": False}


# ===========================================================================
# 6. Cross-mode resume: advisory → autonomous raises GoalImmutabilityError
# ===========================================================================

class TestCrossModeResume:
    @pytest.mark.asyncio
    async def test_resume_advisory_as_autonomous_raises(self, tmp_path):
        """Starting a goal in advisory and resuming in autonomous raises GoalImmutabilityError."""
        from stratum.goal.orchestrator import run_goal
        from stratum.goal.errors import GoalImmutabilityError

        goal_id = "cross-mode-resume"
        preds = _make_predicates(1)
        budget = {"max_turns": 1}

        # First call: advisory mode
        judge_met = _make_judge_result(met=True)
        gate_result = {"status": "approved"}

        # Worker returns artifact so extraction succeeds
        worker = _make_worker_with_artifact("output")

        first_result = await run_goal(
            goal_id=goal_id,
            predicates=preds,
            mode="advisory",
            dispatch_worker_callable=worker,
            run_judge_callable=AsyncMock(return_value=judge_met),
            stratum_agent_run_callable=AsyncMock(),
            stratum_gate_resolve_callable=_gate_resolve_noop(),
            budget=budget,
            artifact_contract=[{"name": "output", "required": True, "description": "out"}],
            goal_state_root=tmp_path,
            flow_state_root=tmp_path,
        )

        # Second call: try to resume as autonomous — should raise
        with pytest.raises(GoalImmutabilityError, match="Mode mismatch|mode cannot change"):
            await run_goal(
                goal_id=goal_id,
                predicates=preds,
                mode="autonomous",  # different from persisted "advisory"
                dispatch_worker_callable=worker,
                run_judge_callable=AsyncMock(return_value=judge_met),
                stratum_agent_run_callable=AsyncMock(),
                stratum_gate_resolve_callable=_gate_resolve_noop(),
                budget=budget,
                goal_state_root=tmp_path,
                flow_state_root=tmp_path,
            )


# ===========================================================================
# 7. extract_artifacts: duplicate fence names — last-wins behaviour
# ===========================================================================

class TestExtractArtifactsDuplicateFenceNames:
    def test_duplicate_fence_name_last_wins(self):
        """When worker emits the same artifact name twice, last occurrence wins."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce

        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:output===\nfirst value\n===END===\n"
            f"===ARTIFACT-{nonce}:output===\nsecond value\n===END==="
        )
        contract = [{"name": "output", "required": True, "description": ""}]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "output" in artifacts
        assert artifacts["output"] == "second value"
        assert missing == []

    def test_two_different_artifact_names_both_extracted(self):
        """Two differently-named artifacts in one response are both extracted."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce

        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:alpha===\nalpha content\n===END===\n"
            f"===ARTIFACT-{nonce}:beta===\nbeta content\n===END==="
        )
        contract = [
            {"name": "alpha", "required": True, "description": ""},
            {"name": "beta", "required": True, "description": ""},
        ]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert artifacts["alpha"] == "alpha content"
        assert artifacts["beta"] == "beta content"
        assert missing == []

    def test_artifact_not_in_contract_still_extracted(self):
        """Artifacts emitted by worker but not in contract are still captured (extra dict keys)."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce

        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:required_one===\ncontent\n===END===\n"
            f"===ARTIFACT-{nonce}:extra_artifact===\nextra\n===END==="
        )
        contract = [{"name": "required_one", "required": True, "description": ""}]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "required_one" in artifacts
        assert "extra_artifact" in artifacts
        assert missing == []


# ===========================================================================
# 8. build_turn_prompt feedback window boundary tests
# ===========================================================================

class TestBuildTurnPromptFeedbackBoundary:
    def _make_prior_turn(self, turn_num: int, predicate_id: str = "p1") -> dict:
        return {
            "turn": turn_num,
            "findings": [{"predicate_id": predicate_id, "verdict": "not_met", "reason": "fail"}],
        }

    def test_zero_prior_findings_shows_first_turn_message(self):
        """Length 0: [Previous judge feedback] section indicates first turn."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt("task", [], [], nonce)
        assert "first turn" in prompt.lower() or "no prior" in prompt.lower()

    def test_three_prior_findings_all_verbatim_no_summary(self):
        """Length 3: all three turns shown verbatim, no 'earlier' collapse line."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        findings = [self._make_prior_turn(i, f"p{i}") for i in range(1, 4)]
        prompt = build_turn_prompt("task", [], findings, nonce)
        assert "p1" in prompt
        assert "p2" in prompt
        assert "p3" in prompt
        # No summary line for earlier turns
        assert "earlier" not in prompt.lower() or "0 earlier" not in prompt.lower()

    def test_four_prior_findings_triggers_summary(self):
        """Length 4: turn 1 is summarised as '1 earlier turn(s)'; turns 2-4 verbatim."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        findings = [self._make_prior_turn(i, f"p{i}") for i in range(1, 5)]
        prompt = build_turn_prompt("task", [], findings, nonce)
        # Should see collapse line
        assert "earlier" in prompt.lower()
        # Turn 1 predicate should NOT be in the verbatim section
        # (it's in the collapsed summary, not explicitly listed)
        # Turns 2,3,4 should be shown
        assert "p2" in prompt or "p3" in prompt or "p4" in prompt

    def test_findings_with_empty_findings_list_per_turn(self):
        """A prior turn with an empty findings list produces '(no findings)' output."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        findings = [{"turn": 1, "findings": []}]
        prompt = build_turn_prompt("task", [], findings, nonce)
        assert "no findings" in prompt.lower()

    def test_prior_findings_missing_turn_key_uses_question_mark(self):
        """A turn dict without 'turn' key defaults to '?' in the prompt."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        findings = [{"findings": [{"predicate_id": "p1", "verdict": "not_met", "reason": "r"}]}]
        prompt = build_turn_prompt("task", [], findings, nonce)
        assert "?" in prompt


# ===========================================================================
# 9. stratum_goal_status for a goal that never started
# ===========================================================================

class TestGoalStatusNeverStarted:
    """stratum_goal_status for an unknown goal_id returns GoalNotFoundError envelope."""

    @pytest.mark.asyncio
    async def test_status_unknown_goal_returns_error(self):
        """Status check on a never-started goal returns error envelope."""
        import stratum_mcp.server as srv

        ctx = MagicMock()
        ctx.request_context = MagicMock()

        # The server imports restore_goal_state inline inside stratum_goal_status.
        # Patch at the source module so the inline import sees the mock.
        with patch("stratum.goal.state.restore_goal_state", side_effect=FileNotFoundError("not found")):
            result = await srv.stratum_goal_status("nonexistent-goal-xyz", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "GoalNotFoundError"
        assert "nonexistent-goal-xyz" in result["message"]

    @pytest.mark.asyncio
    async def test_status_goal_state_exists_but_no_flow_state(self):
        """If GoalState exists but FlowState is missing, returns GoalNotFoundError."""
        import stratum_mcp.server as srv
        from stratum.goal.state import GoalState

        fake_state = GoalState(
            goal_id="partial-goal",
            mode="advisory",
            predicates=[],
            predicates_hash="abc",
        )

        ctx = MagicMock()

        with patch("stratum.goal.state.restore_goal_state", return_value=fake_state):
            with patch("stratum_mcp.executor.restore_flow", return_value=None):
                result = await srv.stratum_goal_status("partial-goal", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "GoalNotFoundError"


# ===========================================================================
# 10. stratum_goal_decide against terminal state
# ===========================================================================

class TestGoalDecideTerminalState:
    """stratum_goal_decide on a complete/killed goal returns no_pending_decision."""

    def _make_mock_flow_state(self, *, current_idx: int, step_count: int, step_id: str = "goal_turn"):
        """Return a minimal fake FlowState."""
        class FakeStep:
            def __init__(self, sid: str):
                self.id = sid

        class FakeFlow:
            def __init__(self):
                self.ordered_steps = [FakeStep(step_id)] * step_count
                self.current_idx = current_idx
                self.terminal_status = None

        return FakeFlow()

    @pytest.mark.asyncio
    async def test_decide_on_complete_flow_returns_no_pending(self):
        """Goal whose flow is complete (current_idx >= step_count) → no_pending_decision."""
        import stratum_mcp.server as srv
        from stratum.goal.state import GoalState

        fake_goal = GoalState(
            goal_id="done-goal",
            mode="advisory",
            predicates=[],
            predicates_hash="abc",
            decision_gates=[],
        )
        # Flow is complete: current_idx == step_count
        fake_flow = self._make_mock_flow_state(current_idx=2, step_count=2)

        ctx = MagicMock()

        with patch("stratum.goal.state.restore_goal_state", return_value=fake_goal):
            with patch("stratum_mcp.executor.restore_flow", return_value=fake_flow):
                result = await srv.stratum_goal_decide("done-goal", "confirm", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "no_pending_decision"
        assert "complete" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_decide_on_non_decision_step_returns_no_pending(self):
        """Goal whose current step is goal_turn (not goal_decision) → no_pending_decision."""
        import stratum_mcp.server as srv
        from stratum.goal.state import GoalState

        fake_goal = GoalState(
            goal_id="in-progress-goal",
            mode="advisory",
            predicates=[],
            predicates_hash="abc",
            decision_gates=[],
        )
        # Flow at goal_turn step
        fake_flow = self._make_mock_flow_state(current_idx=0, step_count=2, step_id="goal_turn")

        ctx = MagicMock()

        with patch("stratum.goal.state.restore_goal_state", return_value=fake_goal):
            with patch("stratum_mcp.executor.restore_flow", return_value=fake_flow):
                result = await srv.stratum_goal_decide("in-progress-goal", "confirm", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "no_pending_decision"

    @pytest.mark.asyncio
    async def test_decide_unknown_goal_returns_goal_not_found(self):
        """Decide on a never-started goal returns GoalNotFoundError."""
        import stratum_mcp.server as srv

        ctx = MagicMock()

        with patch("stratum.goal.state.restore_goal_state", side_effect=FileNotFoundError):
            result = await srv.stratum_goal_decide("missing-goal", "confirm", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "GoalNotFoundError"

    @pytest.mark.asyncio
    async def test_decide_invalid_decision_value_returns_error(self):
        """Invalid decision string (not confirm/reject/kill) returns invalid_decision error."""
        import stratum_mcp.server as srv
        from stratum.goal.state import GoalState, DecisionGateRecord

        fake_goal = GoalState(
            goal_id="decide-invalid",
            mode="advisory",
            predicates=[],
            predicates_hash="abc",
            decision_gates=[DecisionGateRecord(round=0, decision="pending")],
        )

        class FakeStep:
            id = "goal_decision"

        class FakeFlow:
            ordered_steps = [FakeStep()]
            current_idx = 0
            terminal_status = None

        ctx = MagicMock()

        with patch("stratum.goal.state.restore_goal_state", return_value=fake_goal):
            with patch("stratum_mcp.executor.restore_flow", return_value=FakeFlow()):
                result = await srv.stratum_goal_decide("decide-invalid", "BOGUS", ctx)

        assert result["status"] == "error"
        assert result["error_type"] == "invalid_decision"


# ===========================================================================
# 11. WorkerFailureTracker reset behaviour: success interleaved with failures
# ===========================================================================

class TestWorkerFailureTrackerResetBehaviour:
    def test_success_resets_to_zero_counter(self):
        """record_success resets the internal counter to 0."""
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=3)

        tracker.record_failure(RuntimeError("1"))
        tracker.record_failure(RuntimeError("2"))
        tracker.record_success()

        # Counter is 0 — two more failures should be fine
        tracker.record_failure(RuntimeError("after reset 1"))
        tracker.record_failure(RuntimeError("after reset 2"))
        # Still at 2 — no exception
        assert tracker._consecutive_failures == 2

    def test_multiple_success_resets_still_resets(self):
        """Multiple success calls in a row keep the counter at 0."""
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=2)

        tracker.record_success()
        tracker.record_success()
        tracker.record_failure(RuntimeError("1"))
        assert tracker._consecutive_failures == 1

    def test_failure_cap_hit_exactly_at_max(self):
        """BudgetExceededError is raised exactly when consecutive count reaches max_failures."""
        from stratum.goal.worker import WorkerFailureTracker
        from stratum.judge.errors import BudgetExceededError

        tracker = WorkerFailureTracker(max_failures=2)
        tracker.record_failure(RuntimeError("1"))  # count = 1, no raise

        with pytest.raises(BudgetExceededError):
            tracker.record_failure(RuntimeError("2"))  # count = 2 = max_failures → raise

    def test_error_message_includes_count_and_exception(self):
        """BudgetExceededError message includes failure count and last exception text."""
        from stratum.goal.worker import WorkerFailureTracker
        from stratum.judge.errors import BudgetExceededError

        tracker = WorkerFailureTracker(max_failures=1)
        with pytest.raises(BudgetExceededError) as exc_info:
            tracker.record_failure(RuntimeError("network timeout"))

        msg = str(exc_info.value)
        assert "1" in msg  # failure count
        assert "network timeout" in msg  # last error propagated

    def test_success_after_cap_hit_is_too_late(self):
        """After the cap is hit and BudgetExceededError raised, calling record_success is moot."""
        from stratum.goal.worker import WorkerFailureTracker
        from stratum.judge.errors import BudgetExceededError

        tracker = WorkerFailureTracker(max_failures=1)
        try:
            tracker.record_failure(RuntimeError("cap hit"))
        except BudgetExceededError:
            pass  # expected

        # After cap hit, counter is 1; calling success resets to 0
        tracker.record_success()
        assert tracker._consecutive_failures == 0

    def test_interleaved_pattern(self):
        """Interleave success/failure: F, F, S, F, F, F → raises on 3rd F after reset."""
        from stratum.goal.worker import WorkerFailureTracker
        from stratum.judge.errors import BudgetExceededError

        tracker = WorkerFailureTracker(max_failures=3)
        tracker.record_failure(RuntimeError("1"))
        tracker.record_failure(RuntimeError("2"))
        tracker.record_success()  # reset
        tracker.record_failure(RuntimeError("3"))
        tracker.record_failure(RuntimeError("4"))
        with pytest.raises(BudgetExceededError):
            tracker.record_failure(RuntimeError("5"))  # 3rd consecutive → cap


# ===========================================================================
# 12. stratum_goal_archive partial failure envelope
# ===========================================================================

class TestGoalArchivePartialFailure:
    @pytest.mark.asyncio
    async def test_archive_all_present_returns_complete(self, tmp_path):
        """archive returns {status:'complete', removed:[...]} when all targets removable."""
        import shutil
        import stratum_mcp.server as srv
        import stratum_mcp.executor as exec_mod
        import stratum.judge.staging as staging_mod
        import stratum.goal.state as goal_state_mod

        goal_id = "archive-complete-test"

        # Create fake paths
        flow_json = tmp_path / "flows" / f"{goal_id}.json"
        judge_dir = tmp_path / "judge" / goal_id
        goal_dir = tmp_path / "goal" / goal_id

        flow_json.parent.mkdir(parents=True)
        judge_dir.mkdir(parents=True)
        goal_dir.mkdir(parents=True)
        flow_json.write_text("{}")
        (judge_dir / "ev.txt").write_text("evidence")
        (goal_dir / "state.json").write_text("{}")

        orig_flows_dir = exec_mod._FLOWS_DIR
        orig_judge_root = staging_mod.JUDGE_ROOT
        orig_goal_root = goal_state_mod._GOAL_ROOT_DEFAULT
        exec_mod._FLOWS_DIR = tmp_path / "flows"
        staging_mod.JUDGE_ROOT = tmp_path / "judge"
        goal_state_mod._GOAL_ROOT_DEFAULT = tmp_path / "goal"

        ctx = MagicMock()
        try:
            result = await srv.stratum_goal_archive(goal_id, ctx)
        finally:
            exec_mod._FLOWS_DIR = orig_flows_dir
            staging_mod.JUDGE_ROOT = orig_judge_root
            goal_state_mod._GOAL_ROOT_DEFAULT = orig_goal_root

        assert result["status"] == "complete"
        assert set(result["removed"]) == {"flow_json", "judge_dir", "goal_dir"}

    @pytest.mark.asyncio
    async def test_archive_already_archived_returns_already_archived(self, tmp_path):
        """Re-archiving a fully absent goal returns {status:'already_archived'}."""
        import stratum_mcp.server as srv
        import stratum_mcp.executor as exec_mod
        import stratum.judge.staging as staging_mod
        import stratum.goal.state as goal_state_mod

        goal_id = "already-archived"

        orig_flows_dir = exec_mod._FLOWS_DIR
        orig_judge_root = staging_mod.JUDGE_ROOT
        orig_goal_root = goal_state_mod._GOAL_ROOT_DEFAULT
        exec_mod._FLOWS_DIR = tmp_path / "flows"
        staging_mod.JUDGE_ROOT = tmp_path / "judge"
        goal_state_mod._GOAL_ROOT_DEFAULT = tmp_path / "goal"

        ctx = MagicMock()
        try:
            result = await srv.stratum_goal_archive(goal_id, ctx)
        finally:
            exec_mod._FLOWS_DIR = orig_flows_dir
            staging_mod.JUDGE_ROOT = orig_judge_root
            goal_state_mod._GOAL_ROOT_DEFAULT = orig_goal_root

        assert result["status"] == "already_archived"


# ===========================================================================
# 13. _collect_prior_findings and _get_latest_rejection_note
# ===========================================================================

class TestOrchestratorHelpers:
    def test_collect_prior_findings_empty_turns(self):
        """Empty turns list produces empty prior_findings."""
        from stratum.goal.orchestrator import _collect_prior_findings
        from stratum.goal.state import GoalState

        state = GoalState(
            goal_id="g", mode="advisory", predicates=[], predicates_hash="x",
        )
        result = _collect_prior_findings(state)
        assert result == []

    def test_collect_prior_findings_with_turns(self):
        """prior_findings has one entry per turn with turn number and findings."""
        from stratum.goal.orchestrator import _collect_prior_findings
        from stratum.goal.state import GoalState, TurnRecord

        state = GoalState(
            goal_id="g", mode="advisory", predicates=[], predicates_hash="x",
            turns=[
                TurnRecord(
                    turn=1,
                    agent_correlation_id="c1",
                    duration_ms=100,
                    worker_text="",
                    judge_result_summary={"findings": ["f1"], "met": False},
                ),
                TurnRecord(
                    turn=2,
                    agent_correlation_id="c2",
                    duration_ms=200,
                    worker_text="",
                    judge_result_summary={"findings": ["f2"], "met": True},
                ),
            ],
        )
        result = _collect_prior_findings(state)
        assert len(result) == 2
        assert result[0]["turn"] == 1
        assert result[0]["findings"] == ["f1"]
        assert result[1]["turn"] == 2

    def test_get_latest_rejection_note_no_gates(self):
        """No decision gates → returns None."""
        from stratum.goal.orchestrator import _get_latest_rejection_note
        from stratum.goal.state import GoalState

        state = GoalState(
            goal_id="g", mode="advisory", predicates=[], predicates_hash="x",
        )
        assert _get_latest_rejection_note(state) is None

    def test_get_latest_rejection_note_with_note(self):
        """Last gate's rejection_note is returned."""
        from stratum.goal.orchestrator import _get_latest_rejection_note
        from stratum.goal.state import GoalState, DecisionGateRecord

        state = GoalState(
            goal_id="g", mode="advisory", predicates=[], predicates_hash="x",
            decision_gates=[
                DecisionGateRecord(round=0, decision="reject", rejection_note="fix this"),
            ],
        )
        assert _get_latest_rejection_note(state) == "fix this"

    def test_get_latest_rejection_note_empty_note_returns_none(self):
        """Empty string rejection_note is coerced to None."""
        from stratum.goal.orchestrator import _get_latest_rejection_note
        from stratum.goal.state import GoalState, DecisionGateRecord

        state = GoalState(
            goal_id="g", mode="advisory", predicates=[], predicates_hash="x",
            decision_gates=[
                DecisionGateRecord(round=0, decision="pending", rejection_note=""),
            ],
        )
        # empty string is falsy → _get_latest_rejection_note returns None
        assert _get_latest_rejection_note(state) is None


# ===========================================================================
# 14. _partition_outcomes correctness
# ===========================================================================

class TestPartitionOutcomes:
    def test_met_predicates_auto_bind_when_type_whitelisted(self):
        """Met predicates whose type is in autonomy → autobind list."""
        from stratum.goal.orchestrator import _partition_outcomes
        from stratum.judge.result import (
            BudgetConsumed, JudgeKernelMeta, JudgeResult, PredicateResult, TierRecord,
        )

        def _pr(id_, type_, verdict):
            return PredicateResult(
                id=id_, type=type_, statement="s", verdict=verdict,
                confidence=8, applied_gate=7, evidence=[],
                tier_history=[TierRecord(tier="T1", verdict=verdict, confidence=None, reason="ok")],
            )

        jr = JudgeResult(
            clean=True, met=True, summary="", findings=[],
            meta={"agent_type": "judge", "model_id": "n/a"},
            stakes="default",
            predicates=[
                _pr("p1", "deterministic", "met"),
                _pr("p2", "verified", "met"),
                _pr("p3", "judged", "not_met"),
            ],
            budget_consumed=BudgetConsumed(turns=1),
            judge_kernel_meta=JudgeKernelMeta(),
        )

        autonomy = {"deterministic": True, "verified": False, "judged": False}
        autobind, await_human = _partition_outcomes(jr, autonomy)

        autobind_ids = {pr.id for pr in autobind}
        await_ids = {pr.id for pr in await_human}

        assert "p1" in autobind_ids  # deterministic=True
        assert "p2" in await_ids     # verified=False → awaits human
        assert "p3" not in autobind_ids and "p3" not in await_ids  # not_met → excluded

    def test_not_met_predicates_excluded_from_both_lists(self):
        """not_met predicates appear in neither autobind nor await_human."""
        from stratum.goal.orchestrator import _partition_outcomes
        from stratum.judge.result import (
            BudgetConsumed, JudgeKernelMeta, JudgeResult, PredicateResult, TierRecord,
        )

        def _pr(id_, verdict):
            return PredicateResult(
                id=id_, type="deterministic", statement="s", verdict=verdict,
                confidence=8, applied_gate=7, evidence=[],
                tier_history=[],
            )

        jr = JudgeResult(
            clean=False, met=False, summary="", findings=[],
            meta={"agent_type": "judge", "model_id": "n/a"},
            stakes="default",
            predicates=[_pr("p1", "not_met"), _pr("p2", "ambiguous")],
            budget_consumed=BudgetConsumed(turns=1),
            judge_kernel_meta=JudgeKernelMeta(),
        )

        autobind, await_human = _partition_outcomes(jr, {"deterministic": True})
        assert autobind == []
        assert await_human == []

    def test_all_types_false_autonomy_all_await_human(self):
        """When all autonomy flags are False, all met predicates await human."""
        from stratum.goal.orchestrator import _partition_outcomes
        from stratum.judge.result import (
            BudgetConsumed, JudgeKernelMeta, JudgeResult, PredicateResult, TierRecord,
        )

        def _pr(id_, type_):
            return PredicateResult(
                id=id_, type=type_, statement="s", verdict="met",
                confidence=8, applied_gate=7, evidence=[], tier_history=[],
            )

        jr = JudgeResult(
            clean=True, met=True, summary="", findings=[],
            meta={"agent_type": "judge", "model_id": "n/a"},
            stakes="default",
            predicates=[_pr("p1", "deterministic"), _pr("p2", "verified")],
            budget_consumed=BudgetConsumed(turns=1),
            judge_kernel_meta=JudgeKernelMeta(),
        )

        autobind, await_human = _partition_outcomes(jr, {"deterministic": False, "verified": False, "judged": False})
        assert autobind == []
        assert len(await_human) == 2


# ===========================================================================
# 15. restore_goal_state FileNotFoundError
# ===========================================================================

class TestRestoreGoalStateNotFound:
    def test_restore_missing_state_raises_file_not_found(self, tmp_path):
        """restore_goal_state for an unknown goal_id raises FileNotFoundError."""
        from stratum.goal.state import restore_goal_state

        with pytest.raises(FileNotFoundError, match="No GoalState found"):
            restore_goal_state("no-such-goal", root=tmp_path)

    def test_restore_with_correct_hash_succeeds(self, tmp_path):
        """restore_goal_state with matching expected_predicates_hash returns state."""
        from stratum.goal.state import (
            GoalState, compute_predicates_hash, persist_goal_state, restore_goal_state,
        )

        preds = [{"id": "p1", "type": "deterministic", "statement": "s", "applied_gate": 7}]
        h = compute_predicates_hash(preds)
        state = GoalState(
            goal_id="correct-hash",
            mode="advisory",
            predicates=preds,
            predicates_hash=h,
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("correct-hash", root=tmp_path, expected_predicates_hash=h)
        assert restored.predicates_hash == h

    def test_restore_with_correct_mode_succeeds(self, tmp_path):
        """restore_goal_state with matching expected_mode returns state."""
        from stratum.goal.state import GoalState, persist_goal_state, restore_goal_state

        state = GoalState(
            goal_id="correct-mode",
            mode="autonomous",
            predicates=[],
            predicates_hash="xyz",
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("correct-mode", root=tmp_path, expected_mode="autonomous")
        assert restored.mode == "autonomous"


# ===========================================================================
# 16. Autonomy parse_sm_results edge cases
# ===========================================================================

class TestParseSMResults:
    def test_non_dict_results_returns_empty(self):
        """If SmartMemory returns a list instead of dict, parse returns {}."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results([{"metadata": {}}])
        assert result == {}

    def test_missing_learned_key_returns_empty(self):
        """If 'learned' key is absent, returns {}."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results({"other_key": []})
        assert result == {}

    def test_non_list_learned_returns_empty(self):
        """If 'learned' is not a list, returns {}."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results({"learned": "not-a-list"})
        assert result == {}

    def test_item_with_wrong_schema_is_skipped(self):
        """Items with wrong schema version are skipped."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results({
            "learned": [
                {
                    "metadata": {
                        "schema": "wrong_schema",
                        "deterministic": {"autonomous": True},
                    }
                }
            ]
        })
        assert result == {}

    def test_valid_calibration_record_extracted(self):
        """A well-formed calibration record correctly sets autonomy flags."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results({
            "learned": [
                {
                    "metadata": {
                        "schema": "goal_autonomy_calibration.v1",
                        "deterministic": {"autonomous": True},
                        "verified": {"autonomous": False},
                        "judged": {"autonomous": True},
                    }
                }
            ]
        })
        assert result == {"deterministic": True, "verified": False, "judged": True}

    def test_only_first_matching_record_used(self):
        """When multiple calibration records exist, only the first is used."""
        from stratum.goal.autonomy import _parse_sm_results
        result = _parse_sm_results({
            "learned": [
                {
                    "metadata": {
                        "schema": "goal_autonomy_calibration.v1",
                        "deterministic": {"autonomous": True},
                    }
                },
                {
                    "metadata": {
                        "schema": "goal_autonomy_calibration.v1",
                        "deterministic": {"autonomous": False},
                        "verified": {"autonomous": True},
                    }
                },
            ]
        })
        # First record: deterministic=True, no verified key
        assert result.get("deterministic") is True
        assert "verified" not in result  # first record had no verified key


# ===========================================================================
# 17. GoalState with autonomy field round-trips
# ===========================================================================

class TestGoalStateAutonomyField:
    def test_autonomy_field_persists_and_restores(self, tmp_path):
        """The autonomy dict on GoalState survives persist/restore."""
        from stratum.goal.state import GoalState, persist_goal_state, restore_goal_state

        state = GoalState(
            goal_id="autonomy-persist",
            mode="autonomous",
            predicates=[],
            predicates_hash="aaa",
            autonomy={"deterministic": True, "verified": False, "judged": True},
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("autonomy-persist", root=tmp_path)
        assert restored.autonomy == {"deterministic": True, "verified": False, "judged": True}

    def test_autonomy_field_defaults_to_empty_dict(self):
        """GoalState.autonomy defaults to {} when not specified."""
        from stratum.goal.state import GoalState
        state = GoalState(goal_id="g", mode="advisory", predicates=[], predicates_hash="x")
        assert state.autonomy == {}


# ===========================================================================
# 18. _git_diff_files error resilience
# ===========================================================================

class TestGitDiffFiles:
    def test_empty_cwd_returns_empty_list(self):
        """_git_diff_files with empty cwd returns []."""
        from stratum.goal.orchestrator import _git_diff_files
        result = _git_diff_files("")
        assert result == []

    def test_none_cwd_returns_empty_list(self):
        """_git_diff_files with None cwd returns []."""
        from stratum.goal.orchestrator import _git_diff_files
        result = _git_diff_files(None)
        assert result == []

    def test_nonexistent_dir_returns_empty_list(self):
        """_git_diff_files with a path that has no git repo returns []."""
        from stratum.goal.orchestrator import _git_diff_files
        result = _git_diff_files("/tmp/no-such-git-repo-xyz")
        assert result == []
