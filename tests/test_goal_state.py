"""Tests for A2 (goal-result.json contract) and A3 (result.py).

A2 acceptance:
- Schema is a valid JSON Schema
- allOf refs judge-result.json + adds goal-specific fields
- additionalProperties: false at the goal extension level
- goal_version const "1.0", mode, status enum, turns_run, worker_runs, round,
  predicate_outcomes[], optional would_have_decided

A3 acceptance:
- GoalResult and PredicateOutcome dataclasses exist
- to_dict() output validates against goal-result.json
- clean == met invariant preserved
- would_have_decided omitted when turns is 0 / None (PRD M5)
- predicate_outcomes[] populated correctly
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# Contract paths
CONTRACTS_DIR = Path(__file__).parent.parent.parent / "compose" / "contracts"
GOAL_CONTRACT_PATH = CONTRACTS_DIR / "goal-result.json"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_meta() -> dict:
    """Minimal valid meta satisfying review-result.json's required fields."""
    return {"agent_type": "judge", "model_id": None}


def _make_judge_result(**kwargs):
    """Construct a minimal valid JudgeResult. Accepts overrides."""
    from stratum.judge.result import (
        BudgetConsumed,
        JudgeKernelMeta,
        JudgeResult,
        PredicateResult,
        TierRecord,
    )
    pr = PredicateResult(
        id="p1",
        type="deterministic",
        statement="file exists",
        verdict=kwargs.get("predicate_verdict", "met"),
        confidence=kwargs.get("confidence", 8),
        applied_gate=7,
        evidence=[],
        tier_history=[
            TierRecord(
                tier="T1",
                verdict=kwargs.get("predicate_verdict", "met"),
                confidence=None,
                reason="T1 ran",
            )
        ],
    )
    clean = kwargs.get("predicate_verdict", "met") == "met"
    return JudgeResult(
        clean=clean,
        summary=kwargs.get("summary", "ok"),
        findings=[],
        meta=_make_meta(),
        met=clean,
        stakes="default",
        predicates=[pr],
        budget_consumed=BudgetConsumed(turns=kwargs.get("turns", 1)),
        judge_kernel_meta=JudgeKernelMeta(),
    )


def _make_predicate_outcome(*, verdict: str = "met") -> "PredicateOutcome":
    from stratum.goal.result import PredicateOutcome
    return PredicateOutcome(
        id="p1",
        type="deterministic",
        verdict=verdict,
        confidence=8,
        applied_gate=7,
        judge_verdict=verdict,
        bound_autonomously=False,
        awaiting_human=False,
    )


def _validate_against_goal_schema(instance: dict, schema: dict) -> None:
    """Validate instance against schema using jsonschema with local $ref resolution."""
    import jsonschema
    resolver = jsonschema.RefResolver(
        base_uri=GOAL_CONTRACT_PATH.parent.as_uri() + "/",
        referrer=schema,
    )
    validator = jsonschema.Draft7Validator(schema, resolver=resolver)
    validator.validate(instance)


def _find_goal_extension(schema: dict) -> dict:
    """Return the non-$ref entry in the top-level allOf (the goal extension)."""
    for entry in schema.get("allOf", []):
        if "$ref" not in entry:
            return entry
    raise AssertionError("No goal-extension entry found in allOf")


# ---------------------------------------------------------------------------
# A2: Schema self-validation
# ---------------------------------------------------------------------------

