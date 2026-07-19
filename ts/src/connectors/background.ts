import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { AgentType, CodexSandboxMode, ConnectorTelemetry, ConnectorUsage } from "./base.js";
import { finiteNonnegative, modelIdentity } from "./base.js";
import type { ClaudeConnectorOptions } from "./claude.js";
import { codexCommand, defaultCodexModel } from "./codex.js";
import { procStartTime, processGroupId, processIdentityMatches } from "./proc_identity.js";

// ── Claude background worker registry ────────────────────────────────────────
// Keyed by runId. Entry absent means "not running" (terminal). Deletion is the
// terminal signal (D10) — no isAlive field needed (saves unbounded memory growth).
interface ClaudeBgEntry {
  worker: Worker;
  // D9: set before worker.terminate() — suppresses exit/error-handler sentinel write.
  cancelling: boolean;
  // D13: per-run finalization lock. First synchronous caller (error fires before exit)
  // sets this promise; subsequent callers chain on the same promise with their
  // doFinalize discarded. Atomic at JS event-loop level (no await between null-check
  // and set). Registry deletion happens in .finally() after doFinalize settles.
  finalizationClaim: Promise<void> | null;
}
const claudeWorkerRegistry = new Map<string, ClaudeBgEntry>();

// Single serialization point for all terminal writes on a claude bg run.
// Only the first caller's doFinalize() executes; subsequent callers get the
// same promise. Registry deletion always happens via .finally().
function claimFinalization(
  entry: ClaudeBgEntry,
  runId: string,
  doFinalize: () => Promise<void>,
): Promise<void> {
  if (entry.finalizationClaim !== null) {
    return entry.finalizationClaim; // already claimed — another path owns the terminal record
  }
  entry.finalizationClaim = doFinalize()
    .catch(() => { /* best-effort — I/O failure must not block registry deletion */ })
    .finally(() => claudeWorkerRegistry.delete(runId));
  return entry.finalizationClaim;
}
// ─────────────────────────────────────────────────────────────────────────────

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

interface BackgroundRunMetaBase {
  runId: string;
  model: string;
  cwd: string;
  sandboxMode: CodexSandboxMode;
  promptChars: number;
  createdAt: string;
  streamPath: string;
  stderrPath: string;
}

export interface CodexRunMeta extends BackgroundRunMetaBase {
  agent: "codex";
  childPid: number;
  procStartTime?: string;
}

export interface ClaudeRunMeta extends BackgroundRunMetaBase {
  agent: "claude";
  allowedTools?: string[];
  disallowedTools?: string[];
}

