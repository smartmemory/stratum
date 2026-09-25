import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { respondToServerRequest } from "../../src/connectors/codex-appserver-driver.js";
const { assessExecBaseline, assessServerRequests, serverRequestTriggers, requiredServerMethods, requiredCases, assessSummary, assessPreflight, assessSandboxCase, sandboxExpectations, assessProcessCase, assessTool, signalShimSource } = await import(resolve("scripts/peer3-probe.mjs"));
const enabled = process.env.STRATUM_LIVE_PEER3 === "1";
describe.skipIf(!enabled)("server requests real-server evidence", () => {
  it("requires proven transcripts or recorded unreached triggers and rejects answered failures", async () => {
    const root = process.env.STRATUM_PEER3_EVIDENCE;
    if (!root) throw new Error("STRATUM_PEER3_EVIDENCE is required for the explicit live gate");
    let reportRoot = join(root, "server-requests");
    try { await access(join(reportRoot, "report.json")); } catch { reportRoot = root; }
    const report = JSON.parse(await readFile(join(reportRoot, "report.json"), "utf8"));
    expect(report.mode).toBe("server-requests"); expect(report.error).toBeUndefined();
    expect(report.codex.code).toBe(0); expect(report.codex.stdout).toContain("0.155.1");
    const runs = [];
    for (const run of report.runs) {
      const evidence = JSON.parse(await readFile(join(reportRoot, run.file), "utf8"));
      expect(evidence.claim).toBe(run.claim);
      expect(evidence.trigger).toEqual(run.trigger);
      expect(serverRequestTriggers).toContainEqual(run.trigger);
      // The transcript must show the advertised configuration and actual prompt.
      const client = evidence.transcript.filter((e: any) => e.direction === "client").map((e: any) => e.frame);
      expect(client.find((f: any) => f.method === "thread/start")?.params.approvalPolicy).toBe(run.trigger.approvalPolicy);
      const turn = client.find((f: any) => f.method === "turn/start");
      expect(client.find((f: any) => f.method === "thread/start")?.params.sandbox).toBe(run.trigger.filesystemMode);
      expect(turn?.params).not.toHaveProperty("sandboxPolicy");
      expect(turn?.params.input).toContainEqual({ type: "text", text: run.trigger.prompt, text_elements: [] });
      runs.push({ ...evidence, file: run.file });
    }
    expect(report.methods).toEqual(assessServerRequests(runs, respondToServerRequest));
  });
});

function evidenceRuns() {
  return serverRequestTriggers.map((trigger: any, index: number) => ({ trigger, file: `run-${index}.json`, claim: "completed", transcript: [] as any[] }));
}
it("evidence gate records unreached methods and requires a dedicated patch approval trigger", () => {
  const runs = evidenceRuns();
  const result = assessServerRequests(runs, respondToServerRequest);
  expect(result.map((r: any) => r.method)).toEqual(requiredServerMethods);
  expect(result.every((r: any) => r.status === "unreached" && r.triggers.length)).toBe(true);
  expect(serverRequestTriggers).toContainEqual(expect.objectContaining({
    methods: ["item/fileChange/requestApproval", "applyPatchApproval"], approvalPolicy: "on-request", filesystemMode: "read-only", prompt: expect.stringContaining("apply_patch"),
  }));
  expect(() => assessServerRequests(runs.slice(0, 1), respondToServerRequest)).toThrow("no recorded trigger");
});
it.each(["failed", "cancelled", "missing-terminal", "error-after-reply", "bad-reply", "missing-reply", "completed"])("evidence gate checks every elicited reply: %s", mode => {
  const runs = evidenceRuns(), method = "item/fileChange/requestApproval", run = runs[1];
  run.claim = ["failed", "cancelled"].includes(mode) ? mode : "completed";
  run.transcript = [
    { direction: "server", frame: { id: "approval", method } },
    ...(mode === "missing-reply" ? [] : [{ direction: "client", frame: { id: "approval", ...(mode === "bad-reply" ? { result: {} } : respondToServerRequest(method)) } }]),
    ...(mode === "missing-terminal" ? [] : [{ direction: "server", frame: { method: "turn/completed", params: { turn: { status: "completed" } } } }]),
    ...(mode === "error-after-reply" ? [{ direction: "server", frame: { method: "error", params: { message: "invalid reply" } } }] : []),
  ];
  if (mode !== "completed") expect(() => assessServerRequests(runs, respondToServerRequest)).toThrow();
  else expect(assessServerRequests(runs, respondToServerRequest).find((r: any) => r.method === method)).toEqual({ method, status: "proven", evidence: [{ file: "run-1.json", request: 0, reply: 1, terminal: 2 }] });
});


