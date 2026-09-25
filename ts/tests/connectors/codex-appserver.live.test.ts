import { readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { respondToServerRequest } from "../../src/connectors/codex-appserver-driver.js";
const { scoreServerRequests, assessLiveRows, assessGolden, assessIdentities, extractController, loadGolden, verifyEvidence, goldenTraceSource, assessExecBaseline, assessServerRequests, serverRequestTriggers, requiredServerMethods, requiredCases, assessSummary, assessPreflight, assessSandboxCase, sandboxExpectations, assessProcessCase, assessTool, signalShimSource } = await import(resolve("scripts/peer3-probe.mjs"));
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
    expect(["passed", "passed-amended"]).toContain(scoreServerRequests(report.methods).status);
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

const goldenFixture = JSON.parse(await readFile(resolve("tests/fixtures/peer3-s5b/golden.json"), "utf8"));
// Complete the compact synthetic fixture with the raw provenance now required.
goldenFixture.rollout[1].payload.turn_id = "turn";
for (const [index, time] of [[2, 1150], [3, 1300]] as const) {
  goldenFixture.rollout[index].timestamp = new Date(time).toISOString();
  goldenFixture.rollout[index].payload.internal_chat_message_metadata_passthrough = {turn_id: "turn", content_item_kinds: ["user.text"]};
}
goldenFixture.rollout.push({type: "event_msg", timestamp: new Date(1900).toISOString(), payload: {type: "task_complete", turn_id: "turn"}});
Object.assign(goldenFixture.second.sentFrame, {type: "user", from: "uds:/tmp/probe.sock", message: {role: "user", content: "Keep waiting."}});
goldenFixture.second.senderReplies = [];
goldenFixture.wire.push(
  {time: 2110, direction: "in", frame: structuredClone(goldenFixture.second.sentFrame)},
  {time: 2120, direction: "out", frame: structuredClone(goldenFixture.second.callbackFrames[1])},
);
const goldenFailures: [string, (f: any) => void][] = [
  ["Golden state identity", f => f.state.peer.name = "other"],
  ["Marker in original prompt", f => f.prompt += f.state.marker],
  ["Golden poll incomplete", f => f.poll.status = "running"],
  ["Golden concatenated output/marker", f => f.poll.text = "wrong"],
  ["Golden concatenated output/marker", f => { f.records[4].item.text = "no marker"; f.poll.text = "Got: no marker"; }],
  ["Golden bounded tool command", f => f.records[2].item.exit_code = 1],
  ["Golden requires exactly one successful turn", f => f.records.push({type: "turn.started"})],
  ["Golden requires exactly one successful turn", f => f.records.pop()],
  ["Golden nonzero accounting", f => f.poll.split.input = 0],
  ["Golden nonzero accounting", f => f.poll.usdSource = "reported"],
  ["Golden rollout thread", f => f.rollout[0].payload.id = "other"],
  ["Golden model-visible rollout marker", f => f.rollout.pop()],
  ["Golden model-visible rollout marker", f => f.rollout[3].payload.role = "assistant"],
  ["Golden rollout second turn", f => f.rollout.push(f.rollout[1])],
  ["Golden steer request", f => f.ipc[1].message.text = "other"],
  ["Golden active steer result", f => f.ipc[2].message.outcome = "ack"],
  ["Golden active steer result", f => f.ipc[1].message.expectedTurnId = "other"],
  ["Golden active steer result", f => f.ipc.splice(1, 0, {time: 1150, direction: "driver-to-sidecar", message: {type: "active-turn-state", runId: "run", threadId: "thread", turnId: null}})],
  ["Golden controller marker tool", f => f.controller[0].input.to = "other"],
  ["Golden delivered callback, not ack", f => f.wire[1].frame.status = "ack"],
  ["Golden controller delivery notice", f => f.controller.splice(2, 1)],
  ["Golden delivered callback, not ack", f => f.controller[1].content = JSON.stringify({success: true, msg_id: "other"})],
  ["Golden exactly one idle notice", f => f.controller.push(f.controller[3])],
  ["Golden exactly one idle notice", f => f.wire.push(f.wire[3])],
  ["Golden exactly one idle notice", f => f.controller.pop()],
  ["Golden idle correlation", f => f.wire[3].frame.orig_msg_id = "other"],
  ["Golden lifecycle ordering", f => f.wire[1].time = 1000],
  ["Golden from_mode echo", f => delete f.wire[3].frame.from_mode],
  ["Golden from_mode echo", f => f.wire[0].frame.message.content = f.state.marker],
  ["Golden from_mode echo", f => f.wire[3].frame.from_mode = "plan"],
  ["Golden from_mode echo", f => f.wire[0].frame.message.content = f.wire[0].frame.message.content.replace('from-mode="bypass"', 'from-mode="plan"')],
  ["Golden controller delivery notice", f => f.controller[2].text = f.controller[2].text.replace("100.sock", "999.sock")],
  ...["held", "refused", "expired"].map(status => ["Golden controller delivery notice", (f: any) => f.controller[2].text = f.controller[2].text.replace("approved and released", status)] as [string, (f: any) => void]),
  ["Golden controller delivery notice", f => f.controller.push({...f.controller[2], text: f.controller[2].text.replace("approved and released", "held")})],
  ["Golden controller delivery notice", f => f.controller[2].role = "assistant"],
  ["Golden controller delivery ordering", f => f.controller[2].time = 1100],
  ["Golden controller delivery ordering", f => [f.controller[1], f.controller[2]] = [f.controller[2], f.controller[1]]],
  ["Golden conflicting delivery status", f => f.wire.push({...f.wire[1], frame: {...f.wire[1].frame, status: "refused"}})],
  ["Golden delivered callback, not ack", f => f.wire[0].frame.msg_id = "other"],
  ["Golden delivered callback, not ack", f => f.wire[1].frame.orig_msg_id = "other"],
  ["Golden exactly one idle notice", f => f.controller[3].role = "assistant"],
  ["Golden controller idle completion", f => f.controller[3].time = 1800],
  ["Golden controller idle completion", f => f.wire[3].frame.from = "uds:/tmp/other.sock"],
  ["Golden post-completion refusal", f => f.second.callbackFrames[1].status = "delivered"],
  ["Golden post-completion refusal", f => f.second.callbackFrames[0].authenticated = false],
  ["Golden post-completion refusal", f => f.second.sentAt = 999999],
  ["Golden model-visible rollout marker", f => f.rollout[2].payload.content[0].text += f.state.marker], // marker-in-actual-original-prompt
  ["Golden model-visible rollout marker", f => { // marker-only-in-startup-context
    f.rollout.splice(2, 0, {type: "response_item", payload: {type: "message", role: "user", content: [{type: "input_text", text: "environment " + f.state.marker}]}});
    f.rollout.splice(4, 1);
  }],
  ...["developer", "system", "user"].map(role => ["Golden model-visible rollout marker", (f: any) => f.rollout.splice(2, 0, {type: "response_item", payload: {type: "message", role, content: [{type: "input_text", text: f.state.marker}]}})] as [string, (f: any) => void]),
  ["Golden model-visible rollout marker", f => f.rollout[2].payload.content[0].text += " changed"],
  ["Golden model-visible rollout marker", f => f.rollout[3].payload.content[0].text += " changed"],
  ["Golden model-visible rollout marker", f => f.rollout[3].payload.internal_chat_message_metadata_passthrough.turn_id = "other"],
  ["Golden model-visible rollout marker", f => [f.rollout[2], f.rollout[3]] = [f.rollout[3], f.rollout[2]]],
  ["Golden model-visible rollout marker", f => f.rollout[3].timestamp = new Date(1199).toISOString()],
  ["Golden controller marker tool", f => f.controller.splice(2, 0, {...f.controller[0], id: "other", input: {...f.controller[0].input, message: "OTHER"}})],
  ["Golden ambiguous delivery window", f => { // other-message-delivery
    const incoming = structuredClone(f.wire[0]); incoming.frame.msg_id = "other"; incoming.frame.message.content = "OTHER";
    const outgoing = structuredClone(f.wire[1]); outgoing.frame.orig_msg_id = "other";
    f.wire.splice(2, 0, incoming, outgoing);
  }],
  ["Golden delivered callback, not ack", f => f.wire[1].frame.from = "uds:/tmp/other.sock"],
  ["Golden delivered callback, not ack", f => f.wire[1].frame.status_detail = "refused"],
  ["Golden delivered callback, not ack", f => { f.wire[0].frame.from = "uds:/tmp/other.sock"; f.wire[2].frame.from = "uds:/tmp/other.sock"; }],
  ["Golden idle correlation", f => f.wire[2].frame.from = "uds:/tmp/other.sock"],
  ["Golden idle correlation", f => f.wire[2].frame.msg_id = "other"],
  ["Golden exactly one idle notice", f => f.wire[3].frame.state = "busy"],
  ["Golden post-completion refusal", f => f.wire[5].frame.status = "delivered"], // post-completion-wire-accepted
  ["Golden post-completion refusal", f => { // post-completion-conflicting-denied
    f.second.callbackFrames.push({...f.second.callbackFrames[1], status: "denied"});
    f.second.senderReplies.push({type: "error", error: "authentication failed"});
  }],
  ["Golden post-completion refusal", f => f.second.senderReplies.push({type: "error", error: "sender failed"})],
  ["Golden post-completion refusal", f => f.second.callbackFrames.push({type: "auth", authenticated: false})],
  ...["orig_msg_id", "from", "status_detail", "from_mode"].flatMap(key => [
    ["Golden post-completion refusal", (f: any) => f.second.callbackFrames[1][key] = "other"],
    ["Golden post-completion refusal", (f: any) => f.wire[5].frame[key] = "other"],
    // Alter both copies: their mutual equality must not replace field validation.
    ["Golden post-completion refusal", (f: any) => { f.second.callbackFrames[1][key] = "other"; f.wire[5].frame[key] = "other"; }],
  ] as [string, (f: any) => void][]),
  ["Golden post-completion refusal", f => f.wire[4].frame.message.content = "other"],
  ["Golden post-completion refusal", f => f.wire.push({...f.wire[5], frame: {...f.wire[5].frame, status: "denied"}})],
  ["Golden post-completion refusal", f => f.ipc.push({time: 2200, direction: "sidecar-to-driver", message: {type: "steer", msgId: "second"}})],
  ["Golden post-completion refusal", f => f.ipc.push({time: 2200, direction: "driver-to-sidecar", message: {type: "active-turn-state", turnId: "new"}})],
  ["Golden process exit evidence", f => f.after = f.before],
  ["Golden process exit evidence", f => f.identitiesAfter.pop()],
];
it.each(goldenFailures)("S5b golden rejects: %s", (message, mutate) => {
  const f = structuredClone(goldenFixture);
  expect(assessGolden(f)).toBe(true);
  mutate(f); expect(() => assessGolden(f)).toThrow(message);
});
it("S5b controller extraction retains only matching content blocks", () => {
  const f = goldenFixture;
  const records = f.controller.map(({role, time, ...block}: any) => ({
    type: role, timestamp: new Date(time).toISOString(), message: {role, content: [block]},
  }));
  records.push(
    {type: "user", timestamp: new Date(2100).toISOString(), message: {role: "user", content: [
      {type: "text", text: "private unrelated prose"},
      {type: "tool_use", name: "SendMessage", id: "other", input: {to: "unrelated", message: "private"}},
      {type: "tool_result", tool_use_id: "other", content: "private"},
      {type: "text", text: '[Cross-session idle notice] "unrelated", which you asked to be notified about, is idle now.'},
      {type: "text", text: f.controller[2].text.replace("100.sock", "999.sock")},
    ]}},
    // Even a queue entry with message.content must never double-count the user notice.
    {type: "queue-operation", operation: "enqueue", content: f.controller[3].text,
      timestamp: new Date(2040).toISOString(), message: {role: "user", content: [f.controller[3]]}},
  );
  expect(extractController(records, f.state)).toEqual(f.controller);
  expect(JSON.stringify(extractController(records, f.state))).not.toContain("private");
  expect(assessGolden({...f, controller: extractController(records, f.state)})).toBe(true);
  const queueOnly = records.filter((r: any) => r.type === "queue-operation" || !r.message.content.some((b: any) => b.text === f.controller[3].text));
  expect(() => assessGolden({...f, controller: extractController(queueOnly, f.state)})).toThrow("Golden exactly one idle notice");
});
it("S5b versions and HEAD are required, successful and identical", () => {
  const identity = {codex: {code: 0, stdout: "codex-cli 0.155.1"}, claude: {code: 0, stdout: "Claude 1"}, head: {code: 0, stdout: "abc"}};
  expect(assessIdentities([identity, structuredClone(identity)])).toBe(true);
  for (const key of ["codex", "claude", "head"] as const) {
    const mismatch = structuredClone(identity); mismatch[key].stdout += "other";
    expect(() => assessIdentities([identity, mismatch])).toThrow("Identity version/HEAD mismatch");
    const failed = structuredClone(identity); failed[key].code = 1;
    expect(() => assessIdentities([identity, failed])).toThrow("Identity command failed");
  }
});
it("S5b verify-evidence fails missing raw artifacts regardless of a passed summary", async () => {
  const {mkdtemp, writeFile, mkdir, rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "p3-evidence-test-"));
  try {
    await mkdir(join(root, "golden"));
    await writeFile(join(root, "golden/summary.json"), JSON.stringify({outcome: "passed"}));
    const result = await verifyEvidence({out: root});
    expect(result.passed).toBe(false);
    expect(result.rows.map((r: any) => r.ac)).toEqual(["preflight", "AC03", "AC13", "AC05 rerun", "AC07", "AC16"]);
    expect(result.rows.every((r: any) => r.status === "unreached")).toBe(true);
    expect(result.methods.map((m: any) => m.method)).toEqual(requiredServerMethods);
  } finally { await rm(root, {recursive: true, force: true}); }
});
it("S5b golden preload parses without starting any process", async () => {
  // Import-free compilation catches accidental template escaping; no socket/model launch.
  const {SourceTextModule} = await import("node:vm");
  if (SourceTextModule) expect(() => new SourceTextModule(goldenTraceSource())).not.toThrow();
  else expect(goldenTraceSource()).toContain("Socket.prototype.end");
});
describe.skipIf(!enabled)("S5b real golden and full evidence gate", () => {
  function root() {
    if (!process.env.STRATUM_PEER3_EVIDENCE) throw new Error("STRATUM_PEER3_EVIDENCE is required for the explicit live gate");
    return process.env.STRATUM_PEER3_EVIDENCE;
  }
  it("validates golden from every raw link", async () => {
    expect(assessGolden(await loadGolden(join(root(), "golden")))).toBe(true);
  });
  it("verifies every mode and common versions/HEAD", async () => {
    const result = await verifyEvidence({out: root()});
    expect(result.rows, JSON.stringify(result)).toEqual(expect.arrayContaining([
      ...["AC03", "AC07", "AC13", "AC16"].map(ac => expect.objectContaining({ac, status: "passed"})),
    ]));
    expect(["passed", "passed-amended"]).toContain(result.rows.find((r: any) => r.ac === "AC05 rerun")?.status);
    expect(result.passed).toBe(true);
  });
});

