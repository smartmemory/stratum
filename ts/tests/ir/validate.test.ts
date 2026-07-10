import { describe, expect, it } from "vitest";
import { validateSpec } from "../../src/ir/validate.js";
import { REVIEW_REGRESSIONS, invalidFixtures, validFixtures } from "./fixtures.js";

describe("STRAT-TS-PORT P0 IR validator", () => {
  it.each(validFixtures)("accepts $name", ({ spec }) => {
    const result = validateSpec(spec);
    expect(result.ok ? result.value.version : result.errors).toBe(1);
  });

  it("compiles declared contracts to strict Zod objects", () => {
    const result = validateSpec(validFixtures[1]!.spec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contracts.Result?.safeParse({ value: "ok", tags: ["red"] }).success).toBe(true);
    expect(result.contracts.Result?.safeParse({ value: "ok", tags: ["blue"], extra: true }).success).toBe(false);
  });

  it.each(invalidFixtures)("rejects $name", ({ spec, errors }) => {
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map(({ code, path }) => ({ code, path }))).toEqual(errors);
  });
});

describe("review regressions (P0 adversarial pass)", () => {
  it("rejects agent: none on a do task", () => {
    const r = validateSpec(REVIEW_REGRESSIONS.agentNoneOnDoRejected);
    expect(r.ok).toBe(false);
  });
  it("accepts nested typed arrays (string[][])", () => {
    const r = validateSpec(REVIEW_REGRESSIONS.nestedTypedArrayAccepted);
    expect(r.ok).toBe(true);
  });
  it("rejects reserved contract field names loudly (no zod silent drop, no pollution)", () => {
    const before = ({} as Record<string, unknown>)["done"];
    const r = validateSpec(REVIEW_REGRESSIONS.protoContractField);
    expect(({} as Record<string, unknown>)["done"]).toBe(before);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes("__proto__"))).toBe(true);
    }
  });
  it("reports every unknown field, not just the first", () => {
    const r = validateSpec(REVIEW_REGRESSIONS.multiUnknownFields);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.errors.filter((e) => e.code === "E2_UNKNOWN_FIELD").map((e) => e.path);
      expect(paths.some((p) => p.includes("bogus_a"))).toBe(true);
      expect(paths.some((p) => p.includes("bogus_b"))).toBe(true);
    }
  });
});
