import { describe, expect, it } from "vitest";
import { guardChecksum } from "../../src/guard/fingerprint.js";
import { SpecificationSchema, type Specification } from "../../src/ir/schema.js";
import {
  bundleIdForRules,
  guardEdgePredicatesFor,
  mergeBundleIntoSpec,
  validateBundle,
} from "../../src/policy/bundle.js";
import type { PolicyBundle, Rule, Source } from "../../src/policy/types.js";

const source: Source = {
  record_id: "decision-1",
  memory_type: "decision",
  version: 2,
  content_hash: "a".repeat(64),
  chain_hash: "b".repeat(64),
  workspace_id: "workspace-1",
};

function makeBundle(rules: Rule[], overrides: Partial<PolicyBundle> = {}): PolicyBundle {
  return {
    bundle_id: bundleIdForRules(rules),
    workspace_id: "workspace-1",
    compiled_at: "2026-08-21T00:00:00.000Z",
    selector: { status: ["active"] },
    rules,
    ...overrides,
  };
}

const spec: Specification = SpecificationSchema.parse({
  version: 1,
  contracts: { Result: { ok: "boolean" } },
  flows: {
    entry: "main",
    main: {
      input: {},
      output: { from: "${finish.output}", contract: "Result" },
      steps: [
        { id: "build-one", do: "build", out: "Result", ensure: [{ expr: "true" }] },
        { id: "finish", do: "finish", out: "Result" },
        { id: "approval", gate: { on_approve: null, on_revise: null, on_kill: null } },
      ],
    },
  },
});

describe("validateBundle", () => {
  const rule: Rule = {
    rule_id: "decision-1#0",
    source,
    bind: { kind: "ensure" },
    predicate: { expr: "result.ok == true" },
    on_fail: "refuse",
  };

  it("accepts a contract-shaped active bundle", () => {
    expect(validateBundle(makeBundle([rule]))).toEqual(makeBundle([rule]));
  });

  it("refuses a mismatched bundle_id and a non-active selector", () => {
    expect(() => validateBundle({ ...makeBundle([rule]), bundle_id: "0".repeat(64) })).toThrow(/bundle_id mismatch/);
    expect(() => validateBundle({ ...makeBundle([rule]), selector: { status: ["superseded"] } })).toThrow();
  });

  it("refuses guard-edge expr predicates because P1 cannot evaluate them", () => {
    const guardRule: Rule = {
      ...rule,
      bind: { kind: "guard_edge" },
    };
    expect(() => validateBundle(makeBundle([guardRule])))
      .toThrow("guard-edge expr predicates are not evaluable in P1; use judged/file_exists/file_contains");
  });

  it("refuses guard-edge gate routing because it is deferred to P3", () => {
    const guardRule: Rule = {
      ...rule,
      bind: { kind: "guard_edge" },
      predicate: { file_exists: "proof.txt" },
      on_fail: "gate",
    };
    expect(() => validateBundle(makeBundle([guardRule])))
      .toThrow(/guard-edge.*on_fail.*gate.*P3/);
  });

  it.each(["record_id", "version", "content_hash", "chain_hash", "workspace_id"] as const)(
    "refuses a source missing %s",
    (field) => {
      const incomplete = structuredClone(rule) as unknown as { source: Record<string, unknown> };
      delete incomplete.source[field];
      expect(() => validateBundle(makeBundle([incomplete as unknown as Rule]))).toThrow();
    },
  );
});

