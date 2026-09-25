import { describe, expect, it, vi } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StratumEngine } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { spineSpent } from "../../src/engine/receipts.js";
import { createEvaluator } from "../../src/eval/expr.js";

async function* messages() {
  yield { type: "system", subtype: "init", model: "claude-sonnet-4-6-20260701" };
  yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
  yield {
    type: "result", subtype: "success", result: "echo ok", duration_ms: 42, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.01, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, dispatches: 50 },
  };
}

describe("ClaudeConnector", () => {
  describe.each(["success", "terminal error", "SDK throw"])("%s effort telemetry", (outcome) => {
    it.each(["low", "max", undefined])("reports only the dispatched effort (%s)", async (effort) => {
      const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
      const query = vi.fn<QueryFunction>(async function* () {
        if (outcome === "SDK throw") throw new Error("SDK failed");
        yield {
          type: "result", subtype: outcome === "success" ? "success" : "error_during_execution",
          result: "done", errors: ["query failed"], usage: { input_tokens: 3, output_tokens: 4 },
        };
      });
      const run = new ClaudeConnector({
        ...(effort !== undefined ? { effort } : {}), query, onEvent: event => { events.push(event); },
      }).run("test");
      const result = outcome === "success" ? await run : await run.catch(error => error);
      if (outcome !== "success") expect(result).toBeInstanceOf(Error);
      const sdkOptions = query.mock.calls[0]![0].options!;
      const identities = [sdkOptions, result.telemetry, ...events.filter(event => event.kind === "step_usage").map(event => event.metadata)];
      expect(events.filter(event => event.kind === "step_usage")).toHaveLength(outcome === "SDK throw" ? 0 : 1);
      for (const identity of identities) {
        if (effort === undefined) expect(identity).not.toHaveProperty("effort");
        else expect(identity).toHaveProperty("effort", effort);
      }
    });
  });

  it("omits effort when an event handler fails before SDK dispatch", async () => {
    const query = vi.fn<QueryFunction>(() => messages());
    const failure = await new ClaudeConnector({
      effort: "high", query, onEvent: () => { throw new Error("event failed"); },
    }).run("test").catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(query).not.toHaveBeenCalled();
    expect(failure.telemetry).not.toHaveProperty("effort");
  });

  async function capturedTools(options: ConstructorParameters<typeof ClaudeConnector>[0]): Promise<unknown> {
    let tools: unknown;
    const query: QueryFunction = async function* ({ options: sdkOptions }) {
      tools = sdkOptions?.tools;
      yield { type: "result", subtype: "success", result: "ok" };
    };
    await new ClaudeConnector({ ...options, query }).run("test");
    return tools;
  }

  it("adds ToolSearch to an explicit allowedTools restriction", async () => {
    await expect(capturedTools({ allowedTools: ["Read", "Bash"] }))
      .resolves.toEqual(["Read", "Bash", "ToolSearch"]);
  });

  it("does not duplicate ToolSearch when it is already allowed", async () => {
    await expect(capturedTools({ allowedTools: ["Read", "ToolSearch"] }))
      .resolves.toEqual(["Read", "ToolSearch"]);
  });

  it("respects an explicit ToolSearch disallow", async () => {
    await expect(capturedTools({ allowedTools: ["Read"], disallowedTools: ["ToolSearch"] }))
      .resolves.toEqual(["Read"]);
  });

  it("keeps the Claude Code preset when allowedTools is undefined", async () => {
    await expect(capturedTools({}))
      .resolves.toEqual({ type: "preset", preset: "claude_code" });
  });

  it("maps live assistant, tool, result, and usage messages to connector events", async () => {
    const query: QueryFunction = async function* () {
      yield {
        type: "assistant",
        message: { content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/a.ts" } },
        ] },
      };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "contents", is_error: false }] },
      };
      yield {
        type: "result", subtype: "success", result: "done", duration_ms: 5, total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.01, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 },
      };
    };
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    const connector = new ClaudeConnector({
      model: "claude-test",
      query,
      onEvent: async (event) => { events.push(event); },
    });

    await expect(connector.run("ping")).resolves.toMatchObject({ text: "done", usage: { tokens: 7 } });
    expect(events).toEqual([
      { kind: "agent_started", metadata: { agent: "claude", model: "claude-test", prompt_chars: 4 } },
      { kind: "agent_relay", metadata: { text: "working", role: "assistant" } },
      {
        kind: "tool_use_summary",
        metadata: {
          tool: "Read", summary: "/work/a.ts", ok: true, duration_ms: 0,
          input: { file_path: "/work/a.ts" }, tool_use_id: "toolu_1",
        },
      },
      { kind: "tool_result", metadata: { tool_use_id: "toolu_1", ok: true, output: "contents" } },
      {
        kind: "step_usage",
        metadata: {
          input_tokens: 3, output_tokens: 4, cost_usd: 0.01, usd_source: "reported",
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1, model: "claude-test",
        },
      },
    ]);
  });

  it("uses agent-sdk query() through a narrow boundary and reports resolved telemetry", async () => {
    const query = vi.fn<QueryFunction>(() => messages());
    const connector = new ClaudeConnector({
      model: "claude-sonnet-4-6",
      cwd: "/work",
      allowedTools: ["Read"],
      query,
    });

    const result = await connector.run("echo test");

    expect(query).toHaveBeenCalledWith({
      prompt: "echo test",
      options: expect.objectContaining({
        cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", tools: ["Read", "ToolSearch"],
      }),
    });
    expect(result).toEqual({
      text: "echo ok",
      usage: { usd: 0.01, tokens: 7, ms: 42 },
      split: { input: 3, output: 4, cacheRead: 1, cacheCreation: 2 },
      usdSource: "reported",
      telemetry: { durationMs: 42, model: "claude-sonnet-4-6-20260701" },
    });
    expect(result.usage).not.toHaveProperty("dispatches");
  });

  it("preserves a reported zero-cost result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "success", result: "free", duration_ms: 3, total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 1 } };
    };
    const result = await new ClaudeConnector({ query }).run("test");
    expect(result.usage).toEqual({ tokens: 3, ms: 3, usd: 0 });
    expect(result.usdSource).toBe("reported");
  });

  it("fails on an SDK terminal error result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["auth failed"], duration_ms: 2 };
    };
    await expect(new ClaudeConnector({ query }).run("test")).rejects.toThrow("auth failed");
  });
});

