import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Offline harvest of failure signal from persisted runs.
 *
 * Reads what the engine already writes (`~/.stratum/ts/flows/*.json`) and extracts
 * nothing but failures. Deliberately NOT wired into the engine: a harvest crash must
 * never be able to fail a user's flow, and the read path has no coupling to change.
 *
 * Two sources, not one. Step failures are `result` events carrying `detail.failure`.
 * Flow-level failures — budget exhaustion above all — never appear there; they are
 * `budget_exhausted` events plus the run's top-level `failure` context. A reader that
 * takes only the first source produces zero `transient` records, which leaves the
 * classifier with no negative class.
 */

export type FailureShape = "schema" | "ensure" | "gate" | "budget" | "other";

export interface FailureRecord {
  runId: string;
  flowName: string;
  /** null for flow-level failures, which belong to no step. */
  stepId: string | null;
  /** Spec revision. Carried and reported, never used as a grouping key — it changes
   * on every spec edit, so keying on it splits one lesson into one cluster per edit. */
  specDigest?: string;
  attempt: number;
  /** Verbatim. Never interpreted here; semantics belong to the classifier. */
  reason: string;
  shape: FailureShape;
  workspaceRoot?: string;
  at: string;
  /** A later attempt of the same step succeeded — the invisible-waste marker. */
  recovered: boolean;
}

export interface HarvestResult {
  records: FailureRecord[];
  /** Run files that could not be parsed or carried no usable identity. */
  skipped: number;
  /** Individual events that looked like failures but were malformed. Counted
   * separately from `skipped`: a run that parses cleanly and then silently drops
   * half its events would otherwise report as a clean read, which is the failure
   * mode a fail-open reader is most likely to hide. */
  droppedEvents: number;
}

interface RawEvent {
  at?: unknown;
  type?: unknown;
  stepId?: unknown;
  detail?: unknown;
}

export async function harvest(flowsDir: string): Promise<HarvestResult> {
  let names: string[];
  try {
    names = (await readdir(flowsDir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    // A missing corpus is an empty corpus, not an error.
    return { records: [], skipped: 0, droppedEvents: 0 };
  }

  const records: FailureRecord[] = [];
  let skipped = 0;
  let droppedEvents = 0;

  for (const name of names) {
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(await readFile(join(flowsDir, name), "utf8")) as Record<string, unknown>;
    } catch {
      skipped += 1;
      continue;
    }
    try {
      droppedEvents += collect(run, records);
    } catch {
      skipped += 1;
    }
  }

  return { records, skipped, droppedEvents };
}

/** Returns the number of failure-shaped events that were malformed and dropped. */
function collect(run: Record<string, unknown>, out: FailureRecord[]): number {
  const runId = str(run.id);
  if (runId === undefined) throw new Error("run has no id");
  const flowName = str(run.flowName) ?? "";
  const workspaceRoot = str(run.workspaceRoot);
  const specDigest = str(run.revisionDigest);
  const events = Array.isArray(run.events) ? (run.events as RawEvent[]) : [];

  let dropped = 0;

  for (const [index, event] of events.entries()) {
    const type = str(event.type);
    const detail = isRecord(event.detail) ? event.detail : undefined;
    if (detail === undefined) continue;

    if (type === "result") {
      if (!("failure" in detail)) continue;
      // `failure` is a string in some drifted runs: failure-shaped but unusable.
      const failure = isRecord(detail.failure) ? detail.failure : undefined;
      if (failure === undefined) { dropped += 1; continue; }
      const reason = str(failure.reason);
      if (reason === undefined) { dropped += 1; continue; }
      const stepId = str(event.stepId) ?? null;
      out.push({
        runId,
        flowName,
        stepId,
        ...(specDigest !== undefined ? { specDigest } : {}),
        attempt: num(failure.attempt) ?? num(detail.attempt) ?? 0,
        reason,
        shape: shapeOf(reason),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        at: str(event.at) ?? "",
        recovered: stepId !== null && succeededAfter(events, stepId, index),
      });
      continue;
    }

    if (type === "budget_exhausted") {
      const reason = str(detail.reason);
      if (reason === undefined) { dropped += 1; continue; }
      out.push({
        runId,
        flowName,
        stepId: null,
        ...(specDigest !== undefined ? { specDigest } : {}),
        attempt: num(detail.attempt) ?? 0,
        reason,
        shape: "budget",
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        at: str(event.at) ?? "",
        recovered: false,
      });
    }
  }

  return dropped;
}

/**
 * Did this step succeed AFTER this failure? Position matters: a success recorded
 * earlier in the run says nothing about whether this failure was recovered, and
 * treating it as recovery overstates what the evidence shows.
 */
function succeededAfter(events: RawEvent[], stepId: string, afterIndex: number): boolean {
  for (let i = afterIndex + 1; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined || str(event.type) !== "result") continue;
    if (str(event.stepId) !== stepId) continue;
    const detail = isRecord(event.detail) ? event.detail : undefined;
    if (detail !== undefined && !isRecord(detail.failure)) return true;
  }
  return false;
}

function shapeOf(reason: string): FailureShape {
  const trimmed = reason.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "schema";
  if (/budget exhausted/i.test(reason)) return "budget";
  if (trimmed.startsWith("ensure")) return "ensure";
  if (trimmed.startsWith("gate")) return "gate";
  return "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
