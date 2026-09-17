import { spawn } from "node:child_process";
import { query as sdkQuery, type SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorEvent, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { finiteNonnegative, SMARTMEMORY_SCRUB_VARS } from "./base.js";

import { linkAbort, processTermination, requireProcessGroups } from "./cancellation.js";

interface QueryParams {
  prompt: string;
  options?: Record<string, unknown>;
}

/** Deliberately structural: agent-sdk and its zod@4 peer types stop at this boundary. */
export type QueryFunction = (params: QueryParams) => AsyncIterable<unknown>;

export interface ClaudeConnectorOptions {
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  thinking?: Record<string, unknown>;
  effort?: string;
  signal?: AbortSignal;
  /** Opt in to POSIX process-group ownership. Set ONLY by the cancellation
   * contract (an MCP `cancellationId`). `signal` alone must not imply it: MCP
   * always supplies a request-scoped `extra.signal`, so gating on the signal
   * made every MCP Claude dispatch demand process groups — and fail before
   * spawn on Windows. */
  ownProcessGroup?: boolean;
  cancellationGraceMs?: number;
  /** Group-leader pid of each cancellable child, reported as it spawns. Invoked only when
   *  ownProcessGroup is true — without a process group there is nothing a cross-process
   *  cancel could signal. Called synchronously; never awaited, so the connector never blocks
   *  the spawn path on registry I/O (S02-1). */
  onSpawn?: (pid: number) => void;
  env?: NodeJS.ProcessEnv;
  /** SDK-boundary test seam. */
  query?: QueryFunction;
  onEvent?: ConnectorEventHandler;
}

const defaultQuery: QueryFunction = (params) => sdkQuery(params as Parameters<typeof sdkQuery>[0]);
const SENSITIVE_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE", ...SMARTMEMORY_SCRUB_VARS] as const;

export class ClaudeConnector {
  private readonly options: ClaudeConnectorOptions;
  private readonly query: QueryFunction;
  private readonly onEvent: ConnectorEventHandler | undefined;

  constructor(options: ClaudeConnectorOptions = {}) {
    this.options = options;
    this.query = options.query ?? defaultQuery;
    this.onEvent = options.onEvent;
  }

  async run(prompt: string): Promise<ConnectorResult> {
    this.options.signal?.throwIfAborted();
    const controller = new AbortController();
    const unlink = linkAbort(this.options.signal, controller);
    const ownProcessGroup = this.options.ownProcessGroup === true;
    if (ownProcessGroup) requireProcessGroups();
    const children: Array<ReturnType<typeof processTermination>> = [];
    let stderr = "";
    const requestedModel = this.options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
    let resolvedModel = requestedModel;
    let durationMs = 0;
    let inputTokens = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    let outputTokens = 0;
    let costUsd = 0;
    const terminate = (): void => {
      for (const child of children) void child.terminate();
    };
    controller.signal.addEventListener("abort", terminate, { once: true });
    try {
      const env = { ...(this.options.env ?? process.env) };
      for (const key of SENSITIVE_ENV_VARS) delete env[key];
      const sdkOptions: Record<string, unknown> = {
        cwd: this.options.cwd ?? process.cwd(),
        model: requestedModel,
        permissionMode: "acceptEdits",
        env,
        abortController: controller,
        // Own the SDK process group so cancellation also stops shell/tool children.
        ...(ownProcessGroup ? { spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => {
          controller.signal.throwIfAborted();
          const child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (child.pid !== undefined) this.options.onSpawn?.(child.pid);
          const termination = processTermination(child, true, this.options.cancellationGraceMs);
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
          const sdkAbort = (): void => { void termination.terminate(); };
          options.signal.addEventListener("abort", sdkAbort, { once: true });
          void termination.close.then(() => options.signal.removeEventListener("abort", sdkAbort));
          children.push(termination);
          if (options.signal.aborted) sdkAbort();
          // The SDK receives a process handle whose kill requests enter the same
          // graceful teardown path; the actual ChildProcess.kill is never replaced.
          // The requested signal is the one sent first — the grace path still owns
          // escalation to SIGKILL, so a caller's SIGINT/SIGKILL is not downgraded.
          // stderr is not part of the SDK's SpawnedProcess contract but costs
          // nothing to surface and is what the connector itself reads.
          return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
            get killed() { return child.killed; },
            get exitCode() { return child.exitCode; }, pid: child.pid,
            kill: (signal?: NodeJS.Signals) => { void termination.terminate(signal); return true; },
            on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
        } } : {}),
      };
      if (this.options.allowedTools !== undefined) {
        // MCP schema deferral requires ToolSearch; without it every schema is inlined on the
        // post-connect turn (2026-09-16: compose/docs/features/COMP-MODEL-ROUTE-1/evidence/).
        const toolSearchDisallowed = this.options.disallowedTools?.includes("ToolSearch") === true;
        sdkOptions.tools = toolSearchDisallowed
          ? this.options.allowedTools.filter(tool => tool !== "ToolSearch")
          : this.options.allowedTools.includes("ToolSearch")
            ? this.options.allowedTools
            : [...this.options.allowedTools, "ToolSearch"];
        if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
      } else {
        sdkOptions.tools = { type: "preset", preset: "claude_code" };
        if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
      }
      if (this.options.effort !== undefined) sdkOptions.effort = this.options.effort;
      if (this.options.thinking !== undefined) sdkOptions.thinking = this.options.thinking;

      let finalText: string | undefined;
      let assistantText = "";
      await this.emit({
        kind: "agent_started",
        metadata: { agent: "claude", model: requestedModel, prompt_chars: prompt.length },
      });
      for await (const raw of this.query({ prompt, options: sdkOptions })) {
        if (!isRecord(raw)) continue;
        if (raw.type === "system" && raw.subtype === "init" && typeof raw.model === "string") resolvedModel = raw.model;
        if (raw.type === "assistant" && isRecord(raw.message) && Array.isArray(raw.message.content)) {
          for (const block of raw.message.content) {
            if (!isRecord(block)) continue;
            if (block.type === "text" && typeof block.text === "string" && block.text) {
              assistantText += block.text;
              await this.emit({ kind: "agent_relay", metadata: { text: block.text, role: "assistant" } });
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const input = "input" in block ? block.input : {};
              await this.emit({
                kind: "tool_use_summary",
                metadata: {
                  tool: block.name,
                  summary: shortInputSummary(input),
                  ok: true,
                  duration_ms: 0,
                  input: cappedToolInput(input),
                  ...(typeof block.id === "string" ? { tool_use_id: block.id } : {}),
                },
              });
            }
          }
        }
        if (raw.type === "user" && isRecord(raw.message) && Array.isArray(raw.message.content)) {
          for (const block of raw.message.content) {
            if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
            await this.emit({
              kind: "tool_result",
              metadata: {
                tool_use_id: block.tool_use_id,
                ok: block.is_error !== true,
                output: capText(toolResultText(block.content)),
              },
            });
          }
        }
        if (raw.type !== "result") continue;
        durationMs = finiteNonnegative(raw.duration_ms);
        if (typeof raw.result === "string") finalText = raw.result;
        costUsd = finiteNonnegative(raw.total_cost_usd);
        if (isRecord(raw.usage)) {
          inputTokens = finiteNonnegative(raw.usage.input_tokens);
          outputTokens = finiteNonnegative(raw.usage.output_tokens);
          cacheRead = finiteNonnegative(raw.usage.cache_read_input_tokens);
          cacheCreation = finiteNonnegative(raw.usage.cache_creation_input_tokens);
          // `usd_source` is stated, never inferred by the consumer from whether cost_usd
          // is present. Claude DOES report a real cost, so this is "reported" -- and a
          // 0 total means a genuinely free/cached-only turn, which is still a report.
          await this.emit({
            kind: "step_usage",
            metadata: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              cost_usd: costUsd,
              usd_source: "reported",
              cache_creation_input_tokens: cacheCreation,
              cache_read_input_tokens: cacheRead,
              model: requestedModel,
            },
          });
        }
        if (raw.subtype !== "success") {
          const errors = Array.isArray(raw.errors) ? raw.errors.filter((value): value is string => typeof value === "string") : [];
          throw new Error(errors.join("; ") || `claude query failed: ${String(raw.subtype)}`);
        }
      }
      controller.signal.throwIfAborted();
      return {
        text: finalText ?? assistantText,
        // total_cost_usd is the SDK's own price for the call — provider-reported.
        // A zero/absent price is omitted entirely: receipts require provenance
        // whenever `usd` is present, and there is nothing to attribute.
        usage: { ...(costUsd > 0 ? { usd: costUsd } : {}), tokens: inputTokens + outputTokens, ms: durationMs },
        // The Budget-shaped usage above necessarily drops the split; carry it
        // beside so receipts and downstream accounting keep input vs output
        // (STRAT-USAGE-SPLIT — before this, input_tokens read 0 everywhere).
        split: {
          input: inputTokens,
          output: outputTokens,
          ...(cacheRead > 0 ? { cacheRead } : {}),
          ...(cacheCreation > 0 ? { cacheCreation } : {}),
        },
        ...(costUsd > 0 ? { usdSource: "reported" as const } : {}),
        telemetry: { durationMs, model: resolvedModel },
      };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      Object.assign(failure, {
        telemetry: { durationMs, model: resolvedModel },
        usage: { tokens: inputTokens + outputTokens, ms: durationMs, ...(costUsd > 0 ? { usd: costUsd } : {}) },
        split: { input: inputTokens, output: outputTokens, cacheRead, cacheCreation },
        ...(costUsd > 0 ? { usdSource: "reported" } : {}),
      });
      // Finish stderr collection and child teardown before returning a diagnostic.
      if (controller.signal.aborted) { terminate(); await Promise.all(children.map(child => child.finish())); }
      if (stderr) Object.assign(failure, { stderr, cause: failure.cause ?? new Error(stderr.trim()) });
      throw failure;
    } finally {
      unlink();
      controller.signal.removeEventListener("abort", terminate);
      // Do not acknowledge cancellation while any owned process is still open.
      if (controller.signal.aborted) {
        terminate();
        await Promise.all(children.map(child => child.finish()));
      }
    }
  }

  private async emit(event: ConnectorEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_DETAIL_CAP = 2_048;

function shortInputSummary(input: unknown, limit = 80): string {
  if (isRecord(input)) {
    const values = Object.values(input);
    if (values.length === 1 && typeof values[0] === "string") return truncate(values[0], limit);
  }
  return truncate(safeStringify(input), limit);
}

function cappedToolInput(input: unknown): unknown {
  const normalized = input ?? {};
  const serialized = safeStringify(normalized);
  return serialized.length <= TOOL_DETAIL_CAP ? normalized : capText(serialized);
}

function toolResultText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : safeStringify(item)).join("\n");
  }
  return String(content);
}

function capText(value: string, limit = TOOL_DETAIL_CAP): string {
  if (value.length <= limit) return value;
  const keep = Math.max(0, limit - `…[truncated ${value.length} chars]`.length);
  return `${value.slice(0, keep)}…[truncated ${value.length - keep} chars]`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
