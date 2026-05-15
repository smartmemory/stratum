"""Tier orchestration for the judge kernel.

``run_judge`` is the single entry point. It:

  1. Validates inputs (empty list, paranoid-stakes-in-v1, cheap-stakes
     vs non-deterministic predicates).
  2. Computes the prospective turn index and rejects up-front if it
     exceeds the caller's ``max_turns`` cap.
  3. Stages the turn (snapshot of artifacts + modified files into
     ``~/.stratum/judge/<flow_id>/<step_id>/turn-<N>/``).
  4. Iterates predicates. T1 always runs. ``verified``/``judged`` types
     additionally fire T2 in v1 (``cheap`` stakes skips T2 — but the
     caller cannot get this far with non-deterministic predicates).
  5. Normalizes ``met`` verdicts with sub-gate confidence to ``ambiguous``.
  6. Enforces wall-clock budget between predicates.
  7. Aggregates per-predicate verdicts into a :class:`JudgeResult` and
     emits findings for ``not_met``/``ambiguous``.

Concurrency: v1 is sequential. No ``asyncio.gather`` over predicates.
"""

from __future__ import annotations

import time
from pathlib import Path

from .errors import (
    BudgetExceededError,
    EmptyPredicateListError,
    StakesNotAvailableError,
    StakesPredicateMismatchError,
)
from .logging import append_turn_log
from .predicates import evaluate_t1
from .result import (
    BudgetConsumed,
    Evidence,
    JudgeKernelMeta,
    JudgeResult,
    Predicate,
    PredicateResult,
    TierRecord,
)
from .staging import stage_turn
from .verifier import evaluate_t2


async def run_judge(
    flow_id: str,
    step_id: str,
    predicates: list[Predicate],
    artifacts: dict[str, str],
    modified_files: list[str],
    stakes: str,
    budget,
    workspace_root: Path,
    stratum_agent_run,
    ctx,
) -> JudgeResult:
    # --- 1. Input validation ------------------------------------------------
    if not predicates:
        raise EmptyPredicateListError("predicates list must be non-empty")
    if stakes == "paranoid":
        raise StakesNotAvailableError(
            "'paranoid' stakes require T3 adversary; ships in v2"
        )
    if stakes == "cheap":
        non_det = [p for p in predicates if p.type != "deterministic"]
        if non_det:
            raise StakesPredicateMismatchError(
                f"'cheap' stakes rejects non-deterministic predicates: "
                f"{[p.id for p in non_det]}"
            )

    # --- 1b. Turn budget pre-check -----------------------------------------
    prospective_turn = _next_turn_index(flow_id, step_id)
    if budget and budget.max_turns and prospective_turn > budget.max_turns:
        raise BudgetExceededError(
            f"turn budget exceeded: next turn would be {prospective_turn}, "
            f"max_turns={budget.max_turns}"
        )

    # --- 2. Stage the turn -------------------------------------------------
    turn = prospective_turn
    turn_dir, turn = stage_turn(
        flow_id, step_id, turn, artifacts, modified_files, workspace_root,
    )

    # --- 3. Per-predicate tier evaluation ----------------------------------
    started_at = time.time()
    predicate_results: list[PredicateResult] = []
    degraded_judged = False

    for p in predicates:
        history: list[TierRecord] = []
        evidence: list[Evidence] = []

        # T1 always runs.
        t1 = evaluate_t1(p, str(turn_dir), artifacts, modified_files)
        history.append(t1)
        append_turn_log(
            flow_id, step_id, turn,
            {
                "predicate_id": p.id,
                "tier": "T1",
                "verdict": t1.verdict,
                "confidence": t1.confidence,
            },
        )

        if p.type == "deterministic":
            final = t1
        elif stakes == "cheap":
            # Defensive — cheap+nondet should have been rejected above.
            final = t1
        else:
            if p.type == "judged":
                degraded_judged = True
            t2, t2_ev = await evaluate_t2(p, turn_dir, stratum_agent_run, ctx)
            history.append(t2)
            evidence.extend(t2_ev)
            append_turn_log(
                flow_id, step_id, turn,
                {
                    "predicate_id": p.id,
                    "tier": "T2",
                    "verdict": t2.verdict,
                    "confidence": t2.confidence,
                },
            )
            final = t2

        # --- 4. Per-predicate normalization -------------------------------
        verdict = final.verdict
        confidence = final.confidence or 0
        if verdict == "met" and confidence < p.applied_gate:
            verdict = "ambiguous"

        predicate_results.append(
            PredicateResult(
                id=p.id,
                type=p.type,
                statement=p.statement,
                verdict=verdict,
                confidence=confidence,
                applied_gate=p.applied_gate,
                evidence=evidence,
                tier_history=history,
            )
        )

        # --- 5. Per-predicate wall-clock budget ---------------------------
        elapsed = time.time() - started_at
        if budget and budget.max_wall_clock_s and elapsed > budget.max_wall_clock_s:
            raise BudgetExceededError(
                f"wall-clock budget exceeded at {elapsed:.1f}s "
                f"(cap={budget.max_wall_clock_s}s)"
            )

    # --- 6. Aggregate ------------------------------------------------------
    met = all(pr.verdict == "met" for pr in predicate_results)
    findings = _findings_from_predicates(predicate_results)
    t1_only = all(pr.type == "deterministic" for pr in predicate_results)
    agent_type = "judge" if t1_only else "claude"
    model_id = None if t1_only else "claude-sonnet-4-6"
    summary = _build_summary(met, predicate_results, degraded_judged, agent_type)

    return JudgeResult(
        clean=met,
        summary=summary,
        findings=findings,
        meta={"agent_type": agent_type, "model_id": model_id},
        judge_version="1.0",
        met=met,
        stakes=stakes,
        predicates=predicate_results,
        tier_disagreements=[],
        budget_consumed=BudgetConsumed(
            turns=turn,
            dollars=0.0,
            wall_clock_s=time.time() - started_at,
        ),
        judge_kernel_meta=JudgeKernelMeta(
            decomposer_mode="user",
            smartmemory_priors_consulted=0,
            degraded_judged=degraded_judged,
        ),
    )


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------