// A complete synthetic bundle exercises the filesystem walker; never live evidence.
async function syntheticBundle(root: string) {
  const {mkdir, writeFile} = await import("node:fs/promises");
  const put = async (path: string, value: any, raw = false) => {
    const {dirname} = await import("node:path");
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), raw ? value : JSON.stringify(value));
  };
  const identity = {codex: {code: 0, stdout: "codex-cli 0.155.1"}, claude: {code: 0, stdout: "Claude fixture"}, head: {code: 0, stdout: "fixture-head"}};
  for (const mode of ["preflight", "sandbox", "process-tree", "server-requests", "golden"]) {
    await put(`${mode}/identity.json`, identity);
    await put(`${mode}/summary.json`, {outcome: "failed", note: "Deliberately false: not a source of verdicts"});
  }
  for (const name of requiredCases.preflight) await put(`preflight/${name}.json`, {
    code: 0, stdout: name === "codex-version" ? identity.codex.stdout : name === "claude-version" ? identity.claude.stdout : name === "git-head" ? identity.head.stdout : "fixture", authenticated: true,
  });
  await put("sandbox/exec-baseline/report.json", baselineFixture.report);
  for (const mode of ["built-in", "ordinary", "override"]) await put(`sandbox/exec-baseline/${mode}.json`, baselineFixture.raw[mode]);
  const baseline = assessExecBaseline(baselineFixture.report, baselineFixture.raw);
  for (const name of requiredCases.sandbox) {
    const observed = sandboxExpectations(name, name.startsWith("temp-") ? baseline[name.slice(5)] : undefined);
    const result = name.startsWith("network-") ? {fetched: name === "network-on", error: "denied"} : Object.fromEntries(Object.entries(observed).map(([k, writable]) => [k, {writable, code: "EPERM"}]));
    await put(`sandbox/${name}.json`, {poll: {status: "complete"}, policy: {filesystemMode: name === "read-only" ? "read-only" : "workspace-write", networkAccess: name === "network-on", approvalPolicy: "never"},
      nonce: "N", osWritableOutside: true, observed,
      tempComparison: Object.fromEntries(["TMPDIR", "slashTmp"].map(k => [k, {exec: observed[k], appServer: observed[k]}])),
      records: [{type: "item.completed", item: {type: "command_execution", exit_code: 0, aggregated_output: "N=" + JSON.stringify(result)}}]});
  }
  for (const name of requiredCases["process-tree"]) {
    const f = structuredClone(pendingFixture);
    f.signalMode = ["cancel-active", "parent-death", "driver-sigkill"].includes(name) ? "native-signal" : "controlled-shim";
    f.action.kind = name === "parent-death" ? "parent-sigkill" : name === "driver-sigkill" ? "driver-sigkill" : "cancel";
    if (["parent-death", "completion-wins", "sigterm-ignore"].includes(name)) {
      f.records.push({type: "turn.completed"}, {__t2f5_done__: 0}); f.poll.status = "complete";
      f.parentGone = true; f.driverAliveAfterParentDeath = true;
    }
    if (name === "completion-wins") { f.action.records.push({type: "turn.completed"}); f.completedBeforeCancel = true; f.sentinelBeforeCancel = false; }
    for (const event of ["held-initialize-response", "held-completion", "ignored-sigterm"]) f.events.push({event});
    await put(`process-tree/${name}.json`, f);
    await put(`process-tree/${name}.before.ps`, "PID PPID PGID STAT COMMAND\n" + f.pids.map((p: any) => `${p.pid} 1 ${p.pgid} S fixture`).join("\n"), true);
    await put(`process-tree/${name}.after.ps`, "PID PPID PGID STAT COMMAND\n", true);
  }
  for (const [i, trigger] of serverRequestTriggers.entries()) {
    const transcript = [
      {direction: "client", frame: {method: "thread/start", params: {approvalPolicy: trigger.approvalPolicy, sandbox: trigger.filesystemMode}}},
      {direction: "client", frame: {method: "turn/start", params: {input: [{type: "text", text: trigger.prompt}]}}},
      ...trigger.methods.flatMap((method: string, index: number) => [
        {direction: "server", frame: {id: index, method}},
        {direction: "client", frame: {id: index, ...respondToServerRequest(method)}},
      ]),
      {direction: "server", frame: {method: "turn/completed", params: {turn: {status: "completed"}}}},
    ];
    await put(`server-requests/run-${i}.json`, {trigger, transcript, claim: "completed"});
  }
  for (const [key, value] of Object.entries(goldenFixture)) await put(`golden/${key === "prompt" ? "prompt.txt" : ["before", "after"].includes(key) ? key + ".ps" : key + ".json"}`, value, ["prompt", "before", "after"].includes(key));
  return put;
}
it("S5b walker rederives all ACs, ignores summaries and rejects broken mode links", async () => {
  const {mkdtemp, rm} = await import("node:fs/promises");
  const {tmpdir} = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "p3-bundle-"));
  try {
    const put = await syntheticBundle(root);
    const control = await verifyEvidence({out: root});
    expect(control, JSON.stringify(control)).toMatchObject({passed: true});
    // The opt-in live test and CLI walker both assess these same raw files.
    // A forged passing summary cannot mask any controller/wire failure.
    await put("golden/summary.json", {outcome: "passed"});
    for (const [message, mutate] of goldenFailures.filter(([message]) => /controller|delivered|idle|from_mode|conflicting/.test(message))) {
      const broken = structuredClone(goldenFixture);
      mutate(broken);
      for (const key of ["controller", "wire", "ipc", "second"]) await put(`golden/${key}.json`, broken[key]);
      expect(() => assessGolden(broken)).toThrow(message);
      const raw = await loadGolden(join(root, "golden"));
      expect(() => assessGolden(raw)).toThrow(message);
      const verdict = await verifyEvidence({out: root});
      expect(verdict.passed).toBe(false);
      expect(verdict.rows.find((r: any) => r.ac === "AC07")).toMatchObject({status: "failed", reason: message});
      for (const key of ["controller", "wire", "ipc", "second"]) await put(`golden/${key}.json`, goldenFixture[key]);
    }
    const scenarios: [string, string, (data: any) => void][] = [
      ["preflight/login.json", "preflight", d => d.authenticated = false],
      ["sandbox/read-only.json", "AC03", d => d.records = []],
      ["sandbox/exec-baseline/ordinary.json", "AC03", d => d.code = 1],
      ["process-tree/cancel-active.json", "AC13", d => delete d.action],
      ["server-requests/run-0.json", "AC05 rerun", d => d.trigger = {}],
      ["server-requests/run-0.json", "AC05 rerun", d => delete d.transcript],
      ["server-requests/run-0.json", "AC05 rerun", d => d.transcript[0].frame.params.sandbox = "danger-full-access"],
      ["server-requests/run-0.json", "AC05 rerun", d => d.transcript.pop()],
      ["golden/prompt.txt", "AC07", () => {}],
      ["sandbox/identity.json", "AC16", d => d.head.stdout = "other"],
      ["preflight/git-head.json", "AC16", d => d.stdout = "other"],
    ];
    for (const [file, ac, mutate] of scenarios) {
      const original = await readFile(join(root, file), "utf8");
      if (file.endsWith(".txt")) await put(file, original + goldenFixture.state.marker, true);
      else { const data = JSON.parse(original); mutate(data); await put(file, data); }
      const result = await verifyEvidence({out: root});
      expect(result.passed, file).toBe(false);
      expect(result.rows.find((r: any) => r.ac === ac)?.status, file).toBe("failed");
      if (file === "server-requests/run-0.json" && JSON.parse(await readFile(join(root, file), "utf8")).transcript && !JSON.parse(await readFile(join(root, file), "utf8")).transcript?.some((e: any) => e.frame.method === "turn/completed")) expect(result.rows.find((r: any) => r.ac === ac)?.reason).toBe("Server request missing terminal");
      await put(file, original, true);
    }
    const tempPath = "sandbox/temp-ordinary.json", tempRaw = await readFile(join(root, tempPath), "utf8"), tempData = JSON.parse(tempRaw);
    tempData.observed.TMPDIR = false; tempData.tempComparison.TMPDIR = {exec: false, appServer: false};
    const results = JSON.parse(tempData.records[0].item.aggregated_output.slice(2)); results.TMPDIR.writable = false;
    tempData.records[0].item.aggregated_output = "N=" + JSON.stringify(results);
    await put(tempPath, tempData);
    expect((await verifyEvidence({out: root})).rows.find((r: any) => r.ac === "AC03")).toMatchObject({status: "failed", reason: "Exec/app-server temp mismatch"});
    await put(tempPath, tempRaw, true);
    const psPath = "process-tree/cancel-active.after.ps";
    const ps = await readFile(join(root, psPath), "utf8");
    await put(psPath, ps + "100 1 100 S leaked driver\n", true);
    const leaked = await verifyEvidence({out: root});
    expect(leaked.rows.find((r: any) => r.ac === "AC13")).toMatchObject({status: "failed", reason: "Process snapshot PID mismatch"});
    await put(psPath, ps, true);
    const file = "server-requests/run-0.json", run = JSON.parse(await readFile(join(root, file), "utf8"));
    run.transcript = run.transcript.filter((e: any) => e.frame.id === undefined);
    await put(file, run);
    const unavailable = await verifyEvidence({out: root});
    expect(unavailable.passed).toBe(true);
    expect(unavailable.rows.find((r: any) => r.ac === "AC05 rerun")?.status).toBe("passed-amended");
    expect(unavailable.methods.filter((m: any) => m.status === "unreached").every((m: any) => m.triggers.length > 0)).toBe(true);
    expect(unavailable.rows.find((r: any) => r.ac === "AC16")?.status).toBe("passed");
  } finally { await rm(root, {recursive: true, force: true}); }
});


