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
  text: string;
  usage: ConnectorUsage;
  telemetry: ConnectorTelemetry;
}

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
