import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { registerGuard, guardTransition } from "../guard/transition.js";
import type { FailureRecord } from "./harvest.js";
import type { PatchCandidate } from "./candidate.js";

/**
 * The write half of the loop: admission, then a journalled, ledger-committed apply,
 * then compare-and-swap revert.
 *
 * Default OFF. With the flag unset nothing here writes anything.
 *
 * The single commit point is the guard LEDGER, not the journal. The journal is a plain
 * file this module writes, so "journal says applied" is only a claim about intent; the
 * ledger is hash-chained and is already the authorization record. Recovery therefore
 * asks the ledger what happened and treats the target and the journal as reconstructible.
 */

export class ApplyError extends Error {}
export class ApplyRefused extends ApplyError {}

export interface ApplyOptions {
  /** Default OFF (STRAT-GUARD / COMP-MCP-ENFORCE precedent). */
  enabled?: boolean;
}

function isEnabled(options: ApplyOptions): boolean {
  if (options.enabled === true) return true;
  return process.env.STRATUM_LEARN_APPLY_ENABLED === "1";
}

// ---------------------------------------------------------------------------
// Admission (G5)
// ---------------------------------------------------------------------------

export type CriticName =
  | "structural-validity"
  | "behavioral-harmlessness"
  | "semantic-consistency"
  | "subset-marginal-gain";

export interface Verdict {
  critic: CriticName;
  passes: boolean;
  findings: string[];
}

export interface AdmissionResult {
  admitted: boolean;
  verdicts: Verdict[];
  candidateDigest: string;
  poolDigest: string;
}

/**
 * Instructions that are damaging, irreversible, or that bypass a control. Deterministic
 * on purpose: this is the critic that must not depend on a model being available, and
 * the class of harm it catches is the one the other two provably miss.
 */