describe.skipIf(!enabled)("S5a real production evidence", () => {
  it.each(["preflight", "sandbox", "process-tree"])("validates %s and every referenced artifact", async mode => {
    const base = process.env.STRATUM_PEER3_EVIDENCE;
    if (!base) throw new Error("STRATUM_PEER3_EVIDENCE is required for the explicit live gate");
    const root = join(base, mode), summary = JSON.parse(await readFile(join(root, "summary.json"), "utf8"));
    expect(assessSummary(summary, mode)).toBe(true);
    for (const entry of summary.cases) {
      for (const path of entry.evidence) expect((await readFile(join(root, path))).length).toBeGreaterThan(0);
      const data = JSON.parse(await readFile(join(root, `${entry.case}.json`), "utf8"));
      expect(data.error).toBeUndefined();
      if (mode === "preflight") expect(assessPreflight(entry.case, data, "0.155.1")).toBe(true);
      if (mode === "sandbox") {
        assessSandboxCase(entry.case, data);
        if (entry.case.startsWith("temp-")) {
          const baseline = JSON.parse(await readFile(join(root, "exec-baseline/report.json"), "utf8"));
          const raw = Object.fromEntries(await Promise.all(["built-in", "ordinary", "override"].map(async mode =>
            [mode, JSON.parse(await readFile(join(root, `exec-baseline/${mode}.json`), "utf8"))])));
          const observed = assessExecBaseline(baseline, raw)[entry.case.slice(5)];
          for (const key of ["TMPDIR", "slashTmp"]) {
            expect(data.observed[key]).toBe(observed[key]);
            expect(data.tempComparison[key]).toEqual({ exec: observed[key], appServer: data.observed[key] });
          }
        }
      }
      if (mode === "process-tree") expect(assessProcessCase(entry.case, data)).toBe(true);
    }
  });
});

