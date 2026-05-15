"""STRAT-JUDGE — reusable tiered-judge kernel.

v1 ships T1 (deterministic predicates against staged artifacts) + T2
(Claude-only tool-using verifier with mandatory evidence citation).
Callers invoke ``run_judge(...)`` via the ``stratum_judge`` MCP tool
registered in ``stratum_mcp.server``.

The ``stratum.judge.postmortem`` subpackage is the calibration-corpus
extractor (STRAT-JUDGE-POSTMORTEM) and is independent of the kernel.

See ``docs/features/STRAT-JUDGE/{design,blueprint,plan}.md`` for the spec.
"""

from .errors import (
    BudgetExceededError,
    CitationFormatError,
    EmptyPredicateListError,
    JudgeError,
    PredicateBuiltinError,
    PredicatePathError,
    StakesNotAvailableError,
    StakesPredicateMismatchError,
)
from .result import (
    BudgetCaps,
    BudgetConsumed,
    Evidence,
    JudgeKernelMeta,
    JudgeOutcome,
    JudgeResult,
    Predicate,
    PredicateResult,
    PredicateType,
    Stakes,
    TierName,
    TierRecord,
    TurnVerdict,
    Verdict,
)

__all__ = [
    # errors
    "BudgetExceededError",
    "CitationFormatError",
    "EmptyPredicateListError",
    "JudgeError",
    "PredicateBuiltinError",
    "PredicatePathError",
    "StakesNotAvailableError",
    "StakesPredicateMismatchError",
    # types
    "BudgetCaps",
    "BudgetConsumed",
    "Evidence",
    "JudgeKernelMeta",
    "JudgeOutcome",
    "JudgeResult",
    "Predicate",
    "PredicateResult",
    "PredicateType",
    "Stakes",
    "TierName",
    "TierRecord",
    "TurnVerdict",
    "Verdict",
]
