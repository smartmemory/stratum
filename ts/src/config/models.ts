import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { z } from "zod";
import { CODEX_REASONING_EFFORTS } from "../connectors/base.js";
import { resolveDevinModel } from "./devin-resolution.js";

const name = z.string().min(1);
const selection = z.object({ model: name, effort: name }).strict();
const tier = selection.extend({ mode: z.enum(["adaptive", "off", "unavailable"]) });
const tiers = z.object(Object.fromEntries(
  ["critical", "standard", "fast", "budget", "coordinator"].map(key => [key, z.union([tier, z.literal("unavailable")])]),
)).strict();
const price = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cache_read: z.number().finite().nonnegative(),
}).strict();
const judgeEffort = z.enum(["low", "medium", "high"], {
  errorMap: () => ({ message: "unsupported judge effort; accepted efforts: low, medium, high" }),
});
const schema = z.object({
  codex: z.object({ default: selection }).strict(),
  devin: z.object({ default: selection }).strict(),
  claude: z.object({ default: z.object({ model: name }).strict() }).strict(),
  models: z.object({ claude: z.array(name).nonempty() }).strict(),
  retired: z.object({ codex: z.array(name), devin: z.array(name), claude: z.array(name) }).strict(),
  judge: z.object({
    cheap: selection.extend({ effort: judgeEffort }),
    default: selection.extend({ effort: judgeEffort }),
    paranoid: selection.extend({ effort: judgeEffort }),
  }).strict(),
  tiers: z.object({ codex: tiers, devin: tiers, claude: tiers }).strict(),
  pricing: z.object({ codex: z.record(price), devin: z.record(price) }).strict(),
}).strict();

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type ModelCatalog = DeepReadonly<z.infer<typeof schema>>;
export interface LoadedModelCatalog {
  readonly catalog: ModelCatalog;
  readonly catalogDigest: string;
  /** Absolute path of this installation's shipped file. */
  readonly path: string;
}

/** Explicit file seam for validation/tests, never a user/project override. */
export function loadModelCatalog(path: string): LoadedModelCatalog {
  const absolutePath = resolve(path);
  try {
    const bytes = readFileSync(absolutePath);
    const models = schema.parse(parse(bytes.toString("utf8")));
    validateSelections(models);
    return deepFreeze({
      catalog: models,
      catalogDigest: createHash("sha256").update(bytes).digest("hex"),
      path: absolutePath,
    });
  } catch (error) {
    throw new Error(`Invalid model catalog ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function validateSelections(models: ModelCatalog): void {
  for (const provider of ["codex", "devin", "claude"] as const) {
    const ids = provider === "claude" ? models.models.claude : Object.keys(models.pricing[provider]);
    const accepted = ids.filter(id => !models.retired[provider].includes(id)).sort();
    for (const id of models.retired[provider]) {
      if (!ids.includes(id)) throw new Error(`Unknown retired ${provider} model ${JSON.stringify(id)}; accepted models: ${ids.join(", ")}`);
    }
    const selections = Object.entries(models.tiers[provider]).filter((entry): entry is [string, z.infer<typeof tier>] => entry[1] !== "unavailable");
    const candidates: [string, { readonly model: string; readonly effort?: string; readonly mode?: string }][] = [
      ["default", models[provider].default], ...selections,
      ...(provider === "codex" ? Object.entries(models.judge) : []),
    ];
    for (const [key, entry] of candidates) {
      if (!accepted.includes(entry.model)) {
        throw new Error(`${provider}.${key} names unknown or retired model ${JSON.stringify(entry.model)}; accepted models: ${accepted.join(", ")}`);
      }
      const efforts = provider === "codex" ? CODEX_REASONING_EFFORTS : ["low", "medium", "high", "xhigh", "max"];
      const absentEffort = provider === "claude" && (entry.effort === undefined || entry.effort === "unavailable" && entry.mode === "off");
      if (!absentEffort && !efforts.includes(entry.effort ?? "")) {
        throw new Error(`${provider}.${key} has unsupported effort ${JSON.stringify(entry.effort)}; accepted efforts: ${efforts.join(", ")}`);
      }
      if (entry.mode !== undefined && (provider === "claude" ? entry.mode === "unavailable" : entry.mode !== "unavailable")) {
        throw new Error(`${provider}.${key} has unsupported thinking mode ${JSON.stringify(entry.mode)}`);
      }
      if (provider === "devin") {
        try { resolveDevinModel(entry.model, entry.effort, models); }
        catch (error) {
          throw new Error(`${provider}.${key}: ${error instanceof Error ? error.message : String(error)}; accepted models: ${accepted.join(", ")}; accepted efforts: ${efforts.join(", ")}`);
        }
      }
    }
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

// One parse per module/installation. Validation depends only on the pure resolver.
export const modelCatalog = loadModelCatalog(fileURLToPath(new URL("./models.default.toml", import.meta.url)));
export const { catalog, catalogDigest, path } = modelCatalog;
export const DEVIN_DEFAULT_MODEL = catalog.devin.default.model;
