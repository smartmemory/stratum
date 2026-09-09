import { describe, expect, it } from "vitest";
import { validateSpec } from "../../src/ir/validate.js";
import { buildCarryExample } from "./fixtures.js";

// STRAT-LOOP-CARRY coverage sweep — validation-side edge cases not exercised by
// tests/ir/validate.test.ts's fixture tables or tests/ir/collectors.test.ts.

describe("STRAT-LOOP-CARRY validation edge cases", () => {
  it("accepts a carry name that collides with a step id in a different (subflow) flow", () => {
    // CARRY_NAME_CONFLICT checks `ids`, which is built fresh per flow inside the per-flow
    // loop (validate.ts:369-370) — so a step id in a *different* flow is not in scope for
    // the entry flow's carry pass. Renaming the subflow's only step to "wave" (the carry
    // name declared on main) must not trip CARRY_NAME_CONFLICT.
    const spec: any = buildCarryExample();
    expect(spec.flows.main.carry.wave).toBeDefined();
    const summarize = spec.flows.summarize;
    expect(summarize.steps).toHaveLength(1);
    summarize.steps[0].id = "wave";
    summarize.output.from = "${wave.output}";

    const result = validateSpec(spec);
    expect(result.ok ? result.value.version : result.errors).toBe(1);
  });

  it("accepts an index path into a carry reference (${wave[0]})", () => {
    // The carry path grammar is the same parsePath used for every other reference kind
    // (S01-2), so a numeric index segment must be legal. `wave` is declared from
    // `build.output.items`, a string[], so `wave[0]` is a valid (if unchecked-by-contract)
    // string index.
    const spec: any = buildCarryExample();
    const check = spec.flows.main.steps.find((step: any) => step.id === "check");
    check.do = "Verify ${build.output.notes} against tests, matching ${wave[0]}";
    // `check` is now a consumer of `wave` too, so it must be inside the revise gate's
    // reset closure AND dependency-ordered before it (R1-1). It already sits inside
    // `resetClosure(build)` (build -> check via the reference edge above), but nothing
    // orders `check` before `assess_gate` — make that explicit.
    const fixups = spec.flows.main.steps.find((step: any) => step.id === "fixups");
    fixups.after = ["build", "check"];

    const result = validateSpec(spec);
    expect(result.ok ? result.value.version : result.errors).toBe(1);
  });

  it("accepts a carry variable referenced only inside a fanout stage's do, not in over", () => {
    // Move the ONLY use of `${wave}` from `fixups.fanout.over` into the fanout stage's
    // `do` template. carryUses is collected from every leaf of referencesInStep (S01-6),
    // which includes fanout stage leaves tagged fanoutStage: true but attributed to the
    // OUTER step id (validate.ts: `carryUses.push({ name, stepId: step.id, path })`) — so
    // ordering (CARRY_REF_BEFORE_INITIAL) and revise-coverage rules must still be checked
    // against `fixups`, exactly as when `over` itself carried the reference.
    const spec: any = buildCarryExample();
    const fixups = spec.flows.main.steps.find((step: any) => step.id === "fixups");
    expect(fixups.fanout.over).toBe("${wave}");
    fixups.fanout.over = "${check.output.items}";
    fixups.fanout.steps[0].do = "Fix ${item} using ${wave[0]}";

    const result = validateSpec(spec);
    expect(result.ok ? result.value.version : result.errors).toBe(1);
  });

  it("still catches ordering violations when the carry reference is inside a fanout stage do", () => {
    // Same move as above, but drop `fixups`'s `after: ["build"]` so the dependency-only
    // path from `build` to `fixups` is broken (fixups's over now points at `check`, whose
    // own do references `build`, so build still reaches fixups transitively through
    // check — dropping `after` alone does not break that). To actually break ordering,
    // point `over` at a step with no path back to `build` and reference the carry only
    // in the stage `do`.
    const spec: any = buildCarryExample();
    const fixups = spec.flows.main.steps.find((step: any) => step.id === "fixups");
    // Give fixups an independent trigger unrelated to build/check, so it no longer
    // depends (even transitively) on the carry's source step.
    spec.flows.main.steps.push({ id: "aside", do: "aside", out: "Fixup" });
    fixups.after = ["aside"];
    fixups.fanout.over = "${aside.output.path}";
    fixups.fanout.steps[0].do = "Fix ${item} using ${wave[0]}";
    // aside has no `out` shaped like an array; fanout over a scalar string path is fine
    // for THIS check since FANOUT_OVER_SINGLE_REF only requires one full reference — the
    // point under test is CARRY_REF_BEFORE_INITIAL, which fires before that would matter.

    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: "CARRY_REF_BEFORE_INITIAL" });
  });
});
