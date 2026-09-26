import { SMARTMEMORY_SCRUB_VARS } from "./base.js";
import type { CodexSandboxMode } from "../config/types.js";
import { fullAccessAuthorization } from "../config/index.js";
import { DEVIN_MODEL_PRICING } from "../judge/pricing.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1a — devin's static tables and pure resolution.
 * The spawn connector lands in S1b; everything here is table-driven and needs
 * no devin binary.
 */

/** Owner-picked default (Q3): the free SWE-2 family at high effort. */
export const DEVIN_DEFAULT_MODEL = "swe-2-high";

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

/** Sorted list of accepted devin model ids — the pricing table's keys. */
export function devinModelIds(): string[] {
  return Object.keys(DEVIN_MODEL_PRICING).sort();
}

/**
 * Family → accepted effort suffixes, derived from the pricing ids (D6: the
 * table must not be hand-listed twice). `swe-2-high` yields family "swe-2" /
 * effort "high". A derived "family" that is itself a priced id (e.g.
 * claude-opus-5-5-low, surfaced by the -fast serving variants) is a full id,
 * not a family — those rows stay dispatchable only by their full id.
 */
export function devinModelFamilies(): ReadonlyMap<string, readonly string[]> {
  const ids = devinModelIds();
  const byFamily = new Map<string, string[]>();
  for (const id of ids) {
    const dash = id.lastIndexOf("-");
    if (dash <= 0) continue;
    const family = id.slice(0, dash);
    byFamily.set(family, [...(byFamily.get(family) ?? []), id.slice(dash + 1)]);
  }
  for (const id of ids) byFamily.delete(id);
  for (const efforts of byFamily.values()) efforts.sort();
  return byFamily;
}

/** The effort suffix a priced id carries within its family, if one is known. */
function effortOf(modelId: string, families: ReadonlyMap<string, readonly string[]>): string | undefined {
  for (const [family, efforts] of families) {
    const prefix = `${family}-`;
    if (modelId.startsWith(prefix)) {
      const suffix = modelId.slice(prefix.length);
      if (efforts.includes(suffix)) return suffix;
    }
  }
  return undefined;
}

/**
 * Resolve request/default model and effort before any dispatch side effect —
 * the devin counterpart of resolveCodexModel (D6, equality). Accepts a full id
 * (`swe-2-high`), a family plus `effort` (`swe-2` + `high` → `swe-2-high`), or
 * the stratum slash form (`swe-2/high`). Default is DEVIN_DEFAULT_MODEL.
 * Unknown ids, unknown effort for a family, and a full id plus a conflicting
 * effort are rejected naming the valid set.
 */
export function resolveDevinModel(model?: string, effort?: string): string {
  const ids = devinModelIds();
  const families = devinModelFamilies();
  let base = model;
  let requestedEffort = effort;
  if (model !== undefined) {
    const slash = model.lastIndexOf("/");
    if (slash >= 0) {
      base = model.slice(0, slash);
      const slashEffort = model.slice(slash + 1);
      if (effort !== undefined && effort !== slashEffort) {
        throw new Error(`devin effort ${JSON.stringify(effort)} conflicts with the effort in model ${JSON.stringify(model)}`);
      }
      requestedEffort = slashEffort;
    }
  }
  if (base === undefined) {
    const dash = DEVIN_DEFAULT_MODEL.lastIndexOf("-");
    base = DEVIN_DEFAULT_MODEL.slice(0, dash);
    requestedEffort ??= DEVIN_DEFAULT_MODEL.slice(dash + 1);
  }
  if (ids.includes(base)) {
    if (requestedEffort !== undefined && effortOf(base, families) !== requestedEffort) {
      throw new Error(`devin effort ${JSON.stringify(requestedEffort)} conflicts with model ${JSON.stringify(base)}`);
    }
    return base;
  }
  const efforts = families.get(base);
  if (efforts !== undefined) {
    if (requestedEffort === undefined) {
      throw new Error(`devin model family ${JSON.stringify(base)} requires an effort; accepted efforts: ${efforts.join(", ")}`);
    }
    if (!efforts.includes(requestedEffort)) {
      throw new Error(`Unknown devin effort ${JSON.stringify(requestedEffort)} for family ${JSON.stringify(base)}; accepted efforts: ${efforts.join(", ")}`);
    }
    return `${base}-${requestedEffort}`;
  }
  throw new Error(`Unknown devin model ${JSON.stringify(base)}; accepted models: ${ids.join(", ")}`);
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
