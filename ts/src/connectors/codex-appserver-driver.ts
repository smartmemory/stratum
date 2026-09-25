#!/usr/bin/env -S node --experimental-strip-types
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { SandboxPolicy } from "../config/types.js";
import type { DriverPeerAttachment, SteerRequest, SteerResult } from "./codex-appserver-ipc.js";
import type { CommandExecutionRequestApprovalResponse } from "./codex-appserver-protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./codex-appserver-protocol/v2/FileChangeRequestApprovalResponse.js";
import type { ExecCommandApprovalResponse } from "./codex-appserver-protocol/ExecCommandApprovalResponse.js";
import type { ApplyPatchApprovalResponse } from "./codex-appserver-protocol/ApplyPatchApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "./codex-appserver-protocol/v2/PermissionsRequestApprovalResponse.js";
import type { McpServerElicitationRequestResponse } from "./codex-appserver-protocol/v2/McpServerElicitationRequestResponse.js";

// Slice 1 uses NodeNext .js imports. Resolve its entire source graph without
// changing those concurrently reviewed files or requiring a dist build.
const sourceRoot = new URL("../", import.meta.url).href;
const hooks = import.meta.url.endsWith(".ts") ? registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && specifier.endsWith(".js")) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(candidate)) return next(candidate.href, context);
  }
  return next(specifier, context);
} }) : undefined;
function moduleUrl(name: string): URL {
  const source = new URL(`./${name}.ts`, import.meta.url);
  return existsSync(source) ? source : new URL(`./${name}.js`, import.meta.url);
}
const { encodeCodexPolicy }: typeof import("./codex-policy.js") = await import(moduleUrl("codex-policy").href);
const { assertAppServerIdentity }: typeof import("./codex-appserver-contract.js") = await import(moduleUrl("codex-appserver-contract").href);
const { clientInfo }: typeof import("./codex-appserver-client-info.js") = await import(moduleUrl("codex-appserver-client-info").href);
hooks?.deregister();

type Frame = Record<string, any>;
export type TerminalClaim = "completed" | "failed" | "interrupted" | "cancelled";
export interface DriverWriter { write(line: string): Promise<void>; flush(): Promise<void> }
export interface DriverOptions {
  runId: string; model: string; cwd: string; prompt: string; policy: SandboxPolicy;
  command?: string[]; env?: NodeJS.ProcessEnv;
}
export interface DriverBoundaries {
  writer: DriverWriter;
  spawn?: () => ChildProcessWithoutNullStreams;
  peer?: DriverPeerAttachment;
  signals?: NodeJS.EventEmitter;
  log?: (message: string) => void;
  timings?: { startup?: number; stall?: number; eof?: number; term?: number; steer?: number };
}

/** Each result is checked against its pinned generated binding. */
export function respondToServerRequest(method: string): { result: unknown } | { error: { code: number; message: string } } {
  switch (method) {
    case "item/commandExecution/requestApproval": return { result: { decision: "decline" } satisfies CommandExecutionRequestApprovalResponse };
    case "item/fileChange/requestApproval": return { result: { decision: "decline" } satisfies FileChangeRequestApprovalResponse };
    case "execCommandApproval": return { result: { decision: { denied: { rejection: "unattended Stratum run: approvals are declined" } } } satisfies ExecCommandApprovalResponse };
    case "applyPatchApproval": return { result: { decision: { denied: { rejection: "unattended Stratum run: approvals are declined" } } } satisfies ApplyPatchApprovalResponse };
    case "item/permissions/requestApproval": return { result: { permissions: {}, scope: "turn" } satisfies PermissionsRequestApprovalResponse };
    case "mcpServer/elicitation/request": return { result: { action: "decline", content: null, _meta: null } satisfies McpServerElicitationRequestResponse };
    default: return { error: { code: -32601, message: "unsupported by unattended driver" } };
  }
}

