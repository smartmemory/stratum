import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readCandidates, type PatchCandidate } from "./candidate.js";
import { groupRecords, type GroupingKey } from "./classify.js";
import { failureRecordsOf, type FailureRecord } from "./harvest.js";
import { lessonLifecycle, readLifecycle, type ReviewKind } from "./lifecycle.js";
import { canonicalizeRecordRoots, canonicalWorkspace } from "./workspace.js";

/**
 * STRAT-LEARN-DELIVER-1 D6: did a delivered lesson hold? Counted per run and per offered
 * step, ordered by event position; closed by lifecycle watermarks (D5). Nothing here
 * changes state: reviews are raised, the owner acts.
 */

export type Outcome = "held" | "not-holding" | "unknown";

export interface LessonOutcome {
  revisionId: string;
  clusterId: string;
  runId: string;
  /** The harvest step id the lesson was offered to (DELIVER-1 D3). */
  stepId: string;
  outcome: Outcome;
  /** Time of the deciding event: the matching failure, the success, or (unknown) the offer. */
  at: string;
}

export interface LessonReview {
  kind: ReviewKind;
  clusterId: string;
  /** The revision the evidence concerns; absent for recurrence of a retired cluster. */
  revisionId?: string;
  runs: string[];
  detail: string;
}

const ISSUING = new Set(["ready", "fanout_item_ready", "fanout_item_dispatched"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "budget_exhausted"]);
const GROUPINGS: readonly GroupingKey[] = ["step-agnostic", "step-scoped"];
/** DELIVER-1 D6 (design.md:178, 278-279): Compose intercepts these steps and runs them
 *  in-process — a lesson offered to one is offered but never delivered to an agent. */
const INTERCEPTED_STEPS = new Set(["ship"]);

interface RawEvent { type?: unknown; stepId?: unknown; at?: unknown; detail?: unknown }
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The cluster ids a (canonicalized) failure record is evidence for — the classifier's own keys. */
export function clusterIdsOf(failure: FailureRecord): Set<string> {
  const ids = new Set<string>();
  for (const grouping of GROUPINGS) for (const key of groupRecords([failure], grouping).keys()) ids.add(sha(key));
  return ids;
}

interface RunScan {
  runId: string;
  terminal: boolean;
  events: RawEvent[];
  failures: Array<{ record: FailureRecord; index: number; clusters: Set<string> }>;
}

