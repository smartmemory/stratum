# STRAT-AGENT-BG-WRITE-1 Design: Workspace-Write Background Agent Mode + Tool Allowlists

**Status:** DESIGN  
**Phase:** STRAT-AGENT: Agent Surface  
**Created:** 2026-07-18  
**Revised:** 2026-07-18 (r2 — design-gate findings addressed)  
**Related:** [feature.json](./feature.json), GitHub #18

---

## Problem Statement

Two capability gaps in the agent surface (both surfaced during the E3 GSD pipeline build):

**Gap A — Background runs are codex-only and read-only-only:**  
`background.ts:65` throws for any `agent !== "codex"`. `background.ts:68` throws for any `sandboxMode !== "read-only"`. GSD worktree consumer items need Claude in `workspace-write` mode. Because no background path exists, Compose calls `stratum_agent_run` synchronously — the call blocks, returns no `runId`, and cannot be interrupted. When the user cancels a flow mid-fanout, new consumer items stop being dispatched but the already-running Claude agent keeps writing to the worktree with no kill path. Items fail post-hoc on timeout.

**Gap B — Tool availability restrictions cannot be carried over the MCP wire:**  
`ClaudeConnectorOptions.allowedTools` and `disallowedTools` exist in the internal TypeScript types and are wired through `runAgent()` to `ClaudeConnector`, but `stratum_agent_run`'s MCP surface contract (`mcp-surface.json:152`) does not declare these fields, and `server.ts:111-120` never reads them from the request. Even if a caller sent them, `assertToolRequest` (strict `additionalProperties: false` validation) would reject the call. Additionally, `ClaudeConnector` currently maps `allowedTools` to the SDK `allowedTools` param (auto-approve/permission only) rather than the SDK `tools` param (availability restriction — which tools the model is offered at all). This is the root cause of the reviewer read-only boundary failure in E3 (commit `9221548` Compose workaround). Compose bypasses stratum entirely for availability restriction.

---

## Scope

This feature is engine-side only. Compose-side wiring of the new capabilities is a follow-on slice in the compose repo.

Two independent sub-features that share a design review:

| Sub-feature | Tag | Files touched |
|---|---|---|
| Background workspace-write runs (claude via Worker Threads; codex workspace-write) | BG-WRITE-A | `background.ts`, new `claude-bg-worker.ts`, `runner.ts`, `mcp-surface.json`, `server.ts` |
| Tool allowlists over MCP wire (availability restriction fix) | BG-WRITE-B | `claude.ts`, `mcp-surface.json`, `server.ts` |

---

## Architecture Overview

### Existing agent background infrastructure (Codex only)

```
stratum_agent_run { background: true, agent: "codex" }
  → startBackgroundRun()
      → newRunDir()   creates ~/.stratum/ts/agent_runs/<12-hex-runId>/
      → writeFile     stream.jsonl, stream.jsonl.err, stream.jsonl.in
      → spawn("sh", ["-c", T2F5_SHELL_WRAPPER, "sh", ...codexCommand()])
                      detached=true, stdio="ignore", child.unref()
      → atomicWriteJson(meta.json)
          { runId, agent:"codex", childPid, procStartTime, sandboxMode, streamPath, ... }
      → returns { status:"bg_started", runId, pid, streamPath }

stratum_agent_poll { runId }
  → loadMeta()        reads meta.json, validates agent==="codex"
  → scanStream()      parses JSONL until T2F5_DONE_SENTINEL
  → processIdentityMatches(pid, procStartTime)   liveness via /proc or libproc
  → returns { status:"running"|"complete"|"error", ... }

stratum_cancel_agent_run { runId }
  → loadMeta()
  → scanStream()      already done → already_complete/already_error
  → processIdentityMatches × 2 + processGroupId check
  → process.kill(-pid, "SIGTERM")  kills whole process group
  → returns { status:"cancelled" }
```

The JSONL stream format (both Codex and Claude worker will emit this):
```jsonl
{"type":"item.completed","item":{"type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}
{"__t2f5_done__":0}
```

---

## BG-WRITE-A: Workspace-Write Background Agent Runs

