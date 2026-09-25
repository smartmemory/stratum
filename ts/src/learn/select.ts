import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { journalDir, ledgerReceipt, verifyIdentity, type JournalEntry } from "./apply.js";
import { sidecarPath, type PatchCandidate } from "./candidate.js";
import { lessonLifecycle, type LessonLifecycle } from "./lifecycle.js";
import { canonicalWorkspace } from "./workspace.js";

export interface ActiveLesson {
  candidate: PatchCandidate;
  applyId: string;
  appliedAt: string;
}

export interface SelectionDiagnostic {
  reason: "journal-unreadable" | "journal-invalid" | "sidecar-unreadable" | "sidecar-invalid"
    | "receipt-unreadable" | "receipt-not-applied" | "snapshot-digest-mismatch"
    | "snapshot-content-missing" | "candidate-missing" | "candidate-identity-invalid"
    | "candidate-cluster-mismatch" | "guidance-missing" | "lifecycle-unreadable"
    | "lifecycle-invalid" | "lifecycle-inactive" | "superseded-revision";
  applyId?: string;
  revisionId?: string;
  clusterId?: string;
  detail?: string;
}

type Report = (diagnostic: SelectionDiagnostic) => void;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function ids(value: unknown): Pick<SelectionDiagnostic, "applyId" | "revisionId" | "clusterId"> {
  if (!object(value)) return {};
  return Object.fromEntries(["applyId", "revisionId", "clusterId"]
    .filter((key) => typeof value[key] === "string").map((key) => [key, value[key]]));
}

/** Validate the fields consumed by selection and by ledgerReceipt, not journal state. */
function isJournal(value: unknown): value is JournalEntry {
  return object(value)
    && ["applyId", "revisionId", "clusterId", "targetPath", "beforeDigest", "afterDigest", "after", "at"]
      .every((key) => typeof value[key] === "string")
    && (value.applyId as string).length > 0
    && Number.isFinite(Date.parse(value.at as string));
}

async function journals(root: string, report: Report): Promise<JournalEntry[]> {
  const dir = journalDir(root);
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) {
    if (!missing(error)) report({ reason: "journal-unreadable", detail: `${dir}: ${message(error)}` });
    return [];
  }
  const entries: JournalEntry[] = [];
  for (const name of names.sort().filter((name) => name.endsWith(".json"))) {
    const path = join(dir, name);
    let raw: string;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if (!missing(error)) report({ reason: "journal-unreadable", detail: `${path}: ${message(error)}` });
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
      if (!isJournal(value)) throw new Error("invalid journal selection fields");
      entries.push(value);
    } catch (error) {
      report({ reason: "journal-invalid", ...ids(value), detail: `${path}: ${message(error)}` });
    }
  }
  return entries;
}

