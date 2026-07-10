import { describe, expect, it } from "vitest";
import { baseModel, MODEL_PRICING, usdFromTokens } from "../../src/judge/pricing.js";

describe("judge pricing", () => {
  it.each([
    ["gpt-5.3-codex-spark/low", "gpt-5.3-codex-spark"],
    ["gpt-5.6-terra/high", "gpt-5.6-terra"],
    ["gpt-5.6-sol/high", "gpt-5.6-sol"],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
  ])("normalizes %s", (model, expected) => expect(baseModel(model)).toBe(expected));

  it("ships only the three P2 judge tiers", () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual(["gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  it("prices input and output independently", () => {
    expect(usdFromTokens("gpt-5.3-codex-spark/low", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.00875, 10);
  });

  it("returns zero for an unknown model or invalid counts", () => {
    expect(usdFromTokens("unknown", { inputTokens: 100, outputTokens: 100 })).toBe(0);
    expect(usdFromTokens("gpt-5.6-sol/high", { inputTokens: -1, outputTokens: Number.NaN })).toBe(0);
  });
});
