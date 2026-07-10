import { describe, expect, it, vi } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";

async function* messages() {
  yield { type: "system", subtype: "init", model: "claude-sonnet-4-6-20260701" };
  yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
  yield {
    type: "result", subtype: "success", result: "echo ok", duration_ms: 42, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, dispatches: 50 },
  };
}

describe("ClaudeConnector", () => {
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
        cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", allowedTools: ["Read"],
      }),
    });
    expect(result).toEqual({
      text: "echo ok",
      usage: { usd: 0.01, tokens: 7, ms: 42 },
      telemetry: { durationMs: 42, model: "claude-sonnet-4-6-20260701" },
    });
    expect(result.usage).not.toHaveProperty("dispatches");
  });

  it("fails on an SDK terminal error result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["auth failed"], duration_ms: 2 };
    };
    await expect(new ClaudeConnector({ query }).run("test")).rejects.toThrow("auth failed");
  });
});