describe("mergeBundleIntoSpec", () => {
  it("applies a glob and the default wildcard with aligned appended indices", () => {
    const rules: Rule[] = [
      { rule_id: "decision-1#0", source, bind: { kind: "ensure", step_selector: "build-*" }, predicate: { file_exists: "proof.txt" }, on_fail: "refuse" },
      { rule_id: "decision-1#1", source, bind: { kind: "ensure" }, predicate: { judged: { statement: "approved", stakes: "default" } }, on_fail: "gate" },
    ];
    const merged = mergeBundleIntoSpec(spec, makeBundle(rules));
    expect(() => SpecificationSchema.parse(merged.spec)).not.toThrow();
    const flow = merged.spec.flows.main;
    if (typeof flow === "string" || flow === undefined) throw new Error("missing flow");
    expect(flow.steps[0]?.ensure).toEqual([
      { expr: "true" },
      { file_exists: "proof.txt" },
      { judged: { statement: "approved", stakes: "default" } },
    ]);
    expect(flow.steps[1]?.ensure).toEqual([{ judged: { statement: "approved", stakes: "default" } }]);
    expect(flow.steps[2]?.ensure).toBeUndefined();
    expect(merged.policy_rules).toEqual({
      "main/build-one": [
        { ensure_index: 1, rule_id: "decision-1#0", source, step_selector: "build-*", on_fail: "refuse" },
        { ensure_index: 2, rule_id: "decision-1#1", source, step_selector: "*", on_fail: "gate" },
      ],
      "main/finish": [{ ensure_index: 0, rule_id: "decision-1#1", source, step_selector: "*", on_fail: "gate" }],
    });
    expect(spec.flows.main).not.toEqual(flow);
  });

  it("narrows default selectors and keeps narrower rule selectors in policy_rules", () => {
    const rules: Rule[] = [
      { rule_id: "decision-1#0", source, bind: { kind: "ensure" }, predicate: { expr: "result.ok == true" }, on_fail: "refuse" },
      { rule_id: "decision-1#1", source, bind: { kind: "ensure", step_selector: "finish" }, predicate: { expr: "result.ok == true" }, on_fail: "refuse" },
    ];
    const merged = mergeBundleIntoSpec(spec, makeBundle(rules), "build-*");
    expect(merged.policy_rules).toEqual({
      "main/build-one": [{ ensure_index: 1, rule_id: "decision-1#0", source, step_selector: "build-*", on_fail: "refuse" }],
    });
  });

  it("never widens a rule when the caller supplies a broader selector", () => {
    const rule: Rule = { rule_id: "decision-1#0", source, bind: { kind: "ensure", step_selector: "finish" }, predicate: { expr: "result.ok == true" }, on_fail: "refuse" };
    const merged = mergeBundleIntoSpec(spec, makeBundle([rule]), "*");
    expect(merged.policy_rules).toEqual({
      "main/finish": [{ ensure_index: 0, rule_id: "decision-1#0", source, step_selector: "finish", on_fail: "refuse" }],
    });
  });
});

describe("guardEdgePredicatesFor", () => {
  it("stamps source and makes chain_hash part of guardChecksum", () => {
    const rule = (chainHash: string): Rule => ({
      rule_id: "decision-1#0",
      source: { ...source, chain_hash: chainHash },
      bind: { kind: "guard_edge", resource_selector: "memory-*", edge: "draft->done" },
      predicate: { file_contains: { path: "proof.txt", text: "approved" } },
      on_fail: "refuse",
    });
    const graph = { draft: ["done"], done: [] };
    const first = guardEdgePredicatesFor(makeBundle([rule("b".repeat(64))]), "memory-7", { "draft->done": [] }, {});
    const second = guardEdgePredicatesFor(makeBundle([rule("c".repeat(64))]), "memory-7", { "draft->done": [] }, {});
    expect(first["draft->done"]?.[0]).toMatchObject({
      id: "decision-1#0",
      type: "deterministic",
      statement: "server_file_contains(\"proof.txt\", \"approved\")",
      source: { chain_hash: "b".repeat(64) },
    });
    expect(guardChecksum(graph, first, ["done"], {})).not.toBe(guardChecksum(graph, second, ["done"], {}));
  });

  it("refuses a judged-only paranoid merge with the rule_id and edge", () => {
    const rule: Rule = {
      rule_id: "decision-1#9",
      source,
      bind: { kind: "guard_edge" },
      predicate: { judged: { statement: "safe to ship", stakes: "paranoid" } },
      on_fail: "refuse",
    };
    expect(() => guardEdgePredicatesFor(makeBundle([rule]), "resource", { "draft->done": [] }, { "draft->done": "paranoid" }))
      .toThrow(/decision-1#9.*draft->done/);
  });
});
