import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { processIdentity, procStartTime } from "../../src/connectors/proc_identity.js";
import { StratumEngine } from "../../src/engine/engine.js";
import {
  acquireRunLock,
  lockedRead,
  lockedSave,
  readDriverLeaseSync,
  writeDriverLeaseSync,
} from "../../src/engine/run_lock.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
const restores: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) await restore().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A REAL child run to completion: its pid+startTime name a provably dead owner. */
async function deadIdentity(): Promise<{ pid: number; startTime: string }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = await procStartTime(pid);
  if (startTime === undefined) throw new Error("could not read the child's start time");
  await new Promise<void>((resolve) => { child.on("exit", () => resolve()); child.kill("SIGKILL"); });
  for (let tick = 0; tick < 200 && await processIdentity(pid, startTime) !== "dead"; tick += 1) await delay(5);
  return { pid, startTime };
}

/** A REAL child left running: its pid+startTime name a live foreign owner. */
async function liveIdentity(): Promise<{ pid: number; startTime: string }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = await procStartTime(pid);
  if (startTime === undefined) throw new Error("could not read the child's start time");
  restores.push(async () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  return { pid, startTime };
}

const spec = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};

async function plannedRun(stateRoot: string): Promise<string> {
  const engine = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
  const first = await engine.plan(spec, { name: "Ada" });
  return first.runId;
}

describe("F1 — a driver lease is reclaimed by TOKEN, never by bare process identity", () => {
  it("refuses a second claim from the same process when the token is not ours", async () => {
    const root = await tempRoot("stratum-f1-lease-");
    const startTime = (await procStartTime(process.pid))!;
    const first = writeDriverLeaseSync(root, "run-a", startTime);

    // The second claim is a DIFFERENT engine instance in the same process: same pid, same start
    // time, no knowledge of `first`. Identity alone cannot tell it from a leftover of its own.
    expect(() => writeDriverLeaseSync(root, "run-a", startTime))
      .toThrow(expect.objectContaining({ code: "DRIVER_LEASE_HELD" }));
    expect(readDriverLeaseSync(root, "run-a")?.token).toBe(first);

    // Our OWN leftover, named by its token, is still reclaimable.
    const second = writeDriverLeaseSync(root, "run-a", startTime, first);
    expect(second).not.toBe(first);
    expect(readDriverLeaseSync(root, "run-a")?.token).toBe(second);
  });

  it("does not let a second engine over one state root steal a live sibling's lease", async () => {
    const stateRoot = await tempRoot("stratum-f1-engine-");
    const runId = await plannedRun(stateRoot);
    const held = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
    const other = new StratumEngine({ stateRoot, evaluator: createEvaluator() });

    // `held` pins the run for real, through its own public bg path.
    const store = new StateStore(stateRoot);
    const run = await store.load(runId);
    run.bgDriven = true;
    await store.save(run);
    await held.rehydrateBgFlows();
    const owner = readDriverLeaseSync(stateRoot, runId);
    expect(owner).toBeDefined();

    // A sibling engine in the SAME process must read that lease as foreign and leave it alone.
    await other.rehydrateBgFlows();
    expect(readDriverLeaseSync(stateRoot, runId)?.token).toBe(owner!.token);
  });
});

describe("F3 — lockedSave is lease-aware and honours cancelled finality", () => {
  it("writes a plain run, refuses one under a live foreign lease, and refuses a cancelled one", async () => {
    const stateRoot = await tempRoot("stratum-f3-");
    const store = new StateStore(stateRoot);
    const runId = await plannedRun(stateRoot);

    // A plain run still works.
    await lockedSave(store, runId, (run) => { run.receipts = [];  });
    expect((await store.load(runId)).receipts).toEqual([]);

    // A LIVE foreign lease means another process owns the in-memory copy: refuse.
    const live = await liveIdentity();
    writeDriverLeaseSyncAs(stateRoot, runId, live);
    await expect(lockedSave(store, runId, (run) => { run.flowName = "clobbered"; }))
      .rejects.toMatchObject({ code: "DRIVER_LEASE_HELD" });
    expect((await store.load(runId)).flowName).not.toBe("clobbered");

    // A provably DEAD owner's lease is reclaimed and the write proceeds.
    const dead = await deadIdentity();
    writeDriverLeaseSyncAs(stateRoot, runId, dead);
    await lockedSave(store, runId, (run) => { run.flowName = "reclaimed"; });
    expect((await store.load(runId)).flowName).toBe("reclaimed");
    expect(readDriverLeaseSync(stateRoot, runId)).toBeUndefined();

    // A cancelled run is written exactly once, by the settle. Everything else throws.
    const cancelled = await store.load(runId);
    cancelled.status = "cancelled";
    await store.save(cancelled);
    await expect(lockedSave(store, runId, (run) => { run.flowName = "after-cancel"; }))
      .rejects.toMatchObject({ code: "PERSIST_ON_CANCELLED_RUN" });
    expect((await store.load(runId)).flowName).toBe("reclaimed");

    // Reading a cancelled run is always allowed, and never rewrites it.
    const before = await readFile(join(stateRoot, `${runId}.json`), "utf8").catch(() => undefined);
    expect(await lockedRead(store, runId, (run) => run.status)).toBe("cancelled");
    if (before !== undefined) expect(await readFile(join(stateRoot, `${runId}.json`), "utf8")).toBe(before);
  });
});

