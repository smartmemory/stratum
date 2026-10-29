import { describe, expect, it } from "vitest";
import type { StepSpec } from "../src/data-client";
import { deriveEdges, layoutGraph } from "../src/model/graph";
import { runTone, stepTone } from "../src/model/status";
import { stepTiming } from "../src/model/timing";

describe("status → style", () => {
  // kind | status | label | token in color | fallback hex | live
  const rows: Array<[("step" | "run"), string, string, string, string, boolean]> = [
    ["step", "pending", "pending", "--stratum-pending", "#8b9099", false],
    ["step", "ready", "ready", "--stratum-ready", "#38bdf8", false],
    ["step", "running", "running", "--stratum-running", "#f59e0b", true],
    ["step", "waiting_gate", "waiting gate", "--stratum-waiting", "#a78bfa", true],
    ["step", "succeeded", "succeeded", "--stratum-succeeded", "#10b981", false],
    ["step", "failed", "failed", "--stratum-failed", "#ef4444", false],
    ["step", "skipped", "skipped", "--stratum-skipped", "#6b7280", false],
    ["step", "mystery", "mystery", "--stratum-pending", "#8b9099", false],
    ["run", "complete", "complete", "--stratum-succeeded", "#10b981", false],
    ["run", "awaiting_gate", "awaiting gate", "--stratum-waiting", "#a78bfa", true],
    ["run", "killed", "killed", "--stratum-killed", "#f97316", false],
    ["run", "cancelled", "cancelled", "--stratum-skipped", "#6b7280", false],
    ["run", "budget_exhausted", "budget exhausted", "--stratum-budget", "#fbbf24", false],
  ];
  it.each(rows)("%s %s", (kind, status, label, token, hex, live) => {
    const tone = kind === "step" ? stepTone(status) : runTone(status);
    expect(tone.label).toBe(label);
    expect(tone.color).toBe(`var(${token}, ${hex})`);
    expect(tone.live).toBe(live);
  });
});

describe("edge derivation (after + ${step.output} refs + routing)", () => {
  const s = (step: Partial<StepSpec> & { id: string }): StepSpec => ({ kind: "do", ...step });
  // name | steps | expected edge ids (sorted)
  const rows: Array<[string, StepSpec[], string[]]> = [
    ["after only", [s({ id: "a" }), s({ id: "b", after: ["a"] })], ["after:a->b"]],
    ["output ref in do", [s({ id: "a" }), s({ id: "b", do: "use ${a.output}" })], ["data:a->b"]],
    ["output path and index", [s({ id: "a" }), s({ id: "b" }), s({ id: "c", do: "${a.output.x} and ${b.output[0]}" })], ["data:a->c", "data:b->c"]],
    ["ref already in after is one edge", [s({ id: "a" }), s({ id: "b", after: ["a"], do: "${a.output}" })], ["after:a->b"]],
    ["carry-like names are not step refs", [s({ id: "a" }), s({ id: "b", do: "${a.outputs} ${a.outputValue} ${input.a}" })], []],
    ["ref to unknown step dropped", [s({ id: "b", do: "${ghost.output}" })], []],
    ["self ref dropped", [s({ id: "a", do: "${a.output}" })], []],
    ["refs in when / ensure expr / with / evaluate.in", [
      s({ id: "a" }), s({ id: "b" }), s({ id: "c" }), s({ id: "d" }),
      s({ id: "e", when: "${a.output.ok}", ensure: [{ expr: "${b.output} != null" }], with: { x: "${c.output}" }, evaluate: { in: "${d.output}" } } as never),
    ], ["data:a->e", "data:b->e", "data:c->e", "data:d->e"]],
    ["refs in fanout over and stage do", [
      s({ id: "prep" }), s({ id: "seed" }),
      s({ id: "fan", kind: "fanout", fanout: { over: "${prep.output.items}", steps: [{ do: "seeded by ${seed.output}" }] } }),
    ], ["data:prep->fan", "data:seed->fan"]],
    ["gate routes and on_fail", [
      s({ id: "draft", on_fail: "fix" }), s({ id: "fix" }), s({ id: "ship" }), s({ id: "abort" }),
      s({ id: "g", kind: "gate", after: ["draft"], gate: { on_approve: "ship", on_revise: "draft", on_kill: "abort" } }),
    ], ["after:draft->g", "approve:g->ship", "fail:draft->fix", "kill:g->abort", "revise:g->draft"]],
  ];
  it.each(rows)("%s", (_name, steps, expected) => {
    expect(deriveEdges(steps).map((edge) => edge.id).sort()).toEqual(expected);
  });

  it("lays out left to right and keeps revise out of the ranking", () => {
    const steps = [s({ id: "a" }), s({ id: "b", after: ["a"] }), s({ id: "g", kind: "gate", after: ["b"], gate: { on_revise: "a" } })];
    const layout = layoutGraph(steps, deriveEdges(steps));
    expect(layout.nodes.a!.x).toBeLessThan(layout.nodes.b!.x);
    expect(layout.nodes.b!.x).toBeLessThan(layout.nodes.g!.x);
    expect(layout.edges.find((edge) => edge.kind === "revise")!.points).toHaveLength(3);
  });
});

describe("step timing from events and attempts", () => {
  it("uses ready/result events, falls back to attempts, and leaves live steps open", () => {
    const events = [
      { at: "2026-10-30T01:00:00Z", type: "ready", stepId: "a" },
      { at: "2026-10-30T01:00:04Z", type: "result", stepId: "a" },
    ];
    expect(stepTiming("a", { status: "succeeded", attempts: [] }, events).durationMs).toBe(4000);
    const fromAttempts = stepTiming("b", { status: "failed", attempts: [{ attempt: 1, at: "2026-10-30T01:00:00Z" }, { attempt: 2, at: "2026-10-30T01:00:09Z" }] }, events);
    expect(fromAttempts.durationMs).toBe(9000);
    expect(stepTiming("a", { status: "running", attempts: [] }, events).endedAt).toBeNull();
  });
});
