import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createToolDispatcher } from "../../src/mcp/server.js";

it.each([false, true])("rejects bad agent at MCP before dispatch or registry writes (flow=%s)", async (flow) => {
  const root = await mkdtemp(join(tmpdir(), "stratum-invalid-agent-"));
  const runAgent = vi.fn();
  const dispatcher = createToolDispatcher({ runAgent, foregroundRegistryRoot: root });
  try {
    await expect(dispatcher.call("stratum_agent_run", {
      agent: "gemini", prompt: "p", cwd: root,
      ...(flow ? { cancellationId: randomUUID(), flow: { runId: "unused" } } : {}),
    })).rejects.toThrow('Unknown agent "gemini"; expected codex or claude');
    expect(runAgent).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  { name: "unknown", model: "typo", env: "gpt-5.6-terra/high", effort: undefined, message: 'Unknown Codex model "typo"' },
  { name: "retired", model: "gpt-5.3-codex-spark/low", env: "gpt-5.6-terra/high", effort: undefined, message: "retired upstream 2026-09-16" },
  { name: "invalid CODEX_MODEL default", model: undefined, env: "env-typo/high", effort: undefined, message: 'Unknown Codex model "env-typo"' },
  { name: "effort conflict", model: "gpt-6-sol/low", env: "gpt-5.6-terra/high", effort: "high", message: "Codex effort conflicts" },
])("rejects $name before creating a registry directory or consuming the cancellation id", async ({ model, env, message, effort }) => {
  const root = await mkdtemp(join(tmpdir(), "stratum-invalid-model-"));
  const registryRoot = join(root, "registry");
  vi.stubEnv("CODEX_MODEL", env);
  const runAgent = vi.fn(async () => ({ text: "done", usage: { tokens: 0 }, telemetry: { durationMs: 0, model: "gpt-6-sol" } }));
  const engine = new StratumEngine({ stateRoot: join(root, "state"), evaluator: createEvaluator() });
  const dispatcher = createToolDispatcher({ engine, runAgent, foregroundRegistryRoot: registryRoot });
  try {
    const planned = await dispatcher.call("stratum_plan", {
      spec: {
        version: 1, contracts: { Result: { value: "string" } },
        flows: { entry: "main", main: {
          input: {}, output: { from: "${build.output}", contract: "Result" },
          steps: [{ id: "build", do: "build", out: "Result" }],
        } },
      }, input: {},
    });
    const request = {
      agent: "codex", prompt: "p", cwd: root, cancellationId: randomUUID(),
      flow: { runId: planned.runId }, ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
    };
    await expect(dispatcher.call("stratum_agent_run", request)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { code: "input_validation_failed", errors: [
        { code: "input_validation_failed", path: "model", message: expect.stringContaining(message) },
      ] },
    });
    expect(runAgent).not.toHaveBeenCalled();
    await expect(stat(registryRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(dispatcher.call("stratum_agent_run", { ...request, model: "gpt-6-sol" }))
      .resolves.toMatchObject({ status: "complete", text: "done" });
    expect(runAgent).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
