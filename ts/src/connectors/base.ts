/**
 * Credentials that must never reach a spawned agent subprocess.
 *
 * GOV-COMPOSE-SEAM-1 step 0: Compose now injects the SmartMemory API key and
 * workspace id into the Stratum MCP server's env so the policy client can
 * deliver enforcement events. The MCP server reads them once at construction,
 * long before any agent spawn — an implementer or reviewer agent has no use for
 * a live memory-write credential, and handing one over widens the blast radius
 * of a prompt injection from "edits code" to "rewrites the audit trail".
 *
 * Shared rather than duplicated per connector: the failure mode of this control
 * is a third connector that forgets it. Spread this into each connector's own
 * scrub list, which keeps its provider-specific entries (Codex, for instance,
 * legitimately keeps OPENAI_API_KEY).
 */
export const SMARTMEMORY_SCRUB_VARS = ["SMARTMEMORY_API_KEY", "SMARTMEMORY_WORKSPACE_ID"] as const;

/**
 * The one dispatchable agent list (STRAT-AGENT-DEVIN-1 D1). Every validator
 * derives its accepted set and error text from this — a fourth agent must never
 * ride in through an `else` that meant claude, and every `switch` over
 * AgentType carries a `never` default so the next addition is a compile error.
 */
export const AGENT_TYPES = ["claude", "codex", "devin"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Quoted agent list for "Unknown agent" error text, generated from AGENT_TYPES. */
export function describeAgentTypes(): string {
  return AGENT_TYPES.map((agent) => `"${agent}"`).join(", ");
}
export type { CodexSandboxMode } from "../config/types.js";
import type { CodexSandboxMode as SandboxMode } from "../config/types.js";

/** GUI apps cannot start inside the OS sandbox: full Chrome aborts
 * (SIGABRT) during WindowServer registration even with --headless. Agents that
 * discover this by crashing tend to retry into a crash loop, so every dispatch
 * states the constraint up front.
 *
 * Shared by every sandboxed connector (STRAT-AGENT-DEVIN-1 D3): the text is
 * agent-neutral — a seatbelt aborts a GUI launch no matter which agent runs
 * inside it. */
export const CODEX_SANDBOX_PREAMBLE = [
  "[sandbox constraints]",
  "You are running inside a restricted OS sandbox (macOS seatbelt / Linux landlock).",
  "GUI applications cannot start here: full Chrome/Chromium, Electron, or anything",
  "that opens a window aborts at launch (SIGABRT). That abort is the sandbox, not",
  "a bug in the code under test. For browser work use chrome-headless-shell (set",
  "via PUPPETEER_EXECUTABLE_PATH when available) or another headless-only tool.",
  "If a GUI launch aborts, do not retry it.",
  "[/sandbox constraints]",
].join("\n");

/** Sandboxed modes both run under seatbelt/landlock. Full access does not, so
 * prepending this warning there would assert a false execution boundary. */
export function withSandboxPreamble(prompt: string, sandboxMode: SandboxMode = "read-only"): string {
  if (sandboxMode === "danger-full-access") return prompt;
  if (prompt.startsWith("[sandbox constraints]")) return prompt;
  return `${CODEX_SANDBOX_PREAMBLE}\n\n${prompt}`;
}

/** Post-dispatch usage. Dispatch counts are reserved exclusively by the engine. */
export interface ConnectorUsage {
  usd?: number;
  tokens?: number;
  ms?: number;
}

/** Resolved execution identity, persisted verbatim on an engine attempt. */
export interface ConnectorTelemetry {
  durationMs: number;
  model: string;
  effort?: string;
}

export interface ConnectorResult {
  /**
   * Provenance of `usage.usd`, reported BESIDE usage: the engine ledger admits
   * only budget keys inside `usage` (ledger.ts validUsage), and surface 15
   * (`stratum_usage_report`) fails closed on an unlabelled dollar value — so a
   * connector that reports a provider-priced cost must say so here or the
   * receipt loses it (2026-08-30 census: local Claude receipts had no usd).
   *
   * "estimated" admitted 2026-09-12. Codex reports NO cost at all -- its usage events
   * carry token counts only -- so a codex call could never label a dollar value and
   * every one reached consumers as cost-unknown (measured: both codex rows of a live
   * compose shadow build were `usd: null` / incomplete, against a complete
   * provider-reported claude row). The connector now prices those calls from tokens and
   * says `estimated`, which the persisted receipt state at engine/state.ts:30 has always
   * admitted. "legacy" stays reserved for engine-synthesized receipts
   * (engine.ts:863-864); a connector must never send it.
   */
  usdSource?: "reported" | "estimated";
  /**
   * Input/output token detail, reported BESIDE usage for the same reason as
   * usdSource: the ledger admits only budget keys inside `usage`, so the
   * split must ride alongside or it is lost at the Budget narrowing —
   * which is exactly what happened to every record before STRAT-USAGE-SPLIT
   * (input_tokens read 0 on all of them; the aggregate was filed as output).
   */
  split?: ConnectorSplit;
  text: string;
  usage: ConnectorUsage;
  telemetry: ConnectorTelemetry;
  /** Present only when the effective Codex policy exceeds safe built-in defaults. */
  sandboxAudit?: SandboxPolicyAudit;
}

/** Token detail preserved beside the Budget-shaped usage (STRAT-USAGE-SPLIT). */
export interface ConnectorSplit {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** Connector-local narration event; the MCP boundary adds its wire envelope. */
export interface ConnectorEvent {
  kind: string;
  metadata: Record<string, unknown>;
}

export type ConnectorEventHandler = (event: ConnectorEvent) => void | Promise<void>;

export const CODEX_REASONING_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh"];

export function modelIdentity(modelId: string): { model: string; effort?: string } {
  const slash = modelId.lastIndexOf("/");
  if (slash < 0) return { model: modelId };
  const model = modelId.slice(0, slash);
  const effort = modelId.slice(slash + 1);
  return CODEX_REASONING_EFFORTS.includes(effort) ? { model, effort } : { model: modelId };
}

export function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
import type { SandboxPolicyAudit } from "../config/types.js";
