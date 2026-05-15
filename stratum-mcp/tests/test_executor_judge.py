"""Tests for STRAT-JUDGE v1 executor.py edits.

Covers:
- FlowState.judge_history / judge_outcome fields round-trip through
  persist_flow / restore_flow.
- _step_mode returns "judge" for a step with judge: config.
- get_current_step_info returns the standard envelope for judge mode.
- _clear_from clears judge state for affected steps.
- delete_persisted_flow removes the JUDGE_ROOT subtree.
- compute_spec_checksum changes when the judge payload changes.
- record_judge_turn records per-(predicate, tier) history + outcome.
- commit_checkpoint / revert_checkpoint snapshot judge state.
"""
from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import pytest

from stratum.judge import (
    BudgetConsumed,
    Evidence,
    JudgeKernelMeta,
    JudgeResult,
    Predicate,
    PredicateResult,
    TierRecord,
)
from stratum.judge.staging import JUDGE_ROOT
from stratum_mcp.executor import (
    FlowState,
    _clear_from,
    _flows,
    commit_checkpoint,
    compute_spec_checksum,
    create_flow_state,
    delete_persisted_flow,
    get_current_step_info,
    persist_flow,
    restore_flow,
    revert_checkpoint,
    _step_mode,
)
from stratum_mcp.spec import parse_and_validate


def _judge_spec() -> str:
    return textwrap.dedent("""\
        version: "0.3"
        flows:
          build:
            input: {}
            output: ""
            steps:
              - id: verify
                agent: claude
                ensure:
                  - "result.met == True"
                judge:
                  predicates:
                    - id: p1
                      type: deterministic
                      statement: "file_exists('artifacts/out.txt')"
        """)


def _make_state(flow_id: str = "test-judge-flow"):
    spec = parse_and_validate(_judge_spec())
    state = create_flow_state(
        spec=spec, flow_name="build", inputs={}, raw_spec=_judge_spec(),
    )
    state.flow_id = flow_id
    return state


def _make_result(turn: int = 1, met: bool = True) -> JudgeResult:
    verdict = "met" if met else "not_met"
    pr = PredicateResult(
        id="p1",
        type="deterministic",
        statement="file_exists('artifacts/out.txt')",
        verdict=verdict,
        confidence=10,
        applied_gate=7,
        evidence=[Evidence(source="artifacts/out.txt:1", quote="ok", tier="T1")],
        tier_history=[
            TierRecord(tier="T1", verdict=verdict, confidence=10,
                       reason="deterministic check")
        ],
    )
    return JudgeResult(
        clean=met, summary="judge: smoke", findings=[],
        meta={"agent_type": "judge", "model_id": None},
        judge_version="1.0", met=met, stakes="default",
        predicates=[pr],
        budget_consumed=BudgetConsumed(turns=turn, dollars=0.0, wall_clock_s=0.0),
        judge_kernel_meta=JudgeKernelMeta(),
    )


class TestStepMode:
    def test_judge_step_mode(self):
        spec = parse_and_validate(_judge_spec())
        step = spec.flows["build"].steps[0]
        assert _step_mode(step) == "judge"


class TestGetCurrentStepInfo:
    def test_judge_envelope_shape(self):
        state = _make_state()
        _flows[state.flow_id] = state
        try:
            info = get_current_step_info(state)
        finally:
            _flows.pop(state.flow_id, None)
        assert info["status"] == "execute_step"
        assert info["step_mode"] == "judge"
        assert info["step_id"] == "verify"
        assert info["step_number"] == 1
        assert info["total_steps"] == 1
        assert info["agent"] == "claude"
        assert info["stakes"] == "default"
        assert info["budget"] is None
        assert info["ensure"] == ["result.met == True"]
        assert info["retries_remaining"] == 1
        assert isinstance(info["predicates"], list)
        assert info["predicates"][0]["id"] == "p1"


class TestRecordAndPersist:
    def test_record_judge_turn_writes_history_and_outcome(self):
        state = _make_state()
        result = _make_result(turn=1, met=True)
        state.record_judge_turn("verify", result)
        assert "verify" in state.judge_history
        history = state.judge_history["verify"]
        assert len(history) == 1
        assert history[0]["predicate_id"] == "p1"
        assert history[0]["tier"] == "T1"
        assert history[0]["turn"] == 1
        outcome = state.judge_outcome["verify"]
        assert outcome["met"] is True
        assert outcome["predicate_results"][0]["id"] == "p1"
        assert outcome["predicate_results"][0]["tier_history"][0]["tier"] == "T1"

    def test_persist_and_restore_round_trip(self, tmp_path, monkeypatch):
        # Redirect _FLOWS_DIR to tmp
        from stratum_mcp import executor as _exec
        monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
        state = _make_state(flow_id="rt-flow-1")
        state.record_judge_turn("verify", _make_result(turn=1, met=True))
        persist_flow(state)
        restored = restore_flow("rt-flow-1")
        assert restored is not None
        assert "verify" in restored.judge_history
        assert restored.judge_history["verify"][0]["tier"] == "T1"
        assert restored.judge_outcome["verify"]["met"] is True


class TestClearFrom:
    def test_clear_from_pops_judge_state(self):
        state = _make_state()
        state.record_judge_turn("verify", _make_result(turn=1, met=True))
        assert "verify" in state.judge_history
        _clear_from(state, target_idx=0)
        assert "verify" not in state.judge_history
        assert "verify" not in state.judge_outcome


class TestDeletePersisted:
    def test_delete_removes_judge_tree(self, tmp_path, monkeypatch):
        from stratum_mcp import executor as _exec
        monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
        flow_id = "del-flow-judge"
        # Materialize a judge tree directly.
        judge_dir = JUDGE_ROOT / flow_id
        judge_dir.mkdir(parents=True, exist_ok=True)
        (judge_dir / "marker.txt").write_text("present")
        try:
            assert judge_dir.exists()
            delete_persisted_flow(flow_id)
            assert not judge_dir.exists()
        finally:
            if judge_dir.exists():
                shutil.rmtree(judge_dir, ignore_errors=True)


class TestComputeSpecChecksum:
    def test_checksum_includes_judge_payload(self):
        spec_a = parse_and_validate(_judge_spec())
        # Same shape but with a stakes override
        spec_b = parse_and_validate(textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    ensure: ["result.met == True"]
                    judge:
                      stakes: cheap
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "file_exists('artifacts/out.txt')"
        """))
        ck_a = compute_spec_checksum(spec_a.flows["build"], spec_a)
        ck_b = compute_spec_checksum(spec_b.flows["build"], spec_b)
        assert ck_a != ck_b, "checksum must change when judge.stakes changes"


class TestCheckpointSnapshots:
    def test_commit_revert_round_trip(self, tmp_path, monkeypatch):
        from stratum_mcp import executor as _exec
        monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
        state = _make_state(flow_id="ckpt-judge-1")
        state.record_judge_turn("verify", _make_result(turn=1, met=True))
        commit_checkpoint(state, "after_judge")
        # Mutate then revert
        state.judge_history.clear()
        state.judge_outcome.clear()
        assert revert_checkpoint(state, "after_judge") is True
        assert "verify" in state.judge_history
        assert state.judge_outcome["verify"]["met"] is True
