"""STRAT-JUDGE v1 ship-gate: corpus smoke test.

Loads the first 10 candidates from the STRAT-JUDGE-POSTMORTEM corpus, builds
small hand-written predicate lists per candidate, stages each candidate's
claim text as an artifact, and runs ``stratum_judge`` end-to-end. Asserts
the kernel mechanics work against real data: result is produced, schema
validates, verdict is recorded.

This is not a judgement-quality benchmark — the corpus labels (mostly
"ambiguous") are for the v3 replay harness, not v1. v1 ships the kernel;
the calibration corpus is consumed by future work that tunes prompts and
priors.

Snapshot of results is written to ``tests/fixtures/judge_corpus_smoke.json``
so regressions in citation format, schema shape, or finding emission are
diff-able.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from jsonschema import Draft7Validator
from referencing import Registry, Resource

from stratum.judge import (
    BudgetCaps,
    JudgeResult,
    Predicate,
)
from stratum.judge.kernel import run_judge

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CORPUS_PATH = REPO_ROOT / "stratum" / ".stratum" / "postmortem" / "candidates.jsonl"
CONTRACTS_DIR = REPO_ROOT / "compose" / "contracts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def _registry() -> Registry:
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
def schema_validator() -> Draft7Validator:
    schema = json.loads((CONTRACTS_DIR / "judge-result.json").read_text())
    return Draft7Validator(schema, registry=_registry())


def _load_candidates(n: int = 10) -> list[dict]:
    assert CORPUS_PATH.exists(), f"corpus missing at {CORPUS_PATH}"
    out: list[dict] = []
    with CORPUS_PATH.open() as f:
        for line in f:
            out.append(json.loads(line))
            if len(out) >= n:
                break
    return out


def _predicates_for(candidate: dict) -> list[Predicate]:
    """Hand-crafted predicates per candidate, exercising T1 + T2 paths.

    These aren't 'is the claim correct' judgements — they test the kernel
    mechanics. Each candidate gets:
      * one deterministic predicate over staged artifact (T1 only)
      * one verified predicate (T2, exercised under a mocked stratum_agent_run)
    """
    claim_len = len(candidate.get("claim_text", "") or "")
    return [
        Predicate(
            id="claim_non_empty",
            type="deterministic",
            statement="len(file_contains.__self__ if False else open(artifacts_path('claim.txt')).read()) > 0",
            # Use a simpler, supported-builtin form below; the line above is illustrative.
            applied_gate=7,
        ),
        Predicate(
            id="claim_addresses_request",
            type="verified",
            statement="The claim_text directly addresses the request.",
            applied_gate=7,
        ),
    ]


def _simple_predicates_for(candidate: dict) -> list[Predicate]:
    """The actually-runnable predicate list — uses only v1 T1 builtins."""
    return [
        Predicate(
            id="claim_artifact_exists",
            type="deterministic",
            statement="file_exists('artifacts/claim.txt')",
            applied_gate=7,
        ),
        Predicate(
            id="claim_addresses_request",
            type="verified",
            statement="The claim_text addresses the request.",
            applied_gate=7,
        ),
    ]


async def _mock_agent_run(prompt: str, ctx, **kwargs) -> dict:
    """Stub `stratum_agent_run` that returns a deterministic T2 verdict.
    Used so the corpus test exercises the dispatch path without burning LLM
    budget. The verifier validates citations against the staged tree, so the
    mock returns a citation that resolves to a real staged file.
    """
    return {
        "text": json.dumps(
            {
                "predicate_id": "claim_addresses_request",
                "verdict": "met",
                "confidence": 8,
                "reason": "mocked T2 verdict for corpus smoke test",
                "evidence": [
                    {
                        "source": "artifacts/claim.txt:1",
                        "quote": "claim opens with topic restatement",
                        "tier": "T2",
                    }
                ],
            }
        )
    }


@pytest.mark.asyncio
async def test_kernel_runs_on_10_corpus_candidates(
    tmp_path, monkeypatch, schema_validator: Draft7Validator
) -> None:
    # Redirect JUDGE_ROOT so the test doesn't touch ~/.stratum/judge/.
    from stratum.judge import staging as staging_mod

    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")

    # Mock T2 dispatch at the boundary: stratum_agent_run is injected into
    # the kernel by the MCP handler in production; tests inject an AsyncMock.
    async def fake_agent_run(**kwargs) -> dict:
        return {
            "text": json.dumps(
                {
                    "predicate_id": "claim_addresses_request",
                    "verdict": "met",
                    "confidence": 8,
                    "reason": "mocked T2 verdict for corpus smoke test",
                    "evidence": [
                        {
                            "source": "artifacts/claim.txt:1",
                            "quote": "claim opens with topic restatement",
                            "tier": "T2",
                        }
                    ],
                }
            )
        }

    candidates = _load_candidates(10)
    assert len(candidates) == 10, "corpus must have at least 10 entries"

    snapshot: list[dict] = []
    for i, cand in enumerate(candidates):
        flow_id = f"corpus-smoke-{i}"
        step_id = "judge_step"
        # Staging appends ".txt" to each key (blueprint §4.3 convention) —
        # pass bare names so files land at artifacts/claim.txt etc.
        artifacts = {
            "claim": cand.get("claim_text", "") or "",
            "request": cand.get("request_text", "") or "",
        }
        result = await run_judge(
            flow_id=flow_id,
            step_id=step_id,
            predicates=_simple_predicates_for(cand),
            artifacts=artifacts,
            modified_files=[],
            stakes="default",
            budget=BudgetCaps(max_turns=1, max_wall_clock_s=10.0),
            workspace_root=tmp_path / "workspace",
            stratum_agent_run=fake_agent_run,
            ctx=None,
        )

        # (a) result produced
        assert isinstance(result, JudgeResult)
        # (b) schema validates
        errors = list(schema_validator.iter_errors(result.to_dict()))
        assert errors == [], f"candidate {i} produced invalid result: {errors}"
        # (c) verdict recorded
        assert isinstance(result.met, bool)
        assert len(result.predicates) == 2

        snapshot.append(
            {
                "candidate_id": cand.get("candidate_id", f"cand-{i}"),
                "met": result.met,
                "summary": result.summary,
                "predicate_verdicts": [
                    {"id": p.id, "verdict": p.verdict, "confidence": p.confidence}
                    for p in result.predicates
                ],
            }
        )

    # Write fixture snapshot so future regressions are diff-able.
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    (FIXTURES_DIR / "judge_corpus_smoke.json").write_text(
        json.dumps(snapshot, indent=2, sort_keys=True)
    )

    # All 10 succeeded.
    assert len(snapshot) == 10


def _mock_t2_record():
    """Build the (TierRecord, [Evidence]) tuple that evaluate_t2 returns."""
    from stratum.judge.result import Evidence, TierRecord

    return (
        TierRecord(
            tier="T2",
            verdict="met",
            confidence=8,
            reason="mocked T2 verdict for corpus smoke test",
        ),
        [
            Evidence(
                source="artifacts/claim.txt:1",
                quote="claim opens with topic restatement",
                tier="T2",
            )
        ],
    )