// Replay SDK result frames at the transport seam; the connector and both engine
// settlement paths are production code, and assertions reload receipts from disk.
describe.each(["stepDone", "usageReport"] as const)("Claude %s receipts", (settlement) => {
  it.each([
    ["absent", undefined, undefined], ["zero", 0, 0], ["positive", 0.01, 0.01],
    ["negative", -1, undefined], ["null", null, undefined], ["string", "0", undefined],
    ["NaN", NaN, undefined], ["infinite", Infinity, undefined],
  ])("preserves %s provider cost", async (_label, cost, expected) => {
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    const query: QueryFunction = async function* () {
      for await (const frame of messages()) {
        if (frame.type !== "result") { yield frame; continue; }
        const { total_cost_usd: _cost, ...rest } = frame;
        yield { ...rest, ...(cost !== undefined ? { total_cost_usd: cost } : {}) };
      }
    };
    const result = await new ClaudeConnector({ query, onEvent: event => { events.push(event); } }).run("test");
    const metadata = events.find(event => event.kind === "step_usage")!.metadata;
    const expectedUsd = expected === undefined ? {} : { usd: expected };
    expect(result.usage).toEqual({ tokens: 7, ms: 42, ...expectedUsd });
    if (expected === undefined) {
      expect(result).not.toHaveProperty("usdSource");
      expect(metadata).not.toHaveProperty("cost_usd");
      expect(metadata).not.toHaveProperty("usd_source");
    } else {
      expect(result.usdSource).toBe("reported");
      expect(metadata).toMatchObject({ cost_usd: expected, usd_source: "reported" });
    }
    const root = await mkdtemp(join(tmpdir(), "claude-cost-receipts-"));
    try {
      const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
      const planned = await engine.plan({
        version: 1, contracts: { Result: { value: "string" } },
        flows: { entry: "main", main: {
          input: {}, output: { from: "${work.output}", contract: "Result" },
          budget: { usd: 0.005, tokens: 100 },
          steps: [{ id: "work", do: "work", out: "Result" }],
        } },
      }, {});
      if (planned.status !== "ready") throw new Error("expected ready step");
      const dispatchId = planned.ready[0]!.dispatchToken;
      if (settlement === "usageReport") {
        await engine.usageReport(planned.runId, { ...result, dispatchId, stepId: "work", source: "claude" });
      } else {
        await engine.stepDone(planned.runId, "work", { ...result, output: { value: result.text } }, dispatchId);
      }
      const run = await new StateStore(root).load(planned.runId);
      expect(run.receipts).toHaveLength(1);
      const receipt = run.receipts![0]!;
      expect(receipt.amount).toEqual({ tokens: 7, ms: 42, ...expectedUsd });
      if (expected === undefined) expect(receipt).not.toHaveProperty("usdSource");
      else expect(receipt.usdSource).toBe("reported");
      expect(run.flowSpent).toEqual({ dispatches: 1, tokens: 7, ms: 42, ...(expected ? { usd: expected } : {}) });
      expect(spineSpent(run)).toEqual({ tokens: 7, ms: 42, ...(expected ? { usd: expected } : {}) });
      // Unknown cost retains the existing no-debit policy, not a known free price.
      expect(run.status === "budget_exhausted").toBe(expected === 0.01);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.each([undefined, 0, 0.01])("preserves Claude error-frame cost %s", async (cost) => {
  const query: QueryFunction = async function* () {
    yield { type: "result", subtype: "error_during_execution", errors: ["failed"],
      ...(cost !== undefined ? { total_cost_usd: cost } : {}) };
  };
  const failure = await new ClaudeConnector({ query }).run("test").catch(error => error);
  expect(failure.usage).toEqual({ tokens: 0, ms: 0, ...(cost !== undefined ? { usd: cost } : {}) });
  if (cost === undefined) expect(failure).not.toHaveProperty("usdSource");
  else expect(failure.usdSource).toBe("reported");
});
