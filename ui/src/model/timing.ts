import type { RunEvent, StepStateView } from "../data-client";

/**
 * Per-step timing. The engine persists no startedAt/endedAt per step
 * (STRATUM-CADENCE-UI-AUDIT-1 stratum-dag-check §2), so derive it:
 * start = first `ready` (or `gate_waiting`) event for the step, else the first attempt;
 * end   = last `result` / `gate_resolved` / `skipped` / `failed` event for the step, else the
 *         last attempt, only once the step is terminal.
 */
export interface StepTiming {
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
}

const START = new Set(["ready", "gate_waiting", "fanout_item_ready"]);
const END = new Set(["result", "gate_resolved", "skipped", "failed", "fanout_merge"]);
const TERMINAL = new Set(["succeeded", "failed", "skipped"]);

export function stepTiming(stepId: string, state: StepStateView | undefined, events: RunEvent[]): StepTiming {
  const mine = events.filter((event) => event.stepId === stepId);
  const startedAt = mine.find((event) => START.has(event.type))?.at ?? state?.attempts[0]?.at ?? null;
  let endedAt: string | null = null;
  if (state && TERMINAL.has(state.status)) {
    endedAt = [...mine].reverse().find((event) => END.has(event.type))?.at
      ?? state.attempts[state.attempts.length - 1]?.at
      ?? null;
  }
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const end = endedAt ? Date.parse(endedAt) : NaN;
  return { startedAt, endedAt, durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const mins = Math.round((now - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function money(usd: number | undefined): string {
  return `$${(Number(usd) || 0).toFixed(2)}`;
}

/** Compact one-line rendering of an unknown value (event detail, attempt result). */
export function preview(value: unknown, max = 160): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
