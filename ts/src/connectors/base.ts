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
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

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
