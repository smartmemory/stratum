import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { link, mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity } from "../connectors/proc_identity.js";
import { procStartTime } from "../connectors/proc_identity.js";
import { assertRunId, type PersistedRun, type StateStore } from "./state.js";

/** The general waiter's budget. 300s, not 30s: two locked sections await LLM-scale work —
 *  a judged ensure and the `evaluate:` runner — so a shorter budget would throw
 *  RUN_LOCK_TIMEOUT against a perfectly healthy holder. Staleness is decided by process
 *  identity, never by age, so a long hold is never mistaken for a dead one and this is a
 *  backstop against a wedge rather than a liveness check. */
export const DEFAULT_RUN_LOCK_TIMEOUT_MS = 300_000;
/** How long `flowCancel` waits to ACQUIRE the run lock, before anything is settled. */
export const DEFAULT_CANCEL_LOCK_WAIT_MS = 120_000;
/** The 0.4.0 acknowledgement budget for agent teardown, whose clock starts only AFTER
 *  settlement. A different measurement from the two above; collapsing any two of the three
 *  reintroduces either a false timeout or a cancel that appears to hang. */
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;

/** A `<runId>.lock.<token>` tmp older than this belongs to a process that crashed between
 *  writing it and linking it, and is swept opportunistically. */
const RUN_LOCK_TMP_TTL_MS = 60_000;

export function runLockTimeoutMs(): number {
  return Number(process.env.STRATUM_RUN_LOCK_TIMEOUT_MS ?? DEFAULT_RUN_LOCK_TIMEOUT_MS);
}

export function cancelLockWaitMs(): number {
  return Number(process.env.STRATUM_CANCEL_LOCK_WAIT_MS ?? DEFAULT_CANCEL_LOCK_WAIT_MS);
}

export function cancelTimeoutMs(): number {
  return Number(process.env.STRATUM_CANCEL_TIMEOUT_MS ?? DEFAULT_CANCEL_TIMEOUT_MS);
}

export interface LockRecord {
  pid: number;
  /** REQUIRED (R3-1): a lock owned by a bare pid cannot be aged out safely, because pids
   *  recycle. Without an identity the engine refuses to acquire at all. */
  startTime: string;
  /** Identifies THIS acquisition, so release cannot unlink a successor's lock. */
  token: string;
  at: string;
}

export interface DriverLease {
  pid: number;
  startTime: string;
  token: string;
  at: string;
}

export type ProcessIdentityOracle = (pid: number, startTime: string) => Promise<"alive" | "dead" | "unknown">;

export interface RunLockOptions {
  timeoutMs?: number;
  /** Test seam: the tri-state identity probe used by every reclaim. */
  identity?: ProcessIdentityOracle;
  /** Test seam: this process's own start time (R3-1 refusal is driven through it). */
  selfStartTime?: () => Promise<string | undefined>;
  /** Test seam: age threshold for the tmp-orphan sweep. */
  tmpTtlMs?: number;
  now?: () => number;
  /** Test seam for T-S01-L5: runs between the identity verdict and the inode re-check. */
  beforeBreakUnlink?: () => Promise<void>;
}

export type ReleaseRunLock = () => Promise<void>;

function lockPath(root: string, runId: string): string {
  assertRunId(runId);
  return join(root, `${runId}.lock`);
}

function breakLockPath(root: string, runId: string): string {
  assertRunId(runId);
  return join(root, `${runId}.lock-break`);
}

