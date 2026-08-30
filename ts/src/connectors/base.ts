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

export type AgentType = "claude" | "codex";
export type CodexSandboxMode = "read-only" | "workspace-write";

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
   */
  usdSource?: "reported";
  text: string;
  usage: ConnectorUsage;
  telemetry: ConnectorTelemetry;
}

/** Connector-local narration event; the MCP boundary adds its wire envelope. */
export interface ConnectorEvent {
  kind: string;
  metadata: Record<string, unknown>;
}

export type ConnectorEventHandler = (event: ConnectorEvent) => void | Promise<void>;

export function modelIdentity(modelId: string): { model: string; effort?: string } {
  const slash = modelId.indexOf("/");
  if (slash < 0) return { model: modelId };
  const model = modelId.slice(0, slash);
  const effort = modelId.slice(slash + 1);
  return effort ? { model, effort } : { model };
}

export function finiteNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
