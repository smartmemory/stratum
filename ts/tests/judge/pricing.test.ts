import { describe, expect, it, vi } from "vitest";
import { baseModel, dispatchableModels, RETIRED_MODELS, MODEL_PRICING, DEVIN_MODEL_PRICING, usdFromTokens, devinUsdFromTokens } from "../../src/judge/pricing.js";
import { DEVIN_DEFAULT_MODEL } from "../../src/connectors/devin-model.js";

describe("synthetic catalog pricing adapters", () => {
  it("maps independent price rows and cache_read to cacheRead", () => {
    expect(MODEL_PRICING).toEqual({
      "test-codex-a": { input: 3, output: 11, cacheRead: 0.25 },
      "test-codex-b": { input: 2, output: 7, cacheRead: 0.2 },
      "test-codex-c": { input: 5, output: 17, cacheRead: 0.5 },
      "test-codex-retired": { input: 9, output: 21, cacheRead: 0.1 },
    });
    expect(DEVIN_MODEL_PRICING["test-claude-b-high"]).toEqual({ input: 4, output: 20, cacheRead: 0.4 });
    expect(DEVIN_MODEL_PRICING["test-claude-b-low-fast"]).toEqual({ input: 8, output: 40, cacheRead: 0.8 });
    expect(DEVIN_DEFAULT_MODEL).toBe("test-devin-high");
    expect(Object.isFrozen(MODEL_PRICING)).toBe(true);
    expect(Object.isFrozen(MODEL_PRICING["test-codex-a"])).toBe(true);
  });

  it("keeps retired ids priceable while excluding them and Devin from dispatch", () => {
    expect([...RETIRED_MODELS]).toEqual(["test-codex-retired"]);
    expect(dispatchableModels()).toEqual(["test-codex-a", "test-codex-b", "test-codex-c"]);
    expect(usdFromTokens("test-codex-retired/low", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.0195, 10);
  });

  it.each([
    ["test-codex-a/high", "test-codex-a"],
    ["test-codex-retired/low", "test-codex-retired"],
    ["test-codex-b", "test-codex-b"],
  ])("normalizes %s", (model, expected) => expect(baseModel(model)).toBe(expected));

  it.each([
    ["test-codex-a/high", 0.0085],
    ["test-codex-b/low", 0.0055],
    ["test-codex-c/medium", 0.0135],
  ])("prices independent input/output rates for %s", (model, expected) => {
    expect(usdFromTokens(model, { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(expected, 10);
  });

  it("bills cached input as a subset and clamps excess cached counts", () => {
    expect(usdFromTokens("test-codex-a", { inputTokens: 1_000_000 })).toBe(3);
    expect(usdFromTokens("test-codex-a", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 })).toBe(0.25);
    expect(usdFromTokens("test-codex-a/high", { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 })).toBeCloseTo(2.725, 10);
    expect(usdFromTokens("test-codex-c", { inputTokens: 10, cachedInputTokens: 999 })).toBeCloseTo(0.000005, 10);
  });

  it("prices Devin independently, including free and fast serving rows", () => {
    expect(devinUsdFromTokens("test-devin-high", { inputTokens: 1_000, outputTokens: 500 })).toBe(0);
    expect(devinUsdFromTokens("test-claude-b-high", { inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 500 })).toBeCloseTo(0.01184, 10);
    expect(devinUsdFromTokens("test-claude-b-low-fast", { inputTokens: 1_000, outputTokens: 500 })).toBeCloseTo(0.028, 10);
    expect(usdFromTokens("test-claude-b-high", { inputTokens: 1_000 })).toBe(0);
  });

  it("returns zero for unknown models, missing counts and invalid counts", () => {
    expect(usdFromTokens("unknown", { inputTokens: 100, outputTokens: 100 })).toBe(0);
    expect(usdFromTokens("test-codex-a", {})).toBe(0);
    expect(usdFromTokens("test-codex-a", { inputTokens: -1, outputTokens: Number.NaN, cachedInputTokens: Infinity })).toBe(0);
    expect(usdFromTokens("test-codex-a", { inputTokens: 1_000, cachedInputTokens: -1, outputTokens: Infinity })).toBeCloseTo(0.003, 10);
  });
});

// Inject synthetic bytes into the real singleton loader, preserving every adapter.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { fileURLToPath } = await import("node:url");
  const shipped = fileURLToPath(new URL("../../src/config/models.default.toml", import.meta.url));
  const fixture = fileURLToPath(new URL("../fixtures/models.synthetic.toml", import.meta.url));
  return { ...actual, readFileSync: new Proxy(actual.readFileSync, {
    apply(target, receiver, args) {
      if (args[0] === shipped) args[0] = fixture;
      return Reflect.apply(target, receiver, args);
    },
  }) };
});