it("amended AC05 requires proven methods and recorded triggers", () => {
  const methods = assessServerRequests(evidenceRuns(), respondToServerRequest);
  expect(() => scoreServerRequests(methods)).toThrow("No proven server request method");
  methods[0] = {method: methods[0].method, status: "proven", evidence: []};
  expect(scoreServerRequests(methods)).toEqual({status: "passed-amended", reason: "1 proven, 10 unreached (recorded with triggers)"});
  const broken = structuredClone(methods); broken[1].triggers = [];
  expect(() => scoreServerRequests(broken)).toThrow("Unreached method has no recorded trigger");
  broken[1].status = "failed";
  expect(() => scoreServerRequests(broken)).toThrow("Elicited method not proven");
});
it("AC16 accepts only passed rows and amended AC05, never plain unreached", () => {
  expect(assessLiveRows([{ac: "AC03", status: "passed"}, {ac: "AC05 rerun", status: "passed-amended"}])).toBe(true);
  for (const row of [{ac: "AC05 rerun", status: "unreached"}, {ac: "AC07", status: "passed-amended"}, {ac: "AC05 rerun", status: "failed"}]) {
    expect(() => assessLiveRows([row])).toThrow("Required live gate incomplete");
  }
});
it.each(["bad-reply", "rejected", "stall", "zero-proven", "missing-trigger"])("amended AC05 walker fails closed: %s", async mode => {
  const {mkdtemp, rm} = await import("node:fs/promises");
  const root = await mkdtemp("/tmp/p3-amended-");
  try {
    const put = await syntheticBundle(root);
    for (let i = 0; i < serverRequestTriggers.length; i++) {
      const file = `server-requests/run-${i}.json`, run = JSON.parse(await readFile(join(root, file), "utf8"));
      if (mode === "zero-proven") run.transcript = run.transcript.filter((e: any) => e.frame.id === undefined);
      else if (i === 0) {
        if (mode === "bad-reply") run.transcript[3].frame.result = {};
        if (mode === "rejected") run.transcript.push({direction: "server", frame: {method: "error", params: {message: "rejected reply"}}});
        if (mode === "stall") run.transcript.pop();
        if (mode === "missing-trigger") run.trigger.methods = [];
      }
      await put(file, run);
    }
    const result = await verifyEvidence({out: root});
    expect(result.rows.find((r: any) => r.ac === "AC05 rerun")?.status).toBe("failed");
    expect(result.rows.find((r: any) => r.ac === "AC16")?.status).toBe("failed");
    expect(result.passed).toBe(false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

it("bad-server-reply keeps all eight unreached methods visible in the failed CLI report", async () => {
  const {mkdtemp, rm} = await import("node:fs/promises");
  const {execFile} = await import("node:child_process");
  const root = await mkdtemp("/tmp/p3-bad-reply-");
  try {
    const put = await syntheticBundle(root);
    for (let i = 0; i < serverRequestTriggers.length; i++) {
      const file = `server-requests/run-${i}.json`, run = JSON.parse(await readFile(join(root, file), "utf8"));
      run.transcript = run.transcript.filter((e: any) => e.frame.id === undefined || e.frame.id === 0);
      if (i === 0) run.transcript.find((e: any) => e.direction === "client" && e.frame.id === 0).frame.result = {};
      await put(file, run);
    }
    const result = await verifyEvidence({out: root});
    expect(result.rows.find((r: any) => r.ac === "AC05 rerun")?.status).toBe("failed");
    expect(result.methods.map((m: any) => m.method)).toEqual(requiredServerMethods);
    expect(result.methods.filter((m: any) => m.status === "failed")).toEqual([expect.objectContaining({reason: expect.stringContaining("incorrect reply")})]);
    const gaps = result.methods.filter((m: any) => m.status === "unreached");
    expect(gaps).toHaveLength(8);
    expect(gaps.every((m: any) => m.triggers.length > 0)).toBe(true);
    const cli = await new Promise<{code: number | string | null; stdout: string}>(resolveResult => {
      execFile(process.execPath, [resolve("scripts/peer3-probe.mjs"), "verify-evidence", "--out", root], (error, stdout) => resolveResult({code: error?.code ?? 0, stdout}));
    });
    expect(cli.code).toBe(1);
    const printed = JSON.parse(cli.stdout.slice(cli.stdout.indexOf("[\n")));
    expect(printed).toEqual(result.methods);
  } finally { await rm(root, {recursive: true, force: true}); }
});
