import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { ConfigProvenance } from "./types.js";

/** The `[learn]` switches this resolver owns, each with its env override. */
export const LEARN_ENV = Object.freeze({
  /** STRAT-LEARN-DELIVER-1: inject applied lessons into matching dispatches. */
  deliver: "STRATUM_LEARN_DELIVER",
  /** STRAT-LEARN-INLINE-TS-1: stage lessons automatically after every terminal run. */
  inline: "STRATUM_LEARN_INLINE",
});
export type LearnKey = keyof typeof LEARN_ENV;
const LEARN_KEYS = Object.keys(LEARN_ENV) as LearnKey[];
/** DELIVER-1 D6: held runs before a `retire-candidate` review is raised. */
export const RETIRE_REVIEW_AFTER_ENV = "STRATUM_LEARN_RETIRE_REVIEW_AFTER";
export const DEFAULT_RETIRE_REVIEW_AFTER = 3;
const ALL_KEYS: readonly string[] = [...LEARN_KEYS, "retireReviewAfter"];

export interface LearnConfigOptions {
  /** The project layer: the canonical workspace of the run being served. Omitted → no project layer. */
  readonly projectRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ResolvedLearnConfig {
  readonly deliver: boolean;
  readonly inline: boolean;
  /** Positive integer; an invalid value keeps the default (a threshold, not a switch). */
  readonly retireReviewAfter: number;
  /** The winning layer per switch (reported by `stratum learn list` and diagnostics). */
  readonly provenance: Readonly<Record<LearnKey, ConfigProvenance>>;
  /** Invalid values and unreadable files. Never thrown: an invalid switch resolves OFF. */
  readonly diagnostics: readonly string[];
}

const DEFAULT: ConfigProvenance = Object.freeze({ layer: "default", source: "built-in defaults" });

/**
 * Resolve `[learn]` through defaults < user < project < env (STRAT-CONFIG-PREFS-1),
 * isolated from the shared sandbox loader (INLINE-TS-1 §A7): an invalid value turns that
 * switch OFF; an unknown `[learn]` key, a non-table `[learn]` or a TOML parse failure in
 * a layer turns every switch OFF. Each case is a diagnostic; nothing here throws, so a
 * `[learn]` mistake can neither fail a dispatch nor fail the flow.
 */
export function resolveLearnConfig(options: LearnConfigOptions = {}): ResolvedLearnConfig {
  const env = options.env ?? process.env;
  const diagnostics: string[] = [];
  const values: Record<LearnKey, boolean> = { deliver: false, inline: false };
  const provenance: Record<LearnKey, ConfigProvenance> = { deliver: DEFAULT, inline: DEFAULT };
  const invalid = new Set<LearnKey>();
  let retireReviewAfter = DEFAULT_RETIRE_REVIEW_AFTER;
  const threshold = (value: unknown, source: string): void => {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) retireReviewAfter = value;
    else diagnostics.push(`${source}: learn.retireReviewAfter must be a positive integer`);
  };

  const layers: Array<{ path: string; layer: "user" | "project" }> = [
    { path: env.STRATUM_CONFIG_FILE || join(homedir(), ".stratum", "config.toml"), layer: "user" },
    ...(options.projectRoot !== undefined
      ? [{ path: join(options.projectRoot, "stratum.toml"), layer: "project" as const }]
      : []),
  ];
  for (const { path, layer } of layers) {
    const table = fileTable(path, diagnostics);
    if (table === "invalid") { for (const key of LEARN_KEYS) invalid.add(key); continue; }
    if (table?.retireReviewAfter !== undefined) threshold(table.retireReviewAfter, path);
    for (const key of LEARN_KEYS) {
      const value = table?.[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean") {
        diagnostics.push(`${path}: learn.${key} must be a boolean`);
        invalid.add(key);
        continue;
      }
      values[key] = value;
      provenance[key] = Object.freeze({ layer, source: path });
    }
  }

  for (const key of LEARN_KEYS) {
    const name = LEARN_ENV[key];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const value = envBoolean(raw);
    if (value === undefined) {
      diagnostics.push(`${name}: must be one of 1/0, true/false, yes/no, on/off`);
      invalid.add(key);
      continue;
    }
    values[key] = value;
    provenance[key] = Object.freeze({ layer: "env", source: name });
  }

  const rawThreshold = env[RETIRE_REVIEW_AFTER_ENV];
  if (rawThreshold !== undefined && rawThreshold.trim() !== "") {
    threshold(/^\d+$/.test(rawThreshold.trim()) ? Number(rawThreshold.trim()) : Number.NaN, RETIRE_REVIEW_AFTER_ENV);
  }

  return Object.freeze({
    deliver: !invalid.has("deliver") && values.deliver,
    inline: !invalid.has("inline") && values.inline,
    retireReviewAfter,
    provenance: Object.freeze(provenance),
    diagnostics: Object.freeze(diagnostics),
  });
}

function fileTable(path: string, diagnostics: string[]): Record<string, unknown> | "invalid" | undefined {
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
  const unknown = Object.keys(table).filter((key) => !ALL_KEYS.includes(key));
  if (unknown.length > 0) {
    diagnostics.push(`${path}: unknown config key(s) ${unknown.map((key) => JSON.stringify(`learn.${key}`)).join(", ")}`);
    return "invalid";
  }
  return table;
}

function envBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}
