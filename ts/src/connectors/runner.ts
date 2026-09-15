import type { AgentType, CodexSandboxMode, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { startBackgroundRun } from "./background.js";
import { ClaudeConnector, type QueryFunction } from "./claude.js";
import { CodexConnector, type SpawnProcess } from "./codex.js";

// Module-level discriminant sets — created once, not per-call (intentionally isolated
// from the identical sets in background.ts to avoid a cross-module import dependency).
const VALID_AGENTS = new Set<string>(["claude", "codex"]);
const VALID_SANDBOX_MODES = new Set<string>(["read-only", "workspace-write"]);

export interface AgentRunOptions {
  agent: AgentType;
  prompt: string;
  cwd?: string;
  model?: string;
  background?: boolean;
  signal?: AbortSignal;
  ownProcessGroup?: boolean;
  /** Group-leader pid of each cancellable child, reported as it spawns (S02-1). Forwarded to
   *  the foreground connectors only: a background run already records its own pid
   *  (background.ts:176-191). */
  onSpawn?: (pid: number) => void;
  thinking?: Record<string, unknown>;
  effort?: string;
  sandboxMode?: CodexSandboxMode;
  registryRoot?: string;
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Foreground connector narration; omitted for background runs. */
  onEvent?: ConnectorEventHandler;
}

export interface AgentRunBoundaries {
  codexSpawn?: SpawnProcess;
  claudeQuery?: QueryFunction;
  /** Final argv replacement at the durable process boundary. */
  backgroundCommand?: string[];
}

export async function runAgent(
  options: AgentRunOptions,
  boundaries: AgentRunBoundaries = {},
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string }> {
  // 4c: discriminant validation — reject unknown agent and sandboxMode values before
  // either the background or foreground dispatch branch. Mirrors background.ts guards
  // (D11) but is intentionally independent (no cross-module import).
  if (!VALID_AGENTS.has(options.agent)) {
    throw new Error(
      `Unknown agent ${JSON.stringify(options.agent)}; must be "claude" or "codex"`,
    );
  }
  if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
    throw new Error(
      `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only" or "workspace-write"`,
    );
  }
  // D8 applies to the FOREGROUND claude path too: ClaudeConnector hardcodes
  // permissionMode "acceptEdits" and cannot enforce read-only, so accepting the
  // request would be a false guarantee. (The background path rejects in
  // startClaudeBackgroundRun; codex enforces read-only natively.)
  if (options.agent === "claude" && options.sandboxMode === "read-only") {
    throw new Error(
      'claude runs with sandboxMode="read-only" are not supported: the Claude connector ' +
      'cannot enforce read-only (D8). Omit sandboxMode or pass "workspace-write".',
    );
  }
  options.signal?.throwIfAborted();
  validateAgentSettings(options);
  const cwd = options.cwd ?? process.cwd();
  if (options.background) {
    // Claude-only settings never reach a background codex run: startBackgroundRun's
    // codex branch builds its argv from codexCommand() and records CodexRunMeta,
    // neither of which carries a tool filter or a thinking block. Forwarding them
    // here would advertise a guarantee the durable wrapper cannot keep, and
    // validateAgentSettings has already rejected them for codex, so the spread is
    // claude-only rather than dead (D5 / BG-WRITE-A).
    return startBackgroundRun({
      agent: options.agent,
      prompt: options.prompt,
      cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(boundaries.backgroundCommand !== undefined ? { command: boundaries.backgroundCommand } : {}),
      ...(options.agent === "claude" && options.thinking !== undefined ? { thinking: options.thinking } : {}),
      // 4b: carry tool filters through to background CLAUDE runs (D5 / BG-WRITE-A)
      ...(options.agent === "claude" && options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.agent === "claude" && options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    } as Parameters<typeof startBackgroundRun>[0]);
  }
  if (options.agent === "codex") {
    return new CodexConnector({
      ...(options.ownProcessGroup !== undefined ? { ownProcessGroup: options.ownProcessGroup } : {}),
      cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
      ...(boundaries.codexSpawn !== undefined ? { spawn: boundaries.codexSpawn } : {}),
      ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }).run(options.prompt);
  }
  return new ClaudeConnector({
    cwd,
    ...(options.ownProcessGroup !== undefined ? { ownProcessGroup: options.ownProcessGroup } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
    ...(boundaries.claudeQuery !== undefined ? { query: boundaries.claudeQuery } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
  }).run(options.prompt);
}

/** Reject settings that would otherwise silently disappear at a provider boundary. */
export function validateAgentSettings(options: Pick<AgentRunOptions, "agent" | "model" | "effort" | "thinking" | "allowedTools" | "disallowedTools">): void {
  if (options.agent === "codex") {
    if (options.thinking !== undefined || options.allowedTools !== undefined || options.disallowedTools !== undefined) {
      throw new Error("Codex does not support Claude thinking/tool filters; select a Codex sandboxMode instead");
    }
    if (options.effort !== undefined && !["minimal", "low", "medium", "high", "xhigh"].includes(options.effort)) {
      throw new Error(`unsupported Codex reasoning effort ${JSON.stringify(options.effort)}`);
    }
  } else {
    if (options.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(options.effort)) {
      throw new Error(`unsupported Claude effort ${JSON.stringify(options.effort)}`);
    }
    if (options.thinking !== undefined) {
      const { type, budgetTokens, display, ...unknown } = options.thinking;
      if (!["adaptive", "enabled", "disabled"].includes(String(type)) || Object.keys(unknown).length
        || (budgetTokens !== undefined && (type !== "enabled" || !Number.isInteger(budgetTokens) || Number(budgetTokens) <= 0))
        || (display !== undefined && (type === "disabled" || !["summarized", "omitted"].includes(String(display))))) {
        throw new Error("invalid Claude thinking configuration");
      }
    }
  }
}
