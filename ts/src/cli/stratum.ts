#!/usr/bin/env -S node --experimental-strip-types
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { agentRunsRoot, T2F5_DONE_SENTINEL } from "../connectors/background.js";
import { StratumEngine } from "../engine/engine.js";
import { createEvaluator } from "../eval/expr.js";
import { validateSpec } from "../ir/validate.js";
import { checkLegacyYaml, renderCompatReport } from "../migrate/check.js";
import { assertEvent, eventContract } from "../mcp/contracts.js";
import { gateCommand, queryCommand } from "./query_gate.js";

const AGENT_RUN_ID = /^[0-9a-f]{12}$/;
const EVENT_TEXT_CAP = 2_000;
const AGENT_EVENT_KINDS = new Set(["started", "assistant", "reasoning", "tool", "usage", "error"]);
const DEFAULT_AGENT_EVENT_KINDS = new Set(["assistant", "tool", "error"]);

type Mode = "text" | "json" | "events";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  if (command === "validate") return validateCommand(args);
  if (command === "migrate") return migrateCommand(args);
  if (command === "query") return queryCommand(args);
  if (command === "gate") return gateCommand(args);
  if (command === "watch") return watchCommand(args);
  process.stderr.write("Usage: stratum <validate|migrate|query|gate|watch> ...\n");
  return 2;
}

