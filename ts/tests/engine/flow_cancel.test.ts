import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointOperationError, StratumEngine, type EngineConnector, type EngineResponse } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { acquireRunLock, lockedSave } from "../../src/engine/run_lock.js";
import { procStartTime, processIdentity } from "../../src/connectors/proc_identity.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.STRATUM_CANCEL_LOCK_WAIT_MS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(connector?: EngineConnector, root?: string) {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-flowcancel-"));
  if (!root) roots.push(stateRoot);
  return {
    engine: new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...(connector ? { connector } : {}) }),
    root: stateRoot,
    store: new StateStore(stateRoot),
  };
}

const echo: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });
const Result = { value: "string" };
const TaskGraph = { tasks: "string[]" };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenOf(response: EngineResponse, id?: string): string {
  if (response.status !== "ready") throw new Error(`expected ready, got ${response.status}`);
  const entry = id === undefined ? response.ready[0] : response.ready.find((step) => step.id === id);
  const token = entry?.dispatchToken;
  if (typeof token !== "string") throw new Error(`expected a dispatch token for ${id ?? "the first ready step"}`);
  return token;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let tick = 0; tick < 400; tick += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A consumer-dispatch flow: compose's actual shape. `scheduleFanout` returns early for it,
 *  so it is NEVER pinned and therefore never carries a driver lease. */
const consumerFlow = {
  version: 1,
  contracts: { Result, TaskGraph },
  flows: { entry: "main", main: {
    input: { goal: "string" },
    output: { from: "${verify.output}", contract: "Result" },
    max_rounds: 2,
    steps: [
      { id: "plan", do: "plan ${input.goal}", out: "TaskGraph" },
      { id: "execute", after: ["plan"], fanout: {
        over: "${plan.output.tasks}", dispatch: "consumer", concurrency: 2, isolation: "none",
        require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
      } },
      { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
      { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
    ],
  } },
};

/** An ENGINE-dispatch fanout: pinned by `scheduleFanout`, so it carries a driver lease. */
const engineFanFlow = (attempts = 1) => ({
  version: 1,
  contracts: { Result },
  flows: { entry: "main", main: {
    input: { items: "string[]" },
    output: { from: "${fan.output[0]}", contract: "Result" },
    steps: [{ id: "fan", fanout: {
      over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
      steps: [{ do: "fan ${item}", out: "Result", attempts }],
    } }],
  } },
});

const taskFlow = {
  version: 1,
  contracts: { Result },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${work.output}", contract: "Result" },
    steps: [{ id: "work", do: "work ${input.name}", out: "Result" }],
  } },
};

/** Plan `consumerFlow` and settle `plan`, leaving two consumer items ready. */
async function consumerRun(engine: StratumEngine): Promise<{ runId: string; response: EngineResponse }> {
  const planned = await engine.plan(consumerFlow, { goal: "ship" });
  const response = await engine.stepDone(planned.runId, "plan", { output: { tasks: ["a", "b"] } }, tokenOf(planned));
  return { runId: planned.runId, response };
}

describe("STRAT-FLOW-CANCEL-FG S01 — cross-process foreground cancel", () => {
  it("T-S01-1: a second engine over the same root settles a consumer-fanout foreground run", async () => {
    const first = await subject(echo);
    const { runId } = await consumerRun(first.engine);
    const second = await subject(echo, first.root);

    const result = await second.engine.flowCancel(runId, "abort");
    expect(result).toMatchObject({ runId, status: "cancelled", flowSettled: true, settledByThisCall: true });

    const persisted = await first.store.load(runId);
    expect(persisted.status).toBe("cancelled");
    expect(persisted.cancelRequested).toBe(true);
    const cancelled = persisted.events.filter((event) => event.type === "flow_cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.detail).toMatchObject({ by: "fg", reason: "abort" });
    // The settle burned every outstanding issuance, and recorded WHAT it burned.
    const burned = (cancelled[0]!.detail as { burned: { steps: string[]; items: number } }).burned;
    expect(burned.items).toBe(2);
    expect(persisted.steps.execute?.fanout?.items.every((item) => item.dispatchToken === undefined)).toBe(true);
  });

  it("T-S01-2: a concurrent stepDone and cancel never interleave, and the final state is cancelled either way", async () => {
    const first = await subject(echo);
    const { runId, response } = await consumerRun(first.engine);
    const token = tokenOf(response, response.status === "ready" ? response.ready.find((s) => s.id.startsWith("execute/"))!.id : undefined);
    const itemId = response.status === "ready" ? response.ready.find((s) => s.id.startsWith("execute/"))!.id : "";
    const second = await subject(echo, first.root);

    const snapshots: Array<{ status: string; events: number }> = [];
    const save = StateStore.prototype.save;
    vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, run: PersistedRun) {
      snapshots.push({ status: run.status, events: run.events.length });
      return save.call(this, run);
    });

    const settle = first.engine.stepDone(runId, itemId, { output: { value: "late" } }, token).catch((error: unknown) => error);
    const cancel = second.engine.flowCancel(runId).catch((error: unknown) => error);
    await Promise.all([settle, cancel]);

    // Whichever order they serialised in, the durable end state is cancelled, and no snapshot
    // was ever written back over a cancelled one except the sanctioned settle itself.
    expect((await first.store.load(runId)).status).toBe("cancelled");
    const afterFirstCancelled = snapshots.slice(snapshots.findIndex((snapshot) => snapshot.status === "cancelled") + 1);
    expect(afterFirstCancelled.filter((snapshot) => snapshot.status === "running")).toEqual([]);
  });

  it("T-S01-3: a persist outside a locked section throws", async () => {
    const { engine, store } = await subject(echo);
    const planned = await engine.plan(taskFlow, { name: "Ada" });
    const run = await store.load(planned.runId);
    const unlocked = engine as unknown as { persist: (run: PersistedRun) => Promise<void> };
    // The assertion fires BEFORE any promise is created, so an unlocked write cannot even be
    // scheduled — it is a programming error, not a rejected operation.
    expect(() => unlocked.persist(run)).toThrow(/outside a locked section/);
  });

  it("T-S01-4: a late consumer stepDone is refused and its issuance is burned, not accepted", async () => {
    const first = await subject(echo);
    const { runId, response } = await consumerRun(first.engine);
    if (response.status !== "ready") throw new Error("expected ready consumer items");
    const item = response.ready.find((step) => step.id.startsWith("execute/"))!;
    const second = await subject(echo, first.root);

    await second.engine.flowCancel(runId);
    await expect(first.engine.stepDone(runId, item.id, { output: { value: "late" } }, item.dispatchToken!))
      .rejects.toThrow(/cancelled/);
    const persisted = await first.store.load(runId);
    const items = persisted.steps.execute?.fanout?.items ?? [];
    expect(items.map((entry) => entry.dispatchToken)).toEqual(items.map(() => undefined));
    expect(items.map((entry) => entry.acceptedDispatchToken)).toEqual(items.map(() => undefined));
  });

  it("T-S01-5: a merge-gate decision is refused and its gate token is burned", async () => {
    const first = await subject(echo);
    const { runId, response } = await consumerRun(first.engine);
    let current = response;
    while (current.status === "ready" && current.ready.some((step) => step.id.startsWith("execute/"))) {
      const next = current.ready.find((step) => step.id.startsWith("execute/"))!;
      current = await first.engine.stepDone(runId, next.id, { output: { value: "done" } }, next.dispatchToken!);
    }
    await waitUntil(async () => (await first.store.load(runId)).steps.execute_merge?.status === "waiting_gate", "the merge gate");
    const gateToken = (await first.store.load(runId)).steps.execute_merge!.gateToken!;
    expect(gateToken).toBeDefined();

    const second = await subject(echo, first.root);
    await second.engine.flowCancel(runId);
    await expect(first.engine.gateResolve(runId, "execute_merge", "approve", gateToken)).rejects.toThrow(/cancelled/);
    expect((await first.store.load(runId)).steps.execute_merge?.gateToken).toBeUndefined();
  });

  it("T-S01-6: resume is refused on a cancelled run", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const second = await subject(echo, first.root);
    await second.engine.flowCancel(planned.runId);
    await expect(first.engine.resume(planned.runId)).rejects.toThrow(/cancelled/);
    await expect(second.engine.resume(planned.runId)).rejects.toThrow(/cancelled/);
  });

  it("T-S01-7: both revert and commit are refused on a cancelled run — foreground AND bg-driven", async () => {
    // Foreground.
    const foreground = await subject(echo);
    const planned = await foreground.engine.plan(taskFlow, { name: "Ada" });
    await foreground.engine.commit(planned.runId, "before");
    await foreground.engine.flowCancel(planned.runId);
    for (const operation of ["commit", "revert"] as const) {
      const attempt = operation === "commit"
        ? foreground.engine.commit(planned.runId, "after")
        : foreground.engine.revert(planned.runId, "before");
      await expect(attempt).rejects.toMatchObject({ errorType: "flow_cancelled" });
      await expect(attempt).rejects.toBeInstanceOf(CheckpointOperationError);
    }

    // Bg-driven: this is the row that fails if the cancelled check sits behind
    // assertExternalMutationAllowed — it reports `is background-driven` instead (R4-6).
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const background = await subject(async ({ prompt }) => { await blocked; return { output: { value: prompt } }; });
    const bg = await background.engine.flowRunBg(taskFlow, { name: "Ada" });
    // The lease restricts a pinned run's cancel to its own driver, so cancel from there.
    await background.engine.flowCancel(bg.runId);
    await expect(background.engine.commit(bg.runId, "after")).rejects.toMatchObject({ errorType: "flow_cancelled" });
    await expect(background.engine.revert(bg.runId, "before")).rejects.toMatchObject({ errorType: "flow_cancelled" });
    release();
  });

  it("T-S01-8: a result returning after the cancel is abandoned — no attempt, output, or accepted token", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a"] });
    await waitUntil(() => calls === 1, "the fanout connector to be in flight");

    // The lease refuses a second process (T-S01-D2), so the driving engine cancels.
    const cancelled = await first.engine.flowCancel(planned.runId);
    expect(cancelled.settledByThisCall).toBe(true);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");

    const persisted = await first.store.load(planned.runId);
    expect(persisted.status).toBe("cancelled");
    const item = persisted.steps.fan!.fanout!.items[0]!;
    expect(item.output).toBeUndefined();
    expect(item.patch).toBeUndefined();
    expect(item.acceptedDispatchToken).toBeUndefined();
    expect(item.dispatchToken).toBeUndefined();
    // The dispatched attempt was admitted before the cancel; the returning result recorded
    // nothing — no attempt carries a result.
    expect(item.attempts.filter((attempt) => attempt.result !== undefined)).toEqual([]);
  });

  it("T-S01-8b: an abandoned WORKTREE item captures no patch — the most expensive wrong accept", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-flowcancel-repo-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);

    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let workdir: string | undefined;
    const first = await subject(async ({ prompt, cwd }) => {
      workdir = cwd;
      // Real work in the worktree: exactly the change a patch capture would pick up.
      await writeFile(join(cwd!, "AGENT_WORK"), "written by a cancelled agent\n");
      await blocked;
      return { output: { value: prompt } };
    });
    const spec = {
      version: 1, contracts: { Result }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      } },
    };
    const planned = await first.engine.plan(spec, { items: ["a"] }, { workspaceRoot: repo });
    await waitUntil(() => workdir !== undefined, "the worktree item to dispatch");
    await first.engine.flowCancel(planned.runId);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");

    const item = (await first.store.load(planned.runId)).steps.fan!.fanout!.items[0]!;
    expect(item.patch).toBeUndefined();
    expect(item.status).not.toBe("succeeded");
    // The worktree is still torn down on DISK: a cancelled run must not leak worktrees just
    // because it may not write.
    expect(existsSync(workdir!)).toBe(false);
    // The RECORD still names it, and deliberately so: the settle snapshot is final (R4-1), so
    // the finally's `delete item.worktree` is never persisted. Nothing reads the field on a
    // cancelled run — resume, commit and revert are all refused — and the alternative is a
    // second write to a record the whole design declares closed.
    expect(item.worktree).toBe(workdir);
  });

  it("T-S01-8d: a connector that REJECTS after the cancel records no attempt either", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async () => { calls += 1; await blocked; throw new Error("connector exploded"); });
    const planned = await first.engine.plan(engineFanFlow(2), { items: ["a"] });
    await waitUntil(() => calls === 1, "the fanout connector to be in flight");
    const before = (await first.store.load(planned.runId)).steps.fan!.fanout!.items[0]!.attempts.length;

    await first.engine.flowCancel(planned.runId);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");

    const item = (await first.store.load(planned.runId)).steps.fan!.fanout!.items[0]!;
    // recordFanoutAttempt now runs inside the locked transaction, not a bare catch (R4-5).
    expect(item.attempts).toHaveLength(before);
    expect(calls).toBe(1);
  });

  it("T-S01-8c: the post-drain snapshot equals the settle snapshot, written exactly once", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a", "b"] });
    await waitUntil(() => calls >= 1, "the fanout connector to be in flight");

    const cancelledSnapshots: Array<{ events: number }> = [];
    const save = StateStore.prototype.save;
    vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, run: PersistedRun) {
      if (run.status === "cancelled") cancelledSnapshots.push({ events: run.events.length });
      return save.call(this, run);
    });

    await first.engine.flowCancel(planned.runId);
    const settled = await first.store.load(planned.runId);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");

    // Exactly ONE cancelled snapshot was written: the sanctioned one (R4-1).
    expect(cancelledSnapshots).toHaveLength(1);
    const drained = await first.store.load(planned.runId);
    expect(drained.events.length).toBe(settled.events.length);
    expect(drained.events.filter((event) => event.type === "flow_cancelled")).toHaveLength(1);
    expect(drained).toEqual(settled);
  });

  it("T-S01-8e: persist on a cancelled run surfaces PERSIST_ON_CANCELLED_RUN instead of vanishing", async () => {
    const { engine } = await subject(echo);
    const planned = await engine.plan(taskFlow, { name: "Ada" });
    await engine.flowCancel(planned.runId);
    await expect(engine.withReceiptUpdate(planned.runId, () => undefined))
      .rejects.toMatchObject({ code: "PERSIST_ON_CANCELLED_RUN" });
  });

  it("T-S01-9: the fanout brake sees the cancel — no further item is dispatched", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a", "b", "c"] });
    await waitUntil(() => calls === 1, "the first item to dispatch");
    await first.engine.flowCancel(planned.runId);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");
    expect(calls).toBe(1);
  });

  it("T-S01-10: cancelling an already-completed run is a no-op success, not an error", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    await first.engine.stepDone(planned.runId, "work", { output: { value: "done" } }, tokenOf(planned));
    const before = await first.store.load(planned.runId);
    expect(before.status).toBe("completed");

    const second = await subject(echo, first.root);
    const result = await second.engine.flowCancel(planned.runId);
    expect(result).toMatchObject({
      status: "completed", flowSettled: false, settledByThisCall: false, reason: "already_completed",
    });
    expect(await first.store.load(planned.runId)).toEqual(before);

    // Idempotency for a genuinely cancelled run falls out of the same disk read.
    const other = await subject(echo);
    const running = await other.engine.plan(taskFlow, { name: "Ada" });
    await other.engine.flowCancel(running.runId);
    const events = (await other.store.load(running.runId)).events.length;
    expect(await other.engine.flowCancel(running.runId)).toMatchObject({
      status: "cancelled", flowSettled: true, settledByThisCall: false, reason: "already_cancelled",
    });
    expect((await other.store.load(running.runId)).events.length).toBe(events);
  });

  it("T-S01-11: a live bg driver's lease refuses a foreign cancel, and driveBg terminalises off the DURABLE record", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = await subject(async ({ prompt }) => { await blocked; return { output: { value: prompt } }; });
    const bg = await first.engine.flowRunBg(taskFlow, { name: "Ada" });

    // flowRunBg pins the run, so it carries a driver lease exactly as an engine-dispatch
    // fanout does: a second process is refused with the holder pid rather than allowed to
    // race the driver's in-memory object (R4-4).
    const second = await subject(echo, first.root);
    await expect(second.engine.flowCancel(bg.runId)).rejects.toMatchObject({
      code: "CANCELLATION_UNCONFIRMED", reason: "engine_dispatch_active", holderPid: process.pid,
    });
    expect((await first.store.load(bg.runId)).status).toBe("running");

    // The driving engine may settle its own pinned run. The driver loop must then terminalise
    // rather than spin, and the returning connector result must NOT complete the run back over
    // the settle.
    await first.engine.flowCancel(bg.runId);
    release();
    await waitUntil(async () => (await first.engine.flowBgPoll(bg.runId)).bg.status === "cancelled", "the bg mirror to catch up");
    const settled = await first.store.load(bg.runId);
    expect(settled.status).toBe("cancelled");
    await delay(100);
    expect((await first.store.load(bg.runId)).status).toBe("cancelled");
    expect((await first.engine.flowBgPoll(bg.runId)).status).toBe("cancelled");
  });

  it("T-S01-12: a BACKGROUND cancel still abandons rather than settling", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = await subject(async ({ prompt }) => { await blocked; return { output: { value: prompt } }; });
    const bg = await first.engine.flowRunBg(taskFlow, { name: "Ada" });
    await first.engine.flowCancelBg(bg.runId);
    release();
    await delay(50);
    const persisted = await first.store.load(bg.runId);
    expect(persisted.status).toBe("running");
    expect(persisted.cancelRequested).toBe(true);
  });

  it("T-S01-13: flowCancel of an unknown run id rejects with ENOENT", async () => {
    const { engine } = await subject(echo);
    await expect(engine.flowCancel("no-such-run")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("T-S01-14: a lock-wait expiry carries the holder pid and mutates NOTHING", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const before = await first.store.load(planned.runId);

    const holder = await acquireRunLock(first.root, planned.runId, {});
    process.env.STRATUM_CANCEL_LOCK_WAIT_MS = "40";
    const second = await subject(echo, first.root);
    try {
      await expect(second.engine.flowCancel(planned.runId))
        .rejects.toMatchObject({ code: "RUN_LOCK_TIMEOUT", holderPid: process.pid });
    } finally {
      await holder();
    }
    const after = await first.store.load(planned.runId);
    expect(after).toEqual(before);
    expect(after.events.filter((event) => event.type === "flow_cancelled")).toEqual([]);
  });
});

