import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { ConfigProvenance } from "./types.js";

/** The one `[learn]` key this resolver owns; INLINE-TS-1 adds `inline` alongside it. */
export const LEARN_DELIVER_ENV = "STRATUM_LEARN_DELIVER";

export interface LearnConfigOptions {
  /** The project layer: the canonical workspace of the run being served. */
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedLearnConfig {
  readonly deliver: boolean;
  readonly provenance: ConfigProvenance;
  /** Invalid values and unreadable files. Never thrown: an invalid switch resolves OFF. */
  readonly diagnostics: readonly string[];
}

const DEFAULT: ConfigProvenance = Object.freeze({ layer: "default", source: "built-in defaults" });

/**
 * Resolve `[learn] deliver` through defaults < user < project < env (STRAT-CONFIG-PREFS-1),
 * isolated from the shared sandbox loader (INLINE-TS-1 §A7): any invalid value, unknown
 * `[learn]` key or TOML parse failure resolves the switch OFF with a diagnostic and can
 * neither fail a dispatch nor fail the flow.
 */
export function resolveLearnConfig(options: LearnConfigOptions): ResolvedLearnConfig {
  const env = options.env ?? process.env;
  const diagnostics: string[] = [];
  let deliver = false;
  let provenance = DEFAULT;
  let invalid = false;

  const layers: Array<{ path: string; layer: "user" | "project" }> = [
    { path: env.STRATUM_CONFIG_FILE || join(homedir(), ".stratum", "config.toml"), layer: "user" },
    { path: join(options.projectRoot, "stratum.toml"), layer: "project" },
  ];
  for (const { path, layer } of layers) {
    const value = fileValue(path, diagnostics);
    if (value === "invalid") invalid = true;
    else if (value !== undefined) {
      deliver = value;
      provenance = Object.freeze({ layer, source: path });
    }
  }

  const raw = env[LEARN_DELIVER_ENV];
  if (raw !== undefined && raw.trim() !== "") {
    const value = envBoolean(raw);
    if (value === undefined) {
      diagnostics.push(`${LEARN_DELIVER_ENV}: must be one of 1/0, true/false, yes/no, on/off`);
      invalid = true;
    } else {
      deliver = value;
      provenance = Object.freeze({ layer: "env", source: LEARN_DELIVER_ENV });
    }
  }

  return Object.freeze({ deliver: invalid ? false : deliver, provenance, diagnostics: Object.freeze(diagnostics) });
}

function fileValue(path: string, diagnostics: string[]): boolean | "invalid" | undefined {
  let raw: unknown;
  try {
    if (!existsSync(path)) return undefined;
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(`${path}: TOML parse error: ${error instanceof Error ? error.message : String(error)}`);
    return "invalid";
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const learn = (raw as Record<string, unknown>).learn;
  if (learn === undefined) return undefined;
  if (learn === null || typeof learn !== "object" || Array.isArray(learn)) {
    diagnostics.push(`${path}: learn must be a table`);
    return "invalid";
  }
  const table = learn as Record<string, unknown>;
  const unknown = Object.keys(table).filter((key) => key !== "deliver");
  if (unknown.length > 0) {
    diagnostics.push(`${path}: unknown config key(s) ${unknown.map((key) => JSON.stringify(`learn.${key}`)).join(", ")}`);
    return "invalid";
  }
  if (table.deliver === undefined) return undefined;
  if (typeof table.deliver !== "boolean") {
    diagnostics.push(`${path}: learn.deliver must be a boolean`);
    return "invalid";
  }
  return table.deliver;
}

function envBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}
