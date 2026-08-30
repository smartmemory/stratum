import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function engine(root?: string) {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-subflow-"));
  if (!root) roots.push(stateRoot);
  return { root: stateRoot, engine: tokenEchoingEngine(new StratumEngine({ stateRoot, evaluator: createEvaluator() })) };
}

const resultContract = { value: "string" };

function subflowSpec(options: { childSteps?: unknown[]; childOutput?: string; parentSteps?: unknown[] } = {}) {
  return {
    version: 1,
    contracts: { Result: resultContract },
    flows: {
      entry: "main",
      main: {
        input: { name: "string", payload: "object" },
        output: { from: "${finish.output}", contract: "Result" },
        steps: options.parentSteps ?? [
          { id: "wrap", run: "summarize", with: { name: "hello ${input.name}", payload: "${input.payload}" } },
          { id: "finish", do: "publish ${wrap.output.value}", out: "Result" },
        ],
      },
      summarize: {
        input: { name: "string", payload: "object" },
        output: { from: options.childOutput ?? "${digest.output}", contract: "Result" },
        steps: options.childSteps ?? [
          { id: "digest", do: "digest ${input.name} ${input.payload}", out: "Result" },
        ],
      },
    },
  };
}

describe("P4 run subflow execution", () => {
  it("executes inline, surfaces namespaced tasks, and writes one ordered event spine", async () => {
    const { engine: e } = await engine();
    const planned = await e.plan(subflowSpec(), { name: "Ada", payload: { n: 7 } });
    expect(planned).toMatchObject({
      status: "ready",
      ready: [{ id: "wrap/digest", do: 'digest hello Ada {"n":7}', attempt: 1 }],
      ledger: { spent: { dispatches: 1 } },
    });
    if (planned.status !== "ready") return;

    const parentReady = await e.stepDone(planned.runId, "wrap/digest", {
      output: { value: "summary" },
      usage: { tokens: 12 },
      telemetry: { durationMs: 4, model: "fake-model" },
    });
    expect(parentReady).toMatchObject({ status: "ready", ready: [{ id: "finish", do: "publish summary" }] });
    if (parentReady.status !== "ready") return;
    const done = await e.stepDone(planned.runId, "finish", { output: { value: "done" } });
    expect(done).toMatchObject({ status: "completed", output: { value: "done" }, ledger: { spent: { dispatches: 2, tokens: 12 } } });

    const audit = await e.audit(planned.runId);
    expect(audit.events.map(({ type, stepId }) => [type, stepId])).toEqual([
      ["planned", undefined],
      ["ready", "wrap/digest"],
      ["usage_debit", "wrap/digest"],
      ["result", "wrap/digest"],
      ["result", "wrap"],
      ["ready", "finish"],
      ["result", "finish"],
      ["completed", undefined],
    ]);
    expect(audit.steps.wrap?.sub?.steps.digest?.attempts[0]).toMatchObject({
      result: { value: "summary" }, durationMs: 4, model: "fake-model", usage: { tokens: 12 },
    });
  });

  it.each([
    { name: "full string", sourceType: "string", childType: "string", source: "x", template: "${input.value}", expected: "x" },
    { name: "full integer", sourceType: "integer", childType: "integer", source: 3, template: "${input.value}", expected: 3 },
    { name: "full boolean", sourceType: "boolean", childType: "boolean", source: true, template: "${input.value}", expected: true },
    { name: "full object", sourceType: "object", childType: "object", source: { x: 1 }, template: "${input.value}", expected: { x: 1 } },
    { name: "full array", sourceType: "array", childType: "array", source: [1, "x"], template: "${input.value}", expected: [1, "x"] },
    { name: "mixed string", sourceType: "string", childType: "string", source: "x", template: "pre ${input.value} post", expected: "pre x post" },
    { name: "mixed integer", sourceType: "integer", childType: "string", source: 3, template: "pre ${input.value} post", expected: "pre 3 post" },
    { name: "mixed boolean", sourceType: "boolean", childType: "string", source: true, template: "pre ${input.value} post", expected: "pre true post" },
    { name: "mixed object", sourceType: "object", childType: "string", source: { x: 1 }, template: "pre ${input.value} post", expected: 'pre {"x":1} post' },
    { name: "mixed null", sourceType: "object", childType: "string", source: { x: null }, template: "pre ${input.value.x} post", expected: "pre  post" },
  ])("resolves a $name with-template with prompt rendering rules", async ({ sourceType, childType, source, template, expected }) => {
    const { engine: e } = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: {
        entry: "main",
        main: {
          input: { value: sourceType }, output: { from: "${wrap.output}", contract: "Result" },
          steps: [{ id: "wrap", run: "child", with: { value: template } }],
        },
        child: {
          input: { value: childType }, output: { from: "${digest.output}", contract: "Result" },
          steps: [{ id: "digest", do: "digest ${input.value}", out: "Result" }],
        },
      },
    };
    const planned = await e.plan(spec, { value: source });
    expect(planned.status).toBe("ready");
    const audit = await e.audit(planned.runId);
    expect(audit.steps.wrap?.sub?.input).toEqual({ value: expected });
  });

  it("activates independent run steps and root tasks concurrently — list order is never a dependency", async () => {
    const { engine: e } = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: {
        entry: "main",
        main: {
          input: { name: "string" },
          output: { from: "${combine.output}", contract: "Result" },
          steps: [
            { id: "one", run: "summarize", with: { name: "${input.name}" } },
            { id: "two", run: "summarize", with: { name: "${input.name}" } },
            { id: "solo", do: "solo ${input.name}", out: "Result" },
            { id: "combine", do: "combine ${one.output.value} ${two.output.value} ${solo.output.value}", out: "Result" },
          ],
        },
        summarize: {
          input: { name: "string" },
          output: { from: "${digest.output}", contract: "Result" },
          steps: [{ id: "digest", do: "digest ${input.name}", out: "Result" }],
        },
      },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error(`expected ready, got ${planned.status}`);
    expect(planned.ready.map((step) => step.id).sort()).toEqual(["one/digest", "solo", "two/digest"]);
    await e.stepDone(planned.runId, "two/digest", { output: { value: "b" } });
    await e.stepDone(planned.runId, "solo", { output: { value: "c" } });
    const last = await e.stepDone(planned.runId, "one/digest", { output: { value: "a" } });
    expect(last).toMatchObject({ status: "ready", ready: [{ id: "combine", do: "combine a b c" }] });
    if (last.status !== "ready") return;
    expect(await e.stepDone(planned.runId, "combine", { output: { value: "all" } })).toMatchObject({ status: "completed", output: { value: "all" } });
  });

  it("routes namespaced stepDone only to an active child task", async () => {
    const { engine: e } = await engine();
    const planned = await e.plan(subflowSpec(), { name: "x", payload: {} });
    if (planned.status !== "ready") throw new Error("expected child ready");
    for (const id of ["digest", "wrap", "missing/digest", "wrap/missing", "wrap/digest/extra"]) {
      await expect(e.stepDone(planned.runId, id, { output: { value: "bad" } })).rejects.toThrow("step is not awaiting a client result");
    }
    expect((await e.stepDone(planned.runId, "wrap/digest", { output: { value: "ok" } })).status).toBe("ready");
    await expect(e.stepDone(planned.runId, "wrap/digest", { output: { value: "again" } })).rejects.toThrow("step is not awaiting a client result");
  });

  it("rejects client-reported child dispatches while preserving engine accounting", async () => {
    const { engine: e } = await engine();
    const planned = await e.plan(subflowSpec(), { name: "x", payload: {} });
    if (planned.status !== "ready") throw new Error("expected child ready");
    const retry = await e.stepDone(planned.runId, "wrap/digest", {
      output: { value: "bad-accounting" }, usage: { dispatches: 99, tokens: 5 },
    });
    expect(retry).toMatchObject({
      status: "ready",
      ready: [{ id: "wrap/digest", attempt: 2, previousFailure: { reason: expect.stringContaining("engine-accounted") } }],
      ledger: { spent: { dispatches: 2, tokens: 5 } },
    });
    const audit = await e.audit(planned.runId);
    expect(audit.steps.wrap?.sub?.steps.digest?.spent).toEqual({ dispatches: 2, tokens: 5 });
  });

  it("keeps on_fail, when, set, ensure, attempts, and iterate inside the child scope", async () => {
    const { engine: e } = await engine();
    const spec = subflowSpec({
      childOutput: "${fallback.output}",
      childSteps: [
        { id: "skip", do: "skip", out: "Result", when: "false" },
        { id: "prep", set: { value: "input.name" }, out: "Result" },
        { id: "primary", after: ["prep"], do: "primary ${prep.output.value}", out: "Result", attempts: 1, ensure: [{ expr: "result.value == 'ok'" }], on_fail: "fallback" },
        { id: "fallback", do: "fallback", out: "Result", iterate: { max: 2, until: "result.value == 'fixed'" } },
      ],
    });
    const planned = await e.plan(spec, { name: "x", payload: {} });
    expect(planned).toMatchObject({ status: "ready", ready: [{ id: "wrap/primary", do: "primary hello x" }] });
    if (planned.status !== "ready") return;
    const routed = await e.stepDone(planned.runId, "wrap/primary", { output: { value: "bad" } });
    expect(routed).toMatchObject({ status: "ready", ready: [{ id: "wrap/fallback", previousFailure: { reason: expect.stringContaining("ensure") } }] });
    const iterated = await e.stepDone(planned.runId, "wrap/fallback", { output: { value: "not-yet" } });
    expect(iterated).toMatchObject({ status: "ready", ready: [{ id: "wrap/fallback", attempt: 2, previousFailure: { reason: expect.stringContaining("iterate until") } }] });
    const parentReady = await e.stepDone(planned.runId, "wrap/fallback", { output: { value: "fixed" } });
    expect(parentReady).toMatchObject({ status: "ready", ready: [{ id: "finish", do: "publish fixed" }] });
    const audit = await e.audit(planned.runId);
    expect(audit.steps.wrap?.sub?.steps.skip?.status).toBe("skipped");
    expect(audit.events.find((event) => event.type === "routed")).toMatchObject({
      stepId: "wrap/primary", detail: { target: "wrap/fallback" },
    });
  });

  it("turns terminal child output-contract failure into the parent run step's on_fail route", async () => {
    const { engine: e } = await engine();
    const spec = {
      version: 1,
      contracts: { Result: resultContract, Loose: { value: "object" } },
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
          input: { name: "string" }, output: { from: "${digest.output}", contract: "Result" },
          steps: [{ id: "digest", do: "digest", out: "Loose", attempts: 1 }],
        },
      },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected child ready");
    const recovery = await e.stepDone(planned.runId, "wrap/digest", { output: { value: { invalid: true } } });
    expect(recovery).toMatchObject({ status: "ready", ready: [{ id: "recovery", previousFailure: { reason: expect.stringContaining("Expected string") } }] });
    const audit = await e.audit(planned.runId);
    expect(audit.steps.wrap?.status).toBe("failed");
    expect(audit.events).toContainEqual(expect.objectContaining({ type: "routed", stepId: "wrap", detail: expect.objectContaining({ target: "recovery" }) }));
  });

  it("resumes a persisted mid-subflow run and re-surfaces namespaced ready tasks", async () => {
    const { root, engine: first } = await engine();
    const planned = await first.plan(subflowSpec(), { name: "x", payload: {} });
    expect(planned).toMatchObject({ status: "ready", ready: [{ id: "wrap/digest" }] });
    const { engine: second } = await engine(root);
    const resumed = await second.resume(planned.runId);
    expect(resumed).toMatchObject({ status: "ready", runId: planned.runId, ready: [{ id: "wrap/digest", attempt: 1 }] });
    expect((await second.audit(planned.runId)).events.at(-1)).toMatchObject({ type: "resumed" });
  });
});
