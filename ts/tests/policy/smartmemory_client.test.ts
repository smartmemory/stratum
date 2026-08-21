import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_MAX_BYTES, OUTBOX_MAX_FILES, SmartMemoryClient } from "../../src/policy/smartmemory_client.js";
import type { EnforcementEvent } from "../../src/policy/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const event = (id: string): EnforcementEvent => ({
  event_id: id,
  kind: "flow_terminal",
  run_id: "run-1",
  bundle_id: "a".repeat(64),
  runner: "local",
  occurred_at: "2026-08-21T00:00:00.000Z",
  outcome: "completed",
  resolved_by: "agent",
  rules_evaluated: [],
});

async function outbox(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-policy-client-"));
  roots.push(root);
  return root;
}

function eventFilename(id: string): string {
  return `${createHash("sha256").update(id, "utf8").digest("hex")}.json`;
}

const env = {
  SMARTMEMORY_API_URL: "https://memory.example/",
  SMARTMEMORY_API_KEY: "secret",
  SMARTMEMORY_WORKSPACE_ID: "workspace-1",
};

type DrainLockInternals = {
  acquireDrainLock(): Promise<unknown | undefined>;
  assertDrainLockOwned(lock: unknown): Promise<void>;
  heartbeatDrainLock(lock: unknown): Promise<void>;
  releaseDrainLock(lock: unknown): Promise<boolean>;
  renameDrainLock(source: string, destination: string): Promise<void>;
};

