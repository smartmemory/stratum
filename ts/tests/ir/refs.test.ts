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

  it("parses a bare carry reference and gives it no edge", () => {
    expect(extractReferences("${wave}")).toEqual([
      { raw: "${wave}", fullValue: true, reference: { kind: "carry", name: "wave", path: [] } },
    ]);
    const withPath = extractReferences("${wave.tasks[0].id}");
    expect(withPath?.[0]?.reference).toEqual({ kind: "carry", name: "wave", path: ["tasks", 0, "id"] });
    expect(referenceEdges("fan", withPath ?? [])).toEqual([]);
    expect(referenceEdges("fan", extractReferences("${wave}") ?? [])).toEqual([]);
  });

  it("reserves only the exact output segment", () => {
    expect(extractReferences("${wave.output}")?.[0]?.reference).toEqual({ kind: "step", stepId: "wave", path: [] });
    expect(extractReferences("${wave.output.tasks}")?.[0]?.reference).toEqual({ kind: "step", stepId: "wave", path: ["tasks"] });
    expect(extractReferences("${wave.outputValue}")?.[0]?.reference).toEqual({ kind: "carry", name: "wave", path: ["outputValue"] });
    expect(extractReferences("${wave.outputs}")?.[0]?.reference).toEqual({ kind: "carry", name: "wave", path: ["outputs"] });

    // regressions
    expect(extractReferences("${build.output.items[0].name}")?.[0]?.reference).toEqual({ kind: "step", stepId: "build", path: ["items", 0, "name"] });
    expect(extractReferences("${input.bad-name}")).toBeUndefined();
    expect(extractReferences("${Foo.output}")).toBeUndefined();
    expect(extractReferences("${my-wave}")?.[0]?.reference).toEqual({ kind: "carry", name: "my-wave", path: [] });
  });
});
