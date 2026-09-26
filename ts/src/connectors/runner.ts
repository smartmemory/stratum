import { AGENT_TYPES, CODEX_REASONING_EFFORTS, describeAgentTypes } from "./base.js";
import { normalizePeerLabel } from "./peer-registry.js";
import type { AgentType, CodexSandboxMode, ConnectorEventHandler, ConnectorResult } from "./base.js";
import { startBackgroundRun } from "./background.js";
import { ClaudeConnector, type QueryFunction } from "./claude.js";
import { CodexConnector, type SpawnProcess } from "./codex.js";
import { assertDevinSandboxAllowed, resolveDevinModel } from "./devin-model.js";
import { isSandboxEscalated, loadStratumConfig, type ResolvedStratumConfig } from "../config/index.js";
import type { CodexApprovalPolicy } from "../config/types.js";

// Module-level discriminant sets — created once, not per-call (intentionally isolated
// from the identical sets in background.ts to avoid a cross-module import dependency;
// both derive the agent set from AGENT_TYPES in base.js — D1).
const VALID_AGENTS = new Set<string>(AGENT_TYPES);
const VALID_SANDBOX_MODES = new Set<string>(["read-only", "workspace-write", "danger-full-access"]);

export interface AgentRunOptions {
  agent: AgentType;
  prompt: string;
  cwd?: string;
  model?: string;
  background?: boolean;
  peerLabel?: string;
  signal?: AbortSignal;
  ownProcessGroup?: boolean;
  /** Group-leader pid of each cancellable child, reported as it spawns (S02-1). Forwarded to
   *  the foreground connectors only: a background run already records its own pid
   *  (background.ts:176-191). */
  onSpawn?: (pid: number) => void;
  thinking?: Record<string, unknown>;
  effort?: string;
  sandboxMode?: CodexSandboxMode;
  networkAccess?: boolean;
  writableRoots?: readonly string[];
  approvalPolicy?: CodexApprovalPolicy;
  registryRoot?: string;
  sessionsDir?: string;
  sockDir?: string;
  lingerMs?: number;
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
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string; peerName?: string }> {
  if (options.peerLabel !== undefined && options.background !== true) throw new Error("peerLabel is background-only");
  const peerLabel = normalizePeerLabel(options.peerLabel);
  // 4c: discriminant validation — reject unknown agent and sandboxMode values before
  // either the background or foreground dispatch branch. Mirrors background.ts guards
  // (D11) but is intentionally independent (no cross-module import).
  if (!VALID_AGENTS.has(options.agent)) {
    throw new Error(
      `Unknown agent ${JSON.stringify(options.agent)}; must be one of ${describeAgentTypes()}`,
    );
  }
  if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
    throw new Error(
      `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only", "workspace-write", or "danger-full-access"`,
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
  if (options.agent === "claude" && options.sandboxMode === "danger-full-access") {
    throw new Error('sandboxMode="danger-full-access" is Codex-only; Claude does not enforce Codex sandbox modes');
  }
  options.signal?.throwIfAborted();
  validateAgentSettings(options);
  const cwd = options.cwd ?? process.cwd();
  // Sandbox-capable agents resolve stratum.toml/env policy here (D11); claude
  // has no sandbox knobs to resolve.
  let resolved: ResolvedStratumConfig | undefined;
  switch (options.agent) {
    case "claude":
      break;
    case "codex":
      resolved = loadStratumConfig({
        projectRoot: cwd,
        dispatch: {
          ...(options.sandboxMode !== undefined ? { filesystemMode: options.sandboxMode } : {}),
          ...(options.networkAccess !== undefined ? { networkAccess: options.networkAccess } : {}),
          ...(options.writableRoots !== undefined ? { writableRoots: options.writableRoots } : {}),
          ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {}),
        },
        env: options.env ?? process.env,
      });
      break;
    case "devin":
      resolved = loadStratumConfig({
        projectRoot: cwd,
        agent: "devin",
        dispatch: {
          ...(options.sandboxMode !== undefined ? { filesystemMode: options.sandboxMode } : {}),
          ...(options.networkAccess !== undefined ? { networkAccess: options.networkAccess } : {}),
          ...(options.writableRoots !== undefined ? { writableRoots: options.writableRoots } : {}),
          // No approvalPolicy: explicit values are already rejected by
          // validateAgentSettings, and loadStratumConfig fail-closes on any
          // that slip through.
        },
        env: options.env ?? process.env,
      });
      assertDevinSandboxAllowed(resolved.sandbox.filesystemMode, options.env ?? process.env);
      break;
    default: {
      const exhaustive: never = options.agent;
      throw new Error(`Unknown agent ${JSON.stringify(exhaustive)}; must be one of ${describeAgentTypes()}`);
    }
  }
  const sandbox = resolved?.sandbox;
  const sandboxAudit = sandbox !== undefined && isSandboxEscalated(sandbox) ? resolved!.sandboxAudit() : undefined;
  if (options.background) {
    // Claude-only settings never reach a background codex run: startBackgroundRun's
    // codex branch builds its argv from codexCommand() and records CodexRunMeta,
    // neither of which carries a tool filter or a thinking block. Forwarding them
    // here would advertise a guarantee the durable wrapper cannot keep, and
    // validateAgentSettings has already rejected them for codex, so the spread is
    // claude-only rather than dead (D5 / BG-WRITE-A).
    return startBackgroundRun({
      ...(peerLabel !== undefined ? {peerLabel} : {}),
      agent: options.agent,
      prompt: options.prompt,
      cwd,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(sandbox !== undefined ? {
        sandboxMode: sandbox.filesystemMode,
        networkAccess: sandbox.networkAccess,
        writableRoots: sandbox.writableRoots,
        // devin's approvalPolicy is enforced, not resolved — never forwarded.
        ...(options.agent === "devin" ? {} : { approvalPolicy: sandbox.approvalPolicy }),
      } : options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
      ...(sandboxAudit !== undefined ? { sandboxAudit } : {}),
      ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
      ...(options.sessionsDir !== undefined ? { sessionsDir: options.sessionsDir } : {}),
      ...(options.sockDir !== undefined ? { sockDir: options.sockDir } : {}),
      ...(options.lingerMs !== undefined ? { lingerMs: options.lingerMs } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(boundaries.backgroundCommand !== undefined ? { command: boundaries.backgroundCommand } : {}),
      ...claudeBackgroundSettings(options),
    } as Parameters<typeof startBackgroundRun>[0]);
  }
  switch (options.agent) {
    case "codex":
      return new CodexConnector({
        ...(options.ownProcessGroup !== undefined ? { ownProcessGroup: options.ownProcessGroup } : {}),
        cwd,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        sandboxMode: sandbox!.filesystemMode,
        networkAccess: sandbox!.networkAccess,
        writableRoots: sandbox!.writableRoots,
        approvalPolicy: sandbox!.approvalPolicy,
        ...(sandboxAudit !== undefined ? { sandboxAudit } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
        ...(boundaries.codexSpawn !== undefined ? { spawn: boundaries.codexSpawn } : {}),
        ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }).run(options.prompt);
    case "claude":
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
    case "devin":
      // S1a lands validation only; DevinConnector arrives in S1b.
      throw new Error("devin connector not implemented yet (STRAT-AGENT-DEVIN-1 S1b)");
    default: {
      const exhaustive: never = options.agent;
      throw new Error(`Unknown agent ${JSON.stringify(exhaustive)}; must be one of ${describeAgentTypes()}`);
    }
  }
}

/**
 * Claude-only options for the background path (4b/D5 / BG-WRITE-A). Codex and
 * devin have these rejected by validateAgentSettings, so for them this returns
 * nothing — the exhaustive switch keeps a future agent from silently
 * inheriting claude's filters (D1).
 */
function claudeBackgroundSettings(
  options: Pick<AgentRunOptions, "agent" | "thinking" | "allowedTools" | "disallowedTools">,
): Pick<AgentRunOptions, "thinking" | "allowedTools" | "disallowedTools"> {
  switch (options.agent) {
    case "claude":
      return {
        ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
      };
    case "codex":
    case "devin":
      return {};
    default: {
      const exhaustive: never = options.agent;
      throw new Error(`Unknown agent ${JSON.stringify(exhaustive)}; must be one of ${describeAgentTypes()}`);
    }
  }
}

/** Reject settings that would otherwise silently disappear at a provider boundary. */
export function validateAgentSettings(options: Pick<AgentRunOptions, "agent" | "model" | "effort" | "thinking" | "allowedTools" | "disallowedTools" | "networkAccess" | "writableRoots" | "approvalPolicy">): void {
  switch (options.agent) {
    case "codex": {
      if (options.thinking !== undefined || options.allowedTools !== undefined || options.disallowedTools !== undefined) {
        throw new Error("Codex does not support Claude thinking/tool filters; select a Codex sandboxMode instead");
      }
      if (options.effort !== undefined && !CODEX_REASONING_EFFORTS.includes(options.effort)) {
        throw new Error(`unsupported Codex reasoning effort ${JSON.stringify(options.effort)}`);
      }
      return;
    }
    case "devin": {
      // Same rejection codex gives for Claude-only settings, naming devin (D1).
      if (options.thinking !== undefined || options.allowedTools !== undefined || options.disallowedTools !== undefined) {
        throw new Error("Devin does not support Claude thinking/tool filters; select a Devin sandboxMode instead");
      }
      // approvalPolicy is a codex approval concept; devin's is enforced (D11).
      if (options.approvalPolicy !== undefined) {
        throw new Error("Codex approvalPolicy is not supported by devin");
      }
      // Only an EXPLICIT dispatch-level false fails — the resolved default is
      // overridden to the enforced `true` by loadStratumConfig (D3 network).
      if (options.networkAccess === false) {
        throw new Error("devin cannot run without network; networkAccess:false is not enforceable for devin");
      }
      resolveDevinModel(options.model, options.effort);
      return;
    }
    case "claude": {
      if (options.networkAccess !== undefined || options.writableRoots !== undefined || options.approvalPolicy !== undefined) {
        throw new Error("Codex sandbox networkAccess/writableRoots/approvalPolicy settings are not supported by Claude");
      }
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
      return;
    }
    default: {
      const exhaustive: never = options.agent;
      throw new Error(`Unknown agent ${JSON.stringify(exhaustive)}; must be one of ${describeAgentTypes()}`);
    }
  }
}
