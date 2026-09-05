import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { T2F5_DONE_SENTINEL, cancelBackgroundRun, pollBackgroundRun, runAgent } from "../../src/connectors/index.js";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { assertToolRequest, assertToolResponse, mcpSurface } from "../../src/mcp/contracts.js";
import { createMcpServer, type McpDependencies, type ToolName } from "../../src/mcp/server.js";
import { main } from "../../src/cli/stratum.js";

const execFileAsync = promisify(execFile);

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const simpleFlow = {
  version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${build.output}", contract: "Result" }, steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};
const gateFlow = {
  version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, steps: [
      { id: "build", do: "build", out: "Result" },
      { id: "review", after: ["build"], gate: { on_approve: "finish", on_revise: null, on_kill: null } },
      { id: "finish", do: "finish", out: "Result" },
    ],
  } },
};

async function connected(dependencies: McpDependencies) {
  const server = await createMcpServer(dependencies);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "p5-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function response(result: unknown): Record<string, unknown> {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "") as Record<string, unknown>;
}

describe("P5 frozen MCP surface", () => {
  it("exposes exactly the frozen tool set with state-only checkpoint descriptions", async () => {
    const pair = await connected({});
    try {
      const listed = await pair.client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(Object.keys((await mcpSurface()).tools).sort());
      for (const name of ["stratum_commit", "stratum_revert"]) {
        expect(listed.tools.find((tool) => tool.name === name)?.description)
          .toContain("state-only; no files are touched; the caller owns file-level undo.");
      }
    } finally { await pair.close(); }
  });

  it("validates real engine, registry, and connector responses against every frozen status shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-real-")); roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const e = new StratumEngine({
      stateRoot: root, evaluator: createEvaluator(), connector: async ({ prompt }) => {
        if (prompt === "bg slow") await new Promise((resolve) => setTimeout(resolve, 50));
        return { output: { value: prompt } };
      },
      judge: async () => ({ holds: true, reason: "ok", stakes: "cheap", model: "p5-judge", usage: { tokens: 2, usd: 0 } }),
    });
    const pair = await connected({
      engine: e,
      // This is the same final command-boundary seam used by background.test.ts,
      // but requests still travel through the SDK server and durable registry.
      runAgent: (options) => runAgent({ ...options, registryRoot }, {
        backgroundCommand: options.prompt === "error" ? fakeCodex([], { rc: 4, stderr: "bad child" })
          : options.prompt === "cancel" ? fakeCodex([], { sleep: 2 })
            : fakeCodex([{ type: "item.completed", item: { type: "agent_message", text: "background ok" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }], { sleep: 0.15 }),
        codexSpawn: fakeCodexSpawn([{ type: "item.completed", item: { type: "agent_message", text: "sync ok" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }]),
      }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
      cancelBackgroundRun: (runId) => cancelBackgroundRun(runId, { registryRoot }),
    });
    const seen = new Map<string, Set<string>>();
    const call = async (tool: ToolName, arguments_: Record<string, unknown>) => {
      let result: unknown;
      try { result = await pair.client.callTool({ name: tool, arguments: arguments_ }); }
      catch (error) { throw new Error(`${tool} ${JSON.stringify(arguments_)}: ${error instanceof Error ? error.message : String(error)}`); }
      const payload = response(result);
      await assertToolResponse(tool, payload);
      const status = payload.status;
      expect(typeof status).toBe("string");
      const statuses = seen.get(tool) ?? new Set<string>(); statuses.add(status as string); seen.set(tool, statuses);
      return payload;
    };
    try {
      // validate: both frozen statuses over the actual parser/validator.
      await call("stratum_validate", { spec: simpleFlow });
      await call("stratum_validate", { spec: {} });

      // compile_speckit: both frozen statuses over a real task directory.
      const tasksDir = join(root, "tasks");
      await mkdir(tasksDir);
      await writeFile(join(tasksDir, "01-task.md"), "# Task: Build\n");
      await call("stratum_compile_speckit", { tasks_dir: tasksDir });
      await call("stratum_compile_speckit", { tasks_dir: join(root, "missing-tasks") });

      // plan: ready (client step), running (gate), completed (pure set), failed
      // (contract-invalid pure set), and budget_exhausted (pre-dispatch budget).
      const ready = await call("stratum_plan", { spec: chainFlow(), input: { name: "x" } });
      const running = await call("stratum_plan", { spec: initialGateFlow(), input: { name: "x" } });
      await call("stratum_plan", { spec: setFlow("input.name"), input: { name: "x" } });
      await call("stratum_plan", { spec: setFlow("1"), input: { name: "x" } });
      await call("stratum_plan", { spec: budgetFlow(), input: { name: "x" } });

      // usage_report: an accepted receipt and its idempotent replay cover both
      // frozen response variants through the real engine and MCP dispatcher.
      await call("stratum_usage_report", {
        runId: ready.runId,
        receipt: { dispatchId: "p5-receipt", source: "contract", usage: { tokens: 1 } },
      });
      await call("stratum_usage_report", {
        runId: ready.runId,
        receipt: { dispatchId: "p5-receipt", source: "contract", usage: { tokens: 1 } },
      });

      // Checkpoints: commit exposes committed/error; revert exposes ready/running/completed/error.
      const checkpointRun = ready.runId as string;
      await call("stratum_commit", { flow_id: checkpointRun, label: "before_first" });
      await call("stratum_commit", { flow_id: "no-such-flow", label: "cp" });
      await call("stratum_step_done", { runId: checkpointRun, stepId: "first", dispatchToken: readyToken(ready), result: { output: { value: "first" } } });
      await call("stratum_revert", { flow_id: checkpointRun, label: "before_first" });
      await call("stratum_revert", { flow_id: checkpointRun, label: "missing" });
      const checkpointGate = await call("stratum_plan", { spec: initialGateFlow(), input: { name: "x" } });
      await call("stratum_commit", { flow_id: checkpointGate.runId, label: "at_gate" });
      await call("stratum_revert", { flow_id: checkpointGate.runId, label: "at_gate" });
      // revert also exposes completed — reverting to a post-completion checkpoint on a
      // retained terminal run (Python parity: terminal runs stay checkpoint-operable).
      const checkpointDone = await call("stratum_plan", { spec: simpleFlow, input: { name: "x" } });
      await call("stratum_step_done", { runId: checkpointDone.runId, stepId: "build", dispatchToken: readyToken(checkpointDone), result: { output: { value: "done" } } });
      await call("stratum_commit", { flow_id: checkpointDone.runId, label: "post" });
      await call("stratum_revert", { flow_id: checkpointDone.runId, label: "post" });

      // step_done: ready, running at a gate, completed, failed, and budget exhaustion.
      const chain = await call("stratum_plan", { spec: chainFlow(), input: { name: "x" } });
      const chainRun = chain.runId as string;
      await call("stratum_step_done", { runId: chainRun, stepId: "first", dispatchToken: readyToken(chain), result: { output: { value: "first" } } });
      const gateRun = (await gateWaiting(call, gateFlow)) as string;
      const complete = await call("stratum_plan", { spec: simpleFlow, input: { name: "x" } });
      await call("stratum_step_done", { runId: complete.runId, stepId: "build", dispatchToken: readyToken(complete), result: { output: { value: "done" } } });
      const failing = await call("stratum_plan", { spec: failureFlow(), input: { name: "x" } });
      await call("stratum_step_done", { runId: failing.runId, stepId: "build", dispatchToken: readyToken(failing), result: { failure: "broken" } });
      const budget = await call("stratum_plan", { spec: postDispatchBudgetFlow(), input: { name: "x" } });
      await call("stratum_step_done", { runId: budget.runId, stepId: "first", dispatchToken: readyToken(budget), result: { output: { value: "one" } } });

      // Checkpoints on retained terminal runs: committing after failure snapshots the
      // terminal status, so reverting restores it — failed and budget_exhausted are
      // legal revert outcomes, not adapter errors.
      await call("stratum_commit", { flow_id: failing.runId, label: "postmortem" });
      expect(await call("stratum_revert", { flow_id: failing.runId, label: "postmortem" }))
        .toMatchObject({ status: "failed", reverted_to: "postmortem" });
      await call("stratum_commit", { flow_id: budget.runId, label: "postmortem" });
      expect(await call("stratum_revert", { flow_id: budget.runId, label: "postmortem" }))
        .toMatchObject({ status: "budget_exhausted", reverted_to: "postmortem" });

      // resume exposes the same persisted state surface without fabricating it.
      const resumeReady = await call("stratum_plan", { spec: simpleFlow, input: { name: "x" } });
      await call("stratum_resume", { runId: resumeReady.runId });
      await call("stratum_resume", { runId: gateRun });
      await call("stratum_resume", { runId: complete.runId });
      await call("stratum_resume", { runId: failing.runId });
      await call("stratum_resume", { runId: budget.runId });

      // gate_resolve: ready, running via a fanout target, completed, failed,
      // and budget-exhausted via a gated, budgeted dispatch.
      const gateReady = await gateWaiting(call, gateFlow);
      await call("stratum_gate_resolve", { runId: gateReady, stepId: "review", decision: "approve", gateToken: await currentGateToken(e, gateReady) });
      const gateRunning = await gateWaiting(call, gateFanoutFlow(), { name: "x", items: ["a"] });
      await call("stratum_gate_resolve", { runId: gateRunning, stepId: "review", decision: "approve", gateToken: await currentGateToken(e, gateRunning) });
      const gateComplete = await gateWaiting(call, terminalGateFlow());
      await call("stratum_gate_resolve", { runId: gateComplete, stepId: "review", decision: "approve", gateToken: await currentGateToken(e, gateComplete) });
      const gateFailed = await gateWaiting(call, killGateFlow());
      await call("stratum_gate_resolve", { runId: gateFailed, stepId: "review", decision: "kill", gateToken: await currentGateToken(e, gateFailed) });
      const gateBudget = await gateWaiting(call, gateBudgetFlow());
      await call("stratum_gate_resolve", { runId: gateBudget, stepId: "review", decision: "approve", gateToken: await currentGateToken(e, gateBudget) });

      // audit and flow_poll cover every durable state on independent real runs.
      for (const runId of [gateRun, complete.runId, failing.runId, budget.runId] as string[]) {
        await call("stratum_audit", { runId });
        await call("stratum_flow_poll", { runId, cursor: 0 });
      }

      // Whole-flow background tools: run_bg has one minimal start variant;
      // bg_poll mirrors every durable run status; cancel reports every current bg state.
      const bgGate = await call("stratum_flow_run_bg", { spec: initialGateFlow(), input: { name: "x" } });
      const pausedBgGate = await waitForFlowBg(call, bgGate.runId as string, "running", "paused_gate");
      expect(pausedBgGate.bg).toMatchObject({ pendingGates: ["review"], gateStepId: "review" });
      await call("stratum_flow_cancel_bg", { runId: bgGate.runId });
      const bgComplete = await call("stratum_flow_run_bg", { spec: simpleFlow, input: { name: "x" } });
      await waitForFlowBg(call, bgComplete.runId as string, "completed", "completed");
      await call("stratum_flow_cancel_bg", { runId: bgComplete.runId });
      const bgFailed = await call("stratum_flow_run_bg", { spec: setFlow("1"), input: { name: "x" } });
      await waitForFlowBg(call, bgFailed.runId as string, "failed", "failed");
      await call("stratum_flow_cancel_bg", { runId: bgFailed.runId });
      const bgBudget = await call("stratum_flow_run_bg", { spec: budgetFlow(), input: { name: "x" } });
      await waitForFlowBg(call, bgBudget.runId as string, "budget_exhausted", "budget_exhausted");
      await call("stratum_flow_cancel_bg", { runId: bgBudget.runId });
      const bgCancel = await call("stratum_flow_run_bg", { spec: flow([{ id: "build", do: "bg slow", out: "Result" }], "${build.output}"), input: { name: "x" } });
      await call("stratum_flow_cancel_bg", { runId: bgCancel.runId });
      // Cancellation fences the already-issued task result, so the durable run
      // remains abandoned/running while its background ownership is cancelled.
      await waitForFlowBg(call, bgCancel.runId as string, "running", "cancelled");
      await call("stratum_flow_cancel_bg", { runId: bgCancel.runId });

      // Sync complete uses the Codex connector spawn seam; the remainder uses
      // real durable background runs started/polled/cancelled through MCP.
      await call("stratum_agent_run", { agent: "codex", prompt: "sync", cwd: root, background: false });
      const started = await call("stratum_agent_run", { agent: "codex", prompt: "background", cwd: root, background: true });
      const backgroundId = started.runId as string;
      await call("stratum_agent_poll", { runId: backgroundId });
      await waitForBackground(backgroundId, registryRoot, "complete");
      await call("stratum_agent_poll", { runId: backgroundId });
      await call("stratum_agent_poll", { runId: "deadbeef0000" });
      await call("stratum_cancel_agent_run", { runId: backgroundId });
      await call("stratum_cancel_agent_run", { runId: "deadbeef0000" });

      const errorId = (await call("stratum_agent_run", { agent: "codex", prompt: "error", cwd: root, background: true })).runId as string;
      await waitForBackground(errorId, registryRoot, "error");
      await call("stratum_agent_poll", { runId: errorId });
      await call("stratum_cancel_agent_run", { runId: errorId });
      const cancelId = (await call("stratum_agent_run", { agent: "codex", prompt: "cancel", cwd: root, background: true })).runId as string;
      await call("stratum_cancel_agent_run", { runId: cancelId });
      await waitForBackground(cancelId, registryRoot, "error");
      await call("stratum_cancel_agent_run", { runId: cancelId });

      const surface = await mcpSurface();
      for (const tool of Object.keys(surface.tools).filter((tool) => !tool.startsWith("stratum_guard_"))) {
        expect([...seen.get(tool)!].sort(), tool).toEqual(Object.keys(surface.tools[tool]!.responses).sort());
      }
    } finally { await pair.close(); }
  });

  it("fences step_done with the ready entry's dispatch token across revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-token-")); roots.push(root);
    const pair = await connected({ engine: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }) });
    try {
      const reviseFlow = { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${build.output}", contract: "Result" }, max_rounds: 1,
        steps: [
          { id: "build", do: "build ${input.name}", out: "Result" },
          { id: "review", after: ["build"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
        ],
      } } };
      const planned = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec: reviseFlow, input: { name: "Ada" } } }));
      const runId = planned.runId as string;
      const firstToken = readyToken(planned);
      response(await pair.client.callTool({ name: "stratum_step_done", arguments: { runId, stepId: "build", dispatchToken: firstToken, result: { output: { value: "v1" } } } }));
      const audit = response(await pair.client.callTool({ name: "stratum_audit", arguments: { runId } }));
      const gateToken = ((audit.steps as Record<string, Record<string, unknown>>).review!).gateToken;
      const revised = response(await pair.client.callTool({ name: "stratum_gate_resolve", arguments: { runId, stepId: "review", decision: "revise", gateToken } }));
      const currentToken = readyToken(revised);
      await expect(pair.client.callTool({ name: "stratum_step_done", arguments: { runId, stepId: "build", dispatchToken: firstToken, result: { output: { value: "stale" } } } }))
        .rejects.toThrow(/superseded issuance/);
      const current = response(await pair.client.callTool({ name: "stratum_step_done", arguments: { runId, stepId: "build", dispatchToken: currentToken, result: { output: { value: "v2" } } } }));
      expect(current.status).toBe("running");
    } finally { await pair.close(); }
  });

  it("surfaces structured spec validation errors instead of a bare internal error", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-spec-errors-")); roots.push(root);
    const pair = await connected({ engine: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }) });
    try {
      expect((await mcpSurface()).errors.spec_validation_failed).toEqual({
        data: { code: "string", errors: { $array: { code: "string", path: "string", message: "string" } } },
      });
      let protocolError: unknown;
      try {
        await pair.client.callTool({ name: "stratum_plan", arguments: { spec: { version: 2, flows: {} }, input: {} } });
      } catch (error) { protocolError = error; }
      expect(protocolError).toBeInstanceOf(McpError);
      const data = (protocolError as McpError).data as { code: string; errors: Array<Record<string, unknown>> };
      expect(data.code).toBe("spec_validation_failed");
      expect(data.errors.length).toBeGreaterThan(0);
      for (const entry of data.errors) {
        expect(entry).toMatchObject({ code: expect.any(String), path: expect.any(String), message: expect.any(String) });
      }
    } finally { await pair.close(); }
  });

  it("pumps consumer fanout over MCP with descriptor tokens, metadata boundaries, and a typed bg rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-consumer-")); roots.push(root);
    const pair = await connected({ engine: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }) });
    const spec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", attempts: 2, fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none",
          require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      } },
    };
    try {
      const planned = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec, input: { items: ["a"] } } }));
      expect(planned).toMatchObject({ status: "ready", revisionDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const first = (planned.ready as Array<Record<string, unknown>>)[0]!;
      expect(first).toMatchObject({ id: "fan/0", stage: 0, itemIndex: 0, revisionDigest: planned.revisionDigest });
      await expect(assertToolResponse("stratum_plan", {
        status: "ready", runId: planned.runId, ready: [{ id: "bare" }], ledger: { spent: {} }, revisionDigest: planned.revisionDigest,
      })).rejects.toThrow(/oneOf variants matched/);
      expect((await mcpSurface()).errors.consumer_dispatch_bg_unsupported).toEqual({
        data: { code: "string", errors: { $array: { code: "string", path: "string", message: "string" } } },
      });
      const resumed = response(await pair.client.callTool({ name: "stratum_resume", arguments: { runId: planned.runId } }));
      expect(resumed).toMatchObject({ revisionDigest: planned.revisionDigest, ready: [{ dispatchToken: first.dispatchToken }] });

      await expect(pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "fan/0", result: { output: { value: "missing token" } },
      } })).rejects.toThrow(/dispatchToken.*required/i);
      const retry = response(await pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "fan/0", dispatchToken: first.dispatchToken, result: { failure: "retry me" },
      } }));
      expect(retry.revisionDigest).toBeUndefined();
      const second = (retry.ready as Array<Record<string, unknown>>)[0]!;
      expect(second).toMatchObject({ id: "fan/0", previousFailure: { reason: "retry me" } });
      expect(second.dispatchToken).not.toBe(first.dispatchToken);
      await expect(pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "fan/0", dispatchToken: first.dispatchToken, result: { output: { value: "stale" } },
      } })).rejects.toThrow(/stale/);
      const completed = response(await pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "fan/0", dispatchToken: second.dispatchToken, result: { output: { value: "done" } },
      } }));
      expect(completed).toMatchObject({ status: "completed", output: { value: "done" } });
      expect(completed.revisionDigest).toBeUndefined();

      let protocolError: unknown;
      try {
        await pair.client.callTool({ name: "stratum_flow_run_bg", arguments: { spec, input: { items: ["a"] } } });
      } catch (error) { protocolError = error; }
      expect(protocolError).toBeInstanceOf(McpError);
      expect((protocolError as McpError).data).toEqual({
        code: "consumer_dispatch_bg_unsupported",
        errors: [expect.objectContaining({ code: "consumer_dispatch_bg_unsupported" })],
      });
    } finally { await pair.close(); }
  });

  it("forwards ordinary dispatch and gate tokens over MCP without leaking revision metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-token-wire-")); roots.push(root);
    const pair = await connected({ engine: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }) });
    const spec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, max_rounds: 2,
        steps: [
          { id: "build", do: "build", out: "Result" },
          { id: "review", after: ["build"], gate: { on_approve: "finish", on_revise: "build", on_kill: null } },
          { id: "finish", do: "finish", out: "Result" },
        ],
      } },
    };
    try {
      const planned = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec, input: { name: "x" } } }));
      const first = (planned.ready as Array<Record<string, unknown>>)[0]!;
      response(await pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "build", dispatchToken: first.dispatchToken, result: { output: { value: "one" } },
      } }));
      const audit1 = response(await pair.client.callTool({ name: "stratum_audit", arguments: { runId: planned.runId } }));
      const gate1 = ((audit1.steps as Record<string, Record<string, unknown>>).review!).gateToken;
      const revised = response(await pair.client.callTool({ name: "stratum_gate_resolve", arguments: {
        runId: planned.runId, stepId: "review", decision: "revise", gateToken: gate1,
      } }));
      expect(revised.revisionDigest).toBeUndefined();
      const current = (revised.ready as Array<Record<string, unknown>>)[0]!;
      await expect(pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "build", dispatchToken: first.dispatchToken, result: { output: { value: "stale" } },
      } })).rejects.toThrow(/stale/);
      await expect(pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "build", result: { output: { value: "missing echo" } },
      } })).rejects.toThrow(/dispatchToken.*required/i);
      response(await pair.client.callTool({ name: "stratum_step_done", arguments: {
        runId: planned.runId, stepId: "build", dispatchToken: current.dispatchToken, result: { output: { value: "current" } },
      } }));
      expect(current.dispatchToken).not.toBe(first.dispatchToken);
      const audit2 = response(await pair.client.callTool({ name: "stratum_audit", arguments: { runId: planned.runId } }));
      const gate2 = ((audit2.steps as Record<string, Record<string, unknown>>).review!).gateToken;
      expect(gate2).not.toBe(gate1);
      await expect(pair.client.callTool({ name: "stratum_gate_resolve", arguments: {
        runId: planned.runId, stepId: "review", decision: "approve", gateToken: gate1,
      } })).rejects.toThrow(/stale/);
      const ready = response(await pair.client.callTool({ name: "stratum_gate_resolve", arguments: {
        runId: planned.runId, stepId: "review", decision: "approve", gateToken: gate2,
      } }));
      expect(ready).toMatchObject({ status: "ready", ready: [{ id: "finish" }] });
      expect(ready.revisionDigest).toBeUndefined();
    } finally { await pair.close(); }
  });

  it("rejects the retired Phase-1 epoch field at the strict MCP request schema", async () => {
    await expect(assertToolRequest("stratum_step_done", {
      runId: "run", stepId: "step", dispatchToken: "token", epoch: 0, result: { output: { value: "old wire" } },
    })).rejects.toThrow(/epoch.*undeclared/i);
  });

  it("runs plan, stepDone, completed, and gate flows through an SDK client", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-mcp-")); roots.push(root);
    const pair = await connected({ engine: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }) });
    try {
      const planned = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec: simpleFlow, input: { name: "x" } } }));
      expect(planned.status).toBe("ready");
      const committed = response(await pair.client.callTool({ name: "stratum_commit", arguments: { flow_id: planned.runId, label: " initial " } }));
      expect(committed).toEqual({
        status: "committed", flow_id: planned.runId, label: "initial", step_number: 1,
        current_step_id: "build", checkpoints: ["initial"],
      });
      const done = response(await pair.client.callTool({ name: "stratum_step_done", arguments: { runId: planned.runId, stepId: "build", dispatchToken: readyToken(planned), result: { output: { value: "done" } } } }));
      expect(done).toMatchObject({ status: "completed", output: { value: "done" } });

      const revertPlan = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec: gateFlow, input: { name: "x" } } }));
      await pair.client.callTool({ name: "stratum_commit", arguments: { flow_id: revertPlan.runId, label: "start" } });
      await pair.client.callTool({
        name: "stratum_step_done",
        arguments: { runId: revertPlan.runId, stepId: "build", dispatchToken: readyToken(revertPlan), result: { output: { value: "changed" } } },
      });
      const reverted = response(await pair.client.callTool({ name: "stratum_revert", arguments: { flow_id: revertPlan.runId, label: "start" } }));
      expect(reverted).toMatchObject({ status: "ready", runId: revertPlan.runId, ready: [{ id: "build" }], reverted_to: "start" });
      await pair.client.callTool({ name: "stratum_commit", arguments: { flow_id: revertPlan.runId, label: "zeta" } });
      await pair.client.callTool({ name: "stratum_commit", arguments: { flow_id: revertPlan.runId, label: "alpha" } });
      const missing = response(await pair.client.callTool({ name: "stratum_revert", arguments: { flow_id: revertPlan.runId, label: "missing" } }));
      expect(missing).toEqual({
        status: "error", error_type: "checkpoint_not_found",
        message: `No checkpoint 'missing' on flow '${revertPlan.runId as string}'`,
        available: ["start", "zeta", "alpha"], // insertion order (Python parity), not sorted
      });

      const gatePlan = response(await pair.client.callTool({ name: "stratum_plan", arguments: { spec: gateFlow, input: { name: "x" } } }));
      await pair.client.callTool({ name: "stratum_step_done", arguments: { runId: gatePlan.runId, stepId: "build", dispatchToken: readyToken(gatePlan), result: { output: { value: "built" } } } });
      const gateAudit = response(await pair.client.callTool({ name: "stratum_audit", arguments: { runId: gatePlan.runId } }));
      const gateToken = ((gateAudit.steps as Record<string, Record<string, unknown>>).review!).gateToken;
      const resolved = response(await pair.client.callTool({ name: "stratum_gate_resolve", arguments: { runId: gatePlan.runId, stepId: "review", decision: "approve", gateToken } }));
      expect(resolved).toMatchObject({ status: "ready", ready: [{ id: "finish" }] });
    } finally { await pair.close(); }
  });
});

