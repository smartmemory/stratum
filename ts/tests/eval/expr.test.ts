import { describe, expect, it } from "vitest";
import { createEvaluator, evaluateExpression, evaluatePredicate, type ExpressionBindings, type JsonValue } from "../../src/eval/expr.js";

const bindings: ExpressionBindings = {
  result: {
    verdict: "pass",
    count: 4,
    ratio: 2.5,
    active: true,
    empty: "",
    tags: ["ts", "safe", "fast"],
    nums: [3, 1, 9, 2],
    flags: [true, false, true],
    mixed: [0, "", null, 2],
    obj: { own: "yes", nested: { value: 7 } },
  },
  input: { name: "Ada", limit: 5, enabled: false },
  item: { id: 3, label: "work" },
  prev: { score: 8, values: [10, 20] },
};

interface PredicateCase { name: string; expression: string; expected: JsonValue }

const predicateCases: PredicateCase[] = [
  { name: "null literal", expression: "null", expected: null },
  { name: "true literal", expression: "true", expected: true },
  { name: "false literal", expression: "false", expected: false },
  { name: "integer literal", expression: "42", expected: 42 },
  { name: "decimal literal", expression: "2.5", expected: 2.5 },
  { name: "exponent literal", expression: "1e3", expected: 1000 },
  { name: "double quoted string", expression: "\"pass\"", expected: "pass" },
  { name: "single quoted string", expression: "'pass'", expected: "pass" },
  { name: "escaped string", expression: "\"a\\nb\"", expected: "a\nb" },
  { name: "unicode string", expression: "\"\\u0041\"", expected: "A" },
  { name: "result member", expression: "result.verdict", expected: "pass" },
  { name: "input member", expression: "input.name", expected: "Ada" },
  { name: "item member", expression: "item.id", expected: 3 },
  { name: "prev member", expression: "prev.score", expected: 8 },
  { name: "nested member", expression: "result.obj.nested.value", expected: 7 },
  { name: "array first index", expression: "result.tags[0]", expected: "ts" },
  { name: "array last index", expression: "result.tags[2]", expected: "fast" },
  { name: "nested array index", expression: "prev.values[1]", expected: 20 },
  { name: "numeric equality", expression: "result.count == 4", expected: true },
  { name: "numeric inequality", expression: "result.count != 5", expected: true },
  { name: "string equality", expression: "result.verdict == 'pass'", expected: true },
  { name: "null equality", expression: "null == null", expected: true },
  { name: "cross type inequality", expression: "1 != '1'", expected: true },
  { name: "less than", expression: "result.count < input.limit", expected: true },
  { name: "less equal", expression: "result.count <= 4", expected: true },
  { name: "greater than", expression: "prev.score > input.limit", expected: true },
  { name: "greater equal", expression: "prev.score >= 8", expected: true },
  { name: "string comparison", expression: "'alpha' < 'beta'", expected: true },
  { name: "and true", expression: "result.active && result.count == 4", expected: true },
  { name: "and short circuit", expression: "false && missing.value", expected: false },
  { name: "or true", expression: "input.enabled || result.active", expected: true },
  { name: "or short circuit", expression: "true || missing.value", expected: true },
  { name: "logical not", expression: "!input.enabled", expected: true },
  { name: "double logical not", expression: "!!result.active", expected: true },
  { name: "number addition", expression: "result.count + input.limit", expected: 9 },
  { name: "string concatenation", expression: "input.name + ' Lovelace'", expected: "Ada Lovelace" },
  { name: "subtraction", expression: "input.limit - result.count", expected: 1 },
  { name: "multiplication", expression: "result.count * 3", expected: 12 },
  { name: "division", expression: "result.count / 2", expected: 2 },
  { name: "unary minus", expression: "-result.count", expected: -4 },
  { name: "arithmetic precedence", expression: "2 + 3 * 4", expected: 14 },
  { name: "parenthesized precedence", expression: "(2 + 3) * 4", expected: 20 },
  { name: "comparison precedence", expression: "2 + 3 == 5 && true", expected: true },
  { name: "array membership", expression: "'safe' in result.tags", expected: true },
  { name: "array nonmembership", expression: "'missing' in result.tags", expected: false },
  { name: "string membership", expression: "'da' in input.name", expected: true },
  { name: "object own membership", expression: "'own' in result.obj", expected: true },
  { name: "object absent membership", expression: "'toString' in result.obj", expected: false },
  { name: "len string", expression: "len(input.name)", expected: 3 },
  { name: "len array", expression: "len(result.tags)", expected: 3 },
  { name: "len object", expression: "len(result.obj)", expected: 2 },
  { name: "any true", expression: "any(result.flags)", expected: true },
  { name: "any false", expression: "any(prev.values) == true", expected: true },
  { name: "all false", expression: "all(result.flags)", expected: false },
  { name: "all true", expression: "all(prev.values)", expected: true },
  { name: "max number array", expression: "max(result.nums)", expected: 9 },
  { name: "min number array", expression: "min(result.nums)", expected: 1 },
  { name: "max string array", expression: "max(result.tags)", expected: "ts" },
  { name: "min string array", expression: "min(result.tags)", expected: "fast" },
  { name: "str number", expression: "str(result.count)", expected: "4" },
  { name: "str boolean", expression: "str(result.active)", expected: "true" },
  { name: "str null", expression: "str(null)", expected: "null" },
  { name: "str object", expression: "str(result.obj)", expected: '{"own":"yes","nested":{"value":7}}' },
  { name: "int string", expression: "int('17')", expected: 17 },
  { name: "int decimal", expression: "int(result.ratio)", expected: 2 },
  { name: "int boolean", expression: "int(true)", expected: 1 },
  { name: "bool zero", expression: "bool(0)", expected: false },
  { name: "bool nonempty", expression: "bool(result.tags)", expected: true },
  { name: "bool null", expression: "bool(null)", expected: false },
  { name: "matches anchored", expression: "matches(input.name, '^A[a-z]+$')", expected: true },
  { name: "matches character class", expression: "matches(result.verdict, '^[a-z]{4}$')", expected: true },
  { name: "matches false", expression: "matches(input.name, '^Z')", expected: false },
  { name: "nested function", expression: "int(str(result.count))", expected: 4 },
  { name: "compound ensure", expression: "len(result.tags) == 3 && max(result.nums) >= 9", expected: true },
];

