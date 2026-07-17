import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type Evaluator } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const evaluator: Evaluator = {
  evaluate(expression, context) {
    if (expression === "false") return false;
    if (expression === "true") return true;
    if (expression === "upper(input.name)") return String((context.input as { name: string }).name).toUpperCase();
    if (expression === "result.ok == true") return (context.result as { ok?: unknown } | undefined)?.ok === true;
    throw new Error(`unexpected fake expression: ${expression}`);
  },
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function createEngine(extra: Partial<ConstructorParameters<typeof StratumEngine>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "stratum-p1-"));
  roots.push(root);
  return { root, engine: tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator, ...extra })) };
}

const flow = (steps: unknown[], options: { budget?: Record<string, number>; output?: string; contract?: Record<string, string> } = {}) => ({
  version: 1,
  contracts: { Result: options.contract ?? { value: "string" } },
  flows: {
    entry: "main",
    main: {
      input: { name: "string" },
      output: { from: options.output ?? "${finish.output}", contract: "Result" },
      ...(options.budget ? { budget: options.budget } : {}),
      steps,
    },
  },
});

describe("P1 golden flow", () => {
  it("persists a client-driven run, resumes it, completes it, and audits ordered attempts", async () => {
    const { root, engine: first } = await createEngine();
    const spec = flow([
      { id: "collect", do: "collect ${input.name}", out: "Result" },
      { id: "normalize", after: ["collect"], set: { value: "upper(input.name)" }, out: "Result" },
      { id: "finish", do: "finish ${normalize.output.value}", out: "Result" },
    ]);

    const planned = await first.plan(spec, { name: "ada" });
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") return;
    expect(planned.ready).toMatchObject([{ id: "collect", do: "collect ada", attempt: 1 }]);

    const afterCollect = await first.stepDone(planned.runId, "collect", { output: { value: "raw" } });
    expect(afterCollect.status).toBe("ready");
    if (afterCollect.status !== "ready") return;
    expect(afterCollect.ready[0]).toMatchObject({ id: "finish", do: "finish ADA", attempt: 1 });

    const second = tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator }));
    const resumed = await second.resume(planned.runId);
    expect(resumed).toMatchObject({ status: "ready", runId: planned.runId, ready: [{ id: "finish" }] });

    const done = await second.stepDone(planned.runId, "finish", { output: { value: "complete" } });
    expect(done).toMatchObject({ status: "completed", output: { value: "complete" } });
    const audit = await second.audit(planned.runId);
    expect(audit.events.map((event) => event.type)).toEqual(["planned", "ready", "result", "result", "ready", "resumed", "result", "completed"]);
    expect(audit.steps.collect?.attempts[0]).toMatchObject({ attempt: 1, result: { value: "raw" } });
  });
});

