"""STRAT-GOAL v1 ship-gate: adversarial corpus driver.

Parametrizes over ``tests/fixtures/goal-adversarial.jsonl`` — hand-crafted
"looks-met-but-isn't" cases. For each case:

  1. Constructs a stubbed ``dispatch_worker_callable`` returning
     ``entry["stub_worker_output"]`` wrapped in the artifact fence.
  2. Constructs a stubbed ``run_judge_callable`` that returns a JudgeResult
     built from ``entry["stub_judge_predicate_outputs"]``.
  3. Runs ``run_goal(mode="shadow", shadow_source="driven")``.
  4. Asserts ``result.would_have_decided != "met"``.

The test is deterministic (no live model dispatch) and must run in < 5s.
Failure here means the orchestrator's predicate-aggregation/verdict-derivation
logic misreads kernel verdicts and would falsely complete a goal.

Pattern mirrors ``stratum/tests/test_judge_corpus.py:150-195``.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
ADVERSARIAL_CORPUS = FIXTURES_DIR / "goal-adversarial.jsonl"


# ---------------------------------------------------------------------------
# Fixture loading
# ---------------------------------------------------------------------------

def _load_corpus() -> list[dict]:
    """Load all entries from goal-adversarial.jsonl."""
    entries = []
    with open(ADVERSARIAL_CORPUS) as fh:
        for line in fh:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries


_CORPUS = _load_corpus()


# ---------------------------------------------------------------------------
# Stub builders
# ---------------------------------------------------------------------------

def _build_stub_worker(case: dict):
    """Return an async callable that emits stub_worker_output as an artifact block."""
    stub_output = case["stub_worker_output"]
    artifact_names = [a["name"] for a in case.get("artifact_contract", [])]

    async def stub_worker(prompt: str, worker_spec: dict, correlation_id: str, *, ctx=None):
        # Extract the nonce from the prompt so the artifact fence is accepted
        nonce = "stubNonce"
        if "===ARTIFACT-" in prompt:
            try:
                nonce = prompt.split("===ARTIFACT-")[1].split(":")[0]
            except IndexError:
                pass

        parts = []
        for name in artifact_names:
            parts.append(
                f"===ARTIFACT-{nonce}:{name}===\n{stub_output}\n===END==="
            )
        response_text = "\n".join(parts) if parts else stub_output
        return (response_text, correlation_id)

    return stub_worker


def _build_stub_judge(case: dict):
    """Return an async callable that returns a JudgeResult built from
    stub_judge_predicate_outputs."""
    stub_outputs = case["stub_judge_predicate_outputs"]

    async def stub_judge(**kwargs):
        from stratum.judge.result import (
            BudgetConsumed, Evidence, JudgeKernelMeta, JudgeResult,
            PredicateResult, TierRecord,
        )

        pred_results = []
        all_met = True
        for po in stub_outputs:
            verdict = po["verdict"]
            if verdict != "met":
                all_met = False
            confidence = po.get("confidence", 5)
            applied_gate = 7
            evidence = [
                Evidence(
                    source=e.get("source", "artifacts/stub.txt:1"),
                    quote=e.get("quote", "stub"),
                    tier=e.get("tier", "T1"),
                )
                for e in po.get("evidence", [])
            ]
            pred_results.append(PredicateResult(
                id=po["predicate_id"],
                type="deterministic",
                statement=f"stub statement for {po['predicate_id']}",
                verdict=verdict,
                confidence=confidence,
                applied_gate=applied_gate,
                evidence=evidence,
                tier_history=[
                    TierRecord(tier="T1", verdict=verdict, confidence=confidence, reason=po.get("reason", "stub")),
                ],
            ))

        findings = []
        for po in stub_outputs:
            if po["verdict"] != "met":
                findings.append({
                    "predicate_id": po["predicate_id"],
                    "verdict": po["verdict"],
                    "reason": po.get("reason", "not met"),
                })

        return JudgeResult(
            clean=all_met,
            met=all_met,
            summary="Stub judge result for adversarial corpus case",
            findings=findings,
            meta={"agent_type": "judge", "model_id": "stub"},
            stakes="default",
            predicates=pred_results,
            budget_consumed=BudgetConsumed(turns=1),
            judge_kernel_meta=JudgeKernelMeta(),
        )

    return stub_judge


# ---------------------------------------------------------------------------
# Parametrized adversarial test
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "case",
    _CORPUS,
    ids=[c["case_id"] for c in _CORPUS],
)
@pytest.mark.asyncio
async def test_adversarial_case_not_met(case: dict, tmp_path: Path) -> None:
    """Each adversarial case must produce would_have_decided != 'met'.

    The orchestrator's verdict-aggregation logic is under test — not the
    live model. All worker and judge boundaries are stubbed.
    """
    import sys
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

    from stratum.goal.orchestrator import run_goal
    from stratum.judge.result import Predicate

    predicates = [
        Predicate(
            id=p["id"],
            type=p.get("type", "deterministic"),
            statement=p["statement"],
            applied_gate=p.get("applied_gate", 7),
        )
        for p in case["predicates"]
    ]

    stub_worker = _build_stub_worker(case)
    stub_judge = _build_stub_judge(case)

    result = await run_goal(
        goal_id=f"adversarial-{case['case_id']}",
        predicates=predicates,
        mode="shadow",
        shadow_source="driven",
        dispatch_worker_callable=stub_worker,
        run_judge_callable=stub_judge,
        stratum_agent_run_callable=AsyncMock(return_value={"text": "", "correlation_id": "stub"}),
        stratum_gate_resolve_callable=AsyncMock(return_value={}),
        smart_memory_search_callable=None,
        ctx=None,
        prompt=case.get("prompt", "do the task"),
        artifact_contract=case.get("artifact_contract"),
        budget={"max_turns": 3},
        goal_state_root=tmp_path / "goal",
        flow_state_root=tmp_path / "flows",
    )

    # Core assertion: the adversarial case must NOT be reported as met
    assert result.would_have_decided != "met", (
        f"Adversarial case {case['case_id']!r} was incorrectly identified as 'met'. "
        f"would_have_decided={result.would_have_decided!r}, status={result.status!r}. "
        f"Expected 'not_met' or 'ambiguous'. "
        f"This indicates the orchestrator's predicate-aggregation logic is misreading "
        f"kernel verdicts."
    )

    # The expected verdict must match
    expected = case.get("expected_would_have_decided", "not_met")
    assert result.would_have_decided == expected, (
        f"Case {case['case_id']!r}: expected would_have_decided={expected!r}, "
        f"got {result.would_have_decided!r}"
    )
