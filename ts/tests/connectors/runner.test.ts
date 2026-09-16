import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { QueryFunction } from "../../src/connectors/claude.js";
import type { SpawnProcess } from "../../src/connectors/codex.js";
import { runAgent } from "../../src/connectors/runner.js";

// Minimal stub query: emits one success result event (no real SDK call)
const stubClaudeQuery: QueryFunction = async function* () {
  yield {
    type: "result",
    subtype: "success",
    result: "stub ok",
    duration_ms: 0,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};

// Minimal fake codex exec spawn that emits one agent_message then exits 0
function fakeCodexSpawn(text = "stub ok"): SpawnProcess {
  return vi.fn<SpawnProcess>(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      (child.stdout as PassThrough).write(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n",
      );
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit("close", 0, null);
    });
    return child;
  });
}

describe("runAgent discriminant validation (4c)", () => {
  it("rejects unknown agent values with 'Unknown agent'", async () => {
    await expect(
      runAgent({ agent: "gemini" as "claude", prompt: "p", cwd: "/tmp" }),
    ).rejects.toThrow("Unknown agent");
  });

  it("rejects unknown sandboxMode values with 'Unknown sandboxMode'", async () => {
    await expect(
      runAgent({ agent: "codex", sandboxMode: "locked" as "read-only", prompt: "p", cwd: "/tmp" }),
    ).rejects.toThrow("Unknown sandboxMode");
  });

  it("rejects foreground claude with sandboxMode read-only (D8: unenforceable, no false guarantee)", async () => {
    await expect(
      runAgent({ agent: "claude", sandboxMode: "read-only", prompt: "p", cwd: "/tmp" }),
    ).rejects.toThrow('sandboxMode="read-only" are not supported');
  });

  it("rejects an empty-string sandboxMode (must not silently fall back to the default)", async () => {
    await expect(
      runAgent({ agent: "claude", sandboxMode: "" as "read-only", prompt: "p", cwd: "/tmp", background: true }),
    ).rejects.toThrow("Unknown sandboxMode");
  });

  it("accepts claude agent and runs the foreground connector path", async () => {
    const result = await runAgent(
      { agent: "claude", prompt: "test", cwd: "/tmp" },
      { claudeQuery: stubClaudeQuery },
    );
    expect(result).toMatchObject({ text: "stub ok" });
  });

  it("accepts codex agent with read-only sandboxMode and runs the foreground connector path", async () => {
    const result = await runAgent(
      { agent: "codex", sandboxMode: "read-only", prompt: "test", cwd: "/tmp" },
      { codexSpawn: fakeCodexSpawn() },
    );
    expect(result).toMatchObject({ text: "stub ok" });
  });

  it("accepts codex agent with workspace-write sandboxMode on the foreground path", async () => {
    const result = await runAgent(
      { agent: "codex", sandboxMode: "workspace-write", prompt: "test", cwd: "/tmp" },
      { codexSpawn: fakeCodexSpawn() },
    );
    expect(result).toMatchObject({ text: "stub ok" });
  });

  it("accepts opted-in codex danger-full-access and rejects that Codex-only mode for claude", async () => {
    const result = await runAgent(
      {
        agent: "codex", sandboxMode: "danger-full-access" as never, prompt: "test", cwd: "/tmp",
        env: { STRATUM_CODEX_ALLOW_FULL_ACCESS: "on" },
      },
      { codexSpawn: fakeCodexSpawn() },
    );
    expect(result).toMatchObject({ text: "stub ok" });
    await expect(runAgent({
      agent: "claude", sandboxMode: "danger-full-access" as never, prompt: "test", cwd: "/tmp",
    }, { claudeQuery: stubClaudeQuery })).rejects.toThrow("Codex-only");
  });
});

describe("provider settings are enforced at dispatch", () => {
  it("binds Claude thinking, effort and exact tool restrictions to the SDK", async () => {
    let received: Record<string, unknown> | undefined;
    const query: QueryFunction = async function* ({ options }) { received = options; yield { type: "result", subtype: "success", result: "ok" }; };
    await runAgent({ agent: "claude", prompt: "p", thinking: { type: "adaptive" }, effort: "high", allowedTools: ["Read"], disallowedTools: ["Write"] }, { claudeQuery: query });
    expect(received).toMatchObject({ thinking: { type: "adaptive" }, effort: "high", tools: ["Read"], disallowedTools: ["Write"] });
  });
  it("rejects unsupported provider options before execution", async () => {
    await expect(runAgent({ agent: "codex", prompt: "p", allowedTools: ["Read"] })).rejects.toThrow("does not support");
    await expect(runAgent({ agent: "codex", prompt: "p", thinking: { type: "adaptive" } })).rejects.toThrow("does not support");
    await expect(runAgent({ agent: "claude", prompt: "p", thinking: { type: "enabled", budgetTokens: -1 } })).rejects.toThrow("invalid Claude thinking");
    await expect(runAgent({ agent: "claude", prompt: "p", effort: "turbo" })).rejects.toThrow("unsupported Claude effort");
    await expect(runAgent({ agent: "codex", prompt: "p", model: "gpt-5/high", effort: "low" })).rejects.toThrow("conflicts");
  });
  it("binds explicit Codex effort into the actual CLI arguments", async () => {
    const spawn = fakeCodexSpawn();
    await runAgent({ agent: "codex", prompt: "p", model: "gpt-5", effort: "low" }, { codexSpawn: spawn });
    expect(spawn).toHaveBeenCalledWith("codex", expect.arrayContaining(['model_reasoning_effort="low"']), expect.any(Object));
  });
});