const HAZARDS: Array<[RegExp, string]> = [
  [/git\s+checkout\s+--\s/i, "discards uncommitted work (git checkout --)"],
  [/git\s+reset\s+--hard/i, "discards committed work (git reset --hard)"],
  [/git\s+clean\s+-[a-z]*f/i, "deletes untracked files (git clean -f)"],
  [/git\s+push\s+--force/i, "rewrites published history (git push --force)"],
  [/\brm\s+-[a-z]*r[a-z]*f\b/i, "recursive force delete (rm -rf)"],
  [/curl[^\n]*\|\s*(ba)?sh/i, "pipes remote content into a shell"],
  [/\b(api[_-]?key|secret|token|password|credential)s?\b/i, "handles credentials"],
  [/ts\/src\/(guard|judge)\//i, "instructs a write to the immutable core"],
  [/docs\/judgment\//i, "instructs a write that bypasses the judgment tools"],
  [/\.stratum\.yaml/i, "instructs a spec edit"],
  [/guard\s+(registry|ledger)/i, "instructs a write to guard state"],
];

function structuralValidity(candidate: PatchCandidate): Verdict {
  const findings: string[] = [];
  const content = candidate.rendered.content;
  if (content.trim().length === 0) findings.push("rendered content is empty");
  if (content.length > 4000) findings.push("rendered content is implausibly large for a note");
  if (/^#{1,6}\s/m.test(content)) findings.push("content injects a heading into the target document");
  if (candidate.targetKind !== "memory") findings.push(`target kind ${candidate.targetKind} is not memory`);
  if (candidate.evidence.length === 0) findings.push("candidate carries no evidence");
  return { critic: "structural-validity", passes: findings.length === 0, findings };
}

function behavioralHarmlessness(candidate: PatchCandidate): Verdict {
  const findings: string[] = [];
  for (const [pattern, description] of HAZARDS) {
    if (pattern.test(candidate.rendered.content)) findings.push(description);
  }
  return { critic: "behavioral-harmlessness", passes: findings.length === 0, findings };
}

/**
 * Does the note generalize what its evidence shows, and no more? Recurrence COUNT does
 * not license generalization SCOPE — conflating the two is the failure this catches.
 */
function semanticConsistency(candidate: PatchCandidate): Verdict {
  const findings: string[] = [];
  const content = candidate.rendered.content;

  if (/\b(all|every|any)\s+(agent\s+)?(steps?|projects?|flows?|pipelines?)\b/i.test(content)) {
    findings.push(
      `claim is unscoped; evidence spans ${candidate.scope.stepIds.length} step(s) in 1 workspace`,
    );
  }
  if (!content.includes(candidate.scope.flowName)) {
    findings.push("note does not name the flow its evidence came from");
  }
  const cited = new Set(candidate.evidence.map((record: FailureRecord) => record.runId));
  if (cited.size !== candidate.recurrence.distinctRuns) {
    findings.push(
      `recurrence claims ${candidate.recurrence.distinctRuns} runs, evidence carries ${cited.size}`,
    );
  }
  return { critic: "semantic-consistency", passes: findings.length === 0, findings };
}

/**
 * What does this add that the pool does not already carry? Per-candidate critics cannot
 * see the pool, and a pool of individually-clean but overlapping notes is still a bad
 * pool. Memory-class candidates are NOT exempt from this: notes are read together by a
 * working agent even when neither influenced the other's authoring.
 */
function subsetMarginalGain(candidate: PatchCandidate, pool: string): Verdict {
  const findings: string[] = [];
  const marker = `learn:${candidate.clusterId.slice(0, 12)}`;
  if (pool.includes(marker)) findings.push("pool already carries this lesson");
  else if (pool.includes(candidate.rendered.content.trim())) findings.push("pool already carries this text");
  return { critic: "subset-marginal-gain", passes: findings.length === 0, findings };
}

export async function admit(candidate: PatchCandidate, pool: string): Promise<AdmissionResult> {
  const verdicts = [
    structuralValidity(candidate),
    behavioralHarmlessness(candidate),
    semanticConsistency(candidate),
    subsetMarginalGain(candidate, pool),
  ];
  return {
    admitted: verdicts.every((verdict) => verdict.passes),
    verdicts,
    candidateDigest: sha(candidate.rendered.content),
    poolDigest: sha(pool),
  };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export type JournalState = "prepared" | "applying" | "applied" | "aborted";

export interface JournalEntry {
  applyId: string;
  state: JournalState;
  clusterId: string;
  revisionId: string;
  targetPath: string;
  before: string;
  beforeDigest: string;
  after: string;
  afterDigest: string;
  existedBefore: boolean;
  evidence: FailureRecord[];
  verdicts: Verdict[];
  ledgerRef?: string;
  at: string;
}

export function journalDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".stratum", "learn", "applies");
}

export function journalPath(workspaceRoot: string, applyId: string): string {
  return join(journalDir(workspaceRoot), `${applyId}.json`);
}

export async function readJournal(workspaceRoot: string): Promise<JournalEntry[]> {
  let names: string[];
  try {
    names = (await readdir(journalDir(workspaceRoot))).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(journalDir(workspaceRoot), name), "utf8")) as JournalEntry);
    } catch {
      // A corrupt journal record must not hide the others.
    }
  }
  return out;
}

async function writeJournal(workspaceRoot: string, entry: JournalEntry): Promise<void> {
  const path = journalPath(workspaceRoot, entry.applyId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entry, null, 2), "utf8");
  await rename(temporary, path);
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** G4: the resolved target must sit inside the project's own learn directory. */
function assertAllowlisted(candidate: PatchCandidate): string {
  const root = resolve(candidate.scope.workspaceRoot);
  const allowed = resolve(join(root, ".stratum", "learn"));
  const target = resolve(candidate.targetPath);
  if (target !== allowed && !target.startsWith(allowed + sep)) {
    throw new ApplyError(`target is outside the memory allowlist: ${target}`);
  }
  if (!target.endsWith(".md")) throw new ApplyError(`target is not a note file: ${target}`);
  return target;
}

