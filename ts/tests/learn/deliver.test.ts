import { createHash } from "node:crypto";
import { classify, issueUnits } from "../../src/learn/classify.js";
import { authorCandidate } from "../../src/learn/candidate.js";
import type { FailureRecord } from "../../src/learn/harvest.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { validateSpec } from "../../src/ir/validate.js";
import type { PatchCandidate } from "../../src/learn/candidate.js";
import { contractHolds, lessonBlock, matchLessons, pinEventDetail, pinFor, setPin, type PinnedState } from "../../src/learn/deliver.js";
import type { ActiveLesson } from "../../src/learn/select.js";

/** Contracts compiled by the real validator, so the predicate sees exactly what the engine sees. */
function contracts(defs: Record<string, Record<string, string>>): Record<string, z.ZodTypeAny> {
  const result = validateSpec({
    version: 1, contracts: defs,
    flows: { entry: "main", main: { input: {}, output: { from: "${s.output}", contract: Object.keys(defs)[0]! },
      steps: [{ id: "s", do: "x", out: Object.keys(defs)[0]! }] } },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.contracts;
}

let counter = 0;
function lesson(overrides: {
  code?: string; path?: string; expected?: string[]; stepIds?: string[]; flowName?: string;
  groupingKey?: "step-scoped" | "step-agnostic"; records?: number; guidance?: string; clusterId?: string;
  workspaceRoot?: string;
} = {}): ActiveLesson {
  counter += 1;
  const clusterId = overrides.clusterId ?? counter.toString(16).padStart(64, "0");
  const candidate = {
    clusterId, revisionId: `rev-${clusterId}`,
    contract: { code: overrides.code ?? "invalid_enum_value", path: overrides.path ?? "outcome", expected: overrides.expected ?? ["complete", "failed"] },
    scope: { workspaceRoot: overrides.workspaceRoot ?? "/w", flowName: overrides.flowName ?? "build", stepIds: overrides.stepIds ?? ["plan"], specDigests: [] },
    groupingKey: overrides.groupingKey ?? "step-scoped",
    recurrence: { records: overrides.records ?? 3, distinctRuns: 3, distinctPairs: 3 },
    rendered: { guidance: overrides.guidance ?? `guidance ${clusterId.slice(-4)}`, content: "", templateId: "", templateVersion: "2", insertion: { mode: "append-to-section", section: "" } },
  } as unknown as PatchCandidate;
  return { candidate, applyId: `apply-${clusterId}`, appliedAt: "2026-09-26T00:00:00.000Z" };
}

const c = contracts({
  Result: { outcome: "complete|failed", count: "integer", ratio: "number", note: "string?", nested: "Inner", tags: "(x|y)[]", data: "object", list: "array" },
  Inner: { mode: "fast|slow" },
});

describe("contractHolds (D3 predicate)", () => {
  it.each([
    ["enum, exact option set", "invalid_enum_value", "outcome", ["failed", "complete"], true],
    ["enum, option added", "invalid_enum_value", "outcome", ["complete"], false],
    ["enum through a ref", "invalid_enum_value", "nested.mode", ["fast", "slow"], true],
    ["enum array element (index dropped)", "invalid_enum_value", "tags", ["x", "y"], true],
    ["integer as number", "invalid_type", "count", ["number"], true],
    ["integer as integer", "invalid_type", "count", ["integer"], true],
    ["plain number is not integer", "invalid_type", "ratio", ["integer"], false],
    ["nullish string", "invalid_type", "note", ["string"], true],
    ["type drift", "invalid_type", "note", ["number"], false],
    ["object field", "invalid_type", "data", ["object"], true],
    ["array field", "invalid_type", "list", ["array"], true],
    ["ref as object", "invalid_type", "nested", ["object"], true],
    ["unresolvable path", "invalid_type", "missing", ["string"], false],
    ["path into a scalar", "invalid_type", "note.deeper", ["string"], false],
  ] as const)("%s", (_name, code, path, expected, holds) => {
    expect(contractHolds(c.Result, { code, path, expected: [...expected] })).toBe(holds);
  });

  it.each([
    [["tags"], 0], [["tags", 0], 1], [["rows", 0, "tags", 2, 0], 2],
  ] as const)("harvests leaf depth from %j without changing candidate identity", (path, depth) => {
    const record: FailureRecord = {
      runId: "r", flowName: "build", stepId: "plan", attempt: 1, shape: "schema",
      workspaceRoot: "/w", at: "2026-09-26T00:00:00Z", recovered: false,
      reason: JSON.stringify([{ code: "invalid_type", path, expected: "string" }]),
    };
    const summary = issueUnits(record)[0]!.contract;
    expect(summary.leafArrayDepth).toBe(depth);
    const { leafArrayDepth: _, ...legacy } = summary;
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const fingerprint = sha(JSON.stringify({ shape: "schema", ...legacy }));
    const cluster = classify([record], { minRuns: 1, minPairs: 1 })[0]!;
    const candidate = authorCandidate(cluster);
    const key = ["/w", "build", "schema", fingerprint].join("\u0000");
    expect(candidate.clusterKey).toBe(key);
    expect(candidate.clusterId).toBe(sha(key));
    expect(candidate.revisionId).toBe(authorCandidate({ ...cluster, contract: legacy }).revisionId);
  });

  it("suppresses a field-level string lesson after string becomes string[]", () => {
    const own = lesson({ code: "invalid_type", path: "tags", expected: ["string"] });
    own.candidate.contract.leafArrayDepth = 0;
    expect(contractHolds(contracts({ R: { tags: "string" } }).R, own.candidate.contract)).toBe(true);
    expect(matchLessons([own], { flowName: "build", stepId: "plan", contract: contracts({ R: { tags: "string[]" } }).R }))
      .toEqual({ lessons: [], lessonsSuppressed: [{ revisionId: own.candidate.revisionId, reason: "contract-changed" }] });
  });

  it("holds an element-level string lesson only at its exact depth", () => {
    const summary = { code: "invalid_type", path: "tags", expected: ["string"], leafArrayDepth: 1 };
    expect(contractHolds(contracts({ R: { tags: "string[]" } }).R, summary)).toBe(true);
    expect(contractHolds(contracts({ R: { tags: "string" } }).R, summary)).toBe(false);
    expect(contractHolds(contracts({ R: { tags: "string[][]" } }).R, summary)).toBe(false);
  });

  it("retains any-depth matching for legacy candidates", () => {
    const summary = { code: "invalid_type", path: "tags", expected: ["string"] };
    expect(contractHolds(contracts({ R: { tags: "string" } }).R, summary)).toBe(true);
    expect(contractHolds(contracts({ R: { tags: "string[]" } }).R, summary)).toBe(true);
  });

  it("matches invalid_type enums independently of option order", () => {
    const summary = { code: "invalid_type", path: "outcome", expected: ["'failed' | 'complete'"], leafArrayDepth: 0 };
    expect(contractHolds(c.Result, summary)).toBe(true);
    expect(contractHolds(contracts({ R: { outcome: "complete|failed|skipped" } }).R, summary)).toBe(false);
  });

  it("does not hold without an output contract", () => {
    expect(contractHolds(undefined, { code: "invalid_type", path: "note", expected: ["string"] })).toBe(false);
  });
});

describe("matchLessons (D3)", () => {
  const target = { flowName: "build", stepId: "plan", contract: c.Result };

  it("matches a step-scoped lesson only on its own step and flow", () => {
    const own = lesson();
    expect(matchLessons([own], target)?.lessons.map((l) => l.revisionId)).toEqual([own.candidate.revisionId]);
    expect(matchLessons([own], { ...target, stepId: "other" })).toBeUndefined();
    expect(matchLessons([own], { ...target, flowName: "other" })).toBeUndefined();
  });

  it("matches a step-agnostic lesson on any step whose contract satisfies the predicate", () => {
    const agnostic = lesson({ groupingKey: "step-agnostic", stepIds: ["elsewhere"] });
    expect(matchLessons([agnostic], { ...target, stepId: "other" })?.lessons).toHaveLength(1);
    // An unrelated step whose contract lacks the field is out of scope, not drift.
    const other = contracts({ Other: { value: "string" } }).Other;
    expect(matchLessons([agnostic], { ...target, stepId: "other", contract: other })).toBeUndefined();
  });

  it.each([
    ["enum-set drift", { expected: ["complete", "failed", "skipped"] }],
    ["type drift", { code: "invalid_type", path: "note", expected: ["number"] }],
    ["unresolvable path", { code: "invalid_type", path: "gone", expected: ["string"] }],
  ])("suppresses an in-scope lesson on %s and records contract-changed", (_name, overrides) => {
    const drifted = lesson(overrides);
    expect(matchLessons([drifted], target)).toEqual({
      lessons: [], lessonsSuppressed: [{ revisionId: drifted.candidate.revisionId, reason: "contract-changed" }],
    });
  });

  it("suppresses a step-agnostic lesson on one of its own evidence steps when its contract drifted", () => {
    const agnostic = lesson({ groupingKey: "step-agnostic", expected: ["complete"] });
    expect(matchLessons([agnostic], target)?.lessonsSuppressed).toEqual([
      { revisionId: agnostic.candidate.revisionId, reason: "contract-changed" },
    ]);
  });

  it("budget: 4 matching lessons → 3 injected by recurrence then clusterId, 1 recorded as budget", () => {
    const a = lesson({ records: 9, clusterId: "a".repeat(64) });
    const b = lesson({ records: 5, clusterId: "c".repeat(64) });
    const d = lesson({ records: 5, clusterId: "b".repeat(64) });
    const e = lesson({ records: 2, clusterId: "d".repeat(64) });
    const pin = matchLessons([e, b, a, d], target)!;
    expect(pin.lessons.map((l) => l.clusterId)).toEqual([a, d, b].map((l) => l.candidate.clusterId));
    expect(pin.lessonsSuppressed).toEqual([{ revisionId: e.candidate.revisionId, reason: "budget" }]);
  });

  it("budget: guidance beyond 1,200 characters is suppressed", () => {
    const long = lesson({ records: 9, guidance: "x".repeat(1000) });
    const tooLong = lesson({ records: 5, guidance: "y".repeat(300) });
    const fits = lesson({ records: 1, guidance: "z".repeat(200) });
    const pin = matchLessons([long, tooLong, fits], target)!;
    expect(pin.lessons.map((l) => l.revisionId)).toEqual([long.candidate.revisionId, fits.candidate.revisionId]);
    expect(pin.lessonsSuppressed).toEqual([{ revisionId: tooLong.candidate.revisionId, reason: "budget" }]);
  });
});

describe("pinFor fail-closed contract", () => {
  const envFor = (root: string) => ({ STRATUM_CONFIG_FILE: join(root, "none.toml"), STRATUM_LEARN_DELIVER: "1" });

  it("warns selector diagnostics once, including a torn journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "learn-deliver-diagnostic-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const diagnostic = { reason: "journal-invalid" as const, detail: "torn journal regression" };
      const options = {
        workspaceRoot: root, flowName: "build", stepId: "plan", contract: c.Result, env: envFor(root),
        select: async () => ({ lessons: [], diagnostics: [diagnostic] }),
      };
      await expect(pinFor(options)).resolves.toBeUndefined();
      await pinFor(options);
      expect(warn).toHaveBeenCalledExactlyOnceWith(`learn deliver: ${JSON.stringify(diagnostic)}`);
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a throwing selector warns and delivers nothing — never throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "learn-deliver-pin-"));
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(pinFor({
        workspaceRoot: root, flowName: "build", stepId: "plan", contract: c.Result,
        env: envFor(root),
        select: async () => { throw new Error("selection store exploded"); },
      })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("learn deliver: selection failed, delivering nothing: selection store exploded");
      warn.mockRestore();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters out lessons whose canonical workspace differs from the run's", async () => {
    const root = await mkdtemp(join(tmpdir(), "learn-deliver-pin-"));
    const other = await mkdtemp(join(tmpdir(), "learn-deliver-foreign-"));
    try {
      const own = lesson({ workspaceRoot: root });
      const foreign = lesson({ workspaceRoot: other });
      const pin = await pinFor({
        workspaceRoot: root, flowName: "build", stepId: "plan", contract: c.Result,
        env: envFor(root),
        select: async () => ({ lessons: [own, foreign], diagnostics: [] }),
      });
      expect(pin?.lessons.map((l) => l.revisionId)).toEqual([own.candidate.revisionId]);
      expect(pin?.lessonsSuppressed).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("pin rendering", () => {
  it("renders the D4 block after a blank line and nothing without lessons", () => {
    expect(lessonBlock(undefined)).toBe("");
    expect(lessonBlock({ lessons: [] })).toBe("");
    expect(lessonBlock({ lessons: [
      { revisionId: "r1", clusterId: "c1", guidance: "First." },
      { revisionId: "r2", clusterId: "c2", guidance: "Second." },
    ] })).toBe("\n\n## Lessons from prior runs\n- First.\n- Second.");
  });

  it("setPin writes and clears; event detail is empty without a pin", () => {
    const state: PinnedState = {};
    setPin(state, { lessons: [{ revisionId: "r", clusterId: "c", guidance: "g" }] });
    expect(state).toEqual({ lessons: [{ revisionId: "r", clusterId: "c", guidance: "g" }] });
    setPin(state, undefined);
    expect(state).toEqual({});
    expect(pinEventDetail(undefined)).toEqual({});
    expect(pinEventDetail({ lessons: [], lessonsSuppressed: [{ revisionId: "r", reason: "budget" }] }))
      .toEqual({ lessonsSuppressed: [{ revisionId: "r", reason: "budget" }] });
  });
});
