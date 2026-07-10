import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/stratum.js";
import { StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function captureMain(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return main(argv).then((code) => ({ code, stdout, stderr })).finally(() => { process.stdout.write = out; process.stderr.write = err; });
}

async function engine(root?: string): Promise<{ root: string; engine: StratumEngine }> {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-query-gate-"));
  if (!root) roots.push(stateRoot);
  const connector: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });
  return { root: stateRoot, engine: new StratumEngine({ stateRoot, evaluator: createEvaluator(), connector }) };
}

async function withStateRoot<T>(root: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.STRATUM_STATE_ROOT;
  process.env.STRATUM_STATE_ROOT = root;
  try { return await action(); } finally {
    if (previous === undefined) delete process.env.STRATUM_STATE_ROOT;
    else process.env.STRATUM_STATE_ROOT = previous;
  }
}

const simpleFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: {}, output: { from: "${work.output}", contract: "Result" },
    steps: [{ id: "work", do: "write report", out: "Result", attempts: 1 }],
  } },
};

const gateFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "review_flow", review_flow: {
    input: {}, output: { from: "${work.output}", contract: "Result" },
    steps: [
      { id: "work", do: "write report", out: "Result" },
      { id: "review", after: ["work"], gate: { on_approve: null, on_revise: null, on_kill: null } },
    ],
  } },
};

const gateWithContinuationFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "review_flow", review_flow: {
    input: {}, output: { from: "${finish.output}", contract: "Result" },
    steps: [
      { id: "work", do: "write report", out: "Result" },
      { id: "review", after: ["work"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
      { id: "finish", after: ["review"], do: "finish report", out: "Result" },
    ],
  } },
};

const failingEnsureFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: {}, output: { from: "${work.output}", contract: "Result" },
    steps: [{ id: "work", do: "write report", out: "Result", attempts: 1, ensure: [{ expr: "result.value == 'expected'" }] }],
  } },
};

const tinyBudgetFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: {}, output: { from: "${work.output}", contract: "Result" }, budget: { tokens: 1 },
    steps: [{ id: "work", do: "write report", out: "Result" }],
  } },
};

async function pendingGate(subject: StratumEngine): Promise<string> {
  const planned = await subject.plan(gateFlow, {});
  if (planned.status !== "ready") throw new Error("expected work ready");
  await subject.stepDone(planned.runId, "work", { output: { value: "done" } });
  return planned.runId;
}

