import { describe, expect, it } from "vitest";
import { extractReferences, referenceEdges } from "../../src/ir/refs.js";

describe("IR references", () => {
  it("parses output paths and distinguishes typed references from interpolation", () => {
    const full = extractReferences("${build.output.items[0].name}");
    const embedded = extractReferences("Review ${build.output.items[0].name}");

    expect(full).toEqual([{ raw: "${build.output.items[0].name}", fullValue: true, reference: { kind: "step", stepId: "build", path: ["items", 0, "name"] } }]);
    expect(embedded?.[0]?.fullValue).toBe(false);
    expect(referenceEdges("check", full ?? [])).toEqual([{ from: "build", to: "check" }]);
  });

  it("rejects malformed references", () => {
    expect(extractReferences("${input.bad-name}")).toBeUndefined();
    expect(extractReferences("${missing")).toBeUndefined();
  });
});
