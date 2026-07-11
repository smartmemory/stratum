import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LockTimeoutError,
  ResourceLockManager,
  assertStillHeld,
  processIdentity,
  type ProcessIdentity,
  type ProcessIdentityProvider,
} from "../../src/guard/lock.js";
import { GUARDS_DIR, resourceDir, setGuardsDir } from "../../src/guard/store.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];

async function tempGuardsRoot(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stratum-guard-lock-"));
  roots.push(root);
  setGuardsDir(root);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function identitySeam(initial: Record<number, ProcessIdentity>): {
  identities: Map<number, ProcessIdentity>;
  calls: number[];
  provider: ProcessIdentityProvider;
} {
  const identities = new Map(Object.entries(initial).map(([pid, identity]) => [Number(pid), identity]));
  const calls: number[] = [];
  return {
    identities,
    calls,
    provider: async (pid) => {
      calls.push(pid);
      return identities.get(pid) ?? { alive: false, startTime: null };
    },
  };
}

function barrierIdentityChecks(
  provider: ProcessIdentityProvider,
  pid: number,
  participants = 2,
): { provider: ProcessIdentityProvider; arrivals: () => number } {
  const release = deferred();
  let arrivals = 0;
  return {
    arrivals: () => arrivals,
    provider: async (queriedPid) => {
      const identity = await provider(queriedPid);
      if (queriedPid === pid && arrivals < participants) {
        arrivals += 1;
        if (arrivals === participants) release.resolve();
        await release.promise;
      }
      return identity;
    },
  };
}

function firstRejection(promises: Promise<unknown>[]): Promise<unknown> {
  return Promise.race(promises.map((promise) => new Promise((resolve) => {
    void promise.catch(resolve);
  })));
}

function manager(
  pid: number,
  provider: ProcessIdentityProvider,
  tokens: string[],
  timeoutMs = 40,
): ResourceLockManager {
  let nextToken = 0;
  return new ResourceLockManager({
    pid,
    processIdentity: provider,
    token: () => tokens[nextToken++] ?? `00000000-0000-4000-8000-${String(pid).padStart(12, "0")}`,
    timeoutMs,
    minRetryDelayMs: 1,
    maxRetryDelayMs: 2,
  });
}

async function writeLock(resourceId: string, body: Record<string, unknown>): Promise<string> {
  const path = join(resourceDir(resourceId), ".lock.ts");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body), "utf8");
  return path;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

