import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ConnectorResult } from "./base.js";
import { finiteNonnegative } from "./base.js";

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
}

const defaultQuery: QueryFunction = (params) => sdkQuery(params as Parameters<typeof sdkQuery>[0]);
const SENSITIVE_ENV_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"] as const;

export class ClaudeConnector {
  private readonly options: ClaudeConnectorOptions;
  private readonly query: QueryFunction;

  constructor(options: ClaudeConnectorOptions = {}) {
    this.options = options;
    this.query = options.query ?? defaultQuery;
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
      sdkOptions.allowedTools = this.options.allowedTools;
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
    for await (const raw of this.query({ prompt, options: sdkOptions })) {
      if (!isRecord(raw)) continue;
      if (raw.type === "system" && raw.subtype === "init" && typeof raw.model === "string") resolvedModel = raw.model;
      if (raw.type === "assistant" && isRecord(raw.message) && Array.isArray(raw.message.content)) {
        for (const block of raw.message.content) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string") assistantText += block.text;
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
      }
    }
    return {
      text: finalText ?? assistantText,
      usage: { usd: costUsd, tokens: inputTokens + outputTokens, ms: durationMs },
      telemetry: { durationMs, model: resolvedModel },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
