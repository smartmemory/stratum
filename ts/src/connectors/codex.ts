import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadEvent, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import type { CodexSandboxMode, ConnectorEvent, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { finiteNonnegative, modelIdentity, SMARTMEMORY_SCRUB_VARS } from "./base.js";

import { linkAbort, cancellationGraceMs, processTermination, requireProcessGroups } from "./cancellation.js";

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type CodexTransport = "sdk" | "exec";

/** How long a post-spawn `error` may wait for the matching `close` before the
 * run settles on the error alone. Short: it only covers the gap between the two
 * events for a child that did start. */
const SPAWN_ERROR_CLOSE_MS = 250;

export interface CodexSdkThread {
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexSdkClient {
  startThread(options: ThreadOptions): CodexSdkThread;
}

export type CodexSdkFactory = (options: CodexOptions) => CodexSdkClient;

export interface CodexConnectorOptions {
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  ownProcessGroup?: boolean;
  cancellationGraceMs?: number;
  /** Group-leader pid of the cancellable child, reported as it spawns (S02-1). Invoked only
   *  when ownProcessGroup is true: a non-detached child is not a group leader, so recording
   *  it would produce an entry that fails the processGroupId(pid) === pid gate anyway.
   *  Called synchronously; never awaited. */
  onSpawn?: (pid: number) => void;
  cwd?: string;
  sandboxMode?: CodexSandboxMode;
  env?: NodeJS.ProcessEnv;
  /** SDK is the normal in-process path; exec is an explicit compatibility path. */
  transport?: CodexTransport;
  /** Codex SDK construction seam for tests and embedders. */
  sdkFactory?: CodexSdkFactory;
  /** Process-boundary test seam. */
  spawn?: SpawnProcess;
  onEvent?: ConnectorEventHandler;
}

const CODEX_SCRUB_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE", ...SMARTMEMORY_SCRUB_VARS] as const;

/** GUI apps cannot start inside the Codex OS sandbox: full Chrome aborts
 * (SIGABRT) during WindowServer registration even with --headless. Agents that
 * discover this by crashing tend to retry into a crash loop, so every dispatch
 * states the constraint up front. */
export const CODEX_SANDBOX_PREAMBLE = [
  "[sandbox constraints]",
  "You are running inside a restricted OS sandbox (macOS seatbelt / Linux landlock).",
  "GUI applications cannot start here: full Chrome/Chromium, Electron, or anything",
  "that opens a window aborts at launch (SIGABRT). That abort is the sandbox, not",
  "a bug in the code under test. For browser work use chrome-headless-shell (set",
  "via PUPPETEER_EXECUTABLE_PATH when available) or another headless-only tool.",
  "If a GUI launch aborts, do not retry it.",
  "[/sandbox constraints]",
].join("\n");

/** Deliberately NOT gated on sandboxMode. Both values of CodexSandboxMode
 * ("read-only" | "workspace-write") are passed to `codex --sandbox`, so every
 * dispatch runs under seatbelt/landlock — the modes differ in write permission,
 * not window-server access, and GUI apps abort under both. Gating on the mode
 * would strip the warning from workspace-write agents, which are exactly the
 * ones that run browser tests and crash-looped before this existed. Revisit
 * only if an unsandboxed mode is ever added to CodexSandboxMode. */
export function withSandboxPreamble(prompt: string): string {
  if (prompt.startsWith("[sandbox constraints]")) return prompt;
  return `${CODEX_SANDBOX_PREAMBLE}\n\n${prompt}`;
}

/** Newest chrome-headless-shell in the Puppeteer cache, if any. Sandboxed
 * agents can run this binary where full Chrome aborts (see
 * CODEX_SANDBOX_PREAMBLE), but cannot install it themselves without network. */
export function resolveHeadlessShellPath(home: string = homedir()): string | undefined {
  const root = join(home, ".cache", "puppeteer", "chrome-headless-shell");
  if (!existsSync(root)) return undefined;
  const buildOf = (dir: string): number[] => (dir.split("-").pop() ?? "").split(".").map(Number);
  const versions = readdirSync(root)
    .filter((dir) => /-[\d.]+$/.test(dir))
    .sort((a, b) => {
      const [va, vb] = [buildOf(a), buildOf(b)];
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0);
      }
      return 0;
    });
  const binaryName = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  for (const version of versions) {
    const versionDir = join(root, version);
    const binary = readdirSync(versionDir)
      .filter((dir) => dir.startsWith("chrome-headless-shell-"))
      .map((dir) => join(versionDir, dir, binaryName))
      .find((candidate) => existsSync(candidate));
    if (binary) return binary;
  }
  return undefined;
}

