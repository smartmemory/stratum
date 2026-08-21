import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GUARDS_DIR, LedgerEntry, appendLedger, setGuardsDir } from "../../src/guard/store.js";
import { buildFlowTerminalEvent, buildGateResolutionEvent, buildGuardTransitionEvent } from "../../src/policy/events.js";
import type { RuleVerdict, Source } from "../../src/policy/types.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
const source: Source = {
  record_id: "decision-1",
  memory_type: "decision",
  version: 1,
  content_hash: "a".repeat(64),
  chain_hash: "b".repeat(64),
  workspace_id: "workspace-1",
};
const verdict: RuleVerdict = { rule_id: "decision-1#0", source, met: true, predicate_type: "deterministic" };

afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("enforcement event builders", () => {
  it("fills a guard_transition event from a real appended LedgerEntry", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-policy-event-"));
    roots.push(root);
    setGuardsDir(root);
    const entry = new LedgerEntry({
      ts_ms: 1,
      from_state: "draft",
      to_state: "done",
      outcome: "applied",
      kind: "transition",
      resolved_by: "agent",
      payload_digest: "c".repeat(64),
    });
    appendLedger("resource-1", entry);
    const event = buildGuardTransitionEvent({
      runId: "run-1",
      bundleId: "d".repeat(64),
      resourceId: "resource-1",
      entry,
      rulesEvaluated: [verdict],
      occurredAt: "2026-08-21T00:00:00.000Z",
    });
    expect(event).toMatchObject({
      event_id: `run-1:${entry.entry_digest}`,
      kind: "guard_transition",
      runner: "local",
      resource_id: "resource-1",
      from_state: "draft",
      to_state: "done",
      outcome: "applied",
      resolved_by: "agent",
      ledger_ref: entry.entry_digest,
      entry_digest: entry.entry_digest,
      prev_digest: "",
      payload_digest: "c".repeat(64),
      rules_evaluated: [verdict],
    });
  });

  it("builds gate_resolution and verdict-carrying flow_terminal events", () => {
    expect(buildGateResolutionEvent({
      runId: "run-1", bundleId: "d".repeat(64), stepId: "review", round: 2,
      outcome: "revise", resolvedByUserId: "user-1", occurredAt: "2026-08-21T00:00:00.000Z",
    })).toMatchObject({
      event_id: "run-1:gate:review:2", kind: "gate_resolution", outcome: "revise",
      resolved_by: "human", resolved_by_user_id: "user-1", rules_evaluated: [],
    });
    expect(buildFlowTerminalEvent({
      runId: "run-1", bundleId: "d".repeat(64), outcome: "completed", rulesEvaluated: [verdict],
      occurredAt: "2026-08-21T00:00:00.000Z",
    })).toMatchObject({
      event_id: "run-1:flow", kind: "flow_terminal", outcome: "completed",
      resolved_by: "agent", rules_evaluated: [verdict],
    });
  });
});
