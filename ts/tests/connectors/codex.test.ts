import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CodexConnector, codexExecArgs, type SpawnProcess } from "../../src/connectors/codex.js";
import { runAgent } from "../../src/connectors/runner.js";

function fakeSpawn(records: unknown[], exitCode = 0, stderr = "") {
  const spawn = vi.fn<SpawnProcess>(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderrStream = new PassThrough();
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderrStream;
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      for (const record of records) stdout.write(`${JSON.stringify(record)}\n`);
      stderrStream.end(stderr);
      stdout.end();
      child.emit("close", exitCode, null);
    });
    return child;
  });
  return spawn;
}

describe("CodexConnector", () => {
  it("builds argv byte-for-byte like Python _exec_args", () => {
    expect(codexExecArgs("gpt-5.3-codex-spark/low", "/work", "read-only")).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
      "-m", "gpt-5.3-codex-spark", "-C", "/work",
      "-c", 'model_reasoning_effort="low"', "-",
    ]);
    expect(codexExecArgs("gpt-5", "/work", "workspace-write")).toEqual([
      "exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write",
      "-m", "gpt-5", "-C", "/work", "-",
    ]);
  });

  it("runs codex exec --json and returns capped, engine-safe telemetry", async () => {
    const spawn = fakeSpawn([
      { type: "thread.started", thread_id: "t-1" },
      { type: "item.completed", item: { type: "agent_message", text: "echo ok" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 1, dispatches: 99 } },
    ]);
    const connector = new CodexConnector({ model: "gpt-5.3-codex-spark/low", cwd: "/work", spawn });

    const result = await connector.run("echo test");

    expect(spawn).toHaveBeenCalledWith("codex", codexExecArgs("gpt-5.3-codex-spark/low", "/work", "read-only"), expect.objectContaining({ cwd: "/work" }));
    expect(result).toMatchObject({
      text: "echo ok",
      usage: { tokens: 7 },
      telemetry: { model: "gpt-5.3-codex-spark", effort: "low" },
    });
    expect(result.telemetry.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).not.toHaveProperty("dispatches");
  });

  it("surfaces codex error records loudly", async () => {
    const connector = new CodexConnector({ spawn: fakeSpawn([{ type: "error", message: "codex unhappy" }]) });
    await expect(connector.run("test")).rejects.toThrow("codex unhappy");
  });

  for (const [variant, payload] of [
    ["unterminated", "x".repeat(70_000)],
    ["newline-terminated", `${"x".repeat(70_000)}\n`],
    // 30k chars but ~90KB of UTF-8 — the cap counts bytes, not UTF-16 units.
    ["multibyte", `${"€".repeat(30_000)}\n`],
  ] as const) {
    it(`fails loudly when a ${variant} stdout line exceeds STRATUM_CODEX_STREAM_LIMIT_BYTES`, async () => {
      vi.stubEnv("STRATUM_CODEX_STREAM_LIMIT_BYTES", "1"); // floors to 64 KiB
      try {
        let killed = false;
        const spawn: SpawnProcess = () => {
          const child = new EventEmitter() as ChildProcessWithoutNullStreams;
          child.stdin = new PassThrough();
          const stdout = new PassThrough();
          child.stdout = stdout;
          child.stderr = new PassThrough();
          child.kill = vi.fn(() => {
            killed = true;
            queueMicrotask(() => child.emit("close", null, "SIGKILL"));
            return true;
          });
          queueMicrotask(() => { stdout.write(payload); });
          return child;
        };
        const connector = new CodexConnector({ spawn });
        await expect(connector.run("test")).rejects.toThrow("exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES");
        expect(killed).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  }

  it("keeps background false on the synchronous connector path", async () => {
    const spawn = fakeSpawn([{ type: "item.completed", item: { type: "agent_message", text: "sync ok" } }]);
    const result = await runAgent(
      { agent: "codex", prompt: "p", cwd: "/work", background: false },
      { codexSpawn: spawn },
    );
    expect(result).toMatchObject({ text: "sync ok" });
    expect(result).not.toHaveProperty("runId");
  });
});