export function applyHeadlessShellEnv(env: NodeJS.ProcessEnv, home?: string): void {
  if (env.PUPPETEER_EXECUTABLE_PATH) return;
  const shell = resolveHeadlessShellPath(home);
  if (shell) env.PUPPETEER_EXECUTABLE_PATH = shell;
}

export function defaultCodexModel(): string {
  return process.env.CODEX_MODEL ?? "gpt-5.6-terra/high";
}

export function resolveCodexTransport(env: NodeJS.ProcessEnv = process.env): CodexTransport {
  const raw = (env.STRATUM_CODEX_TRANSPORT ?? "sdk").trim().toLowerCase();
  if (raw === "sdk" || raw === "exec") return raw;
  throw new Error(`invalid STRATUM_CODEX_TRANSPORT ${JSON.stringify(raw)}; expected sdk or exec`);
}

/** Same knob and bounds as the Python connector (STRAT-MCP-CHUNK-SIZE):
 * codex's --json preamble routinely exceeds 64 KiB, but an unbounded child
 * must not be able to exhaust the connector's memory. */
export function resolveStdoutLimit(): number {
  const raw = process.env.STRATUM_CODEX_STREAM_LIMIT_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const value = Number.isFinite(parsed) ? parsed : 4 * 1024 * 1024;
  return Math.max(value, 64 * 1024);
}

/** Exact TypeScript port of Python CodexConnector._exec_args. */
export function codexExecArgs(
  modelId: string,
  cwd: string,
  sandboxMode: CodexSandboxMode = "read-only",
): string[] {
  const { model, effort } = modelIdentity(modelId);
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    sandboxMode,
    "-m",
    model,
    "-C",
    cwd,
  ];
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push("-");
  return args;
}

export function codexCommand(modelId: string, cwd: string, sandboxMode: CodexSandboxMode): string[] {
  return ["codex", ...codexExecArgs(modelId, cwd, sandboxMode)];
}

export class CodexConnector {
  private readonly model: string;
  private readonly signal: AbortSignal | undefined;
  private readonly cwd: string;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: CodexTransport;
  private readonly ownProcessGroup: boolean;
  private readonly graceMs: number;
  private readonly injectedSpawn: boolean;
  private readonly sdkFactory: CodexSdkFactory;
  private readonly spawn: SpawnProcess;
  private readonly onEvent: ConnectorEventHandler | undefined;
  private readonly onSpawn: ((pid: number) => void) | undefined;

  constructor(options: CodexConnectorOptions = {}) {
    this.model = codexModelWithEffort(options.model ?? (options.effort === undefined ? defaultCodexModel() : modelIdentity(defaultCodexModel()).model), options.effort);
    this.signal = options.signal;
    this.cwd = options.cwd ?? process.cwd();
    this.sandboxMode = options.sandboxMode ?? "read-only";
    this.env = { ...(options.env ?? process.env) };
    for (const key of CODEX_SCRUB_VARS) delete this.env[key];
    // A caller-supplied env is authoritative; the headless-shell default is
    // only layered onto the ambient process.env fallback.
    if (options.env === undefined) applyHeadlessShellEnv(this.env);
    // Passing an injected spawn is itself an explicit request for the legacy
    // process seam. Production selects exec with STRATUM_CODEX_TRANSPORT=exec.
    const selectedTransport = options.transport ?? (options.spawn ? "exec" : resolveCodexTransport(this.env));
    // Owning a process group requires exec. A transport request or signal alone
    // keeps the selected SDK/exec transport; only the MCP cancellation contract
    // opts into process-group ownership.
    this.ownProcessGroup = options.ownProcessGroup === true;
    this.transport = this.ownProcessGroup ? "exec" : selectedTransport;
    this.graceMs = options.cancellationGraceMs ?? cancellationGraceMs(this.env);
    this.injectedSpawn = options.spawn !== undefined;
    this.sdkFactory = options.sdkFactory ?? defaultSdkFactory;
    this.spawn = options.spawn ?? (nodeSpawn as SpawnProcess);
    this.onEvent = options.onEvent;
    this.onSpawn = options.onSpawn;
  }

  async run(prompt: string): Promise<ConnectorResult> {
    this.signal?.throwIfAborted();
    if (this.ownProcessGroup) requireProcessGroups();
    const framed = withSandboxPreamble(prompt);
    return this.transport === "sdk" ? this.runSdk(framed) : this.runExec(framed);
  }

