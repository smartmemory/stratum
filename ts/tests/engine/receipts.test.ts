import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type EngineConnector, type JudgeRunner } from "../../src/engine/engine.js";
import { buildReceipt, ReceiptValidationError, spineSpent } from "../../src/engine/receipts.js";
import { StateStore, type AuditEvent, type PersistedRun } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(options: { connector?: EngineConnector; judge?: JudgeRunner } = {}): Promise<{
  engine: TokenEchoingEngine;
  store: StateStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "stratum-receipts-"));
  roots.push(root);
  const store = new StateStore(root);
  const engine = tokenEchoingEngine(new StratumEngine({
    stateRoot: root,
    evaluator: createEvaluator(),
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.judge ? { judge: options.judge } : {}),
  }));
  return { engine, store };
}

function receiptRun(): PersistedRun {
  return {
    id: "run-1",
    spec: {},
    input: {},
    flowName: "main",
    status: "running",
    flowSpent: {},
    steps: {},
    events: [],
  };
}

function linearSpec(options: { flowBudget?: Record<string, number>; taskBudget?: Record<string, number>; twoSteps?: boolean } = {}) {
  const second = options.twoSteps
    ? [{ id: "second", after: ["first"], do: "second", out: "Result", ...(options.taskBudget ? { budget: options.taskBudget } : {}) }]
    : [];
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { name: "string" },
        output: { from: options.twoSteps ? "${second.output}" : "${first.output}", contract: "Result" },
        ...(options.flowBudget ? { budget: options.flowBudget } : {}),
        steps: [
          { id: "first", do: "first", out: "Result", ...(options.taskBudget ? { budget: options.taskBudget } : {}) },
          ...second,
        ],
      },
    },
  };
}

