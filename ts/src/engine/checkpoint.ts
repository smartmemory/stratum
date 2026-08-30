import type { CheckpointSnapshot, PersistedRun } from "./state.js";

/**
 * Python FlowState -> TS PersistedRun checkpoint mapping:
 * step_outputs / attempts / iteration state -> steps
 * records / child_audits / judge history -> events
 * round / rounds -> rounds
 * terminal_status -> status / output / failure
 * budget state -> flowSpent
 * detached/fanout mutable state -> cancelRequested / parallel
 */
export const CHECKPOINT_FIELDS = [
  "status", "output", "failure", "flowSpent", "rounds", "steps", "events", "policy_verdicts", "cancelRequested", "parallel",
] as const satisfies readonly (keyof PersistedRun)[];

export type CheckpointField = (typeof CHECKPOINT_FIELDS)[number];

/** Immutable identity/config fields plus the deliberately non-recursive checkpoint map. */
export const CHECKPOINT_EXCLUDED = {
  id: "immutable run identity",
  spec: "immutable validated specification",
  revisionDigest: "immutable digest of the validated effective specification",
  generationCounter: "monotonic issuance identity that must never roll back",
  receiptCounter: "monotonic receipt identity that must never roll back",
  input: "immutable flow input",
  flowName: "immutable flow selection",
  workspaceRoot: "immutable execution configuration",
  bundle_id: "immutable policy bundle identity",
  policy_rules: "immutable rule to ensure correlation",
  policy_rules_version: "immutable scoped policy-rule format version",
  bgDriven: "ownership metadata set by background-run setup, not flow advancement",
  receipts: "append-only cost receipt spine that must never roll back",
  checkpoints: "checkpoint maps are not nested inside snapshots",
} as const satisfies Record<Exclude<keyof PersistedRun, CheckpointField>, string>;

export function commitCheckpoint(run: PersistedRun, label: string): void {
  const snapshot = Object.fromEntries(CHECKPOINT_FIELDS.flatMap((field) =>
    Object.hasOwn(run, field) ? [[field, structuredClone(run[field])]] : [])) as CheckpointSnapshot;
  run.checkpoints ??= [];
  const existing = run.checkpoints.find((entry) => entry.label === label);
  // Overwrite-same-label keeps the label's original position (parity with a dict
  // reassignment); a new label appends.
  if (existing) existing.snapshot = snapshot;
  else run.checkpoints.push({ label, snapshot });
}

export function revertCheckpoint(run: PersistedRun, label: string): boolean {
  const entry = run.checkpoints?.find((candidate) => candidate.label === label);
  if (entry === undefined) return false;
  const restored = structuredClone(entry.snapshot) as Record<CheckpointField, unknown>;
  const mutableRun = run as unknown as Record<CheckpointField, unknown>;
  for (const field of CHECKPOINT_FIELDS) {
    if (Object.hasOwn(restored, field)) mutableRun[field] = restored[field];
    else if (field === "policy_verdicts") continue;
    else delete mutableRun[field];
  }
  return true;
}