describe("STRAT-FLOW-CANCEL-FG S01 — the driver lease", () => {
  it("T-S01-D1: the lease is written on the pin and removed on the last release", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a"] });
    await waitUntil(() => calls === 1, "the fanout to pin the run");
    await expect(stat(join(first.root, `${planned.runId}.driver`))).resolves.toBeDefined();
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the lease to be released");
  });

  it("T-S01-D2: a cross-process cancel of a pinned run is REFUSED, and mutates nothing", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a"] });
    await waitUntil(() => calls === 1, "the fanout to pin the run");
    const before = await first.store.load(planned.runId);

    const second = await subject(echo, first.root);
    await expect(second.engine.flowCancel(planned.runId)).rejects.toMatchObject({
      code: "CANCELLATION_UNCONFIRMED", reason: "engine_dispatch_active", holderPid: process.pid,
    });
    const after = await first.store.load(planned.runId);
    expect(after.status).toBe("running");
    expect(after.cancelRequested).toBeUndefined();
    expect(after.events.length).toBe(before.events.length);
    expect(after.steps.fan?.fanout?.items[0]?.dispatchToken).toBe(before.steps.fan?.fanout?.items[0]?.dispatchToken);
    release();
  });

  it("T-S01-D3: a lease naming a provably dead owner is reclaimed and the cancel settles", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
    const pid = child.pid!;
    const startTime = (await procStartTime(pid))!;
    await new Promise<void>((resolve) => { child.on("exit", () => resolve()); child.kill("SIGKILL"); });
    await waitUntil(async () => await processIdentity(pid, startTime) === "dead", "the child to be reaped");

    const lease = join(first.root, `${planned.runId}.driver`);
    await writeFile(lease, JSON.stringify({ pid, startTime, token: "stale-lease", at: "now" }), "utf8");
    const second = await subject(echo, first.root);
    expect(await second.engine.flowCancel(planned.runId)).toMatchObject({ status: "cancelled", settledByThisCall: true });
    expect(existsSync(lease)).toBe(false);
  });

  it("T-S01-D4: an `unknown` identity is never reclaimed — the cancel is refused", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const lease = join(first.root, `${planned.runId}.driver`);
    // pid 1 is launchd/init: alive, EPERM to a non-root probe, and unreadable — "unknown".
    await writeFile(lease, JSON.stringify({ pid: 1, startTime: "opaque", token: "opaque-lease", at: "now" }), "utf8");
    const second = await subject(echo, first.root);
    await expect(second.engine.flowCancel(planned.runId)).rejects.toMatchObject({
      code: "CANCELLATION_UNCONFIRMED", reason: "engine_dispatch_active", holderPid: 1,
    });
    expect((await first.store.load(planned.runId)).status).toBe("running");
    expect(existsSync(lease)).toBe(true);
  });

  it("T-S01-D5: the DRIVING engine may cancel its own pinned run, and the drain never overwrites the settle", async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = await subject(async ({ prompt }) => { calls += 1; await blocked; return { output: { value: prompt } }; });
    const planned = await first.engine.plan(engineFanFlow(), { items: ["a", "b"] });
    await waitUntil(() => calls === 1, "the fanout to pin the run");

    expect(await first.engine.flowCancel(planned.runId)).toMatchObject({ status: "cancelled", settledByThisCall: true });
    const settled = await first.store.load(planned.runId);
    release();
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the workers to drain");
    const drained = await first.store.load(planned.runId);
    expect(drained.status).toBe("cancelled");
    expect(drained.events.filter((event) => event.type === "flow_cancelled")).toHaveLength(1);
    expect(drained).toEqual(settled);
    expect(calls).toBe(1);
  });

  it("T-S01-D6: a consumer-dispatch run writes NO lease, so compose's case is never refused", async () => {
    const first = await subject(echo);
    const { runId } = await consumerRun(first.engine);
    expect(existsSync(join(first.root, `${runId}.driver`))).toBe(false);
    const second = await subject(echo, first.root);
    expect(await second.engine.flowCancel(runId)).toMatchObject({ status: "cancelled", settledByThisCall: true });
  });
});

