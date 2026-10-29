/// <reference types="vite/client" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The engine's own validator and schema, from source: an engine schema change trips these tests.
// Loaded by import.meta.glob so ui's tsc does not type-check the engine (ts/ does, under its own tsconfig).
type EngineError = { code: string; path: string; message: string };
const VALIDATE = import.meta.glob<{ validateSpec: (spec: unknown) => { ok: true } | { ok: false; errors: EngineError[] } }>("../../ts/src/ir/validate.ts", { eager: true });
const SCHEMA = import.meta.glob<{ SpecificationSchema: { safeParse: (spec: unknown) => { success: true } | { success: false; error: { issues: Array<{ code: string; path: Array<string | number>; message: string }> } } } }>("../../ts/src/ir/schema.ts", { eager: true });
const { validateSpec } = VALIDATE["../../ts/src/ir/validate.ts"]!;
const { SpecificationSchema } = SCHEMA["../../ts/src/ir/schema.ts"]!;
import { buildExport, defaultStep, KINDS, parseImport, pinErrors, renameStep, stepKind, type RawSpec, type StepKind } from "../src/builder/lib/spec";

const fixture = (name: string): RawSpec => JSON.parse(readFileSync(join(__dirname, "fixtures", "specs", name), "utf8"));

/**
 * Three REAL specs copied verbatim from `~/.stratum/ts/flows/<run>.json` `.spec` on
 * 2026-10-30 (file name = construct + run id). Each round-trips import → export deep-equal,
 * and the engine's validateSpec accepts both the original and the export.
 */
const ROUND_TRIP: Array<{ name: string; file: string; construct: StepKind; flows: number }> = [
  { name: "gate spec (compose `new`)", file: "gate-5dc37b92-dd13-4486-91ca-636021d5ac9d.json", construct: "gate", flows: 1 },
  { name: "fanout spec (compose `gsd`)", file: "fanout-59a1d992-672b-469f-b0ac-8d48a6dbd930.json", construct: "fanout", flows: 1 },
  { name: "run: spec (compose `build`, 3 flows)", file: "run-99d76a27-c5f1-4b10-bbea-7d527e9f147d.json", construct: "run", flows: 3 },
];

describe("builder round-trip on real specs", () => {
  it.each(ROUND_TRIP)("$name: import → export is deep-equal and validateSpec says valid", ({ file, construct, flows }) => {
    const original = fixture(file);
    expect(validateSpec(original)).toMatchObject({ ok: true });

    const doc = parseImport(JSON.parse(JSON.stringify(original)));
    const exported = buildExport(doc);
    expect(exported).toStrictEqual(original);
    expect(validateSpec(exported)).toMatchObject({ ok: true });

    // The canvas sees every flow, one kind per step, and the construct this row is for.
    const names = Object.keys(exported.flows).filter((name) => name !== "entry");
    expect(names).toHaveLength(flows);
    const steps = names.flatMap((name) => (exported.flows[name] as { steps: Array<Record<string, unknown>> }).steps);
    expect(steps.every((step) => stepKind(step) !== null)).toBe(true);
    expect(steps.some((step) => stepKind(step) === construct)).toBe(true);

    // A rename there and back is lossless too (after, routes, ${id.output} refs, output.from).
    const target = steps.find((step) => stepKind(step) === construct)!.id as string;
    const owner = names.find((name) => (exported.flows[name] as { steps: Array<{ id: string }> }).steps.some((step) => step.id === target))!;
    const renamed = renameStep({ ...doc, flowName: owner }, target, `${target}_x`);
    const renamedIds = (buildExport(renamed).flows[owner] as { steps: Array<{ id: string }> }).steps.map((step) => step.id);
    expect(renamedIds).toContain(`${target}_x`);
    expect(renamedIds).not.toContain(target);
    expect(JSON.stringify(buildExport(renamed))).not.toMatch(new RegExp(`"${target}"|\\$\\{${target}\\.output`));
    expect(buildExport(renameStep(renamed, `${target}_x`, target))).toStrictEqual(original);
  });
});

describe("new steps carry exactly one kind key (fixes Base44 serializeStep `kind: 'do'`)", () => {
  it.each(KINDS.map((kind) => ({ kind })))("$kind", ({ kind }) => {
    const step = defaultStep(kind, `${kind}_1`);
    expect(step).not.toHaveProperty("kind");
    expect(KINDS.filter((key) => key in step)).toEqual([kind]);
    const spec = { version: 1, contracts: { Result: { summary: "string" } }, flows: { entry: "main", main: { input: {}, output: { from: "", contract: "Result" }, steps: [step] } } };
    const parsed = SpecificationSchema.safeParse(spec);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues.filter((issue) => issue.message.startsWith("E2_") || issue.code === "unrecognized_keys")).toEqual([]);
  });
});

describe("validateSpec errors pin to the node named by path", () => {
  const base = (): RawSpec => fixture("gate-5dc37b92-dd13-4486-91ca-636021d5ac9d.json");
  const ROWS: Array<{ name: string; mutate: (spec: RawSpec) => void; code: string; stepId: string | null }> = [
    { name: "gate routes to an unknown step", mutate: (spec) => { ((spec.flows.new as any).steps[2].gate.on_approve = "nowhere"); }, code: "ROUTING_UNKNOWN_TARGET", stepId: "review_gate" },
    { name: "a step with two kind keys", mutate: (spec) => { (spec.flows.new as any).steps[3].set = { x: "y" }; }, code: "E2_CONSTRUCT_MIX", stepId: "roadmap" },
    { name: "an unknown output contract on the flow", mutate: (spec) => { (spec.flows.new as any).output.contract = "Nope"; }, code: "CONTRACT_UNKNOWN_REF", stepId: null },
  ];
  it.each(ROWS)("$name", ({ mutate, code, stepId }) => {
    const spec = base();
    mutate(spec);
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors.map((error) => error.code)).toContain(code);
    const pinned = pinErrors(spec, errors);
    if (stepId) expect(pinned.steps.new?.[stepId]?.map((error) => error.code)).toContain(code);
    else expect(pinned.other.map((error) => error.code)).toContain(code);
  });
});