/** `after` is a pure function of before + rendered content + insertion. */
export function renderAfter(before: string, candidate: PatchCandidate): string {
  const { content, insertion } = candidate.rendered;
  if (insertion.mode === "create" || before.trim().length === 0) {
    return `${insertion.section}\n\n${content}\n`;
  }
  if (!before.includes(insertion.section)) {
    return `${before.replace(/\n*$/, "\n")}\n${insertion.section}\n\n${content}\n`;
  }
  return `${before.replace(/\n*$/, "\n")}${content}\n`;
}

export interface AppliedResult {
  applyId: string;
  ledgerRef: string;
  targetPath: string;
}

export async function applyCandidate(
  candidate: PatchCandidate,
  options: ApplyOptions,
): Promise<AppliedResult> {
  if (!isEnabled(options)) {
    throw new ApplyRefused(
      "learn apply is disabled; enable it explicitly (STRATUM_LEARN_APPLY_ENABLED=1)",
    );
  }
  const workspaceRoot = candidate.scope.workspaceRoot;
  const target = assertAllowlisted(candidate);

  // An unreconciled journal for this target means we do not know the target's true
  // state; another apply on top would bury the ambiguity.
  for (const entry of await readJournal(workspaceRoot)) {
    if (entry.targetPath === target && (entry.state === "prepared" || entry.state === "applying")) {
      throw new ApplyError(`target has an unreconciled apply (${entry.applyId}); reconcile first`);
    }
  }

  const { content: before, existed } = await readTarget(target);
  const admission = await admit(candidate, before);
  if (!admission.admitted) {
    const failed = admission.verdicts.filter((v) => !v.passes);
    throw new ApplyRefused(
      `admission refused: ${failed.map((v) => `${v.critic} (${v.findings.join("; ")})`).join(", ")}`,
    );
  }

  const after = renderAfter(before, candidate);
  const applyId = sha([candidate.revisionId, target, sha(before)].join(" ")).slice(0, 32);

  // 1. Prepare.
  const entry: JournalEntry = {
    applyId,
    state: "prepared",
    clusterId: candidate.clusterId,
    revisionId: candidate.revisionId,
    targetPath: target,
    before,
    beforeDigest: sha(before),
    after,
    afterDigest: sha(after),
    existedBefore: existed,
    evidence: candidate.evidence,
    verdicts: admission.verdicts,
    at: new Date().toISOString(),
  };
  await writeJournal(workspaceRoot, entry);

  // 2. Transition to `applying`, committing the ledger to this journal record.
  const resourceId = guardResource(applyId);
  await registerGuard(
    resourceId,
    { staged: ["applying"], applying: ["applied", "aborted"], applied: [], aborted: [] },
    {},
    "staged",
    ["applied", "aborted"],
  );
  await guardTransition(resourceId, "staged", "applying", {
    artifacts: { journal_digest: sha(JSON.stringify(entry)), revision_id: candidate.revisionId },
    idempotencyKey: `${applyId}:applying`,
  });
  await writeJournal(workspaceRoot, { ...entry, state: "applying" });

  // 3. Write, only if the target still holds what we snapshotted.
  const current = await readTarget(target);
  if (sha(current.content) !== entry.beforeDigest) {
    throw new ApplyError("target changed between snapshot and write; aborting");
  }
  await atomicWriteFile(target, after);

  // 4. Commit. This ledger append is the moment the apply becomes real.
  const committed = await guardTransition(resourceId, "applying", "applied", {
    artifacts: { after_digest: entry.afterDigest },
    modifiedFiles: [target],
    idempotencyKey: `${applyId}:applied`,
  });

  // 5. Finish. Bookkeeping; its loss is not a correctness problem.
  await writeJournal(workspaceRoot, { ...entry, state: "applied", ledgerRef: committed.ledger_ref });

  return { applyId, ledgerRef: committed.ledger_ref, targetPath: target };
}