function validSummary(mode: string) {
  return { mode, cases: requiredCases[mode].map((name: string) => ({ case: name, outcome: "passed", evidence: [`${name}.json`], exitCode: 0, timings: { elapsedMs: 1 } })) };
}
it.each(["failed", "unreached", "skipped"])("S5a gate never accepts %s", outcome => {
  const s = validSummary("sandbox"); s.cases[0].outcome = outcome;
  expect(() => assessSummary(s, "sandbox")).toThrow();
});
it("S5a gate rejects missing, duplicate, unsafe and invalid evidence", () => {
  expect(assessSummary(validSummary("preflight"), "preflight")).toBe(true);
  for (const mutate of [
    (s: any) => s.cases.pop(), (s: any) => s.cases[0] = s.cases[1],
    (s: any) => s.cases[0].evidence = ["../escape"], (s: any) => s.cases[0].exitCode = 1,
    (s: any) => s.cases[0].timings.elapsedMs = -1,
  ]) { const s = validSummary("preflight"); mutate(s); expect(() => assessSummary(s, "preflight")).toThrow(); }
});
it("preflight requires exact pin and positive login classification", () => {
  expect(assessPreflight("codex-version", { code: 0, stdout: "codex-cli 0.155.1\n" }, "0.155.1")).toBe(true);
  for (const stdout of ["codex-cli 0.155.10", "codex-cli 0.155.1 modified", ""]) expect(assessPreflight("codex-version", { code: 0, stdout }, "0.155.1")).toBe(false);
  expect(assessPreflight("login", { code: 0, authenticated: false }, "0.155.1")).toBe(false);
});
it("tool assessment ignores model prose and rejects bad exit/duplicate tools", () => {
  const item = { type: "item.completed", item: { type: "command_execution", exit_code: 0, aggregated_output: 'N={"outside":{"writable":false,"code":"EPERM"}}' } };
  expect(assessTool([item], "N").outside.writable).toBe(false);
  expect(() => assessTool([{ type: "item.completed", item: { type: "agent_message", text: item.item.aggregated_output } }], "N")).toThrow();
  expect(() => assessTool([item, item], "N")).toThrow();
  expect(() => assessTool([{ ...item, item: { ...item.item, exit_code: 1 } }], "N")).toThrow();
  for (const key of ["workspace", "writableRoot", "TMPDIR", "slashTmp"]) {
    const result = JSON.parse(item.item.aggregated_output.slice(2)); result[key] = { writable: true };
    item.item.aggregated_output = "N=" + JSON.stringify(result);
  }
  const data = { poll: { status: "complete" }, records: [item], nonce: "N", policy: { filesystemMode: "workspace-write", networkAccess: false, approvalPolicy: "never" }, osWritableOutside: true,
    observed: { outside: false, workspace: true, writableRoot: true, TMPDIR: true, slashTmp: true } };
  expect(assessSandboxCase("workspace-write", data).outside.writable).toBe(false);
  expect(() => assessSandboxCase("workspace-write", { ...data, observed: { outside: true } })).toThrow();
});
it("process assessment rejects leaks, multiple outcomes and missing race barriers", () => {
  const data = { signalMode: "native-signal", action: { kind: "cancel", time: 4000, records: [{ type: "turn.started" }] }, records: [{ type: "turn.started" }], poll: { status: "error", reason: "child_died_without_sentinel" }, pids: ["driver", "app-server"].map((role, i) => ({ role, pid: 100 + i, pgid: 100, start: "123", after: "dead" })), activeBeforeAction: true, events: [], cancel: { status: "cancelled" } };
  expect(assessProcessCase("cancel-active", data)).toBe(true);
  expect(() => assessProcessCase("cancel-active", { ...data, records: [], action: { ...data.action, records: [] } })).toThrow("Missing active turn before action");
  expect(() => assessProcessCase("cancel-active", { ...data, records: [{ __t2f5_done__: 0 }] })).toThrow();
  expect(() => assessProcessCase("cancel-active", { ...data, pids: data.pids.map(p => ({ ...p, after: "unknown" })) })).toThrow();
  expect(() => assessProcessCase("cancel-pending-steer", data)).toThrow();
  const complete = { ...data, records: [{ __t2f5_done__: 0 }], poll: { status: "complete" } };
  expect(() => assessProcessCase("completion-wins", complete)).toThrow();
  expect(() => assessProcessCase("parent-death", complete)).toThrow();
  expect(signalShimSource()).toContain("os.execv(real");
});

it("temp expectations follow exec observations and still reject app-server differences", () => {
  for (const mode of ["built-in", "ordinary", "override"]) {
    for (const allowed of [true, false]) {
      const name = `temp-${mode}`;
      const observed = { workspace: true, writableRoot: true, outside: false, TMPDIR: allowed, slashTmp: allowed };
      expect(sandboxExpectations(name, observed)).toEqual(observed);
      const results = Object.fromEntries(Object.entries(observed).map(([key, writable]) => [key, writable ? { writable } : { writable, code: "EPERM" }]));
      const data = { poll: {status: "complete"}, policy: {filesystemMode: "workspace-write", networkAccess: false, approvalPolicy: "never"},
        osWritableOutside: true, nonce: "N", observed,
        tempComparison: { TMPDIR: {exec: allowed, appServer: allowed}, slashTmp: {exec: allowed, appServer: allowed} },
        records: [{type: "item.completed", item: {type: "command_execution", exit_code: 0, aggregated_output: "N=" + JSON.stringify(results)}}] };
      expect(() => assessSandboxCase(name, data)).not.toThrow();
      for (const key of ["TMPDIR", "slashTmp"]) {
        expect(() => assessSandboxCase(name, {...data, observed: {...observed, [key]: !allowed}})).toThrow("Write enforcement mismatch");
      }
    }
  }
  expect(() => sandboxExpectations("temp-override")).toThrow("Missing exec temp baseline");
  expect(sandboxExpectations("workspace-write").TMPDIR).toBe(true);
  expect(sandboxExpectations("read-only").TMPDIR).toBe(false);
});

