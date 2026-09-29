import * as resolution from "../config/devin-resolution.js";
import { SMARTMEMORY_SCRUB_VARS } from "./base.js";
import type { CodexSandboxMode } from "../config/types.js";
import { fullAccessAuthorization } from "../config/index.js";
import { catalog, DEVIN_DEFAULT_MODEL, type ModelCatalog } from "../config/models.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1a — devin's static tables and pure resolution.
 * The spawn connector lands in S1b; everything here is table-driven and needs
 * no devin binary.
 */

/** Owner-picked default (Q3): the free SWE-2 family at high effort. */
export { DEVIN_DEFAULT_MODEL };

/**
 * Devin authenticates from its own credentials file (`devin auth` →
 * ~/.local/share/devin/credentials.toml), so every provider key is scrubbed —
 * including OPENAI_API_KEY, which codex legitimately keeps but devin must never
 * inherit. The DEVIN_* mode overrides are scrubbed too: the connector owns
 * --model/--permission-mode (D7). Applied on both paths in S1b.
 */
export const DEVIN_SCRUB_VARS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "CLAUDECODE",
  "OPENAI_API_KEY",
  "DEVIN_MODEL",
  "DEVIN_PERMISSION_MODE",
  "DEVIN_SANDBOX",
  ...SMARTMEMORY_SCRUB_VARS,
] as const;

/** Catalog-backed connector API; validation uses the pure resolver directly. */
export function devinModelIds(models: ModelCatalog = catalog): string[] {
  return resolution.devinModelIds(models);
}
export function devinModelFamilies(models: ModelCatalog = catalog): ReadonlyMap<string, readonly string[]> {
  return resolution.devinModelFamilies(models);
}
export function devinModelIdentity(modelId: string): { model: string; effort?: string } {
  return resolution.devinModelIdentity(modelId, catalog);
}
export function resolveDevinModel(model?: string, effort?: string, models: ModelCatalog = catalog): string {
  return resolution.resolveDevinModel(model, effort, models);
}

/**
 * devin's danger-full-access is fail-closed opt-in, mirroring
 * assertCodexSandboxAllowed but keyed on STRATUM_DEVIN_ALLOW_FULL_ACCESS —
 * a codex env grant must never authorise a devin run (D11).
 */
export function assertDevinSandboxAllowed(
  sandboxMode: CodexSandboxMode,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (sandboxMode !== "danger-full-access") return;
  if (fullAccessAuthorization(env, "devin") === undefined) {
    throw new Error(
      "devin danger-full-access is disabled; set STRATUM_DEVIN_ALLOW_FULL_ACCESS=1 to opt in explicitly",
    );
  }
}
