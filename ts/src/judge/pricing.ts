import { modelIdentity } from "../connectors/base.js";

export interface ModelPricing {
  input: number;
  output: number;
  /** USD per MTok for cached input. Every priced model here bills cache reads at 0.1x input. */
  cacheRead: number;
}

/**
 * Approximate USD per one million tokens.
 *
 * VERIFIED 2026-09-12 against the LiteLLM community registry
 * (github.com/BerriAI/litellm, model_prices_and_context_window.json) and OpenAI's
 * published rate card. The previous figures were STALE by two price cuts: terra fell
 * to 2/12 on 2026-07-30 and sol to a promotional 4/20 on 2026-08-21, so this table
 * had been overstating both by 20-33%.
 *
 * PROMOTIONAL RATE: sol's 4/20 is a promotion OpenAI has stated runs at least through
 * 2026-11-21. Re-check it against the registry on or after that date.
 *
 * cacheRead is 0.1x input, confirmed against the registry's cache_read_input_token_cost
 * for astra, sol, terra and luna. SPARK'S CACHE RATE IS INFERRED, not confirmed: the
 * registry carries spark only as a subscription-billed entry (`chatgpt/gpt-5.3-codex-spark`,
 * no cost fields), so both its 1.75/14 and its 0.175 cache rate are inherited/derived and
 * have no external source. The discount matters: a real astra run observed 13.25M cached of
 * 13.47M total input tokens, so ignoring it overstates that call by roughly 10x.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "gpt-5.3-codex-spark": { input: 1.75, output: 14, cacheRead: 0.175 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2 },
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4 },
  // Source: OpenAI 2026-09-22 announcement; not yet checked against LiteLLM.
  // cacheRead is INFERRED at 0.1x input for these two models.
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1 },
});

/** Retired upstream 2026-09-16; retained in MODEL_PRICING for historical usage. */
export const RETIRED_MODELS: ReadonlySet<string> = new Set(["gpt-5.3-codex-spark"]);

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
  const pricing = MODEL_PRICING[baseModel(model)];
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