async function validateCommand(args: string[]): Promise<number> {
  if (args.length !== 1) {
    process.stderr.write("Usage: stratum validate <spec.yaml>\n");
    return 2;
  }
  try {
    const source = await readFile(args[0]!, "utf8");
    const parsed = parseDocument(source, { prettyErrors: false });
    if (parsed.errors.length > 0) throw new Error(parsed.errors.map((error) => error.message).join("; "));
    const spec = parsed.toJS() as unknown;
    const result = validateSpec(spec);
    process.stdout.write(`${JSON.stringify(result.ok ? { valid: true } : { valid: false, errors: result.errors })}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`stratum validate: ${message(error)}\n`);
    return 2;
  }
}

async function migrateCommand(args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== "--check") {
    process.stderr.write("Usage: stratum migrate --check <old.yaml>\n");
    return 2;
  }
  try {
    process.stdout.write(renderCompatReport(checkLegacyYaml(await readFile(args[1]!, "utf8"))));
    return 0;
  } catch (error) {
    process.stderr.write(`stratum migrate: ${message(error)}\n`);
    return 2;
  }
}

export async function watchCommand(argv: string[]): Promise<number> {
  const parsed = parseWatch(argv);
  if (typeof parsed === "number") return parsed;
  const flow = await createFlowEngine().flowPoll(parsed.runId, 0).catch(() => undefined);
  if (flow) return watchFlow(parsed, flow.nextCursor === 0 ? 0 : 0);
  return watchAgent(parsed);
}

interface WatchOptions { runId: string; mode: Mode; kinds?: Set<string> }

function parseWatch(argv: string[]): WatchOptions | number {
  let mode: Mode = "text";
  const args = [...argv];
  const json = take(args, "--json");
  const events = take(args, "--events");
  const kindArgs = args.filter((arg) => arg.startsWith("--kinds="));
  for (const arg of kindArgs) args.splice(args.indexOf(arg), 1);
  const usage = "Usage: stratum watch <run_id> [--json | --events [--kinds=k1,k2,...]]";
  if (json && events || kindArgs.length > 1 || kindArgs.length > 0 && !events || args.length !== 1) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  if (json) mode = "json";
  if (events) mode = "events";
  const kinds = kindArgs.length === 1 ? new Set(kindArgs[0]!.slice("--kinds=".length).split(",")) : undefined;
  return { runId: args[0]!, mode, ...(kinds ? { kinds } : {}) };
}

async function watchFlow(options: WatchOptions, cursor: number): Promise<number> {
  const engine = createFlowEngine();
  const flowKinds = options.kinds;
  // Flow event kinds are frozen in events.json, so validate the filter against that
  // contract before waiting. Agent-only labels intentionally do not apply here.
  if (flowKinds) {
    const contract = await eventContract();
    for (const kind of flowKinds) {
      if (!(kind in contract.kinds)) {
        process.stderr.write(`stratum watch: unknown flow event kind ${kind}\n`);
        return 2;
      }
    }
  }
  while (true) {
    const poll = await engine.flowPoll(options.runId, cursor);
    cursor = poll.nextCursor;
    for (const event of poll.events) {
      await assertEvent(event);
      if (flowKinds && !flowKinds.has(event.type)) continue;
      printFlowEvent(options.mode, event);
    }
    if (poll.status !== "running") return poll.status === "completed" ? 0 : 1;
    await delay(500);
  }
}

async function watchAgent(options: WatchOptions): Promise<number> {
  if (options.kinds && ![...options.kinds].every((kind) => AGENT_EVENT_KINDS.has(kind))) {
    process.stderr.write(`stratum watch: unknown --kinds value; valid agent kinds: ${[...AGENT_EVENT_KINDS].join(", ")}\n`);
    return 2;
  }
  if (!AGENT_RUN_ID.test(options.runId)) return unknownRun(options);
  let meta: AgentMeta;
  try {
    meta = JSON.parse(await readFile(join(agentRunsRoot(), options.runId, "meta.json"), "utf8")) as AgentMeta;
  } catch { return unknownRun(options); }
  if (meta.runId !== options.runId || typeof meta.streamPath !== "string") return unknownRun(options);
  // Incremental BYTE-offset reads: only new bytes are read each poll, and a
  // UTF-8 character split across writes stays whole in the pending byte
  // buffer until its line completes (string offsets would misalign on the
  // replacement character a partial decode inserts).
  let position = 0;
  let pendingBytes: Buffer = Buffer.alloc(0);
  while (true) {
    let chunk: Buffer | undefined;
    try {
      const handle = await open(meta.streamPath, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > position) {
          const buffer = Buffer.alloc(size - position);
          await handle.read(buffer, 0, buffer.length, position);
          position = size;
          chunk = buffer;
        }
      } finally {
        await handle.close();
      }
    } catch { /* a just-created stream may briefly be absent */ }
    if (chunk) {
      pendingBytes = pendingBytes.length > 0 ? Buffer.concat([pendingBytes, chunk]) : chunk;
      let newline = pendingBytes.indexOf(10);
      while (newline >= 0) {
        const line = pendingBytes.subarray(0, newline).toString("utf8").trim();
        pendingBytes = pendingBytes.subarray(newline + 1);
        newline = pendingBytes.indexOf(10);
        if (!line) continue;
        let parsedLine: unknown;
        try { parsedLine = JSON.parse(line); } catch { continue; }
        // JSONL primitives (null, strings, numbers) are noise, not records —
        // they must not crash the watcher (Python skips them too).
        if (!isRecord(parsedLine)) continue;
        const record: Record<string, unknown> = parsedLine;
        if (T2F5_DONE_SENTINEL in record) {
          const rc = number(record[T2F5_DONE_SENTINEL]) ?? 1;
          if (options.mode === "json") lineOut(record);
          else if (options.mode === "events") lineOut({ event: "done", rc });
          else process.stdout.write(`run ${options.runId} finished rc=${rc}\n`);
          return rc;
        }
        printAgentRecord(options, record, meta);
      }
      continue;
    }
    if (!agentAlive(meta.childPid)) {
      const stderrTail = meta.stderrPath ? await readFile(meta.stderrPath, "utf8").catch(() => "") : "";
      if (options.mode === "events") lineOut({ event: "died", reason: "child_died_without_sentinel", stderr_tail: cap(stderrTail, meta.stderrPath ?? meta.streamPath) });
      process.stderr.write(`run ${options.runId} died without completion sentinel\n`);
      if (stderrTail) process.stderr.write(`${stderrTail}\n`);
      return 1;
    }
    await delay(500);
  }
}

function printFlowEvent(mode: Mode, event: { type: string; stepId?: string; detail?: unknown; at: string }): void {
  if (mode === "json" || mode === "events") lineOut(event);
  else process.stdout.write(`${event.at} ${event.type}${event.stepId ? ` ${event.stepId}` : ""}\n`);
}

function printAgentRecord(options: WatchOptions, record: Record<string, unknown>, meta: AgentMeta): void {
  if (options.mode === "json") { lineOut(record); return; }
  const event = mapAgentRecord(record, meta);
  if (!event) return;
  if (options.mode === "events") {
    const kinds = options.kinds ?? DEFAULT_AGENT_EVENT_KINDS;
    if (kinds.has(event.event)) lineOut(event);
    return;
  }
  if (event.event === "assistant") process.stdout.write(`${event.text}\n`);
  if (event.event === "tool") process.stdout.write(`[${event.tool}] ${event.summary}\n`);
}

function mapAgentRecord(record: Record<string, unknown>, meta: AgentMeta): AgentEvent | undefined {
  if (record.type === "thread.started") return { event: "started", model: meta.model ?? "", prompt_chars: meta.promptChars ?? 0 };
  if (record.type === "error") return { event: "error", message: cap(stringValue(record.message), meta.streamPath) };
  if (record.type === "turn.completed") {
    const usage = isRecord(record.usage) ? record.usage : {};
    return { event: "usage", input_tokens: number(usage.input_tokens) ?? 0, output_tokens: number(usage.output_tokens) ?? 0, cache_read_input_tokens: number(usage.cached_input_tokens) ?? 0 };
  }
  if (record.type !== "item.completed" || !isRecord(record.item)) return undefined;
  const item = record.item;
  if (item.type === "agent_message") return { event: "assistant", text: cap(stringValue(item.text), meta.streamPath) };
  if (item.type === "reasoning") return { event: "reasoning", text: cap(stringValue(item.text), meta.streamPath) };
  if (item.type === "command_execution") return { event: "tool", tool: "bash", summary: cap(stringValue(item.command), meta.streamPath), ok: (number(item.exit_code) ?? 1) === 0, duration_ms: number(item.duration_ms) ?? 0 };
  return undefined;
}

function unknownRun(options: WatchOptions): number {
  const text = `unknown run_id ${options.runId}`;
  if (options.mode === "events") lineOut({ event: "error", message: text });
  process.stderr.write(`stratum watch: ${text}\n`);
  return 2;
}

function createFlowEngine(): StratumEngine { return new StratumEngine({ ...(process.env.STRATUM_STATE_ROOT ? { stateRoot: process.env.STRATUM_STATE_ROOT } : {}), evaluator: createEvaluator() }); }
function take(args: string[], value: string): boolean { const index = args.indexOf(value); if (index < 0) return false; args.splice(index, 1); return true; }
function lineOut(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function cap(value: string, streamPath: string): string { return value.length <= EVENT_TEXT_CAP ? value : `[truncated, full stream at ${streamPath}]\n${value.slice(-100)}`; }
function agentAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface AgentMeta { runId: string; streamPath: string; stderrPath?: string; childPid?: number; model?: string; promptChars?: number }
type AgentEvent =
  | { event: "started"; model: string; prompt_chars: number }
  | { event: "assistant" | "reasoning"; text: string }
  | { event: "tool"; tool: string; summary: string; ok: boolean; duration_ms: number }
  | { event: "usage"; input_tokens: number; output_tokens: number; cache_read_input_tokens: number }
  | { event: "error"; message: string };

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  void main().then((code) => { process.exitCode = code; });
}