describe("P5 stratum watch", () => {
  it("ports text, missing, JSONL, curated events, kinds, and sentinel exit semantics", async () => {
    const home = await mkdtemp(join(tmpdir(), "stratum-p5-watch-")); roots.push(home);
    const run = async (runId: string, records: unknown[], args: string[] = [], stderr = "") => {
      const dir = join(home, ".stratum", "ts", "agent_runs", runId); await mkdir(dir, { recursive: true });
      const streamPath = join(dir, "stream.jsonl"); const stderrPath = `${streamPath}.err`;
      await writeFile(streamPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
      await writeFile(stderrPath, stderr);
      await writeFile(join(dir, "meta.json"), JSON.stringify({ runId, streamPath, stderrPath, childPid: 0, model: "gpt-5", promptChars: 1 }));
      return captureMain(home, ["watch", runId, ...args]);
    };
    const message = { type: "item.completed", item: { type: "agent_message", text: "first\nsecond" } };
    const tool = { type: "item.completed", item: { type: "command_execution", command: "echo curated", exit_code: 0, duration_ms: 12 } };
    const usage = { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 0 } };
    const text = await run("ab12cd34ef56", [message, { __t2f5_done__: 7 }]);
    expect(text).toMatchObject({ code: 7 }); expect(text.stdout).toContain("first\nsecond"); expect(text.stdout).toContain("finished rc=7");
    const missing = await captureMain(home, ["watch", "missing"]);
    expect(missing.code).toBe(2);
    const json = await run("ab12cd34ef57", [message, { __t2f5_done__: 3 }], ["--json"]);
    expect(json.code).toBe(3); expect(json.stdout.trim().split("\n").map((line) => JSON.parse(line))).toHaveLength(2);
    const events = await run("ab12cd34ef58", [message, { type: "item.completed", item: { type: "reasoning", text: "hidden" } }, tool, usage, { type: "error", message: "codex unhappy" }, { __t2f5_done__: 0 }], ["--events"]);
    expect(events.code).toBe(0); expect(events.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { event: "assistant", text: "first\nsecond" }, { event: "tool", tool: "bash", summary: "echo curated", ok: true, duration_ms: 12 }, { event: "error", message: "codex unhappy" }, { event: "done", rc: 0 },
    ]);
    const narrowed = await run("ab12cd34ef59", [message, usage, { __t2f5_done__: 0 }], ["--events", "--kinds=usage"]);
    expect(narrowed.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ event: "usage", input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0 }, { event: "done", rc: 0 }]);
    const died = await run("ab12cd34ef60", [message], ["--events", "--kinds=usage"], "child stderr");
    expect(died.code).toBe(1); expect(died.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ event: "died", reason: "child_died_without_sentinel", stderr_tail: "child stderr" }]);
  });

  it("streams persisted flow-spine events and filters by frozen kind", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-flow-watch-")); roots.push(root);
    const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const planned = await engine.plan(simpleFlow, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected ready flow");
    await engine.stepDone(planned.runId, "build", { output: { value: "done" } }, planned.ready[0]!.dispatchToken);
    const watched = await captureMain(process.env.HOME ?? "", ["watch", planned.runId, "--events", "--kinds=completed"], root);
    expect(watched.code).toBe(0);
    const events = watched.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "completed", detail: { output: { value: "done" } } });
  });

  it("matches the remaining Python watch matrix adversarial cases", async () => {
    const home = await mkdtemp(join(tmpdir(), "stratum-p5-watch-parity-")); roots.push(home);
    for (const argv of [["watch", "ab12cd34ef62", "--events", "--json"], ["watch", "ab12cd34ef62", "--kinds=assistant"], ["watch", "ab12cd34ef62", "--events", "--kinds=bogus"]]) {
      const result = await captureMain(home, argv);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(argv.at(-1) === "--kinds=bogus" ? "valid agent kinds:" : "Usage:");
    }
    const unknown = await captureMain(home, ["watch", "ab12cd34ef63", "--events"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout.trim()).toBe(JSON.stringify({ event: "error", message: "unknown run_id ab12cd34ef63" }));

    const dir = join(home, ".stratum", "ts", "agent_runs", "ab12cd34ef64"); await mkdir(dir, { recursive: true });
    const streamPath = join(dir, "stream.jsonl");
    await writeFile(streamPath, `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "a".repeat(3_000) } })}\n${JSON.stringify({ [T2F5_DONE_SENTINEL]: 7 })}\n`);
    await writeFile(`${streamPath}.err`, "");
    await writeFile(join(dir, "meta.json"), JSON.stringify({ runId: "ab12cd34ef64", streamPath, stderrPath: `${streamPath}.err`, childPid: 0, model: "gpt-5", promptChars: 1 }));
    const capped = await captureMain(home, ["watch", "ab12cd34ef64", "--events"]);
    expect(capped.code).toBe(7);
    const lines = capped.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([expect.objectContaining({ event: "assistant", text: expect.stringMatching(/^\[truncated, full stream at /) }), { event: "done", rc: 7 }]);
    expect((lines[0] as { text: string }).text.length).toBeLessThanOrEqual(2_000);
    expect((lines[0] as { text: string }).text.endsWith("a".repeat(100))).toBe(true);
  });

  it("skips JSONL primitives and keeps multibyte text intact instead of crashing", async () => {
    const home = await mkdtemp(join(tmpdir(), "stratum-p5-watch-noise-")); roots.push(home);
    const dir = join(home, ".stratum", "ts", "agent_runs", "ab12cd34ef65"); await mkdir(dir, { recursive: true });
    const streamPath = join(dir, "stream.jsonl");
    const lines = [
      "null",
      '"noise"',
      "42",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "caf\u00e9 \u20ac ok" } }),
      JSON.stringify({ [T2F5_DONE_SENTINEL]: 0 }),
    ];
    await writeFile(streamPath, `${lines.join("\n")}\n`);
    await writeFile(`${streamPath}.err`, "");
    await writeFile(join(dir, "meta.json"), JSON.stringify({ runId: "ab12cd34ef65", streamPath, stderrPath: `${streamPath}.err`, childPid: 0, model: "gpt-5", promptChars: 1 }));
    const watched = await captureMain(home, ["watch", "ab12cd34ef65", "--events"]);
    expect(watched.code).toBe(0);
    expect(watched.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { event: "assistant", text: "caf\u00e9 \u20ac ok" },
      { event: "done", rc: 0 },
    ]);
  });
});

