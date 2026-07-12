import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { assertToolResponse } from "../../src/mcp/contracts.js";
import { createToolDispatcher } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("STRAT-TS-FLOW-BG MCP tools", () => {
  it("round-trips run_bg through bg_poll to a contract-valid terminal response", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-mcp-"));
    roots.push(root);
    const engine = new StratumEngine({
      stateRoot: root,
      evaluator: createEvaluator(),
      connector: async ({ prompt }) => ({ output: { value: prompt } }),
    });
    const dispatcher = createToolDispatcher({ engine });
    const started = await dispatcher.call("stratum_flow_run_bg", { spec: simpleFlow, input: { name: "Ada" } });
    await assertToolResponse("stratum_flow_run_bg", started);
    expect(started).toMatchObject({ status: "running", runId: expect.any(String) });

    let terminal: Record<string, unknown> | undefined;
    for (let tick = 0; tick < 100; tick += 1) {
      const polled = await dispatcher.call("stratum_flow_bg_poll", { runId: started.runId, cursor: 0 });
      await assertToolResponse("stratum_flow_bg_poll", polled);
      if (polled.status === "completed" && (polled.bg as Record<string, unknown>).status === "completed") { terminal = polled; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(terminal).toMatchObject({ status: "completed", bg: { status: "completed", cancelRequested: false, pendingGates: [] } });
  });

  it("adds pendingGates while retaining gateStepId for paused-gate readers", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-flow-bg-mcp-"));
    roots.push(root);
    const engine = new StratumEngine({
      stateRoot: root,
      evaluator: createEvaluator(),
      connector: async ({ prompt }) => ({ output: { value: prompt } }),
    });
    const dispatcher = createToolDispatcher({ engine });
    const started = await dispatcher.call("stratum_flow_run_bg", { spec: gateFlow, input: { name: "Ada" } });

    let paused: Record<string, unknown> | undefined;
    for (let tick = 0; tick < 100; tick += 1) {
      const polled = await dispatcher.call("stratum_flow_bg_poll", { runId: started.runId, cursor: 0 });
      if ((polled.bg as Record<string, unknown>).status === "paused_gate") { paused = polled; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(paused).toMatchObject({
      status: "running",
      bg: { status: "paused_gate", cancelRequested: false, pendingGates: ["review"], gateStepId: "review" },
    });
    await assertToolResponse("stratum_flow_bg_poll", paused);
  });
});

const simpleFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};

const gateFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [
      { id: "build", do: "build ${input.name}", out: "Result" },
      { id: "review", after: ["build"], gate: { on_approve: null, on_revise: null, on_kill: null } },
    ],
  } },
};