export async function runAppServerDriver(options: DriverOptions, io: DriverBoundaries): Promise<TerminalClaim> {
  const policy = encodeCodexPolicy(options.model, options.cwd, options.policy, "app-server");
  const log = io.log ?? ((message: string) => console.error(message));
  const signals = io.signals ?? process;
  const timing = { startup: 60_000, stall: 120_000, eof: 3000, term: 2000, steer: 10_000, ...io.timings };
  let child: ChildProcessWithoutNullStreams | undefined, claim: TerminalClaim | undefined;
  let threadId: string | null = null, turnId: string | null = null, threadWritten = false, turnWritten = false;
  let usage: Frame | undefined, nextId = 0, malformed = 0, buffer = "", exited = false, expedited = false;
  let startup: NodeJS.Timeout | undefined, stall: NodeJS.Timeout | undefined, stallMethod: string | undefined;
  let postExit: NodeJS.Timeout | undefined, inputEnded = false;
  let wake: (() => void) | undefined, detach: (() => void) | undefined;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  let writes = Promise.resolve();
  let queued = 0, paused = false;
  const highWatermark = 64, lowWatermark = 32;
  let finish!: (claim: TerminalClaim) => void, failWriter!: (error: unknown) => void;
  const done = new Promise<TerminalClaim>((resolve, reject) => { finish = resolve; failWriter = reject; });
  const publish = () => { try { io.peer?.send({ type: "active-turn-state", runId: options.runId, threadId, turnId: claim ? null : turnId }); } catch (error) { log(`peer: ${error}`); } };
  function writeExecRecord(record: unknown) {
    queued++;
    if (queued >= highWatermark) { paused = true; child?.stdout.pause(); }
    writes = writes.then(() => io.writer.write(JSON.stringify(record) + "\n"));
    void writes.then(() => {
      queued--;
      if (paused && queued < lowWatermark && !claim) {
        paused = false;
        consumeFrames();
        if (!paused && !claim) child?.stdout.resume();
      }
    }, error => { queued--; log(`writer: ${error}`); claimTerminal("failed", "stream writer failed"); });
  }
  function send(frame: unknown) {
    if (!child || child.stdin.destroyed) throw new Error("app-server stdin unavailable");
    child.stdin.write(JSON.stringify(frame) + "\n");
  }
  function request(method: string, params: unknown, timeout?: number): Promise<any> {
    if (claim) return Promise.reject(new Error("run finalized"));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const entry: { resolve: typeof resolve; reject: typeof reject; timer?: NodeJS.Timeout } = { resolve, reject };
      if (timeout) entry.timer = setTimeout(() => { pending.delete(id); reject(new Error("request timeout")); }, timeout);
      pending.set(id, entry);
      try { send({ id, method, params }); } catch (error) { pending.delete(id); clearTimeout(entry.timer); reject(error); }
    });
  }
  function armStallWatchdog(method: string) {
    if (exited) return;
    clearTimeout(stall); stallMethod = method;
    stall = setTimeout(() => claimTerminal("failed", `unattended request stalled: ${method}`), timing.stall);
  }
  function signal() {
    if (claim) { expedited = true; wake?.(); }
    else claimTerminal("cancelled");
  }
  function claimTerminal(value: TerminalClaim, message?: string) {
    if (claim) return;
    claim = value; clearTimeout(startup); clearTimeout(stall); clearTimeout(postExit); publish();
    if (value === "failed" || value === "interrupted") writeExecRecord({ type: "error", error: { message: message ?? value } });
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("run finalized")); }
    pending.clear();
    // Defer cleanup until the synchronous spawn call has returned.
    void Promise.resolve().then(cleanup).then(() => finish(value), failWriter);
  }
  async function waitExit(ms: number) {
    if (exited || !child || expedited) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(end, ms);
      function end() { clearTimeout(timer); wake = undefined; resolve(); }
      wake = end;
    });
  }
  async function cleanup() {
    let writerError: unknown;
    try { await writes; await io.writer.flush(); } catch (error) { writerError = error; }
    child?.stdin.end();
    await waitExit(timing.eof);
    if (child && !exited) child.kill("SIGTERM");
    await waitExit(timing.term);
    if (child && !exited) {
      const reaped = new Promise<void>(resolve => child!.once("exit", () => resolve()));
      child.kill("SIGKILL"); await reaped;
    }
    // Reaping the owned process is independent of descendants holding its pipes.
    child?.stdout.destroy(); child?.stderr.destroy(); child?.stdin.destroy();
    buffer = "";
    try {
      if (writerError) throw writerError;
      if (claim !== "cancelled") {
        await io.writer.write(JSON.stringify({ __t2f5_done__: claim === "completed" ? 0 : claim === "interrupted" ? 130 : 1 }) + "\n");
        await io.writer.flush();
      }
    } finally {
      signals.off("SIGTERM", signal); signals.off("SIGINT", signal);
      detach?.();
      try { io.peer?.send({ type: "run-finalized", runId: options.runId }); io.peer?.close(); } catch (error) { log(`peer: ${error}`); }
    }
  }
  async function steer(message: SteerRequest): Promise<SteerResult> {
    const base = { type: "steer-result" as const, reqId: message.reqId };
    if (claim || !turnId) return { ...base, outcome: "expired", detail: "refused" };
    try {
      const result = await request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: message.text, text_elements: [] }] }, timing.steer);
      return typeof result?.turnId === "string" ? { ...base, outcome: "delivered", detail: null } : { ...base, outcome: "expired", detail: "refused" };
    } catch (error) {
      return { ...base, outcome: (error as Error).message.startsWith("RPC:") ? "expired" : "dropped", detail: (error as Error).message.startsWith("RPC:") ? "refused" : "unknown" };
    }
  }
  function threadStarted(id: unknown) {
    if (typeof id !== "string" || (threadId && threadId !== id)) return;
    threadId = id;
    if (!threadWritten) { threadWritten = true; writeExecRecord({ type: "thread.started", thread_id: id }); }
  }
  function notification(method: string, p: Frame) {
    if (stallMethod) armStallWatchdog(stallMethod);
    if (method === "thread/started") { threadStarted(p.thread?.id); return; }
    if (!threadId || p.threadId !== threadId) return;
    if (method === "turn/started") {
      if (turnId && turnId !== p.turn?.id) return;
      if (typeof p.turn?.id !== "string") return;
      turnId = p.turn.id; clearTimeout(startup);
      if (!turnWritten) { turnWritten = true; writeExecRecord({ type: "turn.started" }); publish(); }
      return;
    }
    if (!turnId || (p.turnId ?? p.turn?.id) !== turnId) return;
    if (method === "thread/tokenUsage/updated") usage = p.tokenUsage?.total;
    if (method === "item/completed") {
      const item = p.item;
      if (!item || typeof item !== "object") return;
      let mapped: Frame | undefined;
      if (item.type === "agentMessage") mapped = { type: "agent_message", text: item.text };
      if (item.type === "commandExecution") mapped = { type: "command_execution", command: item.command, aggregated_output: item.aggregatedOutput ?? "", ...(typeof item.exitCode === "number" ? { exit_code: item.exitCode } : {}), status: item.status === "declined" ? "failed" : item.status };
      if (item.type === "fileChange") mapped = { type: "file_change", changes: item.changes?.map((c: Frame) => ({ path: c.path, kind: c.kind?.type })), status: item.status === "declined" ? "failed" : item.status };
      if (item.type === "mcpToolCall") mapped = { type: "mcp_tool_call", server: item.server, tool: item.tool, arguments: item.arguments, ...(item.result ? { result: { content: item.result.content, structured_content: item.result.structuredContent, ...(item.result._meta ? { _meta: item.result._meta } : {}) } } : {}), ...(item.error ? { error: item.error } : {}), status: item.status };
      if (item.type === "reasoning") mapped = { type: "reasoning", text: (item.summary ?? []).join("\n") };
      if (item.type === "webSearch") mapped = { type: "web_search", query: item.query };
      if (mapped) writeExecRecord({ type: "item.completed", item: { id: item.id, ...mapped } });
    }
    if (method === "turn/completed") {
      if (p.turn.status === "completed") {
        writeExecRecord({ type: "turn.completed", ...(usage ? { usage: { input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens, cache_write_input_tokens: usage.cacheWriteInputTokens, output_tokens: usage.outputTokens, reasoning_output_tokens: usage.reasoningOutputTokens } } : {}) });
        claimTerminal("completed");
      } else if (p.turn.status === "failed") claimTerminal("failed", p.turn.error?.message ?? "turn failed");
      else if (p.turn.status === "interrupted") claimTerminal("interrupted");
    }
  }
  function frame(line: string) {
    if (claim) return;
    try {
      const f: Frame = JSON.parse(line);
      if (!f || typeof f !== "object" || Array.isArray(f) || (!f.method && !Object.hasOwn(f, "id"))) throw new Error("invalid frame");
      if (Object.hasOwn(f, "method") && (typeof f.method !== "string" || !f.method)) throw new Error("invalid method");
      if (Object.hasOwn(f, "id") && typeof f.id !== "string" && typeof f.id !== "number") throw new Error("invalid id");
      if (f.params !== undefined && (!f.params || typeof f.params !== "object" || Array.isArray(f.params))) throw new Error("invalid params");
      if (!Object.hasOwn(f, "method") && (Object.hasOwn(f, "result") === Object.hasOwn(f, "error"))) throw new Error("invalid response");
      if (f.jsonrpc !== undefined && f.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC version");
      if (Object.hasOwn(f, "method") && (Object.hasOwn(f, "result") || Object.hasOwn(f, "error"))) throw new Error("mixed request/response");
      if (Object.hasOwn(f, "error") && (!f.error || typeof f.error !== "object" || Array.isArray(f.error) || typeof f.error.message !== "string")) throw new Error("invalid RPC error");
      if (typeof f.method === "string") {
        if (Object.hasOwn(f, "id")) {
          const response = respondToServerRequest(f.method);
          if ("error" in response) log(`unsupported server request: ${f.method}`);
          try { send({ id: f.id, ...response }); }
          catch (error) { claimTerminal("failed", `app-server transport: ${error}`); return; }
          armStallWatchdog(f.method);
        } else notification(f.method, f.params ?? {});
      } else {
        const entry = pending.get(f.id);
        if (entry) { pending.delete(f.id); clearTimeout(entry.timer); if (f.error) entry.reject(new Error(`RPC: ${f.error.message}`)); else entry.resolve(f.result); }
      }
      malformed = 0;
    } catch (error) {
      log(`malformed app-server frame: ${error}`);
      if (++malformed >= 3) claimTerminal("failed", "three consecutive malformed app-server frames");
    }
  }
  function consumeFrames() {
    let index: number;
    while (!claim && !paused && (index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.length > 1024 * 1024) { claimTerminal("failed", "app-server frame exceeds limit"); return; }
      frame(line);
    }
    if (!paused && buffer.length > 1024 * 1024) claimTerminal("failed", "app-server frame exceeds limit");
    // EOF (or the post-exit cutoff) cannot discard frames waiting on the writer.
    if (!claim && !paused && inputEnded) claimTerminal("failed", buffer ? "app-server truncated frame at EOF" : exited ? "app-server exit before turn/completed" : "app-server EOF before turn/completed");
  }
  signals.on("SIGTERM", signal); signals.on("SIGINT", signal);
  startup = setTimeout(() => claimTerminal("failed", "turn/started timeout after spawn"), timing.startup);
  try {
    const [command = "codex", ...args] = options.command ?? ["codex", "app-server"];
    child = io.spawn ? io.spawn() : spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, detached: false, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", error => { exited = true; wake?.(); claimTerminal("failed", `spawn: ${error.message}`); });
    child.on("exit", () => {
      exited = true; wake?.();
      if (claim) return;
      clearTimeout(startup); clearTimeout(stall);
      // Descendants may hold stdout open. Stop intake after a bounded grace,
      // retaining both the parser buffer and bytes already in the readable queue.
      postExit = setTimeout(() => {
        child!.stdout.read();
        child!.stdout.destroy();
        endInput();
      }, 2000);
      consumeFrames();
    });
    child.stdin.on("error", error => claimTerminal("failed", `app-server stdin: ${error.message}`));
    child.stderr.on("data", data => log(String(data)));
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", data => {
      if (claim) return;
      buffer += decoder.write(data);
      // A single delivered chunk can contain many frames even after pause().
      // Bound retained decoded input as well as the record queue.
      if (buffer.length > 2 * 1024 * 1024) { claimTerminal("failed", "app-server input buffer exceeds limit"); return; }
      consumeFrames();
    });
    function endInput() {
      if (inputEnded) return;
      inputEnded = true; clearTimeout(postExit);
      buffer += decoder.end();
      consumeFrames();
    }
    child.stdout.on("end", endInput);
    try { detach = io.peer?.subscribe(message => {
      if (message.type === "owner-ready") publish();
      else void steer(message).then(result => { try { io.peer?.send(result); } catch (error) { log(`peer: ${error}`); } });
    }); } catch (error) { log(`peer attachment: ${error}`); }
    void (async () => {
      let step = "initialize";
      try {
        const identity = await request(step, { clientInfo, capabilities: null });
        if (claim) return;
        assertAppServerIdentity(identity?.userAgent, clientInfo); send({ method: "initialized" });
        step = "thread/start";
        const thread = await request(step, policy.thread);
        if (claim) return;
        threadStarted(thread?.thread?.id);
        if (!threadId) throw new Error("missing thread id");
        step = "turn/start";
        const turn = await request(step, { ...policy.turn, threadId, input: [{ type: "text", text: options.prompt, text_elements: [] }] });
        if (!claim && !turnId && typeof turn?.turn?.id === "string") turnId = turn.turn.id;
      } catch (error) { claimTerminal("failed", `${step}: ${(error as Error).message}`); }
    })();
  } catch (error) { exited = true; claimTerminal("failed", `spawn: ${(error as Error).message}`); }
  return done;
}

export async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Expected driver JSON config path");
  const config = JSON.parse(await readFile(configPath, "utf8")) as DriverOptions & { streamPath: string };
  const stream = await open(config.streamPath, "a", 0o600);
  try { await runAppServerDriver(config, { writer: { async write(line) { await stream.writeFile(line); }, async flush() { await stream.sync(); } } }); }
  finally { await stream.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