### A1. Codex workspace-write (trivial unlock)

Remove the guard at `background.ts:68`. `sandboxMode` is already persisted in `BackgroundRunMeta` and passed through to `codexCommand()`. No other changes needed for Codex.

```diff
- if (sandboxMode !== "read-only") throw new Error("workspace-write durable background runs are not supported in v1");
```

### A2. Claude background runs via Worker Threads

**Why Worker Threads instead of a subprocess:**  
`ClaudeConnector` uses `@anthropic-ai/claude-agent-sdk`'s `query()` async generator — an in-process SDK call, not a CLI invocation. There is no `claude` binary equivalent of `codexCommand`. A subprocess approach would require shipping a separate runner binary and a build step. Worker Threads are the idiomatic Node.js isolation boundary for in-process async work that needs true termination: `worker.terminate()` kills the thread hard, which is "death-confirmed" in the same sense as SIGTERM to a process group — all writes stop immediately.

**Why not AbortController:**  
AbortController is cooperative (the SDK must observe the signal). Worker thread termination is unconditional — it mirrors the forceful kill semantics of `process.kill(-pid, "SIGTERM")` that the Codex path provides.

**Why JSONL stream normalization (Codex-compatible format):**  
The worker writes events in the same format as the Codex shell wrapper. This lets `scanStream()` parse both without branching per agent type. The claude-agent-sdk emits different event shapes internally; the worker normalizes them to `item.completed`/`turn.completed`/`__t2f5_done__` before writing.

### New file: `ts/src/connectors/claude-bg-worker.ts`

Worker thread entry point. Receives `workerData`, runs `ClaudeConnector`, writes normalized JSONL to stream, writes sentinel.

```typescript
// claude-bg-worker.ts
import { workerData } from "node:worker_threads";
import { createWriteStream } from "node:fs";
import { ClaudeConnector, type ClaudeConnectorOptions } from "./claude.js";
import { T2F5_DONE_SENTINEL } from "./background.js";

interface WorkerInput {
  prompt: string;
  connectorOptions: ClaudeConnectorOptions;
  streamPath: string;
}

const { prompt, connectorOptions, streamPath } = workerData as WorkerInput;
const stream = createWriteStream(streamPath, { flags: "a", encoding: "utf8" });

function writeLine(record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(record) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

async function run(): Promise<void> {
  // Override the query function to intercept SDK events and write normalized JSONL.
  let inputTokens = 0;
  let outputTokens = 0;

  const connector = new ClaudeConnector({
    ...connectorOptions,
    query: async function* (params) {
      const { query as sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
      for await (const raw of sdkQuery(params as Parameters<typeof sdkQuery>[0])) {
        const r = raw as Record<string, unknown>;
        // Normalize to scanStream-compatible JSONL:
        if (r.type === "assistant" && isRecord(r.message) && Array.isArray((r.message as Record<string, unknown>).content)) {
          for (const block of (r.message as Record<string, unknown>).content as unknown[]) {
            if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
              await writeLine({ type: "item.completed", item: { type: "agent_message", text: block.text } });
            }
          }
        }
        if (r.type === "result" && isRecord(r.usage)) {
          inputTokens += Number(r.usage.input_tokens) || 0;
          outputTokens += Number(r.usage.output_tokens) || 0;
          await writeLine({ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
        }
        yield raw;
      }
    },
  });

  await connector.run(prompt);
}

// Finding 5 fix: stream errors in writeLine reject individual Promises but do not crash
// the worker — the outer .catch() below writes the error sentinel to the stream
// (best-effort) and stream.end() always runs via .finally(). If stream.end() itself
// fails (e.g. disk full after the sentinel), the worker process exits uncleanly, which
// causes the 'exit' event on the parent, and the exit-handler's writeSentinelIfAbsent
// writes a rc=1 sentinel so poll always finds a terminal state.
run()
  .then(() => writeLine({ [T2F5_DONE_SENTINEL]: 0 }))
  .catch(async (err: unknown) => {
    // Truncate error message to avoid unbounded writes on pathological errors
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    await writeLine({ type: "error", message: msg }).catch(() => {/* stream may be broken */});
    await writeLine({ [T2F5_DONE_SENTINEL]: 1 }).catch(() => {/* best-effort */});
  })
  .finally(() => stream.end());

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

> **Note on query seam:** The actual implementation will need to integrate with the query injection seam in `ClaudeConnector` (the `query?: QueryFunction` option). The worker wraps the default `sdkQuery` to intercept events before they reach `ConnectorResult` accumulation.

### Modified: `ts/src/connectors/background.ts`

**Type changes — `BackgroundRunMeta`:**

```typescript
// Before (codex-only):
export interface BackgroundRunMeta {
  runId: string;
  agent: "codex";
  childPid: number;
  procStartTime?: string;
  sandboxMode: CodexSandboxMode;
  ...
}

