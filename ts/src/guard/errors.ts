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
  constructor(
    readonly errorType: GuardErrorType,
    message: string,
  ) {
    super(message);
    this.name = "GuardError";
  }

  toEnvelope(): GuardErrorEnvelope {
    return guardErrorEnvelope(this.errorType, this.message);
  }
}

export function guardErrorEnvelope(errorType: GuardErrorType, message: string): GuardErrorEnvelope {
  return { status: "error", error_type: errorType, message };
}
