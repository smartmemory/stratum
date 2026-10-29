import type { DataClient, GateResolution, PendingGate, ResolveGateRequest, RunDetail, RunSummary } from "../src/data-client";

/** A persisted run document in the engine's shape (ts/src/engine/state.ts PersistedRun). */
export function persistedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-aaaa1111",
    flowName: "review",
    status: "running",
    rounds: 1,
    flowSpent: { dispatches: 2, usd: 0.42, tokens: 900, ms: 3000 },
    input: { topic: "x" },
    spec: {
      version: 1,
      contracts: {},
      flows: {
        entry: "review",
        review: {
          max_rounds: 3,
          steps: [
            { id: "draft", do: "write a draft about ${input.topic}" },
            { id: "critique", do: "critique ${draft.output.text}" },
            { id: "approve", after: ["critique"], gate: { on_approve: null, on_revise: "draft", on_kill: null } },
          ],
        },
      },
    },
    steps: {
      draft: { status: "succeeded", attempts: [{ attempt: 1, at: "2026-10-30T01:00:01Z", result: { text: "d" }, model: "sonnet", durationMs: 1200 }], output: { text: "d" }, spent: { usd: 0.2 }, dispatchToken: "secret-dispatch" },
      critique: { status: "succeeded", attempts: [{ attempt: 1, at: "2026-10-30T01:00:05Z", result: "ok" }], spent: { usd: 0.22 } },
      approve: { status: "waiting_gate", attempts: [], gateToken: "tok-1", spent: {} },
    },
    events: [
      { at: "2026-10-30T01:00:00Z", type: "planned" },
      { at: "2026-10-30T01:00:00Z", type: "ready", stepId: "draft" },
      { at: "2026-10-30T01:00:02Z", type: "result", stepId: "draft" },
      { at: "2026-10-30T01:00:03Z", type: "ready", stepId: "critique" },
      { at: "2026-10-30T01:00:06Z", type: "result", stepId: "critique" },
      { at: "2026-10-30T01:00:07Z", type: "gate_waiting", stepId: "approve" },
    ],
    receipts: [{ seq: 1 }],
    ...overrides,
  };
}

const summary: RunSummary = {
  id: "run-aaaa1111", flowName: "review", status: "running", displayStatus: "awaiting_gate",
  stepCount: 3, completedSteps: 2, currentStepId: "approve", round: 1,
  startedAt: "2026-10-30T01:00:00Z", updatedAt: "2026-10-30T01:00:07Z", spent: { usd: 0.42 }, waitingGates: 1,
};

export const fakeDetail: RunDetail = {
  ...summary,
  steps: [
    { id: "draft", kind: "do", do: "write a draft" },
    { id: "critique", kind: "do", do: "critique ${draft.output.text}" },
    { id: "approve", kind: "gate", after: ["critique"], gate: { on_approve: null, on_revise: "draft", on_kill: null } },
  ],
  stepStates: {
    draft: { status: "succeeded", attempts: [{ attempt: 1, at: "2026-10-30T01:00:01Z", result: "d", model: "sonnet", durationMs: 1200 }], output: { text: "d" } },
    critique: { status: "failed", attempts: [{ attempt: 1, at: "2026-10-30T01:00:05Z", failure: { attempt: 1, reason: "ensure failed" } }], failure: { attempt: 1, reason: "ensure failed" } },
    approve: { status: "waiting_gate", attempts: [] },
  },
  events: [
    { at: "2026-10-30T01:00:00Z", type: "planned" },
    { at: "2026-10-30T01:00:07Z", type: "gate_waiting", stepId: "approve" },
  ],
  maxRounds: 3,
};

export const fakeGate: PendingGate = {
  runId: "run-aaaa1111", flowName: "review", stepId: "approve", gateToken: "tok-1",
  onApprove: null, onRevise: "draft", onKill: null, round: 1, maxRounds: 3, reviseEndsRun: false, waitingSince: "2026-10-30T01:00:07Z",
};

/** In-memory DataClient that records every call. */
export function fakeClient(overrides: Partial<DataClient> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const resolved: ResolveGateRequest[] = [];
  const client: DataClient = {
    async listRuns() { calls.push({ method: "listRuns", args: [] }); return [summary, { ...summary, id: "run-bbbb2222", flowName: "build", displayStatus: "failed", status: "failed", waitingGates: 0, currentStepId: null }]; },
    async getRun(runId) { calls.push({ method: "getRun", args: [runId] }); return runId === fakeDetail.id ? fakeDetail : null; },
    async listGates() { calls.push({ method: "listGates", args: [] }); return [fakeGate]; },
    async resolveGate(request): Promise<GateResolution> {
      calls.push({ method: "resolveGate", args: [request] });
      resolved.push(request);
      return { ok: true, runId: request.runId, stepId: request.stepId, outcome: request.action === "reject" ? "kill" : request.action, result: "complete" };
    },
    ...overrides,
  };
  return { client, calls, resolved };
}
