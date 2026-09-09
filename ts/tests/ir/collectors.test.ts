import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { stringLeaves } from "../../src/engine/engine.js";
import { StateStore, type AuditEvent } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { referencesInStep, resetClosure } from "../../src/ir/validate.js";
import { extractReferences } from "../../src/ir/refs.js";
import type { Flow } from "../../src/ir/schema.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";
import { buildCarryExample } from "./fixtures.js";

// T-S01-13: the validator's referencesInStep and the engine's stringLeaves must collect the
// same multiset of string leaves, tagged with the same `expression` flag, for every step — or
// a future carry arm in either one could silently reintroduce the ROUTING_CYCLE this feature
// exists to avoid (C5, R1-10).
describe("collector mirror (referencesInStep vs stringLeaves)", () => {
  it("agree on every step of the carry fixture", () => {
    const spec: any = buildCarryExample();
    for (const step of spec.flows.main.steps) {
      const fromValidator = referencesInStep(step, []).map((leaf) => ({ value: leaf.value, expression: leaf.expression })).sort((a, b) => a.value.localeCompare(b.value) || Number(a.expression) - Number(b.expression));
      const fromEngine = stringLeaves(step).map((leaf) => ({ value: leaf.value, expression: leaf.expression })).sort((a, b) => a.value.localeCompare(b.value) || Number(a.expression) - Number(b.expression));
      expect(fromEngine).toEqual(fromValidator);
    }
  });

  it("never produces a kind === \"step\" reference for a carry token", () => {
    const spec: any = buildCarryExample();
    const fixups = spec.flows.main.steps.find((step: any) => step.id === "fixups");
    expect(fixups.fanout.over).toBe("${wave}");
    const validatorLeaves = referencesInStep(fixups, []);
    const engineLeaves = stringLeaves(fixups);
    expect(validatorLeaves.some((leaf) => leaf.value === "${wave}")).toBe(true);
    expect(engineLeaves.some((leaf) => leaf.value === "${wave}")).toBe(true);

    // F5: collecting the literal is not the claim under test — the claim is that the token
    // PARSES as a carry reference and never as a step reference, since a `kind === "step"`
    // classification is what would reintroduce the dependency edge (and the ROUTING_CYCLE).
    let sawCarry = false;
    for (const leaf of [...validatorLeaves, ...engineLeaves]) {
      for (const extracted of extractReferences(leaf.value) ?? []) {
        if (leaf.value === "${wave}") {
          expect(extracted.reference.kind).toBe("carry");
          expect(extracted.fullValue).toBe(true);
          sawCarry = true;
        }
        expect(extracted.reference.kind === "step" && extracted.reference.stepId === "wave").toBe(false);
      }
    }
    expect(sawCarry).toBe(true);
  });
});

