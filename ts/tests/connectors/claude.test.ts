import { describe, expect, it, vi } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";

async function* messages() {
  yield { type: "system", subtype: "init", model: "claude-sonnet-4-6-20260701" };
  yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
  yield {
    type: "result", subtype: "success", result: "echo ok", duration_ms: 42, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.01, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, dispatches: 50 },
  };
}

describe("ClaudeConnector", () => {
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
        cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", tools: ["Read"],
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

  it("omits usd and usdSource entirely for a zero-cost result (receipts require provenance whenever usd is present)", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "success", result: "free", duration_ms: 3, total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 1 } };
    };
    const result = await new ClaudeConnector({ query }).run("test");
    expect(result.usage).toEqual({ tokens: 3, ms: 3 });
    expect(result).not.toHaveProperty("usdSource");
  });

  it("fails on an SDK terminal error result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["auth failed"], duration_ms: 2 };
    };
    await expect(new ClaudeConnector({ query }).run("test")).rejects.toThrow("auth failed");
  });
});
