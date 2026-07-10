import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentType, CodexSandboxMode, ConnectorTelemetry, ConnectorUsage } from "./base.js";
import { finiteNonnegative, modelIdentity } from "./base.js";
import { codexCommand, defaultCodexModel } from "./codex.js";
import { procStartTime, processGroupId, processIdentityMatches } from "./proc_identity.js";

export const T2F5_DONE_SENTINEL = "__t2f5_done__";
export const T2F5_SHELL_WRAPPER =
  '"$@" > "$T2F5_OUT" 2> "$T2F5_ERR" < "$T2F5_IN"; rc=$?; ' +
  'printf \'{"__t2f5_done__":%d}\\n\' "$rc" >> "$T2F5_OUT"; ' +
  'exit "$rc"';
const RUN_ID = /^[0-9a-f]{12}$/;
const TEXT_CAP = 20_000;
// Bounds a single unterminated JSONL line so a runaway writer cannot grow the
// poller's memory without limit; oversized lines are dropped like malformed ones.
const MAX_LINE_BYTES = 5_000_000;

export interface BackgroundRunMeta {
  runId: string;
  agent: "codex";
  model: string;
  cwd: string;
  sandboxMode: CodexSandboxMode;
  promptChars: number;
  createdAt: string;
  childPid: number;
  procStartTime?: string;
  streamPath: string;
  stderrPath: string;
}

export interface StartBackgroundRunOptions {
  agent: AgentType;
  prompt: string;
  cwd: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  budgeted?: boolean;
  registryRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Final-agent-argv process-boundary seam used by the ported Python scenarios. */
  command?: string[];
}

export interface RegistryOptions { registryRoot?: string }

export type BackgroundPollResult =
  | { status: "not_found"; runId: string }
  | { status: "running"; runId: string; textTail: string; eventsSeen: number; streamPath: string }
  | { status: "complete"; runId: string; text: string; usage: ConnectorUsage; exitCode: 0; telemetry: ConnectorTelemetry }
  | { status: "error"; runId: string; reason?: string; exitCode?: number; textTail: string; stderrTail: string; eventsSeen?: number; streamPath?: string; telemetry?: ConnectorTelemetry };

export function agentRunsRoot(): string {
  return join(homedir(), ".stratum", "ts", "agent_runs");
}

export async function startBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; pid: number; streamPath: string;
}> {
  if (options.agent !== "codex") throw new Error("background agent runs are codex-only in v1");
  if (options.budgeted) throw new Error("background agent runs cannot debit run budgets yet");
  const sandboxMode = options.sandboxMode ?? "read-only";
  if (sandboxMode !== "read-only") throw new Error("workspace-write durable background runs are not supported in v1");
  const registryRoot = options.registryRoot ?? agentRunsRoot();
  const { runId, runDir } = await newRunDir(registryRoot);
  const streamPath = join(runDir, "stream.jsonl");
  const stderrPath = `${streamPath}.err`;
  const inputPath = `${streamPath}.in`;
  // Prompts and agent output are private to the invoking user (0600/0700).
  await Promise.all([
    writeFile(streamPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(stderrPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(inputPath, options.prompt, { encoding: "utf8", mode: 0o600 }),
  ]);
  const model = options.model ?? defaultCodexModel();
  const command = options.command ?? codexCommand(model, options.cwd, sandboxMode);
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    T2F5_OUT: streamPath,
    T2F5_ERR: stderrPath,
    T2F5_IN: inputPath,
  };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_API_KEY;
  delete env.CLAUDECODE;
  // Stamped before spawn: durationMs is measured from here to the sentinel
  // write, so identity-lookup latency never deflates it.
  const createdAt = new Date().toISOString();
  const child = spawn("sh", ["-c", T2F5_SHELL_WRAPPER, "sh", ...command], {
    cwd: options.cwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("durable wrapper did not expose a pid");
  child.unref();
  const startTime = await procStartTime(pid);
  const meta: BackgroundRunMeta = {
    runId,
    agent: "codex",
    model,
    cwd: options.cwd,
    sandboxMode,
    promptChars: options.prompt.length,
    createdAt,
    childPid: pid,
    ...(startTime ? { procStartTime: startTime } : {}),
    streamPath,
    stderrPath,
  };
  await atomicWriteJson(join(runDir, "meta.json"), meta);
  return { status: "bg_started", runId, pid, streamPath };
}

export async function pollBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<BackgroundPollResult> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };
  const { streamPath, stderrPath } = loaded;
  const scan = await scanStream(streamPath);
  const text = capText(scan.text, streamPath);
  if (scan.exitCode === undefined) {
    if (await processIdentityMatches(loaded.meta.childPid, loaded.meta.procStartTime)) {
      return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
    }
    return {
      status: "error", runId, reason: "child_died_without_sentinel", textTail: text,
      stderrTail: await tailText(stderrPath), eventsSeen: scan.eventsSeen, streamPath,
    };
  }
  const telemetry = await terminalTelemetry(loaded.meta, streamPath);
  if (scan.exitCode === 0 && scan.error === undefined) {
    return { status: "complete", runId, text, usage: scan.usage, exitCode: 0, telemetry };
  }
  return {
    status: "error", runId, exitCode: scan.exitCode, textTail: text,
    stderrTail: await tailText(stderrPath), ...(scan.error ? { reason: scan.error } : {}), telemetry,
  };
}

export async function cancelBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<Record<string, unknown>> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };
  const scan = await scanStream(loaded.streamPath);
  if (scan.exitCode !== undefined) return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
  const { childPid: pid, procStartTime: expected } = loaded.meta;
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  if (await processGroupId(pid) !== pid) return { status: "already_error", runId };
  // Verify the start-time identity a second time immediately before the only signal.
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  try { process.kill(-pid, "SIGTERM"); } catch { return { status: "already_error", runId }; }
  return { status: "cancelled", runId };
}