// ---------------------------------------------------------------------------
// Revert (compare-and-swap)
// ---------------------------------------------------------------------------

export async function revertApply(
  applyId: string,
  workspaceRoot: string,
  options: ApplyOptions,
): Promise<void> {
  if (!isEnabled(options)) throw new ApplyRefused("learn apply is disabled");
  const entry = (await readJournal(workspaceRoot)).find((e) => e.applyId === applyId);
  if (entry === undefined) throw new ApplyError(`no apply journal for ${applyId}`);
  if (entry.state !== "applied") throw new ApplyError(`apply ${applyId} is ${entry.state}, not applied`);

  const current = await readTarget(entry.targetPath);
  // Compare-and-swap. Restoring a snapshot over content we did not write destroys
  // whatever landed after this apply — a data-loss bug dressed as a safety feature.
  if (sha(current.content) !== entry.afterDigest) {
    throw new ApplyError(
      `target has changed since apply ${applyId} (out-of-band edit or a stacked apply); ` +
        "revert refused — resolve explicitly or revert the newer apply first",
    );
  }
  await atomicWriteFile(entry.targetPath, entry.before);
  await guardTransition(guardResource(applyId), "applied", "aborted", {
    artifacts: { reverted_to: entry.beforeDigest },
    modifiedFiles: [entry.targetPath],
    idempotencyKey: `${applyId}:reverted`,
  }).catch(() => {
    // The bytes are already restored; a ledger hiccup must not leave the caller
    // believing the revert failed. Reconciliation will re-derive state from the ledger.
  });
  await writeJournal(workspaceRoot, { ...entry, state: "aborted" });
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface ReconcileReport {
  completed: number;
  rolledBack: number;
  diverged: number;
}

export async function reconcile(
  workspaceRoot: string,
  options: ApplyOptions,
): Promise<ReconcileReport> {
  if (!isEnabled(options)) throw new ApplyRefused("learn apply is disabled");
  const report: ReconcileReport = { completed: 0, rolledBack: 0, diverged: 0 };

  for (const entry of await readJournal(workspaceRoot)) {
    if (entry.state === "applied" || entry.state === "aborted") continue;
    const current = await readTarget(entry.targetPath);
    const digest = sha(current.content);
    const committed = entry.ledgerRef !== undefined;

    if (committed) {
      if (digest === entry.afterDigest) {
        await writeJournal(workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else if (digest === entry.beforeDigest) {
        // The commit happened; the write did not survive. Redo it.
        await atomicWriteFile(entry.targetPath, entry.after);
        await writeJournal(workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (digest === entry.afterDigest) {
      await atomicWriteFile(entry.targetPath, entry.before);
      await abort(workspaceRoot, entry);
      report.rolledBack += 1;
    } else if (digest === entry.beforeDigest) {
      await abort(workspaceRoot, entry);
      report.rolledBack += 1;
    } else {
      // Neither state. Guessing here is how a recovery routine destroys data.
      report.diverged += 1;
    }
  }

  return report;
}

async function abort(workspaceRoot: string, entry: JournalEntry): Promise<void> {
  // Terminating the journal alone would leave the guard in `applying` forever, and
  // current state is derived from the ledger — so the guard must terminate too.
  await guardTransition(guardResource(entry.applyId), "applying", "aborted", {
    artifacts: { aborted: "reconcile" },
    idempotencyKey: `${entry.applyId}:aborted`,
  }).catch(() => {
    // Idempotent by key; a missing or already-terminal guard must not block rollback.
  });
  await writeJournal(workspaceRoot, { ...entry, state: "aborted" });
}

// ---------------------------------------------------------------------------

function guardResource(applyId: string): string {
  return `learn-apply-${applyId}`;
}

async function readTarget(path: string): Promise<{ content: string; existed: boolean }> {
  try {
    return { content: await readFile(path, "utf8"), existed: true };
  } catch {
    return { content: "", existed: false };
  }
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