/** Publishes a lease naming SOMEONE ELSE, which `writeDriverLeaseSync` cannot do for us. */
function writeDriverLeaseSyncAs(root: string, runId: string, owner: { pid: number; startTime: string }): void {
  const record = { pid: owner.pid, startTime: owner.startTime, token: `foreign-${owner.pid}`, at: new Date().toISOString() };
  writeFileSync(join(root, `${runId}.driver`), JSON.stringify(record), "utf8");
}

describe("F4 — a release that FAILS is not a release that found nothing", () => {
  it("propagates an unlink failure instead of silently abandoning a live lock", async () => {
    const root = await tempRoot("stratum-f4-");
    const release = await acquireRunLock(root, "run-f4", { timeoutMs: 2_000 });
    await chmod(root, 0o500);
    restores.push(async () => { await chmod(root, 0o700); });
    // The lock is readable and the record is ours, but the directory refuses the unlink. The
    // old blanket catch reported `false` — "nothing of ours was there" — and left a live-owned
    // lock no other process could ever reclaim.
    await expect(release()).rejects.toMatchObject({ code: "EACCES" });
    await chmod(root, 0o700);
    expect(await readFile(join(root, "run-f4.lock"), "utf8")).toContain("\"pid\"");
  });
});

describe("F6 — a cancel budget that is not a number is refused, never treated as infinite", () => {
  it("rejects a non-finite STRATUM_CANCEL_TIMEOUT_MS rather than deadlining on NaN", async () => {
    const { cancelFlow } = await import("../../src/engine/flow_cancel.js");
    const engine = { flowCancel: async () => ({ runId: "r", status: "cancelled" as const, flowSettled: true, settledByThisCall: true }) };
    await expect(cancelFlow(engine as never, "r", { timeoutMs: Number.NaN }))
      .rejects.toThrow(/nonnegative finite number/);
    await expect(cancelFlow(engine as never, "r", { timeoutMs: Number.POSITIVE_INFINITY }))
      .rejects.toThrow(/nonnegative finite number/);
  });
});