  private async runSdk(prompt: string): Promise<ConnectorResult> {
    const startedAt = Date.now();
    const stdoutLimit = resolveStdoutLimit();
    const controller = new AbortController();
    const unlink = linkAbort(this.signal, controller);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let costUsd = 0;
    try {
      const identity = modelIdentity(this.model);
      const options: ThreadOptions = {
        approvalPolicy: "never",
        model: identity.model,
        sandboxMode: this.sandboxMode,
        skipGitRepoCheck: true,
        workingDirectory: this.cwd,
        ...(identity.effort !== undefined ? { modelReasoningEffort: reasoningEffort(identity.effort) } : {}),
      };
      const pathBinary = pathCodex(this.env);
      const client = this.sdkFactory({ env: stringEnvironment(this.env), ...(pathBinary ? { codexPathOverride: pathBinary } : {}) });
      const streamed = await client.startThread(options).runStreamed(prompt, { signal: controller.signal });
      const text: string[] = [];

      // Consume SDK events directly rather than run(), which buffers every tool
      // and file-change item for the whole turn. Stratum only retains the final
      // agent text and accounting data, matching the direct JSONL transport. The
      // SDK does not expose its raw readline/stderr buffers, so this enforces the
      // same per-JSONL-line bound immediately after each event is yielded.
      for await (const event of streamed.events) {
        if (exceedsStreamLimit(JSON.stringify(event), stdoutLimit)) {
          controller.abort();
          throw stdoutOverrunError(stdoutLimit);
        }
        for (const connectorEvent of codexConnectorEvents(event, this.model, prompt)) {
          await this.emit(connectorEvent);
        }
        if ((event.type === "turn.completed" || event.type === "turn.failed") && "usage" in event && isRecord(event.usage)) {
          inputTokens += finiteNonnegative(event.usage.input_tokens);
          outputTokens += finiteNonnegative(event.usage.output_tokens);
          cacheRead += finiteNonnegative(event.usage.cached_input_tokens);
          costUsd += finiteNonnegative((event.usage as unknown as Record<string, unknown>).total_cost_usd ?? (event.usage as unknown as Record<string, unknown>).cost_usd);
        }
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "item.completed" && event.item.type === "agent_message" && event.item.text) {
          text.push(event.item.text);
        }
      }
      controller.signal.throwIfAborted();
      const durationMs = Math.max(0, Date.now() - startedAt);
      return {
        text: text.join(""),
        usage: { tokens: inputTokens + outputTokens, ms: durationMs },
        split: { input: inputTokens, output: outputTokens },
        telemetry: { durationMs, ...identity },
      };
    } catch (error) {
      throw attachCodexUsage(error, inputTokens, outputTokens, cacheRead, costUsd, Date.now() - startedAt, this.model);
    } finally { unlink(); }
  }

  private async runExec(prompt: string): Promise<ConnectorResult> {
    const startedAt = Date.now();
    const command = this.injectedSpawn ? { command: "codex", prefix: [] } : resolveCodexCommand(this.env);
    const child = this.spawn(command.command, [...command.prefix, ...codexExecArgs(this.model, this.cwd, this.sandboxMode)], {
      cwd: this.cwd,
      env: this.env,
      detached: this.ownProcessGroup && process.platform !== "win32",
    });
    if (this.ownProcessGroup && child.pid !== undefined) this.onSpawn?.(child.pid);
    const termination = processTermination(child, this.ownProcessGroup, this.graceMs);
    const killGroup = (): void => { void termination.terminate(); };
    const abort = killGroup;
    this.signal?.addEventListener("abort", abort, { once: true });
    if (this.signal?.aborted) abort();
    const stdoutLimit = resolveStdoutLimit();
    const text: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let costUsd = 0;
    let codexError: string | undefined;
    let eventDelivery = Promise.resolve();
    let eventDeliveryError: Error | undefined;
    const handleLine = (line: string): void => {
      const record = parseRecord(line);
      if (!record) return;
      const connectorEvents = codexConnectorEvents(record, this.model, prompt);
      if (connectorEvents.length > 0) {
        eventDelivery = eventDelivery.then(async () => {
          if (eventDeliveryError) return;
          for (const connectorEvent of connectorEvents) await this.emit(connectorEvent);
        }).catch((error: unknown) => {
          // Attach immediately, while the process is still alive: a callback
          // rejection must neither escape as unhandled nor leave an agent running.
          eventDeliveryError = error instanceof Error ? error : new Error(String(error));
          try { killGroup(); }
          catch (killError) { eventDeliveryError = new Error("Could not terminate Codex after an event callback failed", { cause: killError }); }
        });
      }
      if (record.type === "turn.failed" && isRecord(record.error)) codexError = String(record.error.message ?? "codex turn failed");
      if (record.type === "error" && codexError === undefined) {
        codexError = typeof record.message === "string" ? record.message : "codex error";
      }
      if (record.type === "item.completed" && isRecord(record.item) && record.item.type === "agent_message") {
        if (typeof record.item.text === "string" && record.item.text) text.push(record.item.text);
      }
      if ((record.type === "turn.completed" || record.type === "turn.failed") && isRecord(record.usage)) {
        inputTokens += finiteNonnegative(record.usage.input_tokens);
        outputTokens += finiteNonnegative(record.usage.output_tokens);
        cacheRead += finiteNonnegative(record.usage.cached_input_tokens);
        costUsd += finiteNonnegative(record.usage.total_cost_usd ?? record.usage.cost_usd);
      }
    };

    // Lines are parsed as they stream, so only one pending partial line is
    // ever held; a line past the limit fails the run loudly, like Python's
    // LimitOverrunError path.
    let pending = "";
    let pendingBytes = 0;
    let overrun = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const declareOverrun = (): void => {
      overrun = true;
      pending = "";
      pendingBytes = 0;
      // Overrun means the child is producing output we can no longer parse, so
      // the graceful window buys nothing and lets it keep flooding: SIGKILL the
      // group now. Teardown (including group reaping) is still awaited below.
      void termination.terminate("SIGKILL");
    };
    child.stdout.on("data", (chunk: string) => {
      if (overrun) return;
      pending += chunk;
      pendingBytes += Buffer.byteLength(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        // Enforced per UTF-8-byte line, terminated or not — Python's readline
        // raises LimitOverrunError for any line past the byte limit.
        const line = pending.slice(0, newline);
        const lineBytes = Buffer.byteLength(line);
        if (exceedsStreamLimit(line, stdoutLimit)) return declareOverrun();
        handleLine(line);
        pending = pending.slice(newline + 1);
        pendingBytes -= lineBytes + 1;
        newline = pending.indexOf("\n");
      }
      if (pendingBytes > stdoutLimit) declareOverrun();
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-stdoutLimit); });
    // A cancelled child may close stdin before it consumes the prompt.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt, "utf8");

    let spawnError: Error | undefined;
    const exitCode = await new Promise<number>((resolve) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const settle = (code: number): void => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        resolve(code);
      };
      child.once("close", (code) => settle(code ?? 1));
      child.once("error", (error) => {
        spawnError = error;
        // A process that never started emits `error` and no `close`, so waiting
        // on `close` alone would hang the run forever. A post-spawn `error`
        // (EPIPE on a killed child) is still followed by `close`, so give that
        // a short bound rather than settling immediately and losing the code.
        if (!settled) deadline = setTimeout(() => settle(1), SPAWN_ERROR_CLOSE_MS);
      });
    }).finally(() => this.signal?.removeEventListener("abort", abort));
    if (!overrun && pending) handleLine(pending);
    // Child exit is not the whole lifetime: callbacks may still be writing a
    // usage/event ledger. Drain them before every terminal outcome, including
    // abort and stream overrun, so cancellation acknowledges complete teardown.
    await eventDelivery;
    try {
    await termination.finish();
    this.signal?.throwIfAborted();
    if (overrun) throw stdoutOverrunError(stdoutLimit);
    if (spawnError) throw spawnError;
    if (eventDeliveryError) throw eventDeliveryError;

    if (codexError) throw new Error(codexError);
    // A nonzero exit is NOT on its own a failed run: codex exits nonzero on some
    // sandbox denials after it has already emitted a complete agent_message.
    // Only an exit that produced no agent text at all is an error.
    if (exitCode !== 0 && text.length === 0) throw new Error(stderr.trim() || `codex exited with code ${exitCode}`);
    } catch (error) {
      throw attachCodexUsage(error, inputTokens, outputTokens, cacheRead, costUsd, Date.now() - startedAt, this.model);
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      text: text.join(""),
      usage: { tokens: inputTokens + outputTokens, ms: durationMs },
      split: { input: inputTokens, output: outputTokens },
      telemetry: { durationMs, ...modelIdentity(this.model) },
    };
  }

  private async emit(event: ConnectorEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

const defaultSdkFactory: CodexSdkFactory = (options) => {
  const codex = new Codex(options);
  return { startThread: (threadOptions) => codex.startThread(threadOptions) };
};

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") result[key] = value;
  return result;
}

