import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRunLock,
  readRunLock,
  type LockRecord,
  type ProcessIdentityOracle,
  type RunLockOptions,
} from "../../src/engine/run_lock.js";
import { processIdentity, procStartTime } from "../../src/connectors/proc_identity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function root(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "stratum-runlock-"));
  roots.push(created);
  return created;
}

const RUN = "run-fixture";
const lockFile = (dir: string) => join(dir, `${RUN}.lock`);
const breakFile = (dir: string) => join(dir, `${RUN}.lock-break`);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A real child process, run to completion, so its pid+startTime name a provably dead owner. */
async function deadIdentity(): Promise<{ pid: number; startTime: string }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = await procStartTime(pid);
  if (startTime === undefined) throw new Error("could not read the child's start time");
  await new Promise<void>((resolve) => { child.on("exit", () => resolve()); child.kill("SIGKILL"); });
  // The pid may linger as a zombie for an instant; wait for the identity to actually read dead.
  for (let tick = 0; tick < 200 && await processIdentity(pid, startTime) !== "dead"; tick += 1) await delay(5);
  return { pid, startTime };
}

async function writeLockRecord(dir: string, record: Partial<LockRecord> | string): Promise<void> {
  const body = typeof record === "string"
    ? record
    : JSON.stringify({ pid: process.pid, startTime: "self", token: "foreign", at: new Date().toISOString(), ...record });
  await writeFile(lockFile(dir), body, "utf8");
}

/** The REAL process identity by default: a fixture that fakes this process's own start time
 *  makes `processIdentity` read our own live lock as "dead" (a mismatched start time is a
 *  positive dead finding), and the acquire then breaks its own lock. */
function options(extra: RunLockOptions = {}): RunLockOptions {
  return { ...extra };
}

