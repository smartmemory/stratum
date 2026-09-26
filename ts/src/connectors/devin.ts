import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { atomicWriteJson, newRunDir } from "./background.js";
import type { CodexSandboxMode, ConnectorEvent, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { finiteNonnegative, withSandboxPreamble } from "./base.js";
import { cancellationGraceMs, processTermination, requireProcessGroups } from "./cancellation.js";
import type { SpawnProcess } from "./codex.js";
import { applyHeadlessShellEnv, resolveStdoutLimit } from "./codex.js";
import { fullAccessAuthorization, isSandboxEscalated } from "../config/index.js";
import type { SandboxPolicy, SandboxPolicyAudit, SandboxPolicyKey } from "../config/types.js";
import { devinModelIdentity, DEVIN_SCRUB_VARS, assertDevinSandboxAllowed, resolveDevinModel } from "./devin-model.js";
import {
  devinHomePaths,
  devinHomeEnv,
  devinRunLayout,
  devinWrapperEnv,
  prepareDevinRunHome,
  sweepDevinCredentialCopies,
  DEVIN_WRAPPER_SCRIPT,
  type DevinHomePaths,
  type DevinRunLayout,
} from "./devin-wrapper.js";
import { assertDevinGrants, assertDevinPlatform, devinSeatbeltProfile } from "./devin-sandbox.js";
import { procStartTime } from "./proc_identity.js";
import { devinUsdFromTokens } from "../judge/pricing.js";

export interface DevinConnectorOptions {
  model?: string;
  effort?: string;
  signal?: AbortSignal;
  /** Opt in to POSIX process-group reporting (the MCP cancellation contract).
   *  The wrapper is ALWAYS spawned detached — devin is its child, so only a
   *  group kill reaches it; this flag only controls whether the leader pid is
   *  reported to the foreground registry via onSpawn (S02-1 parity). */
  ownProcessGroup?: boolean;
  cancellationGraceMs?: number;
  /** Group-leader pid of the cancellable wrapper, reported as it spawns.
   *  Invoked only when ownProcessGroup is true. Called synchronously. */
  onSpawn?: (pid: number) => void;
  cwd?: string;
  sandboxMode?: CodexSandboxMode;
  writableRoots?: readonly string[];
  /** Winning-layer evidence supplied by the central config resolver. */
  sandboxAudit?: SandboxPolicyAudit;
  env?: NodeJS.ProcessEnv;
  /** Process-boundary test seam (error harness, no network). */
  spawn?: SpawnProcess;
  /** Sweep oracle seam for tests. */
  identity?: (pid: number, startTime: string) => Promise<"alive" | "dead" | "unknown">;
  /** Wrapper identity capture seam for tests. */
  procStartTime?: typeof procStartTime;
  /** Platform seam for tests (the Linux refusal). */
  platform?: string;
  onEvent?: ConnectorEventHandler;
}

/** How long a post-spawn `error` may wait for the matching `close`. */
const SPAWN_ERROR_CLOSE_MS = 250;

/** D4's two rejection witnesses: the stderr warning and the ATIF observation. */
const STDERR_REJECTION = "rejected a tool call that requires confirmation";
const OBSERVATION_REJECTION = "Tool execution was rejected by the user";

/**
 * The foreground devin connector (STRAT-AGENT-DEVIN-1 S1b, D2/D3/D4). One
 * dispatch = one private run dir, one private devin home, one supervisor
 * wrapper. The result and usage come from the ATIF export, the exit status
 * from `exit.rc` — devin's raw stdout is narration, never a status channel.
 */
export class DevinConnector {
  private readonly model: string;
  private readonly signal: AbortSignal | undefined;
  private readonly cwd: string;
  private readonly sandboxMode: CodexSandboxMode;
  private readonly writableRoots: readonly string[];
  private readonly sandboxAudit: SandboxPolicyAudit | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ownProcessGroup: boolean;
  private readonly graceMs: number;
  private readonly spawn: SpawnProcess;
  private readonly identity: DevinConnectorOptions["identity"];
  private readonly platform: string;
  private readonly captureStartTime: typeof procStartTime;
  private readonly onEvent: ConnectorEventHandler | undefined;
  private readonly onSpawn: ((pid: number) => void) | undefined;
  private readonly paths: DevinHomePaths;

  constructor(options: DevinConnectorOptions = {}) {
    this.model = resolveDevinModel(options.model, options.effort);
    this.signal = options.signal;
    this.cwd = options.cwd ?? process.cwd();
    this.sandboxMode = options.sandboxMode ?? "read-only";
    this.writableRoots = Object.freeze([...(options.writableRoots ?? [])]);
    this.env = { ...(options.env ?? process.env) };
    assertDevinSandboxAllowed(this.sandboxMode, this.env);
    this.platform = options.platform ?? process.platform;
    assertDevinPlatform(this.sandboxMode, this.platform);
    for (const key of DEVIN_SCRUB_VARS) delete this.env[key];
    // A caller-supplied env is authoritative; the headless-shell default is
    // only layered onto the ambient process.env fallback.
    if (options.env === undefined) applyHeadlessShellEnv(this.env);
    const policy: SandboxPolicy = {
      filesystemMode: this.sandboxMode,
      // D3/D11: network and approval are enforced facts, not resolved options.
      networkAccess: true,
      writableRoots: this.writableRoots,
      approvalPolicy: "never",
    };
    this.sandboxAudit = options.sandboxAudit ?? (isSandboxEscalated(policy)
      ? directDevinSandboxAudit(policy, options)
      : undefined);
    this.ownProcessGroup = options.ownProcessGroup === true;
    this.graceMs = options.cancellationGraceMs ?? cancellationGraceMs(this.env);
    this.spawn = options.spawn ?? (nodeSpawn as SpawnProcess);
    this.identity = options.identity;
    this.captureStartTime = options.procStartTime ?? procStartTime;
    this.onEvent = options.onEvent;
    this.onSpawn = options.onSpawn;
    this.paths = devinHomePaths(this.env, homedir());
  }

  async run(prompt: string): Promise<ConnectorResult> {
    this.signal?.throwIfAborted();
    if (this.ownProcessGroup) requireProcessGroups();
    // Dispatch-time sweep over BOTH devin run roots, on EVERY dispatch (D2):
    // orphaned credentials copies are removed only on positive proof (exit.rc,
    // dead identity, or a meta-less dir past the orphan window). Best-effort —
    // the next dispatch retries whatever this pass could not settle.
    await sweepDevinCredentialCopies([this.paths.agentRunsRoot, this.paths.devinFgRoot],
      this.identity === undefined ? {} : { identity: this.identity }).catch(() => ({ deleted: 0, kept: 0 }));
    // Fail before any run-dir side effect when there is nothing to copy (D2).
    if (!existsSync(this.paths.credentialsSource)) {
      throw new Error("devin is not logged in (run `devin auth`)");
    }

    const sandboxed = this.sandboxMode !== "danger-full-access";
    const { runId, runDir } = await newRunDir(this.paths.devinFgRoot);
    const layout = devinRunLayout(runDir);
    try {
      return await this.runInLayout(prompt, runId, layout, sandboxed);
    } finally {
      // The foreground run dir is removed after the result is read (D2); a
      // crash leaves it for the sweep, like an agent_runs dir.
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runInLayout(prompt: string, runId: string, layout: DevinRunLayout, sandboxed: boolean): Promise<ConnectorResult> {
    await prepareDevinRunHome(layout, this.paths.mcpConfigSource);
    const framed = withSandboxPreamble(prompt, this.sandboxMode);
    // The grant check precedes the profile: workspace-write grants cwd plus
    // each writableRoots entry; read-only grants nothing beyond A (D3).
    const writable: readonly string[] = this.sandboxMode === "workspace-write"
      ? [this.cwd, ...this.writableRoots]
      : [];
    assertDevinGrants(writable, this.paths.stratumRoot, layout.agentDir);
    await writeFile(layout.promptPath, framed, { encoding: "utf8", mode: 0o600 });
    await writeFile(layout.streamPath, "", { encoding: "utf8", mode: 0o600 });
    if (sandboxed) {
      await writeFile(layout.profilePath, devinSeatbeltProfile(layout.agentDir, writable), { encoding: "utf8", mode: 0o600 });
    }
    await writeFile(layout.wrapperPath, DEVIN_WRAPPER_SCRIPT, { encoding: "utf8", mode: 0o700 });

    const devinArgv = [
      "devin",
      "--model", this.model,
      "--permission-mode", "dangerous",
      "--config", layout.devinConfigPath,
      "--respect-workspace-trust", "false",
      "--export", layout.exportPath,
      "--prompt-file", layout.promptPath,
      "-p",
    ];
    const argv = sandboxed ? ["sandbox-exec", "-f", layout.profilePath, ...devinArgv] : devinArgv;
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      ...devinHomeEnv(layout),
      ...devinWrapperEnv(layout, this.paths.credentialsSource),
    };

    const startedAt = Date.now();
    const stdoutLog = createWriteStream(layout.stdoutPath, { mode: 0o600 });
    const stderrLog = createWriteStream(layout.stderrPath, { mode: 0o600 });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(layout.wrapperPath, argv, {
        cwd: this.cwd,
        env,
        // The wrapper is always a group leader: devin is ITS child, so only a
        // group kill reaches it (the acp subprocess shares the group, D8).
        detached: this.platform !== "win32",
        // stdin is /dev/null inside the wrapper; stdout/stderr are piped so the
        // supervisor owns stdout.log/.err and the live overrun rule (D2).
        stdio: "pipe",
      });
    } catch (error) {
      stdoutLog.destroy();
      stderrLog.destroy();
      throw error;
    }

    // Attach the close/error watchers BEFORE any await: a wrapper that exits
    // instantly (and a synchronous test double) must never lose its terminal
    // event. The awaits below just consume closePromise.
    let spawnError: Error | undefined;
    let closeSignal: NodeJS.Signals | null = null;
    let settled = false;
    let closeDeadline: NodeJS.Timeout | undefined;
    let resolveClose!: (code: number | null) => void;
    const closePromise = new Promise<number | null>((resolve) => { resolveClose = resolve; });
    const settleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (closeDeadline) clearTimeout(closeDeadline);
      closeSignal = signal;
      resolveClose(code);
    };
    child.once("close", (code, signal) => settleClose(code, signal));
    child.once("error", (error) => {
      spawnError = error;
      if (!settled) closeDeadline = setTimeout(() => settleClose(1, null), SPAWN_ERROR_CLOSE_MS);
    });
    // Same early-listen rule for the teardown helper: its internal close watch
    // must observe even a wrapper that exits before the meta write returns.
    const termination = processTermination(child, true, this.graceMs);

    const abort = (): void => { void termination.terminate(); };
    try {
      const stdoutLimit = resolveStdoutLimit();
      let pending = "";
      let pendingBytes = 0;
      let overrun = false;
      let stderrTail = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const declareOverrun = (): void => {
        overrun = true;
        pending = "";
        pendingBytes = 0;
        // Overrun means the child is producing output we can no longer bound:
        // SIGKILL the group now (codex parity, r4 N3), teardown is awaited below.
        void termination.terminate("SIGKILL");
      };
      child.stdout.on("data", (chunk: string) => {
        if (overrun) return;
        pending += chunk;
        pendingBytes += Buffer.byteLength(chunk);
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          const lineBytes = Buffer.byteLength(line);
          if (lineBytes > stdoutLimit) return declareOverrun();
          stdoutLog.write(`${line}\n`);
          pending = pending.slice(newline + 1);
          pendingBytes -= lineBytes + 1;
          newline = pending.indexOf("\n");
        }
        if (pendingBytes > stdoutLimit) declareOverrun();
      });
      child.stderr.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-stdoutLimit);
        stderrLog.write(chunk);
      });

      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
      if (this.ownProcessGroup && child.pid !== undefined) this.onSpawn?.(child.pid);
      // The foreground meta carries the wrapper's pid and start time so the
      // dispatch-time sweep can positively identify a dead wrapper (r5 N5).
      const procStart = child.pid === undefined ? undefined : await this.captureStartTime(child.pid);
      if (child.pid === undefined) await closePromise;
      if (spawnError) throw spawnError;
      if (child.pid === undefined || procStart === undefined) {
        throw new Error(`devin wrapper identity could not be captured: ${stderrTail.trim() || "no process start time"}`);
      }
      await atomicWriteJson(layout.metaPath, {
        runId,
        agent: "devin",
        model: this.model,
        cwd: this.cwd,
        sandboxMode: this.sandboxMode,
        promptChars: framed.length,
        createdAt: new Date().toISOString(),
        childPid: child.pid,
        procStartTime: procStart,
        ...(this.sandboxAudit !== undefined ? { sandboxAudit: this.sandboxAudit } : {}),
        streamPath: layout.streamPath,
        stderrPath: layout.stderrPath,
      });
      await this.emit({
        kind: "agent_started",
        metadata: { agent: "devin", model: this.model, prompt_chars: framed.length },
      });

      const closeCode = await closePromise;
      if (!overrun && pending) stdoutLog.write(pending);
      // Register the finish watches BEFORE end(): a stream that finishes during
      // the other's drain would otherwise leave a once() waiting on an event it
      // already missed.
      const stdoutFlushed = new Promise<void>((resolve) => { stdoutLog.once("finish", resolve); stdoutLog.once("error", () => resolve()); });
      const stderrFlushed = new Promise<void>((resolve) => { stderrLog.once("finish", resolve); stderrLog.once("error", () => resolve()); });
      stdoutLog.end();
      stderrLog.end();
      await stdoutFlushed;
      await stderrFlushed;
      // A successful wrapper can leave ACP/Node descendants writing exit-time
      // caches. Reap its group before reading results or removing the run dir.
      await termination.finishGroup();
      this.signal?.throwIfAborted();
      if (overrun) {
        throw new Error(
          `devin stdout exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES (current limit ${stdoutLimit} bytes). Raise the env knob and retry.`,
        );
      }
      if (spawnError) throw spawnError;

      // exit.rc is the status channel; the close event is only the fallback for
      // a wrapper that died before writing it (an externally SIGKILLed wrapper
      // — the agent cannot signal it, D3).
      const rc = await this.exitRc(layout, closeCode, closeSignal);
      return await this.buildResult(layout, rc, stderrTail, Date.now() - startedAt);
    } catch (error) {
      await termination.terminate();
      await termination.finish();
      throw error;
    } finally {
      this.signal?.removeEventListener("abort", abort);
      stdoutLog.destroy();
      stderrLog.destroy();
    }
  }

  private async exitRc(layout: DevinRunLayout, closeCode: number | null, closeSignal: NodeJS.Signals | null): Promise<number> {
    try {
      const parsed = Number.parseInt((await readFile(layout.exitRcPath, "utf8")).trim(), 10);
      if (Number.isFinite(parsed)) return parsed;
    } catch { /* wrapper died before writing it — fall through */ }
    if (closeCode !== null) return closeCode;
    if (closeSignal !== null) return 128 + signalNumber(closeSignal);
    return 1;
  }

  private async buildResult(layout: DevinRunLayout, rc: number, stderrTail: string, durationMs: number): Promise<ConnectorResult> {
    const trajectory = await readTrajectory(layout.exportPath);
    // D4: a rejected tool call is a failure, never a success — exit 0 is not
    // trusted when either witness says a call was rejected (fact 2/3).
    const rejection = rejectionReason(trajectory, stderrTail);
    if (rejection !== undefined) throw new Error(`devin rejected a tool call: ${rejection}`);
    const transient = coldCacheModelError(stderrTail);
    if (transient !== undefined) throw new Error(transient);
    if (trajectory?.finalText === undefined) {
      throw new Error(`devin produced no trajectory: ${stderrTail.trim() || "(empty stderr)"}`);
    }
    if (rc !== 0) {
      throw new Error(`devin exited with code ${rc}: ${stderrTail.trim() || "(empty stderr)"}`);
    }
    const metrics = trajectory.metrics ?? { prompt: 0, completion: 0, cached: 0 };
    const usd = devinUsdFromTokens(this.model, {
      inputTokens: metrics.prompt,
      cachedInputTokens: metrics.cached,
      outputTokens: metrics.completion,
    });
    await this.emit({ kind: "agent_relay", metadata: { text: trajectory.finalText, role: "assistant" } });
    await this.emit({
      kind: "step_usage",
      metadata: {
        input_tokens: metrics.prompt,
        output_tokens: metrics.completion,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: metrics.cached,
        cost_usd: usd,
        usd_source: "estimated",
        model: this.model,
      },
    });
    return {
      text: trajectory.finalText,
      usage: { tokens: metrics.prompt + metrics.completion, ms: durationMs, usd },
      split: { input: metrics.prompt, output: metrics.completion, ...(metrics.cached > 0 ? { cacheRead: metrics.cached } : {}) },
      usdSource: "estimated",
      telemetry: { durationMs, ...devinModelIdentity(this.model) },
      ...(this.sandboxAudit !== undefined ? { sandboxAudit: this.sandboxAudit } : {}),
    };
  }

  private async emit(event: ConnectorEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

interface DevinTrajectory {
  /** `message` of the last `source:"agent"` step — the run's final answer. */
  finalText?: string;
  /** Command head of a rejected tool call, if the export records one (D4). */
  rejectedCommand?: string;
  metrics?: { prompt: number; completion: number; cached: number };
}

/**
 * The ATIF-v1.7 export is the result channel (fact 6): final answer = the
 * `message` of the last `source:"agent"` step; usage = `final_metrics`. An
 * unparseable or agent-less export yields `finalText: undefined` and the
 * caller fails the run — never an empty success.
 */
async function readTrajectory(exportPath: string): Promise<DevinTrajectory | undefined> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(exportPath, "utf8")); }
  catch { return undefined; }
  if (!isRecord(raw) || !Array.isArray(raw.steps)) return undefined;
  const trajectory: DevinTrajectory = {};
  // Fact 6: the final answer is the message of the LAST source:"agent" step —
  // a trailing tool-call step with an empty message means the run ended
  // mid-action and yields no text, not the previous step's.
  let lastAgentMessage: string | undefined;
  for (const step of raw.steps) {
    if (!isRecord(step) || step.source !== "agent") continue;
    lastAgentMessage = typeof step.message === "string" ? step.message : undefined;
    if (trajectory.rejectedCommand === undefined) {
      const rejected = rejectedObservation(step);
      if (rejected !== undefined) trajectory.rejectedCommand = rejected;
    }
  }
  if (lastAgentMessage !== undefined && lastAgentMessage.length > 0) trajectory.finalText = lastAgentMessage;
  if (isRecord(raw.final_metrics)) {
    trajectory.metrics = {
      prompt: finiteNonnegative(raw.final_metrics.total_prompt_tokens),
      completion: finiteNonnegative(raw.final_metrics.total_completion_tokens),
      cached: finiteNonnegative(raw.final_metrics.total_cached_tokens),
    };
  }
  return trajectory;
}

