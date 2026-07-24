import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type Evaluator } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { validateSpec } from "../../src/ir/validate.js";

// The expression evaluator (unrelated to the S1 external "evaluate" step) only
// needs to render `${input.goal}` into the runner input for these tests.
const evaluator: Evaluator = {
  evaluate(expression, context) {
    if (expression === "input.goal") return (context.input as { goal: string }).goal;
    throw new Error(`unexpected fake expression: ${expression}`);
  },
};

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function createEngine(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "stratum-eval-"));
  roots.push(root);
  return new StratumEngine({ stateRoot: root, evaluator, ...extra } as ConstructorParameters<typeof StratumEngine>[0]);
}

// Single evaluate step whose output IS the flow output, validated against the
// author-declared `Eval` contract. The author contract is deliberately loose
// (`status: "string"`) — the engine's fixed evaluator-result schema is what
// enforces the enum and the cross-field invariants.
const evalFlow = (evaluate: unknown) => ({
  version: 1,
  contracts: { Eval: { status: "string", children: "string[]", reason: "string" } },
  flows: {
    entry: "main",
    main: {
      input: { goal: "string" },
      output: { from: "${probe.output}", contract: "Eval" },
      steps: [{ id: "probe", evaluate, out: "Eval" }],
    },
  },
});

const ok = (result: unknown) => async () => ({ ok: true as const, result });
const fail = (kind: string, reason: string) => async () => ({ ok: false as const, kind, reason });

describe("S1 evaluate step", () => {
  it("invokes the runner server-side and yields its validated verdict as the step output", async () => {
    const calls: unknown[] = [];
    const engine = await createEngine({
      evaluateRunner: async (invocation: unknown, context: unknown) => {
        calls.push({ invocation, context });
        return { ok: true, result: { status: "open", children: ["g1", "g2"], reason: "two subgoals remain" } };
      },
    });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", in: "${input.goal}", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({
      status: "completed",
      output: { status: "open", children: ["g1", "g2"], reason: "two subgoals remain" },
    });
    // The declared command, rendered input, and timeout reach the runner.
    expect(calls).toEqual([{ invocation: { command: "lean-probe", input: "prove P", timeoutMs: 5000 }, context: {} }]);
  });

  it("fails closed with a distinct reason when no evaluate runner is configured", async () => {
    const engine = await createEngine();
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("no evaluate runner") } });
  });

  it("maps a non-zero exit to a typed failure and never synthesises a closed verdict", async () => {
    const engine = await createEngine({ evaluateRunner: fail("exit", "process exited with code 2") });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("non-zero") } });
    expect(planned.status).not.toBe("completed");
    expect((planned as { output?: unknown }).output).toBeUndefined();
  });

  it("maps a timeout to a distinct typed failure", async () => {
    const engine = await createEngine({ evaluateRunner: fail("timeout", "killed after 5000ms") });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("timed out") } });
  });

  it("maps unparseable stdout to a distinct typed failure", async () => {
    const engine = await createEngine({ evaluateRunner: fail("parse", "unexpected token") });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("not valid JSON") } });
  });

  it("rejects output that parses but violates the evaluator-result contract", async () => {
    const engine = await createEngine({ evaluateRunner: ok({ status: "maybe", children: [], reason: "x" }) });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("evaluator-result contract") } });
  });

  it("rejects a closed verdict that carries children (cross-field invariant)", async () => {
    const engine = await createEngine({ evaluateRunner: ok({ status: "closed", children: ["g1"], reason: "done?" }) });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("evaluator-result contract") } });
  });

  it("accepts a well-formed closed verdict with no children", async () => {
    const engine = await createEngine({ evaluateRunner: ok({ status: "closed", children: [], reason: "goal discharged" }) });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "completed", output: { status: "closed", children: [], reason: "goal discharged" } });
  });

  it("rejects a malformed runner envelope instead of trusting its verdict", async () => {
    // A buggy runner whose `ok` discriminant is not a real boolean must not have
    // its verdict laundered through — the engine owns the envelope, not the runner.
    const engine = await createEngine({ evaluateRunner: async () => ({ ok: "false", result: { status: "closed", children: [], reason: "trust me" } }) as never });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("malformed") } });
    expect(planned.status).not.toBe("completed");
  });

  it("converts a thrown runner into a typed failure rather than rejecting the run", async () => {
    const engine = await createEngine({ evaluateRunner: async () => { throw new Error("spawn ENOENT"); } });
    const planned = await engine.plan(evalFlow({ command: "lean-probe", timeout_ms: 5000 }), { goal: "prove P" });
    expect(planned).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("spawn ENOENT") } });
  });

  it("waits for a step referenced by its input binding before invoking the runner", async () => {
    const engine = await createEngine({
      evaluator: createEvaluator(),
      evaluateRunner: ok({ status: "closed", children: [], reason: "ok" }),
    });
    const spec = {
      version: 1,
      contracts: { Eval: { status: "string", children: "string[]", reason: "string" }, Prep: { goal: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { seed: "string" },
          output: { from: "${probe.output}", contract: "Eval" },
          steps: [
            { id: "prep", do: "prepare ${input.seed}", out: "Prep" },
            { id: "probe", evaluate: { command: "lean-probe", in: "${prep.output.goal}", timeout_ms: 5000 }, out: "Eval" },
          ],
        },
      },
    };
    const planned = await engine.plan(spec, { seed: "s" });
    // probe references prep's output — it must NOT run until prep completes.
    expect(planned.status).toBe("ready");
    if (planned.status !== "ready") return;
    expect(planned.ready.map((r) => r.id)).toEqual(["prep"]);
    const done = await engine.stepDone(planned.runId, "prep", { output: { goal: "prove P" } }, planned.ready[0]!.dispatchToken);
    expect(done.status).toBe("completed");
  });
});

describe("S1 evaluate typed references (R1-8)", () => {
  it("types a reference into an evaluate step's output through its out contract", () => {
    const spec = {
      version: 1,
      contracts: { Eval: { status: "string", children: "string[]", reason: "string" }, Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { goal: "string" },
          output: { from: "${probe.output.status}", contract: "Result" },
          steps: [{ id: "probe", evaluate: { command: "c", timeout_ms: 1000 }, out: "Eval" }],
        },
      },
    };
    // referencing a real field of the out contract is valid; a bogus field is not.
    expect(validateSpec(spec).ok).toBe(true);
    (spec.flows.main.output.from as string) = "${probe.output.nonsense}";
    const bad = validateSpec(spec);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]?.code).toBe("REF_UNKNOWN_PATH");
  });

  it("requires an out contract to reference an evaluate step's output", () => {
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { goal: "string" },
          output: { from: "${probe.output}", contract: "Result" },
          steps: [{ id: "probe", evaluate: { command: "c", timeout_ms: 1000 } }],
        },
      },
    };
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe("REF_OUTPUT_CONTRACT_REQUIRED");
  });
});
