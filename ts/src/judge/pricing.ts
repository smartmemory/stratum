import { catalog, type ModelCatalog } from "../config/models.js";
import { modelIdentity } from "../connectors/base.js";

export interface ModelPricing {
  input: number;
  output: number;
  /** USD per MTok for cached input; the discount varies by model. */
  cacheRead: number;
}

/** Approximate USD/MTok; provenance lives beside the shipped price rows. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = pricingAdapter(catalog.pricing.codex);
export const RETIRED_MODELS: ReadonlySet<string> = new Set(catalog.retired.codex);
export const DEVIN_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = pricingAdapter(catalog.pricing.devin);

function pricingAdapter(rows: ModelCatalog["pricing"]["codex"]): Readonly<Record<string, ModelPricing>> {
  return Object.freeze(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id,
    Object.freeze({ input: row.input, output: row.output, cacheRead: row.cache_read }),
  ])));
}

export function dispatchableModels(): string[] {
  return Object.keys(MODEL_PRICING).filter((model) => !RETIRED_MODELS.has(model)).sort();
}

export interface PricedTokenUsage {
  inputTokens?: number;
  /** Cached portion of inputTokens, NOT additional to it. Billed at the cacheRead rate. */
  cachedInputTokens?: number;
  outputTokens?: number;
}

export function baseModel(model: string): string {
  return modelIdentity(model).model;
}

/**
 * Estimate USD for a call from its token counts.
 *
 * Returns 0 for an unknown model. Callers must treat 0 as "cannot price", NOT as
 * "free": emitting a zero cost as though it were reported is what made an unpriced
 * Codex call look like a free one. The codex connector therefore omits usd entirely
 * when this returns 0, so the consumer records unknown cost rather than a false zero.
 */
export function usdFromTokens(model: string, usage: PricedTokenUsage): number {
  return usdFromTable(MODEL_PRICING[baseModel(model)], usage);
}

/**
 * The devin counterpart of usdFromTokens, priced from DEVIN_MODEL_PRICING
 * (STRAT-AGENT-DEVIN-1 D6). Every dispatched devin id is in the table by
 * construction — a 0 here is a real "free", so the connector reports
 * `usd: 0` labelled `estimated` (a price-table fact), unlike codex whose
 * unpriced models must stay cost-unknown.
 */
export function devinUsdFromTokens(model: string, usage: PricedTokenUsage): number {
  return usdFromTable(DEVIN_MODEL_PRICING[baseModel(model)] ?? { input: 0, output: 0, cacheRead: 0 }, usage);
}

function usdFromTable(pricing: ModelPricing | undefined, usage: PricedTokenUsage): number {
  if (!pricing) return 0;
  const input = validCount(usage.inputTokens);
  const output = validCount(usage.outputTokens);
  // cachedInputTokens is a SUBSET of inputTokens, so bill the uncached remainder at
  // the full rate and the cached portion at the discounted rate. Clamped because a
  // provider reporting cached > input must never produce a negative charge.
  const cached = Math.min(validCount(usage.cachedInputTokens), input);
  const uncached = Math.max(0, input - cached);
  return (uncached * pricing.input + cached * pricing.cacheRead + output * pricing.output) / 1_000_000;
}

function validCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
