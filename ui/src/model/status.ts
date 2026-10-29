import type { DisplayStatus, StepKind, StepStatus } from "../data-client";

/**
 * Status → style. Each entry names a CSS custom property (themeable by the host) and a
 * fallback colour (the Base44 "Stratum Studio" palette). `live` marks statuses that pulse.
 */
export interface Tone {
  label: string;
  /** CSS colour expression: `var(--stratum-<x>, <fallback>)`. */
  color: string;
  live: boolean;
}

const tone = (token: string, fallback: string, label: string, live = false): Tone => ({
  label,
  color: `var(--stratum-${token}, ${fallback})`,
  live,
});

export const STEP_TONES: Record<StepStatus, Tone> = {
  pending: tone("pending", "#8b9099", "pending"),
  ready: tone("ready", "#38bdf8", "ready"),
  running: tone("running", "#f59e0b", "running", true),
  waiting_gate: tone("waiting", "#a78bfa", "waiting gate", true),
  succeeded: tone("succeeded", "#10b981", "succeeded"),
  failed: tone("failed", "#ef4444", "failed"),
  skipped: tone("skipped", "#6b7280", "skipped"),
};

export const RUN_TONES: Record<DisplayStatus, Tone> = {
  running: tone("running", "#f59e0b", "running", true),
  awaiting_gate: tone("waiting", "#a78bfa", "awaiting gate", true),
  complete: tone("succeeded", "#10b981", "complete"),
  failed: tone("failed", "#ef4444", "failed"),
  killed: tone("killed", "#f97316", "killed"),
  cancelled: tone("skipped", "#6b7280", "cancelled"),
  budget_exhausted: tone("budget", "#fbbf24", "budget exhausted"),
};

export const KIND_TONES: Record<StepKind, Tone> = {
  do: tone("kind-do", "#38bdf8", "do"),
  set: tone("kind-set", "#94a3b8", "set"),
  gate: tone("kind-gate", "#a78bfa", "gate"),
  fanout: tone("kind-fanout", "#22d3ee", "fanout"),
  run: tone("kind-run", "#fbbf24", "run"),
  evaluate: tone("kind-evaluate", "#34d399", "evaluate"),
};

const UNKNOWN: Tone = tone("pending", "#8b9099", "unknown");

export function stepTone(status: string | undefined): Tone {
  return (status && STEP_TONES[status as StepStatus]) || { ...UNKNOWN, label: status ?? "pending" };
}

export function runTone(status: string | undefined): Tone {
  return (status && RUN_TONES[status as DisplayStatus]) || { ...UNKNOWN, label: status ?? "unknown" };
}

export function kindTone(kind: string | undefined): Tone {
  return (kind && KIND_TONES[kind as StepKind]) || KIND_TONES.do;
}

const EVENT_TOKENS: Record<string, [string, string]> = {
  planned: ["pending", "#8b9099"],
  ready: ["ready", "#38bdf8"],
  result: ["succeeded", "#34d399"],
  judged: ["ready", "#38bdf8"],
  routed: ["waiting", "#a78bfa"],
  skipped: ["skipped", "#6b7280"],
  gate_waiting: ["waiting", "#a78bfa"],
  gate_resolved: ["succeeded", "#10b981"],
  fanout_item_ready: ["kind-fanout", "#22d3ee"],
  fanout_item_dispatched: ["kind-fanout", "#22d3ee"],
  fanout_attempt_result: ["kind-fanout", "#22d3ee"],
  fanout_merge: ["kind-fanout", "#22d3ee"],
  step_reset: ["running", "#f59e0b"],
  usage_debit: ["budget", "#fbbf24"],
  completed: ["succeeded", "#10b981"],
  failed: ["failed", "#ef4444"],
  budget_exhausted: ["budget", "#fbbf24"],
  flow_cancelled: ["skipped", "#6b7280"],
};

export function eventColor(type: string): string {
  const entry = EVENT_TOKENS[type] ?? ["pending", "#8b9099"];
  return `var(--stratum-${entry[0]}, ${entry[1]})`;
}
