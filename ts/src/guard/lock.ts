/** Per-resource in-process and cross-process guard locking. */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { promisify } from "node:util";
import { resourceDir } from "./store.js";

const execFileAsync = promisify(execFile);

export type ProcessIdentity = { alive: boolean; startTime: string | null };
export type ProcessIdentityProvider = (pid: number) => Promise<ProcessIdentity>;

export interface ResourceLockHandle {
  token: string;
}

export interface ResourceLockOptions {
  timeoutMs?: number;
  minRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface ResourceLockManagerOptions extends ResourceLockOptions {
  pid?: number;
  processIdentity?: ProcessIdentityProvider;
  token?: () => string;
}

type LockOwner = {
  token: string;
  pid: number;
  procStartTime: string;
  since?: string;
};

type LockRead =
  | { kind: "missing" }
  | { kind: "owner"; owner: LockOwner };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_RETRY_DELAY_MS = 10;
const DEFAULT_MAX_RETRY_DELAY_MS = 250;
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that the pid exists even though it cannot be signalled.
    if (isErrno(error, "EPERM")) return true;
    if (isErrno(error, "ESRCH")) return false;
    // An unfamiliar probe failure cannot safely establish death.
    return true;
  }
}

async function linuxStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name is parenthesized and may itself contain spaces or ')'.
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fieldsFromThree = stat.slice(close + 2).trim().split(/\s+/);
    return fieldsFromThree[19] || null; // Linux procfs field 22: starttime.
  } catch {
    return null;
  }
}

async function darwinStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Return a same-host pid identity. `alive: true, startTime: null` means the
 * process exists but its stable identity is unverifiable and must be protected.
 */
export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, startTime: null };
  if (!pidIsAlive(pid)) return { alive: false, startTime: null };

  let startTime: string | null = null;
  if (process.platform === "linux") startTime = await linuxStartTime(pid);
  else if (process.platform === "darwin") startTime = await darwinStartTime(pid);

  // Re-probe after reading the identity. Disappearance is verified death; an
  // unreadable start time for a still-live process remains fail-closed.
  if (!pidIsAlive(pid)) return { alive: false, startTime: null };
  return { alive: true, startTime };
}

