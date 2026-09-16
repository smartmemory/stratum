import { describe, expect, it } from "vitest";
import { evaluateJudged } from "../../src/judge/judged.js";

describe("live judged predicate", () => {
  const live = process.env.OPENAI_API_KEY ? it : it.skip;

  live("runs one cheap-stakes AI SDK judgment", async () => {
    const result = await evaluateJudged(
      { statement: "The result value equals the input expected value.", stakes: "cheap" },
      { result: { value: 2 }, input: { expected: 2 } },
    );
    expect(result).toMatchObject({ holds: true, stakes: "cheap", model: "gpt-5.6-terra/low" });
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.usage.tokens).toBeGreaterThan(0);
  }, 60_000);
});
