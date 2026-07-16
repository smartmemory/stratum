import { describe, expect, it } from "vitest";
import { assertShape, type Shape } from "../../src/mcp/contracts.js";

describe("tagged frozen-contract shape grammar", () => {
  it("rejects non-arrays for $array", () => {
    expect(() => assertShape("not-an-array", { $array: "string" }, "payload.items"))
      .toThrow("payload.items must be an array");
  });

  it("checks every $array element and includes its index in the path", () => {
    expect(() => assertShape(["ok", 7], { $array: "string" }, "payload.items"))
      .toThrow("payload.items[1] must be string");
  });

  it("accepts an empty $array", () => {
    expect(() => assertShape([], { $array: { id: "string" } }, "payload.items"))
      .not.toThrow();
  });

  it("accepts a $oneOf value matching exactly one variant", () => {
    const shape: Shape = { $oneOf: ["string", "number"] };
    expect(() => assertShape(3, shape, "payload.choice")).not.toThrow();
  });

  it("rejects a $oneOf value matching zero variants", () => {
    const shape: Shape = { $oneOf: ["string", "number"] };
    expect(() => assertShape(false, shape, "payload.choice"))
      .toThrow(/payload\.choice.*zero.*variants matched/i);
  });

  it("rejects an ambiguous $oneOf value matching multiple variants", () => {
    const shape: Shape = { $oneOf: ["any", "string"] };
    expect(() => assertShape("ambiguous", shape, "payload.choice"))
      .toThrow(/payload\.choice.*multiple.*variants matched/i);
  });

  it("uses complete-strict record matching inside $oneOf variants", () => {
    const shape: Shape = { $oneOf: [{ kind: "string" }] };
    expect(() => assertShape({ kind: "task", extra: true }, shape, "payload.choice"))
      .toThrow(/payload\.choice.*zero.*variants matched/i);
  });

  it("honors optional fields inside $oneOf variants", () => {
    const shape: Shape = { $oneOf: [{ kind: "string", "detail?": "string" }, "null"] };
    expect(() => assertShape({ kind: "task" }, shape, "payload.choice")).not.toThrow();
    expect(() => assertShape({ kind: "task", detail: "present" }, shape, "payload.choice")).not.toThrow();
  });

  it("nests $oneOf inside $array", () => {
    const shape: Shape = { $array: { $oneOf: ["string", { count: "number" }] } };
    expect(() => assertShape(["first", { count: 2 }], shape, "payload.items")).not.toThrow();
    expect(() => assertShape(["first", { count: "two" }], shape, "payload.items"))
      .toThrow(/payload\.items\[1\].*zero.*variants matched/i);
  });

  it("nests tagged constructs in record fields", () => {
    const shape: Shape = {
      entries: { $array: "string" },
      selected: { $oneOf: ["string", "null"] },
    };
    expect(() => assertShape({ entries: ["a", "b"], selected: null }, shape, "payload"))
      .not.toThrow();
  });

  it.each([
    ["an unknown reserved tag", { $wat: "string" }],
    ["a recognized tag with an extra key", { $array: "string", extra: "number" }],
    ["a non-array $oneOf payload", { $oneOf: "string" }],
    ["an empty $oneOf payload", { $oneOf: [] }],
    ["a reserved record field", { name: "string", $foo: "string" }],
    ["an unknown leaf type", { $array: "bogus" }],
    ["an unknown leaf union member", { value: "string|bogus" }],
    ["required and optional forms of the same field", { x: "string", "x?": "number" }],
  ])("rejects malformed shapes containing %s", (_case, malformed) => {
    expect(() => assertShape({}, malformed as unknown as Shape, "payload"))
      .toThrow(/malformed shape at payload/i);
  });
});
