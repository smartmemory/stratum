"""STRAT-GUARD — standalone guarded-transition primitive.

A resource-agnostic, tamper-evident state machine over the FlowState-light
``run_judge`` verifier. Any client (e.g. compose's feature tracker) can register
a transition graph with per-edge evidence predicates and get strict, independently
verified, append-only-audited transitions without standing up a stratum flow.

See ``docs/features/STRAT-GUARD/`` for design + blueprint.
"""

from .errors import (
    GuardError,
    GuardAlreadyRegistered,
    GuardNotFound,
    GuardTampered,
    IllegalEdge,
    StaleFromState,
    IdempotencyConflict,
    LedgerCorrupt,
    InvalidStateName,
    InvalidWorkspaceRoot,
    CommandExecutionDisabled,
    ParanoidEdgeNeedsTrustedEvidence,
    EvidenceParseError,
    OverrideUnavailable,
    ResourceIdMismatch,
)
from .fingerprint import guard_checksum
from .store import (
    GuardRegistry,
    LedgerEntry,
    GUARDS_DIR,
)
from .transition import (
    register_guard,
    guard_transition,
    guard_override,
    guard_migrate,
    guard_history,
)

__all__ = [
    "GuardError",
    "GuardAlreadyRegistered",
    "GuardNotFound",
    "GuardTampered",
    "IllegalEdge",
    "StaleFromState",
    "IdempotencyConflict",
    "LedgerCorrupt",
    "InvalidStateName",
    "InvalidWorkspaceRoot",
    "CommandExecutionDisabled",
    "ParanoidEdgeNeedsTrustedEvidence",
    "EvidenceParseError",
    "OverrideUnavailable",
    "ResourceIdMismatch",
    "guard_checksum",
    "GuardRegistry",
    "LedgerEntry",
    "GUARDS_DIR",
    "register_guard",
    "guard_transition",
    "guard_override",
    "guard_migrate",
    "guard_history",
]