describe("P5 CLI and MCP process boundaries", () => {
  it("validates files through the executable CLI bin under the current Node", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-cli-bin-")); roots.push(root);
    const spec = join(root, "valid.json"); await writeFile(spec, JSON.stringify(simpleFlow));
    const bin = fileURLToPath(new URL("../../src/cli/bin.mjs", import.meta.url));
    const result = await execFileAsync(process.execPath, [bin, "validate", spec]);
    expect(result.stdout).toContain('"valid":true');
  });

  it("keeps validate exit and diagnostic contracts for invalid, unreadable, and malformed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p5-validate-")); roots.push(root);
    const invalid = join(root, "invalid.json"); const malformed = join(root, "bad.json");
    await writeFile(invalid, JSON.stringify({})); await writeFile(malformed, "{");
    expect(await captureMain(root, ["validate", join(root, "valid.json")])).toMatchObject({ code: 2, stderr: expect.stringContaining("ENOENT") });
    const badSpec = await captureMain(root, ["validate", invalid]);
    expect(badSpec.code).toBe(1); expect(badSpec.stdout).toContain('"errors"');
    const badJson = await captureMain(root, ["validate", malformed]);
    expect(badJson.code).toBe(2); expect(badJson.stderr).toContain("stratum validate:");
  });

  it("answers an initialize handshake from the executable MCP bin", async () => {
    const bin = fileURLToPath(new URL("../../src/mcp/bin.mjs", import.meta.url));
    const response = await initializeMcpBin(bin);
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: expect.any(String), serverInfo: { name: "stratum-mcp" } } });
  });

  it("returns MCP errors for malformed calls and internal failures without breaking the connection", async () => {
    const pair = await connected({});
    try {
      // Surface 10 types spec/input "object" (untyped "any" made MCP clients
      // deliver them as raw strings): scalar input is now malformed alongside
      // a missing required key, a wrong-typed declared optional, an undeclared
      // extra field, and a string-serialized spec.
      for (const arguments_ of [{ spec: simpleFlow }, { spec: simpleFlow, input: 1 }, { spec: JSON.stringify(simpleFlow), input: {} }, { spec: simpleFlow, input: {}, workspaceRoot: 42 }, { spec: simpleFlow, input: {}, surprise: true }]) {
        await expect(pair.client.callTool({ name: "stratum_plan", arguments: arguments_ })).rejects.toThrow("MCP error");
      }
      expect(response(await pair.client.callTool({ name: "stratum_validate", arguments: { spec: simpleFlow } }))).toEqual({ status: "valid" });
    } finally { await pair.close(); }

    const failing = await connected({ engine: { plan: async () => { throw new Error("intentional engine failure"); } } as never });
    try {
      await expect(failing.client.callTool({ name: "stratum_plan", arguments: { spec: simpleFlow, input: {} } })).rejects.toThrow("intentional engine failure");
      expect(response(await failing.client.callTool({ name: "stratum_validate", arguments: { spec: simpleFlow } }))).toEqual({ status: "valid" });
    } finally { await failing.close(); }
  });
});

