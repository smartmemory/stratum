import type { AgentType, CodexSandboxMode, ConnectorResult } from "./base.js";
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
  sandboxMode?: CodexSandboxMode;
  budgeted?: boolean;
  registryRoot?: string;
  env?: NodeJS.ProcessEnv;
  allowedTools?: string[];
  disallowedTools?: string[];
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
  const cwd = options.cwd ?? process.cwd();
  if (options.background) {
    return startBackgroundRun({
      agent: options.agent,
      prompt: options.prompt,
      cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.budgeted !== undefined ? { budgeted: options.budgeted } : {}),
      ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(boundaries.backgroundCommand !== undefined ? { command: boundaries.backgroundCommand } : {}),
      // 4b: carry tool filters through to background runs (D5 / BG-WRITE-A)
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    } as Parameters<typeof startBackgroundRun>[0]);
  }
  if (options.agent === "codex") {
    return new CodexConnector({
      cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(boundaries.codexSpawn !== undefined ? { spawn: boundaries.codexSpawn } : {}),
    }).run(options.prompt);
  }
  return new ClaudeConnector({
    cwd,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(boundaries.claudeQuery !== undefined ? { query: boundaries.claudeQuery } : {}),
  }).run(options.prompt);
}
