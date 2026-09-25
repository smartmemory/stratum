import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAppServerDriver, respondToServerRequest, type DriverBoundaries, type DriverOptions } from "../../src/connectors/codex-appserver-driver.js";
import { pollBackgroundRun } from "../../src/connectors/background.js";
import type { DriverMessage, PeerMessage } from "../../src/connectors/codex-appserver-ipc.js";
const fake = resolve("tests/helpers/fake-app-server.mjs");
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call', 'unknown'];
const options: DriverOptions = { runId: "abcdef012345", model: "gpt-6-luna/low", cwd: process.cwd(), prompt: "fixture", policy: { filesystemMode: "read-only", writableRoots: [], networkAccess: false, approvalPolicy: "never" } };
async function run(scenario: Record<string, unknown> = {}, extra: Partial<DriverBoundaries> = {}, policy = options.policy) {
  const records: any[] = [], order: string[] = [], logs: string[] = [];
  const result = await runAppServerDriver({ ...options, policy, command: [process.execPath, fake, JSON.stringify(scenario)] }, {
    writer: { async write(line) { records.push(JSON.parse(line)); order.push(Object.hasOwn(records.at(-1), "__t2f5_done__") ? "sentinel" : "record"); }, async flush() { order.push("flush"); } },
    log: message => logs.push(message), timings: { eof: 20, term: 20 }, ...extra,
  });
  return { result, records, order, logs };
}
async function poll(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "peer3-driver-")); roots.push(root);
  const dir = join(root, "abcdef012345"); await mkdir(dir);
  const streamPath = join(dir, "stream.jsonl"), stderrPath = `${streamPath}.err`;
  await writeFile(streamPath, records.map(record => JSON.stringify(record) + "\n").join("")); await writeFile(stderrPath, "");
  await writeFile(join(dir, "meta.json"), JSON.stringify({ ...options, agent: "codex", sandboxMode: "read-only", promptChars: 7, createdAt: new Date().toISOString(), childPid: 0, streamPath, stderrPath }));
  const result = await pollBackgroundRun("abcdef012345", { registryRoot: root });
  if (result.status === "not_found") throw new Error("missing fixture");
  return result;
}
const message = (text: string) => ({ method: "item/completed", params: { item: { type: "agentMessage", id: text, text } } });
const snapshot = (n: number) => ({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { inputTokens: n, cachedInputTokens: 2, cacheWriteInputTokens: 3, outputTokens: 4, reasoningOutputTokens: 1 } } } });
function sentinel(records: any[], value: number | undefined) {
  expect(records.filter(r => Object.hasOwn(r, "__t2f5_done__"))).toEqual(value === undefined ? [] : [{ __t2f5_done__: value }]);
}

describe("thread sandbox policy", () => {
  it.each(["read-only", "workspace-write", "danger-full-access"] as const)("strict fake accepts %s at thread/start", async filesystemMode => {
    const r = await run({}, {}, { ...options.policy, filesystemMode, networkAccess: true, writableRoots: ["/root with spaces"] });
    expect(r.result).toBe("completed"); sentinel(r.records, 0);
  });
  it("strict fake rejects turn sandbox overrides and temp-exclusion config", async () => {
    const { validateThreadStart, validateTurnStart } = await import(fake);
    const thread = { model: "gpt-6-luna", cwd: "/work", approvalPolicy: "never", sandbox: "workspace-write",
      config: { "sandbox_workspace_write.network_access": false, "sandbox_workspace_write.writable_roots": [] } };
    expect(() => validateThreadStart(thread)).not.toThrow();
    for (const key of ["sandbox_workspace_write.exclude_tmpdir_env_var", "sandbox_workspace_write.exclude_slash_tmp"]) {
      expect(() => validateThreadStart({ ...thread, config: { ...thread.config, [key]: false } })).toThrow();
    }
    expect(() => validateThreadStart({ ...thread, config: undefined })).toThrow();
    expect(() => validateTurnStart({ threadId: "t", input: [], sandboxPolicy: { type: "workspaceWrite" } })).toThrow();
  });
});