describe("guard resource lock", () => {
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "returns stable identity when readable, fail-closed identity when denied, and death for an absent pid",
    async () => {
      const first = await processIdentity(process.pid);
      const second = await processIdentity(process.pid);
      expect(first.alive).toBe(true);
      expect(second).toEqual(first);
      expect(await processIdentity(2 ** 30)).toEqual({ alive: false, startTime: null });
    },
  );

  it("acquires and releases an uncontended atomically-published sidecar", async () => {
    await tempGuardsRoot();
    const seam = identitySeam({ 101: { alive: true, startTime: "start-101" } });
    const locks = manager(101, seam.provider, ["11111111-1111-4111-8111-111111111111"]);
    const path = join(resourceDir("basic"), ".lock.ts");

    await locks.resourceLock("basic", async ({ token }) => {
      expect(token).toBe("11111111-1111-4111-8111-111111111111");
      expect(await readJson(path)).toMatchObject({ token, pid: 101, procStartTime: "start-101" });
      await locks.assertStillHeld("basic", token);
    });

    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes two coroutines by raw resource_id inside one process", async () => {
    await tempGuardsRoot();
    const seam = identitySeam({ 102: { alive: true, startTime: "start-102" } });
    const locks = manager(102, seam.provider, [
      "22222222-2222-4222-8222-222222222221",
      "22222222-2222-4222-8222-222222222222",
    ]);
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = locks.resourceLock("same-raw-id", async () => {
      order.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push("first-exit");
    });
    await firstEntered.promise;
    const second = locks.resourceLock("same-raw-id", async () => { order.push("second-enter"); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first-enter"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("lets exactly one of two claimants replace a dead holder and never lets the loser unlink it", async () => {
    await tempGuardsRoot();
    const resourceId = "dead-holder-race";
    const staleToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = await writeLock(resourceId, {
      token: staleToken, pid: 200, procStartTime: "dead-200", since: "2026-07-11T00:00:00.000Z",
    });
    const seam = identitySeam({
      200: { alive: false, startTime: null },
      201: { alive: true, startTime: "start-201" },
      202: { alive: true, startTime: "start-202" },
    });
    const barrier = barrierIdentityChecks(seam.provider, 200);
    const first = manager(201, barrier.provider, [
      "20100000-0000-4000-8000-000000000001", "20100000-0000-4000-8000-000000000002",
    ]);
    const second = manager(202, barrier.provider, [
      "20200000-0000-4000-8000-000000000001", "20200000-0000-4000-8000-000000000002",
    ]);
    const releaseWinner = deferred();
    const winnerEntered = deferred();
    const winners: string[] = [];

    const attempts = [first, second].map((locks) => locks.resourceLock(resourceId, async ({ token }) => {
      winners.push(token);
      winnerEntered.resolve();
      await releaseWinner.promise;
    }));
    const loserRejected = firstRejection(attempts);
    const outcomesPromise = Promise.allSettled(attempts);
    await winnerEntered.promise;
    const liveReplacement = await readJson(path);
    const loserError = await loserRejected;
    expect(loserError).toBeInstanceOf(LockTimeoutError);
    expect(barrier.arrivals()).toBe(2);
    expect(liveReplacement).toMatchObject({ token: winners[0] });
    expect(await readJson(path)).toEqual(liveReplacement);
    await first.assertStillHeld(resourceId, winners[0]!);
    expect(winners).toHaveLength(1);

    releaseWinner.resolve();
    const outcomes = await outcomesPromise;
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")[0]).toMatchObject({
      reason: expect.any(LockTimeoutError),
    });
  });

  it.each([
    ["verified alive", { alive: true, startTime: "holder-start" }],
    ["unverifiable alive", { alive: true, startTime: null }],
  ] as const)("never takes over a %s holder", async (_label, holderIdentity) => {
    await tempGuardsRoot();
    const resourceId = `paused-${_label}`;
    const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const path = await writeLock(resourceId, {
      token, pid: 300, procStartTime: "holder-start", since: "2026-07-11T00:00:00.000Z",
    });
    const seam = identitySeam({
      300: holderIdentity,
      301: { alive: true, startTime: "start-301" },
    });
    const claimant = manager(301, seam.provider, ["30100000-0000-4000-8000-000000000001"], 15);

    await expect(claimant.resourceLock(resourceId, async () => undefined)).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await readJson(path)).toMatchObject({ token, pid: 300 });
  });

  it("treats a live pid with a different start time as recycled and stale", async () => {
    await tempGuardsRoot();
    const resourceId = "recycled-pid";
    const oldToken = "abababab-abab-4bab-8bab-abababababab";
    await writeLock(resourceId, {
      token: oldToken, pid: 305, procStartTime: "old-process", since: "2026-07-11T00:00:00.000Z",
    });
    const seam = identitySeam({
      305: { alive: true, startTime: "recycled-process" },
      306: { alive: true, startTime: "start-306" },
    });
    const claimant = manager(306, seam.provider, [
      "30600000-0000-4000-8000-000000000001", "30600000-0000-4000-8000-000000000002",
    ]);

    await claimant.resourceLock(resourceId, async ({ token }) => {
      expect(token).not.toBe(oldToken);
      expect(await readJson(join(resourceDir(resourceId), ".lock.ts"))).toMatchObject({ token, pid: 306 });
    });
  });

  it("aborts a resumed holder at the own-token fence and release preserves the replacement", async () => {
    await tempGuardsRoot();
    const resourceId = "fenced-holder";
    const seam = identitySeam({ 310: { alive: true, startTime: "start-310" } });
    const holder = manager(310, seam.provider, ["31000000-0000-4000-8000-000000000001"]);
    const path = join(resourceDir(resourceId), ".lock.ts");
    const replacement = {
      token: "99999999-9999-4999-8999-999999999999",
      pid: 999,
      procStartTime: "replacement",
      since: "2026-07-11T00:00:00.000Z",
    };

    await holder.resourceLock(resourceId, async ({ token }) => {
      await unlink(path);
      await writeFile(path, JSON.stringify(replacement), "utf8");
      await expect(holder.assertStillHeld(resourceId, token)).rejects.toThrow(/no longer held/);
      await expect(assertStillHeld(resourceId, token)).rejects.toThrow(/no longer held/);
    });

    expect(await readJson(path)).toEqual(replacement);
  });

  it("recovers a crashed recovery claimant only after verifying its pid identity is dead", async () => {
    await tempGuardsRoot();
    const resourceId = "crashed-recovery";
    const staleToken = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await writeLock(resourceId, {
      token: staleToken, pid: 400, procStartTime: "dead-400", since: "2026-07-11T00:00:00.000Z",
    });
    const recoveryPath = join(resourceDir(resourceId), `.lock.ts.recovery.${staleToken}`);
    await writeFile(recoveryPath, JSON.stringify({
      token: "40000000-0000-4000-8000-000000000099", pid: 401, procStartTime: "recovery-401",
    }), "utf8");
    const seam = identitySeam({
      400: { alive: false, startTime: null },
      401: { alive: true, startTime: "recovery-401" },
      402: { alive: true, startTime: "start-402" },
    });
    const claimant = manager(402, seam.provider, [
      "40200000-0000-4000-8000-000000000001", "40200000-0000-4000-8000-000000000002",
    ], 15);

    await expect(claimant.resourceLock(resourceId, async () => undefined)).rejects.toBeInstanceOf(LockTimeoutError);
    expect(await readJson(recoveryPath)).toMatchObject({ pid: 401 });

    seam.identities.set(401, { alive: false, startTime: null });
    const recovered = manager(402, seam.provider, [
      "40200000-0000-4000-8000-000000000011", "40200000-0000-4000-8000-000000000012",
    ]);
    await recovered.resourceLock(resourceId, async ({ token }) => {
      expect((await readJson(join(resourceDir(resourceId), ".lock.ts"))).token).toBe(token);
    });
    expect(seam.calls).toContain(401);
    await expect(readFile(recoveryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically serializes two reclaimers that both observed the same dead recovery owner", async () => {
    await tempGuardsRoot();
    const resourceId = "dead-recovery-race";
    const staleToken = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const path = await writeLock(resourceId, {
      token: staleToken, pid: 500, procStartTime: "dead-500", since: "2026-07-11T00:00:00.000Z",
    });
    const recoveryPath = join(resourceDir(resourceId), `.lock.ts.recovery.${staleToken}`);
    await writeFile(recoveryPath, JSON.stringify({
      token: "50000000-0000-4000-8000-000000000099", pid: 501, procStartTime: "dead-501",
    }), "utf8");
    const seam = identitySeam({
      500: { alive: false, startTime: null },
      501: { alive: false, startTime: null },
      502: { alive: true, startTime: "start-502" },
      503: { alive: true, startTime: "start-503" },
    });
    const barrier = barrierIdentityChecks(seam.provider, 501);
    const claimants = [
      manager(502, barrier.provider, ["50200000-0000-4000-8000-000000000001", "50200000-0000-4000-8000-000000000002"]),
      manager(503, barrier.provider, ["50300000-0000-4000-8000-000000000001", "50300000-0000-4000-8000-000000000002"]),
    ];
    const releaseWinner = deferred();
    const winnerEntered = deferred();
    const winners: string[] = [];
    const attempts = claimants.map((locks) => locks.resourceLock(resourceId, async ({ token }) => {
      winners.push(token);
      winnerEntered.resolve();
      await releaseWinner.promise;
    }));
    const loserRejected = firstRejection(attempts);
    const outcomesPromise = Promise.allSettled(attempts);

    await winnerEntered.promise;
    const replacement = await readJson(path);
    const loserError = await loserRejected;
    expect(loserError).toBeInstanceOf(LockTimeoutError);
    expect(barrier.arrivals()).toBe(2);
    expect(winners).toHaveLength(1);
    expect(replacement).toMatchObject({ token: winners[0] });
    expect(await readJson(path)).toEqual(replacement);
    await claimants[0]!.assertStillHeld(resourceId, winners[0]!);
    releaseWinner.resolve();
    const outcomes = await outcomesPromise;
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });
});
