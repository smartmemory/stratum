import type { AgentType, CodexSandboxMode, ConnectorResult } from "./base.js";
import { startBackgroundRun } from "./background.js";
import { ClaudeConnector, type QueryFunction } from "./claude.js";
import { CodexConnector, type SpawnProcess } from "./codex.js";

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
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid: number; streamPath: string }> {
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
    });
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
