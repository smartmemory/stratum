import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resourceLock } from "../guard/lock.js";
import { loadRegistry, readLedger, resourceDir } from "../guard/store.js";
import { guardTransition, noteLegacyDigestMatch, payloadDigestForVersion, registerGuard } from "../guard/transition.js";

export class ApplyError extends Error {}
export class ApplyRefused extends ApplyError {}

export interface ApplyOptions {
  enabled?: boolean;
}

export type JournalState = "prepared" | "applying" | "applied" | "reverting" | "reverted" | "aborted";

export interface AdmissionResult {
  admitted: boolean;
  verdicts: Array<{ critic: string; passes: boolean; findings: string[] }>;
  candidateDigest: string;
  poolDigest: string;
}

export interface BaseJournalEntry<E> {
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
  evidence: E[];
  verdicts: AdmissionResult["verdicts"];
  ledgerRef?: string;
  at: string;
}

export interface PoolView {
  target: { content: string; existed: boolean };
  admissionInput: unknown;
}

export interface GuardRegistration {
  graph: Parameters<typeof registerGuard>[1];
  edgePredicates: Parameters<typeof registerGuard>[2];
  initial: Parameters<typeof registerGuard>[3];
  terminal: Parameters<typeof registerGuard>[4];
  stakes?: Parameters<typeof registerGuard>[5];
  workspaceRoot?: Parameters<typeof registerGuard>[6];
  policyBundle?: Parameters<typeof registerGuard>[7];
}

export interface ApplyAdapter<C, E, J extends BaseJournalEntry<E>> {
  kind: "memory" | "asset";
  enabled(options: ApplyOptions): boolean;
  workspaceRoot(candidate: C): string;
  targetPath(candidate: C): string;
  evidenceFor(candidate: C): E[];
  ids(candidate: C): { clusterId: string; revisionId: string };
  verifyIdentity(candidate: C): void;
  allowlist(workspaceRoot: string, targetPath: string): Promise<string>;
  pool(workspaceRoot: string, target: string): Promise<PoolView>;
  admit(candidate: C, pool: PoolView): Promise<AdmissionResult>;
  renderAfter(before: string, candidate: C): string;
  journalDir(workspaceRoot: string): string;
  journalEntry(candidate: C, base: BaseJournalEntry<E>, admission: AdmissionResult): J;
  guardResource(applyId: string): string;
  guardRegistration(): GuardRegistration;
  transitionArtifacts(entry: J, edge: "applying" | "applied" | "reverted" | "aborted"): Record<string, string>;
  locks(workspaceRoot: string, target: string): string[];
}

export interface AppliedResult {
  applyId: string;
  ledgerRef: string;
  targetPath: string;
}

export type Receipt =
  | { kind: "committed"; state: "applied" | "reverted" }
  | { kind: "absent" }
  | { kind: "unreadable" };

export interface ReconcileReport {
  completed: number;
  rolledBack: number;
  reverted: number;
  diverged: number;
}

export function journalPath<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, workspaceRoot: string, applyId: string,
): string {
  return join(adapter.journalDir(workspaceRoot), `${applyId}.json`);
}

export async function readJournal<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, workspaceRoot: string,
): Promise<J[]> {
  let names: string[];
  try {
    names = (await readdir(adapter.journalDir(workspaceRoot))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: J[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(adapter.journalDir(workspaceRoot), name), "utf8")) as J);
    } catch {
      // A corrupt journal record must not hide the others.
    }
  }
  return out;
}

async function writeJournal<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, workspaceRoot: string, entry: J,
): Promise<void> {
  const path = journalPath(adapter, workspaceRoot, entry.applyId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(entry, null, 2), "utf8");
  await rename(temporary, path);
}

async function withLocks<T>(resources: string[], action: () => Promise<T>, index = 0): Promise<T> {
  const resource = resources[index];
  if (resource === undefined) return action();
  return resourceLock(resource, () => withLocks(resources, action, index + 1));
}

