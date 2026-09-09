import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine, SpecValidationError, type EngineResponse } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

// §7 of the STRAT-LOOP-CARRY blueprint: the COMP-FABLE-ASTRA loop in miniature, run
// end-to-end against the real engine over a temp state root. This is the single test
// that would catch a regression spanning any of the four slices (IR grammar, engine
// state, engine runtime, surfaces) rather than one slice in isolation.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(extra: Record<string, unknown> = {}, root?: string): Promise<{ engine: TokenEchoingEngine; raw: StratumEngine; store: StateStore; root: string }> {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-carry-golden-"));
  if (!root) roots.push(stateRoot);
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

const contracts = {
  TaskGraph: { tasks: "string[]" },
  Result: { value: "string" },
  WaveDecision: { action: "string", tasks: "string[]" },
};

/** The COMP-FABLE-ASTRA loop in miniature (blueprint §7.1, verbatim). */
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
      // `after` is load-bearing: CARRY_REVISE_GATE_NOT_AFTER_CONSUMER is dependency-only,
      // and the on_approve routing edge does not count as ordering.
      { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
      { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
      { id: "assess_gate", after: ["assess"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
    ],
  } },
};

/** Settle every ready consumer item of `execute` and return the response that follows,
 *  along with the ordered list of resolved `item` values the descriptors carried. */
async function settleWave(
  engine: TokenEchoingEngine, runId: string, response: EngineResponse,
): Promise<{ response: EngineResponse; items: unknown[] }> {
  let current = response;
  const items: unknown[] = [];
  while (current.status === "ready" && current.ready.some((entry) => entry.id.startsWith("execute/"))) {
    const next = current.ready.find((entry) => entry.id.startsWith("execute/"))!;
    items.push((next as unknown as { item: unknown }).item);
    current = await engine.stepDone(runId, next.id, { output: { value: `done ${next.id}` } }, next.dispatchToken);
  }
  return { response: current, items };
}