/** Every persisted run in the store whose canonical workspace is `root`. Unreadable runs are skipped. */
async function scanStore(storeRoot: string, root: string): Promise<RunScan[]> {
  let names: string[];
  try { names = (await readdir(storeRoot)).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
  const scans: RunScan[] = [];
  for (const name of names) {
    let run: Record<string, unknown>;
    try { run = JSON.parse(await readFile(join(storeRoot, name), "utf8")) as Record<string, unknown>; } catch { continue; }
    const workspaceRoot = str(run.workspaceRoot);
    const runId = str(run.id);
    if (workspaceRoot === undefined || runId === undefined || await canonicalWorkspace(workspaceRoot) !== root) continue;
    let extracted: ReturnType<typeof failureRecordsOf>;
    try { extracted = failureRecordsOf(run); } catch { continue; }
    await canonicalizeRecordRoots(extracted.records);
    scans.push({
      runId,
      terminal: TERMINAL.has(str(run.status) ?? ""),
      events: Array.isArray(run.events) ? run.events as RawEvent[] : [],
      failures: extracted.records.map((failure, i) => ({ record: failure, index: extracted.eventIndices[i]!, clusters: clusterIdsOf(failure) })),
    });
  }
  return scans;
}

function succeededAt(scan: RunScan, stepId: string, after: number): string | undefined {
  for (let i = after + 1; i < scan.events.length; i += 1) {
    const event = scan.events[i]!;
    if (str(event.stepId) !== stepId) continue;
    const detail = record(event.detail);
    if (event.type === "result" && detail !== undefined && !("failure" in detail)) return str(event.at) ?? "";
    if (event.type === "fanout_attempt_result" && detail?.success === true) return str(event.at) ?? "";
  }
  return undefined;
}

function outcomesOf(scan: RunScan, clusterOf: (revisionId: string) => string | undefined): LessonOutcome[] {
  // First offer of each revision to each step id.
  const offers = new Map<string, { revisionId: string; stepId: string; index: number; at: string }>();
  for (const [index, event] of scan.events.entries()) {
    if (!ISSUING.has(str(event.type) ?? "")) continue;
    const stepId = str(event.stepId);
    const lessons = record(event.detail)?.lessons;
    if (stepId === undefined || !Array.isArray(lessons)) continue;
    for (const revisionId of lessons) {
      if (typeof revisionId !== "string") continue;
      const key = `${revisionId}\u0000${stepId}`;
      if (!offers.has(key)) offers.set(key, { revisionId, stepId, index, at: str(event.at) ?? "" });
    }
  }
  const out: LessonOutcome[] = [];
  for (const offer of offers.values()) {
    const clusterId = clusterOf(offer.revisionId);
    if (clusterId === undefined) continue; // an offer whose revision left the sidecar: nothing to attribute it to
    const base = { revisionId: offer.revisionId, clusterId, runId: scan.runId, stepId: offer.stepId };
    // A matching failure after the offer decides at once, terminal or not.
    const failure = scan.failures.find((f) => f.index > offer.index && f.record.stepId === offer.stepId && f.clusters.has(clusterId));
    if (failure !== undefined) { out.push({ ...base, outcome: "not-holding", at: failure.record.at }); continue; }
    const success = scan.terminal ? succeededAt(scan, offer.stepId, offer.index) : undefined;
    out.push(success !== undefined ? { ...base, outcome: "held", at: success } : { ...base, outcome: "unknown", at: offer.at });
  }
  return out;
}

async function sidecarIndex(root: string): Promise<Map<string, PatchCandidate>> {
  const byRevision = new Map<string, PatchCandidate>();
  for (const candidate of await readCandidates(join(root, ".stratum", "learn"))) byRevision.set(candidate.revisionId, candidate);
  return byRevision;
}

/** Per run and offered step, for every lesson offered in `root`'s runs of this store. */
export async function lessonOutcomes(storeRoot: string, workspaceRoot: string): Promise<LessonOutcome[]> {
  const root = await canonicalWorkspace(workspaceRoot);
  const byRevision = await sidecarIndex(root);
  const scans = await scanStore(storeRoot, root);
  return scans.flatMap((scan) => outcomesOf(scan, (revisionId) => byRevision.get(revisionId)?.clusterId));
}

/** The D6 caveat for evidence gathered on a step Compose never hands to an agent. */
const offeredNotDelivered = (rows: LessonOutcome[]): string =>
  rows.some((o) => INTERCEPTED_STEPS.has(o.stepId))
    ? ` (offered to step "ship", which Compose runs in-process: offered, not delivered)`
    : "";

export interface ReviewOptions { retireReviewAfter: number }

/**
 * The open reviews for `root` (D6). Each kind counts only evidence after that cluster's
 * watermark for that kind (D5), so acknowledging a review closes it until newer evidence.
 * Recomputed on every call. A cluster whose lifecycle cannot be read raises no reviews.
 */
export async function lessonReviews(storeRoot: string, workspaceRoot: string, options: ReviewOptions): Promise<LessonReview[]> {
  const root = await canonicalWorkspace(workspaceRoot);
  const byRevision = await sidecarIndex(root);
  const scans = await scanStore(storeRoot, root);
  const clusterOf = (revisionId: string) => byRevision.get(revisionId)?.clusterId;
  const outcomes = scans.flatMap((scan) => outcomesOf(scan, clusterOf));

  // contract-changed: a D3 suppression recorded on an issuing event.
  const drift: Array<{ clusterId: string; revisionId: string; runId: string; at: string }> = [];
  for (const scan of scans) {
    for (const event of scan.events) {
      if (!ISSUING.has(str(event.type) ?? "")) continue;
      const suppressed = record(event.detail)?.lessonsSuppressed;
      if (!Array.isArray(suppressed)) continue;
      for (const entry of suppressed) {
        const row = record(entry);
        const revisionId = str(row?.revisionId);
        const clusterId = revisionId === undefined ? undefined : clusterOf(revisionId);
        if (row?.reason === "contract-changed" && revisionId !== undefined && clusterId !== undefined) {
          drift.push({ clusterId, revisionId, runId: scan.runId, at: str(event.at) ?? "" });
        }
      }
    }
  }

  // Recurrence needs a retire/dismiss row, so only clusters named in the lifecycle log
  // (not every failure cluster in the store) are checked for it.
  let lifecycleClusters: string[] = [];
  try { lifecycleClusters = (await readLifecycle(root, () => {})).rows.map((row) => row.clusterId); } catch { /* per-cluster reads below fail closed */ }
  const clusters = new Set<string>([...outcomes.map((o) => o.clusterId), ...drift.map((d) => d.clusterId), ...lifecycleClusters]);
  const reviews: LessonReview[] = [];
  for (const clusterId of [...clusters].sort()) {
    let lifecycle;
    try { lifecycle = await lessonLifecycle(root, clusterId, () => { /* reported by readLifecycle */ }); } catch { continue; }
    const after = (kind: ReviewKind) => (at: string) => lifecycle.watermarks[kind] === undefined || at > lifecycle.watermarks[kind]!;
    const mine = outcomes.filter((o) => o.clusterId === clusterId);
    const latest = (rows: Array<{ revisionId: string; at: string }>) => [...rows].sort((a, b) => a.at < b.at ? -1 : 1).at(-1)?.revisionId;
    const runs = (rows: Array<{ runId: string }>) => [...new Set(rows.map((r) => r.runId))];

    const failing = mine.filter((o) => o.outcome === "not-holding" && after("not-holding")(o.at));
    if (failing.length > 0) {
      reviews.push({ kind: "not-holding", clusterId, revisionId: latest(failing)!, runs: runs(failing),
        detail: `offered and failed again in ${runs(failing).length} run(s)` + offeredNotDelivered(failing) });
    }
    const sinceRetire = after("retire-candidate");
    const held = mine.filter((o) => o.outcome === "held" && sinceRetire(o.at));
    const brokeSince = mine.some((o) => o.outcome === "not-holding" && sinceRetire(o.at));
    if (!brokeSince && runs(held).length >= options.retireReviewAfter) {
      reviews.push({ kind: "retire-candidate", clusterId, revisionId: latest(held)!, runs: runs(held),
        detail: `held in ${runs(held).length} run(s); check whether the cause is fixed and retire it (a clean run with the lesson may be why it was clean)` + offeredNotDelivered(held) });
    }
    const drifted = drift.filter((d) => d.clusterId === clusterId && after("contract-changed")(d.at));
    if (drifted.length > 0) {
      reviews.push({ kind: "contract-changed", clusterId, revisionId: latest(drifted)!, runs: runs(drifted),
        detail: "suppressed because the output contract it describes changed" });
    }
    if (lifecycle.state !== "active" && lifecycle.since !== undefined) {
      const since = lifecycle.since;
      const recurred = scans.flatMap((scan) => scan.failures
        .filter((f) => f.clusters.has(clusterId) && f.record.at > since && after("recurred-after-retirement")(f.record.at))
        .map(() => ({ runId: scan.runId })));
      if (recurred.length > 0) {
        reviews.push({ kind: "recurred-after-retirement", clusterId, runs: runs(recurred),
          detail: `${lifecycle.state} on ${since}, failed again in ${runs(recurred).length} run(s)` });
      }
    }
  }
  return reviews;
}
