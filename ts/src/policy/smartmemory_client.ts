import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import type { EnforcementEvent } from "./types.js";

const DELIVERY_WARNING = "policy events not delivered: SMARTMEMORY_API_URL/KEY unset";
const DRAIN_LIMIT = 100;
export const OUTBOX_MAX_FILES = 1_000;
export const OUTBOX_MAX_BYTES = 50 * 1024 * 1024;
const DRAIN_LOCK_STALE_MS = 60_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
let disabledWarningLogged = false;
let defaultClient: SmartMemoryClient | undefined;

type FetchResponse = Pick<Response, "ok" | "status">;
type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<FetchResponse>;
type DrainLock = { handle: FileHandle; path: string; token: string };
type OutboxFile = { name: string; path: string; modified: number; size: number };

class DrainLeaseLost extends Error {}

export interface SmartMemoryClientOptions {
  env?: NodeJS.ProcessEnv;
  outboxDir?: string;
  fetchImpl?: FetchImplementation;
  warn?: (message: string) => void;
  /** Test seams; production always uses the exported 1000-file / 50-MB caps. */
  maxOutboxFiles?: number;
  maxOutboxBytes?: number;
  now?: () => number;
  random?: () => number;
}

export class SmartMemoryClient {
  private readonly url: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly workspaceId: string;
  private readonly outboxDir: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly warn: (message: string) => void;
  private readonly maxOutboxFiles: number;
  private readonly maxOutboxBytes: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private drainTail: Promise<void> = Promise.resolve();
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  constructor(options: SmartMemoryClientOptions = {}) {
    const env = options.env ?? process.env;
    const url = env.SMARTMEMORY_API_URL?.replace(/\/+$/, "");
    this.url = url ? url : undefined;
    this.apiKey = env.SMARTMEMORY_API_KEY || undefined;
    this.workspaceId = env.SMARTMEMORY_WORKSPACE_ID ?? "";
    this.outboxDir = resolve(options.outboxDir ?? resolve(homedir(), ".stratum", "policy-outbox"));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.warn = options.warn ?? ((warning) => console.warn(warning));
    this.maxOutboxFiles = options.maxOutboxFiles ?? OUTBOX_MAX_FILES;
    this.maxOutboxBytes = options.maxOutboxBytes ?? OUTBOX_MAX_BYTES;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.repairOutboxPermissions();
  }

  async postEvent(event: EnforcementEvent): Promise<void> {
    validateEventId(event.event_id);
    if (this.url === undefined || this.apiKey === undefined) {
      if (!disabledWarningLogged) {
        disabledWarningLogged = true;
        this.warn(DELIVERY_WARNING);
      }
      return;
    }

    if (this.now() < this.nextAttemptAt) {
      await this.writeOutbox(event);
      this.warn(`policy event ${event.event_id} queued during delivery backoff`);
      return;
    }

    let response: FetchResponse | undefined;
    let failure: unknown;
    try {
      response = await this.request(event);
    } catch (error) {
      failure = error;
    }
    if (response?.ok) {
      this.resetBackoff();
      await this.drainOutbox();
      return;
    }

    this.recordFailure();
    await this.writeOutbox(event);
    const detail = response === undefined ? message(failure) : `HTTP ${response.status}`;
    this.warn(`policy event ${event.event_id} queued after delivery failure: ${detail}`);
  }

  private repairOutboxPermissions(): void {
    try {
      mkdirSync(this.outboxDir, { recursive: true, mode: 0o700 });
      chmodSync(this.outboxDir, 0o700);
    } catch (error) {
      this.warn(`policy outbox permissions could not be repaired: ${message(error)}`);
    }
  }

  private async ensureOutboxDir(): Promise<void> {
    await mkdir(this.outboxDir, { recursive: true, mode: 0o700 });
    await chmod(this.outboxDir, 0o700);
  }

  private outboxPath(name: string): string {
    const path = resolve(this.outboxDir, name);
    if (!path.startsWith(`${this.outboxDir}${sep}`)) {
      throw new Error(`policy outbox path escapes configured directory: ${JSON.stringify(name)}`);
    }
    return path;
  }

  private eventPath(eventId: string): string {
    validateEventId(eventId);
    const filename = `${createHash("sha256").update(eventId, "utf8").digest("hex")}.json`;
    return this.outboxPath(filename);
  }