function reasoningEffort(value: string): ModelReasoningEffort {
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error(`unsupported Codex reasoning effort ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_DETAIL_CAP = 2_048;

function codexConnectorEvents(value: unknown, model: string, prompt: string): ConnectorEvent[] {
  if (!isRecord(value)) return [];
  if (value.type === "thread.started") {
    return [{ kind: "agent_started", metadata: { agent: "codex", model, prompt_chars: prompt.length } }];
  }
  if (value.type === "turn.completed" && isRecord(value.usage)) {
    return [{
      kind: "step_usage",
      metadata: {
        input_tokens: finiteNonnegative(value.usage.input_tokens),
        output_tokens: finiteNonnegative(value.usage.output_tokens),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: finiteNonnegative(value.usage.cached_input_tokens),
        cost_usd: 0,
        model,
      },
    }];
  }
  if (value.type !== "item.completed" || !isRecord(value.item)) return [];
  const item = value.item;
  if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
    return [{ kind: "agent_relay", metadata: { text: item.text, role: "assistant" } }];
  }
  if (item.type === "reasoning" && typeof item.text === "string" && item.text) {
    return [{ kind: "agent_relay", metadata: { text: item.text, role: "system" } }];
  }
  if (item.type === "command_execution") {
    const command = typeof item.command === "string"
      ? item.command
      : isRecord(item.input) && typeof item.input.command === "string" ? item.input.command : "";
    const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
    return [{
      kind: "tool_use_summary",
      metadata: {
        tool: "bash",
        summary: command.length <= 80 ? command : `${command.slice(0, 77)}...`,
        ok: exitCode === undefined || exitCode === 0,
        duration_ms: Math.trunc(finiteNonnegative(item.duration_ms)),
        input: { command: command.slice(0, TOOL_DETAIL_CAP) },
      },
    }];
  }
  if (item.type === "file_change") {
    const path = typeof item.path === "string"
      ? item.path
      : Array.isArray(item.changes) && isRecord(item.changes[0]) && typeof item.changes[0].path === "string"
        ? item.changes[0].path
        : "";
    return [{
      kind: "tool_use_summary",
      metadata: {
        tool: "edit",
        summary: `edit ${path}`.slice(0, 80),
        ok: true,
        duration_ms: 0,
        input: { file_path: path },
      },
    }];
  }
  return [];
}

function exceedsStreamLimit(value: string, limit: number): boolean {
  return Buffer.byteLength(value) > limit;
}

function stdoutOverrunError(limit: number): Error {
  return new Error(
    `codex stdout exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES (current limit ${limit} bytes). Raise the env knob and retry.`,
  );
}

export function codexModelWithEffort(model: string, effort?: string): string {
  const identity = modelIdentity(model);
  if (effort !== undefined && identity.effort !== undefined && effort !== identity.effort) {
    throw new Error("Codex effort conflicts with the effort suffix in model");
  }
  const selected = effort ?? identity.effort;
  if (selected !== undefined) reasoningEffort(selected);
  return selected === undefined ? identity.model : `${identity.model}/${selected}`;
}

/** Resolve only at execution time; the user's PATH binary takes precedence. */
export function bundledCodexCommand(env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } {
  try {
    const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
    const manifest = sdkRequire.resolve("@openai/codex/package.json");
    const cli = join(dirname(manifest), "bin", "codex.js");
    if (!existsSync(cli)) throw new Error("SDK CLI entrypoint is absent");
    return { command: process.execPath, prefix: [cli] };
  } catch (cause) {
    const command = pathCodex(env);
    if (command) return { command, prefix: [] };
    throw new Error("Codex CLI unavailable: no executable codex on PATH and the SDK bundled CLI could not be resolved", { cause });
  }
}

function pathCodex(env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
  }
  return undefined;
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env) {
  const command = pathCodex(env);
  return command ? { command, prefix: [] } : bundledCodexCommand(env);
}

function attachCodexUsage(error: unknown, input: number, output: number, cacheRead: number, usd: number, ms: number, model: string): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), {
    telemetry: { durationMs: ms, ...modelIdentity(model) },
    usage: { tokens: input + output, ms, ...(usd > 0 ? { usd } : {}) },
    split: { input, output, ...(cacheRead > 0 ? { cacheRead } : {}) },
    ...(usd > 0 ? { usdSource: "reported" } : {}),
  });
}
