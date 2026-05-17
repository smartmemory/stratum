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
from .verifier import evaluate_t2, evaluate_t3


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
    # 'paranoid' is live as of STRAT-JUDGE v2 slice 1 (T3 cold-read
    # adversary). It escalates every interpretive `met` through T3.
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
    disagreements: list[dict] = []

    for p in predicates:
        history: list[TierRecord] = []
        evidence: list[Evidence] = []

        # Cold-read isolation hardening (STRAT-JUDGE v2 slice 1): buffer this
        # predicate's tier rows and flush them only AFTER T3 has run for the
        # same predicate. cwd is not a read-jail, so writing T1/T2 verdicts
        # to the shared turns.jsonl before T3 would let a Read/Grep adversary
        # walk to them. Deferring the writes makes same-predicate
        # reasoning-isolation real by ordering. (Residual: rows from OTHER
        # predicates/turns remain on disk — a hard jail is
        # STRAT-JUDGE-T3-READJAIL; this is the cheap correct mitigation.)
        pending_logs: list[dict] = []

        # Tiers run inside try/finally: pending_logs is flushed in
        # `finally` so (a) same-predicate rows never hit disk before
        # T3 (cold-read ordering) and (b) audit completeness survives
        # a mid-predicate verifier exception.
        try:
            # T1 always runs.
            t1 = evaluate_t1(p, str(turn_dir), artifacts, modified_files)
            history.append(t1)
            pending_logs.append(
                {
                    "predicate_id": p.id,
                    "tier": "T1",
                    "verdict": t1.verdict,
                    "confidence": t1.confidence,
                }
            )

            if p.type == "deterministic":
                final = t1
            elif stakes == "cheap":
                # Defensive — cheap+nondet should have been rejected above.
                final = t1
            else:
                t2, t2_ev = await evaluate_t2(p, turn_dir, stratum_agent_run, ctx)
                history.append(t2)
                evidence.extend(t2_ev)
                pending_logs.append(
                    {
                        "predicate_id": p.id,
                        "tier": "T2",
                        "verdict": t2.verdict,
                        "confidence": t2.confidence,
                    }
                )
                final = t2

                # T3 cold-read adversary — paranoid-only (STRAT-JUDGE v2 slice 1).
                # default/cheap stay byte-for-byte v1. T3 runs only over a T2
                # `met`: the adversary's job is to break met claims, not re-judge
                # not-met ones.
                ran_t3 = False
                if stakes == "paranoid" and t2.verdict == "met":
                    t3, t3_ev = await evaluate_t3(
                        p, turn_dir, stratum_agent_run, ctx
                    )
                    ran_t3 = True
                    history.append(t3)
                    evidence.extend(t3_ev)
                    pending_logs.append(
                        {
                            "predicate_id": p.id,
                            "tier": "T3",
                            "verdict": t3.verdict,
                            "confidence": t3.confidence,
                        }
                    )
                    if t3.verdict == "met":
                        final = t2  # adversary tried and failed — met stands
                    else:
                        # not_met or ambiguous: T4 quorum is deferred, so we do
                        # NOT silently pick a side — surface as ambiguous and
                        # record the disagreement (acceptable: paranoid is
                        # opt-in maximum scrutiny).
                        final = TierRecord(
                            tier="T3",
                            verdict="ambiguous",
                            confidence=t3.confidence or 0,
                            reason=f"adversary: {t3.reason}",
                        )
                        disagreements.append(
                            {
                                "predicate": p.id,
                                "tiers": ["T2", "T3"],
                                "resolution": "adversary_counterexample",
                                "t2_verdict": t2.verdict,
                                "t3_verdict": t3.verdict,
                            }
                        )

                # `degraded_judged` = a judged predicate did NOT receive
                # adversarial (T3) verification. True only when T3 did not run.
                if p.type == "judged" and not ran_t3:
                    degraded_judged = True
        finally:
            for row in pending_logs:
                append_turn_log(flow_id, step_id, turn, row)

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
        tier_disagreements=disagreements,
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
