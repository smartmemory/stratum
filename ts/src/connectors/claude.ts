import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorEvent, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { finiteNonnegative, SMARTMEMORY_SCRUB_VARS } from "./base.js";

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
    const requestedModel = this.options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
    const env = { ...(this.options.env ?? process.env) };
    for (const key of SENSITIVE_ENV_VARS) delete env[key];
    const sdkOptions: Record<string, unknown> = {
      cwd: this.options.cwd ?? process.cwd(),
      model: requestedModel,
      permissionMode: "acceptEdits",
      env,
    };
    if (this.options.allowedTools !== undefined) {
      sdkOptions.tools = this.options.allowedTools;
      if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
    } else {
      sdkOptions.tools = { type: "preset", preset: "claude_code" };
      if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
    }
    if (this.options.thinking !== undefined) sdkOptions.thinking = this.options.thinking;

    let resolvedModel = requestedModel;
    let finalText: string | undefined;
    let assistantText = "";
    let durationMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
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
      if (raw.subtype !== "success") {
        const errors = Array.isArray(raw.errors) ? raw.errors.filter((value): value is string => typeof value === "string") : [];
        throw new Error(errors.join("; ") || `claude query failed: ${String(raw.subtype)}`);
      }
      if (typeof raw.result === "string") finalText = raw.result;
      costUsd = finiteNonnegative(raw.total_cost_usd);
      if (isRecord(raw.usage)) {
        inputTokens = finiteNonnegative(raw.usage.input_tokens);
        outputTokens = finiteNonnegative(raw.usage.output_tokens);
        await this.emit({
          kind: "step_usage",
          metadata: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: finiteNonnegative(raw.usage.cache_creation_input_tokens),
            cache_read_input_tokens: finiteNonnegative(raw.usage.cache_read_input_tokens),
            model: requestedModel,
          },
        });
      }
    }
    return {
      text: finalText ?? assistantText,
      usage: { usd: costUsd, tokens: inputTokens + outputTokens, ms: durationMs },
      telemetry: { durationMs, model: resolvedModel },
    };
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
