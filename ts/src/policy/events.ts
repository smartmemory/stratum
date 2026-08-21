import type { LedgerEntry } from "../guard/store.js";
import type { EnforcementEvent, RuleVerdict } from "./types.js";

export function buildGuardTransitionEvent(options: {
  runId: string;
  bundleId: string;
  resourceId: string;
  entry: LedgerEntry;
  rulesEvaluated: RuleVerdict[];
  resolvedByUserId?: string;
  occurredAt?: string;
}): EnforcementEvent {
  const { entry } = options;
  return {
    event_id: `${options.runId}:${entry.entry_digest}`,
    kind: "guard_transition",
    run_id: options.runId,
    bundle_id: options.bundleId,
    runner: "local",
    occurred_at: options.occurredAt ?? new Date().toISOString(),
    resource_id: options.resourceId,
    from_state: entry.from_state,
    to_state: entry.to_state,
    outcome: entry.outcome,
    resolved_by: entry.resolved_by as "agent" | "human",
    ...(options.resolvedByUserId !== undefined ? { resolved_by_user_id: options.resolvedByUserId } : {}),
    ...(entry.rationale !== null ? { rationale: entry.rationale } : {}),
    ledger_ref: entry.entry_digest,
    entry_digest: entry.entry_digest,
    prev_digest: entry.prev_digest,
    ...(entry.payload_digest !== null ? { payload_digest: entry.payload_digest } : {}),
    rules_evaluated: structuredClone(options.rulesEvaluated),
  };
}

export function buildGateResolutionEvent(options: {
  runId: string;
  bundleId: string;
  stepId: string;
  round: number;
  outcome: "approve" | "revise" | "kill";
  resolvedByUserId?: string;
  occurredAt?: string;
}): EnforcementEvent {
  return {
    event_id: `${options.runId}:gate:${options.stepId}:${options.round}`,
    kind: "gate_resolution",
    run_id: options.runId,
    bundle_id: options.bundleId,
    runner: "local",
    occurred_at: options.occurredAt ?? new Date().toISOString(),
    outcome: options.outcome,
    resolved_by: "human",
    ...(options.resolvedByUserId !== undefined ? { resolved_by_user_id: options.resolvedByUserId } : {}),
    rules_evaluated: [],
  };
}

export function buildFlowTerminalEvent(options: {
  runId: string;
  bundleId: string;
  outcome: string;
  rulesEvaluated: RuleVerdict[];
  occurredAt?: string;
}): EnforcementEvent {
  return {
    event_id: `${options.runId}:flow`,
    kind: "flow_terminal",
    run_id: options.runId,
    bundle_id: options.bundleId,
    runner: "local",
    occurred_at: options.occurredAt ?? new Date().toISOString(),
    outcome: options.outcome,
    resolved_by: "agent",
    rules_evaluated: structuredClone(options.rulesEvaluated),
  };
}