describe("AC05 unattended server requests", () => {
  it.each(methods)("strict fake accepts %s and continues", async method => {
    const r = await run({ requests: [method] }); expect(r.result).toBe("completed");
    expect(r.logs.join("")).toContain(`accepted:${method}`); sentinel(r.records, 0);
  });
  it("accepts multiple interleaved requests", async () => { const r = await run({ requests: methods }); expect(r.result).toBe("completed"); expect(r.logs.join("").match(/accepted:/g)).toHaveLength(methods.length); });
});

describe("AC06 exec stream through public poll", () => {
  it("multiple assistant items, ignored deltas, last total wins and cached fields", async () => {
    const r = await run({ events: [snapshot(10), message("first"), { method: "item/agentMessage/delta", params: { delta: "ignored" } }, snapshot(20), message("second")] });
    expect(r.records.filter(r => r.type === "thread.started")).toHaveLength(1);
    expect(r.records.filter(r => r.type === "turn.started")).toHaveLength(1);
    expect(r.records.find(r => r.type === "turn.completed").usage).toEqual({ input_tokens: 20, cached_input_tokens: 2, cache_write_input_tokens: 3, output_tokens: 4, reasoning_output_tokens: 1 });
    const result = await poll(r.records); expect(result).toMatchObject({ status: "complete", usage: { tokens: 24 }, split: { input: 20, output: 4, cacheRead: 2 } }); expect(result.status === "complete" ? result.text : undefined).toContain("first"); expect(result.status === "complete" ? result.text : undefined).toContain("second"); expect(result.status === "complete" ? result.text : undefined).not.toContain("ignored");
    expect(r.order.slice(-3)).toEqual(["flush", "sentinel", "flush"]);
  });
  it("absent usage stays absent; unsupported items and foreign notifications dropped", async () => {
    const r = await run({ events: [{ method: "item/completed", params: { item: { type: "userMessage", text: "drop" } } }, { ...message("foreign"), params: { ...message("foreign").params, threadId: "other" } }, message("ok")] });
    expect(r.records.find(r => r.type === "turn.completed")).not.toHaveProperty("usage"); expect(await poll(r.records)).toMatchObject({ status: "complete", text: "ok" });
  });
  it("every section 3 mapped record has its complete exec shape", async () => {
    const pairs = [
      [{ type: "agentMessage", text: "done" }, { type: "agent_message", text: "done" }],
      [{ type: "commandExecution", command: "echo hi", aggregatedOutput: "hi", exitCode: 7, status: "declined" }, { type: "command_execution", command: "echo hi", aggregated_output: "hi", exit_code: 7, status: "failed" }],
      [{ type: "commandExecution", command: "true", status: "completed" }, { type: "command_execution", command: "true", aggregated_output: "", status: "completed" }],
      [{ type: "fileChange", changes: [{ path: "a", kind: { type: "add" } }, { path: "b", kind: { type: "delete" } }], status: "declined" }, { type: "file_change", changes: [{ path: "a", kind: "add" }, { path: "b", kind: "delete" }], status: "failed" }],
      [{ type: "mcpToolCall", server: "s", tool: "t", arguments: { x: 1 }, result: { content: [{ type: "text", text: "ok" }], structuredContent: { yes: true }, _meta: { m: 1 } }, status: "completed" }, { type: "mcp_tool_call", server: "s", tool: "t", arguments: { x: 1 }, result: { content: [{ type: "text", text: "ok" }], structured_content: { yes: true }, _meta: { m: 1 } }, status: "completed" }],
      [{ type: "mcpToolCall", server: "s", tool: "t", arguments: {}, error: { message: "oops" }, status: "failed" }, { type: "mcp_tool_call", server: "s", tool: "t", arguments: {}, error: { message: "oops" }, status: "failed" }],
      [{ type: "reasoning", summary: ["one", "two"] }, { type: "reasoning", text: "one\ntwo" }],
      [{ type: "webSearch", query: "search" }, { type: "web_search", query: "search" }],
    ];
    const r = await run({ events: pairs.map(([item], i) => ({ method: "item/completed", params: { item: { id: String(i), ...item } } })) });
    expect(r.records).toEqual([
      { type: "thread.started", thread_id: "t" }, { type: "turn.started" },
      ...pairs.map(([, item], i) => ({ type: "item.completed", item: { id: String(i), ...item } })),
      { type: "turn.completed" }, { __t2f5_done__: 0 },
    ]);
  });
  it.each(["failed", "interrupted"])("partial output then %s polls error", async status => {
    const r = await run({ status, events: [message("partial")] }); expect((await poll(r.records)).status).toBe("error"); expect(r.records.filter(r => r.type === "error")).toEqual([{ type: "error", error: { message: status === "failed" ? "fixture failed" : "interrupted" } }]); sentinel(r.records, status === "failed" ? 1 : 130);
  });
  it("retryable error and malformed counter reset do not end the run", async () => {
    const r = await run({ events: ["bad", "bad", { method: "error", params: { willRetry: true } }, "bad", "bad", message("ok")] });
    expect(r.result).toBe("completed"); expect((await poll(r.records)).status).toBe("complete");
  });
});