async function candidates(root: string, report: Report): Promise<Map<string, PatchCandidate[]>> {
  const path = sidecarPath(join(root, ".stratum", "learn"));
  const rows = new Map<string, PatchCandidate[]>();
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (!missing(error)) report({ reason: "sidecar-unreadable", detail: `${path}: ${message(error)}` });
    return rows;
  }
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const location = `${path}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
      if (!object(value) || typeof value.revisionId !== "string") throw new Error("invalid candidate row");
    } catch (error) {
      report({ reason: "sidecar-invalid", detail: `${location}: ${message(error)}` });
      continue;
    }
    const candidate = value as unknown as PatchCandidate;
    try {
      verifyIdentity(candidate);
      if (typeof candidate.rendered.content !== "string") throw new Error("invalid rendered content");
    } catch (error) {
      report({ reason: "candidate-identity-invalid", ...ids(value), detail: `${location}: ${message(error)}` });
      continue;
    }
    const revisions = rows.get(candidate.revisionId) ?? [];
    revisions.push(candidate);
    rows.set(candidate.revisionId, revisions);
  }
  return rows;
}

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function compare(a: ActiveLesson, b: ActiveLesson): number {
  return Date.parse(a.appliedAt) - Date.parse(b.appliedAt) || lexical(a.applyId, b.applyId);
}

/** D2: pure, fail-closed selection from committed apply snapshots, never live NOTES.md. */
export async function activeLessons(root: string): Promise<{
  lessons: ActiveLesson[]; diagnostics: SelectionDiagnostic[];
}> {
  root = await canonicalWorkspace(root);
  const diagnostics: SelectionDiagnostic[] = [];
  const report: Report = (diagnostic) => { diagnostics.push(diagnostic); };
  const entries = await journals(root, report);
  const rows = await candidates(root, report);
  const lifecycles = new Map<string, LessonLifecycle | string>();
  const revisions = new Map<string, ActiveLesson>();
  for (const entry of entries) {
    const fail = (reason: SelectionDiagnostic["reason"], detail?: string): void => {
      report({ reason, ...ids(entry), ...(detail === undefined ? {} : { detail }) });
    };
    // C1: the ledger is authoritative even when the journal is unfinished.
    let receipt: ReturnType<typeof ledgerReceipt>;
    try {
      receipt = ledgerReceipt(entry, () => { /* Selection returns diagnostics; no console notices. */ });
    } catch (error) {
      fail("receipt-unreadable", message(error));
      continue;
    }
    if (receipt.kind !== "committed" || receipt.state !== "applied") {
      fail(receipt.kind === "unreadable" ? "receipt-unreadable" : "receipt-not-applied");
      continue;
    }
    // C2: exactly the private sha() used by apply/protocol.ts and learn/apply.ts.
    if (createHash("sha256").update(entry.after).digest("hex") !== entry.afterDigest) {
      fail("snapshot-digest-mismatch");
      continue;
    }
    // C3: the strict reader has verified identity for every retained sidecar row.
    const matching = rows.get(entry.revisionId);
    if (!matching) { fail("candidate-missing"); continue; }
    const candidate = matching.find((row) => row.clusterId === entry.clusterId);
    if (!candidate) { fail("candidate-cluster-mismatch"); continue; }
    if (!entry.after.includes(candidate.rendered.content)) {
      fail("snapshot-content-missing");
      continue;
    }
    // C4: note-only candidates remain human notes.
    if (typeof candidate.rendered.guidance !== "string" || candidate.rendered.guidance.trim().length === 0) {
      fail("guidance-missing");
      continue;
    }
    // C5: preserve D5's skipped-line semantics, collecting its diagnostics silently.
    if (!lifecycles.has(entry.clusterId)) {
      try {
        lifecycles.set(entry.clusterId, await lessonLifecycle(root, entry.clusterId,
          (detail) => fail("lifecycle-invalid", detail)));
      } catch (error) {
        lifecycles.set(entry.clusterId, message(error));
      }
    }
    const lifecycle = lifecycles.get(entry.clusterId);
    if (typeof lifecycle === "string") { fail("lifecycle-unreadable", lifecycle); continue; }
    if (!lifecycle) throw new Error("missing cached lifecycle");
    if (lifecycle.state !== "active") { fail("lifecycle-inactive", lifecycle.state); continue; }
    const lesson = { candidate, applyId: entry.applyId, appliedAt: entry.at };
    const previous = revisions.get(entry.revisionId);
    if (!previous || compare(previous, lesson) < 0) revisions.set(entry.revisionId, lesson);
  }
  const clusters = new Map<string, ActiveLesson>();
  for (const lesson of [...revisions.values()].sort(compare)) {
    const previous = clusters.get(lesson.candidate.clusterId);
    if (previous) report({ reason: "superseded-revision", applyId: previous.applyId,
      revisionId: previous.candidate.revisionId, clusterId: previous.candidate.clusterId,
      detail: `superseded by apply ${lesson.applyId}` });
    clusters.set(lesson.candidate.clusterId, lesson);
  }
  return { lessons: [...clusters.values()].sort(compare), diagnostics };
}
