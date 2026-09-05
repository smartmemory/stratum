import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecValidationError, StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { bundleIdForRules } from "../../src/policy/bundle.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const inputSpec = {
  version: 1,
  contracts: { Person: { name: "string", age: "integer?" }, Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { people: "Person[]", flag: "boolean", note: "string?" },
    output: { from: "${finish.output}", contract: "Result" },
    steps: [{ id: "finish", do: "Handle ${input.people[0].name}", out: "Result" }],
  } },
};

async function subject() {
  const root = await mkdtemp(join(tmpdir(), "stratum-entry-input-"));
  roots.push(root);
  const connector = vi.fn(async () => ({ output: { value: "unexpected" } }));
  const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector, learnEgressOptions: { env: {} } });
  return { root, engine, connector };
}

describe("entry input boundary", () => {
  it.each([
    ["missing", {}],
    ["null", null],
    ["scalar", 7],
    ["extra field", { people: [{ name: "Ada" }], flag: true, surprise: 1 }],
    ["wrong scalar", { people: [{ name: "Ada" }], flag: "true" }],
    ["wrong array", { people: { name: "Ada" }, flag: true }],
    ["nested type", { people: [{ name: 123 }], flag: true }],
    ["nested missing", { people: [{}], flag: true }],
    ["nested extra", { people: [{ name: "Ada", extra: true }], flag: true }],
    ["nested integer", { people: [{ name: "Ada", age: 1.2 }], flag: true }],
  ])("rejects %s before any persisted run or connector call", async (_name, input) => {
    const { root, engine, connector } = await subject();
    for (const plan of [engine.plan.bind(engine), engine.flowRunBg.bind(engine)]) {
      await expect(plan(inputSpec, input)).rejects.toBeInstanceOf(SpecValidationError);
      expect(await readdir(root)).toEqual([]);
      expect(connector).not.toHaveBeenCalled();
    }
  });

  it("validates and snapshots nested entry input using the policy-merged specification", async () => {
    const { root, engine } = await subject();
    const input = { people: [{ name: "Ada", age: 37 }], flag: true };
    const rules = [{
      rule_id: "entry-policy#0",
      source: { record_id: "entry-policy", memory_type: "decision" as const, version: 1, content_hash: "a".repeat(64), chain_hash: "b".repeat(64), workspace_id: "fixture" },
      bind: { kind: "ensure" as const, step_selector: "finish" },
      predicate: { expr: "result.value == input.people[0].name" },
      on_fail: "refuse" as const,
    }];
    const planned = await engine.plan(inputSpec, input, { policyBundle: {
      bundle_id: bundleIdForRules(rules), workspace_id: "fixture", compiled_at: "2026-09-05T00:00:00.000Z", selector: { status: ["active"] }, rules,
    } });
    expect(planned).toMatchObject({ status: "ready", ready: [{ do: "Handle Ada" }] });
    input.people[0]!.name = "mutated";
    const persisted = JSON.parse(await readFile(join(root, `${planned.runId}.json`), "utf8"));
    expect(persisted.input.people[0].name).toBe("Ada");
    expect(persisted.spec.flows.main.steps[0].ensure).toEqual([rules[0]!.predicate]);
  });
});
