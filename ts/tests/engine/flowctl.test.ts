import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKPOINT_EXCLUDED, CHECKPOINT_FIELDS, commitCheckpoint, revertCheckpoint } from "../../src/engine/checkpoint.js";
import { StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

const twoStepFlow = {
  version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${second.output}", contract: "Result" }, steps: [
      { id: "first", do: "first", out: "Result" },
      { id: "second", after: ["first"], do: "second", out: "Result" },
    ],
  } },
};

async function subject(root?: string, connector: EngineConnector = async () => ({ output: { value: "done" } })) {
  const stateRoot = root ?? await mkdtemp(join(tmpdir(), "stratum-flowctl-"));
  if (!root) roots.push(stateRoot);
  return tokenEchoingEngine(new StratumEngine({ stateRoot, evaluator: createEvaluator(), connector }));
}

function run(): PersistedRun {
  return {
    id: "run-1",
    spec: { immutable: true },
    input: { name: "Ada" },
    flowName: "main",
    workspaceRoot: "/workspace",
    status: "running",
    output: { nested: { value: "before" } },
    failure: { attempt: 1, reason: "before" },
    flowSpent: { tokens: 2 },
    rounds: 1,
    steps: { build: { status: "ready", attempts: [], spent: {}, output: { nested: { value: "before" } } } },
    events: [{ at: "before", type: "planned", detail: { nested: { value: "before" } } }],
    cancelRequested: false,
    bgDriven: false,
    parallel: { stepId: "build", tasks: [] },
  };
}

describe("checkpoint state", () => {
  it("classifies every PersistedRun field as snapshotted or excluded with a reason", () => {
    const classified = [...CHECKPOINT_FIELDS, ...Object.keys(CHECKPOINT_EXCLUDED)].sort();
    expect(classified).toEqual([
      "bgDriven", "bundle_id", "cancelRequested", "checkpoints", "events", "failure", "flowName", "flowSpent", "generationCounter", "id", "input",
      "output", "parallel", "policy_rules", "policy_rules_version", "policy_verdicts", "revisionDigest", "rounds", "spec", "status", "steps", "workspaceRoot",
    ]);
    expect(Object.values(CHECKPOINT_EXCLUDED).every((reason) => reason.length > 0)).toBe(true);
  });

  it("round-trips every mutable field without touching immutable fields or aliasing either direction", () => {
    const state = run();
    commitCheckpoint(state, "before");
    const snapshot = state.checkpoints!.find((entry) => entry.label === "before")!.snapshot;
    const originalSpec = state.spec;

    (snapshot.output as { nested: { value: string } }).nested.value = "snapshot only";
    expect(state.output).toEqual({ nested: { value: "before" } });
    (snapshot.output as { nested: { value: string } }).nested.value = "before";
    (state.output as { nested: { value: string } }).nested.value = "after";
    state.flowSpent.tokens = 99;
    state.rounds = 9;
    state.steps.build!.output = { nested: { value: "after" } };
    state.events.push({ at: "after", type: "result" });
    state.status = "failed";
    state.spec = { immutable: "changed" };
    expect((snapshot.output as { nested: { value: string } }).nested.value).toBe("before");

    expect(revertCheckpoint(state, "before")).toBe(true);
    expect(state).toMatchObject({
      status: "running", output: { nested: { value: "before" } }, flowSpent: { tokens: 2 }, rounds: 1,
      steps: { build: { output: { nested: { value: "before" } } } }, events: [{ at: "before" }],
    });
    expect(state.spec).not.toBe(originalSpec);
    expect(state.spec).toEqual({ immutable: "changed" });
    (state.output as { nested: { value: string } }).nested.value = "live mutation";
    expect((snapshot.output as { nested: { value: string } }).nested.value).toBe("before");
  });

  it("overwrites the same label and reports a missing label without mutation", () => {
    const state = run();
    commitCheckpoint(state, "same");
    state.output = { nested: { value: "replacement" } };
    commitCheckpoint(state, "same");
    state.output = { nested: { value: "live" } };
    expect(revertCheckpoint(state, "same")).toBe(true);
    expect(state.output).toEqual({ nested: { value: "replacement" } });
    expect(revertCheckpoint(state, "missing")).toBe(false);
    expect(state.output).toEqual({ nested: { value: "replacement" } });
  });
});

