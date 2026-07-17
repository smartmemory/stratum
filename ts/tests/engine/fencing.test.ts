import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type EngineConnector, type EngineResponse } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { StateStore, type PersistedRun, type StepState } from "../../src/engine/state.js";
import { asUntypedCaller } from "../helpers/untyped_caller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(connector?: EngineConnector, root?: string) {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-fencing-"));
  if (!root) roots.push(stateRoot);
  return {
    engine: new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...(connector ? { connector } : {}) }),
    root: stateRoot,
    store: new StateStore(stateRoot),
  };
}

const resultContract = { value: "string" };
const taskFlow = (attempts = 2) => ({
  version: 1,
  contracts: { Result: resultContract },
  flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${work.output}", contract: "Result" },
    steps: [{ id: "work", do: "work ${input.name}", out: "Result", attempts }],
  } },
});

function tokenOf(response: EngineResponse): string {
  if (response.status !== "ready") throw new Error(`expected ready, got ${response.status}`);
  const token = response.ready[0]?.dispatchToken;
  if (typeof token !== "string") throw new Error("expected dispatch token");
  return token;
}

async function waitFor(engine: StratumEngine, runId: string, predicate: (run: Awaited<ReturnType<StratumEngine["audit"]>>) => boolean) {
  for (let tick = 0; tick < 200; tick += 1) {
    const run = await engine.audit(runId);
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("run did not reach expected state");
}

describe("engine issuance fencing", () => {
  it("persists one ready token across plan, resume, polling, and process restart without re-debiting", async () => {
    const first = await subject();
    const planned = await first.engine.plan(taskFlow(), { name: "Ada" });
    const token = tokenOf(planned);
    expect(planned).toMatchObject({ status: "ready", ready: [{ dispatchToken: token }], ledger: { spent: { dispatches: 1 } } });
    expect((await first.engine.flowPoll(planned.runId)).ledger.spent.dispatches).toBe(1);
    expect(await first.engine.resume(planned.runId)).toMatchObject({ status: "ready", ready: [{ dispatchToken: token }], ledger: { spent: { dispatches: 1 } } });

    const restarted = await subject(undefined, first.root);
    expect(await restarted.engine.resume(planned.runId)).toMatchObject({ status: "ready", ready: [{ dispatchToken: token }], ledger: { spent: { dispatches: 1 } } });
    expect((await restarted.store.load(planned.runId)).steps.work?.dispatchToken).toBe(token);
  });

  it("rejects missing, mismatched, and superseded step tokens, accepts the current token, and persists acceptedDispatchToken", async () => {
    const current = await subject();
    const planned = await current.engine.plan(taskFlow(), { name: "Ada" });
    const firstToken = tokenOf(planned);
    await expect(current.engine.stepDone(planned.runId, "work", { failure: "retry" }, "wrong-token")).rejects.toThrow(/stale/);
    const retry = await current.engine.stepDone(planned.runId, "work", { failure: "retry" }, firstToken);
    const retryToken = tokenOf(retry);
    expect(retryToken).not.toBe(firstToken);
    await expect(current.engine.stepDone(planned.runId, "work", { output: { value: "stale" } }, firstToken)).rejects.toThrow(/stale/);
    expect(await current.engine.stepDone(planned.runId, "work", { output: { value: "fresh" } }, retryToken)).toMatchObject({ status: "completed" });
    expect((await current.engine.audit(planned.runId)).steps.work).toMatchObject({
      status: "succeeded", acceptedDispatchToken: retryToken,
    });
    expect((await current.engine.audit(planned.runId)).steps.work?.dispatchToken).toBeUndefined();

    const compat = await subject();
    const compatible = await compat.engine.plan(taskFlow(), { name: "Grace" });
    await expect(asUntypedCaller(compat.engine).stepDone(compatible.runId, "work", { output: { value: "missing echo" } }))
      .rejects.toThrow(/missing dispatch token/i);
    expect((await compat.engine.audit(compatible.runId)).steps.work?.acceptedDispatchToken).toBeUndefined();
  });

  it("rejects a missing dispatch token for a scoped subflow step id", async () => {
    const { engine } = await subject();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: {
        entry: "main",
        main: {
          input: { name: "string" }, output: { from: "${wrap.output}", contract: "Result" },
          steps: [{ id: "wrap", run: "child", with: { name: "${input.name}" } }],
        },
        child: {
          input: { name: "string" }, output: { from: "${work.output}", contract: "Result" },
          steps: [{ id: "work", do: "work ${input.name}", out: "Result" }],
        },
      },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    expect(planned).toMatchObject({ status: "ready", ready: [{ id: "wrap/work", dispatchToken: expect.any(String) }] });
    await expect(asUntypedCaller(engine).stepDone(planned.runId, "wrap/work", { output: { value: "missing echo" } }))
      .rejects.toThrow(/missing dispatch token/i);
  });

  it("rotates an engine fanout item's token on stage advance and retains the accepted final-stage token", async () => {
    const releases: Array<() => void> = [];
    const starts: Array<() => void> = [];
    const blocked = [0, 1].map((index) => new Promise<void>((resolve) => { releases[index] = resolve; }));
    const started = [0, 1].map((index) => new Promise<void>((resolve) => { starts[index] = resolve; }));
    let call = 0;
    const connector: EngineConnector = async ({ prompt }) => {
      const index = call++;
      starts[index]?.();
      await blocked[index];
      return { output: { value: prompt } };
    };
    const { engine, store } = await subject(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "first ${item}", out: "Result" }, { do: "second ${item}", out: "Result" }],
        } }],
      } },
    };
    const planned = await engine.plan(spec, { items: ["a"] });
    await started[0];
    const first = (await store.load(planned.runId)).steps.fan?.fanout?.items[0];
    expect(first).toMatchObject({ stage: 0, status: "running", generation: 1, dispatchToken: expect.any(String) });
    const firstToken = first?.dispatchToken;
    releases[0]!();
    await started[1];
    const second = (await store.load(planned.runId)).steps.fan?.fanout?.items[0];
    expect(second).toMatchObject({ stage: 1, status: "running", generation: 1, dispatchToken: expect.any(String) });
    expect(second?.dispatchToken).not.toBe(firstToken);
    const secondToken = second?.dispatchToken;
    releases[1]!();
    const terminal = await waitFor(engine, planned.runId, (audit) => audit.status === "completed");
    expect(terminal.steps.fan?.fanout?.items[0]).toMatchObject({
      status: "succeeded", acceptedDispatchToken: secondToken,
    });
    expect(terminal.steps.fan?.fanout?.items[0]?.dispatchToken).toBeUndefined();
  });

  it("mints a fresh gate token each waiting round and rejects prior-round and missing decisions while accepting the current echo", async () => {
    const { engine } = await subject();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, max_rounds: 2,
        steps: [
          { id: "work", do: "work", out: "Result" },
          { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: "work", on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    const dispatch1 = tokenOf(planned);
    await engine.stepDone(planned.runId, "work", { output: { value: "one" } }, dispatch1);
    const gate1 = (await engine.audit(planned.runId)).steps.review?.gateToken;
    expect(gate1).toEqual(expect.any(String));
    const revised = await engine.gateResolve(planned.runId, "review", "revise", gate1!);
    const dispatch2 = tokenOf(revised);
    expect(dispatch2).not.toBe(dispatch1);
    await engine.stepDone(planned.runId, "work", { output: { value: "two" } }, dispatch2);
    const gate2 = (await engine.audit(planned.runId)).steps.review?.gateToken;
    expect(gate2).toEqual(expect.any(String));
    expect(gate2).not.toBe(gate1);
    await expect(engine.gateResolve(planned.runId, "review", "approve", gate1!)).rejects.toThrow(/stale/);
    await expect(asUntypedCaller(engine).gateResolve(planned.runId, "review", "approve")).rejects.toThrow(/missing gate token/i);
    expect(await engine.gateResolve(planned.runId, "review", "approve", gate2!)).toMatchObject({ status: "ready", ready: [{ id: "finish" }] });

    const current = await subject();
    const currentPlan = await current.engine.plan(spec, { name: "Ada" });
    await current.engine.stepDone(currentPlan.runId, "work", { output: { value: "one" } }, tokenOf(currentPlan));
    const gate = (await current.engine.audit(currentPlan.runId)).steps.review?.gateToken;
    expect(await current.engine.gateResolve(currentPlan.runId, "review", "approve", gate!)).toMatchObject({ status: "ready" });
  });

  it("re-mints restored ready and gate issuances after checkpoint revert", async () => {
    const { engine } = await subject();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "work", do: "work", out: "Result" },
          { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    const dispatchBefore = tokenOf(planned);
    await engine.commit(planned.runId, "ready");
    await engine.stepDone(planned.runId, "work", { output: { value: "done" } }, dispatchBefore);
    const gateBefore = (await engine.audit(planned.runId)).steps.review?.gateToken;
    await engine.commit(planned.runId, "gate");
    await engine.gateResolve(planned.runId, "review", "approve", gateBefore!);

    const revertedGate = await engine.revert(planned.runId, "gate");
    expect(revertedGate.status).toBe("running");
    const gateAfter = (await engine.audit(planned.runId)).steps.review?.gateToken;
    expect(gateAfter).not.toBe(gateBefore);
    await expect(engine.gateResolve(planned.runId, "review", "approve", gateBefore!)).rejects.toThrow(/stale/);

    const revertedReady = await engine.revert(planned.runId, "ready");
    const dispatchAfter = tokenOf(revertedReady);
    expect(dispatchAfter).not.toBe(dispatchBefore);
    await expect(engine.stepDone(planned.runId, "work", { output: { value: "stale" } }, dispatchBefore)).rejects.toThrow(/stale/);
  });

  it("keeps generations monotonic across checkpoint revert and re-enumeration", async () => {
    const { engine, store } = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = {
      version: 1, contracts: { Result: resultContract, Batch: { items: "string[]" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [
          { id: "prep", do: "prep", out: "Batch" },
          { id: "fan", fanout: { over: "${prep.output.items}", concurrency: 2, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    await engine.commit(planned.runId, "before-fanout");
    await engine.stepDone(planned.runId, "prep", { output: { items: ["a", "b"] } }, tokenOf(planned));
    await waitFor(engine, planned.runId, (audit) => audit.status === "completed");
    const before = await store.load(planned.runId);
    expect(before.steps.fan?.fanout?.items.map((item) => item.generation)).toEqual([1, 2]);
    expect(before.generationCounter).toBe(2);

    const reverted = await engine.revert(planned.runId, "before-fanout");
    expect((await store.load(planned.runId)).generationCounter).toBe(2);
    await engine.stepDone(planned.runId, "prep", { output: { items: ["a", "b"] } }, tokenOf(reverted));
    await waitFor(engine, planned.runId, (audit) => audit.status === "completed");
    const after = await store.load(planned.runId);
    expect(after.steps.fan?.fanout?.items.map((item) => item.generation)).toEqual([3, 4]);
    expect(after.generationCounter).toBe(4);
  });

  it("advances generations again after gate revise re-enumerates a fanout", async () => {
    const { engine, store } = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = {
      version: 1, contracts: { Result: resultContract, Batch: { items: "string[]" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${fan.output[0]}", contract: "Result" }, max_rounds: 1,
        steps: [
          { id: "prep", do: "prep", out: "Batch" },
          { id: "fan", fanout: { over: "${prep.output.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
          { id: "review", after: ["fan"], gate: { on_approve: null, on_revise: "prep", on_kill: null } },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    await engine.stepDone(planned.runId, "prep", { output: { items: ["a"] } }, tokenOf(planned));
    await waitFor(engine, planned.runId, (audit) => audit.steps.review?.status === "waiting_gate");
    const before = await store.load(planned.runId);
    const gate = before.steps.review?.gateToken;
    expect(before.steps.fan?.fanout?.items[0]?.generation).toBe(1);
    const revised = await engine.gateResolve(planned.runId, "review", "revise", gate!);
    await engine.stepDone(planned.runId, "prep", { output: { items: ["b"] } }, tokenOf(revised));
    await waitFor(engine, planned.runId, (audit) => audit.steps.review?.status === "waiting_gate");
    const after = await store.load(planned.runId);
    expect(after.steps.fan?.fanout?.items[0]?.generation).toBe(2);
    expect(after.generationCounter).toBe(2);
  });

  it("never accepts or re-exposes an outstanding issuance after durable cancellation", async () => {
    const first = await subject();
    const planned = await first.engine.plan(taskFlow(), { name: "Ada" });
    const token = tokenOf(planned);
    const state = await first.store.load(planned.runId);
    state.cancelRequested = true;
    await first.store.save(state);
    const restarted = await subject(undefined, first.root);
    await expect(restarted.engine.stepDone(planned.runId, "work", { output: { value: "late" } }, token)).rejects.toThrow(/cancelled/);
    expect(await restarted.engine.resume(planned.runId)).toMatchObject({ status: "running" });
    expect((await restarted.engine.audit(planned.runId)).steps.work?.acceptedDispatchToken).toBeUndefined();
  });

  it("persists a canonical revisionDigest that is stable on resume and independent of object key insertion order", async () => {
    const one = await subject();
    const spec = taskFlow();
    const reordered = {
      flows: { main: { steps: spec.flows.main.steps, output: spec.flows.main.output, input: spec.flows.main.input }, entry: "main" },
      contracts: spec.contracts,
      version: 1,
    };
    const plannedOne = await one.engine.plan(spec, { name: "Ada" });
    const digest = (await one.store.load(plannedOne.runId)).revisionDigest;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await one.engine.resume(plannedOne.runId);
    expect((await one.store.load(plannedOne.runId)).revisionDigest).toBe(digest);

    const two = await subject();
    const plannedTwo = await two.engine.plan(reordered, { name: "Ada" });
    expect((await two.store.load(plannedTwo.runId)).revisionDigest).toBe(digest);

    const tampered = await two.store.load(plannedTwo.runId);
    tampered.revisionDigest = "0".repeat(64);
    await two.store.save(tampered);
    const restarted = await subject(undefined, two.root);
    await expect(restarted.engine.resume(plannedTwo.runId)).rejects.toThrow(/revision digest/);
  });

  it("backfills issuance tokens when resuming a run persisted before token fencing", async () => {
    const first = await subject();
    const planned = await first.engine.plan(taskFlow(), { name: "Ada" });
    const stripped = await first.store.load(planned.runId);
    delete stripped.steps.work!.dispatchToken;
    delete stripped.revisionDigest;
    delete stripped.generationCounter;
    await first.store.save(stripped);

    const restarted = await subject(undefined, first.root);
    const resumed = await restarted.engine.resume(planned.runId);
    const token = tokenOf(resumed);
    expect((await restarted.store.load(planned.runId)).steps.work?.dispatchToken).toBe(token);

    const gateful = await subject();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "work", do: "work", out: "Result" },
          { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } },
    };
    const gatePlanned = await gateful.engine.plan(spec, { name: "Ada" });
    await gateful.engine.stepDone(gatePlanned.runId, "work", { output: { value: "one" } }, tokenOf(gatePlanned));
    const persisted = await gateful.store.load(gatePlanned.runId);
    delete persisted.steps.review!.gateToken;
    await gateful.store.save(persisted);
    const gateRestarted = await subject(undefined, gateful.root);
    await gateRestarted.engine.resume(gatePlanned.runId);
    const minted = (await gateRestarted.store.load(gatePlanned.runId)).steps.review?.gateToken;
    expect(minted).toEqual(expect.any(String));
    expect(await gateRestarted.engine.gateResolve(gatePlanned.runId, "review", "approve", minted!)).toMatchObject({ status: "ready" });
  });

  it("releases the lifecycle guard via the validated dependency successor, not array adjacency", async () => {
    const { engine } = await subject();
    const guard = (engine as unknown as { assertNoForegroundFanout(run: PersistedRun, operation: "commit" | "revert"): void }).assertNoForegroundFanout;
    const consumerFanout = {
      over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "worktree",
      require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }],
    };
    const stepState = (status: StepState["status"]): StepState => ({ status, attempts: [], spent: {} } as StepState);
    const fanState = (): StepState => ({
      status: "succeeded", attempts: [], spent: {},
      fanout: { items: [{ index: 0, status: "succeeded", attempts: [], generation: 1 }] },
    } as StepState);

    // Real merge gate depends on the fanout but is NOT at index+1: guard must
    // still release once IT succeeds.
    const intervening: PersistedRun = {
      id: "guard-intervening", generationCounter: 1, input: { items: ["a"] }, flowName: "main",
      status: "running", flowSpent: {}, events: [],
      spec: { version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: consumerFanout },
          { id: "side", do: "side", out: "Result" },
          { id: "merge", after: ["fan"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } } },
      steps: { fan: fanState(), side: stepState("succeeded"), merge: stepState("succeeded"), finish: stepState("pending") },
    };
    expect(() => guard.call(engine, intervening, "commit")).not.toThrow();
    intervening.steps.merge = stepState("waiting_gate");
    expect(() => guard.call(engine, intervening, "commit")).toThrow(/fanout lifecycle/);

    // A succeeded gate that does NOT depend on the fanout sits at index+1:
    // it must NOT release the guard while the real merge gate still waits.
    const decoy: PersistedRun = {
      id: "guard-decoy", generationCounter: 1, input: { items: ["a"] }, flowName: "main",
      status: "running", flowSpent: {}, events: [],
      spec: { version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: consumerFanout },
          { id: "decoy", gate: { on_approve: null, on_revise: null, on_kill: null } },
          { id: "merge", after: ["fan"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } } },
      steps: { fan: fanState(), decoy: stepState("succeeded"), merge: stepState("waiting_gate"), finish: stepState("pending") },
    };
    expect(() => guard.call(engine, decoy, "revert")).toThrow(/fanout lifecycle/);
    decoy.steps.merge = stepState("succeeded");
    expect(() => guard.call(engine, decoy, "revert")).not.toThrow();
  });

  it("audit exposes durable state, not the in-memory run pinned by an active fanout", async () => {
    let releaseConnector: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { releaseConnector = resolve; });
    const connector: EngineConnector = async ({ prompt }) => { await blocked; return { output: { value: prompt } }; };
    const { engine, store } = await subject(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      } },
    };
    // plan returns while the fanout worker is blocked on the connector, so the
    // run object stays pinned in memory (loadRun returns the live instance).
    const planned = await engine.plan(spec, { items: ["a"] });

    // Diverge disk from the pinned object: only the durable copy carries the
    // marker. audit must surface durable state — a token that exists only in
    // memory has not met "persist before expose".
    const durable = await store.load(planned.runId);
    durable.steps.fan!.acceptedDispatchToken = "durable-marker";
    await store.save(durable);
    const during = await engine.audit(planned.runId);
    expect(during.steps.fan?.acceptedDispatchToken).toBe("durable-marker");

    releaseConnector();
    await waitFor(engine, planned.runId, (audit) => audit.status === "completed");
  });

  it("guards commit and revert through a consumer worktree successor gate but releases at the specified boundaries", async () => {
    const { engine } = await subject();
    const spec = (isolation: "none" | "worktree") => ({
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation, require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
          { id: "merge", after: ["fan"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } },
    });
    const constructed = (isolation: "none" | "worktree"): PersistedRun => ({
      id: `guard-${isolation}`, spec: spec(isolation), revisionDigest: "digest", generationCounter: 1,
      input: { items: ["a"] }, flowName: "main", status: "running", flowSpent: {}, events: [],
      steps: {
        fan: { status: "succeeded", attempts: [], spent: {}, fanout: { items: [{ index: 0, status: "succeeded", attempts: [], generation: 1 }] } },
        merge: { status: "waiting_gate", attempts: [], spent: {}, gateToken: "gate" },
        finish: { status: "pending", attempts: [], spent: {} },
      },
    });
    const guard = (engine as unknown as { assertNoForegroundFanout(run: PersistedRun, operation: "commit" | "revert"): void }).assertNoForegroundFanout;

    const worktree = constructed("worktree");
    expect(() => guard.call(engine, worktree, "commit")).toThrow(/fanout lifecycle/);
    expect(() => guard.call(engine, worktree, "revert")).toThrow(/fanout lifecycle/);
    worktree.steps.merge!.status = "succeeded";
    expect(() => guard.call(engine, worktree, "commit")).not.toThrow();

    const unisolated = constructed("none");
    expect(() => guard.call(engine, unisolated, "commit")).not.toThrow();
    unisolated.steps.fan!.status = "running";
    expect(() => guard.call(engine, unisolated, "revert")).toThrow(/in-flight fanout/);
    unisolated.status = "completed";
    expect(() => guard.call(engine, unisolated, "revert")).not.toThrow();
  });
});
