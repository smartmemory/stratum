import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { createHandler } from "../server/handler.mjs";
// @ts-expect-error untyped .mjs
import { detail, displayStatus, gateResolution, pendingGate, summarize } from "../server/project.mjs";
import { persistedRun } from "./fixtures";

describe("projection (server/project.mjs)", () => {
  it("summarizes and details a persisted run, dropping engine tokens and receipts", () => {
    const run = persistedRun();
    expect(summarize(run)).toMatchObject({
      id: "run-aaaa1111", displayStatus: "awaiting_gate", stepCount: 3, completedSteps: 2,
      currentStepId: "approve", startedAt: "2026-10-30T01:00:00Z", spent: { usd: 0.42 }, waitingGates: 1,
    });
    const view = detail(run);
    expect(view.steps.map((step: { id: string; kind: string }) => `${step.id}:${step.kind}`)).toEqual(["draft:do", "critique:do", "approve:gate"]);
    expect(view.maxRounds).toBe(3);
    const text = JSON.stringify(view);
    expect(text).not.toContain("secret-dispatch");
    expect(text).not.toContain("tok-1");
    expect(text).not.toContain("receipts");
  });

  // engine status | failure | step statuses | expected display
  const rows: Array<[string, unknown, Record<string, string>, string]> = [
    ["completed", undefined, {}, "complete"],
    ["budget_exhausted", undefined, {}, "budget_exhausted"],
    ["failed", { attempt: 0, reason: "gate approve killed flow" }, {}, "killed"],
    ["failed", { attempt: 0, reason: "gate nope killed flow" }, {}, "failed"],
    ["cancelled", undefined, { approve: "waiting_gate" }, "cancelled"],
    ["running", undefined, { approve: "waiting_gate" }, "awaiting_gate"],
    ["running", undefined, { approve: "pending" }, "running"],
  ];
  it.each(rows)("displayStatus %s %j %j → %s", (status, failure, states, expected) => {
    const steps = Object.fromEntries(Object.entries(states).map(([id, s]) => [id, { status: s, attempts: [] }]));
    expect(displayStatus(persistedRun({ status, failure, steps }))).toBe(expected);
  });

  // name | run | now | expected stale
  const T0 = Date.parse("2026-10-30T01:00:07Z");
  const pending = { approve: { status: "pending", attempts: [] } };
  const STALE_ROWS: Array<[string, unknown, number, boolean]> = [
    ["running, event 1 h ago", persistedRun({ steps: pending }), T0 + 3600e3, false],
    ["running, last event 7 h ago", persistedRun({ steps: pending }), T0 + 7 * 3600e3, true],
    ["running, no events", persistedRun({ steps: pending, events: [] }), T0, true],
    ["completed, old", persistedRun({ status: "completed" }), T0 + 40 * 86400e3, false],
    ["awaiting gate, old", persistedRun(), T0 + 40 * 86400e3, false],
  ];
  for (const [name, run, now, expected] of STALE_ROWS) {
    it(`stale: ${name}`, () => {
      const row = summarize(run, now);
      expect(row.stale).toBe(expected);
      expect(row.lastEventAt).toBe(row.updatedAt);
    });
  }

  it("maps CLI gate rows and gate results", () => {
    const gate = pendingGate({ flow_id: "run-aaaa1111", flow_name: "review", step_id: "approve", on_approve: null, on_revise: "draft", on_kill: null, gate_token: "tok-1" }, persistedRun());
    expect(gate).toEqual({ runId: "run-aaaa1111", flowName: "review", stepId: "approve", gateToken: "tok-1", onApprove: null, onRevise: "draft", onKill: null, round: 1, maxRounds: 3, reviseEndsRun: false, waitingSince: "2026-10-30T01:00:07Z" });
    // revise ends the run: no route | no flow max_rounds | flow budget spent | gate budget spent
    const row = { flow_id: "run-aaaa1111", flow_name: "review", step_id: "approve", on_revise: "draft", gate_token: "t" };
    const flows = (flow: object) => ({ entry: "review", review: flow });
    const base = persistedRun();
    const reviseRows: Array<[string, object, boolean]> = [
      ["no route", pendingGate({ ...row, on_revise: null }, base), true],
      ["no flow max_rounds", pendingGate(row, persistedRun({ spec: { ...base.spec, flows: flows({ steps: base.spec.flows.review.steps }) } })), true],
      ["flow budget spent", pendingGate(row, persistedRun({ rounds: 3 })), true],
      ["gate budget spent", pendingGate(row, persistedRun({ spec: { ...base.spec, flows: flows({ max_rounds: 3, steps: [base.spec.flows.review.steps[0], base.spec.flows.review.steps[1], { ...base.spec.flows.review.steps[2], gate: { on_approve: null, on_revise: "draft", on_kill: null, max_rounds: 1 } }] }) }, steps: { ...base.steps, approve: { ...base.steps.approve, iterations: 1 } } })), true],
      ["rounds left", pendingGate(row, base), false],
    ];
    for (const [name, gateView, expected] of reviseRows) expect([name, (gateView as { reviseEndsRun: boolean }).reviseEndsRun]).toEqual([name, expected]);
    expect(gateResolution(0, JSON.stringify({ ok: true, flow_id: "r", step_id: "s", outcome: "approve", result: "complete" }))).toEqual({ ok: true, runId: "r", stepId: "s", outcome: "approve", result: "complete" });
    expect(gateResolution(2, JSON.stringify({ conflict: true, detail: "Flow is already complete" }))).toMatchObject({ ok: false, kind: "conflict" });
    expect(gateResolution(1, JSON.stringify({ error: { code: "INVALID", message: "stale gate token" } }))).toMatchObject({ ok: false, kind: "error", code: "INVALID" });
    expect(gateResolution(2, "")).toMatchObject({ ok: false, code: "USAGE" });
  });
});

describe("HTTP handler (server/handler.mjs)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stratum-ui-test-"));
    writeFileSync(join(dir, "run-aaaa1111.json"), JSON.stringify(persistedRun()));
    writeFileSync(join(dir, "junk.json"), "{}");
    const handler = createHandler({ flowsDir: dir, stratumBin: join(dir, "missing-stratum.js") });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists runs (skipping non-runs), returns detail, 404s unknown runs, rejects bad ids", async () => {
    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs.map((run: { id: string }) => run.id)).toEqual(["run-aaaa1111"]);
    expect((await (await fetch(`${base}/api/runs/run-aaaa1111`)).json()).steps).toHaveLength(3);
    expect((await fetch(`${base}/api/runs/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/runs/..%2Fetc`)).status).toBe(400);
  });

  it("refuses gate posts that are not JSON or lack a token, before touching the CLI", async () => {
    const url = `${base}/api/gates/run-aaaa1111/approve/approve`;
    expect((await fetch(url, { method: "POST", body: "gateToken=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await fetch(url, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await fetch(`${base}/api/gates/run-aaaa1111/approve/launch`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});