describe("locked expression grammar table", () => {
  it("contains at least 60 independent rows", () => expect(predicateCases.length).toBeGreaterThanOrEqual(60));

  it.each(predicateCases)("$name", ({ expression, expected }) => {
    expect(evaluateExpression(expression, bindings)).toEqual({ ok: true, value: expected });
  });
});

describe("structured predicate failures", () => {
  it.each([
    ["unknown identifier", "missing == 1", "unknown_identifier:"],
    ["unknown function", "upper(input.name)", "unknown_function:"],
    ["nonboolean and", "1 && true", "type_error:"],
    ["nonboolean not", "!1", "type_error:"],
    ["mixed addition", "1 + 'x'", "type_error:"],
    ["mixed comparison", "1 < '2'", "type_error:"],
    ["division by zero", "1 / 0", "type_error:"],
    ["missing member", "result.absent", "type_error:"],
    ["member on array", "result.tags.length", "type_error:"],
    ["index on object", "result.obj[0]", "type_error:"],
    ["index out of bounds", "result.tags[9]", "type_error:"],
    ["dynamic index", "result.tags[input.limit]", "parse_error:"],
    ["string index", "result.tags['0']", "parse_error:"],
    ["negative index", "result.tags[-1]", "parse_error:"],
    ["empty max", "max(item.missing)", "type_error:"],
    ["wrong len arity", "len(input.name, result.tags)", "type_error:"],
    ["bad int", "int('2x')", "type_error:"],
    ["bad regex", "matches(input.name, '[')", "validation_error:"],
    ["file root missing", "file_exists('x')", "validation_error:"],
    ["empty expression", "", "parse_error:"],
    ["array literal addition", "[1]", "parse_error:"],
    ["object literal addition", "{x: 1}", "parse_error:"],
    ["ternary addition", "true ? 1 : 2", "parse_error:"],
    ["modulo addition", "4 % 2", "parse_error:"],
    ["assignment addition", "result.count = 4", "parse_error:"],
  ])("returns a reason for %s", (_name, expression, prefix) => {
    const result = evaluateExpression(expression, bindings);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(new RegExp(`^${prefix}`));
  });

  it("requires predicates to return booleans", () => {
    expect(evaluatePredicate("result.count", bindings)).toEqual({
      holds: false,
      reason: "type_error: predicate must evaluate to boolean, received number",
    });
  });

  it("reports an ordinary false predicate without throwing", () => {
    expect(evaluatePredicate("result.count > 100", bindings)).toEqual({ holds: false, reason: "predicate evaluated to false" });
  });
});

describe("P1 Evaluator adapter", () => {
  it("binds engine input and completed steps through input/result", () => {
    const evaluator = createEvaluator();
    const context = { input: { enabled: true }, steps: { build: { done: true } } };
    expect(evaluator.evaluate("input.enabled && result.build.done", context)).toBe(true);
  });

  it("fails closed and never throws into the engine", () => {
    const evaluator = createEvaluator();
    expect(() => evaluator.evaluate("unknown()", { input: null, steps: {} })).not.toThrow();
    expect(evaluator.evaluate("unknown()", { input: null, steps: {} })).toBe(false);
  });
});