async function captureMain(home: string, argv: string[], stateRoot?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalHome = process.env.HOME;
  const originalStateRoot = process.env.STRATUM_STATE_ROOT;
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  let out = "";
  let err = "";
  process.env.HOME = home;
  if (stateRoot) process.env.STRATUM_STATE_ROOT = stateRoot;
  process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { code: await main(argv), stdout: out, stderr: err }; }
  finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalStateRoot === undefined) delete process.env.STRATUM_STATE_ROOT; else process.env.STRATUM_STATE_ROOT = originalStateRoot;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

function chainFlow() { return flow([{ id: "first", do: "first", out: "Result" }, { id: "second", after: ["first"], do: "second", out: "Result" }], "${second.output}"); }
function failureFlow() { return flow([{ id: "build", do: "build", out: "Result", attempts: 1 }], "${build.output}"); }
function setFlow(expression: string) { return flow([{ id: "finish", set: { value: expression }, out: "Result" }], "${finish.output}"); }
function budgetFlow() {
  return {
    version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
      input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, budget: { tokens: 1 }, steps: [
        { id: "finish", set: { value: "input.name" }, out: "Result", ensure: [{ judged: { statement: "budget test", stakes: "cheap" } }] },
      ],
    } },
  };
}
function postDispatchBudgetFlow() { return { ...chainFlow(), flows: { entry: "main", main: { ...chainFlow().flows.main, budget: { dispatches: 1 } } } }; }
function terminalGateFlow() { return flow([{ id: "build", do: "build", out: "Result" }, { id: "review", after: ["build"], gate: { on_approve: null, on_revise: null, on_kill: null } }], "${build.output}"); }
function killGateFlow() { return flow([{ id: "build", do: "build", out: "Result" }, { id: "review", after: ["build"], gate: { on_approve: null, on_revise: null, on_kill: null } }], "${build.output}"); }
function initialGateFlow() { return flow([{ id: "build", set: { value: "input.name" }, out: "Result" }, { id: "review", after: ["build"], gate: { on_approve: null, on_revise: null, on_kill: null } }], "${build.output}"); }
function gateBudgetFlow() { return { ...gateFlow, flows: { entry: "main", main: { ...gateFlow.flows.main, budget: { dispatches: 1 } } } }; }
function gateFanoutFlow() {
  return {
    version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
      input: { name: "string", items: "string[]" }, output: { from: "${build.output}", contract: "Result" }, steps: [
        { id: "build", do: "build", out: "Result" },
        { id: "review", after: ["build"], gate: { on_approve: "fan", on_revise: null, on_kill: null } },
        { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
      ],
    } },
  };
}
function flow(steps: unknown[], from: string) {
  return { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: { input: { name: "string" }, output: { from, contract: "Result" }, steps } } };
}

