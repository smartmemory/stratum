import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine, type BgStatus, type EngineConnector } from "../../src/engine/engine.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-rehydrate-"));
  roots.push(root);
  return root;
}

function engine(root: string, connector: EngineConnector): TokenEchoingEngine {
  return tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector }));
}

/** The engine that comes up AFTER a crash, where the previous driver is genuinely gone.
 *
 *  A same-process fixture cannot show that by identity alone, and must no longer try: a driver
 *  lease is reclaimed only from an owner that is provably DEAD or by the token this engine
 *  itself holds (F1). Before that, "same pid and start time" was read as "our own leftover",
 *  which is true of every engine instance in one process — so a test's second engine reclaimed
 *  the first engine's LIVE lease, and so would a second engine in a real server. The oracle
 *  states what the crash makes true, rather than leaving the fixture to rely on the hole. */
function restartedEngine(root: string, connector: EngineConnector): TokenEchoingEngine {
  return tokenEchoingEngine(new StratumEngine({
    stateRoot: root, evaluator: createEvaluator(), connector,
    lockOptions: { identity: async () => "dead" },
  }));
}

async function fixture(name: string): Promise<unknown> {
  const bytes = await readFile(new URL(`../../parity/${name}.v1.yaml`, import.meta.url));
  return parseDocument(bytes.toString("utf8"), { prettyErrors: false }).toJS();
}

async function waitForBg(subject: StratumEngine, runId: string, status: BgStatus) {
  for (let tick = 0; tick < 200; tick += 1) {
    const polled = await subject.flowBgPoll(runId);
    if (polled.bg.status === status) return polled;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`background flow did not reach ${status}`);
}

const linearFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${second.output}", contract: "Result" },
    steps: [
      { id: "first", do: "first ${input.name}", out: "Result" },
      { id: "second", after: ["first"], do: "second", out: "Result" },
    ],
  } },
};

describe("STRAT-TS-FLOW-BG-REHYDRATE", () => {
  it("resumes a live detached flow after restart", async () => {
    const root = await stateRoot();
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const blocked = new Promise<void>(() => undefined);
    const first = engine(root, async () => { markDispatched(); await blocked; return { output: { value: "unreachable" } }; });
    const started = await first.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;

    const prompts: string[] = [];
    const restarted = restartedEngine(root, async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    await restarted.rehydrateBgFlows();

    expect((await waitForBg(restarted, started.runId, "completed")).status).toBe("completed");
    expect(prompts).toEqual(["first Ada", "second"]);
  });

  it("rehydrates a paused gate without driving past it", async () => {
    const root = await stateRoot();
    const first = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await first.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    await waitForBg(first, started.runId, "paused_gate");

    const prompts: string[] = [];
    const restarted = engine(root, async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    await restarted.rehydrateBgFlows();
    const paused = await waitForBg(restarted, started.runId, "paused_gate");

    expect(paused).toMatchObject({ status: "running", bg: { status: "paused_gate", pendingGates: ["review"] } });
    expect(prompts).toEqual([]);
    await restarted.gateResolve(started.runId, "review", "approve");
    expect((await waitForBg(restarted, started.runId, "completed")).status).toBe("completed");
    expect(prompts).toEqual(["refine", "publish"]);
  });

  it("rehydrates a subflow gate and recomputes its scoped pending id", async () => {
    const root = await stateRoot();
    const first = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await first.flowRunBg(subflowGateFlow, { name: "Ada" });
    expect((await waitForBg(first, started.runId, "paused_gate")).bg.pendingGates).toEqual(["wrap/review"]);

    const prompts: string[] = [];
    const restarted = engine(root, async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    await restarted.rehydrateBgFlows();
    const paused = await waitForBg(restarted, started.runId, "paused_gate");

    expect(paused).toMatchObject({ status: "running", bg: { status: "paused_gate", pendingGates: ["wrap/review"] } });
    expect(prompts).toEqual([]);
    await restarted.gateResolve(started.runId, "wrap/review", "approve");
    expect((await waitForBg(restarted, started.runId, "completed")).status).toBe("completed");
  });

  it("does not drive a session-driven run", async () => {
    const root = await stateRoot();
    const first = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));
    const planned = await first.plan(linearFlow, { name: "Ada" });
    const restarted = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));

    await restarted.rehydrateBgFlows();

    await expect(restarted.flowBgPoll(planned.runId)).rejects.toThrow(/background flow .* not found/);
  });

  it("re-registers a terminal bg run without re-dispatching it", async () => {
    const root = await stateRoot();
    const first = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await first.flowRunBg(linearFlow, { name: "Ada" });
    await waitForBg(first, started.runId, "completed");
    let dispatches = 0;
    const restarted = engine(root, async ({ prompt }) => { dispatches += 1; return { output: { value: prompt } }; });

    await restarted.rehydrateBgFlows();

    expect((await restarted.flowBgPoll(started.runId)).bg).toMatchObject({ status: "completed", cancelRequested: false });
    expect(dispatches).toBe(0);
  });

  it("does not re-drive a cancelled run", async () => {
    const root = await stateRoot();
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const blocked = new Promise<void>(() => undefined);
    const first = engine(root, async () => { markDispatched(); await blocked; return { output: { value: "unreachable" } }; });
    const started = await first.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    await first.flowCancelBg(started.runId);
    let dispatches = 0;
    const restarted = engine(root, async ({ prompt }) => { dispatches += 1; return { output: { value: prompt } }; });

    await restarted.rehydrateBgFlows();

    expect((await restarted.flowBgPoll(started.runId)).bg).toEqual({ status: "cancelled", cancelRequested: true, pendingGates: [] });
    expect(dispatches).toBe(0);
  });

  it("keeps refusing gate decisions and resume on a cancelled run after restart", async () => {
    const root = await stateRoot();
    const first = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await first.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    await waitForBg(first, started.runId, "paused_gate");
    await first.flowCancelBg(started.runId);
    const restarted = engine(root, async ({ prompt }) => ({ output: { value: prompt } }));

    await restarted.rehydrateBgFlows();

    // Cancellation is durable: the restarted engine must not let the still-waiting
    // gate advance the abandoned run, nor hand its work out through resume.
    expect((await restarted.flowBgPoll(started.runId)).bg).toMatchObject({ status: "cancelled", cancelRequested: true });
    await expect(restarted.gateResolve(started.runId, "review", "approve")).rejects.toThrow(/cancelled/);
    await expect(restarted.resume(started.runId)).rejects.toThrow(/background-driven/);
  });

  it("is idempotent and does not double-drive", async () => {
    const root = await stateRoot();
    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const blocked = new Promise<void>(() => undefined);
    const first = engine(root, async () => { markDispatched(); await blocked; return { output: { value: "unreachable" } }; });
    const started = await first.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    let dispatches = 0;
    const restarted = restartedEngine(root, async ({ prompt }) => { dispatches += 1; return { output: { value: prompt } }; });

    await restarted.rehydrateBgFlows();
    await restarted.rehydrateBgFlows();

    await waitForBg(restarted, started.runId, "completed");
    expect(dispatches).toBe(2);
  });

  it("does not let a malformed persisted run block rehydration of a valid one", async () => {
    const root = await stateRoot();
    // A valid-JSON but invalid-spec bg run: it must fail in its own background
    // driver, never throw out of rehydrateBgFlows or abort the scan.
    const corrupt: PersistedRun = {
      id: "corruptrun", spec: { broken: true }, input: {}, flowName: "main",
      status: "running", flowSpent: {}, steps: {}, events: [], bgDriven: true,
    };
    await new StateStore(root).save(corrupt);

    let markDispatched!: () => void;
    const dispatched = new Promise<void>((resolve) => { markDispatched = resolve; });
    const blocked = new Promise<void>(() => undefined);
    const first = engine(root, async () => { markDispatched(); await blocked; return { output: { value: "unreachable" } }; });
    const started = await first.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;

    const prompts: string[] = [];
    const restarted = restartedEngine(root, async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    await expect(restarted.rehydrateBgFlows()).resolves.toBeUndefined();

    // The valid run still resumes to completion; the corrupt one fails in its own
    // background driver (its state is invalid, so it is not separately pollable).
    expect((await waitForBg(restarted, started.runId, "completed")).status).toBe("completed");
    expect(prompts).toEqual(["first Ada", "second"]);
  });

  it("treats empty and missing state roots as no-ops", async () => {
    const parent = await stateRoot();
    const empty = engine(parent, async ({ prompt }) => ({ output: { value: prompt } }));
    const missing = join(parent, "missing");
    const restarted = engine(missing, async ({ prompt }) => ({ output: { value: prompt } }));

    await expect(empty.rehydrateBgFlows()).resolves.toBeUndefined();
    await expect(restarted.rehydrateBgFlows()).resolves.toBeUndefined();
  });
});

const subflowGateFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: {
    entry: "main",
    main: {
      input: { name: "string" }, output: { from: "${wrap.output}", contract: "Result" },
      steps: [{ id: "wrap", run: "child", with: { name: "${input.name}" } }],
    },
    child: {
      input: { name: "string" }, output: { from: "${build.output}", contract: "Result" },
      steps: [
        { id: "build", do: "build ${input.name}", out: "Result" },
        { id: "review", after: ["build"], gate: { on_approve: null, on_revise: null, on_kill: null } },
      ],
    },
  },
};


it("does not combine an old running flow snapshot with a newly completed driver", async () => {
  const root = await stateRoot();
  let releaseConnector!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseConnector = resolve; });
  let entered!: () => void;
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  const subject = engine(root, async ({ prompt }) => { entered(); await blocked; return { output: { value: prompt } }; });
  const started = await subject.flowRunBg(linearFlow, { name: "Ada" });
  await dispatched;
  const internals = subject as unknown as { store: StateStore; bgFlows: Map<string, { loop?: Promise<void> }> };
  const originalLoad = internals.store.load.bind(internals.store);
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
  let readStarted!: () => void;
  const snapshotRead = new Promise<void>((resolve) => { readStarted = resolve; });
  const spy = vi.spyOn(internals.store, "load").mockImplementationOnce(async (id) => {
    const snapshot = await originalLoad(id);
    readStarted();
    await heldRead;
    return snapshot;
  });
  const polling = subject.flowBgPoll(started.runId);
  try {
    await snapshotRead;
    releaseConnector();
    await internals.bgFlows.get(started.runId)!.loop;
    releaseRead();
    expect(await polling).toMatchObject({ status: "running", bg: { status: "running" } });
    expect(await subject.flowBgPoll(started.runId)).toMatchObject({ status: "completed", bg: { status: "completed" } });
  } finally {
    releaseRead(); releaseConnector();
    await polling;
    await internals.bgFlows.get(started.runId)?.loop;
    spy.mockRestore();
  }
});
