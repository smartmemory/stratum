import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { realpathOrSelf, realpathThroughMissing } from "../apply/paths.js";
import {
  applyCandidate as protocolApplyCandidate,
  journalPath as protocolJournalPath,
  readJournal as protocolReadJournal,
  ledgerReceipt as protocolLedgerReceipt,
  revertApply as protocolRevertApply,
  reconcile as protocolReconcile,
  ApplyError,
  ApplyRefused,
  type ApplyAdapter,
  type BaseJournalEntry,
  type AdmissionResult as ProtocolAdmissionResult,
  type ApplyOptions,
  type AppliedResult,
  type Receipt,
  type ReconcileReport,
} from "../apply/protocol.js";
import type { FailureRecord } from "./harvest.js";
import { computeRevisionId, type PatchCandidate } from "./candidate.js";

export { ApplyError, ApplyRefused };
export type { ApplyOptions, AppliedResult, Receipt, ReconcileReport, JournalState } from "../apply/protocol.js";

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

export interface AdmissionResult extends ProtocolAdmissionResult {
  verdicts: Verdict[];
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
  if (typeof candidate.clusterKey !== "string" || sha(candidate.clusterKey) !== candidate.clusterId) {
    throw new ApplyError("candidate clusterId does not match its clusterKey");
  }
  const parts = candidate.clusterKey.split("\u0000");
  const stepScoped = candidate.groupingKey === "step-scoped";
  if ((!stepScoped && candidate.groupingKey !== "step-agnostic") ||
      parts.length !== (stepScoped ? 5 : 4)) {
    throw new ApplyError("candidate clusterKey does not match its groupingKey");
  }
  if (parts[0] !== candidate.scope.workspaceRoot) {
    throw new ApplyError("candidate clusterKey does not match scope.workspaceRoot");
  }
  if (parts[1] !== candidate.scope.flowName) {
    throw new ApplyError("candidate clusterKey does not match scope.flowName");
  }
  if (stepScoped && (candidate.scope.stepIds.length !== 1 || parts[2] !== candidate.scope.stepIds[0])) {
    throw new ApplyError("candidate clusterKey does not match scope.stepIds for step-scoped grouping");
  }
  if (parts[stepScoped ? 3 : 2] !== candidate.shape) {
    throw new ApplyError("candidate clusterKey does not match its shape");
  }
  const expected = computeRevisionId(candidate);
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

export interface JournalEntry extends BaseJournalEntry<FailureRecord> {
  verdicts: Verdict[];
}

export function journalDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".stratum", "learn", "applies");
}

export function journalPath(workspaceRoot: string, applyId: string): string {
  return protocolJournalPath(memoryApplyAdapter, workspaceRoot, applyId);
}

export function readJournal(workspaceRoot: string): Promise<JournalEntry[]> {
  return protocolReadJournal(memoryApplyAdapter, workspaceRoot);
}

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

export async function applyCandidate(candidate: PatchCandidate, options: ApplyOptions): Promise<AppliedResult> {
  if (!isEnabled(options)) {
    throw new ApplyRefused(
      "learn apply is disabled; enable it explicitly (STRATUM_LEARN_APPLY_ENABLED=1)",
    );
  }
  return protocolApplyCandidate(memoryApplyAdapter, candidate, { ...options, enabled: true });
}

export function ledgerReceipt(entry: JournalEntry): Receipt {
  return protocolLedgerReceipt(memoryApplyAdapter, entry);
}

export async function revertApply(applyId: string, workspaceRoot: string, options: ApplyOptions): Promise<void> {
  if (!isEnabled(options)) throw new ApplyRefused("learn apply is disabled");
  return protocolRevertApply(memoryApplyAdapter, applyId, workspaceRoot, { ...options, enabled: true });
}

export async function reconcile(workspaceRoot: string, options: ApplyOptions): Promise<ReconcileReport> {
  if (!isEnabled(options)) throw new ApplyRefused("learn apply is disabled");
  return protocolReconcile(memoryApplyAdapter, workspaceRoot, { ...options, enabled: true });
}

const memoryApplyAdapter: ApplyAdapter<PatchCandidate, FailureRecord, JournalEntry> = {
  kind: "memory",
  enabled: isEnabled,
  workspaceRoot: (candidate) => candidate.scope.workspaceRoot,
  targetPath: (candidate) => candidate.targetPath,
  evidenceFor: (candidate) => candidate.evidence,
  ids: (candidate) => ({ clusterId: candidate.clusterId, revisionId: candidate.revisionId }),
  verifyIdentity,
  allowlist: assertAllowlisted,
  pool: async (_workspaceRoot, target) => {
    try {
      const content = await readFile(target, "utf8");
      return { target: { content, existed: true }, admissionInput: content };
    } catch {
      return { target: { content: "", existed: false }, admissionInput: "" };
    }
  },
  admit: (candidate, pool) => admit(candidate, pool.admissionInput as string),
  renderAfter,
  journalDir,
  journalEntry: (_candidate, base, _admission) => ({
    applyId: base.applyId,
    state: base.state,
    clusterId: base.clusterId,
    revisionId: base.revisionId,
    targetPath: base.targetPath,
    before: base.before,
    beforeDigest: base.beforeDigest,
    after: base.after,
    afterDigest: base.afterDigest,
    existedBefore: base.existedBefore,
    evidence: base.evidence,
    verdicts: base.verdicts as Verdict[],
    at: base.at,
  }),
  guardResource: (applyId) => "learn-apply-" + applyId,
  guardRegistration: () => ({
    graph: { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] },
    edgePredicates: {},
    initial: "staged",
    terminal: ["aborted", "reverted"],
  }),
  transitionArtifacts: (entry, edge) => {
    if (edge === "applying") return { journal_digest: sha(JSON.stringify(entry)), revision_id: entry.revisionId };
    if (edge === "applied") return { after_digest: entry.afterDigest };
    if (edge === "reverted") return { reverted_to: entry.beforeDigest };
    return { aborted: "reconcile" };
  },
  locks: (_workspaceRoot, target) => ["learn-target-" + sha(target).slice(0, 32)],
};

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
