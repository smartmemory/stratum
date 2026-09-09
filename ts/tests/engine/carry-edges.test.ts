import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, SpecValidationError, type EngineResponse } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { StateStore, type AuditEvent } from "../../src/engine/state.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

// STRAT-LOOP-CARRY coverage sweep — edge cases not exercised by tests/engine/carry.test.ts.
// Helpers below are copied from that file rather than imported, per the review-isolation
// instruction not to edit it.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(extra: Record<string, unknown> = {}): Promise<{ engine: TokenEchoingEngine; raw: StratumEngine; store: StateStore; root: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), "stratum-carry-edges-"));
  roots.push(stateRoot);
  const raw = new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...extra } as ConstructorParameters<typeof StratumEngine>[0]);
  return { engine: tokenEchoingEngine(raw), raw, store: new StateStore(stateRoot), root: stateRoot };
}

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

const contracts = {
  TaskGraph: { tasks: "string[]", extra: "string[]?" },
  Result: { value: "string" },
  WaveDecision: { action: "string", tasks: "string[]" },
};

/** The COMP-FABLE-ASTRA loop in miniature, copied from carry.test.ts's astraFlow. */
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
      { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
      { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
      { id: "assess_gate", after: ["assess"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
    ],
  } },
};

describe("STRAT-LOOP-CARRY edge cases", () => {
  it("does not re-materialise an input-sourced carry across later advances", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { tasks: "string[]" }, output: { from: "${verify.output}", contract: "Result" },
        max_rounds: 2,
        carry: { wave: { initial: "${input.tasks}" } },
        steps: [
          { id: "execute", fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
          { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
          { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
        ],
      } },
    };
    const start = await planned(engine, spec, { tasks: ["a", "b"] });
    const settled = await settleWave(engine, start.runId, start);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const before = (await store.load(start.runId)).carry?.wave;
    expect(before).toMatchObject({ value: ["a", "b"], provenance: { kind: "initial" } });
    void settled;

    // A gate decision re-enters `advance` — the exact re-entry point that would
    // re-run materialisation. An input-sourced entry has no source step/epoch to
    // compare, so the "write once" branch (`existing !== undefined ? continue`) is
    // what must hold here.
    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });

    const after = await store.load(start.runId);
    expect(after.carry?.wave).toEqual(before);
    expect(carryEvents(after.events)).toHaveLength(1);
  });

  it("fans out over an empty carried list and re-fans once a revise makes it non-empty", async () => {
    const { engine, store } = await subject();
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: [] } });
    // Zero fanout items: nothing to settle through settleWave, so the run must reach
    // the merge gate on its own.
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    void afterPlan;
    const empty = await store.load(start.runId);
    expect(empty.carry?.wave?.value).toEqual([]);
    expect(empty.steps.execute?.status).toBe("succeeded");
    expect(empty.steps.execute?.fanout?.items).toEqual([]);
    expect(empty.steps.execute?.output).toEqual([]);
    // One clean aggregate-settle attempt with an empty result — not a burned attempt.
    expect(empty.steps.execute?.attempts).toHaveLength(1);
    expect(empty.steps.execute?.attempts?.[0]).toMatchObject({ result: [] });

    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });
    await engine.stepDone(start.runId, "assess", { output: { action: "repair", tasks: ["t1", "t2"] } });
    await waitFor(engine, start.runId, (run) => run.steps.assess_gate?.status === "waiting_gate");
    const gateToken = (await store.load(start.runId)).steps.assess_gate?.gateToken;
    const revised = await engine.gateResolve(start.runId, "assess_gate", "revise", gateToken!);
    if (revised.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revised)}`);
    expect(revised.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    expect((await store.load(start.runId)).carry?.wave?.value).toEqual(["t1", "t2"]);
  });

  it("a gate that revises one carry variable leaves a sibling variable untouched", async () => {
    const { engine, store } = await subject();
    const twoVarContracts = {
      TaskGraph: { tasks: "string[]", note: "string" },
      Result: { value: "string" },
      WaveDecision: { action: "string", tasks: "string[]" },
    };
    const spec = {
      version: 1, contracts: twoVarContracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${assess.output}", contract: "WaveDecision" },
        max_rounds: 4,
        carry: {
          wave: { initial: "${plan.output.tasks}", on_revise: { assess_gate: "${assess.output.tasks}" } },
          // No on_revise entry for assess_gate at all: a gate resolving a variable it
          // does not declare must leave this one byte-identical.
          note: { initial: "${plan.output.note}" },
        },
        steps: [
          { id: "plan", do: "plan ${input.goal}", out: "TaskGraph" },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
          { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
          { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
          { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
          { id: "assess_gate", after: ["assess"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"], note: "n1" } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });
    await engine.stepDone(start.runId, "assess", { output: { action: "repair", tasks: ["t3"] } });
    await waitFor(engine, start.runId, (run) => run.steps.assess_gate?.status === "waiting_gate");
    const before = (await store.load(start.runId)).carry?.note;
    const gateToken = (await store.load(start.runId)).steps.assess_gate?.gateToken;
    await engine.gateResolve(start.runId, "assess_gate", "revise", gateToken!);

    const after = await store.load(start.runId);
    expect(after.carry?.wave?.value).toEqual(["t3"]);
    expect(after.carry?.wave?.provenance.kind).toBe("revise");
    expect(after.carry?.note).toEqual(before);
    expect(after.carry?.note?.provenance.kind).toBe("initial");
    const notes = carryEvents(after.events).filter((event) => (event.detail as { name: string }).name === "note");
    expect(notes).toHaveLength(1); // only the original initial write, nothing from the revise round
  });

  it("round exhaustion at a revising gate fails the run without writing carry", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        max_rounds: 1,
        carry: { wave: { initial: "${plan.output.tasks}", on_revise: { execute_merge: "${plan.output.tasks}" } } },
        steps: [
          { id: "plan", do: "plan", out: "TaskGraph" },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
          { id: "execute_merge", after: ["execute"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const token1 = (await store.load(start.runId)).steps.execute_merge?.gateToken;
    const round1 = await engine.gateResolve(start.runId, "execute_merge", "revise", token1!);
    if (round1.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(round1)}`);
    await settleWave(engine, start.runId, round1);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const carryAfterRound1 = (await store.load(start.runId)).carry?.wave;
    expect(carryAfterRound1?.provenance).toMatchObject({ kind: "revise", round: 1 });
    const eventsAfterRound1 = carryEvents((await store.load(start.runId)).events).length;

    const token2 = (await store.load(start.runId)).steps.execute_merge?.gateToken;
    await engine.gateResolve(start.runId, "execute_merge", "revise", token2!);

    const after = await store.load(start.runId);
    expect(after.status).toBe("failed");
    expect(after.failure?.reason).toMatch(/gate revision rounds exhausted/);
    // The preflight round-limit check returns before resolveCarryOnRevise ever runs
    // (blueprint S03-7), so carry must be exactly what round 1 left it.
    expect(after.carry?.wave).toEqual(carryAfterRound1);
    expect(carryEvents(after.events)).toHaveLength(eventsAfterRound1);
  });

  it("a kill decision on a gate that declares on_revise writes nothing", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1, contracts, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${execute.output[0]}", contract: "Result" },
        max_rounds: 2,
        carry: { wave: { initial: "${plan.output.tasks}", on_revise: { execute_merge: "${plan.output.tasks}" } } },
        steps: [
          { id: "plan", do: "plan", out: "TaskGraph" },
          { id: "execute", after: ["plan"], fanout: {
            over: "${wave}", dispatch: "consumer", concurrency: 2, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
          } },
          { id: "execute_merge", after: ["execute"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1"] } });
    await settleWave(engine, start.runId, afterPlan);
    await waitFor(engine, start.runId, (run) => run.steps.execute_merge?.status === "waiting_gate");
    const before = (await store.load(start.runId)).carry?.wave;
    const token = (await store.load(start.runId)).steps.execute_merge?.gateToken;

    await engine.gateResolve(start.runId, "execute_merge", "kill", token!);

    const after = await store.load(start.runId);
    expect(after.status).toBe("failed");
    expect(after.failure?.reason).toMatch(/killed flow/);
    expect(after.carry?.wave).toEqual(before);
    expect(carryEvents(after.events)).toHaveLength(1); // only the original initial write
  });

  it("a carry path that does not exist at runtime fails the attempt with a named error, not a crash", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Wrap: { meta: "Meta" }, Meta: { flag: "boolean" }, Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${peek.output}", contract: "Result" },
        carry: { info: { initial: "${plan.output.meta}" } },
        steps: [
          { id: "plan", do: "plan", out: "Wrap" },
          // ${info.missingField}: `info` materialises fine (an object), but the path
          // segment does not exist on it. access() returns undefined for a missing
          // field and render() converts that into a named, catchable error.
          { id: "peek", after: ["plan"], do: "peek ${info.missingField}", out: "Result" },
        ],
      } },
    };
    const start = await planned(engine, spec, { goal: "g" });
    const result = await engine.stepDone(start.runId, "plan", { output: { meta: { flag: true } } });
    void result;

    const run = await store.load(start.runId);
    // Two attempts (the default max), each a named failAttempt, never an unhandled throw.
    expect(run.steps.peek?.status).toBe("failed");
    expect(run.steps.peek?.failure?.reason).toMatch(/reference output is unavailable/);
    expect(run.status).toBe("failed");
    expect(run.failure?.reason).toMatch(/reference output is unavailable/);
    expect(run.carry?.info).toMatchObject({ value: { flag: true }, provenance: { kind: "initial" } });
  });
});
