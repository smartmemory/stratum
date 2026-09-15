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

  it.each([
    ["declared contracts", "contracts"],
    ["flow inputs", "inputs"],
  ] as const)("treats T? as nullish in %s without widening other types", (_name, source) => {
    const result = validateSpec({
      version: 1,
      contracts: { Result: { required_field: "string", opt: "string?" } },
      flows: {
        entry: "main",
        main: {
          input: { required_field: "string", opt: "string?" },
          output: { from: "${work.output}", contract: "Result" },
          steps: [{ id: "work", do: "work", out: "Result" }],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const schema = source === "contracts" ? result.contracts.Result : result.inputs.main;
    expect(schema?.safeParse({ required_field: "s", opt: null }).success).toBe(true);
    expect(schema?.safeParse({ required_field: "s" }).success).toBe(true);
    expect(schema?.safeParse({ required_field: "s", opt: "s" }).success).toBe(true);
    expect(schema?.safeParse({ required_field: "s", opt: 5 }).success).toBe(false);
    expect(schema?.safeParse({ required_field: null, opt: "s" }).success).toBe(false);
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

describe("STRAT-TS-FANOUT-CONSUMER IR validation", () => {
  it("injects dispatch: engine into the validated value when omitted", () => {
    const result = validateSpec(fanoutSpec());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flows.main?.steps[0]?.fanout?.dispatch).toBe("engine");
  });

  it.each(["engine", "consumer"] as const)("accepts dispatch: %s", (dispatch) => {
    expect(validateSpec(fanoutSpec({ dispatch })).ok).toBe(true);
  });

  it("rejects an unknown dispatch value", () => {
    const result = validateSpec(fanoutSpec({ dispatch: "external" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "SCHEMA_INVALID", path: "flows.main.steps[0].fanout.dispatch",
      }));
    }
  });

  it("keeps fanout strict when dispatch is present", () => {
    const result = validateSpec(fanoutSpec({ dispatch: "consumer", extraFanout: { surprise: true } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "E2_UNKNOWN_FIELD", path: "flows.main.steps[0].fanout.surprise",
      }));
    }
  });

  it.each([
    { name: "file_exists", predicate: { file_exists: "src/index.ts" } },
    { name: "file_contains", predicate: { file_contains: { path: "src/index.ts", text: "export" } } },
    { name: "nested expr", predicate: { expr: "result.value != '' && file_exists('src/index.ts')" } },
  ])("rejects consumer worktree filesystem ensure: $name", ({ predicate }) => {
    const result = validateSpec(fanoutSpec({
      dispatch: "consumer", isolation: "worktree", gate: true, stage: { ensure: [predicate] },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_FILESYSTEM_UNSUPPORTED",
        path: "flows.main.steps[0].fanout.steps[0].ensure[0]",
      }));
    }
  });

  it("accepts the same filesystem ensure for engine dispatch", () => {
    expect(validateSpec(fanoutSpec({
      dispatch: "engine", isolation: "worktree", stage: { ensure: [{ file_exists: "src/index.ts" }] },
    })).ok).toBe(true);
  });

  it("rejects a filesystem predicate nested inside a consumer worktree when expression", () => {
    const result = validateSpec(fanoutSpec({
      dispatch: "consumer",
      isolation: "worktree",
      gate: true,
      stage: { when: "item != null && (input.items[0] == item || file_contains('src/index.ts', 'export'))" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_FILESYSTEM_UNSUPPORTED",
        path: "flows.main.steps[0].fanout.steps[0].when",
      }));
    }
  });

  it("accepts a state-only consumer worktree when expression", () => {
    expect(validateSpec(fanoutSpec({
      dispatch: "consumer",
      isolation: "worktree",
      gate: true,
      stage: { when: "item != null && input.items[0] == item" },
    })).ok).toBe(true);
  });

  it("rejects consumer worktree fanout without a direct-successor gate", () => {
    const result = validateSpec(fanoutSpec({ dispatch: "consumer", isolation: "worktree" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_GATE_REQUIRED",
        path: "flows.main.steps[0].fanout.isolation",
      }));
    }
  });

  it("accepts consumer worktree fanout with a direct-successor gate", () => {
    expect(validateSpec(fanoutSpec({ dispatch: "consumer", isolation: "worktree", gate: true })).ok).toBe(true);
  });

  it("rejects a conditional (when-guarded) direct-successor gate — the engine could skip it", () => {
    const result = validateSpec(fanoutSpec({
      dispatch: "consumer", isolation: "worktree", gate: true,
      gateStep: { when: "false" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_GATE_REQUIRED",
      }));
    }
  });

  it("rejects a routed-only direct-successor gate (on_fail target is not normally activated)", () => {
    const result = validateSpec(fanoutSpec({
      dispatch: "consumer", isolation: "worktree", gate: true,
      extraSteps: [{ id: "helper", do: "help", on_fail: "merge_gate" }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_GATE_REQUIRED",
      }));
    }
  });

  it("rejects a routed-only direct-successor gate (gate on_approve target is not normally activated)", () => {
    const result = validateSpec(fanoutSpec({
      dispatch: "consumer", isolation: "worktree", gate: true,
      extraSteps: [{ id: "pre_gate", gate: { on_approve: "merge_gate", on_revise: null, on_kill: null } }],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "CONSUMER_WORKTREE_GATE_REQUIRED",
      }));
    }
  });

  it("does not require a gate for consumer fanout without worktree isolation", () => {
    expect(validateSpec(fanoutSpec({ dispatch: "consumer", isolation: "none" })).ok).toBe(true);
  });

  it("pins consumer fanout in a subflow to the existing root-only diagnostic", () => {
    const spec = fanoutSpec({ dispatch: "consumer", isolation: "worktree" });
    const main = spec.flows.main;
    spec.flows.main = {
      input: { items: "string[]" },
      output: { from: "${wrap.output}", contract: "Result" },
      steps: [{ id: "wrap", run: "child", with: { items: "${input.items}" } }],
    };
    spec.flows.child = main;
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: "SUBFLOW_BODY_RESTRICTED", path: "flows.child.steps[0].fanout",
      }));
    }
  });
});

interface FanoutSpecOptions {
  dispatch?: string;
  isolation?: "none" | "worktree";
  gate?: boolean;
  gateStep?: Record<string, unknown>;
  extraSteps?: Record<string, unknown>[];
  stage?: Record<string, unknown>;
  extraFanout?: Record<string, unknown>;
}

function fanoutSpec(options: FanoutSpecOptions = {}) {
  const fanout = {
    over: "${input.items}",
    steps: [{ do: "work ${item}", out: "Result", ...options.stage }],
    concurrency: 1,
    isolation: options.isolation ?? "none",
    require: "all",
    merge: "sequential",
    ...(options.dispatch !== undefined ? { dispatch: options.dispatch } : {}),
    ...options.extraFanout,
  };
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { items: "string[]" },
        output: { from: "${fan.output[0].value}", contract: "Result" },
        steps: [
          { id: "fan", fanout },
          ...(options.gate ? [{
            id: "merge_gate", after: ["fan"], gate: { on_approve: null, on_revise: null, on_kill: null },
            ...options.gateStep,
          }] : []),
          ...(options.extraSteps ?? []),
        ],
      },
    } as Record<string, any>,
  };
}