async function newRunDir(root: string): Promise<{ runId: string; runDir: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  while (true) {
    const runId = randomBytes(6).toString("hex");
    const runDir = join(root, runId);
    try { await mkdir(runDir, { mode: 0o700 }); return { runId, runDir }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function loadMeta(runId: string, root: string): Promise<{ meta: BackgroundRunMeta; streamPath: string; stderrPath: string } | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  try {
    const runDir = join(root, runId);
    const raw: unknown = JSON.parse(await readFile(join(runDir, "meta.json"), "utf8"));
    if (!isRecord(raw) || raw.runId !== runId || raw.agent !== "codex") return undefined;
    if (typeof raw.childPid !== "number" || typeof raw.model !== "string") return undefined;
    // Read paths are derived from the validated run directory, never from the
    // serialized record — a substituted meta.json cannot redirect poll reads.
    const streamPath = join(runDir, "stream.jsonl");
    return { meta: raw as unknown as BackgroundRunMeta, streamPath, stderrPath: `${streamPath}.err` };
  } catch {
    return undefined;
  }
}

async function scanStream(path: string): Promise<{
  text: string; usage: ConnectorUsage; exitCode?: number; error?: string; eventsSeen: number;
}> {
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let exitCode: number | undefined;
  let error: string | undefined;
  let eventsSeen = 0;
  for await (const record of completeJsonLines(path)) {
    eventsSeen += 1;
    if (Object.hasOwn(record, T2F5_DONE_SENTINEL)) {
      const value = Number(record[T2F5_DONE_SENTINEL]);
      exitCode = Number.isFinite(value) ? Math.trunc(value) : 1;
      continue;
    }
    if (record.type === "error" && error === undefined) error = typeof record.message === "string" ? record.message : "codex error";
    if (record.type === "item.completed" && isRecord(record.item) && record.item.type === "agent_message" && typeof record.item.text === "string") {
      text = (text + record.item.text).slice(-2 * TEXT_CAP);
    }
    if (record.type === "turn.completed" && isRecord(record.usage)) {
      inputTokens += finiteNonnegative(record.usage.input_tokens);
      outputTokens += finiteNonnegative(record.usage.output_tokens);
    }
  }
  return { text, usage: { tokens: inputTokens + outputTokens }, ...(exitCode !== undefined ? { exitCode } : {}), ...(error ? { error } : {}), eventsSeen };
}

async function* completeJsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  let stream;
  try { stream = createReadStream(path); } catch { return; }
  let buffer = Buffer.alloc(0);
  let discardingOversizedLine = false;
  try {
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline = buffer.indexOf(10);
      while (newline >= 0) {
        const line = discardingOversizedLine ? "" : buffer.subarray(0, newline).toString("utf8").trim();
        discardingOversizedLine = false;
        buffer = buffer.subarray(newline + 1);
        if (line) {
          try {
            const value: unknown = JSON.parse(line);
            if (isRecord(value)) yield value;
          } catch { /* malformed complete lines are ignored like the Python reader */ }
        }
        newline = buffer.indexOf(10);
      }
      if (buffer.length > MAX_LINE_BYTES) {
        // Drop the oversized pending line (treated as malformed) so a writer
        // that never emits a newline cannot grow this buffer unboundedly.
        discardingOversizedLine = true;
        buffer = Buffer.alloc(0);
      }
    }
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
  }
  // A trailing partial line belongs to a live writer and is intentionally ignored.
}

function capText(text: string, streamPath: string, cap = TEXT_CAP): string {
  if (text.length <= cap) return text;
  const prefix = `[truncated, full stream at ${streamPath}]\n`;
  const keep = Math.max(0, cap - prefix.length);
  return keep === 0 ? prefix.slice(0, cap) : prefix + text.slice(-keep);
}

async function tailText(path: string): Promise<string> {
  // Bounded read: only the final window of the file is ever brought into
  // memory, so an arbitrarily large stderr file cannot exhaust the poller.
  const window = 2 * TEXT_CAP;
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const size = (await handle.stat()).size;
    const position = Math.max(0, size - window);
    const length = size - position;
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return capText(buffer.toString("utf8").trim(), path);
  } catch {
    return "";
  } finally {
    await handle.close();
  }
}

async function terminalTelemetry(meta: BackgroundRunMeta, streamPath: string): Promise<ConnectorTelemetry> {
  // The sentinel line is the stream's last write, so its mtime marks the end
  // of the run; createdAt marks the start. Both fall back to 0 if unreadable.
  let durationMs = 0;
  try {
    const endedAt = (await stat(streamPath)).mtimeMs;
    const startedAt = Date.parse(meta.createdAt);
    if (Number.isFinite(startedAt)) durationMs = Math.max(0, Math.round(endedAt - startedAt));
  } catch { /* stream vanished between scan and stat — keep durationMs 0 */ }
  return { durationMs, ...modelIdentity(meta.model) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