describe("AC12 terminal owner", () => {
  it.each(["initialize", "thread/start", "turn/start"])("RPC rejection names %s", async reject => {
    const r = await run({ reject }); expect(r.result).toBe("failed"); expect(r.records.find(r => r.type === "error").error.message).toContain(reject); sentinel(r.records, 1);
  });
  it.each([{ exit: true }, { truncated: true }, { events: ["bad", "bad", "bad"] }, { identity: "unknown" }])("transport/identity failure %j", async scenario => {
    const r = await run(scenario); expect(r.result).toBe("failed"); sentinel(r.records, 1);
  });
  it("spawn error is terminal", async () => {
    const r = await run({}, { spawn: () => spawn("/no-such-peer3-command", [], { stdio: ["pipe", "pipe", "pipe"] }) });
    expect(r.records.find(r => r.type === "error").error.message).toContain("spawn"); sentinel(r.records, 1);
  });
  it("completion then repeated SIGTERM during reap keeps sentinel zero", async () => {
    const signals = new EventEmitter();
    const r = await run({ ignoreEOF: true, ignoreTerm: true }, { signals, log: line => { if (line.includes("barrier:eof")) { signals.emit("SIGTERM"); signals.emit("SIGTERM"); } } });
    expect(r.result).toBe("completed"); sentinel(r.records, 0);
  });
  it("SIGTERM then interrupted during EOF cleanup leaves no sentinel or late records", async () => {
    const signals = new EventEmitter();
    const r = await run({ hold: true, status: "interrupted", interruptOnEOF: true }, { signals, peer: { subscribe() { return () => {}; }, close() {}, send(message) { if (message.type === "active-turn-state" && message.turnId) signals.emit("SIGTERM"); } } });
    expect(r.result).toBe("cancelled"); sentinel(r.records, undefined); expect(r.records.some(r => r.type === "error")).toBe(false);
    expect((await poll(r.records))).toMatchObject({ status: "error", reason: "child_died_without_sentinel" });
  });
});

