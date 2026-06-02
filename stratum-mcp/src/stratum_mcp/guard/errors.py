"""STRAT-GUARD error hierarchy.

Every error carries a stable ``error_type`` slug (the class name, lowercased-snake
by the MCP layer) so tool handlers can convert exceptions into the canonical
``{status: "error", error_type, message}`` dict without leaking tracebacks.
"""

from __future__ import annotations


class GuardError(Exception):
    """Base class for all guard errors. ``error_type`` defaults to the class name."""

    error_type: str = "guard_error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class GuardAlreadyRegistered(GuardError):
    error_type = "guard_already_registered"


class GuardNotFound(GuardError):
    error_type = "guard_not_found"


class GuardTampered(GuardError):
    error_type = "guard_tampered"


class IllegalEdge(GuardError):
    error_type = "illegal_edge"


class StaleFromState(GuardError):
    error_type = "stale_from_state"


class IdempotencyConflict(GuardError):
    error_type = "idempotency_conflict"


class LedgerCorrupt(GuardError):
    error_type = "ledger_corrupt"


class InvalidStateName(GuardError):
    error_type = "invalid_state_name"


class InvalidWorkspaceRoot(GuardError):
    error_type = "invalid_workspace_root"


class CommandExecutionDisabled(GuardError):
    error_type = "command_execution_disabled"


class ParanoidEdgeNeedsTrustedEvidence(GuardError):
    error_type = "paranoid_edge_needs_trusted_evidence"


class EvidenceParseError(GuardError):
    error_type = "evidence_parse_error"


class OverrideUnavailable(GuardError):
    error_type = "override_unavailable"


class ResourceIdMismatch(GuardError):
    error_type = "resource_id_mismatch"
