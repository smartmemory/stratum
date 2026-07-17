import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { SpecValidationError, StratumEngine, type BgStatus, type EngineConnector, type JudgeRunner } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(name: string): Promise<unknown> {
  const bytes = await readFile(new URL(`../../parity/${name}.v1.yaml`, import.meta.url));
  return parseDocument(bytes.toString("utf8"), { prettyErrors: false }).toJS();
}

async function subject(connector: EngineConnector, judge?: JudgeRunner): Promise<TokenEchoingEngine> {
  const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-"));
  roots.push(root);
  return tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector, ...(judge ? { judge } : {}) }));
}

// S3: token-fencing assertions must run against the RAW engine — never through the
// auto-echo adapter, which would forward an omitted token and mask a regression.
async function rawSubject(connector: EngineConnector): Promise<StratumEngine> {
  const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-"));
  roots.push(root);
  return new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector });
}

async function waitForBg(engine: StratumEngine, runId: string, status: BgStatus) {
  for (let tick = 0; tick < 200; tick += 1) {
    const polled = await engine.flowBgPoll(runId);
    if (polled.bg.status === status) return polled;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`background flow did not reach ${status}`);
}

const linearFlow = flow([
  { id: "first", do: "first ${input.name}", out: "Result" },
  { id: "second", after: ["first"], do: "second", out: "Result" },
], "${second.output}");

