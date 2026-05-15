"""Dataclasses for the STRAT-JUDGE v1 kernel.

The on-the-wire shape is the JSON Schema at
``compose/contracts/judge-result.json`` — these dataclasses are the in-process
Python representation. ``JudgeResult.to_dict()`` is the canonical adapter; any
divergence is a bug.

Invariant enforced at construction time: ``clean == met``. The kernel writes
both fields and they must agree by definition. This is what keeps existing
ensure-clauses like ``result.clean == True`` working unchanged for judge-
produced results.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Optional

TierName = Literal["T1", "T1.5", "T2", "T3", "T4"]
Verdict = Literal["met", "not_met", "ambiguous", "n/a"]
PredicateType = Literal["deterministic", "verified", "judged"]
Stakes = Literal["cheap", "default", "paranoid"]


@dataclass(frozen=True)
class Predicate:
    """Caller-supplied predicate. v1 uses the ``user`` decomposer only —
    the caller hands these in pre-decomposed. ``applied_gate`` defaults
    to 7, mirroring the review-finding confidence convention.
    """

    id: str
    type: PredicateType
    statement: str
    applied_gate: int = 7


@dataclass(frozen=True)
class Evidence:
    """One citation produced by T2. ``source`` must match the canonical
    ``<bucket>/<path>:<line>`` shape and resolve under the current turn's
    staging tree; otherwise the kernel raises ``CitationFormatError``.
    """

    source: str
    quote: str
    tier: TierName


@dataclass
class TierRecord:
    """One tier's verdict on a single predicate. ``confidence`` is ``None``
    for T1's ``verdict='n/a'`` case (no LLM ran) and integer 1–10 otherwise.
    """

    tier: TierName
    verdict: Verdict
    confidence: Optional[int]
    reason: str


@dataclass
class PredicateResult:
    """Per-predicate aggregate after all tiers have run. The fields are
    post-normalized — a raw ``met`` verdict whose confidence falls below
    the predicate's ``applied_gate`` is downgraded to ``ambiguous`` before
    this struct is constructed.
    """

    id: str
    type: PredicateType
    statement: str
    verdict: Verdict
    confidence: int
    applied_gate: int
    evidence: list[Evidence]
    tier_history: list[TierRecord]


@dataclass
class BudgetConsumed:
    turns: int = 0
    dollars: float = 0.0
    wall_clock_s: float = 0.0


@dataclass(frozen=True)
class BudgetCaps:
    """v1 budget shape. Distinct from the IR's ``IRBudgetDef(ms, usd)``
    because the judge needs an explicit turn count (an iteration concept
    the IR budget doesn't model). The MCP tool parses the input ``budget``
    dict into this struct before dispatching to ``run_judge``.

    v1 enforcement:
      * ``max_turns`` — checked at entry as a gate (BudgetExceededError).
      * ``max_wall_clock_s`` — checked per predicate inside the loop.
      * ``max_dollars`` — recorded in ``BudgetConsumed`` but not enforced.
    """

    max_turns: Optional[int] = None
    max_dollars: Optional[float] = None
    max_wall_clock_s: Optional[float] = None


@dataclass
class JudgeKernelMeta:
    decomposer_mode: Literal["user", "auto", "hybrid", "ask"] = "user"
    smartmemory_priors_consulted: int = 0
    degraded_judged: bool = False


@dataclass
class TurnVerdict:
    """One row of the per-turn audit log written to
    ``~/.stratum/judge/<flow_id>/turns.jsonl``. Schema version 1.0.
    """

    turn: int
    tier: TierName
    predicate_id: str
    verdict: Verdict
    confidence: Optional[int]
    timestamp_ms: int


@dataclass
class JudgeOutcome:
    """Final per-step result persisted into ``FlowState.judge_outcome``."""

    met: bool
    predicate_results: list[PredicateResult]


@dataclass
class JudgeResult:
    """Top-level output of ``run_judge``. Strict superset of
    ``CrossModelReviewResult`` — existing review consumers
    (``compose/lib/build.js`` mergedResult path, cockpit UI,
    ``result.clean == True`` ensure-expressions) read their subset unchanged.

    Invariant: ``clean == met``. Enforced at ``__post_init__``.
    """

    # CrossModelReviewResult superset — inherited fields
    clean: bool
    summary: str
    findings: list[dict]
    meta: dict
    consensus: list[dict] = field(default_factory=list)
    claude_only: list[dict] = field(default_factory=list)
    codex_only: list[dict] = field(default_factory=list)
    lenses_run: list[str] = field(default_factory=list)
    auto_fixes: list[dict] = field(default_factory=list)
    asks: list[dict] = field(default_factory=list)

    # judge-specific additions
    judge_version: str = "1.0"
    met: bool = False
    stakes: Stakes = "default"
    predicates: list[PredicateResult] = field(default_factory=list)
    tier_disagreements: list[dict] = field(default_factory=list)
    budget_consumed: BudgetConsumed = field(default_factory=BudgetConsumed)
    judge_kernel_meta: JudgeKernelMeta = field(default_factory=JudgeKernelMeta)

    def __post_init__(self) -> None:
        if self.clean != self.met:
            raise ValueError(
                f"JudgeResult invariant violated: clean={self.clean} but met={self.met}; "
                "these must agree by construction."
            )

    def to_dict(self) -> dict[str, Any]:
        """JSON-Schema-shaped dict for emission and validation. Dataclasses
        nested inside lists are recursively converted via ``asdict``.
        """
        return {
            # inherited
            "clean": self.clean,
            "summary": self.summary,
            "findings": list(self.findings),
            "meta": dict(self.meta),
            "consensus": list(self.consensus),
            "claude_only": list(self.claude_only),
            "codex_only": list(self.codex_only),
            "lenses_run": list(self.lenses_run),
            "auto_fixes": list(self.auto_fixes),
            "asks": list(self.asks),
            # judge-specific
            "judge_version": self.judge_version,
            "met": self.met,
            "stakes": self.stakes,
            "predicates": [asdict(pr) for pr in self.predicates],
            "tier_disagreements": list(self.tier_disagreements),
            "budget_consumed": asdict(self.budget_consumed),
            "judge_kernel_meta": asdict(self.judge_kernel_meta),
        }