export async function applyCandidate<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, candidate: C, options: ApplyOptions,
): Promise<AppliedResult> {
  if (!adapter.enabled(options)) throw new ApplyRefused("apply is disabled");
  adapter.verifyIdentity(candidate);
  const workspaceRoot = adapter.workspaceRoot(candidate);
  const target = await adapter.allowlist(workspaceRoot, adapter.targetPath(candidate));

  return withLocks(adapter.locks(workspaceRoot, target), async () => {
    for (const entry of await readJournal(adapter, workspaceRoot)) {
      if (entry.targetPath === target && (entry.state === "prepared" || entry.state === "applying")) {
        throw new ApplyError(`target has an unreconciled apply (${entry.applyId}); reconcile first`);
      }
    }

    const pool = await adapter.pool(workspaceRoot, target);
    const { content: before, existed } = pool.target;
    const admission = await adapter.admit(candidate, pool);
    if (!admission.admitted) {
      const failed = admission.verdicts.filter((verdict) => !verdict.passes);
      throw new ApplyRefused(
        `admission refused: ${failed.map((verdict) => `${verdict.critic} (${verdict.findings.join("; ")})`).join(", ")}`,
      );
    }

    const after = adapter.renderAfter(before, candidate);
    const applyId = sha(randomUUID()).slice(0, 32);
    const ids = adapter.ids(candidate);
    const entry = adapter.journalEntry(candidate, {
      applyId,
      state: "prepared",
      clusterId: ids.clusterId,
      revisionId: ids.revisionId,
      targetPath: target,
      before,
      beforeDigest: sha(before),
      after,
      afterDigest: sha(after),
      existedBefore: existed,
      evidence: adapter.evidenceFor(candidate),
      verdicts: admission.verdicts,
      at: new Date().toISOString(),
    }, admission);
    await writeJournal(adapter, workspaceRoot, entry);

    const resourceId = adapter.guardResource(applyId);
    const registration = adapter.guardRegistration();
    await registerGuard(
      resourceId, registration.graph, registration.edgePredicates, registration.initial,
      registration.terminal, registration.stakes, registration.workspaceRoot, registration.policyBundle,
    );
    await guardTransition(resourceId, "staged", "applying", {
      artifacts: adapter.transitionArtifacts(entry, "applying"),
      idempotencyKey: `${applyId}:applying`,
    });
    await writeJournal(adapter, workspaceRoot, { ...entry, state: "applying" });

    const current = await readTarget(target);
    if (sha(current.content) !== entry.beforeDigest) {
      throw new ApplyError("target changed between snapshot and write; aborting");
    }
    await atomicWriteFile(target, after);

    const committed = await guardTransition(resourceId, "applying", "applied", {
      artifacts: adapter.transitionArtifacts(entry, "applied"),
      modifiedFiles: [target],
      idempotencyKey: `${applyId}:applied`,
    });
    await writeJournal(adapter, workspaceRoot, { ...entry, state: "applied", ledgerRef: committed.ledger_ref });
    return { applyId, ledgerRef: committed.ledger_ref, targetPath: target };
  });
}

export function ledgerReceipt<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, entry: J,
): Receipt {
  const resource = adapter.guardResource(entry.applyId);
  let entries;
  try {
    entries = readLedger(resource);
  } catch {
    return { kind: "unreadable" };
  }
  let rawLines = 0;
  try {
    const raw = readFileSync(join(resourceDir(resource), "ledger.jsonl"), "utf8");
    rawLines = raw.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    rawLines = 0;
  }
  if (rawLines > entries.length) return { kind: "unreadable" };
  if (entries.length === 0) return { kind: "absent" };

  let policyChecksum: string;
  try {
    const registry = loadRegistry(resource);
    if (registry === null) return { kind: "unreadable" };
    policyChecksum = registry.checksum;
  } catch {
    return { kind: "unreadable" };
  }

  let receipt: Receipt = { kind: "absent" };
  for (const row of entries) {
    const dict = row.toDict();
    const appliedDigest = payloadDigestForVersion(
      "applying", "applied", adapter.transitionArtifacts(entry, "applied"), [entry.targetPath], "agent", policyChecksum,
      row.payload_digest_version,
    );
    const revertedDigest = payloadDigestForVersion(
      "applied", "reverted", adapter.transitionArtifacts(entry, "reverted"), [entry.targetPath], "agent", policyChecksum,
      row.payload_digest_version,
    );
    if (dict.to_state === "applied" && dict.payload_digest === appliedDigest) {
      if (row.payload_digest_version === 1) noteLegacyDigestMatch(resource);
      receipt = { kind: "committed", state: "applied" };
    }
    if (dict.to_state === "reverted" && dict.payload_digest === revertedDigest) {
      if (row.payload_digest_version === 1) noteLegacyDigestMatch(resource);
      return { kind: "committed", state: "reverted" };
    }
  }
  return receipt;
}

function guardState<C, E, J extends BaseJournalEntry<E>>(adapter: ApplyAdapter<C, E, J>, applyId: string): string | null {
  try {
    const entries = readLedger(adapter.guardResource(applyId));
    const last = entries[entries.length - 1];
    return last === undefined ? "staged" : last.toDict().to_state;
  } catch {
    return null;
  }
}