describe("STRAT-TS-FLOW-BG engine driver", () => {
  it("persists the Zod-parsed fanout dispatch default from foreground plan", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = consumerFanoutSpec();
    delete (spec.flows.main.steps[0]!.fanout as { dispatch?: string }).dispatch;
    const planned = await engine.plan(spec, { items: [] });
    const persisted = await new StateStore(roots.at(-1)!).load(planned.runId);
    expect((persisted.spec as typeof spec).flows.main.steps[0]?.fanout.dispatch).toBe("engine");
  });

  it("rejects consumer dispatch for bg submission while foreground plan accepts the same spec", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = consumerFanoutSpec();
    await expect(engine.plan(spec, { items: [] })).resolves.toHaveProperty("runId");
    await expect(engine.flowRunBg(spec, { items: [] })).rejects.toBeInstanceOf(SpecValidationError);
    await expect(engine.flowRunBg(spec, { items: [] })).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: "consumer_dispatch_bg_unsupported" })],
    });
  });

  it("completes a detached linear flow without test-side stepDone calls", async () => {
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    expect(started.status).toBe("running");
    const terminal = await waitForBg(engine, started.runId, "completed");
    expect(terminal.status).toBe("completed");
    expect(prompts).toEqual(["first Ada", "second"]);
  });

  it("evaluates judged ensures through the real stepDone judge path", async () => {
    let judgeCalls = 0;
    const engine = await subject(
      async ({ prompt }) => ({ output: { value: prompt } }),
      async () => { judgeCalls += 1; return { holds: true, reason: "sound", model: "fake-judge" }; },
    );
    const spec = flow([{ id: "build", do: "build", out: "Result", ensure: [{ judged: { statement: "output is sound", stakes: "cheap" } }] }], "${build.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
    expect(judgeCalls).toBe(1);
  });

  it("fails fast after two dispatches when an adverse retry returns identical evidence", async () => {
    let connectorCalls = 0;
    let judgeCalls = 0;
    const engine = await subject(
      async ({ prompt }) => { connectorCalls += 1; return { output: { value: prompt } }; },
      async () => { judgeCalls += 1; return { holds: false, reason: "adverse" }; },
    );
    const spec = flow([{ id: "build", do: "build", out: "Result", attempts: 3, ensure: [{ judged: { statement: "output is sound", stakes: "cheap" } }] }], "${build.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "failed");
    expect(terminal.status).toBe("failed");
    expect(terminal.failure?.reason).toMatch(/no retry: identical evidence/);
    expect(connectorCalls).toBe(2);
    expect(judgeCalls).toBe(2);
  });

  it("uses the full attempt budget when adverse retries return different evidence", async () => {
    let connectorCalls = 0;
    const engine = await subject(
      async () => { connectorCalls += 1; return { output: { value: `attempt-${connectorCalls}` } }; },
      async () => ({ holds: false, reason: "adverse" }),
    );
    const spec = flow([{ id: "build", do: "build", out: "Result", attempts: 3, ensure: [{ judged: { statement: "output is sound", stakes: "cheap" } }] }], "${build.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "failed");
    expect(terminal.status).toBe("failed");
    expect(connectorCalls).toBe(3);
  });

  it("fails fast on an iterate loop that returns identical evidence", async () => {
    let connectorCalls = 0;
    const engine = await subject(async () => { connectorCalls += 1; return { output: { value: "no" } }; });
    // until can never hold on identical output — must stop after 2, not spin to max=5.
    const spec = flow([{ id: "refine", do: "refine", out: "Result", iterate: { max: 5, until: "result.value == 'ok'" } }], "${refine.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "failed");
    expect(terminal.status).toBe("failed");
    expect(terminal.failure?.reason).toMatch(/no retry: identical evidence/);
    expect(connectorCalls).toBe(2);
  });

  it("terminally fails (does not spin) when a connector returns a malformed result", async () => {
    // A resolved-but-malformed result throws inside stepDone before the step leaves
    // `ready`; the driver must terminalize, not re-dispatch forever.
    const engine = await subject(async () => (undefined as unknown as { output: unknown }));
    const spec = flow([{ id: "build", do: "build", out: "Result" }], "${build.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "failed");
    expect(terminal.status).toBe("failed");
  });

  it("terminally fails (does not spin) on a malformed result inside a subflow child", async () => {
    // Subflow child ids are scoped (wrap/child_one); the selective catch must
    // resolve them via locateStep, else an absent root lookup reads as superseded
    // and the driver re-dispatches the malformed child forever.
    let childCalls = 0;
    const engine = await subject(async ({ prompt }) => {
      if (prompt.startsWith("child one")) { childCalls += 1; return undefined as unknown as { output: unknown }; }
      return { output: { value: prompt } };
    });
    const started = await engine.flowRunBg(await fixture("subflow"), { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "failed");
    expect(terminal.status).toBe("failed");
    expect(childCalls).toBe(1); // rethrown on first throw, not re-dispatched
  });

  it("dispatches independent top-level ready steps concurrently", async () => {
    const startedPrompts: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const engine = await subject(async ({ prompt }) => {
      startedPrompts.push(prompt);
      if (startedPrompts.length === 2) release();
      await barrier;
      return { output: { value: prompt } };
    });
    const spec = flow([
      { id: "left", do: "left ${input.name}", out: "Result" },
      { id: "right", do: "right ${input.name}", out: "Result" },
    ], "${right.output}");
    const started = await engine.flowRunBg(spec, { name: "Ada" });
    const terminal = await waitForBg(engine, started.runId, "completed");
    expect(terminal.status).toBe("completed");
    expect(startedPrompts).toEqual(["left Ada", "right Ada"]);
  });

  it("pauses at a top-level gate and resumes driving after approval", async () => {
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    const paused = await waitForBg(engine, started.runId, "paused_gate");
    expect(paused).toMatchObject({ status: "running", bg: { status: "paused_gate", pendingGates: ["review"] } });
    await engine.gateResolve(started.runId, "review", "approve");
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
    expect(prompts).toEqual(["prepare Ada", "draft", "check", "refine", "publish"]);
  });

  it("exposes every sibling-subflow gate, then re-pauses on only the unresolved gate", async () => {
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(siblingGateFlow(), { name: "Ada" });

    const both = await waitForBg(engine, started.runId, "paused_gate");
    expect(both.bg.pendingGates).toEqual(["left/review", "right/review"]);

    await engine.gateResolve(started.runId, "left/review", "approve");
    const one = await waitForBg(engine, started.runId, "paused_gate");
    expect(one.bg.pendingGates).toEqual(["right/review"]);
    expect((await engine.audit(started.runId)).steps.left?.status).toBe("succeeded");

    await engine.gateResolve(started.runId, "right/review", "approve");
    const completed = await waitForBg(engine, started.runId, "completed");
    expect(completed).toMatchObject({ status: "completed", output: { value: "finish Ada" }, bg: { pendingGates: [] } });
    expect(prompts).toEqual(["work Ada", "work Ada", "finish Ada", "finish Ada"]);
  });

  it("revises only the child scope and enforces child rounds without touching run.rounds", async () => {
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(revisableSubflowGate(), { name: "Ada" });
    expect((await waitForBg(engine, started.runId, "paused_gate")).bg.pendingGates).toEqual(["wrap/review"]);

    await engine.gateResolve(started.runId, "wrap/review", "revise");
    expect((await waitForBg(engine, started.runId, "paused_gate")).bg.pendingGates).toEqual(["wrap/review"]);
    const revised = await engine.audit(started.runId);
    expect(revised.steps.wrap?.sub?.rounds).toBe(1);
    expect(revised.steps.wrap?.sub?.steps.review?.iterations).toBe(1);
    expect(revised.steps.stable?.status).toBe("succeeded");
    expect(prompts.filter((prompt) => prompt === "stable Ada")).toHaveLength(1);
    expect(prompts.filter((prompt) => prompt === "revise Ada")).toHaveLength(2);

    await engine.gateResolve(started.runId, "wrap/review", "revise");
    const completed = await waitForBg(engine, started.runId, "completed");
    expect(completed).toMatchObject({ status: "completed", output: { value: "recover" } });
    const audit = await engine.audit(started.runId);
    expect((await new StateStore(roots.at(-1)!).load(started.runId)).rounds).toBeUndefined();
    expect(audit.steps.wrap?.status).toBe("failed");
    expect(audit.steps.recovery?.status).toBe("succeeded");
    expect(prompts.filter((prompt) => prompt === "stable Ada")).toHaveLength(1);
  });

  it("routes a child terminal kill through the parent run step on_fail", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(killedSubflowGate(), { name: "Ada" });
    expect((await waitForBg(engine, started.runId, "paused_gate")).bg.pendingGates).toEqual(["wrap/review"]);

    await engine.gateResolve(started.runId, "wrap/review", "kill");
    const completed = await waitForBg(engine, started.runId, "completed");
    expect(completed).toMatchObject({ status: "completed", output: { value: "recover" } });
    const audit = await engine.audit(started.runId);
    expect(audit.steps.wrap?.status).toBe("failed");
    expect(audit.steps.recovery?.status).toBe("succeeded");
  });

  it("lets the existing async fanout machinery finish a detached flow", async () => {
    let connectorCalls = 0;
    const engine = await subject(async ({ prompt }) => { connectorCalls += 1; return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(await fixture("fanout"), { items: ["a", "b"] });
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
    expect(connectorCalls).toBe(2);
  });

  it("does not pause on a subflow gate while a root fanout is still in flight, then surfaces it once settled", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    const engine = await subject(async ({ prompt }) => {
      if (prompt.startsWith("fan")) { markStarted(); await blocked; } // hold the fanout item in flight
      return { output: { value: prompt } };
    });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { name: "string", items: "string[]" },
          output: { from: "${wrap.output}", contract: "Result" },
          steps: [
            { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result", ensure: [{ expr: "result.value != ''" }] }] } },
            { id: "wrap", run: "child", with: { name: "${input.name}" } },
          ],
        },
        child: {
          input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" },
          steps: [
            { id: "work", do: "work ${input.name}", out: "Result" },
            { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
            { id: "finish", do: "finish ${input.name}", out: "Result" },
          ],
        },
      },
    };
    const started = await engine.flowRunBg(spec, { name: "Ada", items: ["a"] });
    await dispatched; // the fanout item is dispatched and blocked

    // The subflow gate reaches waiting_gate while the fanout is still running...
    let gateReached = false;
    for (let tick = 0; tick < 200; tick += 1) {
      const audit = await engine.audit(started.runId);
      if (audit.steps.wrap?.sub?.steps.review?.status === "waiting_gate") { gateReached = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Guard against a vacuous pass: the mid-flight assertion is only meaningful if
    // the gate genuinely reached waiting_gate WHILE the fanout was still blocked.
    expect(gateReached).toBe(true);
    // ...but the driver must NOT pause: a still-in-flight fanout could settle behind
    // an exited driver (advancing the run or terminalizing it) with nothing left to
    // refresh bg. The gate stays unpublished until the run is quiescent.
    const midFlight = await engine.flowBgPoll(started.runId);
    expect(midFlight.bg.status).toBe("running");
    expect(midFlight.bg.pendingGates).toEqual([]);

    release();
    const paused = await waitForBg(engine, started.runId, "paused_gate");
    expect(paused.bg.pendingGates).toEqual(["wrap/review"]);
    expect((await engine.audit(started.runId)).steps.fan?.status).toBe("succeeded");

    await engine.gateResolve(started.runId, "wrap/review", "approve");
    const completed = await waitForBg(engine, started.runId, "completed");
    expect(completed).toMatchObject({ status: "completed", output: { value: "finish Ada" } });
  });

  it("cancels cooperatively after an in-flight connector reaches a boundary", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    let connectorCalls = 0;
    const engine = await subject(async ({ prompt }) => {
      connectorCalls += 1;
      markStarted();
      await blocked;
      return { output: { value: prompt } };
    });
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    expect(await engine.flowCancelBg(started.runId)).toEqual({ status: "running" });
    release();
    const cancelled = await waitForBg(engine, started.runId, "cancelled");
    expect(cancelled.bg).toMatchObject({ status: "cancelled", cancelRequested: true });
    expect(connectorCalls).toBe(1);
  });

  it("cancels a gate-paused flow immediately instead of wedging at paused_gate", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    await waitForBg(engine, started.runId, "paused_gate");
    // No live loop observes the cancel flag while paused — flowCancelBg must settle it.
    expect(await engine.flowCancelBg(started.runId)).toEqual({ status: "cancelled" });
    expect((await engine.flowBgPoll(started.runId)).bg).toMatchObject({ status: "cancelled" });
  });

  it("refuses a gate decision on a cancelled bg run instead of advancing it", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    const paused = await waitForBg(engine, started.runId, "paused_gate");
    expect(paused.bg.pendingGates).toEqual(["review"]);
    expect(await engine.flowCancelBg(started.runId)).toEqual({ status: "cancelled" });
    // A cancelled run is durably abandoned: an approval must not complete it or
    // issue new ready work behind the cancellation.
    await expect(engine.gateResolve(started.runId, "review", "approve")).rejects.toThrow(/cancelled/);
    expect((await engine.flowBgPoll(started.runId)).bg).toMatchObject({ status: "cancelled" });
    expect((await engine.audit(started.runId)).steps.refine?.status).toBe("pending");
  });

  it("stops dispatching further fanout items after a cooperative cancel", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    let connectorCalls = 0;
    const engine = await subject(async ({ prompt }) => {
      connectorCalls += 1;
      markStarted();
      await blocked; // block the first (and only in-flight) item until we cancel
      return { output: { value: prompt } };
    });
    const fanoutSpec = {
      version: 1, contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]" },
        output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "work ${item}", out: "Result", ensure: [{ expr: "result.value != ''" }] }] } }],
      } },
    };
    const started = await engine.flowRunBg(fanoutSpec, { items: ["a", "b", "c"] });
    await dispatched;
    await engine.flowCancelBg(started.runId);
    release();
    const cancelled = await waitForBg(engine, started.runId, "cancelled");
    expect(cancelled.bg).toMatchObject({ status: "cancelled" });
    // Only item "a" was in flight; "b" and "c" must never dispatch after cancel.
    expect(connectorCalls).toBe(1);
  });

  it("locks out an external stepDone on a bg-driven run and completes under the driver alone", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.startsWith("first")) { markStarted(); await blocked; }
      return { output: { value: prompt } };
    });
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    // The driver owns the mutation surface: an external stepDone while a step is
    // in flight would race a stale result in — it must be refused, not accepted.
    await expect(engine.stepDone(started.runId, "first", { output: { value: "stale" } }))
      .rejects.toThrow(/background-driven/);
    release();
    const terminal = await waitForBg(engine, started.runId, "completed");
    expect(terminal.status).toBe("completed");
    // The driver drove every step itself; the external pump never advanced anything.
    expect(prompts).toEqual(["first Ada", "second"]);
    // The "stale" external result was never committed — "first" holds the driver's output.
    const audit = await engine.audit(started.runId);
    expect(audit.steps.first?.output).toEqual({ value: "first Ada" });
  });

  it("refuses an external stepDone on a cancelled (abandoned-but-running) bg run", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    const engine = await subject(async ({ prompt }) => {
      if (prompt.startsWith("first")) { markStarted(); await blocked; }
      return { output: { value: prompt } };
    });
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    await engine.flowCancelBg(started.runId);
    release();
    await waitForBg(engine, started.runId, "cancelled");
    // A cancelled run is abandoned; its still-ready step must not be externally pumped.
    await expect(engine.stepDone(started.runId, "second", { output: { value: "sneak" } }))
      .rejects.toThrow(/background-driven/);
  });

  it("permits stepDone again once the bg run reaches a terminal state", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await waitForBg(engine, started.runId, "completed");
    // Post-terminal, the guard no longer refuses — the natural "not awaiting" error surfaces instead.
    await expect(engine.stepDone(started.runId, "first", { output: { value: "x" } }))
      .rejects.toThrow(/not awaiting a client result/);
  });

  it("locks out an external resume on a bg-driven run and completes under the driver alone", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { markStarted = resolve; });
    const engine = await subject(async ({ prompt }) => {
      if (prompt.startsWith("first")) { markStarted(); await blocked; }
      return { output: { value: prompt } };
    });
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await dispatched;
    // The in-flight step is durably `ready`; an external resume would hand that
    // same work to a second executor while the driver's dispatch is still running.
    await expect(engine.resume(started.runId)).rejects.toThrow(/background-driven/);
    release();
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
  });

  it("refuses an external resume on a cancelled (abandoned-but-running) bg run", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    await waitForBg(engine, started.runId, "paused_gate");
    await engine.flowCancelBg(started.runId);
    // The cancelled run still holds a waiting gate; resume must not hand out its work.
    await expect(engine.resume(started.runId)).rejects.toThrow(/background-driven/);
  });

  it("permits resume again once the bg run reaches a terminal state", async () => {
    const engine = await subject(async ({ prompt }) => ({ output: { value: prompt } }));
    const started = await engine.flowRunBg(linearFlow, { name: "Ada" });
    await waitForBg(engine, started.runId, "completed");
    expect((await engine.resume(started.runId)).status).toBe("completed");
  });

  it("rejects a superseded dispatch token after gate revise and accepts the current token", async () => {
    // S3: RAW engine (unwrapped) — this is a token-fencing assertion.
    const engine = await rawSubject(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" },
        output: { from: "${a.output}", contract: "Result" },
        max_rounds: 1,
        steps: [
          { id: "a", do: "build ${input.name}", out: "Result" },
          { id: "b", after: ["a"], gate: { on_approve: null, on_revise: "a", on_kill: null } },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    expect(planned).toMatchObject({ status: "ready", ready: [{ id: "a" }] });
    if (planned.status !== "ready") throw new Error("expected ready");
    const firstToken = planned.ready[0]!.dispatchToken;
    expect(await engine.stepDone(planned.runId, "a", { output: { value: "first" } }, firstToken)).toMatchObject({ status: "running" });
    const gateToken = (await engine.audit(planned.runId)).steps.b?.gateToken;
    const revised = await engine.gateResolve(planned.runId, "b", "revise", gateToken!);
    expect(revised).toMatchObject({ status: "ready", ready: [{ id: "a" }] });
    if (revised.status !== "ready") throw new Error("expected revised ready");
    const currentToken = revised.ready[0]!.dispatchToken;
    expect(currentToken).not.toBe(firstToken);
    await expect(engine.stepDone(planned.runId, "a", { output: { value: "stale" } }, firstToken)).rejects.toThrow(/stale/);
    expect(await engine.stepDone(planned.runId, "a", { output: { value: "fresh" } }, currentToken)).toMatchObject({ status: "running" });
  });
});

