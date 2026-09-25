import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureRecord } from "./harvest.js";
import { appendJsonlUnderLock, canonicalWorkspace, withWorkspaceLock } from "./workspace.js";

export const REVIEW_KINDS = ["retire-candidate", "not-holding", "contract-changed", "recurred-after-retirement"] as const;
export type ReviewKind = typeof REVIEW_KINDS[number];
export type LifecycleKind = "retire" | "dismiss" | "reactivate" | "ack";
export interface LifecycleRow {
  clusterId: string;
  kind: LifecycleKind;
  reason: string;
  at: string;
  fixRef?: string;
  withdrawn?: true;
  ackKinds?: ReviewKind[];
}
export interface LessonLifecycle {
  state: "active" | "retired" | "dismissed";
  since?: string;
  fixRef?: string;
  watermarks: Record<ReviewKind, string | undefined>;
}
export class LifecycleError extends Error {}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateRow(value: unknown): asserts value is LifecycleRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("invalid lifecycle row");
  const row = value as Record<string, unknown>;
  if (typeof row.clusterId !== "string" || !/^[a-f0-9]{64}$/.test(row.clusterId)) {
    throw new LifecycleError("clusterId must be 64 lowercase hex characters");
  }
  if (typeof row.kind !== "string" || !["retire", "dismiss", "reactivate", "ack"].includes(row.kind)) {
    throw new LifecycleError("invalid lifecycle kind");
  }
  if (!nonempty(row.reason)) throw new LifecycleError("reason must be non-empty");
  if (typeof row.at !== "string" || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at) {
    throw new LifecycleError("at must be an ISO timestamp from toISOString()");
  }
  if (row.fixRef !== undefined && !nonempty(row.fixRef)) throw new LifecycleError("fixRef must be non-empty");
  if (row.withdrawn !== undefined && row.withdrawn !== true) throw new LifecycleError("withdrawn must be true");
  if (row.kind === "retire") {
    if ((row.fixRef !== undefined) === (row.withdrawn === true)) {
      throw new LifecycleError("retire requires exactly one of fixRef or withdrawn:true");
    }
  } else if (row.fixRef !== undefined || row.withdrawn !== undefined) {
    throw new LifecycleError("fixRef and withdrawn are only allowed on retire");
  }
  if (row.ackKinds !== undefined && (row.kind !== "ack" || !Array.isArray(row.ackKinds)
    || !row.ackKinds.every((kind) => REVIEW_KINDS.includes(kind)))) {
    throw new LifecycleError("ackKinds is only allowed on ack and must contain known review kinds");
  }
}

/** Preserve file order; malformed/torn lines are counted and reported, never hidden. */
export async function readLifecycle(
  root: string,
  onInvalidLine?: (detail: string) => void,
): Promise<{ rows: LifecycleRow[]; skipped: number }> {
  const path = join(await canonicalWorkspace(root), ".stratum", "learn", "lifecycle.jsonl");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], skipped: 0 };
    throw error;
  }
  const rows: LifecycleRow[] = [];
  let skipped = 0;
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      validateRow(row);
      rows.push(row);
    } catch {
      skipped++;
      onInvalidLine?.(`${path}:${index + 1}: invalid lifecycle row`);
    }
  }
  if (skipped > 0 && !onInvalidLine) console.warn(`learn lifecycle: skipped ${skipped} invalid line(s) in ${path}`);
  return { rows, skipped };
}

function foldLifecycle(rows: LifecycleRow[], clusterId: string): LessonLifecycle {
  const result: LessonLifecycle = {
    state: "active",
    watermarks: { "retire-candidate": undefined, "not-holding": undefined,
      "contract-changed": undefined, "recurred-after-retirement": undefined },
  };
  for (const row of rows) {
    if (row.clusterId !== clusterId) continue;
    if (row.kind !== "ack") {
      result.state = row.kind === "retire" ? "retired" : row.kind === "dismiss" ? "dismissed" : "active";
      result.since = row.at;
      delete result.fixRef;
      if (row.fixRef !== undefined) result.fixRef = row.fixRef;
    }
    for (const kind of row.kind === "ack" ? row.ackKinds ?? REVIEW_KINDS : REVIEW_KINDS) {
      result.watermarks[kind] = row.at;
    }
  }
  return result;
}

export async function lessonLifecycle(
  root: string, clusterId: string, onInvalidLine?: (detail: string) => void,
): Promise<LessonLifecycle> {
  return foldLifecycle((await readLifecycle(root, onInvalidLine)).rows, clusterId);
}

/** State validation and append are one transaction, including across CLI processes. */
export async function appendLifecycle(root: string, input: Omit<LifecycleRow, "at">): Promise<LifecycleRow> {
  root = await canonicalWorkspace(root);
  return withWorkspaceLock(root, async () => {
    const row = { ...input, at: new Date().toISOString() };
    validateRow(row);
    const { state } = await lessonLifecycle(root, row.clusterId);
    if (((row.kind === "retire" || row.kind === "dismiss") && state !== "active")
      || (row.kind === "reactivate" && state === "active")) {
      throw new LifecycleError(`cannot ${row.kind} cluster ${row.clusterId} from ${state}`);
    }
    await appendJsonlUnderLock(root, "lifecycle.jsonl", [row]);
    return row;
  });
}

/** ISO strings from toISOString() compare chronologically (the engine's timestamp format). */
export function isSuppressed(lifecycle: LessonLifecycle, evidence: FailureRecord[]): boolean {
  return lifecycle.state !== "active" && lifecycle.since !== undefined
    && evidence.every((record) => record.at <= lifecycle.since!);
}

export function hasEvidenceAfterRetirement(lifecycle: LessonLifecycle, evidence: FailureRecord[]): boolean {
  return lifecycle.state !== "active" && lifecycle.since !== undefined
    && evidence.some((record) => record.at > lifecycle.since!);
}
