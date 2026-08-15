import { createHash } from "node:crypto";
import type { FailureRecord, FailureShape } from "./harvest.js";

/**
 * Turns raw failure records into clusters, and decides which clusters are lessons.
 *
 * Two things in here are load-bearing, and both were forced by the real corpus rather
 * than chosen:
 *
 * 1. Grouping is ATTRIBUTED. The largest raw cluster in the corpus (155 records on one
 *    step) is a single golden test rerun in 155 ephemeral workspaces. Grouped without
 *    `workspaceRoot`, the harvester's most confident output is its worst.
 *
 * 2. The key is the VIOLATED CONTRACT, never the offending value and never the spec
 *    revision. Keying on the rejected value splits the one real lesson five ways;
 *    keying on `revisionDigest` splits it two ways, because the spec was edited between
 *    the two runs that exhibit it.
 */

export type FailureClass = "transient" | "step-local" | "durable";
export type GroupingKey = "step-scoped" | "step-agnostic";

export interface Thresholds {
  /** A lesson must appear in at least this many distinct runs. */
  minRuns: number;
  /** ...and across at least this many distinct (run, step) pairs. */
  minPairs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { minRuns: 2, minPairs: 3 };

export interface Cluster {
  key: string;
  groupingKey: GroupingKey;
  shape: FailureShape;
  class: FailureClass;
  fingerprint: string;
  /** What was violated, in renderable form. */
  contract: ContractSummary;
  scope: {
    workspaceRoot: string | null;
    flowName: string;
    stepIds: string[];
    specDigests: string[];
  };
  recurrence: { records: number; distinctRuns: number; distinctPairs: number };
  /** Rejected values (enum receiveds, unrecognized keys). Evidence, never key material. */
  observedValues: string[];
  /** Disjoint spec revisions AND disjoint steps: the signature of two unrelated
   * contracts colliding on one fingerprint rather than one contract seen across edits. */
  mixedProvenance: boolean;
  unattributed: boolean;
  applyEligible: boolean;
  evidence: FailureRecord[];
}

/**
 * One violated constraint. The unit of clustering is an ISSUE, not a failure.
 *
 * A single failure can violate two unrelated constraints at once — in the corpus, two
 * records reject the `outcome` enum AND a `commit_hash` type in the same response.
 * Fingerprinting the whole failure makes those records a different "contract" and
 * splits one 14-record lesson into 12 + 2. Exploding to issues lets a record be
 * evidence for every lesson it actually evidences.
 */
export interface IssueUnit {
  record: FailureRecord;
  fingerprint: string;
  received?: string;
  /** The violated constraint, in readable form — used to render the note. */
  contract: ContractSummary;
}

export interface ContractSummary {
  code: string;
  /** Dotted field path, e.g. "outcome". Empty for whole-object violations. */
  path: string;
  /** Allowed enum options, rejected key names, or the expected type. */
  expected: string[];
}

export function issueUnits(record: FailureRecord): IssueUnit[] {
  if (record.shape === "schema") {
    const issues = parseIssues(record.reason);
    if (issues.length > 0) {
      return issues.map((issue) => {
        // The declared contract: allowed enum options, or rejected key NAMES — both
        // properties of the schema, not of the value that failed it.
        const contract: ContractSummary = {
          code: String(issue.code ?? ""),
          path: toStrings(issue.path).join("."),
          expected: [
            ...toStrings(issue.options),
            ...toStrings(issue.keys),
            ...(typeof issue.expected === "string" ? [issue.expected] : []),
          ].sort(),
        };
        return {
          record,
          fingerprint: sha(JSON.stringify({ shape: record.shape, ...contract })),
          contract,
          ...(typeof issue.received === "string" ? { received: issue.received } : {}),
        };
      });
    }
  }
  const text =
    record.shape === "budget"
      ? "budget"
      : record.reason.replace(/"[^"]*"/g, '""').replace(/\d+/g, "#").slice(0, 200);
  const contract: ContractSummary = { code: record.shape, path: "", expected: [] };
  return [{ record, fingerprint: sha(JSON.stringify({ shape: record.shape, text })), contract }];
}

/** The primary violated contract of a record — its first issue in canonical order. */
export function contractFingerprint(record: FailureRecord): string {
  const sorted = [...issueUnits(record)].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  // issueUnits always returns at least one unit, but the compiler cannot know that.
  return sorted[0]?.fingerprint ?? sha(JSON.stringify({ shape: record.shape, text: "" }));
}

interface ZodIssue {
  code?: unknown;
  path?: unknown;
  options?: unknown;
  keys?: unknown;
  expected?: unknown;
  received?: unknown;
}

function parseIssues(reason: string): ZodIssue[] {
  try {
    const parsed: unknown = JSON.parse(reason);
    if (Array.isArray(parsed)) return parsed as ZodIssue[];
    if (typeof parsed === "object" && parsed !== null) return [parsed as ZodIssue];
  } catch {
    // Not a structured reason; the text path in contractShape handles it.
  }
  return [];
}

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function groupRecords(
  records: readonly FailureRecord[],
  groupingKey: GroupingKey,
): Map<string, IssueUnit[]> {
  const groups = new Map<string, IssueUnit[]>();
  for (const record of records) {
    for (const unit of issueUnits(record)) {
      const parts = [
        record.workspaceRoot ?? "\u0000unattributed",
        record.flowName,
        record.shape,
        unit.fingerprint,
      ];
      // The step id joins the key only for step-scoped grouping. Leaving it out is what
      // recovers a contract-level lesson that no single step exhibits often enough.
      if (groupingKey === "step-scoped") parts.splice(2, 0, record.stepId ?? "\u0000flow");
      const key = parts.join("\u0000");
      const bucket = groups.get(key);
      if (bucket === undefined) groups.set(key, [unit]);
      else bucket.push(unit);
    }
  }
  return groups;
}

export function classify(
  records: readonly FailureRecord[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Cluster[] {
  const clusters: Cluster[] = [];
  const claimed = new Set<string>();

  // Step-agnostic first: a contract-level lesson subsumes the per-step view of the same
  // issues, and emitting both would report one lesson twice.
  for (const groupingKey of ["step-agnostic", "step-scoped"] as const) {
    for (const [key, bucket] of groupRecords(records, groupingKey)) {
      const cluster = build(key, groupingKey, bucket, thresholds);
      if (
        groupingKey === "step-scoped" &&
        cluster.class === "durable" &&
        bucket.every((unit) => claimed.has(identity(unit)))
      ) {
        continue;
      }
      // Only an APPLY-ELIGIBLE aggregate subsumes its per-step view. A mixed-provenance
      // or unattributed aggregate is discarded downstream, so letting it claim these
      // units would silently drop clean per-step lessons with it.
      if (cluster.class === "durable" && cluster.applyEligible) {
        for (const unit of bucket) claimed.add(identity(unit));
      }
      clusters.push(cluster);
    }
  }

  return clusters.sort((a, b) => a.key.localeCompare(b.key));
}

function identity(unit: IssueUnit): string {
  const { record } = unit;
  return [record.runId, record.stepId ?? "", record.at, unit.fingerprint].join("\u0000");
}

function build(
  key: string,
  groupingKey: GroupingKey,
  bucket: IssueUnit[],
  thresholds: Thresholds,
): Cluster {
  const rows = bucket.map((unit) => unit.record);
  const first = rows[0];
  if (first === undefined) throw new Error("cannot build a cluster from an empty bucket");
  const runs = new Set(rows.map((r) => r.runId));
  const pairs = new Set(rows.map((r) => `${r.runId}\u0000${r.stepId ?? ""}`));
  const stepIds = [...new Set(rows.map((r) => r.stepId).filter((s): s is string => s !== null))].sort();
  const specDigests = [
    ...new Set(rows.map((r) => r.specDigest).filter((s): s is string => s !== undefined)),
  ].sort();
  const workspaceRoot = first.workspaceRoot ?? null;
  const unattributed = workspaceRoot === null;

  // Disjoint spec revisions AND disjoint steps: the records cannot be one contract seen
  // across edits, so they are more likely two contracts colliding on one fingerprint.
  const perDigestSteps = new Map<string, Set<string>>();
  for (const record of rows) {
    if (record.specDigest === undefined || record.stepId === null) continue;
    const set = perDigestSteps.get(record.specDigest) ?? new Set<string>();
    set.add(record.stepId);
    perDigestSteps.set(record.specDigest, set);
  }
  const stepSets = [...perDigestSteps.values()];
  const mixedProvenance =
    stepSets.length > 1 &&
    stepSets.every((a, i) => stepSets.every((b, j) => i === j || disjoint(a, b)));

  const shape = first.shape;
  let klass: FailureClass;
  if (shape === "budget") klass = "transient";
  else if (runs.size >= thresholds.minRuns && pairs.size >= thresholds.minPairs) klass = "durable";
  else klass = "step-local";

  // Evidence is deduped source records: one record violating two constraints is
  // evidence for two clusters, but only once within each.
  const evidence: FailureRecord[] = [];
  const seen = new Set<string>();
  for (const record of rows) {
    const id = [record.runId, record.stepId ?? "", record.at].join("\u0000");
    if (seen.has(id)) continue;
    seen.add(id);
    evidence.push(record);
  }

  return {
    key,
    groupingKey,
    shape,
    class: klass,
    fingerprint: bucket[0]?.fingerprint ?? "",
    contract: bucket[0]?.contract ?? { code: shape, path: "", expected: [] },
    scope: { workspaceRoot, flowName: first.flowName, stepIds, specDigests },
    recurrence: { records: bucket.length, distinctRuns: runs.size, distinctPairs: pairs.size },
    observedValues: [
      ...new Set(bucket.map((u) => u.received).filter((v): v is string => v !== undefined)),
    ].sort(),
    mixedProvenance,
    unattributed,
    applyEligible: klass === "durable" && !unattributed && !mixedProvenance,
    evidence,
  };
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return false;
  return true;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