export class LockTimeoutError extends Error {
  constructor(resourceId: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for guard lock ${JSON.stringify(resourceId)}`);
    this.name = "LockTimeoutError";
  }
}

export class LockFenceError extends Error {
  constructor(resourceId: string) {
    super(`guard lock for ${JSON.stringify(resourceId)} is no longer held by this token`);
    this.name = "LockFenceError";
  }
}

export class ProcessIdentityUnverifiableError extends Error {
  constructor(pid: number) {
    super(`cannot acquire guard lock: process identity for pid ${pid} is unverifiable`);
    this.name = "ProcessIdentityUnverifiableError";
  }
}

function parseOwner(value: unknown): LockOwner | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || !SAFE_TOKEN.test(record.token)) return null;
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) return null;
  if (typeof record.procStartTime !== "string" || record.procStartTime.length === 0) return null;
  if (record.since !== undefined && typeof record.since !== "string") return null;
  return {
    token: record.token,
    pid: Number(record.pid),
    procStartTime: record.procStartTime,
    ...(typeof record.since === "string" ? { since: record.since } : {}),
  };
}

async function readOwner(path: string): Promise<LockRead> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }

  let owner: LockOwner | null = null;
  try {
    owner = parseOwner(JSON.parse(body));
  } catch {
    // Atomic publication below makes a malformed canonical file impossible for
    // this implementation. Fail loudly on legacy/external corruption instead
    // of classifying it as permanent contention and wedging every claimant.
  }
  if (owner === null) throw new Error(`invalid guard lock file at ${path}`);
  return { kind: "owner", owner };
}

async function createExclusive(path: string, owner: LockOwner): Promise<boolean> {
  const temporaryPath = `${path}.tmp.${randomUUID()}`;
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    // The hard link publishes an already-complete inode and retains O_EXCL's
    // EEXIST arbitration. A crash can leave only an ignored unique temp name.
    try {
      await link(temporaryPath, path);
      return true;
    } catch (error) {
      if (isErrno(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      // Cleanup is best-effort: after link() succeeds, failing the acquisition
      // would strand a valid canonical lock while its caller believes it lost.
      if (!isErrno(error, "ENOENT")) {
        // Unique temp files are never read as locks, so an orphan is harmless.
        void error;
      }
    }
  }
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
  return left.token === right.token
    && left.pid === right.pid
    && left.procStartTime === right.procStartTime;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ResourceLockManager {
  private readonly pid: number;
  private readonly identityProvider: ProcessIdentityProvider;
  private readonly tokenFactory: () => string;
  private readonly timeoutMs: number;
  private readonly minRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly inProcessLocks = new Map<string, Promise<void>>();

  constructor(options: ResourceLockManagerOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.identityProvider = options.processIdentity ?? processIdentity;
    this.tokenFactory = options.token ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.minRetryDelayMs = options.minRetryDelayMs ?? DEFAULT_MIN_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) throw new TypeError("timeoutMs must be non-negative");
    if (!Number.isFinite(this.minRetryDelayMs) || this.minRetryDelayMs < 0) {
      throw new TypeError("minRetryDelayMs must be non-negative");
    }
    if (!Number.isFinite(this.maxRetryDelayMs) || this.maxRetryDelayMs < this.minRetryDelayMs) {
      throw new TypeError("maxRetryDelayMs must be at least minRetryDelayMs");
    }
  }

  private newToken(): string {
    const token = this.tokenFactory();
    if (!SAFE_TOKEN.test(token)) throw new TypeError("guard lock token must contain only letters, digits, '_' or '-'");
    return token;
  }

  private async acquireInProcess(resourceId: string): Promise<() => void> {
    const previous = this.inProcessLocks.get(resourceId) ?? Promise.resolve();
    let signal!: () => void;
    const current = new Promise<void>((resolve) => { signal = resolve; });
    const tail = previous.then(() => current);
    this.inProcessLocks.set(resourceId, tail);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      signal();
      void tail.then(() => {
        if (this.inProcessLocks.get(resourceId) === tail) this.inProcessLocks.delete(resourceId);
      });
    };
  }

  private async ownerIsProtected(owner: LockOwner): Promise<boolean> {
    const identity = await this.identityProvider(owner.pid);
    if (!identity.alive) return false;
    // A live pid with unreadable start time is explicitly unverifiable.
    if (identity.startTime === null) return true;
    return identity.startTime === owner.procStartTime;
  }

  private async unlinkIfStillOwned(path: string, expected: LockOwner): Promise<boolean> {
    const reread = await readOwner(path);
    if (reread.kind !== "owner" || !sameOwner(reread.owner, expected)) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async tryRecover(
    lockPath: string,
    staleOwner: LockOwner,
    ownLock: LockOwner,
    attemptedTokens: Set<string>,
  ): Promise<boolean> {
    if (attemptedTokens.has(staleOwner.token)) return false;
    // A claimant that loses this token-keyed name never retries it during this
    // acquisition. A future acquisition is a new claimant and may recover a
    // recovery file whose creator has subsequently died.
    attemptedTokens.add(staleOwner.token);

    const recoveryPath = `${lockPath}.recovery.${staleOwner.token}`;
    const existingRecovery = await readOwner(recoveryPath);
    if (existingRecovery.kind === "owner") {
      if (await this.ownerIsProtected(existingRecovery.owner)) return false;
      // Verify the exact dead creator again immediately before removing its
      // recovery claim. A live or changed creator is never unlinked.
      if (!await this.unlinkIfStillOwned(recoveryPath, existingRecovery.owner)) return false;
    }

    const recoveryOwner: LockOwner = {
      token: this.newToken(),
      pid: this.pid,
      procStartTime: ownLock.procStartTime,
    };
    if (!await createExclusive(recoveryPath, recoveryOwner)) return false;

    try {
      const current = await readOwner(lockPath);
      if (current.kind !== "owner" || current.owner.token !== staleOwner.token) return false;
      // Holding recovery.<T> is the sole authority to unlink a main lock named T.
      if (!await this.unlinkIfStillOwned(lockPath, current.owner)) return false;
      // A contender may legitimately win the now-empty main name first. The
      // atomic link decides; this claimant never removes that replacement.
      return await createExclusive(lockPath, ownLock);
    } finally {
      await this.unlinkIfStillOwned(recoveryPath, recoveryOwner);
    }
  }

  private async acquireFileLock(resourceId: string, options: ResourceLockOptions): Promise<LockOwner> {
    const identity = await this.identityProvider(this.pid);
    if (!identity.alive || identity.startTime === null) {
      throw new ProcessIdentityUnverifiableError(this.pid);
    }

    const directory = resourceDir(resourceId);
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, ".lock.ts");
    const ownLock: LockOwner = {
      token: this.newToken(),
      pid: this.pid,
      procStartTime: identity.startTime,
      since: new Date().toISOString(),
    };
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const minDelay = options.minRetryDelayMs ?? this.minRetryDelayMs;
    const maxDelay = options.maxRetryDelayMs ?? this.maxRetryDelayMs;
    const started = performance.now();
    const attemptedTokens = new Set<string>();
    let retryDelay = minDelay;

    for (;;) {
      if (await createExclusive(lockPath, ownLock)) return ownLock;

      const observed = await readOwner(lockPath);
      if (observed.kind === "owner" && !await this.ownerIsProtected(observed.owner)) {
        if (await this.tryRecover(lockPath, observed.owner, ownLock, attemptedTokens)) return ownLock;
      }

      if (performance.now() - started >= timeoutMs) throw new LockTimeoutError(resourceId, timeoutMs);
      await delay(retryDelay);
      retryDelay = Math.min(maxDelay, Math.max(minDelay, retryDelay * 2 || 1));
    }
  }

  async assertStillHeld(resourceId: string, token: string): Promise<void> {
    const current = await readOwner(join(resourceDir(resourceId), ".lock.ts"));
    if (current.kind !== "owner" || current.owner.token !== token) throw new LockFenceError(resourceId);
  }

  /** Acquire, yield the fence token to the callback, and always release. */
  async resourceLock<T>(
    resourceId: string,
    action: (handle: ResourceLockHandle) => Promise<T> | T,
    options: ResourceLockOptions = {},
  ): Promise<T> {
    // resourceDir validates the raw id; the mutex key intentionally remains raw.
    resourceDir(resourceId);
    const releaseInProcess = await this.acquireInProcess(resourceId);
    let owner: LockOwner | undefined;
    try {
      owner = await this.acquireFileLock(resourceId, options);
      return await action({ token: owner.token });
    } finally {
      try {
        if (owner !== undefined) {
          await this.unlinkIfStillOwned(join(resourceDir(resourceId), ".lock.ts"), owner);
        }
      } finally {
        releaseInProcess();
      }
    }
  }
}

const defaultManager = new ResourceLockManager();

export function resourceLock<T>(
  resourceId: string,
  action: (handle: ResourceLockHandle) => Promise<T> | T,
  options: ResourceLockOptions = {},
): Promise<T> {
  return defaultManager.resourceLock(resourceId, action, options);
}

export function assertStillHeld(resourceId: string, token: string): Promise<void> {
  return defaultManager.assertStillHeld(resourceId, token);
}