export type BackgroundRunMeta = CodexRunMeta | ClaudeRunMeta;

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
  allowedTools?: string[];
  disallowedTools?: string[];
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
  status: "bg_started"; runId: string; pid?: number; streamPath: string;
}> {
  // D11: explicit runtime validation — TypeScript casts at the MCP boundary do not
  // protect callers that bypass the MCP surface.
  const VALID_AGENTS = new Set(["claude", "codex"]);
  const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
  if (!VALID_AGENTS.has(options.agent)) {
    throw new Error(`Unknown agent ${JSON.stringify(options.agent)}; must be "claude" or "codex"`);
  }
  if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
    throw new Error(
      `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only" or "workspace-write"`,
    );
  }
  if (options.budgeted) throw new Error("background agent runs cannot debit run budgets yet");

  if (options.agent === "claude") {
    return startClaudeBackgroundRun(options);
  }

  // Codex path (D6: workspace-write is now allowed — guard removed)
  const sandboxMode = options.sandboxMode ?? "read-only";
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
  const meta: CodexRunMeta = {
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

// WorkerInput is the data passed to claude-bg-worker via workerData.
interface WorkerInput {
  prompt: string;
  connectorOptions: ClaudeConnectorOptions;
  streamPath: string;
  // stderrPath: worker writes caught errors here (design.md:648 — "stream errors written to stderr,
  // never crash worker"). appendFileSync is used synchronously to avoid timing issues in the catch block.
  stderrPath: string;
}

async function startClaudeBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; streamPath: string;
}> {
  // D8: reject read-only for claude bg — claude.ts:43 hardcodes permissionMode:"acceptEdits"
  // with no SDK enforcement path for sandboxMode:"read-only". Explicit rejection prevents
  // a false read-only guarantee. Callers should omit sandboxMode or pass "workspace-write".
  if (options.sandboxMode === "read-only") {
    throw new Error(
      "claude background runs with sandboxMode='read-only' are not supported in v1. " +
      "Claude's permissionMode cannot be safely enforced via the SDK without a mapped " +
      "tool restriction list. Omit sandboxMode or pass 'workspace-write' explicitly.",
    );
  }
  const registryRoot = options.registryRoot ?? agentRunsRoot();
  const { runId, runDir } = await newRunDir(registryRoot);
  const streamPath = join(runDir, "stream.jsonl");
  const stderrPath = `${streamPath}.err`;
  const inputPath = `${streamPath}.in`;
  await Promise.all([
    writeFile(streamPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(stderrPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(inputPath, options.prompt, { encoding: "utf8", mode: 0o600 }),
  ]);
  const model = options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  // D4: default sandboxMode for claude bg = workspace-write (the primary use case)
  const sandboxMode = options.sandboxMode ?? "workspace-write";
  const workerInput: WorkerInput = {
    prompt: options.prompt,
    connectorOptions: {
      model,
      cwd: options.cwd,
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    },
    streamPath,
    stderrPath,
  };
  // Worker TypeScript loading: point to the .ts source file.
  // The hooks file (--import) registers synchronous resolve/load hooks that:
  //   - remap "./foo.js" imports → "./foo.ts" for sibling source files
  //   - read .ts files via readFileSync + stripTypeScriptTypes (bypasses default loader)
  // This enables the Worker to load TypeScript without a build step (test and production).
  const hooksPath = fileURLToPath(new URL("./claude-bg-worker-hooks.mjs", import.meta.url));
  const worker = new Worker(new URL("./claude-bg-worker.ts", import.meta.url), {
    workerData: workerInput,
    execArgv: ["--import", hooksPath],
  });
  const entry: ClaudeBgEntry = { worker, cancelling: false, finalizationClaim: null };
  claudeWorkerRegistry.set(runId, entry);

  // D9 + D13: exit handler — guarded by cancelling flag AND claimFinalization lock.
  // 'error' fires before 'exit' on worker exceptions, so the error handler atomically
  // claims the finalizationClaim first; the exit handler then sees it non-null and
  // discards its own doFinalize. This prevents duplicate sentinel writes.
  worker.once("exit", () => {
    if (entry.cancelling) return; // cancel path owns finalization
    void claimFinalization(entry, runId, () => writeSentinelIfAbsent(streamPath, 1));
  });

  // D9 + D13: error handler — absorbs uncaught worker exceptions. Without this listener
  // Node.js emits an unhandledRejection and crashes the MCP process. Fires before 'exit'
  // on worker exceptions so the null-check + set in claimFinalization is atomic — the
  // exit handler that follows will see finalizationClaim !== null and discard its work.
  worker.on("error", (err: Error) => {
    if (entry.cancelling) return; // cancel path owns finalization
    const errorLine = JSON.stringify({ type: "error", message: err.message.slice(0, 2000) }) + "\n";
    const sentinelLine = JSON.stringify({ [T2F5_DONE_SENTINEL]: 1 }) + "\n";
    // The WORKER writes its own rc=0 sentinel outside the parent's claim. A late
    // stream/close error after a successful commit must not flip completion to rc=1
    // (scanStream takes the LAST sentinel), so rescan inside the claim and defer to
    // any terminal record the worker already committed (D13 exactly-once invariant).
    void claimFinalization(entry, runId, async () => {
      const scan = await scanStream(streamPath);
      if (scan.exitCode !== undefined) return; // worker's terminal record is authoritative
      await appendFile(streamPath, errorLine + sentinelLine, { encoding: "utf8" });
    });
  });

  const meta: ClaudeRunMeta = {
    runId,
    agent: "claude",
    model,
    cwd: options.cwd,
    sandboxMode,
    promptChars: options.prompt.length,
    createdAt: new Date().toISOString(),
    streamPath,
    stderrPath,
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
  };
  try {
    await atomicWriteJson(join(runDir, "meta.json"), meta);
  } catch (error) {
    // Without meta.json the caller gets no runId handle — a still-running
    // workspace-write worker would be uncontrollable. Kill it before rethrowing.
    entry.cancelling = true; // suppress exit/error finalizers for this dead run
    await worker.terminate().catch(() => { /* already dead */ });
    claudeWorkerRegistry.delete(runId);
    throw error;
  }
  return { status: "bg_started", runId, streamPath };
}

export async function pollBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<BackgroundPollResult> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };
  const { streamPath, stderrPath } = loaded;
  const scan = await scanStream(streamPath);
  const text = capText(scan.text, streamPath);

  if (loaded.meta.agent === "claude") {
    // D10: liveness via in-memory registry (entry present = running; deleted = terminal).
    // Registry deletion always happens AFTER sentinel write so poll never misses a sentinel.
    if (scan.exitCode === undefined) {
      if (claudeWorkerRegistry.has(runId)) {
        return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
      }
      // Not in registry and no sentinel: worker died unexpectedly (MCP server restarted or
      // process was killed externally). Poll surfaces this as an error boundary.
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

  // Codex path — unchanged:
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

  if (loaded.meta.agent === "claude") {
    // Initial scan: if sentinel already present, run already terminal.
    const scan = await scanStream(loaded.streamPath);
    if (scan.exitCode !== undefined) {
      return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
    }
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return { status: "not_found", runId }; // server restart — no worker to kill

    // D9: claim before terminate so the exit handler's sentinel write is suppressed.
    entry.cancelling = true;
    // Death-confirmed: worker.terminate() returns a Promise that resolves when the thread
    // is truly dead — equivalent to SIGTERM + await for a process.
    await entry.worker.terminate();

    // D11: rescan after terminate. The worker can commit its own rc=0 sentinel BETWEEN
    // the initial scan above and the terminate() call (race: scan→worker writes→cancel
    // terminates). Setting cancelling=true suppresses the exit handler, but does not
    // undo a sentinel the worker already appended. Rescanning after death-confirmed
    // terminate is the authoritative check.
    const rescan = await scanStream(loaded.streamPath);
    if (rescan.exitCode !== undefined) {
      // Worker won the race. D13: route through claimFinalization() with a no-op doFinalize
      // so registry deletion happens via the shared lock, guarding a concurrent second cancel.
      void claimFinalization(entry, runId, () => Promise.resolve());
      return { status: rescan.exitCode === 0 && !rescan.error ? "already_complete" : "already_error", runId };
    }

    // D14: before claiming rc=130 finalization, check whether an error/exit handler already
    // claimed it before cancelling=true was set. Interleaving: worker throws → 'error' handler
    // fires with cancelling=false → claims finalizationClaim (appendFile in-flight) → cancel
    // starts → initial scan sees no sentinel (appendFile pending) → sets cancelling=true →
    // terminate (worker dead) → rescan (still no sentinel) → reaches here.
    // finalizationClaim is now non-null (error handler set it). Calling claimFinalization(rc=130)
    // would return the error handler's promise with OUR doFinalize discarded — we'd return
    // 'cancelled' while the committed sentinel is rc=1. Fix: if joined, await, rescan, return
    // the actual outcome. Return 'cancelled' ONLY when we own the rc=130 record.
    if (entry.finalizationClaim !== null) {
      // Joined a pre-existing claim — await its I/O, then report the actual terminal outcome.
      await entry.finalizationClaim;
      const finalScan = await scanStream(loaded.streamPath);
      if (finalScan.exitCode === 0 && !finalScan.error) {
        return { status: "already_complete", runId };
      }
      return { status: "already_error", runId };
    }
    // We own the terminal record. D13: claimFinalization() prevents a concurrent second cancel
    // from writing a second rc=130 sentinel (null-check + set is atomic at JS event-loop level).
    // D10: sentinel written inside doFinalize before .finally() deletes the registry entry.
    await claimFinalization(entry, runId, () => writeSentinelIfAbsent(loaded.streamPath, 130));
    return { status: "cancelled", runId };
  }

  // Codex path — unchanged:
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
    if (!isRecord(raw) || raw.runId !== runId || (raw.agent !== "codex" && raw.agent !== "claude")) return undefined;
    if (raw.agent === "codex" && typeof raw.childPid !== "number") return undefined;
    if (typeof raw.model !== "string") return undefined;
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

// Writes a sentinel to the stream only if none is present yet.
// Used by exit/error handlers. Cancel path calls this via claimFinalization().
async function writeSentinelIfAbsent(streamPath: string, exitCode: number): Promise<void> {
  const scan = await scanStream(streamPath);
  if (scan.exitCode !== undefined) return; // already has a sentinel
  const line = JSON.stringify({ [T2F5_DONE_SENTINEL]: exitCode }) + "\n";
  await appendFile(streamPath, line, { encoding: "utf8" });
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

// Export registry for testing (internal use only)
export { claudeWorkerRegistry };