// Synthetic retained-artifact fixtures. Each negative starts from the passing set.
const baselineFixture = JSON.parse(await readFile(resolve("tests/fixtures/peer3-s5a/baseline.json"), "utf8"));
const pendingFixture = JSON.parse(await readFile(resolve("tests/fixtures/peer3-s5a/pending-steer.json"), "utf8"));
function changeRaw(f: any, mutate: (records: any[]) => void) {
  const records = f.raw.ordinary.stdout.split("\n").map(JSON.parse);
  mutate(records);
  f.raw.ordinary.stdout = records.map((r: any) => JSON.stringify(r)).join("\n");
}
const baselineFailures: [string, (f: any) => void][] = [
  ["Baseline report error", f => f.report.error = "failed"],
  ["Baseline modes", f => f.report.mode = "other"],
  ["Baseline exit", f => f.raw.ordinary.code = 1],
  ["Baseline reason", f => f.raw.ordinary.reason = "timeout"],
  ["Baseline raw error/signal", f => f.raw.ordinary.signal = "SIGTERM"],
  ["Baseline turn completion", f => changeRaw(f, r => r.pop())],
  ["Baseline failed record", f => changeRaw(f, r => r.push({ type: "turn.failed" }))],
  ["Missing unique successful tool execution", f => changeRaw(f, r => r.splice(1, 1))],
  ["Missing unique successful tool execution", f => changeRaw(f, r => r.push(r[1]))],
  ["Missing unique successful tool execution", f => changeRaw(f, r => r[1].item.exit_code = 1)],
  ["Ambiguous tool result", f => changeRaw(f, r => r[1].item.aggregated_output += "\n" + r[1].item.aggregated_output)],
  ["Baseline tool status", f => changeRaw(f, r => r[1].item.status = "failed")],
  ["Baseline tool metadata", f => f.report.runs[1].toolRecords = []],
  ["Baseline result metadata", f => f.report.runs[1].results.TMPDIR.writable = false],
  ["Baseline boolean observation", f => {
    const r = f.report.runs[1]; r.results.TMPDIR.writable = "yes"; r.observed.TMPDIR = "yes";
    changeRaw(f, records => { records[1].item.aggregated_output = "PEER3_TOOL_RESULTS=" + JSON.stringify(r.results); r.toolRecords = [records[1]]; });
  }],
  ["Baseline host observation mismatch", f => f.report.runs[1].observed.TMPDIR = false],
  ["Baseline comparison metadata", f => f.report.comparison.TMPDIR.ordinary = false],
  ["Baseline parity metadata", f => f.report.parityPrerequisite = false],
];
it("r1 accepts independently rederived baseline and rejects malformed stdout", () => {
  expect(assessExecBaseline(baselineFixture.report, baselineFixture.raw).override.TMPDIR).toBe(false);
  const f = structuredClone(baselineFixture); f.raw.ordinary.stdout = "not json";
  expect(() => assessExecBaseline(f.report, f.raw)).toThrow();
});
it.each(baselineFailures)("r1 baseline: %s", (message, mutate) => {
  const f = structuredClone(baselineFixture);
  expect(() => assessExecBaseline(f.report, f.raw)).not.toThrow();
  mutate(f); expect(() => assessExecBaseline(f.report, f.raw)).toThrow(message);
});
const processFailures: [string, (f: any) => void][] = [
  ["Wrong signal label", f => f.signalMode = "native-signal"],
  ["Missing recorded action boundary", f => delete f.action],
  ["Missing recorded action boundary", f => f.action.kind = "driver-sigkill"],
  ["Missing recorded action boundary", f => delete f.action.time],
  ["Action records disagree with retained prefix", f => f.action.records[0].thread_id = "other"],
  ["Missing active turn before action", f => { f.records = []; f.action.records = []; }],
  ["Missing active turn before action", f => f.action.records = f.records.slice(0, 1)],
  ["Turn completed before action", f => { f.records.push({ type: "turn.completed" }); f.action.records = structuredClone(f.records); }],
  ["Missing sent message", f => f.sentFrame.type = "control"],
  ["Missing steer request", f => f.ipc.splice(1, 1)],
  ["Steer message mismatch", f => f.ipc[1].message.msgId = "other"],
  ["Steer active turn mismatch", f => f.ipc[1].message.expectedTurnId = "other"],
  ["Steer active turn mismatch", f => f.ipc.shift()],
  ["Steer thread mismatch", f => f.ipc[0].message.threadId = "other"],
  ["Steer run mismatch", f => f.ipc[1].message.runId = "other"],
  ["Missing correlated steer result", f => f.ipc.pop()],
  ["Missing correlated steer result", f => f.ipc[2].message.reqId = "other"],
  ["Missing correlated steer result", f => f.ipc[2].direction = "sidecar-to-driver"],
  ["Wrong steer result", f => f.ipc[2].message.outcome = "delivered"],
  ["Wrong steer result", f => f.ipc[2].message.detail = "other"],
  ["Wrong steer IPC ordering", f => f.ipc[0].time = 2500],
  ["Wrong steer IPC ordering", f => f.ipc.unshift(f.ipc.pop())],
  ["Wrong steer action ordering", f => f.events[0].time = 4],
  ["Wrong steer action ordering", f => f.events.shift()],
  ["Wrong steer action ordering", f => f.action.time = 2500],
  ["Wrong steer action ordering", f => f.ipc[2].time = 3500],
  ["Unauthenticated callback", f => f.callbackFrames[0].authenticated = false],
  ["Unauthenticated callback", f => f.callbackFrames.shift()],
  ["Missing correlated dropped callback", f => f.callbackFrames[1].orig_msg_id = "other"],
  ["Missing correlated dropped callback", f => f.callbackFrames[1].status = "delivered"],
  ["Missing correlated dropped callback", f => f.callbackFrames[1].status_detail = "other"],
];
it.each(processFailures)("r1 pending steer: %s", (message, mutate) => {
  const f = structuredClone(pendingFixture);
  expect(assessProcessCase("cancel-pending-steer", f)).toBe(true);
  mutate(f); expect(() => assessProcessCase("cancel-pending-steer", f)).toThrow(message);
});
it.each(["cancel-active", "driver-sigkill", "parent-death", "completion-wins", "cancellation-wins"])("r1 active records and labels: %s", name => {
  const f = structuredClone(pendingFixture);
  f.signalMode = ["completion-wins", "cancellation-wins"].includes(name) ? "controlled-shim" : "native-signal";
  f.action.kind = name === "parent-death" ? "parent-sigkill" : name === "driver-sigkill" ? "driver-sigkill" : "cancel";
  if (["parent-death", "completion-wins"].includes(name)) {
    f.records.push({ type: "turn.completed" }, { __t2f5_done__: 0 }); f.poll.status = "complete";
    f.parentGone = true; f.driverAliveAfterParentDeath = true;
  }
  if (name === "completion-wins") {
    f.action.records.push({ type: "turn.completed" }); f.completedBeforeCancel = true; f.sentinelBeforeCancel = false;
  }
  if (name === "cancellation-wins") f.events.push({ event: "held-completion" });
  expect(assessProcessCase(name, f)).toBe(true);
  const wrong = structuredClone(f); wrong.signalMode = f.signalMode === "native-signal" ? "controlled-shim" : "native-signal";
  expect(() => assessProcessCase(name, wrong)).toThrow("Wrong signal label");
  if (name === "completion-wins") {
    f.action.records.pop(); expect(() => assessProcessCase(name, f)).toThrow("Missing completion before cancel");
  } else {
    f.action.records = []; expect(() => assessProcessCase(name, f)).toThrow("Missing active turn before action");
  }
});