function driverLeasePath(root: string, runId: string): string {
  assertRunId(runId);
  return join(root, `${runId}.driver`);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRecord(text: string): LockRecord | undefined {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<LockRecord>;
  if (!Number.isSafeInteger(record.pid) || typeof record.startTime !== "string" || !record.startTime) return undefined;
  if (typeof record.token !== "string") return undefined;
  return record as LockRecord;
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch { return undefined; }
  return parseRecord(text);
}

async function unlinkOwn(path: string, token: string): Promise<void> {
  const record = await readRecord(path);
  if (record === undefined || record.token !== token) return;
  try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
}

/** A `<runId>.lock.<token>` that was written but never linked is a crash between publication
 *  steps: there is no lock, only litter. Sweep the aged ones; a FRESH tmp belongs to a
 *  process that is one `link()` away from owning the lock and must be left alone (R4-8). */
async function sweepOrphanTemporaries(root: string, runId: string, options: RunLockOptions): Promise<void> {
  const ttl = options.tmpTtlMs ?? RUN_LOCK_TMP_TTL_MS;
  const nowMs = (options.now ?? Date.now)();
  let names: string[];
  try { names = await readdir(root); } catch { return; }
  const prefix = `${runId}.lock.`;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (nowMs - info.mtimeMs < ttl) continue;
      await unlink(path);
    } catch { /* best-effort: never block an acquisition on the sweep */ }
  }
}

/**
 * Break a lock whose owner is provably dead.
 *
 * Runs under its own tiny lock so two processes cannot race the sequence, and the removal is
 * conditional on the INODE that was actually judged (R3-2): without that re-check, breaker A
 * can read a dead owner's record, be descheduled while B breaks the lock and C acquires it,
 * and then unlink C's live lock.
 *
 * There is no age-based reclaim anywhere here (R4-2). A breaker legitimately waiting out a
 * slow identity probe would be evicted by one, and that eviction then races the breaker it
 * evicted through the very sequence the break-lock exists to serialise.
 *
 * @returns true when the caller should retry the acquire immediately.
 */
async function breakStaleLock(
  root: string,
  runId: string,
  selfStartTime: string,
  identity: ProcessIdentityOracle,
  options: RunLockOptions,
): Promise<boolean> {
  const path = lockPath(root, runId);
  const breakPath = breakLockPath(root, runId);
  const breakToken = randomUUID();
  try {
    const handle = await open(breakPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, startTime: selfStartTime, token: breakToken, at: new Date().toISOString() }));
    } finally { await handle.close(); }
  } catch (error) {
    if (!isExists(error)) throw error;
    // Someone else is mid-break. Reclaim only a provably dead breaker.
    const owner = await readRecord(breakPath);
    if (owner !== undefined && await identity(owner.pid, owner.startTime) === "dead") {
      await unlinkOwn(breakPath, owner.token);
    }
    return false;
  }
  try {
    let inode: number;
    let record: LockRecord | undefined;
    try {
      const handle = await open(path, "r");
      try {
        inode = (await handle.stat()).ino;
        record = parseRecord(await handle.readFile("utf8"));
      } finally { await handle.close(); }
    } catch (error) {
      if (isNotFound(error)) return true;   // released already
      throw error;
    }
    // Unparseable, or missing an identity: treat as LIVE. Never guess — an unreadable
    // identity is "unknown", and nothing reclaims on "unknown".
    if (record === undefined) return false;
    if (await identity(record.pid, record.startTime) !== "dead") return false;
    if (options.beforeBreakUnlink) await options.beforeBreakUnlink();
    let current;
    try { current = await stat(path); } catch (error) { if (isNotFound(error)) return true; throw error; }
    // Someone else already broke it and a NEW lock is published. Do NOT unlink.
    if (current.ino !== inode) return true;
    try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
    return true;
  } finally {
    await unlinkOwn(breakPath, breakToken);
  }
}

/**
 * Acquire the cross-process lock for one run record.
 *
 * Publication is a single atomic step: the complete owner record is written to a private tmp
 * name and then `link()`ed into place, so the lock file never exists half-written and a crash
 * between the two leaves an orphan tmp and NO lock (R3-2).
 */