// After (discriminated union):
interface BackgroundRunMetaBase {
  runId: string;
  model: string;
  cwd: string;
  sandboxMode: CodexSandboxMode;
  promptChars: number;
  createdAt: string;
  streamPath: string;
  stderrPath: string;
}

export interface CodexRunMeta extends BackgroundRunMetaBase {
  agent: "codex";
  childPid: number;
  procStartTime?: string;
}

export interface ClaudeRunMeta extends BackgroundRunMetaBase {
  agent: "claude";
  allowedTools?: string[];
  disallowedTools?: string[];
  // No pid or procStartTime — worker lifecycle tracked in-memory
}

export type BackgroundRunMeta = CodexRunMeta | ClaudeRunMeta;
```

**In-memory Claude worker registry (module-level):**

```typescript
interface ClaudeBgEntry {
  worker: Worker;       // from node:worker_threads
  isAlive: boolean;     // set to false on 'exit' event
  cancelling: boolean;  // set before worker.terminate() — suppresses exit-handler sentinel (Fix: cancel/exit race)
}
const claudeWorkerRegistry = new Map<string, ClaudeBgEntry>();
```

**`startBackgroundRun()` dispatch:**

```typescript
export async function startBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; pid?: number; streamPath: string;
}> {
  // Remove guard at line 65 (agent !== "codex")
  // Remove guard at line 68 (sandboxMode !== "read-only")
  if (options.budgeted) throw new Error("background agent runs cannot debit run budgets yet");

  if (options.agent === "claude") {
    return startClaudeBackgroundRun(options);
  }
  // Codex path (unchanged except guard removal):
  const sandboxMode = options.sandboxMode ?? "read-only";
  ...
}
```

**New `startClaudeBackgroundRun()` (internal):**

```typescript
async function startClaudeBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; streamPath: string;
}> {
  // Finding 1 fix: reject read-only sandboxMode for claude bg — enforcement is not implemented
  // in v1. Claude background runs are workspace-write only. Future: map read-only to
  // disallowedTools restrictions once the SDK restriction surface is settled.
  if (options.sandboxMode === "read-only") {
    throw new Error(
      "claude background runs with sandboxMode='read-only' are not supported in v1. " +
      "Claude's permissionMode cannot be safely enforced via the SDK without a mapped " +
      "tool restriction list. Omit sandboxMode or pass 'workspace-write' explicitly."
    );
  }
  const registryRoot = options.registryRoot ?? agentRunsRoot();
  const { runId, runDir } = await newRunDir(registryRoot);
  const streamPath = join(runDir, "stream.jsonl");
  const stderrPath = `${streamPath}.err`;
  const inputPath = `${streamPath}.in`;
  await Promise.all([
    writeFile(streamPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(stderrPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(inputPath, options.prompt, { encoding: "utf8", mode: 0o600 }),
  ]);
  const model = options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
  const sandboxMode = options.sandboxMode ?? "workspace-write";  // default write for claude bg (see D4)
  const workerInput: WorkerInput = {
    prompt: options.prompt,
    connectorOptions: {
      model,
      cwd: options.cwd,
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.env ? { env: options.env } : {}),
    },
    streamPath,
  };
  const worker = new Worker(new URL("./claude-bg-worker.js", import.meta.url), {
    workerData: workerInput,
  });
  const entry: ClaudeBgEntry = { worker, isAlive: true, cancelling: false };
  claudeWorkerRegistry.set(runId, entry);
  worker.once("exit", () => {
    entry.isAlive = false;
    // Finding 2 fix: only write the error sentinel when cancel() didn't already claim
    // ownership of the terminal record. Without this guard, cancel + exit both call
    // writeSentinelIfAbsent concurrently — whichever checks "no sentinel" second wins,
    // producing nondeterministic rc=1 vs rc=130.
    if (!entry.cancelling) {
      writeSentinelIfAbsent(streamPath, 1).catch(() => {/* best-effort */});
    }
  });
  // Finding 5 fix: 'error' event fires when the worker fails to start or throws an
  // uncaught top-level exception. Without a listener Node.js emits an uncaught exception
  // and crashes the MCP process. Write a bounded error + sentinel so poll returns 'error'.
  worker.on("error", (err: Error) => {
    entry.isAlive = false;
    if (!entry.cancelling) {
      const errorLine = JSON.stringify({ type: "error", message: err.message.slice(0, 2000) }) + "\n";
      const sentinelLine = JSON.stringify({ [T2F5_DONE_SENTINEL]: 1 }) + "\n";
      appendFile(streamPath, errorLine + sentinelLine, { encoding: "utf8" }).catch(() => {/* best-effort */});
    }
  });
  const meta: ClaudeRunMeta = {
    runId, agent: "claude", model, cwd: options.cwd, sandboxMode,
    promptChars: options.prompt.length, createdAt: new Date().toISOString(),
    streamPath, stderrPath,
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
  };
  await atomicWriteJson(join(runDir, "meta.json"), meta);
  return { status: "bg_started", runId, streamPath };
}
```

**`loadMeta()` — relax agent check:**

```typescript
// Before:
if (!isRecord(raw) || raw.runId !== runId || raw.agent !== "codex") return undefined;

// After:
if (!isRecord(raw) || raw.runId !== runId || (raw.agent !== "codex" && raw.agent !== "claude")) return undefined;
```

**`pollBackgroundRun()` — claude branch:**

```typescript
export async function pollBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<BackgroundPollResult> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };
  const { streamPath, stderrPath } = loaded;
  const scan = await scanStream(streamPath);
  const text = capText(scan.text, streamPath);

  if (loaded.meta.agent === "claude") {
    // Claude path: liveness from in-memory registry, not proc_identity
    if (scan.exitCode === undefined) {
      const entry = claudeWorkerRegistry.get(runId);
      if (entry?.isAlive) {
        return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
      }
      // Not alive and no sentinel = worker died unexpectedly (or server restarted)
      return {
        status: "error", runId, reason: "child_died_without_sentinel", textTail: text,
        stderrTail: await tailText(stderrPath), eventsSeen: scan.eventsSeen, streamPath,
      };
    }
    const telemetry = await terminalTelemetry(loaded.meta, streamPath);
    if (scan.exitCode === 0 && scan.error === undefined) {
      return { status: "complete", runId, text, usage: scan.usage, exitCode: 0, telemetry };
    }
    return { status: "error", runId, exitCode: scan.exitCode, textTail: text,
      stderrTail: await tailText(stderrPath), ...(scan.error ? { reason: scan.error } : {}), telemetry };
  }

  // Codex path — unchanged
  ...
}
```

**`cancelBackgroundRun()` — claude branch:**

```typescript
export async function cancelBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<Record<string, unknown>> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };

  if (loaded.meta.agent === "claude") {
    const scan = await scanStream(loaded.streamPath);
    if (scan.exitCode !== undefined) {
      return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
    }
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return { status: "not_found", runId };   // server restart case
    if (!entry.isAlive) return { status: "already_error", runId };
    // Finding 2 fix: claim ownership of the terminal record BEFORE terminating.
    // worker.terminate() triggers the 'exit' event; if that handler fires before
    // writeSentinelIfAbsent(130) below, both callers could race through the "no sentinel yet"
    // guard and write conflicting sentinels (rc=1 vs rc=130). Setting cancelling=true here
    // causes the exit handler to skip its sentinel write.
    entry.cancelling = true;
    // Death-confirmed: await worker.terminate() blocks until the thread is truly dead
    await entry.worker.terminate();
    // Write cancellation sentinel (exit code 130 = SIGTERM convention)
    await writeSentinelIfAbsent(loaded.streamPath, 130);
    return { status: "cancelled", runId };
  }

  // Codex path — unchanged (process.kill(-pid, "SIGTERM"))
  ...
}
```

**`writeSentinelIfAbsent()` helper (new):**

```typescript
async function writeSentinelIfAbsent(streamPath: string, exitCode: number): Promise<void> {
  const scan = await scanStream(streamPath);
  if (scan.exitCode !== undefined) return;  // already has sentinel
  const line = JSON.stringify({ [T2F5_DONE_SENTINEL]: exitCode }) + "\n";
  await appendFile(streamPath, line, { encoding: "utf8" });
}
```

### Modified: `ts/src/connectors/runner.ts`

**Finding 4 fix — make `pid` optional in `runAgent` return type (runner.ts:27).**  
`runAgent` currently promises `pid: number` (mandatory) in its `bg_started` branch. Claude background runs return no OS pid — the worker has only a `threadId`. Change the TypeScript return union:

```typescript
// Before (runner.ts:27):
Promise<ConnectorResult | { status: "bg_started"; runId: string; pid: number; streamPath: string }>