describe("SmartMemoryClient", () => {
  it("posts a 2xx request with the contract headers", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const client = new SmartMemoryClient({ env, outboxDir: await outbox(), fetchImpl });
    await client.postEvent(event("run-1:flow"));
    expect(fetchImpl).toHaveBeenCalledWith("https://memory.example/memory/policy/events", expect.objectContaining({
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        "X-Workspace-Id": "workspace-1",
        "Content-Type": "application/json",
      },
    }));
  });

  it("writes a non-2xx event to the outbox", async () => {
    const directory = await outbox();
    const client = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: false, status: 503 }), warn: vi.fn() });
    await client.postEvent(event("run-1:flow"));
    expect(JSON.parse(await readFile(join(directory, eventFilename("run-1:flow")), "utf8"))).toEqual(event("run-1:flow"));
  });

  it("hashes traversal-shaped event ids and rejects empty or NUL ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-policy-traversal-"));
    roots.push(root);
    const directory = join(root, "a", "b", "c", "d", "outbox");
    await mkdir(join(root, "a", "tmp"), { recursive: true });
    const id = "../../../../tmp/owned";
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const client = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl, warn: vi.fn(), random: () => 0 });
    await client.postEvent(event(id));
    await expect(readFile(resolve(directory, `${id}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(directory, eventFilename(id)), "utf8"))).toEqual(event(id));
    await expect(client.postEvent(event(""))).rejects.toThrow(/event_id.*non-empty/);
    await expect(client.postEvent(event("bad\0id"))).rejects.toThrow(/event_id.*NUL/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs disabled delivery once and never calls fetch", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));
    const warn = vi.fn();
    const client = new SmartMemoryClient({ env: { SMARTMEMORY_API_URL: "", SMARTMEMORY_API_KEY: "" }, outboxDir: await outbox(), fetchImpl, warn });
    await expect(client.postEvent(event("one"))).resolves.toBeUndefined();
    await expect(client.postEvent(event("two"))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("policy events not delivered: SMARTMEMORY_API_URL/KEY unset");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("drains queued events oldest-first after the next successful post", async () => {
    const directory = await outbox();
    let clock = 10_000;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const client = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl, warn: vi.fn(), now: () => clock, random: () => 0 });
    await client.postEvent(event("run-1:first"));
    clock += 1_000;
    await client.postEvent(event("run-1:second"));
    expect(await readdir(directory)).toEqual([]);
    const delivered = fetchImpl.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).event_id);
    expect(delivered).toEqual(["run-1:first", "run-1:second", "run-1:first"]);
  });

  it("caps the outbox by file count and byte size, dropping oldest with a named warning", async () => {
    expect(OUTBOX_MAX_FILES).toBe(1_000);
    expect(OUTBOX_MAX_BYTES).toBe(50 * 1024 * 1024);
    const countDirectory = await outbox();
    const countWarn = vi.fn();
    const countClient = new SmartMemoryClient({
      env, outboxDir: countDirectory, fetchImpl: async () => ({ ok: false, status: 503 }), warn: countWarn,
      maxOutboxFiles: 2, maxOutboxBytes: 10_000, random: () => 0,
    });
    await countClient.postEvent(event("oldest"));
    await utimes(join(countDirectory, eventFilename("oldest")), new Date(1_000), new Date(1_000));
    await countClient.postEvent(event("middle"));
    await utimes(join(countDirectory, eventFilename("middle")), new Date(2_000), new Date(2_000));
    await countClient.postEvent(event("newest"));
    expect((await readdir(countDirectory)).filter((name) => name.endsWith(".json")).sort()).toEqual([
      eventFilename("middle"), eventFilename("newest"),
    ].sort());
    expect(countWarn).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*oldest/));

    const byteDirectory = await outbox();
    const byteClient = new SmartMemoryClient({
      env, outboxDir: byteDirectory, fetchImpl: async () => ({ ok: false, status: 503 }), warn: vi.fn(),
      maxOutboxFiles: 10, maxOutboxBytes: 1, random: () => 0,
    });
    await byteClient.postEvent(event("too-large"));
    expect((await readdir(byteDirectory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("serializes concurrent drains so each queued file is posted once", async () => {
    const directory = await outbox();
    const seed = new SmartMemoryClient({
      env, outboxDir: directory, fetchImpl: async () => ({ ok: false, status: 503 }), warn: vi.fn(), random: () => 0,
    });
    await seed.postEvent(event("queued-one"));
    await seed.postEvent(event("queued-two"));

    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 201 }));
    const client = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl, warn: vi.fn() });
    await Promise.all([client.postEvent(event("live-one")), client.postEvent(event("live-two"))]);
    const ids = fetchImpl.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).event_id as string);
    expect(ids.filter((id) => id === "queued-one")).toHaveLength(1);
    expect(ids.filter((id) => id === "queued-two")).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("backs off repeated direct delivery failures", async () => {
    const directory = await outbox();
    let clock = 10_000;
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const client = new SmartMemoryClient({
      env, outboxDir: directory, fetchImpl, warn: vi.fn(), now: () => clock, random: () => 0,
    });
    await client.postEvent(event("first"));
    await client.postEvent(event("during-backoff"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await client.postEvent(event("after-backoff"));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts stale takeover when the owner heartbeats after observation and restores its lock", async () => {
    const directory = await outbox();
    const lockPath = join(directory, ".drain.lock");
    const owner = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: true, status: 201 }), now: () => 100_000 });
    const ownerInternals = owner as unknown as DrainLockInternals;
    const ownerLock = await ownerInternals.acquireDrainLock();
    expect(ownerLock).toBeDefined();
    await utimes(lockPath, new Date(0), new Date(0));

    const contender = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: true, status: 201 }), now: () => 100_000 });
    const contenderInternals = contender as unknown as DrainLockInternals;
    const renameLock = contenderInternals.renameDrainLock.bind(contender);
    contenderInternals.renameDrainLock = async (source, destination) => {
      if (destination.includes(".stale.")) await ownerInternals.heartbeatDrainLock(ownerLock);
      await renameLock(source, destination);
    };

    await expect(contenderInternals.acquireDrainLock()).resolves.toBeUndefined();
    await expect(ownerInternals.assertDrainLockOwned(ownerLock)).resolves.toBeUndefined();
    expect(await readFile(lockPath, "utf8")).not.toEqual("");
    await expect(ownerInternals.releaseDrainLock(ownerLock)).resolves.toBe(true);
  });

  it("takes over a genuine stale lock and fences the old owner on its next lease check", async () => {
    const directory = await outbox();
    const lockPath = join(directory, ".drain.lock");
    const owner = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: true, status: 201 }) });
    const ownerInternals = owner as unknown as DrainLockInternals;
    const ownerLock = await ownerInternals.acquireDrainLock();
    expect(ownerLock).toBeDefined();
    await utimes(lockPath, new Date(0), new Date(0));
    const contender = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: true, status: 201 }), now: () => 100_000 });
    const contenderInternals = contender as unknown as DrainLockInternals;
    const contenderLock = await contenderInternals.acquireDrainLock();
    expect(contenderLock).toBeDefined();
    await expect(ownerInternals.assertDrainLockOwned(ownerLock)).rejects.toThrow(/lease .* lost/);
    await expect(contenderInternals.releaseDrainLock(contenderLock)).resolves.toBe(true);
    await ownerInternals.releaseDrainLock(ownerLock);
  });

  it("does not release a replacement lock after its owner loses the lease", async () => {
    const directory = await outbox();
    const lockPath = join(directory, ".drain.lock");
    const owner = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: async () => ({ ok: true, status: 201 }) });
    const ownerInternals = owner as unknown as DrainLockInternals;
    const ownerLock = await ownerInternals.acquireDrainLock();
    expect(ownerLock).toBeDefined();
    await rename(lockPath, join(directory, ".drain.lock.displaced"));
    await writeFile(lockPath, "replacement-token", { mode: 0o600 });

    await expect(ownerInternals.releaseDrainLock(ownerLock)).resolves.toBe(false);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("replacement-token");
  });

  it("stops after mid-drain lease loss and lets a successor drain each persisted file once", async () => {
    const directory = await outbox();
    const queuedOne = event("queued-before-fencing-one");
    const queuedTwo = event("queued-before-fencing-two");
    await writeFile(join(directory, eventFilename(queuedOne.event_id)), JSON.stringify(queuedOne), { mode: 0o600 });
    await writeFile(join(directory, eventFilename(queuedTwo.event_id)), JSON.stringify(queuedTwo), { mode: 0o600 });
    await utimes(join(directory, eventFilename(queuedOne.event_id)), new Date(1_000), new Date(1_000));
    await utimes(join(directory, eventFilename(queuedTwo.event_id)), new Date(2_000), new Date(2_000));

    const ownerFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 201 }));
    const ownerWarn = vi.fn();
    const owner = new SmartMemoryClient({ env, outboxDir: directory, fetchImpl: ownerFetch, warn: ownerWarn });
    const ownerInternals = owner as unknown as DrainLockInternals;
    const assertOwned = ownerInternals.assertDrainLockOwned.bind(owner);
    let ownershipChecks = 0;
    ownerInternals.assertDrainLockOwned = async (lock) => {
      ownershipChecks += 1;
      if (ownershipChecks === 4) {
        await rename(join(directory, ".drain.lock"), join(directory, ".drain.lock.displaced"));
        await writeFile(join(directory, ".drain.lock"), "successor-token", "utf8");
      }
      await assertOwned(lock);
    };

    await owner.postEvent(event("live-owner"));
    expect(ownerWarn).toHaveBeenCalledWith(expect.stringMatching(/^WARNING: policy outbox drain lease lost/));
    expect(ownerFetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).event_id))
      .toEqual(["live-owner", "queued-before-fencing-one"]);

    await utimes(join(directory, ".drain.lock"), new Date(0), new Date(0));
    const successorFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 201 }));
    const successor = new SmartMemoryClient({
      env, outboxDir: directory, fetchImpl: successorFetch, warn: vi.fn(), now: () => 100_000,
    });
    await successor.postEvent(event("live-successor"));
    const allIds = [...ownerFetch.mock.calls, ...successorFetch.mock.calls]
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)).event_id as string);
    expect(allIds.filter((id) => id === queuedOne.event_id)).toHaveLength(1);
    expect(allIds.filter((id) => id === queuedTwo.event_id)).toHaveLength(1);
    expect((await readdir(directory)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("repairs outbox permissions and writes private event files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-policy-permissions-"));
    roots.push(root);
    const directory = join(root, "outbox");
    await mkdir(directory);
    await chmod(directory, 0o777);
    const client = new SmartMemoryClient({
      env, outboxDir: directory, fetchImpl: async () => ({ ok: false, status: 503 }), warn: vi.fn(), random: () => 0,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await client.postEvent(event("private"));
    expect((await stat(join(directory, eventFilename("private")))).mode & 0o777).toBe(0o600);
  });
});