describe("STRAT-LOOP-CARRY golden flow (blueprint §7)", () => {
  it("carries a re-planned wave through a merge-gate retry, an assess-gate revise, a restart, and a checkpoint revert", async () => {
    const { engine, store, root } = await subject();

    // 1. Plan, and first materialisation.
    const start = await planned(engine, astraFlow, { goal: "g" });
    const afterPlan = await engine.stepDone(start.runId, "plan", { output: { tasks: ["t1", "t2"] } });
    const run1 = await store.load(start.runId);
    expect(run1.carry?.wave).toMatchObject({
      value: ["t1", "t2"],
      provenance: { kind: "initial", sourceStep: "plan", sourceEpoch: 0, at: expect.any(String) },
    });

    // 2. First fan-out materialises from carry: two descriptors, `item` equals the planned tasks
    //    in order. If materialiseCarry ran after advanceScopeLoop this assertion sees a burned
    //    attempt instead of two ready descriptors.
    if (afterPlan.status !== "ready") throw new Error(`expected consumer descriptors, got ${JSON.stringify(afterPlan)}`);
    expect(afterPlan.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    expect(afterPlan.ready.map((entry) => (entry as unknown as { item: unknown }).item)).toEqual(["t1", "t2"]);

    // 3. Merge-gate revise re-fans over the SAME list.
    const wave1 = await settleWave(engine, start.runId, afterPlan);
    expect(wave1.items).toEqual(["t1", "t2"]);
    await waitFor(engine, start.runId, (audit) => audit.steps.execute_merge?.status === "waiting_gate");
    const mergeGateToken = (await store.load(start.runId)).steps.execute_merge?.gateToken;
    const revisedMerge = await engine.gateResolve(start.runId, "execute_merge", "revise", mergeGateToken!);
    if (revisedMerge.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revisedMerge)}`);
    expect(revisedMerge.ready.map((entry) => entry.id)).toEqual(["execute/0", "execute/1"]);
    expect(revisedMerge.ready.map((entry) => (entry as unknown as { item: unknown }).item)).toEqual(["t1", "t2"]);
    const run2 = await store.load(start.runId);
    expect(run2.carry?.wave?.value).toEqual(["t1", "t2"]);
    expect(run2.carry?.wave?.provenance.kind).toBe("initial");
    expect(run2.rounds).toBe(1);

    // 4. Approve through to assess.
    const wave2 = await settleWave(engine, start.runId, revisedMerge);
    expect(wave2.items).toEqual(["t1", "t2"]);
    await waitFor(engine, start.runId, (audit) => audit.steps.execute_merge?.status === "waiting_gate");
    await engine.gateResolve(start.runId, "execute_merge", "approve");
    await engine.stepDone(start.runId, "verify", { output: { value: "v" } });
    await engine.stepDone(start.runId, "assess", { output: { action: "repair", tasks: ["t3"] } });
    await waitFor(engine, start.runId, (audit) => audit.steps.assess_gate?.status === "waiting_gate");

    // Checkpoint the pre-revise state (older carry + older assess output) before the rewrite.
    await engine.commit(start.runId, "wave1");

    // 5. Assess-gate revise rewrites the wave.
    // F3: the carry write and the reset must land in ONE durable snapshot. Asserting the
    // final state and the in-memory event order cannot see a crash window, so spy on the
    // real store and inspect every snapshot written during the revise: no snapshot may
    // carry the revised value without the reset that invalidates its readers.
    const preRevise = await store.load(start.runId);
    const assessGateToken = preRevise.steps.assess_gate?.gateToken;
    const resetsBefore = preRevise.events.filter((event) => event.type === "step_reset").length;
    const executeEpochBefore = preRevise.steps.execute?.epoch ?? 0;
    const snapshots: PersistedRun[] = [];
    const originalSave = StateStore.prototype.save;
    const saveSpy = vi.spyOn(StateStore.prototype, "save").mockImplementation(async function (this: StateStore, run: PersistedRun) {
      snapshots.push(structuredClone(run));
      return originalSave.call(this, run);
    });
    let revisedAssess: EngineResponse;
    try {
      revisedAssess = await engine.gateResolve(start.runId, "assess_gate", "revise", assessGateToken!);
    } finally {
      saveSpy.mockRestore();
    }

    const carryRevised = (snapshot: PersistedRun) => snapshot.carry?.wave?.provenance.kind === "revise";
    const resetLanded = (snapshot: PersistedRun) => snapshot.events.filter((event) => event.type === "step_reset").length > resetsBefore;
    expect(snapshots.length).toBeGreaterThan(0);
    // No carry-only intermediate snapshot: every durable state that shows the new wave also
    // shows the reset. A `persist` inserted between the two would break exactly this.
    expect(snapshots.filter(carryRevised).map(resetLanded)).not.toContain(false);
    const firstRevised = snapshots.find(carryRevised);
    expect(firstRevised).toBeDefined();
    expect(firstRevised!.carry?.wave?.value).toEqual(["t3"]);
    expect(firstRevised!.steps.execute?.epoch ?? 0).toBe(executeEpochBefore + 1);
    const firstResetDetail = firstRevised!.events.filter((event) => event.type === "step_reset").at(-1)!.detail as { reset: Array<{ stepId: string }> };
    expect(firstResetDetail.reset.map((entry) => entry.stepId).sort()).toEqual(["assess", "assess_gate", "execute", "execute_merge", "verify"]);
    if (revisedAssess.status !== "ready") throw new Error(`expected a re-fan, got ${JSON.stringify(revisedAssess)}`);
    const run3 = await store.load(start.runId);
    expect(run3.carry?.wave).toMatchObject({
      value: ["t3"],
      provenance: { kind: "revise", sourceStep: "plan", sourceEpoch: 0, gate: "assess_gate", gateToken: assessGateToken, round: 2 },
    });
    // `${wave}` created no dependency edge, so `plan` sits outside the reset closure.
    const resetEventIndex = run3.events.map((event) => event.type).lastIndexOf("step_reset");
    const resetEvent = run3.events[resetEventIndex]!;
    const resetDetail = resetEvent.detail as { reset: Array<{ stepId: string }> };
    expect(resetDetail.reset.map((entry) => entry.stepId).sort()).toEqual(["assess", "assess_gate", "execute", "execute_merge", "verify"]);
    const carryEventIndex = run3.events.map((event) => event.type).lastIndexOf("carry_updated");
    const carryEvent = run3.events[carryEventIndex]!;
    expect(carryEvent).toMatchObject({ stepId: "assess_gate", detail: { reason: "revise" } });
    const gateResolvedIndex = run3.events.findIndex((event) => event.type === "gate_resolved" && event.stepId === "assess_gate");
    expect(gateResolvedIndex).toBeGreaterThanOrEqual(0);
    expect(carryEventIndex).toBeGreaterThan(gateResolvedIndex);
    expect(resetEventIndex).toBeGreaterThan(carryEventIndex);

    // 6. Re-fan over the NEW list: exactly one descriptor, item equal to the new element.
    expect(revisedAssess.ready.map((entry) => entry.id)).toEqual(["execute/0"]);
    expect((revisedAssess.ready[0] as unknown as { item: unknown }).item).toBe("t3");

    // 7. Fresh engine over the same state root still sees carry.
    const second = await subject({}, root);
    const t3Token = (revisedAssess.ready[0] as unknown as { dispatchToken: string }).dispatchToken;
    await second.engine.stepDone(start.runId, "execute/0", { output: { value: "done t3" } }, t3Token);
    const afterRestart = await waitFor(second.engine, start.runId, (audit) => audit.steps.execute_merge?.status === "waiting_gate");
    expect(afterRestart.carry?.wave?.value).toEqual(["t3"]);

    // 8. Checkpoint revert restores the older carry alongside the older outputs.
    await second.engine.revert(start.runId, "wave1");
    const reverted = await second.store.load(start.runId);
    expect(reverted.carry?.wave).toMatchObject({ value: ["t1", "t2"], provenance: { kind: "initial" } });
    expect(reverted.steps.assess?.output).toEqual({ action: "repair", tasks: ["t3"] });

    // 9. Audit exposes carry with provenance.
    const audited = await second.raw.audit(start.runId);
    expect(audited.carry?.wave).toMatchObject({ value: ["t1", "t2"], provenance: { kind: "initial" } });
  });
});
