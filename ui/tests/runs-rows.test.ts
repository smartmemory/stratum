import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs server module, no declarations (same as server.test.ts)
import { disambiguate, expiryCandidates, runLabel, summarize } from "../server/project.mjs";
import { persistedRun } from "./fixtures";

const DAY = 86400e3;
const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const pending = { approve: { status: "pending", attempts: [] } };
const gated = { approve: { status: "waiting_gate", attempts: [] } };
const events = (msAgo: number) => [{ at: at(msAgo + 1000), type: "planned" }, { at: at(msAgo), type: "result", stepId: "draft" }];

describe("run row labels, stale rule and expiry", () => {
  // name | input | expected text | expected source
  const LABELS: Array<[string, unknown, string, string]> = [
    ["description wins", { description: "  Build  the\nrunner ", goal: "g", featureCode: "F-1" }, "Build the runner", "input.description"],
    ["goal", { goal: "ship it", featureCode: "F-1" }, "ship it", "input.goal"],
    ["task", { task: "fix the bug" }, "fix the bug", "input.task"],
    ["non-string field skipped", { description: { a: 1 }, task: "t" }, "t", "input.task"],
    ["feature code", { featureCode: "COMP-X-1", gateCommands: ["x"] }, "COMP-X-1", "input.featureCode"],
    ["first step id", { topic: "x" }, "draft", "flow.steps[0].id"],
    ["long text cut", { goal: "w".repeat(300) }, `${"w".repeat(99)}…`, "input.goal"],
  ];
  for (const [name, input, text, source] of LABELS) {
    it(`label: ${name}`, () => expect(runLabel(persistedRun({ input }))).toEqual({ text, source }));
  }

  it("label falls back to the flow name when the spec has no steps", () => {
    expect(runLabel(persistedRun({ input: {}, spec: { version: 1, contracts: {}, flows: {} } }))).toEqual({ text: "review", source: "flowName" });
  });

  it("disambiguate adds the feature code, then date, then time, then id, only where labels repeat", () => {
    const row = (id: string, label: string, featureCode: string | null, startedAt: string) =>
      ({ ...summarize(persistedRun({ id })), id, label, featureCode, startedAt });
    const rows = [
      row("aaaaaaaa-1", "gsd", "F-1", "2026-10-01T10:00:00Z"),
      row("bbbbbbbb-2", "gsd", "F-2", "2026-10-01T10:00:00Z"),
      row("cccccccc-3", "same", null, "2026-10-01T10:00:00Z"),
      row("dddddddd-4", "same", null, "2026-10-02T10:00:00Z"),
      row("eeeeeeee-5", "same", null, "2026-10-02T11:30:00Z"),
      row("ffffffff-6", "same", null, "2026-10-02T11:30:00Z"),
      row("gggggggg-7", "alone", "F-9", "2026-10-02T11:30:00Z"),
    ];
    const labels = disambiguate(rows).map((r: { label: string }) => r.label);
    expect(labels).toEqual([
      "gsd · F-1", "gsd · F-2",
      "same · 2026-10-01", "same · 2026-10-02 · 10:00", "same · 2026-10-02 · 11:30 · eeeeeeee", "same · 2026-10-02 · 11:30 · ffffffff",
      "alone",
    ]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(rows[0].label).toBe("gsd"); // input rows (the handler's cache) are untouched
  });

  // name | run | stale | expiry candidate
  const STATE_ROWS: Array<[string, unknown, boolean, boolean]> = [
    ["running, 1 h", persistedRun({ steps: pending, events: events(3600e3) }), false, false],
    ["running, 8 d", persistedRun({ steps: pending, events: events(8 * DAY) }), true, false],
    ["running, 31 d", persistedRun({ steps: pending, events: events(31 * DAY) }), true, true],
    ["running, no events", persistedRun({ steps: pending, events: [] }), true, false],
    ["gated, 6 d", persistedRun({ steps: gated, events: events(6 * DAY) }), false, false],
    ["gated, 8 d", persistedRun({ steps: gated, events: events(8 * DAY) }), true, false],
    ["gated, 77 d", persistedRun({ steps: gated, events: events(77 * DAY) }), true, false],
    ["completed, 77 d", persistedRun({ status: "completed", events: events(77 * DAY) }), false, false],
  ];
  for (const [name, run, stale, expires] of STATE_ROWS) {
    it(`state: ${name}`, () => {
      expect(summarize(run, NOW).stale).toBe(stale);
      expect(expiryCandidates([run], NOW).length === 1).toBe(expires);
    });
  }

  it("expiry reason names the last event date", () => {
    const run = persistedRun({ id: "old", steps: pending, events: events(31 * DAY) });
    expect(expiryCandidates([run], NOW)).toEqual([{ id: "old", lastEventAt: at(31 * DAY), reason: `expired: no event since ${at(31 * DAY).slice(0, 10)}` }]);
  });
});
