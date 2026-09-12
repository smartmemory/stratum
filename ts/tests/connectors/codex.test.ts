import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  applyHeadlessShellEnv,
  CodexConnector,
  CODEX_SANDBOX_PREAMBLE,
  codexExecArgs,
  resolveCodexTransport,
  resolveHeadlessShellPath,
  type SpawnProcess,
  withSandboxPreamble,
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
      yield { type: "thread.started" as const, thread_id: "thread-1" };
      yield {
        type: "item.completed" as const,
        item: {
          id: "cmd-1", type: "command_execution" as const, command: "npm test",
          aggregated_output: "ok", exit_code: 0, status: "completed" as const,
        },
      };
      yield {
        type: "item.completed" as const,
        item: { id: "edit-1", type: "file_change" as const, changes: [{ path: "/work/a.ts", kind: "update" as const }], status: "completed" as const },
      };
      yield { type: "item.completed" as const, item: { id: "r-1", type: "reasoning" as const, text: "checking" } };
      yield { type: "item.completed" as const, item: { id: "m-1", type: "agent_message" as const, text: "echo ok" } };
      yield { type: "turn.completed" as const, usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 } };
    }
    const runStreamed = vi.fn(async () => ({ events: events() }));
    const startThread = vi.fn(() => ({ runStreamed }));
    const sdkFactory = vi.fn(() => ({ startThread }));
    const connectorEvents: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    const connector = new CodexConnector({
      model: "gpt-5.3-codex-spark/low",
      cwd: "/work",
      sandboxMode: "workspace-write",
      env: { PATH: "/definitely-missing", ANTHROPIC_API_KEY: "must-not-leak" },
      sdkFactory,
      onEvent: async (event) => { connectorEvents.push(event); },
    });

    let settled = false;
    const pending = connector.run("echo test").finally(() => { settled = true; });
    await vi.waitFor(() => expect(runStreamed).toHaveBeenCalledWith(withSandboxPreamble("echo test"), { signal: expect.any(AbortSignal) }));
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
    expect(connectorEvents).toEqual([
      {
        kind: "agent_started",
        metadata: { agent: "codex", model: "gpt-5.3-codex-spark/low", prompt_chars: withSandboxPreamble("echo test").length },
      },
      {
        kind: "tool_use_summary",
        metadata: {
          tool: "bash", summary: "npm test", ok: true, duration_ms: 0,
          input: { command: "npm test" },
        },
      },
      {
        kind: "tool_use_summary",
        metadata: {
          tool: "edit", summary: "edit /work/a.ts", ok: true, duration_ms: 0,
          input: { file_path: "/work/a.ts" },
        },
      },
      { kind: "agent_relay", metadata: { text: "checking", role: "system" } },
      { kind: "agent_relay", metadata: { text: "echo ok", role: "assistant" } },
      {
        kind: "step_usage",
        metadata: {
          input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0, model: "gpt-5.3-codex-spark/low",
        },
      },
    ]);
  });

  it("step_usage carries RAW provider numbers: input_tokens INCLUDES cached", async () => {
    // Guardrail (2026-09-12). OpenAI's input_tokens includes cached_input_tokens, which does
    // NOT match the consumer's pricing convention -- a consumer summing these events bills the
    // cached portion twice (measured 2.76x on a real call). That is a genuine defect, but it
    // MUST be fixed in the consumer's cost math, never by translating here: compose's routing
    // evidence guard (lib/routing-runtime.js:187-196) refuses with ROUTING_CALL_EVIDENCE_CONFLICT
    // when any forwarded field differs from this connector's own evidence. Subtracting cached
    // tokens here was tried and reverted; it failed 15 compose tests with "Forwarded tokens
    // differs from original connector evidence". This test pins the raw passthrough.
    const connectorEvents: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    async function* events() {
      yield { type: "thread.started" as const, thread_id: "thread-1" };
      yield { type: "item.completed" as const, item: { id: "m-1", type: "agent_message" as const, text: "done" } };
      yield { type: "turn.completed" as const, usage: { input_tokens: 10, cached_input_tokens: 6, output_tokens: 5, reasoning_output_tokens: 0 } };
    }
    const connector = new CodexConnector({
      model: "gpt-5.3-codex-spark/low", cwd: "/work", sandboxMode: "workspace-write", env: { PATH: "/definitely-missing" },
      onEvent: async (event) => { connectorEvents.push(event); },
      sdkFactory: vi.fn(() => ({ startThread: vi.fn(() => ({ runStreamed: vi.fn(async () => ({ events: events() })) })) })),
    });
    const result = await connector.run("raw me");

    const usage = connectorEvents.find(e => e.kind === "step_usage");
    expect(usage?.metadata).toMatchObject({
      input_tokens: 10,             // RAW: includes the 6 cached. Never 10 - 6.
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 0,
      output_tokens: 5,
    });
    // Codex reports no cost, so the key is omitted rather than stamped as a false $0.
    expect(usage?.metadata).not.toHaveProperty("cost_usd");
    // The event's numbers are IDENTICAL to the connector's own evidence -- that identity
    // is what compose's routing evidence guard checks.
    expect(result.usage.tokens).toBe(15);
    expect(result.split).toMatchObject({ input: 10, output: 5, cacheRead: 6 });
  });

  it("carries the reported cost, provenance and cache split on the SDK success path", async () => {
    // Regression (2026-09-10): the success returns rebuilt usage by hand and dropped the
    // accumulated usd/usdSource/cacheRead that the failure path already attached, so every
    // successful codex call reached the ledger cost-unknown.
    async function* events() {
      yield { type: "thread.started" as const, thread_id: "thread-1" };
      yield { type: "item.completed" as const, item: { id: "m-1", type: "agent_message" as const, text: "done" } };
      yield { type: "turn.completed" as const, usage: { input_tokens: 10, cached_input_tokens: 6, output_tokens: 5, reasoning_output_tokens: 0, total_cost_usd: 0.001 } as never };
    }
    const connector = new CodexConnector({
      model: "gpt-6-astra/high", cwd: "/work", sandboxMode: "workspace-write", env: { PATH: "/definitely-missing" },
      sdkFactory: vi.fn(() => ({ startThread: vi.fn(() => ({ runStreamed: vi.fn(async () => ({ events: events() })) })) })),
    });
    const result = await connector.run("price me");
    expect(result.usage).toMatchObject({ tokens: 15, usd: 0.001 });
    expect(result.usdSource).toBe("reported");
    expect(result.split).toEqual({ input: 10, output: 5, cacheRead: 6 });
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

  it("frames every dispatch with the sandbox preamble, exactly once", async () => {
    expect(withSandboxPreamble("do the task")).toBe(`${CODEX_SANDBOX_PREAMBLE}\n\ndo the task`);
    expect(withSandboxPreamble(withSandboxPreamble("do the task"))).toBe(
      `${CODEX_SANDBOX_PREAMBLE}\n\ndo the task`,
    );

    const spawn = fakeSpawn([{ type: "item.completed", item: { type: "agent_message", text: "ok" } }]);
    const connector = new CodexConnector({ transport: "exec", spawn });
    const stdinChunks: string[] = [];
    spawn.mockImplementationOnce((command, args, options) => {
      const child = fakeSpawn([{ type: "item.completed", item: { type: "agent_message", text: "ok" } }])(command, args, options);
      child.stdin.on("data", (chunk: Buffer) => stdinChunks.push(chunk.toString("utf8")));
      return child;
    });
    await connector.run("do the task");
    expect(stdinChunks.join("")).toBe(`${CODEX_SANDBOX_PREAMBLE}\n\ndo the task`);
  });

  it("preserves a caller-set PUPPETEER_EXECUTABLE_PATH", () => {
    const env: NodeJS.ProcessEnv = { PUPPETEER_EXECUTABLE_PATH: "/custom/chrome" };
    applyHeadlessShellEnv(env, mkdtempSync(join(tmpdir(), "stratum-no-cache-")));
    expect(env.PUPPETEER_EXECUTABLE_PATH).toBe("/custom/chrome");
  });

  it("resolves the newest cached chrome-headless-shell, or nothing", () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "stratum-no-cache-"));
    expect(resolveHeadlessShellPath(emptyHome)).toBeUndefined();

    const home = mkdtempSync(join(tmpdir(), "stratum-shell-cache-"));
    const root = join(home, ".cache", "puppeteer", "chrome-headless-shell");
    const binary = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
    for (const version of ["mac_arm-131.0.6778.204", "mac_arm-146.0.7680.153", "mac_arm-134.0.6998.35"]) {
      const dir = join(root, version, `chrome-headless-shell-${version.split("-")[0]}64`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, binary), "");
    }
    expect(resolveHeadlessShellPath(home)).toBe(
      join(root, "mac_arm-146.0.7680.153", "chrome-headless-shell-mac_arm64", binary),
    );

    const env: NodeJS.ProcessEnv = {};
    applyHeadlessShellEnv(env, home);
    expect(env.PUPPETEER_EXECUTABLE_PATH).toBe(resolveHeadlessShellPath(home));
  });
});
