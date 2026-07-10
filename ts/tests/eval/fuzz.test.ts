import { describe, expect, it } from "vitest";
import { evaluateExpression, evaluatePredicate } from "../../src/eval/expr.js";

const data = JSON.parse('{"safe":true,"__proto__":{"polluted":true},"constructor":"owned","prototype":"owned"}') as unknown;

describe("hostile expression fuzz corpus", () => {
  it.each([
    "result.__proto__",
    "result.constructor",
    "result.prototype",
    "result['__proto__']",
    "result[\"constructor\"]",
    "'__proto__' in result",
    "constructor(result)",
    "result.safe.__proto__",
    "\"unterminated",
    "'unterminated",
    "\"bad\\xescape\"",
    "matches(result.attack, '(a+)+$')",
    "matches(result.attack, '((a+))+$')",
    "matches(result.attack, '(a|aa)+$')",
    "matches(result.attack, '(?=a)a')",
    "matches(result.attack, '\\\\1')",
    "matches(result.attack, '^a*a*a*a*a*a*a*a*b$')",
    "matches(result.attack, 'a*a+b$')",
    "matches(result.attack, '[ab]+a?b$')",
    "matches(result.attack, '(ab)*(ab)*c$')",
    "matches(result.attack, 'a{0,99}a*b$')",
    "matches(result.attack, '.*.*x$')",
    "file_exists('../../etc/passwd')",
    "file_contains('a/../../secret', 'x')",
    "(()",
    ")))",
    "result?.safe",
    "result.safe.toString()",
  ])("fails closed without throwing: %s", (expression) => {
    expect(() => evaluateExpression(expression, { result: { attack: `${"a".repeat(4096)}!` } }, { workspaceRoot: "/tmp" })).not.toThrow();
    expect(evaluatePredicate(expression, { result: { attack: `${"a".repeat(4096)}!` } }, { workspaceRoot: "/tmp" }).holds).toBe(false);
  });

  it.each([
    "^a*a*b$",
    "a*a+b",
    "[ab]+a?b",
    "(ab)*(ab)*c",
    "a{0,99}a*b",
    ".*.*x",
    "(a*)(a*)b",
    "a*(a*)b",
  ])("rejects sequential overlapping quantifiers outright: %s", (pattern) => {
    const outcome = evaluateExpression(`matches('aab', ${JSON.stringify(pattern)})`, {});
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringContaining("unsafe construct") });
  });

  it.each([
    "^A[a-z]+$",
    "^[a-z]{4}$",
    "^v[0-9.]+$",
    "a*ba+",
    "(foo|bar)baz",
    ".*error.*",
  ])("still accepts safe patterns: %s", (pattern) => {
    const outcome = evaluateExpression(`matches('aab', ${JSON.stringify(pattern)})`, {});
    expect(outcome).toMatchObject({ ok: true });
  });

  it("never exposes hostile own properties parsed from JSON", () => {
    for (const expression of ["result.__proto__", "result.constructor", "result.prototype", "'__proto__' in result"]) {
      const outcome = evaluateExpression(expression, { result: data });
      expect(outcome).toMatchObject({ ok: false });
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("bounds deeply nested expressions", () => {
    const expression = `${"(".repeat(300)}true${")".repeat(300)}`;
    expect(() => evaluateExpression(expression, {})).not.toThrow();
    expect(evaluateExpression(expression, {})).toMatchObject({ ok: false, reason: expect.stringMatching(/^resource_limit:/u) });
  });

  it("rejects non-JSON prototypes and cycles as structured failures", () => {
    const custom = Object.create({ inherited: true }) as Record<string, unknown>;
    custom.own = true;
    expect(evaluateExpression("result.own", { result: custom })).toMatchObject({ ok: false, reason: expect.stringMatching(/^type_error:/u) });

    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(evaluateExpression("result.self", { result: cycle })).toMatchObject({ ok: false, reason: expect.stringMatching(/^type_error:/u) });
  });
});
