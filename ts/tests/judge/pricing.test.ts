import { describe, expect, it } from "vitest";
import { baseModel, dispatchableModels, RETIRED_MODELS, MODEL_PRICING, usdFromTokens } from "../../src/judge/pricing.js";

describe("judge pricing", () => {
  it.each([
    ["gpt-5.3-codex-spark/low", "gpt-5.3-codex-spark"],
    ["gpt-5.6-terra/high", "gpt-5.6-terra"],
    ["gpt-5.6-sol/high", "gpt-5.6-sol"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
    ["gpt-6-astra/high", "gpt-6-astra"],
  ])("normalizes %s", (model, expected) => expect(baseModel(model)).toBe(expected));

  // This table stopped being a judge-tier list on 2026-09-12: the codex connector now
  // prices its own calls from it, because Codex reports no cost of its own and an
  // unpriced model reaches a consumer as cost-unknown. Tier SELECTION still lives in
  // judged.ts (JUDGE_TIERS cheap/default/paranoid), so extra entries here widen what can
  // be priced, never what the judge may route to. Assert the judge tiers are all present
  // and priced rather than pinning the table closed.
  it("prices every judge tier", () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-astra"]) {
      expect(usdFromTokens(model, { inputTokens: 1_000, outputTokens: 1_000 })).toBeGreaterThan(0);
    }
  });

  it("prices every model the codex connector may dispatch, so none reaches a consumer cost-unknown", () => {
    for (const model of dispatchableModels()) {
      expect(usdFromTokens(model, { inputTokens: 1_000, outputTokens: 1_000 })).toBeGreaterThan(0);
    }
  });

  // Cached input bills at 0.1x, confirmed per-model against the LiteLLM registry. It is
  // not a rounding detail: a real astra run carried 13.25M cached of 13.47M input tokens,
  // so ignoring the discount overstates that call by roughly 10x.
  it("bills cached input at the discounted rate, and never below zero", () => {
    const full = usdFromTokens("gpt-6-astra", { inputTokens: 1_000_000, outputTokens: 0 });
    const cached = usdFromTokens("gpt-6-astra", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
    expect(full).toBeCloseTo(10, 10);
    expect(cached).toBeCloseTo(1, 10);
    // cached > input must clamp, never produce a negative charge
    expect(usdFromTokens("gpt-6-astra", { inputTokens: 10, cachedInputTokens: 999, outputTokens: 0 })).toBeGreaterThanOrEqual(0);
  });

  it("prices input and output independently", () => {
    expect(usdFromTokens("gpt-5.3-codex-spark/low", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.00875, 10);
    expect(usdFromTokens("gpt-6-astra/high", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.035, 10);
    // terra at its VERIFIED post-2026-07-30 rate (2/12): 1_000*2 + 500*12 per MTok
    expect(usdFromTokens("gpt-5.6-terra/high", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.008, 10);
  });

  it("returns zero for an unknown model or invalid counts", () => {
    expect(usdFromTokens("unknown", { inputTokens: 100, outputTokens: 100 })).toBe(0);
    expect(usdFromTokens("gpt-5.6-sol/high", { inputTokens: -1, outputTokens: Number.NaN })).toBe(0);
  });
});

it("prices new models and excludes only retired models from dispatch", () => {
  expect(MODEL_PRICING["gpt-6-sol"]).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
  expect(MODEL_PRICING["gpt-6-luna"]).toEqual({ input: 0.1, output: 0.5, cacheRead: 0.01 });
  expect(RETIRED_MODELS.has("gpt-5.3-codex-spark")).toBe(true);
  expect(dispatchableModels()).toEqual(Object.keys(MODEL_PRICING).filter(id => !RETIRED_MODELS.has(id)).sort());
  expect(dispatchableModels()).not.toContain("gpt-5.3-codex-spark");
});
