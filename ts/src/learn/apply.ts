import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { registerGuard, guardTransition, _payloadDigest } from "../guard/transition.js";
import { readLedger, resourceDir } from "../guard/store.js";
import { resourceLock } from "../guard/lock.js";
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
  else {
    // Overlap beyond identical text: a note about the same field of the same flow is
    // covered by, or contradicts, what is already there. Either way it is not a
    // marginal gain and a human should decide which one is right.
    const subject = noteSubject(candidate.rendered.content);
    if (subject !== null) {
      for (const line of pool.split("\n")) {
        if (line.includes(marker)) continue;
        if (noteSubject(line) === subject) {
          findings.push(`pool already carries a note about ${subject}; resolve which is right`);
          break;
        }
      }
    }
  }
  return { critic: "subset-marginal-gain", passes: findings.length === 0, findings };
}

/**
 * `<flow>/<field>` — the thing a note is about. Deliberately coarse: it catches
 * overlap and same-subject contradiction, and it does NOT catch two notes that conflict
 * while naming different subjects. Genuine semantic conflict detection is specified in
 * ../STRAT-ADMIT and is not implemented here.
 */
function noteSubject(line: string): string | null {
  const match = /recurring \w+ failure on ([\w.]+)\*\* — In flow `([^`]+)`/.exec(line);
  return match === null ? null : `${match[2]}/${match[1]}`;
}

/** The bytes must be the bytes the revision id names. */
export function verifyIdentity(candidate: PatchCandidate): void {
  const expected = sha(
    [
      candidate.clusterId,
      candidate.rendered.templateVersion,
      candidate.rendered.content,
      candidate.targetPath,
      candidate.rendered.insertion.mode,
      candidate.rendered.insertion.section,
    ].join("\u0000"),
  );
  if (expected !== candidate.revisionId) {
    throw new ApplyError(
      "candidate identity does not match its content; the sidecar row was edited after staging",
    );
  }
  const runs = new Set(candidate.evidence.map((record) => record.runId)).size;
  if (runs !== candidate.recurrence.distinctRuns) {
    throw new ApplyError(
      `candidate claims ${candidate.recurrence.distinctRuns} distinct runs but carries ${runs}`,
    );
  }
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

export type JournalState =
  | "prepared"
  | "applying"
  | "applied"
  | "reverting"
  | "reverted"
  | "aborted";

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

/**
 * G4: the target must sit inside the project's own learn directory — checked against the
 * REAL path, not the lexical one. `resolve()` alone collapses `..` but follows no
 * symlinks, so a symlinked `.stratum/learn` would place the write outside the allowlist
 * while passing a purely lexical check.
 */
async function assertAllowlisted(workspaceRoot: string, targetPath: string): Promise<string> {
  const target = resolve(targetPath);
  if (!target.endsWith(".md")) throw new ApplyError(`target is not a note file: ${target}`);

  const realRoot = await realpathOrSelf(resolve(workspaceRoot));
  const allowed = await realpathOrSelf(join(realRoot, ".stratum", "learn"));
  // The allowlist DIRECTORY must itself be inside the workspace. Without this, a
  // symlinked `.stratum/learn` makes `allowed` and the target agree on a path outside
  // the project entirely, and the prefix test below passes happily.
  if (allowed !== realRoot && !allowed.startsWith(realRoot + sep)) {
    throw new ApplyError(`learn directory resolves outside the workspace: ${allowed}`);
  }
  // The file (and its parents) may not exist yet, so resolve the nearest EXISTING
  // ancestor and re-attach the remaining components. Resolving only the immediate
  // parent leaves an unresolved path when the parent is itself missing, which both
  // misses symlinks higher in the chain and, on macOS, fails to normalize /var.
  const real = await realpathThroughMissing(target);
  if (real !== allowed && !real.startsWith(allowed + sep)) {
    throw new ApplyError(`target is outside the memory allowlist: ${real}`);
  }
  return real;
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** realpath of the deepest existing ancestor, with the missing tail re-attached. */
async function realpathThroughMissing(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch {
      const parent = dirname(current);
      // Reached the filesystem root without finding anything real.
      if (parent === current) return resolve(path);
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
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
  // Append INSIDE the section: appending at end-of-document drops the note under
  // whatever heading happens to come last.
  const lines = before.replace(/\n*$/, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === insertion.section.trim());
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i] ?? "")) { end = i; break; }
  }
  while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
  lines.splice(end, 0, content);
  return lines.join("\n").replace(/\n*$/, "\n");
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
  verifyIdentity(candidate);
  const workspaceRoot = candidate.scope.workspaceRoot;
  const target = await assertAllowlisted(workspaceRoot, candidate.targetPath);

  // Serialize on the TARGET, not the apply: two candidates racing on one file could
  // otherwise both snapshot the same `before`, both pass the digest check, overwrite
  // each other, and both commit — leaving one ledger entry describing bytes that are
  // no longer on disk.
  return resourceLock(`learn-target-${sha(target).slice(0, 32)}`, async () => {
    // An unreconciled journal means the target's true state is unknown; applying on top
    // would bury the ambiguity.
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
    // UNIQUE PER ATTEMPT. A deterministic id would reuse the guard resource when the
    // same revision is applied again after a revert, colliding with that resource's
    // terminal state and its spent idempotency keys.
    const applyId = sha(randomUUID()).slice(0, 32);

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
      // `applied` is NOT terminal: revert is a legal, ledger-recorded edge out of it.
      // Registering it terminal made every revert an illegal transition that threw and
      // was swallowed, leaving the ledger claiming `applied` over reverted bytes.
      { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] },
      {},
      "staged",
      ["aborted", "reverted"],
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

    // 5. Finish. Bookkeeping; its loss is not a correctness problem, because recovery
    //    reads the LEDGER rather than this field.
    await writeJournal(workspaceRoot, { ...entry, state: "applied", ledgerRef: committed.ledger_ref });

    return { applyId, ledgerRef: committed.ledger_ref, targetPath: target };
  });
}

/** A ledger receipt, or why we could not read one. */
type Receipt =
  | { kind: "committed"; state: "applied" | "reverted" }
  | { kind: "absent" }
  | { kind: "unreadable" };

/**
 * What the LEDGER says about an apply, bound to THIS journal record.
 *
 * A state string alone is not enough: it would let a modified journal borrow an
 * unrelated `applied` receipt and write different bytes, or a different allowlisted
 * target, under it. So the receipt must match the transition payload we would have
 * committed for exactly this entry.
 */
function ledgerReceipt(entry: JournalEntry): Receipt {
  const resource = guardResource(entry.applyId);
  let entries;
  try {
    entries = readLedger(resource);
  } catch {
    // Corruption must never be read as "nothing committed" — that answer authorizes a
    // destructive rollback. Diverge instead. Every read failure is treated this way,
    // not just LedgerCorrupt: an unexpected error tells us just as little.
    return { kind: "unreadable" };
  }

  // readLedger TRUNCATES at a malformed trailing line rather than throwing (a partial
  // append is normal). Truncation and "nothing was ever written" are indistinguishable
  // from the returned array, and only one of them may authorize a rollback — so compare
  // against the raw line count.
  let rawLines = 0;
  try {
    const raw = readFileSync(join(resourceDir(resource), "ledger.jsonl"), "utf8");
    rawLines = raw.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    rawLines = 0; // no ledger file at all
  }
  if (rawLines > entries.length) return { kind: "unreadable" };
  if (entries.length === 0) return { kind: "absent" };

  const appliedDigest = _payloadDigest(
    "applying",
    "applied",
    { after_digest: entry.afterDigest },
    [entry.targetPath],
    "agent",
  );
  const revertedDigest = _payloadDigest(
    "applied",
    "reverted",
    { reverted_to: entry.beforeDigest },
    [entry.targetPath],
    "agent",
  );

  let receipt: Receipt = { kind: "absent" };
  for (const row of entries) {
    const dict = row.toDict();
    if (dict.to_state === "applied" && dict.payload_digest === appliedDigest) {
      receipt = { kind: "committed", state: "applied" };
    }
    if (dict.to_state === "reverted" && dict.payload_digest === revertedDigest) {
      // A revert receipt wins: it is strictly later in this resource's lifecycle.
      return { kind: "committed", state: "reverted" };
    }
  }
  return receipt;
}

/** The guard's current state, for choosing a legal abort edge. */
function guardState(applyId: string): string | null {
  try {
    const entries = readLedger(guardResource(applyId));
    const last = entries[entries.length - 1];
    return last === undefined ? "staged" : last.toDict().to_state;
  } catch {
    return null;
  }
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

  // Revalidate the journalled path: a journal is a plain file, and revert writes to
  // whatever it names.
  const target = await assertAllowlisted(workspaceRoot, entry.targetPath);

  await resourceLock(`learn-target-${sha(target).slice(0, 32)}`, async () => {
    const current = await readTarget(target);
    // Compare-and-swap. Restoring a snapshot over content we did not write destroys
    // whatever landed after this apply — a data-loss bug dressed as a safety feature.
    if (sha(current.content) !== entry.afterDigest) {
      throw new ApplyError(
        `target has changed since apply ${applyId} (out-of-band edit or a stacked apply); ` +
          "revert refused — resolve explicitly or revert the newer apply first",
      );
    }
    // `reverting` is durable BEFORE either the ledger or the bytes move, so every crash
    // window below lands on a journal state reconciliation can actually see.
    await writeJournal(workspaceRoot, { ...entry, state: "reverting" });
    await guardTransition(guardResource(applyId), "applied", "reverted", {
      artifacts: { reverted_to: entry.beforeDigest },
      modifiedFiles: [target],
      idempotencyKey: `${applyId}:reverted`,
    });
    await restore(target, entry);
    await writeJournal(workspaceRoot, { ...entry, state: "reverted" });
  });
}

/** Restore the target to its pre-apply state — including not existing at all. */
async function restore(target: string, entry: JournalEntry): Promise<void> {
  if (!entry.existedBefore) {
    // The apply created this file. Leaving an empty one behind is not a restore.
    await rm(target, { force: true });
    return;
  }
  await atomicWriteFile(target, entry.before);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface ReconcileReport {
  completed: number;
  rolledBack: number;
  reverted: number;
  diverged: number;
}

/**
 * Drive every non-terminal journal to a terminal state, using the LEDGER as the
 * authority and refusing to mutate whenever the evidence is ambiguous.
 */
export async function reconcile(
  workspaceRoot: string,
  options: ApplyOptions,
): Promise<ReconcileReport> {
  if (!isEnabled(options)) throw new ApplyRefused("learn apply is disabled");
  const report: ReconcileReport = { completed: 0, rolledBack: 0, reverted: 0, diverged: 0 };

  for (const entry of await readJournal(workspaceRoot)) {
    const terminal = entry.state === "applied" || entry.state === "aborted" || entry.state === "reverted";
    // `applied` is included below only when its receipt is missing — see the revert
    // crash window, where the ledger says reverted but the journal still says applied.
    if (terminal && entry.state !== "applied") continue;

    let target: string;
    try {
      target = await assertAllowlisted(workspaceRoot, entry.targetPath);
    } catch {
      report.diverged += 1;
      continue;
    }

    const receipt = ledgerReceipt(entry);
    if (receipt.kind === "unreadable") {
      // A corrupt ledger tells us nothing, and "nothing" must not authorize a write.
      report.diverged += 1;
      continue;
    }
    if (entry.state === "applied" && receipt.kind === "committed" && receipt.state === "applied") {
      continue; // settled
    }

    const current = await readTarget(target);
    const digest = sha(current.content);

    // The revert committed. Finish it, whatever the journal claims.
    if (receipt.kind === "committed" && receipt.state === "reverted") {
      if (digest === entry.beforeDigest && current.existed === entry.existedBefore) {
        await writeJournal(workspaceRoot, { ...entry, state: "reverted" });
        report.reverted += 1;
      } else if (digest === entry.afterDigest) {
        await restore(target, entry);
        await writeJournal(workspaceRoot, { ...entry, state: "reverted" });
        report.reverted += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (receipt.kind === "committed" && receipt.state === "applied") {
      if (digest === entry.afterDigest) {
        await writeJournal(workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else if (digest === entry.beforeDigest) {
        // The commit happened; the write did not survive. Redo it.
        await atomicWriteFile(target, entry.after);
        await writeJournal(workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    // No receipt. A `reverting` or `applied` journal here means the revert never
    // committed, so the apply stands.
    if (entry.state === "reverting" || entry.state === "applied") {
      if (digest === entry.afterDigest) {
        await writeJournal(workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (digest === entry.afterDigest) {
      await restore(target, entry);
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
  // Terminating the journal alone would leave the guard non-terminal forever, and state
  // is derived from the ledger. The legal edge depends on where the guard actually is:
  // a crash right after registration leaves it at `staged`, not `applying`.
  const from = guardState(entry.applyId);
  if (from === "staged" || from === "applying") {
    await guardTransition(guardResource(entry.applyId), from, "aborted", {
      artifacts: { aborted: "reconcile" },
      idempotencyKey: `${entry.applyId}:aborted`,
    }).catch(() => {
      // Idempotent by key; a racing reconcile must not block the rollback.
    });
  }
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
