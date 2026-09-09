import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, SpecValidationError, type EngineConnector, type EngineResponse } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { StateStore, type AuditEvent } from "../../src/engine/state.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(extra: Record<string, unknown> = {}, root?: string): Promise<{ engine: TokenEchoingEngine; raw: StratumEngine; store: StateStore; root: string }> {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-carry-"));
  if (!root) roots.push(stateRoot);
  const raw = new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...extra } as ConstructorParameters<typeof StratumEngine>[0]);
  return { engine: tokenEchoingEngine(raw), raw, store: new StateStore(stateRoot), root: stateRoot };
}

/** plan() throws SpecValidationError with a useless message; surface the codes. */
async function planned(engine: StratumEngine, spec: unknown, input: unknown): Promise<EngineResponse & { runId: string }> {
  return engine.plan(spec, input).catch((error: unknown) => {
    if (error instanceof SpecValidationError) throw new Error(JSON.stringify(error.errors));
    throw error;
  });
}

async function waitFor(engine: StratumEngine, runId: string, predicate: (run: Awaited<ReturnType<StratumEngine["audit"]>>) => boolean) {
  for (let tick = 0; tick < 400; tick += 1) {
    const run = await engine.audit(runId);
    if (predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run did not reach expected state: ${JSON.stringify((await engine.audit(runId)).steps)}`);
}

const contracts = {
  TaskGraph: { tasks: "string[]", extra: "string[]?" },
  Result: { value: "string" },
  WaveDecision: { action: "string", tasks: "string[]" },
};

/** The COMP-FABLE-ASTRA loop in miniature: plan seeds the wave, the consumer fanout
 *  reads it, the merge gate re-fans it and the assess gate rewrites it. */
const astraFlow = {
  version: 1,
  contracts,
  flows: { entry: "main", main: {
    input: { goal: "string" },
    output: { from: "${assess.output}", contract: "WaveDecision" },
    max_rounds: 4,
    carry: { wave: { initial: "${plan.output.tasks}", on_revise: { assess_gate: "${assess.output.tasks}" } } },
    steps: [
      { id: "plan", do: "plan ${input.goal}", out: "TaskGraph" },
      { id: "execute", after: ["plan"], fanout: {
        over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
        require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
      } },
      { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
      // `after` is load-bearing: CARRY_REVISE_GATE_NOT_AFTER_CONSUMER is dependency-only
      // (R1-4), and the on_approve routing edge does not count as ordering.
      { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
      { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
      { id: "assess_gate", after: ["assess"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
    ],
  } },
};

/** Settle every ready consumer item of `execute` and return the response that follows. */
async function settleWave(engine: TokenEchoingEngine, runId: string, response: EngineResponse): Promise<EngineResponse> {
  let current = response;
  while (current.status === "ready" && current.ready.some((entry) => entry.id.startsWith("execute/"))) {
    const next = current.ready.find((entry) => entry.id.startsWith("execute/"))!;
    current = await engine.stepDone(runId, next.id, { output: { value: `done ${next.id}` } }, next.dispatchToken);
  }
  return current;
}

const carryEvents = (events: AuditEvent[]) => events.filter((event) => event.type === "carry_updated");

describe("STRAT-LOOP-CARRY S03 runtime", () => {
  it("T-S03-1 materialises the initial value when its source succeeds", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    const run = await store.load(start.runId);
    expect(run.carry?.wave).toMatchObject({
      value: ["t1", "t2"],
      provenance: { kind: "initial", sourceStep: "plan", sourceEpoch: 0, at: expect.any(String) },
    });
    expect(carryEvents(run.events)).toHaveLength(1);
    expect(carryEvents(run.events)[0]!).toMatchObject({ stepId: "plan", detail: { name: "wave", reason: "initial" } });
  });

  it("T-S03-5a a dispatched do-sourced initial is visible in the same advance", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    if (afterPlan.status !== "ready") throw new Error(`expected consumer descriptors, got ${JSON.stringify(afterPlan)}`);
    expect(afterPlan.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    // A burned attempt is what an unmaterialised carry looks like from here.
    expect((await store.load(start.runId)).steps.execute?.attempts ?? []).toHaveLength(0);
  });

  it("T-S03-2 re-fans over the same list when a gate declares nothing", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const revised = await engine.gateResolve(start.runId, "execute_merge", "revise");
    if (revised.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revised)}`);
    expect(revised.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    const run = await store.load(start.runId);
    expect(run.carry?.wave?.value).toEqual(["t1", "t2"]);
    expect(run.carry?.wave?.provenance.kind).toBe("initial");
    expect(run.rounds).toBe(1);
    expect(carryEvents(run.events)).toHaveLength(1);
  });

  it("T-S03-3/4/12 rewrites the list at a declaring gate, keeps it across later advances, and adds no reset edge", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });
    await engine.stepDone(start.runId, "assess", { output: { action: "repair", tasks: ["t3"] } });
    await waitFor(engine, start.runId, (run) => run.steps.assess_gate?.status === "waiting_gate");
    const gateToken = (await store.load(start.runId)).steps.assess_gate?.gateToken;
    const revised = await engine.gateResolve(start.runId, "assess_gate", "revise", gateToken!);
    if (revised.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revised)}`);

    const run = await store.load(start.runId);
    expect(run.carry?.wave).toMatchObject({
      value: ["t3"],
      provenance: { kind: "revise", sourceStep: "plan", sourceEpoch: 0, gate: "assess_gate", gateToken, round: 1 },
    });
    expect(revised.ready.map((entry) => entry.id)).toEqual(["execute/0"]);
    // T-S03-12: `${wave}` created no dependency edge, so `plan` is outside the closure.
    const reset = run.events.filter((event) => event.type === "step_reset").at(-1)!.detail as { reset: Array<{ stepId: string }> };
    expect(reset.reset.map((entry) => entry.stepId).sort()).toEqual(["assess", "assess_gate", "execute", "execute_merge", "verify"]);
    // T-S03-4: the epoch guard holds the revise write across further advances.
    await settleWave(engine, start.runId, revised);
    await waitFor(engine, start.runId, (audit) => audit.steps.execute_merge?.status === "waiting_gate");
    const later = await store.load(start.runId);
    expect(later.carry?.wave?.value).toEqual(["t3"]);
    expect(later.carry?.wave?.provenance.kind).toBe("revise");
  });
  it("T-S03-5b an input-sourced initial is visible on the first advance", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { tasks: "string[]" }, output: { from: "${execute.output[0]}", contract: "Result" },
        carry: { wave: { initial: "${input.tasks}" } },
        steps: [{ id: "execute", fanout: {
          over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
          require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
        } }],
      } },
    };
    // The strictest scope-aliasing case: the scope is built by advance's default
    // parameter before run.carry exists (R2-1).
    const start = await planned(engine, spec, { tasks: ["a", "b"] });
    if (start.status !== "ready") throw new Error(`expected consumer descriptors, got ${JSON.stringify(start)}`);
    expect(start.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    const run = await store.load(start.runId);
    expect(run.steps.execute?.attempts ?? []).toHaveLength(0);
    expect(run.carry?.wave).toMatchObject({ value: ["a", "b"], provenance: { kind: "initial", at: expect.any(String) } });
    // R1-7: an input-sourced write is attributed to no step at all.
    expect(run.carry?.wave?.provenance.sourceStep).toBeUndefined();
    expect(carryEvents(run.events)[0]!.stepId).toBeUndefined();
  });

  it("T-S03-5 a set-sourced initial is visible to the very next step in the same pass", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts: { TaskGraph: { tasks: "string[]" }, Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { tasks: "string[]" }, output: { from: "${execute.output[0]}", contract: "Result" },
        carry: { wave: { initial: "${seed.output.tasks}" } },
        steps: [
          { id: "seed", set: { tasks: "input.tasks" }, out: "TaskGraph" },
          { id: "execute", after: ["seed"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
        ],
      } },
    };
    // `set` settles INSIDE advanceScopeLoop and the fanout activates in the same pass.
    // Without the post-set call site the fanout resolves nothing and BURNS AN ATTEMPT
    // before a later advance rescues it, so the attempt list is the assertion (R1-2).
    const start = await planned(engine, spec, { tasks: ["a", "b"] });
    if (start.status !== "ready") throw new Error(`expected consumer descriptors, got ${JSON.stringify(start)}`);
    expect(start.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    expect((await store.load(start.runId)).steps.execute?.attempts ?? []).toHaveLength(0);
  });

  it("T-S03-6 an evaluate-sourced initial is visible to the very next step in the same pass", async () => {
    const { engine, store } = await subject({
      evaluateRunner: async () => ({ ok: true, result: { status: "open", children: ["a", "b"], reason: "two left" } }),
    });
    const spec = {
      version: 1,
      contracts: { Eval: { status: "string", children: "string[]", reason: "string" }, Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        carry: { wave: { initial: "${probe.output.children}" } },
        steps: [
          { id: "probe", evaluate: { command: "probe", timeout_ms: 5000 }, out: "Eval" },
          { id: "execute", after: ["probe"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    if (start.status !== "ready") throw new Error(`expected consumer descriptors, got ${JSON.stringify(start)}`);
    expect(start.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    // As in T-S03-5, a missing post-evaluate call site shows up as a burned attempt.
    expect((await store.load(start.runId)).steps.execute?.attempts ?? []).toHaveLength(0);
  });

  it("T-S03-8 fails the run when an initial resolves to nothing, with no partial write", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        carry: {
          wave: { initial: "${plan.output.tasks}" },
          // Declared optional in the contract, absent at runtime: valid statically,
          // unresolvable at materialisation time (R1-3).
          ghost: { initial: "${plan.output.extra}" },
        },
        steps: [
          { id: "plan", do: "plan", out: "TaskGraph" },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const failed = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    expect(failed.status).toBe("failed");
    for (const run of [await store.load(start.runId), await engine.audit(start.runId)]) {
      // Staging is the only thing preventing the first write, so check both halves.
      expect(carryEvents(run.events)).toHaveLength(0);
      if ("carry" in run) expect(run.carry ?? {}).toEqual({});
    }
    const durable = await store.load(start.runId);
    expect(durable.status).toBe("failed");
    expect(durable.failure?.reason).toMatch(/carry_initial_unresolved/);
  });

  it("T-S03-8b no inherited name can be spelled as a carry variable", async () => {
    const { engine } = await subject();
    const withName = (name: string) => ({
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${plan.output}", contract: "TaskGraph" },
        carry: { [name]: { initial: "${plan.output.tasks}" } },
        steps: [{ id: "plan", do: "plan", out: "TaskGraph" }],
      } },
    });
    // R2-3 asks for a carry literally named `toString` or `constructor` driven end to
    // end. Neither is spellable after R3-2: `toString` fails STEP_ID_PATTERN (uppercase)
    // and `constructor` is a RESERVED_FIELD_NAME. The prototype hazard is therefore closed
    // at the schema, and `Object.hasOwn` in resolve/materialiseCarry is defence in depth.
    await expect(planned(engine, withName("toString"), { goal: "g" })).rejects.toThrow(/invalid step id/);
    await expect(planned(engine, withName("constructor"), { goal: "g" })).rejects.toThrow(/E2_RESERVED_FIELD/);
  });

  it("T-S03-8c an inherited name is not a gate declaration", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        max_rounds: 2,
        // An empty on_revise beside a gate step literally named `constructor`: reading it
        // with `onRevise[gateId]` would hand back Object.prototype.constructor, and
        // carryReference would then throw on a function (R2-3, R3-3). `constructor` is the
        // only inherited member a legal step id can spell.
        carry: { wave: { initial: "${plan.output.tasks}", on_revise: {} } },
        steps: [
          { id: "plan", do: "plan", out: "TaskGraph" },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
          { id: "constructor", after: ["execute"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps["constructor"]?.status === "waiting_gate");
    const before = JSON.stringify((await store.load(start.runId)).carry);
    await engine.gateResolve(start.runId, "constructor", "revise");
    const after = await store.load(start.runId);
    expect(JSON.stringify(after.carry)).toBe(before);
    expect(carryEvents(after.events)).toHaveLength(1);
  });

  it("T-S03-9 names the missing variable when a carry is unmaterialised at resolve time", async () => {
    const { engine, raw, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    const run = await store.load(start.runId);
    // Hand-built: the source no longer supplies a value and the entry is gone, so the
    // fanout activates with nothing materialised.
    delete run.carry;
    run.steps.plan!.status = "skipped";
    delete run.steps.plan!.output;
    run.steps.execute = { status: "pending", attempts: [], spent: {}, epoch: 0 };
    await store.save(run);
    await raw.resume(start.runId);
    const failed = await store.load(start.runId);
    expect(failed.failure?.reason).toMatch(/carry variable "wave" is not materialised/);
    expect(failed.steps.execute?.failure?.reason).toMatch(/carry variable "wave" is not materialised/);
  });

  it("T-S03-10 carry survives a fresh engine over the same state root", async () => {
    const first = await subject();
    const start = await planned(first.engine, astraFlow, { goal: "g" });
    const afterPlan = await first.engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    await settleWave(first.engine, start.runId, afterPlan);
    await waitFor(first.engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");

    const second = await subject({}, first.root);
    const revised = await second.engine.gateResolve(start.runId, "execute_merge", "revise");
    if (revised.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revised)}`);
    expect(revised.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    expect((await second.store.load(start.runId)).carry?.wave?.value).toEqual(["t1", "t2"]);
  });

  it("T-S03-11 checkpoint revert restores the older carry beside the older outputs", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });
    await engine.stepDone(start.runId, "assess", { output: { action: "repair", tasks: ["t3"] } });
    await waitFor(engine, start.runId, (run) => run.steps.assess_gate?.status === "waiting_gate");
    await engine.commit(start.runId, "wave1");

    const revised = await engine.gateResolve(start.runId, "assess_gate", "revise");
    expect((await store.load(start.runId)).carry?.wave?.value).toEqual(["t3"]);
    // revert refuses while a fanout is in flight, so settle the new wave first.
    await settleWave(engine, start.runId, revised);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");

    await engine.revert(start.runId, "wave1");
    const reverted = await store.load(start.runId);
    // Both halves move together, or the carry desyncs from the outputs it derives from.
    expect(reverted.carry?.wave).toMatchObject({ value: ["t1", "t2"], provenance: { kind: "initial" } });
    expect(reverted.steps.assess?.output).toEqual({ action: "repair", tasks: ["t3"] });
  });
  it("T-S03-7 refuses a revise whose declared expression has no value, without consuming the gate", async () => {
    // `hold` is an ENGINE-dispatched fanout: while it runs, the engine pins the run in
    // activeRuns, so loadRun hands back the live object and a mutation made before a
    // throw would survive. That pin is what makes the retry below a real proof.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const connector: EngineConnector = async ({ prompt }) => { await held; return { output: { value: prompt } }; };
    const { engine, store } = await subject({ connector });
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        max_rounds: 1,
        carry: { wave: { initial: "${plan.output.tasks}", on_revise: { execute_merge: "${hold.output}" } } },
        steps: [
          { id: "plan", do: "plan", out: "TaskGraph" },
          { id: "hold", after: ["plan"], fanout: {
            over: "${plan.output.tasks}", concurrency: 1, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "hold ${item}", out: "Result" }],
          } },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do it", out: "Result" }],
          } },
          { id: "execute_merge", after: ["execute"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const gateToken = (await store.load(start.runId)).steps.execute_merge?.gateToken;
    expect(gateToken).toBeTypeOf("string");

    // `hold` has not produced an output yet, so the declared expression cannot resolve.
    await expect(engine.gateResolve(start.runId, "execute_merge", "revise", gateToken!))
      .rejects.toThrow(/carry_revise_unresolved/);

    release();
    await waitFor(engine, start.runId, (run) => run.steps.hold?.status === "succeeded");
    // The SAME token, replayed. `delete state.gateToken` (the first mutation of the old
    // ordering) is what would have made it stale, so success proves the failed attempt
    // never reached it. max_rounds is 1, so a double-counted round exhausts the budget.
    const revised = await engine.gateResolve(start.runId, "execute_merge", "revise", gateToken!);
    expect(revised.status).toBe("ready");

    const run = await store.load(start.runId);
    expect(run.rounds).toBe(1);
    // An appended event is invisible to the retry, so it needs its own count.
    expect(run.events.filter((event) => event.type === "gate_resolved")).toHaveLength(1);
    const revise = carryEvents(run.events).filter((event) => (event.detail as { reason: string }).reason === "revise");
    expect(revise).toHaveLength(1);
    expect(run.carry?.wave?.provenance).toMatchObject({ kind: "revise", gate: "execute_merge", gateToken, round: 1 });
  });
});