/**
 * Match the rejection on the observation OF THE CALL (D4): a result whose
 * content is exactly the rejection notice, never arbitrary file content that
 * happens to contain the word "rejected". Returns the rejected call's
 * command head for the error message.
 */
function rejectedObservation(step: Record<string, unknown>): string | undefined {
  if (!isRecord(step.observation) || !Array.isArray(step.observation.results)) return undefined;
  const calls = new Map<string, Record<string, unknown>>();
  if (Array.isArray(step.tool_calls)) {
    for (const call of step.tool_calls) {
      if (isRecord(call) && typeof call.tool_call_id === "string") calls.set(call.tool_call_id, call);
    }
  }
  for (const result of step.observation.results) {
    if (!isRecord(result) || typeof result.content !== "string") continue;
    if (result.content.trim() !== OBSERVATION_REJECTION) continue;
    const call = typeof result.source_call_id === "string" ? calls.get(result.source_call_id) : undefined;
    return commandHead(call?.arguments) ?? OBSERVATION_REJECTION;
  }
  return undefined;
}

function commandHead(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const command = typeof args.command === "string" ? args.command : JSON.stringify(args);
  return command.slice(0, 120);
}

/** Both D4 witnesses: the ATIF observation or the stderr warning line. */
function rejectionReason(trajectory: DevinTrajectory | undefined, stderrTail: string): string | undefined {
  if (trajectory?.rejectedCommand !== undefined) return trajectory.rejectedCommand;
  if (stderrTail.includes(STDERR_REJECTION)) {
    // No command is recoverable without the export — report the warning line.
    const line = stderrTail.split(/\r?\n/).find((l) => l.includes(STDERR_REJECTION)) ?? STDERR_REJECTION;
    return line.trim().slice(0, 120);
  }
  return undefined;
}