async function gateWaiting(call: (tool: ToolName, args: Record<string, unknown>) => Promise<Record<string, unknown>>, spec: Record<string, unknown>, input: Record<string, unknown> = { name: "x" }): Promise<string> {
  const planned = await call("stratum_plan", { spec, input });
  expect(planned.status).toBe("ready");
  const waiting = await call("stratum_step_done", { runId: planned.runId, stepId: "build", dispatchToken: readyToken(planned), result: { output: { value: "built" } } });
  expect(waiting.status).toBe("running");
  return planned.runId as string;
}

function readyToken(response_: Record<string, unknown>): string {
  const token = (response_.ready as Array<Record<string, unknown>> | undefined)?.[0]?.dispatchToken;
  if (typeof token !== "string") throw new Error("expected ready dispatch token");
  return token;
}

async function currentGateToken(engine: StratumEngine, runId: string, stepId = "review"): Promise<string> {
  const token = (await engine.audit(runId)).steps[stepId]?.gateToken;
  if (typeof token !== "string") throw new Error("expected current gate token");
  return token;
}

async function waitForFlowBg(
  call: (tool: ToolName, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  runId: string,
  runStatus: string,
  bgStatus: string,
): Promise<Record<string, unknown>> {
  for (let tick = 0; tick < 100; tick += 1) {
    const polled = await call("stratum_flow_bg_poll", { runId, cursor: 0 });
    if (polled.status === runStatus && (polled.bg as Record<string, unknown>).status === bgStatus) return polled;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`background flow ${runId} did not reach ${runStatus}/${bgStatus}`);
}

function fakeCodex(records: unknown[], options: { rc?: number; stderr?: string; sleep?: number } = {}): string[] {
  const script = [
    ...records.map((record) => `printf '%s\\n' '${JSON.stringify(record).replaceAll("'", "'\\\\''")}'`),
    ...(options.stderr ? [`printf '%s' '${options.stderr.replaceAll("'", "'\\\\''")}' 1>&2`] : []),
    ...(options.sleep ? [`sleep ${options.sleep}`] : []), `exit ${options.rc ?? 0}`,
  ].join("; ");
  return ["sh", "-c", script];
}

function fakeCodexSpawn(records: unknown[]) {
  return () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { for (const record of records) child.stdout.write(`${JSON.stringify(record)}\n`); child.stdout.end(); child.stderr.end(); child.emit("close", 0, null); });
    return child as never;
  };
}

