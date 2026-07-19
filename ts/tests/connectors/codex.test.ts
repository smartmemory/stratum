import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  CodexConnector,
  codexExecArgs,
  resolveCodexTransport,
  type SpawnProcess,
} from "../../src/connectors/codex.js";
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

  it("defaults to sdk and validates the explicit compatibility transport", () => {
    expect(resolveCodexTransport({})).toBe("sdk");
    expect(resolveCodexTransport({ STRATUM_CODEX_TRANSPORT: " EXEC " })).toBe("exec");
    expect(() => resolveCodexTransport({ STRATUM_CODEX_TRANSPORT: "rescue" })).toThrow("expected sdk or exec");
  });

  it("uses the Codex SDK by default and awaits the turn before returning", async () => {
    let finish: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    async function* events() {
      await blocked;
      yield { type: "item.completed" as const, item: { id: "m-1", type: "agent_message" as const, text: "echo ok" } };
      yield { type: "turn.completed" as const, usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 } };
    }
    const runStreamed = vi.fn(async () => ({ events: events() }));
    const startThread = vi.fn(() => ({ runStreamed }));
    const sdkFactory = vi.fn(() => ({ startThread }));
    const connector = new CodexConnector({
      model: "gpt-5.3-codex-spark/low",
      cwd: "/work",
      sandboxMode: "workspace-write",
      env: { PATH: "/definitely-missing", ANTHROPIC_API_KEY: "must-not-leak" },
      sdkFactory,
    });

    let settled = false;
    const pending = connector.run("echo test").finally(() => { settled = true; });
    await vi.waitFor(() => expect(runStreamed).toHaveBeenCalledWith("echo test", { signal: expect.any(AbortSignal) }));
    expect(settled).toBe(false);
    finish?.();

    await expect(pending).resolves.toMatchObject({
      text: "echo ok",
      usage: { tokens: 7 },
      telemetry: { model: "gpt-5.3-codex-spark", effort: "low" },
    });
    expect(sdkFactory).toHaveBeenCalledWith({ env: { PATH: "/definitely-missing" } });
    expect(startThread).toHaveBeenCalledWith({
      approvalPolicy: "never",
      model: "gpt-5.3-codex-spark",
      modelReasoningEffort: "low",
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
      workingDirectory: "/work",
    });
  });

  it("keeps four concurrent SDK turns owned until every turn settles", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    const sdkFactory = vi.fn(() => ({
      startThread: vi.fn((options: { workingDirectory?: string }) => ({
        runStreamed: vi.fn(async () => ({
          events: (async function* () {
            active += 1;
            await new Promise<void>((resolve) => { releases.push(resolve); });
            active -= 1;
            yield { type: "item.completed" as const, item: { id: "m-1", type: "agent_message" as const, text: options.workingDirectory ?? "missing cwd" } };
            yield { type: "turn.completed" as const, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
          })(),
        })),
      })),
    }));
    const runs = Array.from({ length: 4 }, (_, index) => new CodexConnector({
      cwd: `/work/${index}`,
      env: { PATH: "/definitely-missing" },
      sdkFactory,
    }).run(`task ${index}`));

    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(active).toBe(4);
    for (const release of releases) release();

    const results = await Promise.all(runs);
    expect(results.map((result) => result.text)).toEqual(["/work/0", "/work/1", "/work/2", "/work/3"]);
    expect(active).toBe(0);
  });

  it("surfaces Codex SDK error events loudly", async () => {
    async function* events() { yield { type: "error" as const, message: "sdk unhappy" }; }
    const sdkFactory = vi.fn(() => ({
      startThread: vi.fn(() => ({ runStreamed: vi.fn(async () => ({ events: events() })) })),
    }));
    const connector = new CodexConnector({ sdkFactory });
    await expect(connector.run("test")).rejects.toThrow("sdk unhappy");
  });

  it("fails loudly and aborts when an SDK JSONL event exceeds STRATUM_CODEX_STREAM_LIMIT_BYTES", async () => {
    vi.stubEnv("STRATUM_CODEX_STREAM_LIMIT_BYTES", "1"); // floors to 64 KiB
    try {
      let signal: AbortSignal | undefined;
      let streamClosed = false;
      async function* events() {
        try {
          yield {
            type: "item.completed" as const,
            item: {
              id: "command-1",
              type: "command_execution" as const,
              command: "runaway",
              aggregated_output: "x".repeat(70_000),
              exit_code: 0,
              status: "completed" as const,
            },
          };
        } finally {
          streamClosed = true;
        }
      }
      const runStreamed = vi.fn(async (_input: string, options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return { events: events() };
      });
      const sdkFactory = vi.fn(() => ({
        startThread: vi.fn(() => ({ runStreamed })),
      }));
      const connector = new CodexConnector({ sdkFactory });

      await expect(connector.run("test")).rejects.toThrow("exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES");
      expect(signal?.aborted).toBe(true);
      expect(streamClosed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps injected codex exec as the capped compatibility transport", async () => {
    const spawn = fakeSpawn([
      { type: "thread.started", thread_id: "t-1" },
      { type: "item.completed", item: { type: "agent_message", text: "echo ok" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 1, dispatches: 99 } },
    ]);
    const connector = new CodexConnector({ model: "gpt-5.3-codex-spark/low", cwd: "/work", transport: "exec", spawn });

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

  it("surfaces codex exec error records loudly", async () => {
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
