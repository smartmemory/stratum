import { randomUUID } from "node:crypto";
import { linkSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { link, mkdir, open, readdir, stat, unlink, type FileHandle } from "node:fs/promises";
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

/** A `<runId>.lock.<token>` (or `<runId>.lock-break.<token>`) tmp older than this belongs to a
 *  process that crashed between writing it and linking it, and is swept opportunistically. */
const RUN_LOCK_TMP_TTL_MS = 60_000;

/** The ONE age rule in this file, and it applies to exactly one thing: a `.lock-break` that
 *  carries no readable identity at all.
 *
 *  Every other reclaim here is identity-only (R4-2) because there is an owner to judge. An
 *  opaque break-lock has none — no pid, no start time, nothing a probe can answer about — so
 *  identity can never clear it and the run would be wedged forever by a zero-byte file. Age is
 *  the only remaining discriminator, and it is safe here precisely because it is conditioned on
 *  the absence of an identity: a PARSEABLE break-lock is never aged out, however old. */
const BREAK_LOCK_OPAQUE_TTL_MS = 60_000;

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
  /** Test seam for T-S01-L15: runs inside the token+inode CAS, after the record is read and
   *  before the removal is committed. */
  beforeOwnUnlink?: () => Promise<void>;
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

/** Positional read, so the same descriptor can be read more than once. `handle.readFile`
 *  advances the file position and a second call returns "", which would silently turn the CAS
 *  re-read below into "the record vanished". */
async function readHandleRecord(handle: FileHandle): Promise<LockRecord | undefined> {
  const info = await handle.stat();
  if (info.size === 0 || info.size > 64 * 1024) return undefined;
  const buffer = Buffer.allocUnsafe(info.size);
  await handle.read(buffer, 0, info.size, 0);
  return parseRecord(buffer.toString("utf8"));
}

async function readRecord(path: string): Promise<LockRecord | undefined> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); } catch { return undefined; }
  try { return await readHandleRecord(handle); } catch { return undefined; } finally { await handle.close(); }
}

/**
 * Publish a COMPLETE record at `path` in one atomic step (R3-2): write the whole thing to a
 * private tmp name, then `link()` it into place. The published file therefore never exists
 * half-written, and a crash between the two leaves an orphan tmp and NO published record.
 *
 * Used for the run lock AND the break-lock. The break-lock used to be `open(…, "wx")` followed
 * by a separate write, so a crash in between left a zero-byte `.lock-break` that parses to
 * nothing, blocks every future breaker, and — having no identity — could never be reclaimed.
 *
 * @returns false when the path already exists (EEXIST): someone else published first.
 */