describe("STRAT-FLOW-CANCEL-FG S01 — every write path is locked", () => {
  it("T-S01-W1: every durable save lands while the run's lock file is published", async () => {
    const first = await subject(echo);
    const unlockedSaves: string[] = [];
    const save = StateStore.prototype.save;
    vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, run: PersistedRun) {
      // A cross-process reader's view: the lock must be PUBLISHED, not merely intended.
      if (!existsSync(join(this.root, `${run.id}.lock`))) unlockedSaves.push(`${run.id}:${run.status}`);
      return save.call(this, run);
    });
    // plan()'s initial persist and its first advance were the uncovered path (R3-3a).
    const planned = await first.engine.plan(consumerFlow, { goal: "ship" });
    await first.engine.stepDone(planned.runId, "plan", { output: { tasks: ["a"] } }, tokenOf(planned));
    await first.engine.flowCancel(planned.runId);
    expect(unlockedSaves).toEqual([]);
  });

  it("T-S01-W2: a cancel between two stage attempts is seen at the next acquire, and nothing re-dispatches", async () => {
    let calls = 0;
    let cancelled: Promise<unknown> | undefined;
    let engineRef: StratumEngine | undefined;
    let runIdRef: string | undefined;
    const first = await subject(async () => {
      calls += 1;
      // Cancel from the driving engine while attempt 1 is in flight; attempt 2 must never
      // reach the connector, because its admission transaction re-acquires the lock.
      cancelled ??= engineRef!.flowCancel(runIdRef!);
      await cancelled;
      throw new Error("attempt failed");
    });
    engineRef = first.engine;
    const planned = await first.engine.plan(engineFanFlow(3), { items: ["a"] });
    runIdRef = planned.runId;
    await waitUntil(async () => !existsSync(join(first.root, `${planned.runId}.driver`)), "the fanout to drain");
    expect(calls).toBe(1);
    expect((await first.store.load(planned.runId)).status).toBe("cancelled");
  });

  it("T-S01-W3: lockedSave — the helper `stratum learn egress` now uses — blocks on a held lock", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const holder = await acquireRunLock(first.root, planned.runId, {});
    let entered = false;
    const pending = lockedSave(first.store, planned.runId, (run) => { entered = true; run.flowName = run.flowName; });
    await delay(100);
    expect(entered).toBe(false);
    await holder();
    await pending;
    expect(entered).toBe(true);
  });
});
