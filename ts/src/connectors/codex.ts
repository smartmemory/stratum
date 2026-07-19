import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadEvent, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import type { CodexSandboxMode, ConnectorEvent, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { finiteNonnegative, modelIdentity } from "./base.js";

export type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type CodexTransport = "sdk" | "exec";

export interface CodexSdkThread {
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexSdkClient {
  startThread(options: ThreadOptions): CodexSdkThread;
}

export type CodexSdkFactory = (options: CodexOptions) => CodexSdkClient;

export interface CodexConnectorOptions {
  model?: string;
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

const CODEX_SCRUB_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"] as const;

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
  private readonly cwd: string;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly env: NodeJS.ProcessEnv;
  private readonly transport: CodexTransport;
  private readonly sdkFactory: CodexSdkFactory;
  private readonly spawn: SpawnProcess;
  private readonly onEvent: ConnectorEventHandler | undefined;

  constructor(options: CodexConnectorOptions = {}) {
    this.model = options.model ?? defaultCodexModel();
    this.cwd = options.cwd ?? process.cwd();
    this.sandboxMode = options.sandboxMode ?? "read-only";
    this.env = { ...(options.env ?? process.env) };
    for (const key of CODEX_SCRUB_VARS) delete this.env[key];
    // Passing an injected spawn is itself an explicit request for the legacy
    // process seam. Production selects exec with STRATUM_CODEX_TRANSPORT=exec.
    this.transport = options.transport ?? (options.spawn ? "exec" : resolveCodexTransport(this.env));
    this.sdkFactory = options.sdkFactory ?? defaultSdkFactory;
    this.spawn = options.spawn ?? (nodeSpawn as SpawnProcess);
    this.onEvent = options.onEvent;
  }

  async run(prompt: string): Promise<ConnectorResult> {
    return this.transport === "sdk" ? this.runSdk(prompt) : this.runExec(prompt);
  }

  private async runSdk(prompt: string): Promise<ConnectorResult> {
    const startedAt = Date.now();
    const stdoutLimit = resolveStdoutLimit();
    const controller = new AbortController();
    const identity = modelIdentity(this.model);
    const options: ThreadOptions = {
      approvalPolicy: "never",
      model: identity.model,
      sandboxMode: this.sandboxMode,
      skipGitRepoCheck: true,
      workingDirectory: this.cwd,
      ...(identity.effort !== undefined ? { modelReasoningEffort: reasoningEffort(identity.effort) } : {}),
    };
    const client = this.sdkFactory({ env: stringEnvironment(this.env) });
    const streamed = await client.startThread(options).runStreamed(prompt, { signal: controller.signal });
    const text: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
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
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "item.completed" && event.item.type === "agent_message" && event.item.text) {
        text.push(event.item.text);
      }
      if (event.type === "turn.completed") {
        inputTokens += finiteNonnegative(event.usage.input_tokens);
        outputTokens += finiteNonnegative(event.usage.output_tokens);
      }
    }
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      text: text.join(""),
      usage: { tokens: inputTokens + outputTokens, ms: durationMs },
      telemetry: { durationMs, ...identity },
    };
  }

  private async runExec(prompt: string): Promise<ConnectorResult> {
    const startedAt = Date.now();
    const child = this.spawn("codex", codexExecArgs(this.model, this.cwd, this.sandboxMode), {
      cwd: this.cwd,
      env: this.env,
    });
    const stdoutLimit = resolveStdoutLimit();
    const text: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let codexError: string | undefined;
    let eventDelivery = Promise.resolve();
    const handleLine = (line: string): void => {
      const record = parseRecord(line);
      if (!record) return;
      const connectorEvents = codexConnectorEvents(record, this.model, prompt);
      if (connectorEvents.length > 0) {
        eventDelivery = eventDelivery.then(async () => {
          for (const connectorEvent of connectorEvents) await this.emit(connectorEvent);
        });
      }
      if (record.type === "error" && codexError === undefined) {
        codexError = typeof record.message === "string" ? record.message : "codex error";
      }
      if (record.type === "item.completed" && isRecord(record.item) && record.item.type === "agent_message") {
        if (typeof record.item.text === "string" && record.item.text) text.push(record.item.text);
      }
      if (record.type === "turn.completed" && isRecord(record.usage)) {
        inputTokens += finiteNonnegative(record.usage.input_tokens);
        outputTokens += finiteNonnegative(record.usage.output_tokens);
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
      child.kill("SIGKILL");
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
    child.stdin.end(prompt, "utf8");

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    if (overrun) {
      throw stdoutOverrunError(stdoutLimit);
    }
    if (pending) handleLine(pending);
    await eventDelivery;

    if (codexError) throw new Error(codexError);
    if (exitCode !== 0 && text.length === 0) throw new Error(stderr.trim() || `codex exited with code ${exitCode}`);
    const durationMs = Math.max(0, Date.now() - startedAt);
    return {
      text: text.join(""),
      usage: { tokens: inputTokens + outputTokens, ms: durationMs },
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