async function waitForBackground(runId: string, registryRoot: string, status: string): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if ((await pollBackgroundRun(runId, { registryRoot })).status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`background ${runId} did not reach ${status}`);
}

describe("stratum_agent_run T1 contract changes", () => {
  it("accepts allowedTools and disallowedTools as optional string arrays in the request", async () => {
    await expect(assertToolRequest("stratum_agent_run", {
      agent: "claude", prompt: "p", cwd: "/tmp",
      allowedTools: ["Read", "Edit"],
      disallowedTools: ["Write"],
    })).resolves.toBeUndefined();
  });

  it("rejects a mixed-type allowedTools array at the contract boundary", async () => {
    await expect(assertToolRequest("stratum_agent_run", {
      agent: "claude", prompt: "p", cwd: "/tmp",
      allowedTools: ["Read", 42],
    })).rejects.toThrow(/allowedTools\[1\].*must be string/i);
  });

  it("accepts allowedTools and disallowedTools absent from the request", async () => {
    await expect(assertToolRequest("stratum_agent_run", {
      agent: "claude", prompt: "p", cwd: "/tmp",
    })).resolves.toBeUndefined();
  });

  it("accepts a bg_started response without pid (pid is optional)", async () => {
    await expect(assertToolResponse("stratum_agent_run", {
      status: "bg_started", runId: "r123abc00001", streamPath: "/tmp/stream.jsonl",
    })).resolves.toBeUndefined();
  });
});

async function initializeMcpBin(bin: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`MCP bin did not initialize: ${stderr}`)); }, 5_000);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split("\n").find((candidate) => candidate.trim());
      if (!line) return;
      try { const parsed = JSON.parse(line) as Record<string, unknown>; clearTimeout(timeout); child.kill(); resolve(parsed); } catch { /* wait for a complete JSON-RPC line */ }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "p5", version: "0" } } })}\n`);
  });
}
