import type { ModelCatalog } from "./models.js";

/** Sorted list of accepted devin model ids — the pricing table's keys. */
export function devinModelIds(models: ModelCatalog): string[] {
  return Object.keys(models.pricing.devin).filter(id => !models.retired.devin.includes(id)).sort();
}

/**
 * Family → accepted effort suffixes, derived from the pricing ids (D6: the
 * table must not be hand-listed twice). A suffixed id yields its family and
 * effort. A derived "family" that is itself a priced id (for example one
 * surfaced by the -fast serving variants) is a full id,
 * not a family — those rows stay dispatchable only by their full id.
 */
export function devinModelFamilies(models: ModelCatalog): ReadonlyMap<string, readonly string[]> {
  const ids = devinModelIds(models);
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

/** Resolved devin execution identity for telemetry (D6): the dispatched id
 *  plus its effort suffix within the family, as codex reports model/effort. */
export function devinModelIdentity(modelId: string, models: ModelCatalog): { model: string; effort?: string } {
  const effort = effortOf(modelId, devinModelFamilies(models));
  return effort === undefined ? { model: modelId } : { model: modelId, effort };
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
 * the stratum slash form (`swe-2/high`). Default comes from the supplied catalog.
 * Unknown ids, unknown effort for a family, and a full id plus a conflicting
 * effort are rejected naming the valid set.
 */
export function resolveDevinModel(model: string | undefined, effort: string | undefined, models: ModelCatalog): string {
  const ids = devinModelIds(models);
  const families = devinModelFamilies(models);
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
    const defaultModel = models.devin.default.model;
    const dash = defaultModel.lastIndexOf("-");
    base = defaultModel.slice(0, dash);
    requestedEffort ??= models.devin.default.effort;
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