describe("F2 — a pin site that fails leaves no bookkeeping behind", () => {
  it("flowRunBg does not durably mark bgDriven when the lease write fails", async () => {
    const stateRoot = await tempRoot("stratum-f2-bg-");
    const store = new StateStore(stateRoot);
    // `beforePin` is the engine's own seam: it runs after the run is planned and before the
    // locked pin section, which is exactly where a competing process could occupy the lease.
    const engine = new StratumEngine({
      stateRoot,
      evaluator: createEvaluator(),
      hooks: { beforePin: (runId) => blockLeaseWrites(stateRoot, runId) },
    });

    await expect(engine.flowRunBg(spec, { name: "Ada" })).rejects.toBeDefined();
    const ids = await store.list();
    expect(ids.length).toBe(1);
    // The durable `bgDriven` mark used to be written BEFORE the lease was claimed, so a refused
    // claim left a run that every later rehydrate reads as a live background flow.
    expect((await store.load(ids[0]!)).bgDriven).not.toBe(true);
    await expect(engine.flowBgPoll(ids[0]!)).rejects.toBeDefined();
  });

  it("rehydrate leaves no running bgFlows entry when the lease write fails", async () => {
    const stateRoot = await tempRoot("stratum-f2-rehydrate-");
    const store = new StateStore(stateRoot);
    const runId = await plannedRun(stateRoot);
    const run = await store.load(runId);
    run.bgDriven = true;
    await store.save(run);
    await blockLeaseWrites(stateRoot, runId);

    const engine = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
    // The scan swallows per-run failures by design; what must NOT survive is a `running`
    // bgFlows entry naming a driver that never launched.
    await engine.rehydrateBgFlows();
    await expect(engine.flowBgPoll(runId)).rejects.toBeDefined();
  });

  it("a refused gate re-kick leaves the gate pending instead of consuming it", async () => {
    const stateRoot = await tempRoot("stratum-f2-gate-");
    const engine = tokenEchoingEngine(new StratumEngine({
      stateRoot,
      evaluator: createEvaluator(),
      connector: async ({ prompt }) => ({ output: { value: prompt } }),
    }));
    const started = await engine.flowRunBg(await gateFixture(), { name: "Ada" });
    await waitForBg(engine, started.runId, "paused_gate");
    // The driver has released its pin at the pause, so the re-kick claims a fresh lease — and
    // this is where the claim now fails.
    await blockLeaseWrites(stateRoot, started.runId);

    await expect(engine.gateResolve(started.runId, "review", "approve")).rejects.toBeDefined();
    const after = await engine.flowBgPoll(started.runId);
    expect(after.bg.status).toBe("paused_gate");
    expect(after.bg.pendingGates).toEqual(["review"]);
  });

  it("a refused fanout pin does not burn the epoch key that lets the fanout be scheduled", async () => {
    const stateRoot = await tempRoot("stratum-f2-fanout-");
    let dispatched = 0;
    const engine = tokenEchoingEngine(new StratumEngine({
      stateRoot,
      evaluator: createEvaluator(),
      connector: async ({ prompt }) => { if (prompt.startsWith("fan ")) dispatched += 1; return { output: { value: prompt } }; },
    }));
    const planned = await engine.plan(fanoutSpec, { name: "Ada" });
    await blockLeaseWrites(stateRoot, planned.runId);

    // The scheduler pins the run before it dispatches the batch; the pin is what fails here.
    await expect(engine.stepDone(planned.runId, "prep", { output: { items: ["a", "b"] } }))
      .rejects.toBeDefined();
    expect(dispatched).toBe(0);

    // With the lease write working again, the SAME epoch must still be schedulable. Marking the
    // key scheduled before the pin left it set forever, and the step then never ran at all.
    await unblockLeaseWrites(stateRoot, planned.runId);
    await engine.resume(planned.runId);
    for (let tick = 0; tick < 200 && dispatched === 0; tick += 1) await delay(5);
    expect(dispatched).toBeGreaterThan(0);
  });
});

/** A REAL lease-write failure: the lease path is occupied by a directory, so `link()` cannot
 *  publish there and the record behind it cannot be read either. Nothing about it is specific to
 *  the fix under test — it fails the claim in the same place in both versions of the code. */
async function blockLeaseWrites(stateRoot: string, runId: string): Promise<void> {
  await mkdir(join(stateRoot, `${runId}.driver`), { recursive: true });
}

async function unblockLeaseWrites(stateRoot: string, runId: string): Promise<void> {
  await rm(join(stateRoot, `${runId}.driver`), { recursive: true, force: true });
}

async function waitForBg(engine: { flowBgPoll: StratumEngine["flowBgPoll"] }, runId: string, status: string): Promise<void> {
  for (let tick = 0; tick < 400; tick += 1) {
    const polled = await engine.flowBgPoll(runId).catch(() => undefined);
    if (polled?.bg.status === status) return;
    await delay(5);
  }
  throw new Error(`background flow never reached ${status}`);
}

async function gateFixture(): Promise<unknown> {
  const bytes = await readFile(new URL("../../parity/linear-gate.v1.yaml", import.meta.url));
  return parseDocument(bytes.toString("utf8"), { prettyErrors: false }).toJS();
}

const fanoutSpec = {
  version: 1,
  contracts: { Result: { value: "string" }, Batch: { items: "string[]" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${fan.output[0]}", contract: "Result" },
    steps: [
      { id: "prep", do: "prep", out: "Batch" },
      { id: "fan", after: ["prep"], fanout: {
        over: "${prep.output.items}", concurrency: 1, isolation: "none",
        require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }],
      } },
    ],
  } },
};
