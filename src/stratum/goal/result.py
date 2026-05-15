"""Dataclasses for STRAT-GOAL v1 output.

The on-the-wire shape is ``compose/contracts/goal-result.json`` — these
dataclasses are the in-process Python representation. ``GoalResult.to_dict()``
is the canonical adapter; any divergence is a bug.

``GoalResult`` is a superset of ``JudgeResult``. ``to_dict()`` inlines
``JudgeResult.to_dict()`` and adds the goal-specific fields.

Invariant (inherited from JudgeResult): ``clean == met``. Checked at
construction time via the underlying JudgeResult.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from stratum.judge.result import JudgeResult

GoalMode = Literal["shadow", "advisory", "autonomous"]
GoalStatus = Literal["met", "not_met", "awaiting_decision", "budget_exhausted", "killed"]
WouldHaveDecided = Literal["met", "not_met", "ambiguous"]
PredicateType = Literal["deterministic", "verified", "judged"]
Verdict = Literal["met", "not_met", "ambiguous"]


@dataclass
class PredicateOutcome:
    """Per-predicate outcome after the autonomy partition.

    One entry per predicate in the goal's predicate list. Emitted in every
    ``GoalResult.to_dict()`` payload.
    """

    id: str
    type: PredicateType
    verdict: Verdict
    confidence: int
    applied_gate: int
    judge_verdict: Verdict
    bound_autonomously: bool
    awaiting_human: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "verdict": self.verdict,
            "confidence": self.confidence,
            "applied_gate": self.applied_gate,
            "judge_verdict": self.judge_verdict,
            "bound_autonomously": self.bound_autonomously,
            "awaiting_human": self.awaiting_human,
        }


@dataclass
class GoalResult:
    """Top-level output of ``run_goal``.

    Superset of ``JudgeResult`` — the ``judge_result`` field carries the final
    turn's judge verdict; ``to_dict()`` inlines its payload and adds the
    goal-orchestrator fields.

    ``would_have_decided`` is ``None`` when the field must be omitted from the
    serialised dict (zero-turn shadow edge case, or non-shadow modes where the
    field is not applicable). Pass ``None`` to omit; any string value causes
    the key to appear.
    """

    judge_result: JudgeResult
    goal_id: str
    mode: GoalMode
    status: GoalStatus
    turns_run: int
    worker_runs: list[dict]
    round: int
    predicate_outcomes: list[PredicateOutcome]
    would_have_decided: Optional[WouldHaveDecided] = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-Schema-shaped dict for emission and validation.

        Inlines JudgeResult.to_dict() (inherited fields) and adds the
        goal-specific top-level fields. The ``would_have_decided`` key is
        omitted entirely when ``self.would_have_decided is None`` (PRD M5).
        """
        base = self.judge_result.to_dict()
        goal_fields: dict[str, Any] = {
            "goal_id": self.goal_id,
            "goal_version": "1.0",
            "mode": self.mode,
            "status": self.status,
            "turns_run": self.turns_run,
            "worker_runs": list(self.worker_runs),
            "round": self.round,
            "predicate_outcomes": [po.to_dict() for po in self.predicate_outcomes],
        }
        if self.would_have_decided is not None:
            goal_fields["would_have_decided"] = self.would_have_decided

        return {**base, **goal_fields}