async function publishRecord(path: string, record: LockRecord): Promise<boolean> {
  const temporary = `${path}.${record.token}`;
  writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  let published = false;
  try {
    await link(temporary, path);
    published = true;
  } catch (error) {
    if (!isExists(error)) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  await unlink(temporary).catch(() => undefined);
  return published;
}

/**
 * CAS-style removal: unlink `path` only while it still names the INODE we inspected AND that
 * inode's record still carries `token`.
 *
 * The inspected descriptor is held OPEN across the whole comparison, and that is the load-
 * bearing part. A closed descriptor's inode can be recycled between the read and the unlink,
 * so a check that reads, closes, and later unlinks can pass its own comparison against a
 * different file — which is exactly how two reclaimers both judge a dead owner, one removes it,
 * a live successor publishes, and the delayed one deletes the successor.
 *
 * @returns whether this call is the one that removed the record.
 */
async function unlinkOwn(path: string, token: string, options: RunLockOptions = {}): Promise<boolean> {
  let handle: FileHandle;
  try { handle = await open(path, "r"); } catch { return false; }
  try {
    const record = await readHandleRecord(handle);
    if (record === undefined || record.token !== token) return false;
    const inode = (await handle.stat()).ino;
    if (options.beforeOwnUnlink) await options.beforeOwnUnlink();
    let current;
    try { current = await stat(path); } catch (error) { if (isNotFound(error)) return false; throw error; }
    if (current.ino !== inode) return false;              // the path names a successor now
    const still = await readHandleRecord(handle);          // same fd, so the same inode
    if (still === undefined || still.token !== token) return false;
    try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
    return true;
  } catch { return false; } finally { await handle.close(); }
}

/** The opaque-break-lock reclaim (see BREAK_LOCK_OPAQUE_TTL_MS). Conditional on the inode that
 *  was actually judged, exactly as `unlinkOwn` is, and refuses the moment the file turns out to
 *  be parseable after all — an identity that appeared between the two reads is an owner, and
 *  owners are judged by liveness, never by age. */
async function reclaimOpaqueBreakLock(path: string, options: RunLockOptions): Promise<boolean> {
  const ttl = options.tmpTtlMs ?? BREAK_LOCK_OPAQUE_TTL_MS;
  const nowMs = (options.now ?? Date.now)();
  let handle: FileHandle;
  try { handle = await open(path, "r"); } catch { return false; }
  try {
    const info = await handle.stat();
    if (await readHandleRecord(handle) !== undefined) return false;   // it has an identity: not ours to age out
    if (nowMs - info.mtimeMs < ttl) return false;                     // a breaker may still be mid-write
    let current;
    try { current = await stat(path); } catch (error) { if (isNotFound(error)) return false; throw error; }
    if (current.ino !== info.ino) return false;
    try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
    return true;
  } catch { return false; } finally { await handle.close(); }
}

/** A `<runId>.lock.<token>` that was written but never linked is a crash between publication
 *  steps: there is no lock, only litter. Sweep the aged ones; a FRESH tmp belongs to a
 *  process that is one `link()` away from owning the lock and must be left alone (R4-8). */
async function sweepOrphanTemporaries(root: string, runId: string, options: RunLockOptions): Promise<void> {
  const ttl = options.tmpTtlMs ?? RUN_LOCK_TMP_TTL_MS;
  const nowMs = (options.now ?? Date.now)();
  let names: string[];
  try { names = await readdir(root); } catch { return; }
  // BOTH publication tmps: the run lock's `<runId>.lock.<token>` and the break-lock's
  // `<runId>.lock-break.<token>`. The break-lock is published by the same protocol, so it
  // leaves the same litter and needs the same sweep.
  const prefixes = [`${runId}.lock.`, `${runId}.lock-break.`];
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
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
  const breakRecord: LockRecord = { pid: process.pid, startTime: selfStartTime, token: breakToken, at: new Date().toISOString() };
  if (!await publishRecord(breakPath, breakRecord)) {
    // Someone else is mid-break. Reclaim only a provably dead breaker — or, if the record
    // carries no identity at all, only an aged one (BREAK_LOCK_OPAQUE_TTL_MS).
    const owner = await readRecord(breakPath);
    if (owner === undefined) await reclaimOpaqueBreakLock(breakPath, options);
    else if (await identity(owner.pid, owner.startTime) === "dead") await unlinkOwn(breakPath, owner.token, options);
    return false;
  }
  try {
    // The descriptor stays OPEN from the read through the comparison. Closing it first lets the
    // inode be recycled underneath the check, which makes the inode comparison meaningless.
    let handle: FileHandle;
    try { handle = await open(path, "r"); }
    catch (error) {
      if (isNotFound(error)) return true;   // released already
      throw error;
    }
    try {
      const inode = (await handle.stat()).ino;
      const record = await readHandleRecord(handle);
      // Unparseable, or missing an identity: treat as LIVE. Never guess — an unreadable
      // identity is "unknown", and nothing reclaims on "unknown".
      if (record === undefined) return false;
      if (await identity(record.pid, record.startTime) !== "dead") return false;
      if (options.beforeBreakUnlink) await options.beforeBreakUnlink();
      let current;
      try { current = await stat(path); } catch (error) { if (isNotFound(error)) return true; throw error; }
      // Someone else already broke it and a NEW lock is published. Do NOT unlink.
      if (current.ino !== inode) return true;
      // Inode AND token, immediately before the removal, off the descriptor we judged.
      const still = await readHandleRecord(handle);
      if (still === undefined || still.token !== record.token) return false;
      try { await unlink(path); } catch (error) { if (!isNotFound(error)) throw error; }
      return true;
    } finally { await handle.close(); }
  } finally {
    await unlinkOwn(breakPath, breakToken, options);
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
    const record: LockRecord = { pid: process.pid, startTime, token, at: new Date().toISOString() };
    if (await publishRecord(path, record)) return () => releaseRunLock(path, token, options);
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
async function releaseRunLock(path: string, token: string, options: RunLockOptions = {}): Promise<void> {
  const record = await readRecord(path);
  if (record === undefined) return;
  if (record.token !== token) {
    process.stderr.write(`stratum: run lock ${path} is no longer ours (held by pid ${record.pid}); release is a no-op\n`);
    return;
  }
  // Not a bare unlink: the same token+inode CAS the break-lock reclaim uses. The token read
  // above is already stale by the time we act on it.
  await unlinkOwn(path, token, options);
}

export async function readRunLock(root: string, runId: string): Promise<LockRecord | undefined> {
  return readRecord(lockPath(root, runId));
}

/**
 * The driver lease: a durable declaration that ONE live process holds this run's in-memory
 * object (R4-4). Written on the 0 -> 1 pin and unlinked on the return to 0.
 *
 * Written SYNCHRONOUSLY because `retainRun` is synchronous by design — `scheduleFanout` pins
 * with the scheduler's own run object and must not yield between the pin and the launch.
 *
 * The claim is EXCLUSIVE. It used to be a `rename()`, which silently overwrote whatever was
 * there — so a second driver could publish its lease over a live one and the run would have two
 * processes each believing they owned the in-memory copy, which is the single condition the
 * lease exists to make impossible. `link()` fails with EEXIST instead, and the caller must
 * resolve the incumbent by IDENTITY (dead -> reclaim, alive or unknown -> refuse) before
 * retrying. The one case resolved here is an incumbent that is literally us: the same pid AND
 * the same start time is our own leftover lease, and reclaiming it needs no probe.
 *
 * @throws DRIVER_LEASE_HELD when a lease that is not ours already exists.
 */
export function writeDriverLeaseSync(root: string, runId: string, startTime: string): string {
  const path = driverLeasePath(root, runId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const lease: DriverLease = { pid: process.pid, startTime, token, at: new Date().toISOString() };
    const temporary = `${path}.${process.pid}.${token}.tmp`;
    writeFileSync(temporary, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
    let claimed = false;
    try { linkSync(temporary, path); claimed = true; }
    catch (error) {
      if (!isExists(error)) { try { unlinkSync(temporary); } catch { /* best effort */ } throw error; }
    }
    try { unlinkSync(temporary); } catch { /* best effort */ }
    if (claimed) return token;
    const held = readDriverLeaseSync(root, runId);
    // Our own process, our own boot: a leftover of ours, and reclaiming it is not a race.
    if (held !== undefined && held.pid === process.pid && held.startTime === startTime) {
      releaseDriverLeaseSync(root, runId, held.token);
      continue;
    }
    throw Object.assign(
      new Error(`run ${runId} driver lease is held${held !== undefined ? ` by pid ${held.pid}` : ""}`),
      { code: "DRIVER_LEASE_HELD", ...(held?.pid !== undefined ? { holderPid: held.pid } : {}) },
    );
  }
  throw Object.assign(new Error(`run ${runId} driver lease could not be claimed`), { code: "DRIVER_LEASE_HELD" });
}

export function readDriverLeaseSync(root: string, runId: string): DriverLease | undefined {
  const path = driverLeasePath(root, runId);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  const record = parseRecord(text);
  return record as DriverLease | undefined;
}

/** Token-checked exactly as the run lock's release is: never unlink a successor's lease.
 *
 *  ENOENT is the only swallowed failure. A blanket catch here turns EACCES or EIO into a lease
 *  that is never removed, which wedges the run for every other process — and reports success
 *  while doing it. */
export function releaseDriverLeaseSync(root: string, runId: string, token: string): void {
  const path = driverLeasePath(root, runId);
  const lease = readDriverLeaseSync(root, runId);
  if (lease === undefined || lease.token !== token) return;
  try { unlinkSync(path); } catch (error) { if (!isNotFound(error)) throw error; }
}

export function unlinkDriverLeaseSync(root: string, runId: string): void {
  try { unlinkSync(driverLeasePath(root, runId)); } catch (error) { if (!isNotFound(error)) throw error; }
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