async function waitForTerminal(engine: StratumEngine, runId: string) {
  for (let tick = 0; tick < 200; tick += 1) {
    const poll = await engine.flowPoll(runId, 0);
    if (poll.status !== "running") return poll;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("flow did not finish");
}

function usageDebits(events: AuditEvent[]) {
  return events.filter((event) => event.type === "usage_debit");
}

describe("receipt builder", () => {
  it("rejects dispatches because dispatch counts are engine-accounted", () => {
    expect(() => buildReceipt(receiptRun(), {
      dispatchId: "dispatch-1", source: "client", usage: { tokens: 2, dispatches: 1 },
    })).toThrowError(ReceiptValidationError);
    expect(() => buildReceipt(receiptRun(), {
      dispatchId: "dispatch-1", source: "client", usage: { tokens: 2, dispatches: 1 },
    })).toThrow(/dispatches/);
  });

  it("requires usdSource whenever usage contains usd", () => {
    expect(() => buildReceipt(receiptRun(), {
      dispatchId: "dispatch-1", source: "client", usage: { usd: 0.02 },
    })).toThrowError(ReceiptValidationError);
    expect(() => buildReceipt(receiptRun(), {
      dispatchId: "dispatch-1", source: "client", usage: { usd: 0.02 },
    })).toThrow(/usdSource/);
  });

  it("defaults absent telemetry and allocates strictly increasing receipt sequences", () => {
    const run = receiptRun();
    const first = buildReceipt(run, { dispatchId: "dispatch-1", source: "client", usage: { tokens: 2 } });
    const second = buildReceipt(run, {
      dispatchId: "dispatch-2", source: "client", usage: { tokens: 3 },
      telemetry: { model: "fixture", durationMs: 4 },
    });
    expect(first).toMatchObject({ seq: 1, telemetry: { model: "unknown", durationMs: 0 }, egress: "pending" });
    expect(second).toMatchObject({ seq: 2, telemetry: { model: "fixture", durationMs: 4 }, egress: "pending" });
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(run.receiptCounter).toBe(2);
    run.receipts = [first, second];
    expect(spineSpent(run)).toEqual({ tokens: 5 });
  });
});

describe("StratumEngine usage receipts", () => {
  it("returns duplicate without changing the ledger, event stream, or receipt spine", async () => {
    const { engine, store } = await subject();
    const planned = await engine.plan(linearSpec(), { name: "x" });
    const receipt = { dispatchId: "same-call", source: "client", usage: { tokens: 5 } };
    const first = await engine.usageReport(planned.runId, receipt);
    const beforeAudit = await engine.audit(planned.runId);
    const beforeRun = await store.load(planned.runId);
    const duplicate = await engine.usageReport(planned.runId, receipt);
    const afterAudit = await engine.audit(planned.runId);
    const afterRun = await store.load(planned.runId);

    expect(first).toMatchObject({ status: "ok", seq: 1, ledger: { spent: { tokens: 5 } } });
    expect(duplicate).toEqual({ status: "duplicate", runId: planned.runId, seq: 1, ledger: first.ledger });
    expect(afterAudit.flowSpent).toEqual(beforeAudit.flowSpent);
    expect(afterAudit.events).toEqual(beforeAudit.events);
    expect(afterRun.receipts).toEqual(beforeRun.receipts);
    expect(usageDebits(afterAudit.events)).toHaveLength(1);
  });

  it("records a late terminal-run receipt without changing terminal status", async () => {
    const { engine, store } = await subject();
    const planned = await engine.plan(linearSpec({ flowBudget: { tokens: 1 } }), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected first ready");
    expect((await engine.stepDone(planned.runId, "first", { output: { value: "done" } })).status).toBe("completed");

    const reported = await engine.usageReport(planned.runId, {
      dispatchId: "late-call", source: "client", usage: { tokens: 2 },
    });
    expect(reported).toMatchObject({ status: "ok", budget: "flow_exhausted_after_terminal", ledger: { spent: { tokens: 2 } } });
    expect((await engine.audit(planned.runId)).status).toBe("completed");
    expect((await store.load(planned.runId)).receipts).toHaveLength(1);
  });

  it("terminalizes only a running flow-level exhaustion and reports lower-scope exhaustion without failing the attempt", async () => {
    const flow = await subject();
    const flowPlan = await flow.engine.plan(linearSpec({ flowBudget: { tokens: 1 } }), { name: "x" });
    expect(await flow.engine.usageReport(flowPlan.runId, {
      dispatchId: "flow-over", source: "client", usage: { tokens: 2 },
    })).toMatchObject({ status: "ok", budget: "flow_exhausted" });
    expect((await flow.engine.audit(flowPlan.runId)).status).toBe("budget_exhausted");

    const task = await subject();
    const taskPlan = await task.engine.plan(linearSpec({ flowBudget: { tokens: 20 }, taskBudget: { tokens: 1 } }), { name: "x" });
    expect(await task.engine.usageReport(taskPlan.runId, {
      dispatchId: "task-over", stepId: "first", source: "client", usage: { tokens: 2 },
    })).toMatchObject({ status: "ok", budget: "task_exhausted" });
    const taskAudit = await task.engine.audit(taskPlan.runId);
    expect(taskAudit.status).toBe("running");
    expect(taskAudit.steps.first?.spent).toMatchObject({ tokens: 2 });

    const subflow = await subject();
    const subflowSpec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { name: "string" }, output: { from: "${wrap.output}", contract: "Result" }, budget: { tokens: 20 },
          steps: [{ id: "wrap", run: "child", with: { name: "${input.name}" }, budget: { tokens: 1 } }],
        },
        child: {
          input: { name: "string" }, output: { from: "${work.output}", contract: "Result" },
          steps: [{ id: "work", do: "work", out: "Result" }],
        },
      },
    };
    const subflowPlan = await subflow.engine.plan(subflowSpec, { name: "x" });
    expect(await subflow.engine.usageReport(subflowPlan.runId, {
      dispatchId: "subflow-over", stepId: "wrap/work", source: "client", usage: { tokens: 2 },
    })).toMatchObject({ status: "ok", budget: "subflow_exhausted" });
    const subflowAudit = await subflow.engine.audit(subflowPlan.runId);
    expect(subflowAudit.status).toBe("running");
    expect(subflowAudit.steps.wrap?.spent).toMatchObject({ tokens: 2 });
    expect(subflowAudit.steps.wrap?.sub?.steps.work?.spent).toMatchObject({ tokens: 2 });
  });

  it("charges a gate receipt to flow only", async () => {
    const { engine } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${build.output}", contract: "Result" }, budget: { tokens: 20 }, max_rounds: 1,
        steps: [
          { id: "build", do: "build", out: "Result" },
          { id: "review", after: ["build"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    await engine.stepDone(planned.runId, "build", { output: { value: "done" } });
    const result = await engine.usageReport(planned.runId, {
      dispatchId: "gate-call", stepId: "review", source: "gate_qa", usage: { tokens: 3 },
    });
    const audit = await engine.audit(planned.runId);
    expect(result).toMatchObject({ status: "ok", ledger: { spent: { tokens: 3 } } });
    expect(result).not.toHaveProperty("budget");
    expect(audit.steps.review?.spent).toEqual({});
  });

  it("rejects an unknown attributed step with a typed validation error", async () => {
    const { engine } = await subject();
    const planned = await engine.plan(linearSpec(), { name: "x" });
    await expect(engine.usageReport(planned.runId, {
      dispatchId: "unknown-step", stepId: "missing", source: "client", usage: { tokens: 1 },
    })).rejects.toMatchObject({ name: "ReceiptValidationError", errorType: "invalid_step" });
  });

  it("persists the unknown telemetry default on an accepted report", async () => {
    const { engine, store } = await subject();
    const planned = await engine.plan(linearSpec(), { name: "x" });
    await engine.usageReport(planned.runId, { dispatchId: "no-telemetry", source: "client", usage: { ms: 7 } });
    const run = await store.load(planned.runId);
    expect(run.receipts?.[0]?.telemetry).toEqual({ model: "unknown", durationMs: 0 });
    expect(usageDebits(run.events)[0]?.detail).toMatchObject({ model: "unknown", durationMs: 0 });
  });

  it("emits exactly one usage_debit for each ordinary, fanout, and judged legacy debit", async () => {
    const ordinary = await subject();
    const ordinaryPlan = await ordinary.engine.plan(linearSpec(), { name: "x" });
    if (ordinaryPlan.status !== "ready") throw new Error("expected ordinary step");
    await ordinary.engine.stepDone(ordinaryPlan.runId, "first", {
      output: { value: "done" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 3 },
    });
    const ordinaryEvents = usageDebits((await ordinary.engine.audit(ordinaryPlan.runId)).events);
    expect(ordinaryEvents).toHaveLength(1);
    expect(ordinaryEvents[0]?.detail).toMatchObject({ source: "step_done", model: "worker", amount: { tokens: 2 } });

    const fanout = await subject({ connector: async ({ prompt }) => ({
      output: { value: prompt }, usage: { tokens: 3 }, telemetry: { model: "fanout-worker", durationMs: 4 },
    }) });
    const fanoutSpec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      } },
    };
    const fanoutPlan = await fanout.engine.plan(fanoutSpec, { items: ["a"] });
    await waitForTerminal(fanout.engine, fanoutPlan.runId);
    const fanoutEvents = usageDebits((await fanout.engine.audit(fanoutPlan.runId)).events);
    expect(fanoutEvents).toHaveLength(1);
    {
      const run = await fanout.store.load(fanoutPlan.runId);
      expect(costOnly(spineSpent(run))).toEqual(costOnly(run.flowSpent));
    }
    expect(fanoutEvents[0]?.detail).toMatchObject({
      source: "fanout", model: "fanout-worker", amount: { tokens: 3 }, item: { itemIndex: 0, stage: 0, generation: 1 },
    });

    const judged = await subject({ judge: async () => ({
      holds: true, reason: "sound", model: "judge-model", usage: { tokens: 5, usd: 0.04 },
    }) });
    const judgedSpec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${checked.output}", contract: "Result" },
        steps: [{ id: "checked", do: "checked", out: "Result", ensure: [{ judged: { statement: "sound", stakes: "cheap" } }] }],
      } },
    };
    const judgedPlan = await judged.engine.plan(judgedSpec, { name: "x" });
    if (judgedPlan.status !== "ready") throw new Error("expected judged step");
    await judged.engine.stepDone(judgedPlan.runId, "checked", { output: { value: "done" } });
    const judgedEvents = usageDebits((await judged.engine.audit(judgedPlan.runId)).events);
    expect(judgedEvents).toHaveLength(1);
    {
      const run = await judged.store.load(judgedPlan.runId);
      expect(costOnly(spineSpent(run))).toEqual(costOnly(run.flowSpent));
    }
    expect(judgedEvents[0]?.detail).toMatchObject({
      source: "judged", model: "judge-model", amount: { tokens: 5, usd: 0.04 }, usdSource: "legacy",
    });
  });

  it('rejects client receipts in the reserved "legacy:" namespace', async () => {
    const { engine } = await subject();
    const planned = await engine.plan(linearSpec(), { name: "x" });
    await expect(engine.usageReport(planned.runId, { dispatchId: "legacy:2", source: "client", usage: { tokens: 1 } }))
      .rejects.toThrow(/reserved/);
  });

  it("still settles a judge-reported dispatch against the ledger without a receipt", async () => {
    const judged = await subject({ judge: async () => ({
      holds: true, reason: "sound", model: "judge-model", usage: { dispatches: 1, tokens: 5 },
    }) });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${checked.output}", contract: "Result" },
        steps: [{ id: "checked", do: "checked", out: "Result", ensure: [{ judged: { statement: "sound", stakes: "cheap" } }] }],
      } },
    };
    const planned = await judged.engine.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected judged step");
    await judged.engine.stepDone(planned.runId, "checked", { output: { value: "done" } });
    const run = await judged.store.load(planned.runId);
    expect(run.flowSpent.dispatches).toBe(2); // engine reservation + judge-reported dispatch
    expect(usageDebits(run.events)).toHaveLength(1);
    expect(usageDebits(run.events)[0]?.detail).toMatchObject({ amount: { tokens: 5 } });
    expect(spineSpent(run).dispatches).toBeUndefined();
  });

  it("keeps the judged per-item fanout_ledger_debit event complete, dispatches included", async () => {
    const judged = await subject({
      connector: async ({ prompt }) => ({ output: { value: prompt }, usage: { tokens: 3 }, telemetry: { model: "fanout-worker", durationMs: 4 } }),
      judge: async () => ({ holds: true, reason: "sound", model: "", usage: { dispatches: 1, tokens: 5 } }),
    });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result", ensure: [{ judged: { statement: "sound", stakes: "cheap" } }] }],
        } }],
      } },
    };
    const planned = await judged.engine.plan(spec, { items: ["a"] });
    await waitForTerminal(judged.engine, planned.runId);
    const run = await judged.store.load(planned.runId);
    const judgedItemDebits = run.events.filter((event) => event.type === "fanout_ledger_debit"
      && (event.detail as { source?: string }).source === "judged");
    expect(judgedItemDebits).toHaveLength(1);
    expect((judgedItemDebits[0]?.detail as { amount: unknown }).amount).toEqual({ dispatches: 1, tokens: 5 });
    const judgedReceipts = usageDebits(run.events).filter((event) => (event.detail as { source: string }).source === "judged");
    expect(judgedReceipts).toHaveLength(1);
    expect(judgedReceipts[0]?.detail).toMatchObject({ model: "unknown", amount: { tokens: 5 } });
    expect(run.status).toBe("completed");
  });

  it("names the in-flight attempt for a receipt on a consumer fanout item awaiting its result", async () => {
    const { engine } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      } },
    };
    const planned = await engine.plan(spec, { items: ["a"] });
    if (planned.status !== "ready") throw new Error("expected a consumer item to be ready");
    const reported = await engine.usageReport(planned.runId, {
      dispatchId: "consumer-call-1", stepId: "fan/0", source: "consumer", usage: { tokens: 4 },
      telemetry: { model: "consumer-worker", durationMs: 9 },
    });
    expect(reported.status).toBe("ok");
    const events = usageDebits((await engine.audit(planned.runId)).events);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ attempt: 1, item: { itemIndex: 0 } });
  });

  it("keeps usage_debit cost totals equal to flow cost spend", async () => {
    const { engine } = await subject();
    const planned = await engine.plan(linearSpec({ twoSteps: true }), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected first step");
    const second = await engine.stepDone(planned.runId, "first", {
      output: { value: "one" }, usage: { tokens: 2, ms: 10 }, telemetry: { model: "one", durationMs: 10 },
    });
    if (second.status !== "ready") throw new Error("expected second step");
    await engine.stepDone(planned.runId, "second", {
      output: { value: "two" }, usage: { tokens: 3, usd: 0.02 }, telemetry: { model: "two", durationMs: 20 },
    });
    const audit = await engine.audit(planned.runId);
    const totals = usageDebits(audit.events).reduce((sum, event) => {
      const amount = (event.detail as { amount: Record<string, number> }).amount;
      for (const key of ["tokens", "usd", "ms"] as const) sum[key] += amount[key] ?? 0;
      return sum;
    }, { tokens: 0, usd: 0, ms: 0 });
    expect(totals).toEqual({
      tokens: audit.flowSpent.tokens ?? 0,
      usd: audit.flowSpent.usd ?? 0,
      ms: audit.flowSpent.ms ?? 0,
    });
  });
});

function costOnly(budget: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["tokens", "usd", "ms"]) if (budget[key] !== undefined && budget[key] !== 0) out[key] = budget[key]!;
  return out;
}
