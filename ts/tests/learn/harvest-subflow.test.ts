import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { classify } from "../../src/learn/classify.js";
import { harvest } from "../../src/learn/harvest.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function engine() {
  const root = await mkdtemp(join(tmpdir(), "stratum-harvest-subflow-"));
  temporaries.push(root);
  return { root, engine: tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator() })) };
}

const spec = (rootContract: string) => ({
  version: 1,
  contracts: { Result: { outcome: "complete|failed" }, Parent: { value: "string" } },
  flows: {
    entry: "main",
    main: { input: {}, output: { from: "${wrap.output}", contract: rootContract }, steps: [{ id: "wrap", run: "child", with: {} }] },
    child: { input: {}, output: { from: "${work.output}", contract: "Result" }, steps: [{ id: "work", do: "work", out: "Result", attempts: 1 }] },
  },
});

describe("harvest engine-produced subflow failures", () => {
  it("records a child failure once, at the dispatched child step, not again on the parent run step", async () => {
    const { root, engine: e } = await engine();
    const planned = await e.plan(spec("Result"), {});
    await e.stepDone(planned.runId, "wrap/work", { output: { outcome: "done" } });
    expect((await e.audit(planned.runId)).status).toBe("failed");
    // The engine really does echo the child failure onto the parent: this is what harvest must absorb.
    const results = (await e.audit(planned.runId)).events
      .filter((event) => event.type === "result" && (event.detail as { failure?: unknown }).failure !== undefined);
    expect(results.map((event) => event.stepId)).toEqual(["wrap/work", "wrap"]);
    const { records, droppedEvents } = await harvest(root);
    expect(droppedEvents).toBe(0);
    expect(records.map((record) => record.stepId)).toEqual(["wrap/work"]);
    const cluster = classify(records, { minRuns: 1, minPairs: 1 }).find((c) => c.class === "durable")!;
    expect(cluster.recurrence.records).toBe(1);
    expect(cluster.scope.stepIds).toEqual(["wrap/work"]);
  });

  it("keeps a genuine parent failure: the subflow completed but its output breaks the parent contract", async () => {
    const { root, engine: e } = await engine();
    const planned = await e.plan(spec("Parent"), {});
    await e.stepDone(planned.runId, "wrap/work", { output: { outcome: "complete" } });
    expect((await e.audit(planned.runId)).status).toBe("failed");
    const { records } = await harvest(root);
    expect(records.map((record) => record.stepId)).toEqual(["wrap"]);
  });

  it("keeps a later parent failure byte-identical to the child's when it is not the settling echo", async () => {
    const { root, engine: e } = await engine();
    // `work` fails `Result` and routes to `fallback`, which returns `done` — legal under
    // the subflow's own wider `Wide` output contract, but the parent flow output is
    // `Result`, so `wrap` fails with text identical to `work`'s failure. That is a
    // genuine parent failure (the completed subflow's output broke the parent
    // contract), not the echo of `wrap/work`, and it must be recorded.
    const planned = await e.plan({
      version: 1,
      contracts: { Result: { outcome: "complete|failed" }, Wide: { outcome: "complete|failed|done" } },
      flows: {
        entry: "main",
        main: { input: {}, output: { from: "${wrap.output}", contract: "Result" }, steps: [{ id: "wrap", run: "child", with: {} }] },
        child: { input: {}, output: { from: "${fallback.output}", contract: "Wide" }, steps: [
          { id: "work", do: "work", out: "Result", attempts: 1, on_fail: "fallback" },
          { id: "fallback", do: "fallback", out: "Wide", attempts: 1 },
        ] },
      },
    }, {});
    await e.stepDone(planned.runId, "wrap/work", { output: { outcome: "done" } });
    await e.stepDone(planned.runId, "wrap/fallback", { output: { outcome: "done" } });
    expect((await e.audit(planned.runId)).status).toBe("failed");
    const { records } = await harvest(root);
    expect(records.map((record) => record.stepId)).toEqual(["wrap/work", "wrap"]);
    expect(records[0]!.reason).toBe(records[1]!.reason);
  });
  it("keeps a same-reason fallback set failure after a child routed event", async () => {
    const { root, engine: e } = await engine();
    const planned = await e.plan({
      version: 1,
      contracts: { Result: { outcome: "complete|failed" } },
      flows: {
        entry: "main",
        main: { input: {}, output: { from: "${wrap.output}", contract: "Result" }, steps: [{ id: "wrap", run: "child", with: {} }] },
        child: { input: {}, output: { from: "${fallback.output}", contract: "Result" }, steps: [
          { id: "work", do: "work", out: "Result", attempts: 1, on_fail: "fallback" },
          { id: "fallback", set: { outcome: "'done'" }, out: "Result" },
        ] },
      },
    }, {});
    await e.stepDone(planned.runId, "wrap/work", { output: { outcome: "done" } });
    const audit = await e.audit(planned.runId);
    expect(audit.status).toBe("failed");
    expect(audit.events).toContainEqual(expect.objectContaining({ type: "routed", stepId: "wrap/work" }));
    const { records } = await harvest(root);
    expect(records.map((record) => record.stepId)).toEqual(["wrap/work", "wrap"]);
    expect(records[0]!.reason).toBe(records[1]!.reason);
  });

});
