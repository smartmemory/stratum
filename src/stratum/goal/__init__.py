"""stratum.goal — worker→judge orchestrator (STRAT-GOAL v1).

Public surface:
- Error types from errors.py
- Result types from result.py (GoalResult, PredicateOutcome)
- Prompt helpers from prompts.py (build_turn_prompt, extract_artifacts, mk_turn_nonce)
- Worker validation/dispatch helpers from worker.py
- State types and persistence from state.py (GoalState, TurnRecord, DecisionGateRecord,
  ArtifactSpec, persist_goal_state, restore_goal_state, compute_predicates_hash)
- Orchestrator from orchestrator.py (run_goal) — Phase C
- Autonomy gate from autonomy.py (resolve_autonomy) — Phase C
"""

from stratum.goal.errors import (
    ArtifactExtractionError,
    GoalError,
    GoalImmutabilityError,
    GoalNotFoundError,
    NoPendingDecisionError,
    WorkerTypeNotSupportedError,
)
from stratum.goal.prompts import (
    build_turn_prompt,
    extract_artifacts,
    mk_turn_nonce,
)
from stratum.goal.result import GoalResult, PredicateOutcome
from stratum.goal.state import (
    ArtifactSpec,
    DecisionGateRecord,
    GoalState,
    TurnRecord,
    compute_predicates_hash,
    persist_goal_state,
    restore_goal_state,
)
from stratum.goal.worker import (
    WorkerFailureTracker,
    WorkerSpec,
    dispatch_worker,
    validate_worker_spec,
)
from stratum.goal.autonomy import resolve_autonomy
from stratum.goal.orchestrator import run_goal

__all__ = [
    # errors
    "GoalError",
    "GoalImmutabilityError",
    "GoalNotFoundError",
    "WorkerTypeNotSupportedError",
    "NoPendingDecisionError",
    "ArtifactExtractionError",
    # result
    "GoalResult",
    "PredicateOutcome",
    # prompts
    "build_turn_prompt",
    "extract_artifacts",
    "mk_turn_nonce",
    # worker
    "WorkerSpec",
    "validate_worker_spec",
    "dispatch_worker",
    "WorkerFailureTracker",
    # state (Phase B)
    "GoalState",
    "TurnRecord",
    "DecisionGateRecord",
    "ArtifactSpec",
    "persist_goal_state",
    "restore_goal_state",
    "compute_predicates_hash",
    # orchestrator (Phase C)
    "run_goal",
    # autonomy (Phase C)
    "resolve_autonomy",
]
