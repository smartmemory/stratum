import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest, type FailureRecord } from "../../src/learn/harvest.js";
import { classify, contractFingerprint, groupRecords } from "../../src/learn/classify.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures", "learn", "flows");

async function records(): Promise<FailureRecord[]> {
  return (await harvest(FIXTURES)).records;
}

describe("classify", () => {
  it("classifies budget exhaustion as transient", async () => {
    const clusters = classify(await records());
    const budget = clusters.filter((c) => c.shape === "budget");
    expect(budget.length).toBeGreaterThan(0);
    for (const cluster of budget) expect(cluster.class).toBe("transient");
  });

  it("finds exactly one durable cluster: the outcome-enum lesson", async () => {
    const durable = classify(await records()).filter((c) => c.class === "durable");
    expect(durable.length).toBe(1);

    const cluster = durable[0]!;
    expect(cluster.groupingKey).toBe("step-agnostic");
    expect(cluster.scope.workspaceRoot).toContain("/forge/stratum");
    expect(cluster.scope.flowName).toBe("build");
    expect(cluster.recurrence.records).toBe(14);
    expect(cluster.recurrence.distinctRuns).toBe(2);
    expect(cluster.recurrence.distinctPairs).toBe(6);
    // 4 steps, one cause.
    expect(new Set(cluster.scope.stepIds)).toEqual(
      new Set(["explore_design", "plan", "blueprint", "verification"]),
    );
    // Rejected values are evidence, never key material.
    expect(new Set(cluster.observedValues)).toEqual(
      new Set(["success", "revised", "done", "pass", "approved"]),
    );
  });

  it("produces ZERO durable clusters from the 155x ship_gsd test noise", async () => {
    // The single most important test here. Those records are one golden test rerun in
    // 155 ephemeral workspaces, not 155 incidents. An implementation that groups
    // without attribution reports them as the corpus's most confident lesson.
    const clusters = classify(await records());
    const noise = clusters.filter((c) => c.scope.stepIds.includes("ship_gsd"));
    for (const cluster of noise) expect(cluster.class).not.toBe("durable");
  });

  it("requires breadth, not volume: one run retrying a step is never durable", async () => {
    const base = (await records()).find((r) => r.shape === "schema");
    expect(base).toBeDefined();
    const stormy: FailureRecord[] = Array.from({ length: 20 }, (_, i) => ({
      ...base!,
      runId: "one-run",
      attempt: i,
    }));
    const clusters = classify(stormy);
    for (const cluster of clusters) expect(cluster.class).not.toBe("durable");
  });

  it("counts fanout breadth by parent run-step pairs while retaining item evidence", async () => {
    const base = (await records()).find((r) => r.shape === "schema")!;
    const failures = ["run-a", "run-b"].flatMap((runId) =>
      [0, 1, 2].map((itemIndex) => ({
        ...base, runId, stepId: "fan", itemIndex, stage: 0, attempt: 1,
      })),
    );
    const clusters = classify(failures);
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) {
      expect(cluster.recurrence.distinctPairs).toBe(2);
      expect(cluster.class).not.toBe("durable");
      expect(cluster.evidence).toEqual(failures);
    }

    const broader = classify([...failures, { ...failures[0]!, stepId: "another-step" }]);
    const aggregate = broader.find((c) => c.groupingKey === "step-agnostic")!;
    expect(aggregate.recurrence.distinctPairs).toBe(3);
    expect(aggregate.class).toBe("durable");
  });

  describe("key composition — each of these independently breaks the real cluster", () => {
    it("preserves the contract cluster when identical evidence stops retries", async () => {
      const base = (await records()).find((r) => r.reason.includes("invalid_enum_value"))!;
      const retry = { ...base, attempt: base.attempt + 1, reason: `${base.reason} (no retry: identical evidence)` };
      expect(contractFingerprint(retry)).toBe(contractFingerprint(base));
      expect([...groupRecords([retry], "step-agnostic").keys()])
        .toEqual([...groupRecords([base], "step-agnostic").keys()]);
    });

    it("does not key on the rejected value (would give 5 clusters, not 1)", async () => {
      const enumRecords = (await records()).filter((r) => r.reason.includes("invalid_enum_value"));
      const fingerprints = new Set(enumRecords.map((r) => contractFingerprint(r)));
      expect(fingerprints.size).toBe(1);
    });

    it("does not key on specDigest (would give 2 single-run clusters)", async () => {
      const enumRecords = (await records()).filter((r) => r.reason.includes("invalid_enum_value"));
      // The two runs carry different spec revisions — the spec was edited between them.
      expect(new Set(enumRecords.map((r) => r.specDigest)).size).toBe(2);
      const groups = groupRecords(enumRecords, "step-agnostic");
      // One group holds all 14 enum issues. (A second, smaller group holds the
      // commit_hash type issue that two of those records ALSO carry.)
      const sizes = [...groups.values()].map((units) => units.length).sort((a, b) => b - a);
      expect(sizes[0]).toBe(14);
      expect(sizes.filter((n) => n === 14).length).toBe(1);
    });

    it("keys on flowName so like-named steps in unrelated flows never merge", async () => {
      const enumRecords = (await records()).filter((r) => r.reason.includes("invalid_enum_value"));
      const baseline = groupRecords(enumRecords, "step-agnostic").size;
      const foreign = enumRecords.map((r) => ({ ...r, flowName: "some-other-flow" }));
      const groups = groupRecords([...enumRecords, ...foreign], "step-agnostic");
      expect(groups.size).toBe(baseline * 2);
      for (const units of groups.values()) {
        expect(new Set(units.map((u) => u.record.flowName)).size).toBe(1);
      }
    });

    it("keys on workspaceRoot so two projects never merge", async () => {
      const enumRecords = (await records()).filter((r) => r.reason.includes("invalid_enum_value"));
      const baseline = groupRecords(enumRecords, "step-agnostic").size;
      const foreign = enumRecords.map((r) => ({ ...r, workspaceRoot: "/somewhere/else" }));
      const groups = groupRecords([...enumRecords, ...foreign], "step-agnostic");
      expect(groups.size).toBe(baseline * 2);
      for (const units of groups.values()) {
        expect(new Set(units.map((u) => u.record.workspaceRoot)).size).toBe(1);
      }
    });
  });

  it("flags mixed provenance: disjoint specDigests AND disjoint stepIds", async () => {
    const base = (await records()).filter((r) => r.reason.includes("invalid_enum_value"))[0]!;
    // Two unrelated contracts that happen to share a fingerprint, flow and project.
    const a = [0, 1, 2].map((i) => ({ ...base, runId: `a${i}`, stepId: "alpha", specDigest: "aaa" }));
    const b = [0, 1, 2].map((i) => ({ ...base, runId: `b${i}`, stepId: "beta", specDigest: "bbb" }));
    const cluster = classify([...a, ...b]).find(
      (c) => c.class === "durable" && c.groupingKey === "step-agnostic",
    );
    expect(cluster?.mixedProvenance).toBe(true);
    expect(cluster?.applyEligible).toBe(false);
  });

  it("segregates unattributed records and never merges them with attributed ones", async () => {
    const base = (await records()).filter((r) => r.reason.includes("invalid_enum_value"));
    const orphans = base.map((r) => {
      const { workspaceRoot: _drop, ...rest } = r;
      return rest as FailureRecord;
    });
    const clusters = classify([...base, ...orphans]);
    const unattributed = clusters.filter((c) => c.unattributed);
    expect(unattributed.length).toBeGreaterThan(0);
    // No cluster ever mixes attributed and unattributed evidence...
    for (const cluster of clusters) {
      const roots = new Set(cluster.evidence.map((r) => r.workspaceRoot ?? null));
      expect(roots.size).toBe(1);
    }
    // ...and unattributed evidence can never authorize a write.
    for (const cluster of unattributed) expect(cluster.applyEligible).toBe(false);
  });

  it("is deterministic", async () => {
    const source = await records();
    expect(JSON.stringify(classify(source))).toBe(JSON.stringify(classify(source)));
  });
});