class TestGoalResultContract:
    def test_contract_file_exists(self):
        assert GOAL_CONTRACT_PATH.exists(), (
            f"goal-result.json not found at {GOAL_CONTRACT_PATH}"
        )

    def test_contract_is_valid_json(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        assert isinstance(schema, dict)

    def test_contract_passes_draft202012_check_schema(self):
        """jsonschema.Draft202012Validator.check_schema must not raise."""
        import jsonschema
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        jsonschema.Draft202012Validator.check_schema(schema)

    def test_contract_has_allof_with_judge_ref(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        all_of = schema.get("allOf", [])
        assert len(all_of) >= 2, "allOf must have at least 2 entries"
        refs = [entry.get("$ref", "") for entry in all_of]
        assert any("judge-result.json" in r for r in refs), (
            "allOf must include a $ref to judge-result.json"
        )

    def test_goal_version_const(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        goal_ext = _find_goal_extension(schema)
        props = goal_ext.get("properties", {})
        assert "goal_version" in props
        assert props["goal_version"].get("const") == "1.0"

    def test_required_goal_fields_present(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        goal_ext = _find_goal_extension(schema)
        required = set(goal_ext.get("required", []))
        expected = {
            "goal_id", "goal_version", "mode", "status",
            "turns_run", "worker_runs", "round", "predicate_outcomes",
        }
        missing = expected - required
        assert not missing, f"Required fields missing from goal extension: {missing}"

    def test_status_is_enum(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        goal_ext = _find_goal_extension(schema)
        props = goal_ext.get("properties", {})
        assert "status" in props
        status_schema = props["status"]
        assert "enum" in status_schema
        enum_vals = set(status_schema["enum"])
        for v in ["met", "not_met", "awaiting_decision", "budget_exhausted", "killed"]:
            assert v in enum_vals, f"status enum missing {v}"

    def test_would_have_decided_is_optional(self):
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        goal_ext = _find_goal_extension(schema)
        required = set(goal_ext.get("required", []))
        assert "would_have_decided" not in required, (
            "would_have_decided must be optional (not in required)"
        )
        props = goal_ext.get("properties", {})
        assert "would_have_decided" in props

    def test_valid_sample_passes_validation(self):
        """A well-formed GoalResult dict must validate against the schema."""
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        sample = {
            # judge-result.json fields (inherited via allOf)
            "clean": True,
            "summary": "All predicates met",
            "findings": [],
            "meta": {"agent_type": "judge", "model_id": None},
            "consensus": [],
            "claude_only": [],
            "codex_only": [],
            "lenses_run": [],
            "auto_fixes": [],
            "asks": [],
            "judge_version": "1.0",
            "met": True,
            "stakes": "default",
            "predicates": [
                {
                    "id": "p1",
                    "type": "deterministic",
                    "statement": "file exists",
                    "verdict": "met",
                    "confidence": 8,
                    "applied_gate": 7,
                    "evidence": [],
                    "tier_history": [
                        {"tier": "T1", "verdict": "met", "confidence": None, "reason": "T1 passed"}
                    ],
                }
            ],
            "tier_disagreements": [],
            "budget_consumed": {"turns": 1, "dollars": 0.0, "wall_clock_s": 0.5},
            "judge_kernel_meta": {"decomposer_mode": "user"},
            # goal-result.json goal-specific fields
            "goal_id": "test-goal-001",
            "goal_version": "1.0",
            "mode": "advisory",
            "status": "met",
            "turns_run": 1,
            "worker_runs": [{"turn": 1, "agent_correlation_id": "cid-001", "duration_ms": 1200}],
            "round": 0,
            "predicate_outcomes": [
                {
                    "id": "p1",
                    "type": "deterministic",
                    "verdict": "met",
                    "confidence": 8,
                    "applied_gate": 7,
                    "judge_verdict": "met",
                    "bound_autonomously": False,
                    "awaiting_human": False,
                }
            ],
        }
        _validate_against_goal_schema(sample, schema)

    def test_invalid_status_fails_validation(self):
        """An unknown status value must fail schema validation."""
        import jsonschema
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        sample = {
            "clean": True, "summary": "ok", "findings": [],
            "meta": {"agent_type": "judge", "model_id": None},
            "consensus": [], "claude_only": [], "codex_only": [],
            "lenses_run": [], "auto_fixes": [], "asks": [],
            "judge_version": "1.0", "met": True, "stakes": "default",
            "predicates": [
                {
                    "id": "p1", "type": "deterministic", "statement": "s",
                    "verdict": "met", "confidence": 8, "applied_gate": 7,
                    "evidence": [],
                    "tier_history": [{"tier": "T1", "verdict": "met", "confidence": None, "reason": "ok"}],
                }
            ],
            "tier_disagreements": [],
            "budget_consumed": {"turns": 1, "dollars": 0.0, "wall_clock_s": 0.0},
            "judge_kernel_meta": {"decomposer_mode": "user"},
            "goal_id": "g1", "goal_version": "1.0", "mode": "advisory",
            "status": "INVALID_STATUS",  # <-- this should fail
            "turns_run": 1, "worker_runs": [], "round": 0,
            "predicate_outcomes": [
                {
                    "id": "p1", "type": "deterministic", "verdict": "met",
                    "confidence": 8, "applied_gate": 7, "judge_verdict": "met",
                    "bound_autonomously": False, "awaiting_human": False,
                }
            ],
        }
        with pytest.raises(jsonschema.ValidationError):
            _validate_against_goal_schema(sample, schema)


# ---------------------------------------------------------------------------
# A3: GoalResult dataclass and to_dict()
# ---------------------------------------------------------------------------

class TestGoalResult:
    def test_goal_result_and_predicate_outcome_importable(self):
        from stratum.goal.result import GoalResult, PredicateOutcome
        assert GoalResult is not None
        assert PredicateOutcome is not None

    def test_predicate_outcome_fields(self):
        from stratum.goal.result import PredicateOutcome
        po = PredicateOutcome(
            id="p1",
            type="deterministic",
            verdict="met",
            confidence=8,
            applied_gate=7,
            judge_verdict="met",
            bound_autonomously=False,
            awaiting_human=False,
        )
        assert po.id == "p1"
        assert po.verdict == "met"
        assert not po.bound_autonomously

    def test_goal_result_to_dict_validates_against_contract(self):
        """A3 acceptance: to_dict() output validates against goal-result.json."""
        from stratum.goal.result import GoalResult

        jr = _make_judge_result()
        po = _make_predicate_outcome()
        gr = GoalResult(
            judge_result=jr,
            goal_id="test-goal-001",
            mode="advisory",
            status="met",
            turns_run=1,
            worker_runs=[{"turn": 1, "agent_correlation_id": "cid-001", "duration_ms": 1200}],
            round=0,
            predicate_outcomes=[po],
        )

        result_dict = gr.to_dict()
        schema = json.loads(GOAL_CONTRACT_PATH.read_text())
        _validate_against_goal_schema(result_dict, schema)

    def test_clean_equals_met_invariant_preserved(self):
        """Inherited JudgeResult invariant: clean == met must hold."""
        from stratum.goal.result import GoalResult

        jr = _make_judge_result()
        po = _make_predicate_outcome()
        gr = GoalResult(
            judge_result=jr, goal_id="g1", mode="advisory",
            status="met", turns_run=1, worker_runs=[], round=0,
            predicate_outcomes=[po],
        )
        d = gr.to_dict()
        assert d["clean"] == d["met"]

    def test_would_have_decided_omitted_when_none(self):
        """PRD M5: would_have_decided omitted when would_have_decided=None."""
        from stratum.goal.result import GoalResult

        jr = _make_judge_result(predicate_verdict="not_met")
        po = _make_predicate_outcome(verdict="not_met")
        gr = GoalResult(
            judge_result=jr, goal_id="g1", mode="shadow",
            status="budget_exhausted", turns_run=0, worker_runs=[], round=0,
            predicate_outcomes=[po],
            would_have_decided=None,  # None means omit from dict
        )
        d = gr.to_dict()
        assert "would_have_decided" not in d

    def test_would_have_decided_present_when_set(self):
        """PRD M5: would_have_decided present when explicitly set to a verdict."""
        from stratum.goal.result import GoalResult

        jr = _make_judge_result(predicate_verdict="not_met")
        po = _make_predicate_outcome(verdict="not_met")
        gr = GoalResult(
            judge_result=jr, goal_id="g1", mode="shadow",
            status="budget_exhausted", turns_run=1, worker_runs=[], round=0,
            predicate_outcomes=[po],
            would_have_decided="not_met",
        )
        d = gr.to_dict()
        assert "would_have_decided" in d
        assert d["would_have_decided"] == "not_met"

    def test_predicate_outcomes_in_to_dict(self):
        """predicate_outcomes must appear as a list of dicts in to_dict()."""
        from stratum.goal.result import GoalResult, PredicateOutcome

        jr = _make_judge_result()
        po = PredicateOutcome(
            id="p1", type="deterministic", verdict="met", confidence=8,
            applied_gate=7, judge_verdict="met", bound_autonomously=True, awaiting_human=False,
        )
        gr = GoalResult(
            judge_result=jr, goal_id="g1", mode="autonomous",
            status="met", turns_run=1, worker_runs=[], round=0,
            predicate_outcomes=[po],
        )
        d = gr.to_dict()
        assert isinstance(d["predicate_outcomes"], list)
        assert len(d["predicate_outcomes"]) == 1
        outcome = d["predicate_outcomes"][0]
        assert outcome["id"] == "p1"
        assert outcome["bound_autonomously"] is True
        assert outcome["awaiting_human"] is False

    def test_would_have_decided_omitted_by_default(self):
        """Default would_have_decided=None means the key is absent from to_dict()."""
        from stratum.goal.result import GoalResult

        jr = _make_judge_result()
        po = _make_predicate_outcome()
        gr = GoalResult(
            judge_result=jr, goal_id="g1", mode="advisory",
            status="met", turns_run=1, worker_runs=[], round=0,
            predicate_outcomes=[po],
        )
        d = gr.to_dict()
        assert "would_have_decided" not in d


# ---------------------------------------------------------------------------
# B1: GoalState persistence (state.py)
# ---------------------------------------------------------------------------

class TestGoalStatePersistence:
    """B1 acceptance criteria (a)-(f)."""

    def _make_state(self, goal_id: str = "test-goal-b1") -> "GoalState":
        from stratum.goal.state import (
            ArtifactSpec,
            GoalState,
            TurnRecord,
        )
        return GoalState(
            goal_id=goal_id,
            mode="advisory",
            predicates=[
                {"id": "p1", "type": "deterministic", "statement": "file exists", "applied_gate": 7},
            ],
            predicates_hash="abc123",
            artifact_contract=[ArtifactSpec(name="output.py", required=True, description="output")],
            turns=[
                TurnRecord(
                    turn=1,
                    agent_correlation_id="cid-001",
                    duration_ms=1200,
                    worker_text="some output",
                    judge_result_summary={"met": True, "predicate_results": []},
                )
            ],
            decision_gates=[],
            round=0,
            cwd="/tmp/test",
        )

    def test_persist_restore_round_trip(self, tmp_path):
        """(a) persist -> restore preserves all fields."""
        from stratum.goal.state import GoalState, persist_goal_state, restore_goal_state

        orig = self._make_state()
        persist_goal_state(orig, root=tmp_path)
        restored = restore_goal_state(orig.goal_id, root=tmp_path)

        assert restored is not None
        assert restored.goal_id == orig.goal_id
        assert restored.mode == orig.mode
        assert restored.predicates_hash == orig.predicates_hash
        assert restored.round == orig.round
        assert restored.cwd == orig.cwd
        assert len(restored.turns) == len(orig.turns)
        assert restored.turns[0].turn == 1
        assert restored.turns[0].agent_correlation_id == "cid-001"

    def test_compute_predicates_hash_canonical(self):
        """(b) hash is order-independent (canonical-sorted)."""
        from stratum.goal.state import compute_predicates_hash

        predicates_a = [
            {"id": "p1", "type": "deterministic", "statement": "file exists", "applied_gate": 7},
            {"id": "p2", "type": "verified", "statement": "tests pass", "applied_gate": 8},
        ]
        predicates_b = [
            {"id": "p2", "type": "verified", "statement": "tests pass", "applied_gate": 8},
            {"id": "p1", "type": "deterministic", "statement": "file exists", "applied_gate": 7},
        ]
        assert compute_predicates_hash(predicates_a) == compute_predicates_hash(predicates_b)

    def test_hash_mismatch_raises_immutability_error(self, tmp_path):
        """(c) hash mismatch on resume raises GoalImmutabilityError."""
        from stratum.goal.errors import GoalImmutabilityError
        from stratum.goal.state import GoalState, persist_goal_state, restore_goal_state

        orig = self._make_state()
        persist_goal_state(orig, root=tmp_path)

        # Restore with a different expected hash -> must raise
        with pytest.raises(GoalImmutabilityError):
            restore_goal_state(orig.goal_id, root=tmp_path, expected_predicates_hash="WRONG_HASH")

    def test_mode_mismatch_raises_immutability_error(self, tmp_path):
        """(d) mode mismatch on resume raises GoalImmutabilityError."""
        from stratum.goal.errors import GoalImmutabilityError
        from stratum.goal.state import persist_goal_state, restore_goal_state

        orig = self._make_state()
        persist_goal_state(orig, root=tmp_path)

        with pytest.raises(GoalImmutabilityError):
            restore_goal_state(orig.goal_id, root=tmp_path, expected_mode="autonomous")

    def test_atomic_write_no_tmp_file_left(self, tmp_path):
        """(e) atomic-write doesn't leave a tmp file on success."""
        from stratum.goal.state import persist_goal_state

        orig = self._make_state()
        persist_goal_state(orig, root=tmp_path)

        goal_dir = tmp_path / orig.goal_id
        files = list(goal_dir.iterdir())
        file_names = [f.name for f in files]
        assert "state.json" in file_names
        assert not any(n.endswith(".tmp") for n in file_names)

    def test_concurrent_persist_no_corruption(self, tmp_path):
        """(f) concurrent persist produces last-writer-wins without corruption."""
        import threading
        import dataclasses
        from stratum.goal.state import persist_goal_state, restore_goal_state

        orig = self._make_state()
        errors = []

        def writer(round_val: int):
            state = dataclasses.replace(orig, round=round_val)
            try:
                persist_goal_state(state, root=tmp_path)
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors, f"Unexpected errors during concurrent persist: {errors}"
        restored = restore_goal_state(orig.goal_id, root=tmp_path)
        assert restored is not None
        assert isinstance(restored.round, int)


# ---------------------------------------------------------------------------
# B2: FlowState.synthetic field
# ---------------------------------------------------------------------------

class TestFlowStateSynthetic:
    """B2 acceptance criteria."""

    def _stratum_mcp_path(self):
        import os
        return os.path.join(os.path.dirname(__file__), "..", "stratum-mcp", "src")

    def test_flow_state_synthetic_field_default_false(self):
        """FlowState must have synthetic=False by default."""
        import sys
        sys.path.insert(0, self._stratum_mcp_path())
        from stratum_mcp.executor import FlowState
        import dataclasses
        fields = {f.name: f for f in dataclasses.fields(FlowState)}
        assert "synthetic" in fields, "FlowState must have a 'synthetic' field"
        # default must be False (not MISSING)
        assert fields["synthetic"].default is False

    def test_flow_state_synthetic_round_trip(self, tmp_path):
        """construct FlowState(synthetic=True), persist, restore, assert synthetic==True."""
        import sys
        sys.path.insert(0, self._stratum_mcp_path())

        import stratum_mcp.executor as executor_mod
        orig_dir = executor_mod._FLOWS_DIR
        executor_mod._FLOWS_DIR = tmp_path

        try:
            from stratum_mcp.executor import create_flow_state, persist_flow, restore_flow
            from stratum_mcp.spec import parse_and_validate

            raw = """
version: "0.1"
contracts:
  Out:
    value: {type: string}
functions:
  fn1:
    mode: infer
    intent: "test step"
    input: {}
    output: Out
flows:
  main:
    input: {}
    output: Out
    steps:
      - id: s1
        function: fn1
        inputs: {}
"""
            spec = parse_and_validate(raw)
            state = create_flow_state(spec, "main", {}, raw_spec=raw)
            # Patch synthetic=True on the created state
            import dataclasses
            state = dataclasses.replace(state, flow_id="synth-test", synthetic=True)
            persist_flow(state)
            restored = restore_flow("synth-test")
            assert restored is not None
            assert restored.synthetic is True
        finally:
            executor_mod._FLOWS_DIR = orig_dir

    def test_delete_persisted_flow_preserves_judge_tree_when_synthetic(self, tmp_path):
        """Judge tree survives delete_persisted_flow(flow_id, synthetic=True)."""
        import sys
        sys.path.insert(0, self._stratum_mcp_path())

        import stratum_mcp.executor as executor_mod
        orig_dir = executor_mod._FLOWS_DIR
        executor_mod._FLOWS_DIR = tmp_path

        # We can't easily patch JUDGE_ROOT since it's used at call time from delete_persisted_flow.
        # Instead, verify at the module level that the guard is in effect.
        # We'll create a fake judge dir inside the stratum staging area and patch the module.
        import stratum.judge.staging as staging_mod
        orig_judge_root = staging_mod.JUDGE_ROOT
        fake_judge_root = tmp_path / "judge"
        staging_mod.JUDGE_ROOT = fake_judge_root

        try:
            from stratum_mcp.executor import delete_persisted_flow
            flow_id = "synth-delete-test"
            (tmp_path / f"{flow_id}.json").write_text("{}")
            judge_dir = fake_judge_root / flow_id
            judge_dir.mkdir(parents=True)
            (judge_dir / "evidence.txt").write_text("important evidence")

            delete_persisted_flow(flow_id, synthetic=True)

            assert judge_dir.exists(), "Judge tree must not be deleted for synthetic flows"
            assert not (tmp_path / f"{flow_id}.json").exists(), "Flow JSON should be deleted"
        finally:
            executor_mod._FLOWS_DIR = orig_dir
            staging_mod.JUDGE_ROOT = orig_judge_root


# ---------------------------------------------------------------------------
# B3: Schema validation -- synthetic field in contracts
# ---------------------------------------------------------------------------

class TestQueryContractsSynthetic:
    """B3 acceptance criteria."""

    _CONTRACTS_DIR = Path(__file__).parent.parent / "stratum-mcp" / "contracts"

    def _load_schema(self, name: str) -> dict:
        import json
        return json.loads((self._CONTRACTS_DIR / name).read_text())

    def test_flow_state_schema_accepts_synthetic_true(self):
        """flow-state.v1 must accept synthetic: true."""
        import jsonschema
        schema = self._load_schema("flow-state.v1.schema.json")
        instance = {
            "_schema_version": "1",
            "flow_id": "test",
            "flow_name": "main",
            "status": "running",
            "current_step_id": "s1",
            "current_idx": 0,
            "round": 0,
            "rounds_count": 0,
            "terminal_status": None,
            "step_count": 1,
            "step_outputs": {},
            "records": [],
            "rounds": [],
            "ordered_steps": [{"id": "s1", "function": "fn1", "mode": "step"}],
            "synthetic": True,
        }
        jsonschema.validate(instance, schema)

    def test_flow_state_schema_accepts_synthetic_false(self):
        import jsonschema
        schema = self._load_schema("flow-state.v1.schema.json")
        instance = {
            "_schema_version": "1",
            "flow_id": "test",
            "flow_name": "main",
            "status": "running",
            "current_step_id": None,
            "current_idx": 0,
            "round": 0,
            "rounds_count": 0,
            "terminal_status": None,
            "step_count": 0,
            "step_outputs": {},
            "records": [],
            "rounds": [],
            "ordered_steps": [],
            "synthetic": False,
        }
        jsonschema.validate(instance, schema)

    def test_flow_state_schema_rejects_synthetic_string(self):
        """synthetic must be boolean, not string."""
        import jsonschema
        schema = self._load_schema("flow-state.v1.schema.json")
        instance = {
            "_schema_version": "1",
            "flow_id": "test",
            "flow_name": "main",
            "status": "running",
            "current_step_id": None,
            "current_idx": 0,
            "round": 0,
            "rounds_count": 0,
            "terminal_status": None,
            "step_count": 0,
            "step_outputs": {},
            "records": [],
            "rounds": [],
            "ordered_steps": [],
            "synthetic": "true",
        }
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance, schema)

    def test_query_flows_schema_accepts_synthetic_true(self):
        """query-flows.v1 FlowSummary must accept synthetic: true."""
        import jsonschema
        schema = self._load_schema("query-flows.v1.schema.json")
        instance = [
            {
                "_schema_version": "1",
                "flow_id": "test",
                "flow_name": "main",
                "status": "running",
                "current_step_id": None,
                "round": 0,
                "step_count": 1,
                "completed_steps": 0,
                "terminal_status": None,
                "synthetic": True,
            }
        ]
        jsonschema.validate(instance, schema)

    def test_query_flows_schema_rejects_synthetic_string(self):
        """query-flows.v1 synthetic must be boolean."""
        import jsonschema
        schema = self._load_schema("query-flows.v1.schema.json")
        instance = [
            {
                "_schema_version": "1",
                "flow_id": "test",
                "flow_name": "main",
                "status": "running",
                "current_step_id": None,
                "round": 0,
                "step_count": 1,
                "completed_steps": 0,
                "terminal_status": None,
                "synthetic": "true",
            }
        ]
        with pytest.raises(jsonschema.ValidationError):
            jsonschema.validate(instance, schema)


# ---------------------------------------------------------------------------
# B4: _query_flows / _query_flow expose synthetic field
# ---------------------------------------------------------------------------

class TestQueryToolsSynthetic:
    """B4 acceptance criteria."""

    def _stratum_mcp_path(self):
        import os
        return os.path.join(os.path.dirname(__file__), "..", "stratum-mcp", "src")

    def _make_synthetic_flow_state(self, flow_id: str):
        """Helper: create a synthetic FlowState using create_flow_state."""
        import sys
        import dataclasses
        sys.path.insert(0, self._stratum_mcp_path())
        from stratum_mcp.executor import create_flow_state
        from stratum_mcp.spec import parse_and_validate

        raw = """
version: "0.1"
contracts:
  Out:
    value: {type: string}
functions:
  fn1:
    mode: infer
    intent: "test step"
    input: {}
    output: Out
flows:
  main:
    input: {}
    output: Out
    steps:
      - id: s1
        function: fn1
        inputs: {}
"""
        spec = parse_and_validate(raw)
        state = create_flow_state(spec, "main", {}, raw_spec=raw)
        return dataclasses.replace(state, flow_id=flow_id, synthetic=True)

    def test_query_flows_includes_synthetic(self, tmp_path):
        """_query_flows result dicts must include 'synthetic' key."""
        import sys
        sys.path.insert(0, self._stratum_mcp_path())

        import stratum_mcp.executor as executor_mod
        orig_dir = executor_mod._FLOWS_DIR
        executor_mod._FLOWS_DIR = tmp_path

        try:
            from stratum_mcp.executor import persist_flow
            from stratum_mcp.server import _query_flows

            state = self._make_synthetic_flow_state("qf-synth")
            persist_flow(state)

            results = _query_flows()
            flow_result = next((r for r in results if r["flow_id"] == "qf-synth"), None)
            assert flow_result is not None
            assert "synthetic" in flow_result
            assert flow_result["synthetic"] is True
        finally:
            executor_mod._FLOWS_DIR = orig_dir

    def test_query_flow_includes_synthetic(self, tmp_path):
        """_query_flow result dict must include 'synthetic' key."""
        import sys
        sys.path.insert(0, self._stratum_mcp_path())

        import stratum_mcp.executor as executor_mod
        orig_dir = executor_mod._FLOWS_DIR
        executor_mod._FLOWS_DIR = tmp_path

        try:
            from stratum_mcp.executor import persist_flow
            from stratum_mcp.server import _query_flow

            state = self._make_synthetic_flow_state("qf-single-synth")
            persist_flow(state)

            result = _query_flow("qf-single-synth")
            assert "synthetic" in result
            assert result["synthetic"] is True
        finally:
            executor_mod._FLOWS_DIR = orig_dir


# ---------------------------------------------------------------------------
# Finding 3 + Finding 4 regression: DecisionGateRecord new fields round-trip
# ---------------------------------------------------------------------------

class TestDecisionGateRecordNewFields:
    """Regression tests for registered_at_ms and rejection_note (Findings 3 & 4)."""

    def test_registered_at_ms_defaults_to_none(self):
        from stratum.goal.state import DecisionGateRecord
        g = DecisionGateRecord(round=1, decision="pending")
        assert g.registered_at_ms is None

    def test_rejection_note_defaults_to_none(self):
        from stratum.goal.state import DecisionGateRecord
        g = DecisionGateRecord(round=1, decision="pending")
        assert g.rejection_note is None

    def test_registered_at_ms_round_trips_through_dict(self):
        """registered_at_ms survives _gate_record_to_dict / _gate_record_from_dict."""
        from stratum.goal.state import DecisionGateRecord, _gate_record_to_dict, _gate_record_from_dict
        import time
        ts = int(time.time() * 1000)
        g = DecisionGateRecord(round=1, decision="pending", registered_at_ms=ts)
        d = _gate_record_to_dict(g)
        assert d["registered_at_ms"] == ts
        g2 = _gate_record_from_dict(d)
        assert g2.registered_at_ms == ts

    def test_rejection_note_round_trips_through_dict(self):
        """rejection_note survives _gate_record_to_dict / _gate_record_from_dict."""
        from stratum.goal.state import DecisionGateRecord, _gate_record_to_dict, _gate_record_from_dict
        note = "fix edge cases in boundary tests"
        g = DecisionGateRecord(round=1, decision="reject", rejection_note=note)
        d = _gate_record_to_dict(g)
        assert d["rejection_note"] == note
        g2 = _gate_record_from_dict(d)
        assert g2.rejection_note == note

    def test_none_fields_omitted_from_dict(self):
        """registered_at_ms and rejection_note are omitted from dict when None."""
        from stratum.goal.state import DecisionGateRecord, _gate_record_to_dict
        g = DecisionGateRecord(round=1, decision="pending")
        d = _gate_record_to_dict(g)
        assert "registered_at_ms" not in d
        assert "rejection_note" not in d

    def test_full_round_trip_via_persist_restore(self, tmp_path):
        """registered_at_ms and rejection_note survive persist_goal_state / restore_goal_state."""
        import time
        from stratum.goal.state import (
            DecisionGateRecord,
            GoalState,
            persist_goal_state,
            restore_goal_state,
        )
        ts = int(time.time() * 1000)
        state = GoalState(
            goal_id="regressiontest-gate-fields",
            mode="advisory",
            predicates=[],
            predicates_hash="deadbeef",
            decision_gates=[
                DecisionGateRecord(
                    round=0,
                    decision="pending",
                    registered_at_ms=ts,
                    rejection_note="fix this please",
                )
            ],
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("regressiontest-gate-fields", root=tmp_path)
        assert len(restored.decision_gates) == 1
        g = restored.decision_gates[0]
        assert g.registered_at_ms == ts
        assert g.rejection_note == "fix this please"

    def test_outcome_and_resolved_at_ms_round_trip(self, tmp_path):
        """Finding 3 (follow-up): outcome and resolved_at_ms survive persist/restore."""
        import time
        from stratum.goal.state import (
            DecisionGateRecord,
            GoalState,
            persist_goal_state,
            restore_goal_state,
        )
        ts = int(time.time() * 1000)
        state = GoalState(
            goal_id="gate-outcome-roundtrip",
            mode="advisory",
            predicates=[],
            predicates_hash="cafebabe",
            decision_gates=[
                DecisionGateRecord(
                    round=1,
                    decision="confirm",
                    outcome="approve",
                    resolved_at_ms=ts,
                )
            ],
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("gate-outcome-roundtrip", root=tmp_path)
        assert len(restored.decision_gates) == 1
        g = restored.decision_gates[0]
        assert g.outcome == "approve"
        assert g.resolved_at_ms == ts

    def test_outcome_none_omitted_from_dict(self):
        """outcome and resolved_at_ms are absent from the dict when not set."""
        from stratum.goal.state import DecisionGateRecord, _gate_record_to_dict
        g = DecisionGateRecord(round=0, decision="pending")
        d = _gate_record_to_dict(g)
        assert "outcome" not in d
        assert "resolved_at_ms" not in d

    def test_fully_resolved_gate_all_fields_round_trip(self, tmp_path):
        """Codex Round-3 Finding 2: a fully resolved DecisionGateRecord (decision,
        note, resolved_by, registered_at_ms, rejection_note, outcome, resolved_at_ms)
        must survive persist_goal_state → restore_goal_state with every field intact.
        """
        import time
        from stratum.goal.state import (
            DecisionGateRecord,
            GoalState,
            persist_goal_state,
            restore_goal_state,
        )
        ts_registered = int(time.time() * 1000) - 5000
        ts_resolved = int(time.time() * 1000)
        gate = DecisionGateRecord(
            round=2,
            decision="revise",
            note="human note text",
            resolved_by="human",
            registered_at_ms=ts_registered,
            rejection_note="please add unit tests for edge cases",
            outcome="revise",
            resolved_at_ms=ts_resolved,
        )
        state = GoalState(
            goal_id="fully-resolved-gate-roundtrip",
            mode="advisory",
            predicates=[],
            predicates_hash="abcdef01",
            decision_gates=[gate],
        )
        persist_goal_state(state, root=tmp_path)
        restored = restore_goal_state("fully-resolved-gate-roundtrip", root=tmp_path)
        assert len(restored.decision_gates) == 1
        g = restored.decision_gates[0]
        assert g.round == 2
        assert g.decision == "revise"
        assert g.note == "human note text"
        assert g.resolved_by == "human"
        assert g.registered_at_ms == ts_registered
        assert g.rejection_note == "please add unit tests for edge cases"
        assert g.outcome == "revise"
        assert g.resolved_at_ms == ts_resolved