describe("P1 table-driven error harness", () => {
  it.each([
    { name: "retries a submitted failure with structured context", results: [{ failure: "tool crashed" }, { output: { value: "ok" } }], expected: "completed" },
    { name: "retries an E1 contract failure with the zod reason", results: [{ output: { wrong: true } }, { output: { value: "ok" } }], expected: "completed" },
  ])("attempts: $name", async ({ results, expected }) => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "work", out: "Result", attempts: 2 }]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const retry = await engine.stepDone(planned.runId, "finish", results[0]!);
    expect(retry).toMatchObject({ status: "ready", ready: [{ id: "finish", attempt: 2, previousFailure: { attempt: 1 } }] });
    if (retry.status !== "ready") return;
    expect(retry.ready[0]?.previousFailure?.reason).toContain("failure" in results[0]! ? results[0]!.failure : "Required");
    const done = await engine.stepDone(planned.runId, "finish", results[1]!);
    expect(done.status).toBe(expected);
  });

  it.each([{ name: "exhausted task failure", failure: "nope" }])("on_fail: routes $name", async ({ failure }) => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "primary", do: "primary", out: "Result", attempts: 1, on_fail: "fallback" },
      { id: "fallback", do: "fallback", out: "Result" },
      { id: "finish", do: "finish", out: "Result", after: ["fallback"] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const routed = await engine.stepDone(planned.runId, "primary", { failure });
    expect(routed).toMatchObject({ status: "ready", ready: [{ id: "fallback", previousFailure: { reason: failure } }] });
    expect((await engine.audit(planned.runId)).events.at(-2)).toMatchObject({ type: "routed", stepId: "primary", detail: { target: "fallback" } });
    await engine.stepDone(planned.runId, "fallback", { output: { value: "recovered" } });
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done.status).toBe("completed");
  });

  it.each([
    { name: "false condition", when: "false", skipped: "skipped" },
    { name: "true condition", when: "true", skipped: "succeeded" },
  ])("when: $name remains local to its step", async ({ when, skipped }) => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "skip", do: "maybe", out: "Result", when },
      { id: "finish", do: "finish", out: "Result" },
    ]), { name: "x" });
    expect(planned).toMatchObject({ status: "ready" });
    if (planned.status !== "ready") return;
    expect(planned.ready.map((step) => step.id)).toContain("finish");
    if (when === "true") await engine.stepDone(planned.runId, "skip", { output: { value: "ran" } });
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done.status).toBe("completed");
    expect((await engine.audit(planned.runId)).steps.skip?.status).toBe(skipped);
  });

  it.each(([
    "usd", "tokens", "ms",
  ] as const).flatMap((key) => [
    { name: `task ${key} sub-ledger`, taskBudget: { [key]: 2 }, flowBudget: { [key]: 10 }, usage: { [key]: 3 }, expected: "failed" },
    { name: `flow ${key} ledger`, taskBudget: undefined, flowBudget: { [key]: 2 }, usage: { [key]: 3 }, expected: "budget_exhausted" },
  ]))("budget: $name", async ({ taskBudget, flowBudget, usage, expected }) => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "work", out: "Result", attempts: 1, ...(taskBudget ? { budget: taskBudget } : {}) }], { budget: flowBudget }), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { output: { value: "ok" }, usage });
    expect(result.status).toBe(expected);
  });

  it("exhausts a task dispatches budget from engine-side accounting alone", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "finish", do: "work", out: "Result", attempts: 2, budget: { dispatches: 1 } },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { failure: "boom" });
    expect(result).toMatchObject({ status: "failed", failure: { reason: "task budget exhausted" } });
  });

  it("exhausts the flow dispatches budget when reserving a second step, durably", async () => {
    const { root, engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "left", do: "left", out: "Result" },
      { id: "right", do: "right", out: "Result" },
    ], { budget: { dispatches: 1 }, output: "${left.output}" }), { name: "x" });
    expect(planned.status).toBe("budget_exhausted");
    const fresh = new StratumEngine({ stateRoot: root, evaluator });
    expect((await fresh.resume(planned.runId)).status).toBe("budget_exhausted");
  });

  it("rejects client-reported dispatches usage but still settles the valid keys", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "work", out: "Result", attempts: 1 }]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { output: { value: "ok" }, usage: { dispatches: 1, tokens: 500 } });
    expect(result).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("engine-accounted") } });
    const audit = await engine.audit(planned.runId);
    expect(audit.flowSpent.tokens).toBe(500);
    expect(audit.steps.finish?.spent.tokens).toBe(500);
  });

  it("threads connector telemetry into successful and failed attempt records", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "work", out: "Result", attempts: 2 }]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    await engine.stepDone(planned.runId, "finish", {
      failure: "retry",
      telemetry: { durationMs: 12, model: "gpt-5.3-codex-spark", effort: "low" },
    });
    await engine.stepDone(planned.runId, "finish", {
      output: { value: "ok" },
      telemetry: { durationMs: 34, model: "claude-sonnet-4-6" },
    });

    const attempts = (await engine.audit(planned.runId)).steps.finish?.attempts;
    expect(attempts?.[0]).toMatchObject({ durationMs: 12, model: "gpt-5.3-codex-spark", effort: "low" });
    expect(attempts?.[1]).toMatchObject({ durationMs: 34, model: "claude-sonnet-4-6" });
    expect(attempts?.[1]).not.toHaveProperty("effort");
  });

  it("rejects malformed connector telemetry instead of persisting it", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "work", out: "Result", attempts: 1 }]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", {
      output: { value: "ok" },
      telemetry: { durationMs: -1, model: "gpt-5" },
    });
    expect(result).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("invalid connector telemetry") } });
  });

  it("does not ledger a dispatch or stamp usage when rendering fails before dispatch", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "skip", do: "maybe", out: "Result", when: "false" },
      { id: "finish", do: "finish ${skip.output.value}", out: "Result", attempts: 1 },
    ]), { name: "x" });
    expect(planned.status).toBe("failed");
    if (planned.status !== "failed") return;
    const audit = await engine.audit(planned.runId);
    expect(audit.steps.finish?.spent).toEqual({});
    expect(audit.flowSpent).toEqual({});
    expect(audit.steps.finish?.attempts[0]?.usage).toBeUndefined();
  });

  it("carries the flow ledger snapshot on every response", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result" }],
      { budget: { usd: 5, dispatches: 20 } },
    ), { name: "x" });
    expect(planned).toMatchObject({ status: "ready", ledger: { spent: { dispatches: 1 }, budget: { usd: 5, dispatches: 20 } } });
    if (planned.status !== "ready") return;
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "ok" }, usage: { usd: 2 } });
    expect(done).toMatchObject({ status: "completed", ledger: { spent: { usd: 2, dispatches: 1 } } });
  });

  it("does not re-resolve reference tokens inside resolved values", async () => {
    const { engine } = await createEngine();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { a: "string", b: "string" },
        output: { from: "${finish.output}", contract: "Result" },
        steps: [{ id: "finish", do: "${input.a} ${input.b}", out: "Result" }],
      } },
    };
    const planned = await engine.plan(spec, { a: "${input.b}", b: "B" });
    expect(planned).toMatchObject({ status: "ready", ready: [{ do: "${input.b} B" }] });
  });

  it("completes when a successful step's on_fail target is never routed", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "primary", do: "primary", out: "Result", on_fail: "cleanup" },
      { id: "cleanup", do: "cleanup", out: "Result" },
      { id: "finish", do: "finish", out: "Result", after: ["primary"] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    await engine.stepDone(planned.runId, "primary", { output: { value: "ok" } });
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done.status).toBe("completed");
    expect((await engine.audit(planned.runId)).steps.cleanup?.status).toBe("skipped");
  });

  it("lets an after-successor proceed past a when-skipped dependency", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "skip", do: "maybe", out: "Result", when: "false" },
      { id: "finish", do: "finish", out: "Result", after: ["skip"] },
    ]), { name: "x" });
    expect(planned).toMatchObject({ status: "ready", ready: [{ id: "finish" }] });
    if (planned.status !== "ready") return;
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done.status).toBe("completed");
  });

  it("fails a step whose do references a when-skipped step's output", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "skip", do: "maybe", out: "Result", when: "false" },
      { id: "finish", do: "finish ${skip.output.value}", out: "Result", attempts: 1 },
    ]), { name: "x" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("unavailable") } });
  });

  it("renders reference values containing replacement patterns verbatim", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([{ id: "finish", do: "greet ${input.name}", out: "Result" }]), { name: "$& $' $1" });
    expect(planned).toMatchObject({ status: "ready", ready: [{ do: "greet $& $' $1" }] });
  });

  it("persists concurrent stepDone results for independent ready steps", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "left", do: "left", out: "Result" },
      { id: "right", do: "right", out: "Result" },
      { id: "finish", do: "finish", out: "Result", after: ["left", "right"] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    expect(planned.ready.map((step) => step.id).sort()).toEqual(["left", "right"]);
    await Promise.all([
      engine.stepDone(planned.runId, "left", { output: { value: "l" } }),
      engine.stepDone(planned.runId, "right", { output: { value: "r" } }),
    ]);
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done.status).toBe("completed");
    const audit = await engine.audit(planned.runId);
    expect(audit.steps.left?.status).toBe("succeeded");
    expect(audit.steps.right?.status).toBe("succeeded");
  });

  it("records over-limit usage in both ledgers when a task budget exhausts", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, budget: { tokens: 2 } }],
      { budget: { tokens: 10 } },
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { output: { value: "ok" }, usage: { tokens: 5 } });
    expect(result.status).toBe("failed");
    const audit = await engine.audit(planned.runId);
    expect(audit.steps.finish?.spent.tokens).toBe(5);
    expect(audit.flowSpent.tokens).toBe(5);
  });

  it("records usage and the final attempt when the flow ledger exhausts", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1 }],
      { budget: { tokens: 2 } },
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { output: { value: "ok" }, usage: { tokens: 5 } });
    expect(result.status).toBe("budget_exhausted");
    const audit = await engine.audit(planned.runId);
    expect(audit.flowSpent.tokens).toBe(5);
    expect(audit.steps.finish?.attempts[0]).toMatchObject({ usage: { tokens: 5 } });
  });

  it("retries an ensure expr failure with the structured reason, then succeeds", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 2, ensure: [{ expr: "result.ok == true" }] }],
      { contract: { value: "string", ok: "boolean" } },
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const retry = await engine.stepDone(planned.runId, "finish", { output: { value: "v", ok: false } });
    expect(retry).toMatchObject({ status: "ready", ready: [{ attempt: 2, previousFailure: { reason: expect.stringContaining("ensure") } }] });
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v", ok: true } });
    expect(done.status).toBe("completed");
  });

  it("runs judged ensures through the injected runner, settles usage, and events the verdict", async () => {
    const calls: unknown[] = [];
    const { engine } = await createEngine({
      judge: async (predicate, context) => {
        calls.push({ predicate, context });
        return { holds: true, reason: "verified", stakes: "cheap", model: "gpt-5.3-codex-spark/low", usage: { tokens: 100, usd: 0.01 } };
      },
    });
    const planned = await engine.plan(flow([
      { id: "finish", do: "work", out: "Result", ensure: [{ judged: { statement: "output is real", stakes: "cheap" } }] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done.status).toBe("completed");
    expect(calls).toEqual([{ predicate: { statement: "output is real", stakes: "cheap" }, context: { result: { value: "v" }, input: { name: "x" } } }]);
    const audit = await engine.audit(planned.runId);
    expect(audit.flowSpent).toMatchObject({ tokens: 100, usd: 0.01 });
    expect(audit.events.find((event) => event.type === "judged")).toMatchObject({
      stepId: "finish",
      detail: { holds: true, reason: "verified", stakes: "cheap", model: "gpt-5.3-codex-spark/low", usage: { tokens: 100, usd: 0.01 } },
    });
  });

  it("fails the attempt when a judged ensure does not hold", async () => {
    const { engine } = await createEngine({
      judge: async () => ({ holds: false, reason: "the output is fabricated", usage: { tokens: 10, usd: 0.001 } }),
    });
    const planned = await engine.plan(flow([
      { id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "output is real", stakes: "default" } }] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("fabricated") } });
  });

  it("fails closed when a judged ensure has no configured runner", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow([
      { id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "s", stakes: "cheap" } }] },
    ]), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("judge runner") } });
  });

  it("terminalizes the flow when judged usage exhausts the flow ledger", async () => {
    const { engine } = await createEngine({
      judge: async () => ({ holds: true, reason: "ok", usage: { usd: 0.01 } }),
    });
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "s", stakes: "cheap" } }] }],
      { budget: { usd: 0.005 } },
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done.status).toBe("budget_exhausted");
    expect((await engine.audit(planned.runId)).flowSpent.usd).toBe(0.01);
  });

  it("fails an ensure structurally when the evaluator throws or returns a malformed verdict", async () => {
    const throwing = await createEngine({
      evaluator: { evaluate: () => true, evaluatePredicate: () => { throw new Error("evaluator exploded"); } },
    });
    const planned = await throwing.engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ expr: "x" }] }],
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await throwing.engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("evaluator exploded") } });

    const malformed = await createEngine({
      evaluator: { evaluate: () => true, evaluatePredicate: () => ({ holds: 1, reason: 2 }) as never },
    });
    const planned2 = await malformed.engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ expr: "x" }] }],
    ), { name: "x" });
    if (planned2.status !== "ready") throw new Error("expected ready");
    const done2 = await malformed.engine.stepDone(planned2.runId, "finish", { output: { value: "v" } });
    expect(done2).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("malformed predicate verdict") } });
  });

  it("survives unstringifiable thrown values and normalizes non-string event fields", async () => {
    const hostile = await createEngine({
      evaluator: { evaluate: () => true, evaluatePredicate: () => { throw Object.create(null); } },
    });
    const planned = await hostile.engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ expr: "x" }] }],
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await hostile.engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("unstringifiable") } });

    const throwingGetter = await createEngine({
      judge: async () => {
        const raw = { holds: true, reason: "ok" };
        Object.defineProperty(raw, "model", { get() { throw new Error("hostile getter"); }, enumerable: true });
        return raw as never;
      },
    });
    const planned3 = await throwingGetter.engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "s", stakes: "cheap" } }] }],
    ), { name: "x" });
    if (planned3.status !== "ready") throw new Error("expected ready");
    const done3 = await throwingGetter.engine.stepDone(planned3.runId, "finish", { output: { value: "v" } });
    expect(done3).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("hostile getter") } });

    const weirdModel = await createEngine({
      judge: async () => ({ holds: true, reason: "ok", model: 42 }) as never,
    });
    const planned2 = await weirdModel.engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", ensure: [{ judged: { statement: "s", stakes: "cheap" } }] }],
    ), { name: "x" });
    if (planned2.status !== "ready") throw new Error("expected ready");
    await weirdModel.engine.stepDone(planned2.runId, "finish", { output: { value: "v" } });
    const judgedEvent = (await weirdModel.engine.audit(planned2.runId)).events.find((event) => event.type === "judged");
    expect(judgedEvent).toMatchObject({ detail: { model: "none", stakes: "cheap" } });
  });

  it("fails a judged ensure on a malformed runner outcome and always emits the judged event", async () => {
    const { engine } = await createEngine({ judge: async () => ({ holds: "yes", reason: "ok" }) as never });
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "s", stakes: "cheap" } }] }],
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("malformed outcome") } });
    const judgedEvent = (await engine.audit(planned.runId)).events.find((event) => event.type === "judged");
    expect(judgedEvent).toMatchObject({
      stepId: "finish",
      detail: { statement: "s", holds: false, stakes: "cheap", model: "none", usage: { tokens: 0, usd: 0 } },
    });
  });

  it("emits a judged event even when no runner is configured", async () => {
    const { engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "s", stakes: "default" } }] }],
    ), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    const judgedEvent = (await engine.audit(planned.runId)).events.find((event) => event.type === "judged");
    expect(judgedEvent).toMatchObject({ detail: { holds: false, reason: expect.stringContaining("judge runner"), model: "none" } });
  });

  it("canonicalizes a relative workspace root at plan time", async () => {
    const { root, engine } = await createEngine();
    const planned = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result" }],
    ), { name: "x" }, { workspaceRoot: "relative/workspace" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const persisted = JSON.parse(await readFile(join(root, `${planned.runId}.json`), "utf8")) as { workspaceRoot?: string };
    expect(persisted.workspaceRoot).toBeDefined();
    expect(isAbsolute(persisted.workspaceRoot!)).toBe(true);
  });

  it("jails real file predicates to the plan-time workspace root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "stratum-ws-"));
    roots.push(workspace);
    await writeFile(join(workspace, "proof.txt"), "verified evidence", "utf8");
    const { engine } = await createEngine({ evaluator: createEvaluator() });
    const spec = flow([
      { id: "finish", do: "work", out: "Result", attempts: 1, ensure: [
        { file_exists: "proof.txt" },
        { file_contains: { path: "proof.txt", text: "evidence" } },
      ] },
    ]);
    const planned = await engine.plan(spec, { name: "x" }, { workspaceRoot: workspace });
    if (planned.status !== "ready") throw new Error("expected ready");
    const done = await engine.stepDone(planned.runId, "finish", { output: { value: "v" } });
    expect(done.status).toBe("completed");

    const escaping = await engine.plan(flow(
      [{ id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ file_exists: "../outside.txt" }] }],
    ), { name: "x" }, { workspaceRoot: workspace });
    if (escaping.status !== "ready") throw new Error("expected ready");
    const failed = await engine.stepDone(escaping.runId, "finish", { output: { value: "v" } });
    expect(failed).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("ensure") } });
  });

  it("preserves a full-value flow output reference type and rejects the bound output contract", async () => {
    const { engine } = await createEngine();
    const spec = {
      version: 1,
      contracts: { Task: { wrapped: "object" }, Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output.wrapped}", contract: "Result" },
        steps: [{ id: "finish", do: "work", out: "Task", attempts: 1 }],
      } },
    };
    const planned = await engine.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready");
    const result = await engine.stepDone(planned.runId, "finish", { output: { wrapped: { arbitrary: true } } });
    expect(result).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("Required") } });
  });
});
