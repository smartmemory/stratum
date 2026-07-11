/** Stable error vocabulary shared by the Python and TypeScript guard engines. */

export const GUARD_ERROR_TYPES = [
  "guard_already_registered",
  "guard_not_found",
  "guard_tampered",
  "illegal_edge",
  "stale_from_state",
  "idempotency_conflict",
  "ledger_corrupt",
  "invalid_state_name",
  "invalid_workspace_root",
  "command_execution_disabled",
  "paranoid_edge_needs_trusted_evidence",
  "evidence_parse_error",
  "override_unavailable",
  "resource_id_mismatch",
  "guard_engine_owned",
] as const;

export type GuardErrorType = (typeof GUARD_ERROR_TYPES)[number];

export type GuardErrorEnvelope = {
  status: "error";
  error_type: GuardErrorType;
  message: string;
};

/** An error transition/store code can throw; the CLI can emit its envelope. */
export class GuardError extends Error {
  readonly errorType: GuardErrorType;

  constructor(
    errorType: GuardErrorType,
    message: string,
  ) {
    super(message);
    this.errorType = errorType;
    this.name = "GuardError";
  }

  toEnvelope(): GuardErrorEnvelope {
    return guardErrorEnvelope(this.errorType, this.message);
  }
}

function namedGuardError(name: string, errorType: GuardErrorType) {
  return class extends GuardError {
    constructor(message: string) {
      super(errorType, message);
      this.name = name;
    }
  };
}

export class GuardAlreadyRegistered extends namedGuardError("GuardAlreadyRegistered", "guard_already_registered") {}
export class GuardNotFound extends namedGuardError("GuardNotFound", "guard_not_found") {}
export class GuardTampered extends namedGuardError("GuardTampered", "guard_tampered") {}
export class IllegalEdge extends namedGuardError("IllegalEdge", "illegal_edge") {}
export class StaleFromState extends namedGuardError("StaleFromState", "stale_from_state") {}
export class IdempotencyConflict extends namedGuardError("IdempotencyConflict", "idempotency_conflict") {}
export class InvalidStateName extends namedGuardError("InvalidStateName", "invalid_state_name") {}
export class InvalidWorkspaceRoot extends namedGuardError("InvalidWorkspaceRoot", "invalid_workspace_root") {}
export class CommandExecutionDisabled extends namedGuardError("CommandExecutionDisabled", "command_execution_disabled") {}
export class ParanoidEdgeNeedsTrustedEvidence extends namedGuardError("ParanoidEdgeNeedsTrustedEvidence", "paranoid_edge_needs_trusted_evidence") {}
export class EvidenceParseError extends namedGuardError("EvidenceParseError", "evidence_parse_error") {}
export class OverrideUnavailable extends namedGuardError("OverrideUnavailable", "override_unavailable") {}
export class GuardEngineOwned extends namedGuardError("GuardEngineOwned", "guard_engine_owned") {}

export class LedgerCorrupt extends GuardError {
  constructor(message: string) {
    super("ledger_corrupt", message);
    this.name = "LedgerCorrupt";
  }
}

export class ResourceIdMismatch extends GuardError {
  constructor(message: string) {
    super("resource_id_mismatch", message);
    this.name = "ResourceIdMismatch";
  }
}

export function guardErrorEnvelope(errorType: GuardErrorType, message: string): GuardErrorEnvelope {
  return { status: "error", error_type: errorType, message };
}