// After:
Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string }>
```

This change belongs in BG-WRITE-A, not just the MCP surface contract. The TS type must be updated at the `runAgent` declaration so callers don't assume a pid is always present.

Pass `allowedTools`/`disallowedTools` through the background path (currently dropped at this boundary):

```typescript
if (options.background) {
  return startBackgroundRun({
    agent: options.agent,
    prompt: options.prompt,
    cwd,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
    ...(options.budgeted !== undefined ? { budgeted: options.budgeted } : {}),
    ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(boundaries.backgroundCommand !== undefined ? { command: boundaries.backgroundCommand } : {}),
    // NEW: carry tool filters through to background run
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
  });
}
```

Also add `allowedTools?` and `disallowedTools?` to `StartBackgroundRunOptions`:
```typescript
export interface StartBackgroundRunOptions {
  ...
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

### MCP surface contract changes

**`bg_started` response — make `pid` optional (claude runs have no OS pid):**

```json
"bg_started": { "runId": "string", "pid?": "number", "streamPath": "string" }
```

---

## BG-WRITE-B: Tool Allowlists over MCP Wire

### Root cause fix in `ts/src/connectors/claude.ts`

The current mapping is wrong:
```typescript
// Current (WRONG — sdkOptions.allowedTools = auto-approve/permission, not availability):
if (this.options.allowedTools !== undefined) {
  sdkOptions.allowedTools = this.options.allowedTools;
```

The fix maps `ClaudeConnectorOptions.allowedTools` to the SDK `tools` param (availability restriction):
```typescript
// Fixed (sdkOptions.tools = explicit list of tools the model can see):
if (this.options.allowedTools !== undefined) {
  sdkOptions.tools = this.options.allowedTools;
  // Note: sdkOptions.allowedTools (auto-approve) is intentionally not set here.
  // If the caller also wants auto-approve for these tools, they can pass permissionMode separately.
  if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
} else {
  sdkOptions.tools = { type: "preset", preset: "claude_code" };
  if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
}
```

This fix aligns with how the Compose `local-claude-connector.js` workaround works (uses `tools` not `allowedTools` for availability restriction).

> **Breaking change note:** `ClaudeConnectorOptions.allowedTools` now controls availability (which tools the model is offered), not permission (auto-approve). Any internal call sites that relied on the old behavior (auto-approve without restricting visibility) must pass `permissionMode: "acceptEdits"` instead, or use the SDK `allowedTools` field via a custom `query` seam. Audit: `grep -r "allowedTools" ts/src/` shows only `runner.ts` passes this field, and it receives it from MCP callers where the availability semantics are the correct intent.

### MCP surface contract changes

**`stratum_agent_run` request — add tool filter fields:**

```json
"stratum_agent_run": {
  "request": {
    "agent": "string",
    "prompt": "string",
    "cwd": "string",
    "model?": "string",
    "sandboxMode?": "string",
    "background?": "boolean",
    "allowedTools?": "string[]",
    "disallowedTools?": "string[]"
  },
  ...
}
```

> **Finding 3 fix:** The contract specifies `string[]` (not bare `"array"`) to make the element type explicit. `optionalArray` would allow non-string elements to reach the Claude SDK silently. The server handler uses a new `optionalStringArray()` helper that validates every element is a string and throws on the first malformed element.

### `ts/src/mcp/server.ts` — read new fields in dispatcher

```typescript
// New helper (Finding 3 fix): validates every array element is a string.
// Throws a descriptive error on first non-string element so malformed input is
// rejected at the MCP boundary, not silently passed to the Claude SDK.
function optionalStringArray(req: Record<string, unknown>, key: string): string[] | undefined {
  const val = req[key];
  if (val === undefined) return undefined;
  if (!Array.isArray(val)) throw new Error(`${key} must be an array`);
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== "string") throw new Error(`${key}[${i}] must be a string, got ${typeof val[i]}`);
  }
  return val as string[];
}

case "stratum_agent_run": {
  const model = optionalString(request, "model");
  const sandboxMode = optionalString(request, "sandboxMode");
  // Finding 3 fix: use optionalStringArray instead of optionalArray to validate elements
  const allowedTools = optionalStringArray(request, "allowedTools");
  const disallowedTools = optionalStringArray(request, "disallowedTools");
  const executed = await agentRun({
    agent: string(request, "agent") as "claude" | "codex",
    prompt: string(request, "prompt"),
    cwd: string(request, "cwd"),
    ...(model ? { model } : {}),
    ...(sandboxMode ? { sandboxMode: sandboxMode as "read-only" | "workspace-write" } : {}),
    ...(typeof request.background === "boolean" ? { background: request.background } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
  });
  response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
  break;
}
```

---

## File Change Map

| File | Type | Changes |
|---|---|---|
| `ts/src/connectors/background.ts` | modify | Remove guards at :65/:68; update `BackgroundRunMeta` to discriminated union; add `claudeWorkerRegistry` with `cancelling` flag; add `startClaudeBackgroundRun()` with sandboxMode rejection, exit/error handlers; update `loadMeta()` agent check; add claude branch to `pollBackgroundRun()` and `cancelBackgroundRun()` with ownership-before-terminate; add `writeSentinelIfAbsent()` helper |
| `ts/src/connectors/claude-bg-worker.ts` | new | Worker thread entry point: receive workerData, run ClaudeConnector via query seam, write normalized JSONL, write T2F5 sentinel; stream errors written to stderr, never crash worker |
| `ts/src/connectors/claude.ts` | modify | Fix `allowedTools` → SDK `tools` mapping (availability, not auto-approve) |
| `ts/src/connectors/runner.ts` | modify | Change `runAgent` return type: `pid: number` → `pid?: number` in `bg_started` union; add `allowedTools`/`disallowedTools` to `StartBackgroundRunOptions` and forward them to `startBackgroundRun()` |
| `ts/contracts/mcp-surface.json` | modify | Add `allowedTools?: string[]`/`disallowedTools?: string[]` to `stratum_agent_run` request (typed as string arrays, not bare arrays); make `pid?` optional in `bg_started` response |
| `ts/src/mcp/server.ts` | modify | Add `optionalStringArray()` helper; read `allowedTools`/`disallowedTools` via `optionalStringArray` in `stratum_agent_run` handler |

---

## Decision Log

| # | Decision | Rationale |
|---|---|---|
| D1 | Worker Threads for Claude background runs | `ClaudeConnector` uses `@anthropic-ai/claude-agent-sdk` `query()` in-process — no CLI binary equivalent of `codexCommand` exists. Worker Threads are the Node.js isolation boundary; `worker.terminate()` is genuinely fatal (death-confirmed) without requiring a subprocess boundary or separate binary. |
| D2 | Codex-compatible JSONL format from worker | `scanStream()` already parses the Codex JSONL format. Normalizing claude events in the worker reuses the entire poll path without branching per agent type. |
| D3 | In-memory claude worker registry (not durable) | Durability would require persisting worker state across process restarts, which is complex and not needed for the GSD use case — if the MCP server restarts, the flow itself needs to be resumed anyway. Poll correctly returns `child_died_without_sentinel` on restart, which Compose handles as an error boundary. |
| D4 | Default `sandboxMode` for claude bg = `workspace-write` | The primary use case for claude background runs IS workspace mutation. Unlike Codex bg where read-only was the v1 scope, claude bg is specifically targeting write operations. `read-only` is explicitly rejected (D8) — callers cannot accidentally get a "read-only" claude bg run that is actually write-capable. |
| D5 | Fix `ClaudeConnector.allowedTools` → SDK `tools` mapping | The current mapping is a bug: `sdkOptions.allowedTools` controls auto-approve (permission), not which tools the model is offered (availability). The E3 reviewer read-only boundary failure was caused by this bug. The fix aligns with the Compose workaround's correct behavior. |
| D6 | Codex workspace-write unlock is guard-only | Only `background.ts:68` blocks this path. `sandboxMode` is already stored in `BackgroundRunMeta`, threaded to `codexCommand()`, and used in the subprocess spawn. No further architectural change needed. |
| D7 | `pid` made optional in both MCP contract AND `runAgent` TypeScript return type | Claude worker threads have a `worker.threadId` (not an OS pid). Both the MCP contract (`bg_started.pid?`) and the TS type at `runner.ts:27` must change `pid: number` → `pid?: number` — if only the contract is updated, the TS type assertion on the Codex path still assumes a mandatory pid, causing a type error when returning claude bg results. |
| D8 | Reject `sandboxMode: "read-only"` for claude bg runs in v1 | `claude.ts:43` hardcodes `permissionMode: "acceptEdits"` regardless of `sandboxMode`. There is no implemented mapping from `sandboxMode: "read-only"` to an SDK tool restriction. Silently accepting `read-only` and storing it in meta while running `acceptEdits` would be a false guarantee. Explicit rejection is chosen over partial enforcement (e.g. `disallowedTools: [Write, Edit, ...]`) because the SDK restriction surface for claude-agent-sdk is not yet settled in this codebase. Future: add `sandboxMode: "read-only"` support once the `allowedTools`/`disallowedTools` restriction semantics are validated in production. |
| D9 | `cancelling` flag gates exit-handler sentinel, `error` handler added | Two containment fixes for the worker lifecycle: (1) `entry.cancelling = true` is set before `worker.terminate()` so the exit event handler skips its rc=1 sentinel write — cancel then writes rc=130 without a race. (2) A `worker.on("error", ...)` handler absorbs uncaught worker exceptions that would otherwise propagate as unhandled Node.js exceptions and crash the MCP server process. Both write bounded sentinel records so poll always finds a terminal state. |

---

## Test Plan

### BG-WRITE-A: Background workspace-write

- [ ] Codex `workspace-write` background: start a run with `{ agent:"codex", sandboxMode:"workspace-write", background:true }`, poll to completion, verify `workspace-write` behavior (test uses `backgroundCommand` seam to inject a stub)
- [ ] Claude background start: call `stratum_agent_run` with `{ agent:"claude", background:true }`, verify `bg_started` response with valid `runId` and no `pid`, verify `meta.json` written with `agent:"claude"`
- [ ] Claude background poll — running: poll immediately after start, verify `{ status:"running" }`
- [ ] Claude background poll — complete: wait for worker exit sentinel, verify `{ status:"complete", text, usage }`
- [ ] Claude background poll — worker died without sentinel: simulate server restart (clear in-memory registry, no sentinel in file), verify `{ status:"error", reason:"child_died_without_sentinel" }`
- [ ] Claude background cancel — death-confirmed: cancel an in-flight claude bg run, verify `worker.terminate()` was called (test uses worker stub), verify `{ status:"cancelled" }`, verify sentinel was written, verify subsequent poll returns `{ status:"error" }`
- [ ] Claude background cancel — already complete: cancel after sentinel, verify `{ status:"already_complete" }`
- [ ] Claude background cancel — not in registry: cancel after simulated restart (no registry entry, no sentinel), verify `{ status:"not_found" }`
- [ ] `loadMeta` accepts `agent:"claude"` meta files
- [ ] `loadMeta` still rejects unrecognized agent values

### BG-WRITE-B: Tool allowlists

- [ ] `ClaudeConnector` with `allowedTools: ["Read"]`: verify SDK `tools` is set to `["Read"]` (not `sdkOptions.allowedTools`), via test query seam asserting `sdkOptions`
- [ ] `ClaudeConnector` with no `allowedTools`: verify SDK `tools` preset `claude_code` is used (unchanged default)
- [ ] `ClaudeConnector` with `disallowedTools: ["Write"]`: verify `sdkOptions.disallowedTools` is set
- [ ] `stratum_agent_run` over MCP with `allowedTools`/`disallowedTools`: verify fields are read from request and passed to `runAgent()`
- [ ] `stratum_agent_run` contract rejection: verify `assertToolRequest` blocks unknown extra fields in the request (no regression)
- [ ] `stratum_agent_run` with `allowedTools` passed through `background:true` path: verify `allowedTools` reaches `startClaudeBackgroundRun()` and is stored in `meta.json`
- [ ] `optionalStringArray` rejects non-string array elements: call `stratum_agent_run` with `allowedTools: ["Read", 42]`, verify the call is rejected with a descriptive error before reaching `runAgent()`
- [ ] `optionalStringArray` accepts undefined: call without `allowedTools`, verify no error

### BG-WRITE-A: sandboxMode enforcement (Finding 1)

- [ ] Claude bg run with `sandboxMode: "read-only"` throws: call `startClaudeBackgroundRun()` with `sandboxMode: "read-only"`, verify it throws with a message mentioning enforcement not implemented
- [ ] Claude bg run with `sandboxMode: "workspace-write"` succeeds (positive path)
- [ ] Claude bg run with `sandboxMode` omitted uses `workspace-write` default (positive path)

### BG-WRITE-A: cancel/exit sentinel race (Finding 2)

- [ ] Cancel does not race exit-handler sentinel: use a worker stub that emits `exit` synchronously after `terminate()`; verify exactly one sentinel record in stream.jsonl and it has rc=130, not rc=1
- [ ] Exit handler skips sentinel when `cancelling=true`: verify that after `entry.cancelling = true`, the exit callback does not call `writeSentinelIfAbsent`

### BG-WRITE-A: worker error containment (Finding 5)

- [ ] Worker `error` event is contained: inject a worker that emits `error` synchronously; verify no uncaught exception propagates, and that poll returns `{ status:"error" }` with error message in stream
- [ ] Worker `error` sets `isAlive=false`: after worker error, verify `entry.isAlive === false`

### Regression

- [ ] Codex read-only background run (existing behavior): full start/poll/cancel cycle unchanged
- [ ] `stratum_agent_run` synchronous claude (foreground) with `allowedTools`: end-to-end via test query seam
- [ ] `runAgent` return type: TypeScript compiles without error when destructuring `bg_started` result with `pid` as optional

---

## Out of Scope

- Compose-side wiring: exposing the new capabilities in `stratum_flow_run_bg` consumer-dispatch mode (this requires lifting the `consumer_dispatch_bg_unsupported` guard in `engine.ts:291-299`, which is a follow-on once the agent surface has bg kill semantics)
- Claude background event streaming (SSE/push): poll model is sufficient for the GSD use case; push streaming is a separate feature
- Durability of claude bg runs across MCP server restarts: in-memory registry is intentional; durability would require a different process model
- `budgeted` support for background runs: kept as existing guard
- Tool allowlists for Codex: Codex uses `sandboxMode` for access control, not named tool lists; this is by design