/**
 * A per-run home fetches devin's model list cold; a devin-service degradation
 * returns `Unknown model: '<id>'` with an EMPTY `Available:` list — a named,
 * transient failure (D3 fact), not a model-validation error.
 */
function coldCacheModelError(stderrTail: string): string | undefined {
  if (!stderrTail.includes("Unknown model:")) return undefined;
  const marker = stderrTail.lastIndexOf("Available:");
  if (marker < 0) return undefined;
  if (stderrTail.slice(marker + "Available:".length).trim() !== "") return undefined;
  return "devin fetched an empty model list (transient devin-service degradation); retry the run";
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSTOP: 17,
};

function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? 1;
}

function directDevinSandboxAudit(policy: SandboxPolicy, options: DevinConnectorOptions): SandboxPolicyAudit {
  const provenance = Object.fromEntries(([
    "filesystemMode", "networkAccess", "writableRoots", "approvalPolicy",
  ] as const satisfies readonly SandboxPolicyKey[]).map((key) => {
    if (key === "networkAccess" || key === "approvalPolicy") {
      return [key, Object.freeze({
        layer: "enforced" as const,
        source: key === "networkAccess"
          ? "devin: model traffic runs inside the sandbox, so network cannot be denied"
          : "devin: --permission-mode dangerous never asks for approval",
      })];
    }
    const explicit = key === "filesystemMode" ? options.sandboxMode !== undefined : options[key] !== undefined;
    return [key, Object.freeze({
      layer: explicit ? "dispatch" as const : "default" as const,
      source: explicit ? "DevinConnector options" : "built-in defaults",
    })];
  })) as unknown as SandboxPolicyAudit["provenance"];
  const authorization = policy.filesystemMode === "danger-full-access"
    ? fullAccessAuthorization(options.env ?? process.env, "devin")
    : undefined;
  return Object.freeze({
    policy: Object.freeze({ ...policy, writableRoots: Object.freeze([...policy.writableRoots]) }),
    provenance: Object.freeze(provenance),
    ...(authorization !== undefined ? { fullAccessAuthorization: authorization } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
