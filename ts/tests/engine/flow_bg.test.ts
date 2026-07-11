import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type BgStatus, type EngineConnector, type JudgeRunner } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(name: string): Promise<unknown> {
  const bytes = await readFile(new URL(`../../parity/${name}.v1.yaml`, import.meta.url));
  return parseDocument(bytes.toString("utf8"), { prettyErrors: false }).toJS();
}

async function subject(connector: EngineConnector, judge?: JudgeRunner): Promise<StratumEngine> {
  const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-"));
  roots.push(root);
  return new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector, ...(judge ? { judge } : {}) });
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

  it("retries adverse judged verdicts and fails at the declared attempt cap", async () => {
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
    expect(connectorCalls).toBe(3);
    expect(judgeCalls).toBe(3);
  });

  it("pauses at a top-level gate and resumes driving after approval", async () => {
    const prompts: string[] = [];
    const engine = await subject(async ({ prompt }) => { prompts.push(prompt); return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(await fixture("linear-gate"), { name: "Ada" });
    const paused = await waitForBg(engine, started.runId, "paused_gate");
    expect(paused).toMatchObject({ status: "running", bg: { status: "paused_gate", gateStepId: "review" } });
    await engine.gateResolve(started.runId, "review", "approve");
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
    expect(prompts).toEqual(["prepare Ada", "draft", "check", "refine", "publish"]);
  });

  it("lets the existing async fanout machinery finish a detached flow", async () => {
    let connectorCalls = 0;
    const engine = await subject(async ({ prompt }) => { connectorCalls += 1; return { output: { value: prompt } }; });
    const started = await engine.flowRunBg(await fixture("fanout"), { items: ["a", "b"] });
    expect((await waitForBg(engine, started.runId, "completed")).status).toBe("completed");
    expect(connectorCalls).toBe(2);
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
});

function flow(steps: unknown[], from: string) {
  return { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: { input: { name: "string" }, output: { from, contract: "Result" }, steps } } };
}