describe("STRAT-FLOW-CANCEL-FG run lock protocol", () => {
  it("T-S01-L1: serialises two concurrent acquires; the critical sections never interleave", async () => {
    const dir = await root();
    const order: string[] = [];
    const first = await acquireRunLock(dir, RUN, options());
    let secondHeld = false;
    const second = acquireRunLock(dir, RUN, options({ timeoutMs: 10_000 })).then(async (release) => {
      secondHeld = true;
      order.push("B-enter");
      order.push("B-exit");
      await release();
    });
    order.push("A-enter");
    await delay(100);
    expect(secondHeld).toBe(false);
    order.push("A-exit");
    await first();
    await second;
    expect(order).toEqual(["A-enter", "A-exit", "B-enter", "B-exit"]);
  });

  it("T-S01-L2: a crash during publication leaves NO lock, and the aged tmp is swept", async () => {
    const dir = await root();
    // A tmp written but never linked: exactly what a crash between the write and the link
    // leaves behind. There is no lock file, so the run is available.
    const orphan = `${lockFile(dir)}.abandoned-token`;
    await writeFile(orphan, JSON.stringify({ pid: 1, startTime: "x", token: "abandoned-token", at: "now" }), "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(orphan, old, old);
    const release = await acquireRunLock(dir, RUN, options());
    expect((await readdir(dir)).filter((name) => name.startsWith(`${RUN}.lock.`))).toEqual([]);
    expect((await readRunLock(dir, RUN))?.pid).toBe(process.pid);
    await release();
  });

  it("T-S01-L2b: a FRESH tmp — another process one link() away from the lock — is not swept", async () => {
    const dir = await root();
    const fresh = `${lockFile(dir)}.in-flight-token`;
    await writeFile(fresh, JSON.stringify({ pid: 1, startTime: "x", token: "in-flight-token", at: "now" }), "utf8");
    const release = await acquireRunLock(dir, RUN, options());
    await expect(stat(fresh)).resolves.toBeDefined();
    await release();
  });

  it("T-S01-L3: a stale lock owned by a dead process is broken and the acquire proceeds", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    const release = await acquireRunLock(dir, RUN, options({ timeoutMs: 5_000 }));
    expect((await readRunLock(dir, RUN))?.pid).toBe(process.pid);
    // The break-lock is always released, whatever path it took.
    await expect(stat(breakFile(dir))).rejects.toThrow();
    await release();
  });

  it("T-S01-L4: a live lock is never broken, however long it is held — identity, never age", async () => {
    const dir = await root();
    await writeLockRecord(dir, { pid: process.pid, startTime: "live-owner", token: "live" });
    const identity: ProcessIdentityOracle = async () => "alive";
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(lockFile(dir), old, old);
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 120, identity })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect((await readRunLock(dir, RUN))?.token).toBe("live");
  });

  it("T-S01-L5: a breaker never unlinks a live replacement — the inode re-check refuses", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    const inodeBefore = (await stat(lockFile(dir))).ino;
    // Between the identity verdict ("dead") and the unlink, someone else breaks the lock and
    // a NEW holder publishes theirs. The breaker must judge the file it inspected, not the
    // path — otherwise it deletes the replacement.
    let replacementInode = 0;
    const beforeBreakUnlink = async (): Promise<void> => {
      await rm(lockFile(dir), { force: true });
      await writeFile(lockFile(dir), JSON.stringify({ pid: process.pid, startTime: "replacement", token: "live-replacement", at: "now" }), "utf8");
      replacementInode = (await stat(lockFile(dir))).ino;
    };
    // The replacement is live, so this acquire cannot succeed; it must time out WITHOUT
    // having deleted the replacement.
    await expect(acquireRunLock(dir, RUN, options({
      timeoutMs: 150,
      beforeBreakUnlink,
      identity: async (pid) => pid === dead.pid ? "dead" : "alive",
    }))).rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(replacementInode).not.toBe(inodeBefore);
    const survivor = await readRunLock(dir, RUN);
    expect(survivor?.token).toBe("live-replacement");
    expect((await stat(lockFile(dir))).ino).toBe(replacementInode);
  });

  it("T-S01-L6: release with a mismatched token is a no-op, and the holder's lock survives", async () => {
    const dir = await root();
    const release = await acquireRunLock(dir, RUN, options());
    const mine = (await readRunLock(dir, RUN))!;
    // Simulate our lock having been broken and re-acquired by someone else.
    await writeLockRecord(dir, { pid: 4242, startTime: "other", token: "someone-else" });
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { warnings.push(String(chunk)); return true; });
    await release();
    spy.mockRestore();
    expect(warnings.join("")).toMatch(/no longer ours/);
    expect((await readRunLock(dir, RUN))?.token).toBe("someone-else");
    expect(mine.token).not.toBe("someone-else");
  });

  it("T-S01-L7: an unparseable lock record is treated as LIVE and never guessed away", async () => {
    const dir = await root();
    await writeLockRecord(dir, "{ this is not json");
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 120 })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(await readFile(lockFile(dir), "utf8")).toBe("{ this is not json");
    // A record with no startTime is equally opaque: an unreadable identity is "unknown".
    await writeFile(lockFile(dir), JSON.stringify({ pid: process.pid, token: "t", at: "now" }), "utf8");
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 120 })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
  });

  it("T-S01-L8: break-lock reclaim is identity-only — a live breaker is never evicted by age", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    // A LIVE breaker's .lock-break, backdated well past any plausible age rule.
    await writeFile(breakFile(dir), JSON.stringify({ pid: process.pid, startTime: "live-breaker", token: "breaker", at: "now" }), "utf8");
    const ancient = new Date(Date.now() - 60 * 60_000);
    await utimes(breakFile(dir), ancient, ancient);
    const liveBreaker: ProcessIdentityOracle = async (pid) => pid === dead.pid ? "dead" : "alive";
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 150, identity: liveBreaker })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(JSON.parse(await readFile(breakFile(dir), "utf8")).token).toBe("breaker");

    // A DEAD breaker's is removed immediately, whatever its age, and the acquire proceeds.
    const release = await acquireRunLock(dir, RUN, options({ timeoutMs: 5_000, identity: async () => "dead" }));
    await expect(stat(breakFile(dir))).rejects.toThrow();
    expect((await readRunLock(dir, RUN))?.pid).toBe(process.pid);
    await release();
  });

  it("T-S01-L9: timeoutMs expiry throws RUN_LOCK_TIMEOUT carrying the holder pid", async () => {
    const dir = await root();
    await writeLockRecord(dir, { pid: 4242, startTime: "held", token: "held" });
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 50, identity: async () => "alive" })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT", holderPid: 4242 });
  });

  it("F4: a caller-supplied non-finite timeoutMs is refused instead of retrying forever", async () => {
    const dir = await root();
    await writeLockRecord(dir, { pid: 4242, startTime: "held", token: "held" });
    // `nowMs() >= NaN` is false forever, so the acquire loop never reached its RUN_LOCK_TIMEOUT
    // and a mistyped budget became an unbounded wait on a lock somebody else holds.
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: Number.NaN, identity: async () => "alive" })))
      .rejects.toThrow(/timeoutMs must be a nonnegative finite number/);
  });

  it("T-S01-L10: an unavailable process identity refuses the acquire and creates NO lock file", async () => {
    const dir = await root();
    await expect(acquireRunLock(dir, RUN, { selfStartTime: () => Promise.resolve(undefined) }))
      .rejects.toMatchObject({ code: "RUN_LOCK_IDENTITY_UNAVAILABLE" });
    await expect(stat(lockFile(dir))).rejects.toThrow();
    expect((await readdir(dir).catch(() => []))).toEqual([]);
  });

  it("T-S01-L11: processIdentity is tri-state, and neither reclaim path acts on unknown", async () => {
    const dead = await deadIdentity();
    expect(await processIdentity(dead.pid, dead.startTime)).toBe("dead");               // ESRCH
    const live = await procStartTime(process.pid);
    expect(await processIdentity(process.pid, live!)).toBe("alive");
    expect(await processIdentity(process.pid, "not-the-real-start-time")).toBe("dead"); // mismatch
    // pid 1 is launchd/init: alive, but EPERM to a non-root probe and unreadable.
    expect(await processIdentity(1, "whatever")).toBe("unknown");

    // Neither the lock break nor the break-lock reclaim acts on "unknown".
    const dir = await root();
    await writeLockRecord(dir, { pid: 4242, startTime: "opaque", token: "opaque" });
    await writeFile(breakFile(dir), JSON.stringify({ pid: 4243, startTime: "opaque", token: "opaque-breaker", at: "now" }), "utf8");
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 120, identity: async () => "unknown" })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect((await readRunLock(dir, RUN))?.token).toBe("opaque");
    expect(JSON.parse(await readFile(breakFile(dir), "utf8")).token).toBe("opaque-breaker");
  });

  it("T-S01-L12: every entry point rejects an unsafe run id before building a path", async () => {
    const dir = await root();
    for (const runId of ["a/b", "..", "/etc/passwd", "", "a.json", "a\\b"]) {
      await expect(acquireRunLock(dir, runId, options({ timeoutMs: 10 }))).rejects.toThrow("invalid run id");
      await expect(readRunLock(dir, runId)).rejects.toThrow("invalid run id");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("T-S01-L13: the break-lock is published atomically — a crash before the link leaves litter, never a lock", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    // What a crash between the break-lock's write and its link leaves: a tmp under the
    // break-lock's own name, and NO break-lock. Aged, so the sweep is entitled to it.
    const orphan = `${breakFile(dir)}.abandoned-break-token`;
    await writeFile(orphan, JSON.stringify({ pid: 1, startTime: "x", token: "abandoned-break-token", at: "now" }), "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(orphan, old, old);
    const release = await acquireRunLock(dir, RUN, options({ timeoutMs: 5_000, identity: async (pid) => pid === dead.pid ? "dead" : "alive" }));
    expect((await readRunLock(dir, RUN))?.pid).toBe(process.pid);
    await expect(stat(orphan)).rejects.toThrow();
    await expect(stat(breakFile(dir))).rejects.toThrow();
    await release();
  });

  it("T-S01-L13b: a FRESH break-lock tmp belongs to a breaker one link() away and is not swept", async () => {
    const dir = await root();
    const fresh = `${breakFile(dir)}.in-flight-break-token`;
    await writeFile(fresh, JSON.stringify({ pid: 1, startTime: "x", token: "in-flight-break-token", at: "now" }), "utf8");
    const release = await acquireRunLock(dir, RUN, options());
    await expect(stat(fresh)).resolves.toBeDefined();
    await release();
  });

  it("T-S01-L14: an OPAQUE break-lock is reclaimed by age only — fresh wedges nothing away, aged is cleared", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    const oracle: ProcessIdentityOracle = async (pid) => pid === dead.pid ? "dead" : "alive";
    // The empty file the old non-atomic publish left behind: parses to nothing, so there is no
    // identity to judge. FRESH, it may still belong to a breaker mid-write: never reclaimed.
    await writeFile(breakFile(dir), "", "utf8");
    await expect(acquireRunLock(dir, RUN, options({ timeoutMs: 200, identity: oracle })))
      .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(await readFile(breakFile(dir), "utf8")).toBe("");
    // AGED past the opaque TTL, it is litter and nothing else: reclaim it, or the run is
    // wedged forever by a file no identity can ever clear.
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(breakFile(dir), old, old);
    const release = await acquireRunLock(dir, RUN, options({ timeoutMs: 5_000, identity: oracle }));
    expect((await readRunLock(dir, RUN))?.pid).toBe(process.pid);
    await expect(stat(breakFile(dir))).rejects.toThrow();
    await release();
  });

  it("T-S01-L14b: a PARSEABLE break-lock is never aged out — identity still decides", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    await writeFile(breakFile(dir), JSON.stringify({ pid: process.pid, startTime: "live-breaker", token: "breaker", at: "now" }), "utf8");
    const ancient = new Date(Date.now() - 60 * 60_000);
    await utimes(breakFile(dir), ancient, ancient);
    await expect(acquireRunLock(dir, RUN, options({
      timeoutMs: 200, identity: async (pid) => pid === dead.pid ? "dead" : "alive",
    }))).rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(JSON.parse(await readFile(breakFile(dir), "utf8")).token).toBe("breaker");
  });

  it("T-S01-L15: a delayed reclaimer never deletes the live break-lock that replaced the one it judged", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    const deadBreaker = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    // A DEAD breaker's break-lock. Our acquire reads it, judges it dead, and is then
    // descheduled; meanwhile the breaker is reclaimed and a LIVE one takes its place. The
    // delayed reclaim must compare the inode it actually judged, not the path.
    await writeFile(breakFile(dir), JSON.stringify({ pid: deadBreaker.pid, startTime: deadBreaker.startTime, token: "dead-breaker", at: "now" }), "utf8");
    let replaced = false;
    const beforeOwnUnlink = async (): Promise<void> => {
      if (replaced) return;
      replaced = true;
      await rm(breakFile(dir), { force: true });
      await writeFile(breakFile(dir), JSON.stringify({ pid: process.pid, startTime: "live-breaker", token: "live-breaker", at: "now" }), "utf8");
    };
    await expect(acquireRunLock(dir, RUN, options({
      timeoutMs: 200,
      beforeOwnUnlink,
      identity: async (pid) => pid === dead.pid || pid === deadBreaker.pid ? "dead" : "alive",
    }))).rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT" });
    expect(replaced).toBe(true);
    expect(JSON.parse(await readFile(breakFile(dir), "utf8")).token).toBe("live-breaker");
  });

  it("T-S01-L16: two breakers race one dead lock — exactly one reclaims, and the winner's lock survives", async () => {
    const dir = await root();
    const dead = await deadIdentity();
    await writeLockRecord(dir, { pid: dead.pid, startTime: dead.startTime, token: "stale" });
    const oracle: ProcessIdentityOracle = async (pid) => pid === dead.pid ? "dead" : "alive";
    const held: string[] = [];
    const order: string[] = [];
    const run = async (name: string): Promise<void> => {
      const release = await acquireRunLock(dir, RUN, options({ timeoutMs: 10_000, identity: oracle }));
      order.push(name);
      const mine = (await readRunLock(dir, RUN))!;
      held.push(mine.token);
      // While we hold it, the lock file must name US — never a second breaker's replacement.
      await delay(60);
      expect((await readRunLock(dir, RUN))?.token).toBe(mine.token);
      await release();
    };
    await Promise.all([run("A"), run("B")]);
    expect(order).toHaveLength(2);
    expect(new Set(held).size).toBe(2);          // two distinct acquisitions, never one shared
    await expect(stat(breakFile(dir))).rejects.toThrow();
    await expect(stat(lockFile(dir))).rejects.toThrow();
  });
});