describe("checkpoint engine", () => {
  it("commits durably, restores the checkpoint, and silently re-derives the current step", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-flowctl-restart-")); roots.push(root);
    const engine = await subject(root);
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected first ready");
    expect(await engine.commit(planned.runId, "  start  ")).toEqual({
      status: "committed", flow_id: planned.runId, label: "start", step_number: 1,
      current_step_id: "first", checkpoints: ["start"],
    });
    await engine.stepDone(planned.runId, "first", { output: { value: "changed" } });

    const restarted = await subject(root);
    expect(await restarted.revert(planned.runId, " start ")).toMatchObject({
      status: "ready", runId: planned.runId, ready: [{ id: "first" }], reverted_to: "start",
    });
    const restored = await new StateStore(root).load(planned.runId);
    expect(restored.steps.first).toMatchObject({ status: "ready", attempts: [] });
    expect(restored.steps.second).toMatchObject({ status: "pending", attempts: [] });
  });

  it("overwrites labels and reports missing labels in insertion order (Python parity)", async () => {
    const engine = await subject();
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    await engine.commit(planned.runId, "zeta");
    await engine.commit(planned.runId, "alpha");
    await engine.commit(planned.runId, "zeta");
    // Python returns list(checkpoints.keys()) — insertion order, overwrite keeps position.
    await expect(engine.revert(planned.runId, "missing")).rejects.toMatchObject({
      errorType: "checkpoint_not_found", available: ["zeta", "alpha"],
    });
  });

  it("keeps numeric labels in insertion order, not JS numeric-key order", async () => {
    const engine = await subject();
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    // A plain object would enumerate "2" before "10"; the ordered array must not.
    expect((await engine.commit(planned.runId, "10")).checkpoints).toEqual(["10"]);
    expect((await engine.commit(planned.runId, "2")).checkpoints).toEqual(["10", "2"]);
    await expect(engine.revert(planned.runId, "missing")).rejects.toMatchObject({
      errorType: "checkpoint_not_found", available: ["10", "2"],
    });
  });

  it("rejects empty commit labels and unknown runs with Python error types", async () => {
    const engine = await subject();
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    await expect(engine.commit(planned.runId, "  ")).rejects.toMatchObject({ errorType: "invalid_label" });
    await expect(engine.commit("no-such-run", "cp")).rejects.toMatchObject({ errorType: "flow_not_found" });
    await expect(engine.revert("no-such-run", "cp")).rejects.toMatchObject({ errorType: "flow_not_found" });
  });

  it("reverts a terminal (completed) run to a mid-run checkpoint for recovery (Python parity)", async () => {
    const engine = await subject();
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected first ready");
    await engine.commit(planned.runId, "before"); // committed while running, at step "first"
    const second = await engine.stepDone(planned.runId, "first", { output: { value: "first" } });
    if (second.status !== "ready") throw new Error("expected second ready");
    expect((await engine.stepDone(planned.runId, "second", { output: { value: "second" } })).status).toBe("completed");
    // Terminal runs are RETAINED and checkpoint-operable (not flow_not_found): commit works...
    expect((await engine.commit(planned.runId, "post_complete")).status).toBe("committed");
    // ...and reverting to the mid-run checkpoint restores it to re-run "first".
    const reverted = await engine.revert(planned.runId, "before");
    if (reverted.status !== "ready") throw new Error(`expected ready after revert, got ${reverted.status}`);
    expect(reverted.reverted_to).toBe("before");
    expect(reverted.ready.map((step) => step.id)).toEqual(["first"]);
  });

  it("reverts to a post-completion checkpoint, returning the completed envelope (Python parity)", async () => {
    const engine = await subject();
    const planned = await engine.plan(twoStepFlow, { name: "Ada" });
    await engine.stepDone(planned.runId, "first", { output: { value: "first" } });
    expect((await engine.stepDone(planned.runId, "second", { output: { value: "second" } })).status).toBe("completed");
    await engine.commit(planned.runId, "post");
    const reverted = await engine.revert(planned.runId, "post");
    expect(reverted).toMatchObject({ status: "completed", reverted_to: "post" });
  });

  it("refuses commit/revert while a foreground fanout is in flight", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const engine = await subject(undefined, async ({ prompt }) => {
      if (prompt.startsWith("fan")) { started(); await blocked; }
      return { output: { value: prompt } };
    });
    const fanoutSpec = {
      version: 1, contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result", ensure: [{ expr: "result.value != ''" }] }] } }],
      } },
    };
    const planned = await engine.plan(fanoutSpec, { items: ["a"] });
    await dispatched; // fanout worker is in flight and blocked
    await expect(engine.commit(planned.runId, "cp")).rejects.toThrow(/in-flight fanout/);
    await expect(engine.revert(planned.runId, "cp")).rejects.toThrow(/in-flight fanout/);
    release();
    for (let tick = 0; tick < 200; tick += 1) {
      const polled = await engine.flowPoll(planned.runId);
      if (polled.status === "completed" || polled.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  it("reuses the sole-mutator guard for commit and revert on a bg-driven run", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatched = new Promise<void>((resolve) => { started = resolve; });
    const engine = await subject(undefined, async () => { started(); await blocked; return { output: { value: "done" } }; });
    const bg = await engine.flowRunBg(twoStepFlow, { name: "Ada" });
    await dispatched;
    await expect(engine.commit(bg.runId, "cp")).rejects.toThrow(/background-driven/);
    await expect(engine.revert(bg.runId, "cp")).rejects.toThrow(/background-driven/);
    await engine.flowCancelBg(bg.runId);
    release();
    for (let tick = 0; tick < 100; tick += 1) {
      if ((await engine.flowBgPoll(bg.runId)).bg.status === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("background flow did not cancel");
  });
});
