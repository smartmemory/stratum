import { catalog } from "../helpers/models.js";
import { describe, expect, it } from "vitest";
import { evaluateJudged } from "../../src/judge/judged.js";

describe("live judged predicate", () => {
  const live = process.env.OPENAI_API_KEY ? it : it.skip;

  live("runs one cheap-stakes AI SDK judgment", async () => {
    const result = await evaluateJudged(
      { statement: "The result value equals the input expected value.", stakes: "cheap" },
      { result: { value: 2 }, input: { expected: 2 } },
    );
    expect(result).toMatchObject({ holds: true, stakes: "cheap", model: `${catalog.judge.cheap.model}/${catalog.judge.cheap.effort}` });
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.usage.tokens).toBeGreaterThan(0);
  }, 60_000);
});
