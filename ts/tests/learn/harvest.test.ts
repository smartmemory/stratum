import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest } from "../../src/learn/harvest.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Real persisted runs, extracted from ~/.stratum/ts/flows — not hand-written. */
const FIXTURES = join(here, "..", "fixtures", "learn", "flows");

describe("harvest", () => {
  it("reads step-level failures out of result events", async () => {
    const { records } = await harvest(FIXTURES);
    const schema = records.filter((r) => r.shape === "schema");
    expect(schema.length).toBeGreaterThan(0);
    for (const record of schema) {
      expect(record.runId).toBeTruthy();
      expect(record.stepId).toBeTruthy();
      expect(record.reason).toContain("code");
      expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("reads flow-level budget failures, which are NOT result events", async () => {
    // The transient class lives only in budget_exhausted events + the run's top-level
    // failure context. A reader that only consumes result events yields zero of these,
    // and the classifier then has no negative class to be tested against.
    const { records } = await harvest(FIXTURES);
    const budget = records.filter((r) => r.shape === "budget");
    expect(budget.length).toBeGreaterThan(0);
    for (const record of budget) expect(record.stepId).toBeNull();
  });

  it("carries project attribution and spec identity", async () => {
    const { records } = await harvest(FIXTURES);
    const attributed = records.filter((r) => r.workspaceRoot !== undefined);
    expect(attributed.length).toBeGreaterThan(0);

    // The enum cluster is the one real lesson in the corpus: one project, one flow.
    const enumRecords = records.filter((r) => r.reason.includes("invalid_enum_value"));
    expect(enumRecords.length).toBe(14);
    expect(new Set(enumRecords.map((r) => r.workspaceRoot)).size).toBe(1);
    expect(new Set(enumRecords.map((r) => r.flowName))).toEqual(new Set(["build"]));
    // Two runs, two different spec revisions — the reason specDigest is never keyed.
    expect(new Set(enumRecords.map((r) => r.specDigest)).size).toBe(2);
  });

  it("keeps the 155x ship_gsd noise attributable to its ephemeral workspaces", async () => {
    // These must survive harvest (they are real failures) and be killed later by
    // attribution in S2 — harvest does not get to decide what is signal.
    const { records } = await harvest(FIXTURES);
    const noise = records.filter((r) => r.stepId === "ship_gsd");
    expect(noise.length).toBeGreaterThan(0);
    expect(new Set(noise.map((r) => r.workspaceRoot)).size).toBe(noise.length);
    for (const record of noise) expect(record.workspaceRoot).toContain("gsd-stuck-resume-");
  });

  it("is fail-open: malformed runs are skipped and counted, never thrown", async () => {
    const { records, skipped, droppedEvents } = await harvest(FIXTURES);
    expect(skipped).toBeGreaterThanOrEqual(1); // truncated.json — unparseable
    // drifted.json parses but carries a failure-shaped event that is unusable. It must
    // be counted, not silently discarded: a reader that drops events while reporting a
    // clean read is the exact failure mode fail-open invites.
    expect(droppedEvents).toBeGreaterThanOrEqual(1);
    expect(records.length).toBeGreaterThan(0);
  });

  it("returns an empty result for a missing directory rather than throwing", async () => {
    const { records, skipped, droppedEvents } = await harvest(join(FIXTURES, "does-not-exist"));
    expect(records).toEqual([]);
    expect(skipped).toBe(0);
    expect(droppedEvents).toBe(0);
  });

  it("is deterministic across repeated reads", async () => {
    const a = await harvest(FIXTURES);
    const b = await harvest(FIXTURES);
    expect(JSON.stringify(a.records)).toBe(JSON.stringify(b.records));
  });
});