describe("CLI query and gate compatibility", () => {
  it("lists running and completed persisted flows using compose status vocabulary", async () => {
    const { root, engine: subject } = await engine();
    const running = await subject.plan(simpleFlow, {});
    const complete = await subject.plan(simpleFlow, {});
    if (complete.status !== "ready") throw new Error("expected work ready");
    await subject.stepDone(complete.runId, "work", { output: { value: "done" } });

    const result = await withStateRoot(root, () => captureMain(["query", "flows"]));
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ flow_id: running.runId, flow_name: "main", status: "running", current_step_id: "work", step_count: 1, completed_steps: 0, round: 0, terminal_status: null, synthetic: false }),
      expect.objectContaining({ flow_id: complete.runId, status: "complete", current_step_id: null, completed_steps: 1, terminal_status: "completed" }),
    ]));
  });

  it("returns flow detail with honest ordered-step modes and reports missing runs", async () => {
    const { root, engine: subject } = await engine();
    const planned = await subject.plan(gateWithContinuationFlow, {});
    if (planned.status !== "ready") throw new Error("expected work ready");
    await subject.stepDone(planned.runId, "work", { output: { value: "done" } });
    const runId = planned.runId;
    const detail = await withStateRoot(root, () => captureMain(["query", "flow", runId]));
    expect(detail).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(detail.stdout)).toMatchObject({
      flow_id: runId,
      flow_name: "review_flow",
      status: "awaiting_gate",
      current_step_id: "review",
      ordered_steps: [{ id: "work", function: "write report", mode: "step" }, { id: "review", function: "review", mode: "gate" }, { id: "finish", function: "finish report", mode: "step" }],
    });

    const missing = await withStateRoot(root, () => captureMain(["query", "flow", "missing"]));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ error: { code: "NOT_FOUND", message: "Flow 'missing' not found" } });
  });

  it("lists pending gates and approves exactly once through the persisted engine", async () => {
    const { root, engine: subject } = await engine();
    const runId = await pendingGate(subject);
    const gates = await withStateRoot(root, () => captureMain(["query", "gates"]));
    expect(gates).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(gates.stdout)).toEqual([{
      _schema_version: "1", flow_id: runId, flow_name: "review_flow", step_id: "review", function: "review",
      on_approve: null, on_revise: null, on_kill: null, timeout: null,
    }]);

    // While the gate awaits, targeting a non-current (already succeeded) step
    // is a wrong_step CONFLICT — Python parity, exit 2 not not_a_gate_step.
    const wrongStep = await withStateRoot(root, () => captureMain(["gate", "approve", runId, "work"]));
    expect(wrongStep.code).toBe(2);
    expect(JSON.parse(wrongStep.stdout)).toMatchObject({ conflict: true, flow_id: runId, step_id: "work" });

    const approved = await withStateRoot(root, () => captureMain(["gate", "approve", runId, "review", "--note", "looks good", "--resolved-by", "human"]));
    expect(approved).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(approved.stdout)).toEqual({ _schema_version: "1", ok: true, flow_id: runId, step_id: "review", outcome: "approve", result: "complete" });

    const conflict = await withStateRoot(root, () => captureMain(["gate", "approve", runId, "review"]));
    expect(conflict.code).toBe(2);
    expect(JSON.parse(conflict.stdout)).toMatchObject({ conflict: true, flow_id: runId, step_id: "review" });

    // Any step on a finished flow is a flow_already_complete CONFLICT.
    const completedFlow = await withStateRoot(root, () => captureMain(["gate", "approve", runId, "work"]));
    expect(completedFlow.code).toBe(2);
    expect(JSON.parse(completedFlow.stdout)).toMatchObject({ conflict: true, detail: "Flow is already complete" });

    const missing = await withStateRoot(root, () => captureMain(["gate", "approve", "missing", "review"]));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ error: { code: "NOT_FOUND", message: "Flow 'missing' not found" } });
  });

  it("reports execute_step for routed decisions even when the route completes synchronously", async () => {
    const { root, engine: subject } = await engine();
    const planned = await subject.plan(gateWithContinuationFlow, {});
    if (planned.status !== "ready") throw new Error("expected work ready");
    await subject.stepDone(planned.runId, "work", { output: { value: "done" } });

    const approved = await withStateRoot(root, () => captureMain(["gate", "approve", planned.runId, "review"]));
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.stdout)).toMatchObject({ ok: true, outcome: "approve", result: "execute_step" });
  });

  it("rejects revise on a gate without an on_revise route as missing_on_revise", async () => {
    const { root, engine: subject } = await engine();
    const runId = await pendingGate(subject); // gateFlow: on_revise null, no max_rounds pressure
    const revised = await withStateRoot(root, () => captureMain(["gate", "revise", runId, "review"]));
    expect(revised.code).toBe(1);
    expect(JSON.parse(revised.stdout)).toMatchObject({ error: { code: "missing_on_revise" } });

    // The refusal must not have terminalized the run — the gate still awaits.
    const gates = await withStateRoot(root, () => captureMain(["query", "gates"]));
    expect(JSON.parse(gates.stdout)).toHaveLength(1);
  });

  it("reports not_a_gate_step only for the current non-gate step", async () => {
    const { root, engine: subject } = await engine();
    const planned = await subject.plan(gateFlow, {});
    if (planned.status !== "ready") throw new Error("expected work ready");
    // "work" is the CURRENT (ready) step and is not a gate → Python parity error exit 1.
    const notGate = await withStateRoot(root, () => captureMain(["gate", "approve", planned.runId, "work"]));
    expect(notGate.code).toBe(1);
    expect(JSON.parse(notGate.stdout)).toMatchObject({ error: { code: "not_a_gate_step" } });
  });

  it("maps reject to kill and projects the terminal run as killed", async () => {
    const { root, engine: subject } = await engine();
    const runId = await pendingGate(subject);
    const rejected = await withStateRoot(root, () => captureMain(["gate", "reject", runId, "review"]));
    expect(rejected).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(rejected.stdout)).toEqual({ _schema_version: "1", ok: true, flow_id: runId, step_id: "review", outcome: "kill", result: "killed" });

    const detail = await withStateRoot(root, () => captureMain(["query", "flow", runId]));
    expect(JSON.parse(detail.stdout)).toMatchObject({ status: "killed", terminal_status: "failed" });
  });

  it("projects real failed and budget-exhausted runs and ignores a corrupt run file", async () => {
    const { root, engine: subject } = await engine();
    const failed = await subject.plan(failingEnsureFlow, {});
    if (failed.status !== "ready") throw new Error("expected failed flow work ready");
    await subject.stepDone(failed.runId, "work", { output: { value: "wrong" } });
    const exhausted = await subject.plan(tinyBudgetFlow, {});
    if (exhausted.status !== "ready") throw new Error("expected budget flow work ready");
    await subject.stepDone(exhausted.runId, "work", { output: { value: "done" }, usage: { tokens: 2 } });
    await writeFile(join(root, "corrupt.json"), "this is not JSON", "utf8");

    const flows = await withStateRoot(root, () => captureMain(["query", "flows"]));
    expect(flows.code).toBe(0);
    expect(JSON.parse(flows.stdout)).toEqual(expect.arrayContaining([
      expect.objectContaining({ flow_id: failed.runId, status: "failed", terminal_status: "failed" }),
      expect.objectContaining({ flow_id: exhausted.runId, status: "budget_exhausted", terminal_status: "budget_exhausted" }),
    ]));

    const failedDetail = await withStateRoot(root, () => captureMain(["query", "flow", failed.runId]));
    expect(JSON.parse(failedDetail.stdout)).toMatchObject({ status: "failed", terminal_status: "failed" });
    const exhaustedDetail = await withStateRoot(root, () => captureMain(["query", "flow", exhausted.runId]));
    expect(JSON.parse(exhaustedDetail.stdout)).toMatchObject({ status: "budget_exhausted", terminal_status: "budget_exhausted" });
  });

  it("does not derive killed from a task failure reason that resembles a gate kill", async () => {
    const { root, engine: subject } = await engine();
    const planned = await subject.plan(simpleFlow, {});
    if (planned.status !== "ready") throw new Error("expected work ready");
    await subject.stepDone(planned.runId, "work", { failure: "gate review killed flow" });

    const detail = await withStateRoot(root, () => captureMain(["query", "flow", planned.runId]));
    expect(JSON.parse(detail.stdout)).toMatchObject({ status: "failed", terminal_status: "failed" });
  });

  it("reports no current step for terminal runs", async () => {
    const { root, engine: subject } = await engine();
    const runId = await pendingGate(subject);
    await withStateRoot(root, () => captureMain(["gate", "reject", runId, "review"]));

    const detail = await withStateRoot(root, () => captureMain(["query", "flow", runId]));
    expect(JSON.parse(detail.stdout)).toMatchObject({ status: "killed", current_step_id: null });
  });

  it("skips semantically corrupt run documents without aborting the listing", async () => {
    const { root, engine: subject } = await engine();
    const real = await subject.plan(simpleFlow, {});
    await writeFile(join(root, "empty-object.json"), "{}", "utf8");

    const flows = await withStateRoot(root, () => captureMain(["query", "flows"]));
    expect(flows.code).toBe(0);
    expect(flows.stderr).toContain("empty-object");
    expect(JSON.parse(flows.stdout)).toEqual([
      expect.objectContaining({ flow_id: real.runId, status: "running" }),
    ]);
  });

  it("does not derive killed from a spec the validator rejects", async () => {
    const { root } = await engine();
    // Hand-forged terminal run: the failure mimics a canonical gate kill and the
    // spec carries a fake gate step, but the spec does not validate.
    const forged = {
      id: "forged-run-0001",
      flowName: "main",
      status: "failed",
      failure: { attempt: 0, reason: "gate review killed flow" },
      steps: { review: { status: "succeeded", attempts: [] } },
      spec: { version: 1, flows: { entry: "main", main: { steps: [{ id: "review", gate: { on_approve: null, on_revise: null, on_kill: null } }] } } },
      events: [],
    };
    await writeFile(join(root, "forged-run-0001.json"), JSON.stringify(forged), "utf8");

    const detail = await withStateRoot(root, () => captureMain(["query", "flow", "forged-run-0001"]));
    expect(JSON.parse(detail.stdout)).toMatchObject({ status: "failed" });
  });
});