  private async request(event: EnforcementEvent): Promise<FetchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      return await this.fetchImpl(`${this.url!}/memory/policy/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey!}`,
          "X-Workspace-Id": this.workspaceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    const exponent = Math.min(this.consecutiveFailures - 1, 20);
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** exponent));
    const jittered = Math.min(MAX_BACKOFF_MS, base + (base * 0.2 * this.random()));
    this.nextAttemptAt = this.now() + jittered;
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  private async writeOutbox(event: EnforcementEvent): Promise<void> {
    try {
      await this.ensureOutboxDir();
      const path = this.eventPath(event.event_id);
      await writeFile(path, JSON.stringify(event), { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
      await this.enforceOutboxCap();
    } catch (error) {
      this.warn(`policy event ${event.event_id} could not be written to outbox: ${message(error)}`);
    }
  }

  private async outboxFiles(): Promise<OutboxFile[]> {
    const names = (await readdir(this.outboxDir)).filter((name) => name.endsWith(".json"));
    const files = await Promise.all(names.map(async (name): Promise<OutboxFile | undefined> => {
      const path = this.outboxPath(name);
      try {
        const details = await stat(path);
        if (!details.isFile()) return undefined;
        return { name, path, modified: details.mtimeMs, size: details.size };
      } catch {
        return undefined;
      }
    }));
    return files.filter((file): file is OutboxFile => file !== undefined)
      .sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name));
  }

  private async enforceOutboxCap(): Promise<void> {
    const files = await this.outboxFiles();
    let bytes = files.reduce((total, file) => total + file.size, 0);
    while (files.length > this.maxOutboxFiles || bytes > this.maxOutboxBytes) {
      const dropped = files.shift();
      if (dropped === undefined) return;
      let eventId = dropped.name;
      try {
        const event = JSON.parse(await readFile(dropped.path, "utf8")) as { event_id?: unknown };
        if (typeof event.event_id === "string") eventId = event.event_id;
      } catch { /* Name the hashed file when a malformed entry cannot name itself. */ }
      await rm(this.outboxPath(dropped.name), { force: true });
      bytes -= dropped.size;
      this.warn(`WARNING: policy outbox cap dropped ${JSON.stringify(eventId)} (${dropped.name})`);
    }
  }

  private drainOutbox(): Promise<void> {
    const current = this.drainTail.then(() => this.drainOutboxSingleFlight());
    this.drainTail = current.catch(() => undefined);
    return current;
  }

  private async acquireDrainLock(): Promise<DrainLock | undefined> {
    await this.ensureOutboxDir();
    const path = this.outboxPath(".drain.lock");
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(token, "utf8");
        return { handle, path, token };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        try {
          const observedToken = await readFile(path, "utf8");
          const details = await stat(path);
          if (this.now() - details.mtimeMs <= DRAIN_LOCK_STALE_MS) return undefined;
          const stalePath = this.outboxPath(`.drain.lock.stale.${token}`);
          await this.renameDrainLock(path, stalePath);
          const movedToken = await readFile(stalePath, "utf8");
          const movedDetails = await stat(stalePath);
          if (movedToken !== observedToken || this.now() - movedDetails.mtimeMs <= DRAIN_LOCK_STALE_MS) {
            await this.renameDrainLock(stalePath, path);
            return undefined;
          }
          await rm(stalePath, { force: true });
        } catch (lockError) {
          if (!hasCode(lockError, "ENOENT")) throw lockError;
        }
      }
    }
    return undefined;
  }

  private async renameDrainLock(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }

  private async assertDrainLockOwned(lock: DrainLock): Promise<void> {
    try {
      const [held, current, token] = await Promise.all([
        lock.handle.stat(),
        stat(lock.path),
        readFile(lock.path, "utf8"),
      ]);
      if (held.dev !== current.dev || held.ino !== current.ino || token !== lock.token) throw new DrainLeaseLost();
    } catch (error) {
      if (error instanceof DrainLeaseLost || hasCode(error, "ENOENT")) {
        throw new DrainLeaseLost(`policy outbox drain lease ${lock.token} was lost`);
      }
      throw error;
    }
  }

  private async heartbeatDrainLock(lock: DrainLock): Promise<void> {
    await this.assertDrainLockOwned(lock);
    const timestamp = new Date(this.now());
    await lock.handle.utimes(timestamp, timestamp);
    await this.assertDrainLockOwned(lock);
  }

  private async releaseDrainLock(lock: DrainLock): Promise<boolean> {
    try {
      await this.assertDrainLockOwned(lock);
      const releasedPath = this.outboxPath(`.drain.lock.released.${lock.token}`);
      await this.renameDrainLock(lock.path, releasedPath);
      const [held, released] = await Promise.all([lock.handle.stat(), stat(releasedPath)]);
      if (held.dev !== released.dev || held.ino !== released.ino) throw new DrainLeaseLost();
      await rm(releasedPath, { force: true });
      return true;
    } catch (error) {
      if (!(error instanceof DrainLeaseLost)) this.warn(`policy outbox lock could not be released: ${message(error)}`);
      return false;
    } finally {
      await lock.handle.close().catch(() => undefined);
    }
  }

  private async drainOutboxSingleFlight(): Promise<void> {
    let lock: DrainLock | undefined;
    let leaseLost = false;
    try {
      lock = await this.acquireDrainLock();
      if (lock === undefined) return;
      const files = await this.outboxFiles();
      for (const file of files.slice(0, DRAIN_LIMIT)) {
        try {
          const event = JSON.parse(await readFile(file.path, "utf8")) as EnforcementEvent;
          validateEventId(event.event_id);
          await this.heartbeatDrainLock(lock);
          const response = await this.request(event);
          if (!response.ok) {
            this.recordFailure();
            this.warn(`policy outbox drain stopped at ${event.event_id}: HTTP ${response.status}`);
            return;
          }
          this.resetBackoff();
          await this.assertDrainLockOwned(lock);
          await rm(this.outboxPath(file.name), { force: true });
        } catch (error) {
          if (error instanceof DrainLeaseLost) {
            leaseLost = true;
            this.warn(`WARNING: policy outbox drain lease lost; leaving ${file.name} and remaining files for the new owner`);
            return;
          }
          this.recordFailure();
          this.warn(`policy outbox drain stopped at ${file.name}: ${message(error)}`);
          return;
        }
      }
    } catch (error) {
      this.warn(`policy outbox could not be drained: ${message(error)}`);
    } finally {
      if (lock !== undefined) {
        const released = await this.releaseDrainLock(lock);
        if (!released && !leaseLost) {
          this.warn("WARNING: policy outbox drain lease lost before release; remaining files belong to the new owner");
        }
      }
    }
  }
}

export function emitPolicyEvent(event: EnforcementEvent): Promise<void> {
  defaultClient ??= new SmartMemoryClient();
  return defaultClient.postEvent(event);
}

function validateEventId(eventId: unknown): asserts eventId is string {
  if (typeof eventId !== "string" || eventId.length === 0) throw new TypeError("event_id must be a non-empty string");
  if (eventId.includes("\0")) throw new TypeError("event_id must not contain NUL");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