def _next_turn_index(flow_id: str, step_id: str) -> int:
    """Monotonic per-(flow_id, step_id) invocation counter.

    Reads existing ``judge_history`` records from the in-memory FlowState
    (restored from disk if cold) and returns ``max(turn) + 1``. Returns 1
    when the executor module isn't importable (e.g. kernel run outside the
    MCP server in tests) or no flow exists.
    """
    try:
        from stratum_mcp.executor import _flows
    except ImportError:
        return 1
    flow = _flows.get(flow_id)
    if flow is None:
        return 1
    existing = getattr(flow, "judge_history", {}).get(step_id, [])
    distinct = {entry["turn"] for entry in existing if "turn" in entry}
    return max(distinct, default=0) + 1


def _findings_from_predicates(prs: list[PredicateResult]) -> list[dict]:
    """Emit findings for ``not_met`` and ``ambiguous`` predicates only.

    - ``not_met`` → severity ``must-fix``.
    - ``ambiguous`` → severity ``should-fix``.
    - ``met`` → no finding.
    """
    out: list[dict] = []
    for pr in prs:
        if pr.verdict == "met":
            continue
        severity = "must-fix" if pr.verdict == "not_met" else "should-fix"
        reason = pr.tier_history[-1].reason if pr.tier_history else ""
        out.append({
            "lens": "judge",
            "severity": severity,
            "finding": f"{pr.statement} — {reason}",
            "confidence": pr.confidence,
            "applied_gate": pr.applied_gate,
        })
    return out


def _build_summary(
    met: bool,
    prs: list[PredicateResult],
    degraded: bool,
    agent_type: str,
) -> str:
    n_met = sum(1 for p in prs if p.verdict == "met")
    tiers_used = sorted(
        {tr.tier for p in prs for tr in p.tier_history if tr.verdict != "n/a"}
    )
    return (
        f"judge: {n_met}/{len(prs)} predicates met "
        f"({'+'.join(tiers_used)}, {agent_type}); "
        f"degraded_judged={str(degraded).lower()}"
    )