export async function revertApply<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, applyId: string, workspaceRoot: string, options: ApplyOptions,
): Promise<void> {
  if (!adapter.enabled(options)) throw new ApplyRefused("apply is disabled");
  const entry = (await readJournal(adapter, workspaceRoot)).find((item) => item.applyId === applyId);
  if (entry === undefined) throw new ApplyError(`no apply journal for ${applyId}`);
  if (entry.state !== "applied") throw new ApplyError(`apply ${applyId} is ${entry.state}, not applied`);
  const target = await adapter.allowlist(workspaceRoot, entry.targetPath);

  await withLocks(adapter.locks(workspaceRoot, target), async () => {
    const current = await readTarget(target);
    if (sha(current.content) !== entry.afterDigest) {
      throw new ApplyError(
        `target has changed since apply ${applyId} (out-of-band edit or a stacked apply); ` +
          "revert refused — resolve explicitly or revert the newer apply first",
      );
    }
    await writeJournal(adapter, workspaceRoot, { ...entry, state: "reverting" });
    await guardTransition(adapter.guardResource(applyId), "applied", "reverted", {
      artifacts: adapter.transitionArtifacts(entry, "reverted"),
      modifiedFiles: [target],
      idempotencyKey: `${applyId}:reverted`,
    });
    await restore(target, entry);
    await writeJournal(adapter, workspaceRoot, { ...entry, state: "reverted" });
  });
}

async function restore<E>(target: string, entry: BaseJournalEntry<E>): Promise<void> {
  if (!entry.existedBefore) {
    await rm(target, { force: true });
    return;
  }
  await atomicWriteFile(target, entry.before);
}

export async function reconcile<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, workspaceRoot: string, options: ApplyOptions,
): Promise<ReconcileReport> {
  if (!adapter.enabled(options)) throw new ApplyRefused("apply is disabled");
  const report: ReconcileReport = { completed: 0, rolledBack: 0, reverted: 0, diverged: 0 };

  for (const entry of await readJournal(adapter, workspaceRoot)) {
    const terminal = entry.state === "applied" || entry.state === "aborted" || entry.state === "reverted";
    if (terminal && entry.state !== "applied") continue;

    let target: string;
    try {
      target = await adapter.allowlist(workspaceRoot, entry.targetPath);
    } catch {
      report.diverged += 1;
      continue;
    }

    const receipt = ledgerReceipt(adapter, entry);
    if (receipt.kind === "unreadable") {
      report.diverged += 1;
      continue;
    }
    if (entry.state === "applied" && receipt.kind === "committed" && receipt.state === "applied") {
      continue;
    }

    const current = await readTarget(target);
    const digest = sha(current.content);

    if (receipt.kind === "committed" && receipt.state === "reverted") {
      if (digest === entry.beforeDigest && current.existed === entry.existedBefore) {
        await writeJournal(adapter, workspaceRoot, { ...entry, state: "reverted" });
        report.reverted += 1;
      } else if (digest === entry.afterDigest) {
        await restore(target, entry);
        await writeJournal(adapter, workspaceRoot, { ...entry, state: "reverted" });
        report.reverted += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (receipt.kind === "committed" && receipt.state === "applied") {
      if (digest === entry.afterDigest) {
        await writeJournal(adapter, workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else if (digest === entry.beforeDigest) {
        await atomicWriteFile(target, entry.after);
        await writeJournal(adapter, workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (entry.state === "reverting" || entry.state === "applied") {
      if (digest === entry.afterDigest) {
        await writeJournal(adapter, workspaceRoot, { ...entry, state: "applied" });
        report.completed += 1;
      } else {
        report.diverged += 1;
      }
      continue;
    }

    if (digest === entry.afterDigest) {
      await restore(target, entry);
      await abort(adapter, workspaceRoot, entry);
      report.rolledBack += 1;
    } else if (digest === entry.beforeDigest) {
      await abort(adapter, workspaceRoot, entry);
      report.rolledBack += 1;
    } else {
      report.diverged += 1;
    }
  }

  return report;
}

export async function abort<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>, workspaceRoot: string, entry: J,
): Promise<void> {
  const from = guardState(adapter, entry.applyId);
  if (from === "staged" || from === "applying") {
    await guardTransition(adapter.guardResource(entry.applyId), from, "aborted", {
      artifacts: adapter.transitionArtifacts(entry, "aborted"),
      idempotencyKey: `${entry.applyId}:aborted`,
    }).catch(() => {});
  }
  await writeJournal(adapter, workspaceRoot, { ...entry, state: "aborted" });
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