// T-S01-14: the validator's resetClosure must equal the engine's actual step_reset descendant
// set for every (flow, target) pair, across a matrix that includes each of the three routing
// edges plus a plain dependency chain and the golden (design-example) flow. Pins R1-1(b)
// against engine.resetFrom (engine.ts:2224-2244) drifting away from its validator twin.
describe("reset-closure parity (resetClosure vs engine.resetFrom)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  async function subject() {
    const root = await mkdtemp(join(tmpdir(), "stratum-collectors-"));
    roots.push(root);
    return {
      engine: tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator() })),
      store: new StateStore(root),
    };
  }

  function resetIds(events: AuditEvent[]): string[] {
    const event = events.find((candidate) => candidate.type === "step_reset");
    if (!event || !("detail" in event)) throw new Error("expected a step_reset event");
    const detail = event.detail as { reset: Array<{ stepId: string }> };
    return detail.reset.map((entry) => entry.stepId).sort();
  }

  it("plain after chain", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: {}, output: { from: "${c.output}", contract: "Result" }, max_rounds: 1,
          steps: [
            { id: "a", do: "a", out: "Result" },
            { id: "b", after: ["a"], do: "b", out: "Result" },
            { id: "c", after: ["b"], do: "c", out: "Result" },
            { id: "gate", after: ["c"], gate: { on_approve: null, on_revise: "a", on_kill: null } },
          ],
        },
      },
    };
    const planned = await engine.plan(spec, {});
    if (planned.status !== "ready") throw new Error("expected a ready");
    await engine.stepDone(planned.runId, "a", { output: { value: "a" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    await engine.stepDone(planned.runId, "b", { output: { value: "b" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    await engine.stepDone(planned.runId, "c", { output: { value: "c" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    const before = await store.load(planned.runId);
    const token = before.steps.gate?.gateToken!;
    await engine.gateResolve(planned.runId, "gate", "revise", token);
    const after = await store.load(planned.runId);

    const closure = [...resetClosure(spec.flows.main as unknown as Flow, "a")].sort();
    expect(resetIds(after.events)).toEqual(closure);
    expect(closure).toEqual(["a", "b", "c", "gate"]);
  });

  it("chain with an on_fail branch", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: {}, output: { from: "${b.output}", contract: "Result" }, max_rounds: 1,
          steps: [
            { id: "a", do: "a", out: "Result", on_fail: "recover" },
            { id: "recover", do: "recover", out: "Result" },
            { id: "b", after: ["a"], do: "b", out: "Result" },
            { id: "gate", after: ["b"], gate: { on_approve: null, on_revise: "a", on_kill: null } },
          ],
        },
      },
    };
    const planned = await engine.plan(spec, {});
    if (planned.status !== "ready") throw new Error("expected a ready");
    await engine.stepDone(planned.runId, "a", { output: { value: "a" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    await engine.stepDone(planned.runId, "b", { output: { value: "b" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    const before = await store.load(planned.runId);
    const token = before.steps.gate?.gateToken!;
    await engine.gateResolve(planned.runId, "gate", "revise", token);
    const after = await store.load(planned.runId);

    const closure = [...resetClosure(spec.flows.main as unknown as Flow, "a")].sort();
    expect(resetIds(after.events)).toEqual(closure);
    expect(closure).toEqual(["a", "b", "gate", "recover"]);
  });

  it("chain with a gate on_approve branch", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: {}, output: { from: "${b.output}", contract: "Result" }, max_rounds: 1,
          steps: [
            { id: "a", do: "a", out: "Result" },
            { id: "decision", after: ["a"], gate: { on_approve: "c", on_revise: null, on_kill: null } },
            { id: "c", do: "c", out: "Result" },
            { id: "b", after: ["a"], do: "b", out: "Result" },
            { id: "gate", after: ["b"], gate: { on_approve: null, on_revise: "a", on_kill: null } },
          ],
        },
      },
    };
    const planned = await engine.plan(spec, {});
    if (planned.status !== "ready") throw new Error("expected a ready");
    await engine.stepDone(planned.runId, "a", { output: { value: "a" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    await engine.stepDone(planned.runId, "b", { output: { value: "b" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    const before = await store.load(planned.runId);
    const token = before.steps.gate?.gateToken!;
    await engine.gateResolve(planned.runId, "gate", "revise", token);
    const after = await store.load(planned.runId);

    const closure = [...resetClosure(spec.flows.main as unknown as Flow, "a")].sort();
    expect(resetIds(after.events)).toEqual(closure);
    expect(closure).toEqual(["a", "b", "c", "decision", "gate"]);
  });

  it("chain with a gate on_kill branch", async () => {
    const { engine, store } = await subject();
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: {}, output: { from: "${b.output}", contract: "Result" }, max_rounds: 1,
          steps: [
            { id: "a", do: "a", out: "Result" },
            { id: "decision", after: ["a"], gate: { on_approve: null, on_revise: null, on_kill: "c" } },
            { id: "c", do: "c", out: "Result" },
            { id: "b", after: ["a"], do: "b", out: "Result" },
            { id: "gate", after: ["b"], gate: { on_approve: null, on_revise: "a", on_kill: null } },
          ],
        },
      },
    };
    const planned = await engine.plan(spec, {});
    if (planned.status !== "ready") throw new Error("expected a ready");
    await engine.stepDone(planned.runId, "a", { output: { value: "a" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    await engine.stepDone(planned.runId, "b", { output: { value: "b" }, usage: {}, telemetry: { model: "m", durationMs: 1 } });
    const before = await store.load(planned.runId);
    const token = before.steps.gate?.gateToken!;
    await engine.gateResolve(planned.runId, "gate", "revise", token);
    const after = await store.load(planned.runId);

    const closure = [...resetClosure(spec.flows.main as unknown as Flow, "a")].sort();
    expect(resetIds(after.events)).toEqual(closure);
    expect(closure).toEqual(["a", "b", "c", "decision", "gate"]);
  });

  it("the golden (design-example) flow", async () => {
    // Same topology as `designExample` (fixtures.ts) — build -> check -> approve (gate,
    // on_revise: build) -> fixups (fanout) -> wrap (subflow) — with designExample's
    // `file_exists`/`judged` ensures dropped: those need a real workspace root and are
    // orthogonal to what this test pins (the reset closure over that topology).
    const { engine, store } = await subject();
    const spec: any = {
      version: 1,
      contracts: {
        Review: { verdict: "pass|fail", notes: "string", items: "string[]", hint: "string?" },
        Fixup: { done: "boolean", path: "string" },
      },
      flows: {
        entry: "main",
        main: {
          input: { goal: "string" },
          output: { from: "${wrap.output}", contract: "Review" },
          max_rounds: 3,
          steps: [
            { id: "build", do: "Implement ${input.goal}", out: "Review" },
            { id: "check", do: "Verify ${build.output.notes}", out: "Review" },
            { id: "approve", after: ["check"], gate: { on_approve: "fixups", on_revise: "build", on_kill: null, max_rounds: 2 } },
            {
              id: "fixups",
              fanout: {
                over: "${check.output.items}",
                steps: [{ do: "Fix ${item}", out: "Fixup", ensure: [{ expr: "result.done == true" }] }],
                concurrency: 3, isolation: "worktree", require: "all", merge: "sequential", pre_merge: ["pnpm vitest run"],
              },
            },
            { id: "wrap", run: "summarize", with: { notes: "${fixups.output}" } },
          ],
        },
        summarize: {
          input: { notes: "array" },
          output: { from: "${digest.output}", contract: "Review" },
          steps: [{ id: "digest", do: "Summarize ${input.notes} as a Review", out: "Review" }],
        },
      },
    };
    const planned = await engine.plan(spec, { goal: "ship it" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    await engine.stepDone(planned.runId, "build", {
      output: { verdict: "pass", notes: "n", items: ["x"] }, usage: {}, telemetry: { model: "m", durationMs: 1 },
    });
    await engine.stepDone(planned.runId, "check", {
      output: { verdict: "pass", notes: "n2", items: ["y"] }, usage: {}, telemetry: { model: "m", durationMs: 1 },
    });
    const before = await store.load(planned.runId);
    const token = before.steps.approve?.gateToken!;
    await engine.gateResolve(planned.runId, "approve", "revise", token);
    const after = await store.load(planned.runId);

    const closure = [...resetClosure(spec.flows.main as Flow, "build")].sort();
    expect(resetIds(after.events)).toEqual(closure);
    expect(closure).toEqual(["approve", "build", "check", "fixups", "wrap"]);
  });
});