function flow(steps: unknown[], from: string) {
  return { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: { input: { name: "string" }, output: { from, contract: "Result" }, steps } } };
}

function consumerFanoutSpec() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: { entry: "main", main: {
      input: { items: "string[]" },
      output: { from: "${fan.output[0].value}", contract: "Result" },
      steps: [{ id: "fan", when: "false", fanout: {
        over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
        steps: [{ do: "fan ${item}", out: "Result" }],
      } }],
    } },
  };
}

function siblingGateFlow() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { name: "string" }, output: { from: "${right.output}", contract: "Result" },
        steps: [
          { id: "left", run: "child", with: { name: "${input.name}" } },
          { id: "right", run: "child", with: { name: "${input.name}" } },
        ],
      },
      child: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "work", do: "work ${input.name}", out: "Result" },
          { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
          { id: "finish", do: "finish ${input.name}", out: "Result" },
        ],
      },
    },
  };
}

function revisableSubflowGate() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { name: "string" }, output: { from: "${recovery.output}", contract: "Result" },
        steps: [
          { id: "wrap", run: "revisable", with: { name: "${input.name}" }, on_fail: "recovery" },
          { id: "stable", run: "stable_child", with: { name: "${input.name}" } },
          { id: "recovery", do: "recover", out: "Result" },
        ],
      },
      revisable: {
        input: { name: "string" }, output: { from: "${build.output}", contract: "Result" }, max_rounds: 1,
        steps: [
          { id: "build", do: "revise ${input.name}", out: "Result" },
          { id: "review", after: ["build"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
        ],
      },
      stable_child: {
        input: { name: "string" }, output: { from: "${build.output}", contract: "Result" },
        steps: [{ id: "build", do: "stable ${input.name}", out: "Result" }],
      },
    },
  };
}

function killedSubflowGate() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { name: "string" }, output: { from: "${recovery.output}", contract: "Result" },
        steps: [
          { id: "wrap", run: "child", with: { name: "${input.name}" }, on_fail: "recovery" },
          { id: "recovery", do: "recover", out: "Result" },
        ],
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
}
