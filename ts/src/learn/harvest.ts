import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Offline harvest of failure signal from persisted runs.
 *
 * Reads what the engine already writes (`~/.stratum/ts/flows/*.json`) and extracts
 * nothing but failures. Deliberately NOT wired into the engine: a harvest crash must
 * never be able to fail a user's flow, and the read path has no coupling to change.
 *
 * Step failures are `result` events carrying `detail.failure`; fanout attempts
 * carry item/stage failures in `fanout_attempt_result` events.
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
  /** Fanout identity within the parent step; absent for ordinary step failures. */
  itemIndex?: number;
  stage?: number;
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
/**
 * One run's failure records, each paired with the index of the event it came from
 * (DELIVER-1 D6: "after an offer" means a higher event index, not a later timestamp).
 * The records are exactly what `harvest()` yields for this run.
 */
export function failureRecordsOf(run: Record<string, unknown>): { records: FailureRecord[]; eventIndices: number[] } {
  const records: FailureRecord[] = [];
  const eventIndices: number[] = [];
  collect(run, records, eventIndices);
  return { records, eventIndices };
}

function collect(run: Record<string, unknown>, out: FailureRecord[], indices?: number[]): number {
  const runId = str(run.id);
  if (runId === undefined) throw new Error("run has no id");
  const flowName = str(run.flowName) ?? "";
  const workspaceRoot = str(run.workspaceRoot);
  const specDigest = str(run.revisionDigest);
  const events = Array.isArray(run.events) ? (run.events as RawEvent[]) : [];

  let dropped = 0;
  // Reset at each aggregate result so earlier batches cannot hide a later failure.
  const fanoutFailures = new Set<string>();
  // Subflow child failure reason, keyed by parent step id. failParentRunStep re-records
  // the child's exact failure on the parent `run` step, and that echo is positional:
  // the very next `result` event for the parent step after the child's failing one.
  // Any other event for the parent, or a sibling child settling, closes the echo
  // window — a later same-reason `result` for the parent is its own failure.
  const childFailures = new Map<string, string>();

  for (const [index, event] of events.entries()) {
    const type = str(event.type);
    const stepId = str(event.stepId);
    if (type !== "result" && stepId !== undefined) childFailures.delete(stepId);
    const detail = isRecord(event.detail) ? event.detail : undefined;
    if (detail === undefined) continue;

    if (type === "fanout_attempt_result") {
      if (!("failure" in detail)) continue;
      const failure = isRecord(detail.failure) ? detail.failure : undefined;
      const reason = str(failure?.reason);
      const stepId = str(event.stepId);
      const itemIndex = indexOf(detail.itemIndex);
      const stage = indexOf(detail.stage);
      const attempt = num(detail.attempt);
      if (reason === undefined || stepId === undefined || itemIndex === undefined
        || stage === undefined || attempt === undefined || detail.success !== false) {
        dropped += 1;
        continue;
      }
      fanoutFailures.add(stepId);
      indices?.push(index);
      out.push({
        runId, flowName, stepId, itemIndex, stage, attempt, reason,
        ...(specDigest !== undefined ? { specDigest } : {}),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        shape: shapeOf(reason),
        at: str(event.at) ?? "",
        recovered: fanoutSucceededAfter(events, stepId, itemIndex, stage, index),
      });
      continue;
    }

    if (type === "result") {
      const hasFanoutFailures = fanoutFailures.delete(stepId ?? "");
      const childFailure = stepId === undefined ? undefined : childFailures.get(stepId);
      if (stepId !== undefined) childFailures.delete(stepId);
      if (!("failure" in detail)) {
        // A child settling without failure also closes the echo window: whatever the
        // parent result now carries, it is not that earlier failure re-recorded.
        const slash = stepId?.lastIndexOf("/") ?? -1;
        if (slash > 0) childFailures.delete(stepId!.slice(0, slash));
        continue;
      }
      // `failure` is a string in some drifted runs: failure-shaped but unusable.
      const failure = isRecord(detail.failure) ? detail.failure : undefined;
      if (failure === undefined) { dropped += 1; continue; }
      const reason = str(failure.reason);
      if (reason === undefined) { dropped += 1; continue; }
      // The require failure summarizes the item failures already collected. Keep
      // standalone aggregate failures (e.g. no items) and unrelated step failures.
      if (hasFanoutFailures && /^fanout require .+ not met \(\d+\/\d+ succeeded\)$/.test(reason)) continue;
      // The parent echo of a child failure already collected. A parent failure with its own
      // reason (the completed subflow's output breaking the parent contract) is kept.
      if (childFailure === reason) continue;
      const slash = stepId?.lastIndexOf("/") ?? -1;
      if (stepId !== undefined && slash > 0) childFailures.set(stepId.slice(0, slash), reason);
      indices?.push(index);
      out.push({
        runId,
        flowName,
        stepId: stepId ?? null,
        ...(specDigest !== undefined ? { specDigest } : {}),
        attempt: num(failure.attempt) ?? num(detail.attempt) ?? 0,
        reason,
        shape: shapeOf(reason),
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        at: str(event.at) ?? "",
        recovered: stepId !== undefined && succeededAfter(events, stepId, index),
      });
      continue;
    }

    if (type === "budget_exhausted") {
      const reason = str(detail.reason);
      if (reason === undefined) { dropped += 1; continue; }
      indices?.push(index);
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

/** Aggregate success or another item's/stage's success is not recovery. */
function fanoutSucceededAfter(events: RawEvent[], stepId: string, itemIndex: number, stage: number, afterIndex: number): boolean {
  return events.slice(afterIndex + 1).some((event) => {
    if (event.type !== "fanout_attempt_result" || event.stepId !== stepId || !isRecord(event.detail)) return false;
    return event.detail.itemIndex === itemIndex && event.detail.stage === stage
      && event.detail.success === true && !("failure" in event.detail);
  });
}

function indexOf(value: unknown): number | undefined {
  const index = num(value);
  return index !== undefined && Number.isInteger(index) && index >= 0 ? index : undefined;
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