/** Deterministic transport permits exact deadline/race tests without wall-clock sleeps. */
function memoryServer() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { child.emit("exit", 0); return true; } });
  child.stdin.on("finish", () => child.emit("exit", 0));
  const send = (frame: unknown) => (child.stdout as PassThrough).write(JSON.stringify(frame) + "\n");
  let input = "";
  child.stdin.on("data", data => { input += data.toString(); let index: number; while ((index = input.indexOf("\n")) >= 0) { const f = JSON.parse(input.slice(0, index)); input = input.slice(index + 1); if (f.method === "initialize") send({ id: f.id, result: { userAgent: `stratum/0.155.1 (fake) (${f.params.clientInfo.name}; ${f.params.clientInfo.version})` } }); if (f.method === "thread/start") send({ id: f.id, result: { thread: { id: "t" } } }); if (f.method === "turn/start") send({ id: f.id, result: { turn: { id: "u" } } }); } });
  return { child, send };
}
async function ticks() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
it("AC12 no turn/started at 60 seconds; SIGTERM during handshake", async () => {
  vi.useFakeTimers(); const server = memoryServer();
  const promise = run({}, { spawn: () => server.child }); await ticks(); await vi.advanceTimersByTimeAsync(60_000);
  const r = await promise; expect(r.result).toBe("failed"); expect(r.records.find(r => r.type === "error").error.message).toContain("turn/started"); sentinel(r.records, 1);
  const signals = new EventEmitter(), second = memoryServer();
  const cancelled = run({}, { spawn: () => { signals.emit("SIGTERM"); return second.child; }, signals });
  expect((await cancelled).result).toBe("cancelled");
});
it("AC05 120s watchdog resets on notifications and cannot override completion", async () => {
  vi.useFakeTimers(); const server = memoryServer();
  const promise = run({}, { spawn: () => server.child }); await ticks();
  server.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  server.send({ id: "s", method: methods[0] }); await vi.advanceTimersByTimeAsync(119_999);
  server.send({ method: "error", params: { willRetry: true } }); await vi.advanceTimersByTimeAsync(119_999);
  await vi.advanceTimersByTimeAsync(1); const r = await promise;
  expect(r.records.find(r => r.type === "error").error.message).toBe(`unattended request stalled: ${methods[0]}`); sentinel(r.records, 1);
  const s2 = memoryServer(), p2 = run({}, { spawn: () => s2.child }); await ticks();
  s2.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } }); s2.send({ id: "s", method: methods[0] });
  s2.send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
  await vi.advanceTimersByTimeAsync(120_000); expect((await p2).result).toBe("completed");
});
it.each([false, true])("steer result is independent of run outcome (refusal=%s)", async steerReject => {
  let receive!: (message: PeerMessage) => void;
  const results: DriverMessage[] = [], signals = new EventEmitter();
  const r = await run({ hold: true, steerReject }, { signals, peer: {
    subscribe(fn) { receive = fn; return () => {}; }, close() {},
    send(message) { results.push(message); if (message.type === "active-turn-state" && message.turnId) receive({ type: "steer", reqId: "req", senderFrom: "peer", msgId: "msg", text: "hello" }); if (message.type === "steer-result") signals.emit("SIGTERM"); },
  } });
  expect(results.find(m => m.type === "steer-result")).toMatchObject({ outcome: steerReject ? "expired" : "delivered" }); expect(r.result).toBe("cancelled");
});
it.each(["source", "dist"])("standalone %s entry owns real stdio child and durable sentinel", async kind => {
  const root = await mkdtemp(join(tmpdir(), "peer3-entry-")); roots.push(root);
  const streamPath = join(root, "stream.jsonl"), config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ ...options, streamPath, peer: { sessionsDir: join(root, "sessions"), sockDir: join(root, "socks"), name: "entry", lingerMs: 0, firstLineDeadlineMs: 1000 }, command: [process.execPath, fake, JSON.stringify({ events: [message("entry done")] })] }));
  const entry = resolve(kind === "source" ? "src/connectors/codex-appserver-driver.ts" : "dist/connectors/codex-appserver-driver.js");
  const child = spawn(process.execPath, [...(kind === "source" ? ["--experimental-strip-types"] : []), entry, config], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, STRATUM_PEER_REGISTER: "0" } });
  child.send({ type: "bootstrap", runId: options.runId, deadline: Date.now() + 2000 });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code, stderr).toBe(0);
    const records = (await readFile(streamPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records.some(record => record.item?.text === "entry done")).toBe(true);
    sentinel(records, 0); expect(records.at(-1)).toEqual({ __t2f5_done__: 0 });
  } finally { clearTimeout(timer); }
});
it.each(["source", "dist"].flatMap(kind => ["no IPC", "disconnect", "mismatch"].map(failure => ({ kind, failure }))))("standalone $kind bootstrap failure ($failure) writes no stream", async ({ kind, failure }) => {
  const root = await mkdtemp(join(tmpdir(), "peer3-no-bootstrap-")); roots.push(root);
  const streamPath = join(root, "stream.jsonl"), config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ ...options, streamPath, command: [process.execPath, fake] }));
  const entry = resolve(kind === "source" ? "src/connectors/codex-appserver-driver.ts" : "dist/connectors/codex-appserver-driver.js");
  const child = spawn(process.execPath, [...(kind === "source" ? ["--experimental-strip-types"] : []), entry, config], { stdio: failure === "no IPC" ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"] });
  const disconnectTimer = failure === "disconnect" ? setTimeout(() => child.disconnect(), 250) : undefined;
  if (failure === "mismatch") child.send({ type: "bootstrap", runId: "wrong-run", deadline: Date.now() + 2000 });
  let stderr = ""; child.stderr!.on("data", data => { stderr += data.toString(); });
  const stderrEnded = new Promise<void>(resolve => child.stderr!.once("end", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    await stderrEnded;
    expect(code, stderr).toBe(1);
    expect(stderr).toContain(failure === "mismatch" ? "Bootstrap runId mismatch" : failure === "disconnect" ? "parent disconnected before bootstrap" : "Missing bootstrap: no connected IPC channel");
    await expect(readFile(streamPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally { clearTimeout(timer); clearTimeout(disconnectTimer); }
});
it("AC06 bounds frames and ignores late output after terminal claim", async () => {
  const over = await run({ events: ["x".repeat(1024 * 1024 + 1)] }); expect(over.result).toBe("failed"); sentinel(over.records, 1);
  const late = await run({ events: [{ method: "turn/completed", params: { turn: { id: "u", status: "completed" } } }, message("late")] });
  expect(late.records.some(r => r.item?.text === "late")).toBe(false); sentinel(late.records, 0);
});
it("AC12 flush precedes stdin EOF and reap precedes sentinel despite repeated signals", async () => {
  const server = memoryServer(), signals = new EventEmitter(), order: string[] = [];
  let release!: () => void;
  const flushBarrier = new Promise<void>(resolve => { release = resolve; });
  server.child.stdin.on("finish", () => order.push("EOF/reap"));
  let firstFlush = true;
  const promise = run({}, { spawn: () => server.child, signals, writer: {
    async write(line) { order.push(Object.hasOwn(JSON.parse(line), "__t2f5_done__") ? "sentinel" : "record"); },
    async flush() { if (firstFlush) { firstFlush = false; order.push("flush"); await flushBarrier; } },
  } });
  await ticks(); server.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  server.send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
  await ticks(); expect(order).not.toContain("EOF/reap"); signals.emit("SIGTERM"); signals.emit("SIGTERM"); release();
  expect((await promise).result).toBe("completed"); expect(order.indexOf("sentinel")).toBeGreaterThan(order.indexOf("EOF/reap"));
});
it("live probe's disposable MCP tool speaks JSONL and completes declined elicitation (no model)", async () => {
  const probePath = resolve("scripts/peer3-probe.mjs");
  const { elicitationToolSource, runBounded } = await import(probePath);
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
    { id: 2, method: "tools/list" }, { id: 3, method: "tools/call" },
    { id: "elicit", result: { action: "decline", content: null } },
  ];
  const result = await runBounded(process.execPath, ["--input-type=module", "-e", elicitationToolSource()], { input: requests.map(f => JSON.stringify(f) + "\n").join("") });
  expect(result.code, result.stderr).toBe(0);
  const frames = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
  expect(frames).toHaveLength(4); expect(frames[2].method).toBe("elicitation/create"); expect(frames[3].id).toBe(3);
});

it("process exit with grandchild-held pipes fails, reaps and emits one sentinel", async () => {
  let child!: ChildProcessWithoutNullStreams, grandchild: number | undefined, reaped = false;
  const records: any[] = [];
  try {
    const r = await run({ inheritedPipes: true }, {
      spawn() {
        child = spawn(process.execPath, [fake, JSON.stringify({ inheritedPipes: true })], { stdio: ["pipe", "pipe", "pipe"] });
        child.on("exit", () => { reaped = true; }); return child;
      },
      log(line) { const match = /grandchild:(\d+)/.exec(line); if (match) grandchild = Number(match[1]); },
      writer: { async write(line) { const record = JSON.parse(line); if ("__t2f5_done__" in record) expect(reaped).toBe(true); records.push(record); }, async flush() {} },
    });
    expect(r.result).toBe("failed"); expect(grandchild).toBeDefined();
    expect(child.exitCode).toBe(1); expect(child.stdout.destroyed).toBe(true); expect(child.stderr.destroyed).toBe(true);
    expect(records.find(r => r.type === "error").error.message).toContain("exit"); sentinel(records, 1);
  } finally { if (grandchild) { try { process.kill(grandchild, "SIGKILL"); } catch {} } child?.kill("SIGKILL"); }
});

const malformedPayload = { method: "item/completed", params: { item: { type: "fileChange", changes: {} } } };
it.each([malformedPayload, { method: 123 }, '{"id":1}', '{"id":1,"error":null}', '{"method":"unknown","params":[]}', '{"method":"unknown","result":{}}'])("three consecutive malformed payloads fail: %j", async payload => {
  const r = await run({ events: [payload, payload, payload] });
  expect(r.result).toBe("failed"); expect(r.logs.filter(s => s.includes("malformed app-server frame"))).toHaveLength(3); sentinel(r.records, 1);
});
it("a processed valid frame resets malformed payload count", async () => {
  const r = await run({ events: [malformedPayload, malformedPayload, message("reset"), malformedPayload, malformedPayload] });
  expect(r.result).toBe("completed"); sentinel(r.records, 0);
});

it.each(["running", "exit", "exit with EOF", "exit past grace", "exit past grace with queued pipe data", "exit with EOF without completion", "exit past grace without completion"])("bounded queue drains all received frames with a held writer: %s", async state => {
  vi.useFakeTimers();
  const completed = !state.endsWith("without completion");
  const server = memoryServer(), records: any[] = [];
  const pause = vi.spyOn(server.child.stdout, "pause"), resume = vi.spyOn(server.child.stdout, "resume");
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  let writes = 0;
  const promise = run({}, { spawn: () => server.child, writer: {
    async write(line) { writes++; await held; records.push(JSON.parse(line)); }, async flush() {},
  } });
  await ticks();
  const frames = [
    { method: "turn/started", params: { threadId: "t", turn: { id: "u" } } },
    ...Array.from({ length: 200 }, (_, i) => ({ ...message(String(i)), params: { ...message(String(i)).params, threadId: "t", turnId: "u" } })),
    { method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } },
  ];
  if (!completed) frames.pop();
  // One chunk exercises the parser's queue bound, not just stream.pause().
  const pipeFrames = state.endsWith("queued pipe data") ? frames.splice(100) : [];
  const chunk = frames.map(f => JSON.stringify(f) + "\n").join("");
  const parse = vi.spyOn(JSON, "parse");
  (server.child.stdout as PassThrough).write(chunk);
  await ticks();
  const parsed = parse.mock.calls.length; parse.mockRestore();
  // One held thread record plus 63 parsed frames reaches the 64-record bound.
  expect(parsed).toBe(63); expect(pause).toHaveBeenCalled();
  expect(server.child.stdout.isPaused()).toBe(true); expect(writes).toBe(1);
  if (pipeFrames.length) {
    (server.child.stdout as PassThrough).write(pipeFrames.map(f => JSON.stringify(f) + "\n").join(""));
    expect(server.child.stdout.readableLength).toBeGreaterThan(0);
  }
  if (state !== "running") server.child.emit("exit", 0);
  if (state.startsWith("exit with EOF")) server.child.stdout.emit("end");
  if (state.startsWith("exit past grace")) await vi.advanceTimersByTimeAsync(2000);
  release(); const r = await promise;
  expect(r.result).toBe(completed ? "completed" : "failed"); expect(resume).toHaveBeenCalled();
  expect(records.filter(r => r.type === "item.completed").map(r => r.item.text)).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
  expect(records.filter(r => r.type === "turn.completed")).toEqual(completed ? [{ type: "turn.completed" }] : []);
  expect(records.filter(r => r.type === "error")).toEqual(completed ? [] : [{ type: "error", error: { message: "app-server exit before turn/completed" } }]);
  sentinel(records, completed ? 0 : 1); expect(records.at(-1)).toEqual({ __t2f5_done__: completed ? 0 : 1 });
});

it.each(["frame", "utf8"])("decodes a valid %s split across chunks", async split => {
  const server = memoryServer(), promise = run({}, { spawn: () => server.child }); await ticks();
  server.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  const bytes = Buffer.from(JSON.stringify({ method: "item/completed", params: { threadId: "t", turnId: "u", item: { id: "split", type: "agentMessage", text: "hello 世界" } } }) + "\n");
  const at = split === "utf8" ? bytes.indexOf(Buffer.from("世")) + 1 : 20;
  (server.child.stdout as PassThrough).write(bytes.subarray(0, at)); await ticks();
  (server.child.stdout as PassThrough).write(bytes.subarray(at));
  server.send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
  const r = await promise;
  expect(r.records.filter(r => r.type === "item.completed")).toEqual([{ type: "item.completed", item: { id: "split", type: "agent_message", text: "hello 世界" } }]); sentinel(r.records, 0);
});

it("unsignalled cleanup waits 3s then SIGTERM then 2s then SIGKILL and reap before sentinel", async () => {
  vi.useFakeTimers(); const server = memoryServer(), records: any[] = [];
  server.child.stdin.removeAllListeners("finish");
  const kill = vi.fn(() => true); server.child.kill = kill;
  const promise = run({}, { spawn: () => server.child, timings: {}, writer: { async write(line) { records.push(JSON.parse(line)); }, async flush() {} } });
  await ticks(); server.send({ method: "turn/started", params: { threadId: "t", turn: { id: "u" } } });
  server.send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } }); await ticks();
  await vi.advanceTimersByTimeAsync(2999); expect(kill).not.toHaveBeenCalled(); sentinel(records, undefined);
  await vi.advanceTimersByTimeAsync(1); expect(kill.mock.calls).toEqual([["SIGTERM"]]);
  await vi.advanceTimersByTimeAsync(1999); expect(kill).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]); sentinel(records, undefined);
  server.child.emit("exit", 0); expect((await promise).result).toBe("completed"); sentinel(records, 0);
});

it("initialize and identity validation use the shipped package version", async () => {
  const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  const { clientInfo } = await import("../../src/connectors/codex-appserver-client-info.js");
  expect(clientInfo).toEqual({ name: "stratum", version: pkg.version });
  const server = memoryServer(), initialize: any[] = [];
  server.child.stdin.on("data", data => { const f = JSON.parse(String(data)); if (f.method === "initialize") initialize.push(f.params.clientInfo); });
  const promise = run({}, { spawn: () => server.child }); await ticks();
  server.send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
  expect((await promise).result).toBe("completed"); expect(initialize).toEqual([clientInfo]);
});

it("server reply send failure is transport loss rather than malformed input", async () => {
  const server = memoryServer(), promise = run({}, { spawn: () => server.child }); await ticks();
  vi.spyOn(server.child.stdin, "write").mockImplementation(() => { throw new Error("broken pipe"); });
  server.send({ id: "approval", method: methods[0] });
  const r = await promise;
  expect(r.result).toBe("failed"); expect(r.logs.some(s => s.includes("malformed"))).toBe(false);
  expect(r.records.find(r => r.type === "error").error.message).toContain("app-server transport: Error: broken pipe"); sentinel(r.records, 1);
});