export async function acquireRunLock(root: string, runId: string, options: RunLockOptions = {}): Promise<ReleaseRunLock> {
  assertRunId(runId);
  const identity = options.identity ?? processIdentity;
  const startTime = await (options.selfStartTime ?? (() => procStartTime(process.pid)))();
  if (startTime === undefined) {
    throw Object.assign(new Error("cannot establish process identity; run locking is unavailable"),
      { code: "RUN_LOCK_IDENTITY_UNAVAILABLE" });
  }
  const path = lockPath(root, runId);
  const nowMs = options.now ?? Date.now;
  const deadline = nowMs() + (options.timeoutMs ?? runLockTimeoutMs());
  await mkdir(root, { recursive: true });
  for (;;) {
    await sweepOrphanTemporaries(root, runId, options);
    const token = randomUUID();
    const temporary = `${path}.${token}`;
    const record: LockRecord = { pid: process.pid, startTime, token, at: new Date().toISOString() };
    writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    let published = false;
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if (!isExists(error)) { await unlink(temporary).catch(() => undefined); throw error; }
    }
    await unlink(temporary).catch(() => undefined);
    if (published) return () => releaseRunLock(path, token);
    if (!await breakStaleLock(root, runId, startTime, identity, options)) {
      if (nowMs() >= deadline) {
        const held = await readRecord(path);
        throw Object.assign(new Error(`run ${runId} lock is held by pid ${held?.pid ?? "?"}`),
          { code: "RUN_LOCK_TIMEOUT", ...(held?.pid !== undefined ? { holderPid: held.pid } : {}) });
      }
      await delay(10 + Math.random() * 40);
    }
  }
}

/** Release unlinks only its OWN lock. A mismatched token means our lock was broken and the
 *  run may already have been re-acquired: unlinking there would delete a live holder's lock,
 *  which is the one way this scheme produces two concurrent writers. */
async function releaseRunLock(path: string, token: string): Promise<void> {
  const record = await readRecord(path);
  if (record === undefined) return;
  if (record.token !== token) {
    process.stderr.write(`stratum: run lock ${path} is no longer ours (held by pid ${record.pid}); release is a no-op\n`);
    return;
  }
  try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
}

export async function readRunLock(root: string, runId: string): Promise<LockRecord | undefined> {
  return readRecord(lockPath(root, runId));
}

/**
 * The driver lease: a durable declaration that ONE live process holds this run's in-memory
 * object (R4-4). Written on the 0 -> 1 pin and unlinked on the return to 0.
 *
 * Written SYNCHRONOUSLY because `retainRun` is synchronous by design — `scheduleFanout` pins
 * with the scheduler's own run object and must not yield between the pin and the launch. A
 * tmp + rename is atomic for a cross-process reader, and a synchronous write leaves no window
 * at all for a same-process one.
 */
export function writeDriverLeaseSync(root: string, runId: string, startTime: string): string {
  const path = driverLeasePath(root, runId);
  const token = randomUUID();
  const lease: DriverLease = { pid: process.pid, startTime, token, at: new Date().toISOString() };
  const temporary = `${path}.${process.pid}.${token}.tmp`;
  writeFileSync(temporary, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return token;
}

export function readDriverLeaseSync(root: string, runId: string): DriverLease | undefined {
  const path = driverLeasePath(root, runId);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const record = parseRecord(text);
  return record as DriverLease | undefined;
}

/** Token-checked exactly as the run lock's release is: never unlink a successor's lease. */
export function releaseDriverLeaseSync(root: string, runId: string, token: string): void {
  const path = driverLeasePath(root, runId);
  const lease = readDriverLeaseSync(root, runId);
  if (lease === undefined || lease.token !== token) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

export function unlinkDriverLeaseSync(root: string, runId: string): void {
  try { unlinkSync(driverLeasePath(root, runId)); } catch { /* already gone */ }
}

/**
 * Load-modify-save one run record under the real cross-process lock.
 *
 * `stratum learn egress` used to build its own `Map`-of-promises lock, which is local to one
 * CLI invocation and therefore excludes nothing — not another `stratum learn`, and certainly
 * not a running engine (R3-3c).
 */
export async function lockedSave<T>(
  store: Pick<StateStore, "root" | "load" | "save">,
  runId: string,
  mutate: (run: PersistedRun) => T | Promise<T>,
  options: RunLockOptions = {},
): Promise<T> {
  const release = await acquireRunLock(store.root, runId, options);
  try {
    const run = await store.load(runId);
    const result = await mutate(run);
    await store.save(run);
    return result;
  } finally {
    await release();
  }
}
