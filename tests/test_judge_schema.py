"""Schema-validation tests for STRAT-JUDGE v1.

These cross-cut Phase A (contracts) and Phase B (kernel dataclasses) — every
JudgeResult.to_dict() must validate against compose/contracts/judge-result.json,
and the inherited cross-model-review-result.json / review-result.json must
accept the new ``"judge"`` agent_type.
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from jsonschema import Draft7Validator
from referencing import Registry, Resource

from stratum.judge import (
    BudgetCaps,
    BudgetConsumed,
    JudgeKernelMeta,
    JudgeResult,
    Predicate,
    PredicateResult,
    TierRecord,
)

CONTRACTS_DIR = (
    Path(__file__).resolve().parent.parent.parent / "compose" / "contracts"
)


def _registry() -> Registry:
    """Build a referencing Registry over compose/contracts/*.json so allOf
    references resolve correctly during validation."""
    resources = []
    for name in (
        "review-result.json",
        "cross-model-review-result.json",
        "judge-result.json",
    ):
        contents = json.loads((CONTRACTS_DIR / name).read_text())
        resources.append((name, Resource.from_contents(contents)))
    return Registry().with_resources(resources)


@pytest.fixture(scope="module")
def validator() -> Draft7Validator:
    schema = json.loads((CONTRACTS_DIR / "judge-result.json").read_text())
    return Draft7Validator(schema, registry=_registry())


# ----------------------------------------------------------------------------
# Agent-type enum
# ----------------------------------------------------------------------------


def test_review_result_enum_includes_judge() -> None:
    schema = json.loads((CONTRACTS_DIR / "review-result.json").read_text())
    enum = schema["properties"]["meta"]["properties"]["agent_type"]["enum"]
    assert "judge" in enum
    assert "claude" in enum  # additive — old values preserved
    assert "codex" in enum


# ----------------------------------------------------------------------------
# JudgeResult round-trip
# ----------------------------------------------------------------------------


def _minimal_predicate_result(verdict: str = "met", conf: int = 9) -> PredicateResult:
    return PredicateResult(
        id="p1",
        type="deterministic",
        statement="file_exists('artifacts/log.txt')",
        verdict=verdict,
        confidence=conf,
        applied_gate=7,
        evidence=[],
        tier_history=[
            TierRecord(tier="T1", verdict=verdict, confidence=conf, reason="ok")
        ],
    )


def _minimal_result(*, met: bool, predicates: list[PredicateResult]) -> JudgeResult:
    return JudgeResult(
        clean=met,
        met=met,
        stakes="default",
        summary=f"judge: {'1/1' if met else '0/1'} predicates met",
        findings=[],
        meta={"agent_type": "judge", "model_id": None},
        predicates=predicates,
        budget_consumed=BudgetConsumed(turns=1, dollars=0.0, wall_clock_s=0.01),
        judge_kernel_meta=JudgeKernelMeta(decomposer_mode="user"),
    )


def test_minimal_met_result_validates(validator: Draft7Validator) -> None:
    result = _minimal_result(met=True, predicates=[_minimal_predicate_result()])
    errors = list(validator.iter_errors(result.to_dict()))
    assert errors == [], errors


def test_not_met_with_finding_validates(validator: Draft7Validator) -> None:
    pr = _minimal_predicate_result(verdict="not_met", conf=10)
    result = JudgeResult(
        clean=False,
        met=False,
        stakes="default",
        summary="judge: 0/1 predicates met",
        findings=[
            {
                "lens": "judge",
                "severity": "must-fix",
                "finding": "file_exists('artifacts/log.txt') — file missing",
                "confidence": 10,
                "applied_gate": 7,
            }
        ],
        meta={"agent_type": "judge", "model_id": None},
        predicates=[pr],
        budget_consumed=BudgetConsumed(turns=1, dollars=0.0, wall_clock_s=0.01),
        judge_kernel_meta=JudgeKernelMeta(decomposer_mode="user"),
    )
    errors = list(validator.iter_errors(result.to_dict()))
    assert errors == [], errors


def test_evidence_citation_format_enforced(validator: Draft7Validator) -> None:
    """Bad citation source should fail schema validation."""
    pr = PredicateResult(
        id="p1",
        type="verified",
        statement="tests passed",
        verdict="met",
        confidence=9,
        applied_gate=7,
        evidence=[
            # Missing bucket prefix — should fail the regex.
            {"source": "pytest_output.txt:42", "quote": "ok", "tier": "T2"}  # type: ignore[list-item]
        ],
        tier_history=[
            TierRecord(tier="T2", verdict="met", confidence=9, reason="ok")
        ],
    )
    result = _minimal_result(met=True, predicates=[pr])
    errors = list(validator.iter_errors(result.to_dict()))
    assert errors, "expected schema rejection for malformed citation"


def test_predicates_empty_allowed_for_zero_turn_results(validator: Draft7Validator) -> None:
    """Empty predicates list is permitted at the schema layer (STRAT-GOAL v1 loosening) —
    zero-turn results from budget exhaustion before any judge call must serialise."""
    result = JudgeResult(
        clean=True,
        met=True,
        stakes="cheap",
        summary="vacuous",
        findings=[],
        meta={"agent_type": "judge", "model_id": None},
        predicates=[],
        budget_consumed=BudgetConsumed(turns=1, dollars=0.0, wall_clock_s=0.01),
        judge_kernel_meta=JudgeKernelMeta(decomposer_mode="user"),
    )
    errors = list(validator.iter_errors(result.to_dict()))
    assert not errors, f"expected no schema errors, got {errors}"


# ----------------------------------------------------------------------------
# clean == met invariant (enforced at dataclass construction)
# ----------------------------------------------------------------------------


def test_clean_met_invariant_clean_true_met_false() -> None:
    with pytest.raises(ValueError, match="invariant violated"):
        JudgeResult(
            clean=True,
            met=False,
            stakes="cheap",
            summary="",
            findings=[],
            meta={"agent_type": "judge", "model_id": None},
            predicates=[_minimal_predicate_result()],
            budget_consumed=BudgetConsumed(),
            judge_kernel_meta=JudgeKernelMeta(),
        )


def test_clean_met_invariant_clean_false_met_true() -> None:
    with pytest.raises(ValueError, match="invariant violated"):
        JudgeResult(
            clean=False,
            met=True,
            stakes="cheap",
            summary="",
            findings=[],
            meta={"agent_type": "judge", "model_id": None},
            predicates=[_minimal_predicate_result()],
            budget_consumed=BudgetConsumed(),
            judge_kernel_meta=JudgeKernelMeta(),
        )


# ----------------------------------------------------------------------------
# Tier name + verdict enum coverage
# ----------------------------------------------------------------------------


def test_t1_n_a_verdict_with_null_confidence_validates(
    validator: Draft7Validator,
) -> None:
    """Verified/judged predicates produce TierRecord(tier='T1', verdict='n/a',
    confidence=None) from T1 — must be schema-valid."""
    pr = PredicateResult(
        id="p1",
        type="verified",
        statement="tests pass",
        verdict="met",
        confidence=9,
        applied_gate=7,
        evidence=[
            {"source": "artifacts/pytest.txt:1", "quote": "12 passed", "tier": "T2"}  # type: ignore[list-item]
        ],
        tier_history=[
            TierRecord(tier="T1", verdict="n/a", confidence=None, reason="non-det"),
            TierRecord(tier="T2", verdict="met", confidence=9, reason="ok"),
        ],
    )
    result = _minimal_result(met=True, predicates=[pr])
    errors = list(validator.iter_errors(result.to_dict()))
    assert errors == [], errors


def test_ambiguous_predicate_emits_should_fix(validator: Draft7Validator) -> None:
    pr = _minimal_predicate_result(verdict="ambiguous", conf=5)
    result = JudgeResult(
        clean=False,
        met=False,
        stakes="default",
        summary="judge: 0/1 met",
        findings=[
            {
                "lens": "judge",
                "severity": "should-fix",
                "finding": "ambiguous result",
                "confidence": 5,
                "applied_gate": 7,
            }
        ],
        meta={"agent_type": "judge", "model_id": None},
        predicates=[pr],
        budget_consumed=BudgetConsumed(turns=1, dollars=0.0, wall_clock_s=0.0),
        judge_kernel_meta=JudgeKernelMeta(),
    )
    errors = list(validator.iter_errors(result.to_dict()))
    assert errors == [], errors
