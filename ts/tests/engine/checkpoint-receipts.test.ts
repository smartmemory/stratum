import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import type { Budget } from "../../src/engine/ledger.js";
import { spineSpent } from "../../src/engine/receipts.js";
import { StateStore, type AuditEvent } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(): Promise<{ engine: TokenEchoingEngine; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "stratum-checkpoint-receipts-"));
  roots.push(root);
  return {
    engine: tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator() })),
    store: new StateStore(root),
  };
}

function usageDebits(events: AuditEvent[]): AuditEvent[] {
  return events.filter((event) => event.type === "usage_debit");
}

function costOnly(budget: Budget): Budget {
  const { dispatches: _dispatches, ...cost } = budget;
  return cost;
}

describe("receipt spine across corrections", () => {
  it("emits one scoped step_reset without erasing prior usage or cumulative flow spend", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { name: "string" },
          output: { from: "${wrap.output}", contract: "Result" },
          max_rounds: 1,
          steps: [
            { id: "build", do: "build", out: "Result" },
            { id: "wrap", after: ["build"], run: "child", with: { name: "${input.name}" } },
            { id: "review", after: ["wrap"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
          ],
        },
        child: {
          input: { name: "string" },
          output: { from: "${work.output}", contract: "Result" },
          steps: [{ id: "work", do: "work", out: "Result" }],
        },
      },
    };

    const planned = await engine.plan(spec, { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    const child = await engine.stepDone(planned.runId, "build", {
      output: { value: "draft" }, usage: { tokens: 3 }, telemetry: { model: "builder", durationMs: 4 },
    });
    expect(child).toMatchObject({ status: "ready", ready: [{ id: "wrap/work" }] });
    await engine.stepDone(planned.runId, "wrap/work", {
      output: { value: "checked" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 5 },
    });
    const before = await store.load(planned.runId);
    const priorDebits = usageDebits(before.events);
    const gateToken = before.steps.review?.gateToken;
    expect(gateToken).toEqual(expect.any(String));
    expect(before.steps.wrap?.sub).toBeDefined();

    expect(await engine.gateResolve(planned.runId, "review", "revise", gateToken!)).toMatchObject({
      status: "ready", ready: [{ id: "build", epoch: 1 }],
    });
    const after = await store.load(planned.runId);
    expect(usageDebits(after.events)).toEqual(priorDebits);
    expect(after.events.filter((event) => event.type === "step_reset")).toEqual([
      expect.objectContaining({
        type: "step_reset",
        stepId: "build",
        detail: {
          reason: "revise",
          reset: [
            { stepId: "build", fromEpoch: 0, toEpoch: 1 },
            { stepId: "wrap", fromEpoch: 0, toEpoch: 1 },
            { stepId: "review", fromEpoch: 0, toEpoch: 1 },
          ],
          subflowsDropped: ["wrap"],
        },
      }),
    ]);
    expect(costOnly(after.steps.build?.spent ?? {})).toEqual({});
    expect(after.steps.build?.spent.dispatches).toBe(1);
    expect(after.steps.wrap?.sub).toBeUndefined();
    expect(after.flowSpent.tokens).toBe(5);
    expect(after.receipts?.find((receipt) => receipt.source === "engine" && receipt.dispatchId.startsWith("engine:step_reset:")))
      .toMatchObject({ amount: {} });
  });

  it("keeps receipts monotonic and restores live step spend while reverting a checkpoint", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" },
        output: { from: "${second.output}", contract: "Result" },
        steps: [
          { id: "first", do: "first", out: "Result" },
          { id: "second", after: ["first"], do: "second", out: "Result" },
        ],
      } },
    };

    const planned = await engine.plan(spec, { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected first ready");
    const second = await engine.stepDone(planned.runId, "first", {
      output: { value: "first" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 3 },
    });
    expect(second).toMatchObject({ status: "ready", ready: [{ id: "second" }] });
    await engine.commit(planned.runId, "cp");
    const afterCheckpoint = await engine.usageReport(planned.runId, {
      dispatchId: "client-after-checkpoint", stepId: "first", source: "client", usage: { tokens: 5 },
    });
    expect(afterCheckpoint).toMatchObject({ status: "ok", seq: 2 });

    expect(await engine.revert(planned.runId, "cp")).toMatchObject({
      status: "ready", reverted_to: "cp", ready: [{ id: "second" }],
    });
    const reverted = await store.load(planned.runId);
    expect(reverted.receipts?.find((receipt) => receipt.dispatchId === "client-after-checkpoint"))
      .toMatchObject({ seq: 2, amount: { tokens: 5 } });
    expect(costOnly(reverted.flowSpent)).toEqual(costOnly(spineSpent(reverted)));
    expect(reverted.steps.first?.spent).toMatchObject({ tokens: 2 });
    expect(reverted.events.filter((event) => event.type === "checkpoint_reverted")).toEqual([
      expect.objectContaining({
        type: "checkpoint_reverted",
        detail: { label: "cp", receiptsAtRevert: 2, stepsRestored: ["first", "second"] },
      }),
    ]);

    const engineReceipt = reverted.receipts?.find((receipt) => receipt.source === "engine");
    expect(engineReceipt).toMatchObject({ seq: 3, dispatchId: "engine:checkpoint_reverted:3", amount: {} });
    expect(usageDebits(reverted.events).some((event) =>
      (event.detail as { seq?: number } | undefined)?.seq === engineReceipt?.seq)).toBe(false);

    const fresh = await engine.usageReport(planned.runId, {
      dispatchId: "client-after-revert", stepId: "second", source: "client", usage: { tokens: 7 },
    });
    expect(fresh).toMatchObject({ status: "ok", seq: 4 });
    expect(fresh.status).not.toBe("duplicate");
    expect((await engine.stepDone(planned.runId, "second", {
      output: { value: "second" }, usage: { tokens: 11 }, telemetry: { model: "worker", durationMs: 6 },
    })).status).toBe("completed");
    const finished = await store.load(planned.runId);
    expect(finished.receipts?.at(-1)).toMatchObject({ seq: 5, source: "step_done", amount: { tokens: 11 } });
  });

  it("never lowers flow spend on revert, including a pre-receipt run upgraded mid-run", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" },
        output: { from: "${second.output}", contract: "Result" },
        steps: [
          { id: "first", do: "first", out: "Result" },
          { id: "second", after: ["first"], do: "second", out: "Result" },
        ],
      } },
    };
    const planned = await engine.plan(spec, { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected first ready");
    await engine.stepDone(planned.runId, "first", {
      output: { value: "first" }, usage: { tokens: 100, usd: 0.5 }, telemetry: { model: "worker", durationMs: 3 },
    });
    await engine.commit(planned.runId, "cp");
    // Simulate a run persisted before the receipt spine existed.
    const legacy = await store.load(planned.runId);
    delete legacy.receipts;
    delete legacy.receiptCounter;
    for (const entry of legacy.checkpoints ?? []) {
      const snapshot = entry.snapshot as unknown as Record<string, unknown>;
      delete snapshot.receipts;
      delete snapshot.receiptCounter;
    }
    await store.save(legacy);
    // Upgraded mid-run: the first receipt lands on top of pre-spine spend.
    await engine.usageReport(planned.runId, {
      dispatchId: "post-upgrade", stepId: "first", source: "client", usage: { tokens: 5 },
    });
    expect((await store.load(planned.runId)).flowSpent.tokens).toBe(105);

    await engine.revert(planned.runId, "cp");
    const reverted = await store.load(planned.runId);
    expect(reverted.flowSpent).toMatchObject({ tokens: 105, usd: 0.5 });
    expect(reverted.flowSpent.dispatches).toBeGreaterThanOrEqual(1);
    expect(reverted.events.filter((event) => event.type === "checkpoint_reverted")).toHaveLength(1);
  });
});
