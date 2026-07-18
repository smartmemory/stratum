# STRAT-AGENT-BG-WRITE-1 Implementation Blueprint

**Status:** BLUEPRINT  
**Feature:** Workspace-Write Background Agent Mode + Tool Allowlists  
**Created:** 2026-07-18  
**Design:** [design.md](./design.md) (r5, approved after 5 review rounds)

---

## Execution Order

Work in this order — each step has verified gate conditions before the next:

1. MCP contract (`mcp-surface.json`) — types first, no TS impact
2. `background.ts` — core implementation (biggest file)
3. New file: `claude-bg-worker.ts`
4. `runner.ts` — small plumbing changes
5. `server.ts` — read new MCP fields
6. `claude.ts` — BG-WRITE-B SDK mapping fix
7. Tests — new file + existing test updates

---

## Step 1 — MCP Contract: `ts/contracts/mcp-surface.json`

**File:** `ts/contracts/mcp-surface.json`  
**Current lines to change:** 152 and 155 (verified)

### 1a. Add tool filter fields to `stratum_agent_run` request

**Line 152 current:**
```json
"request": { "agent": "string", "prompt": "string", "cwd": "string", "model?": "string", "sandboxMode?": "string", "background?": "boolean" },
```

**Line 152 after:**
```json
"request": { "agent": "string", "prompt": "string", "cwd": "string", "model?": "string", "sandboxMode?": "string", "background?": "boolean", "allowedTools?": { "$array": "string" }, "disallowedTools?": { "$array": "string" } },
```

**Why `{"$array":"string"}`:** `contracts.ts:46` defines `LEAF_TYPES = new Set(["any", "array", "boolean", "null", "number", "object", "string"])` — `"string[]"` is not a leaf type and would be rejected. The `{"$array":"string"}` mechanism causes `matchShape` (`contracts.ts:98-101`) to validate each element as a string — no helper needed in `server.ts`.

### 1b. Make `pid` optional in `bg_started` response

**Line 155 current:**
```json
"bg_started": { "runId": "string", "pid": "number", "streamPath": "string" }
```

**Line 155 after:**
```json
"bg_started": { "runId": "string", "pid?": "number", "streamPath": "string" }
```

**Why:** Claude worker threads expose `worker.threadId`, not an OS pid. The claude background path returns no `pid`.

---

## Step 2 — `ts/src/connectors/background.ts`

This is the core of BG-WRITE-A. Changes are grouped in logical sections.

### 2a. Add imports (top of file, after existing imports)

**Current line 1-10:**
```typescript
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
...
```

Add `appendFile` to the `fs/promises` import and add a new `worker_threads` import:

```typescript
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
```

Also add `ClaudeConnectorOptions` to the claude import (used in WorkerInput typing):
```typescript
import type { ClaudeConnectorOptions } from "./claude.js";
```

### 2b. Replace `BackgroundRunMeta` with discriminated union (lines 23–35)

**Current (lines 23–35):**
```typescript
export interface BackgroundRunMeta {
  runId: string;
  agent: "codex";
  model: string;
  cwd: string;
  sandboxMode: CodexSandboxMode;
  promptChars: number;
  createdAt: string;
  childPid: number;
  procStartTime?: string;
  streamPath: string;
  stderrPath: string;
}
```

**Replace with:**
```typescript
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
}

export type BackgroundRunMeta = CodexRunMeta | ClaudeRunMeta;
```

### 2c. Add `allowedTools`/`disallowedTools` to `StartBackgroundRunOptions` (lines 37–48)

**Current (lines 37–48):**
```typescript
export interface StartBackgroundRunOptions {
  agent: AgentType;
  prompt: string;
  cwd: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  budgeted?: boolean;
  registryRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Final-agent-argv process-boundary seam used by the ported Python scenarios. */
  command?: string[];
}
```

**Add two fields:**
```typescript
export interface StartBackgroundRunOptions {
  agent: AgentType;
  prompt: string;
  cwd: string;
  model?: string;
  sandboxMode?: CodexSandboxMode;
  budgeted?: boolean;
  registryRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Final-agent-argv process-boundary seam used by the ported Python scenarios. */
  command?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

### 2d. Add module-level claude registry and helpers (insert after imports, before `export const T2F5_DONE_SENTINEL`)

Insert this block before line 12 (`export const T2F5_DONE_SENTINEL = ...`):

```typescript
// ── Claude background worker registry ────────────────────────────────────────
// Keyed by runId. Entry absent means "not running" (terminal). Deletion is the
// terminal signal (D10) — no isAlive field needed (saves unbounded memory growth).
interface ClaudeBgEntry {
  worker: Worker;
  // D9: set before worker.terminate() — suppresses exit/error-handler sentinel write.
  cancelling: boolean;
  // D13: per-run finalization lock. First synchronous caller (error fires before exit)
  // sets this promise; subsequent callers chain on the same promise with their
  // doFinalize discarded. Atomic at JS event-loop level (no await between null-check
  // and set). Registry deletion happens in .finally() after doFinalize settles.
  finalizationClaim: Promise<void> | null;
}
const claudeWorkerRegistry = new Map<string, ClaudeBgEntry>();

// Single serialization point for all terminal writes on a claude bg run.
// Only the first caller's doFinalize() executes; subsequent callers get the
// same promise. Registry deletion always happens via .finally().
function claimFinalization(
  entry: ClaudeBgEntry,
  runId: string,
  doFinalize: () => Promise<void>,
): Promise<void> {
  if (entry.finalizationClaim !== null) {
    return entry.finalizationClaim; // already claimed — another path owns the terminal record
  }
  entry.finalizationClaim = doFinalize()
    .catch(() => { /* best-effort — I/O failure must not block registry deletion */ })
    .finally(() => claudeWorkerRegistry.delete(runId));
  return entry.finalizationClaim;
}

// Writes a sentinel to the stream only if none is present yet.
// Used by exit/error handlers. Cancel path calls this via claimFinalization().
async function writeSentinelIfAbsent(streamPath: string, exitCode: number): Promise<void> {
  const scan = await scanStream(streamPath);
  if (scan.exitCode !== undefined) return; // already has a sentinel
  const line = JSON.stringify({ [T2F5_DONE_SENTINEL]: exitCode }) + "\n";
  await appendFile(streamPath, line, { encoding: "utf8" });
}
// ─────────────────────────────────────────────────────────────────────────────
```

> **Ordering note:** `writeSentinelIfAbsent` references `scanStream` and `T2F5_DONE_SENTINEL` which are defined later in the file. TypeScript hoists function declarations — but since these are `async function` declarations (not expressions), forward references work correctly. However, to be safe: place the `writeSentinelIfAbsent` after `scanStream`'s definition (around line 198 in the current file), or move the block lower. See section 2h for placement.

### 2e. Replace `startBackgroundRun` (lines 62–123)

**Current (lines 62–63, function signature):**
```typescript
export async function startBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; pid: number; streamPath: string;
}> {
```

**New signature (pid is optional):**
```typescript
export async function startBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; pid?: number; streamPath: string;
}> {
```

**Current (lines 65–68, guards):**
```typescript
  if (options.agent !== "codex") throw new Error("background agent runs are codex-only in v1");
  if (options.budgeted) throw new Error("background agent runs cannot debit run budgets yet");
  const sandboxMode = options.sandboxMode ?? "read-only";
  if (sandboxMode !== "read-only") throw new Error("workspace-write durable background runs are not supported in v1");
```

**New guards (runtime discriminant validation + dispatch):**
```typescript
  // D11: explicit runtime validation — TypeScript casts at the MCP boundary do not
  // protect callers that bypass the MCP surface.
  const VALID_AGENTS = new Set(["claude", "codex"]);
  const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write"]);
  if (!VALID_AGENTS.has(options.agent)) {
    throw new Error(`Unknown agent ${JSON.stringify(options.agent)}; must be "claude" or "codex"`);
  }
  if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
    throw new Error(
      `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only" or "workspace-write"`,
    );
  }
  if (options.budgeted) throw new Error("background agent runs cannot debit run budgets yet");

  if (options.agent === "claude") {
    return startClaudeBackgroundRun(options);
  }
```

The rest of the codex path (lines 69–123) is **unchanged except**:
- Line 67: `const sandboxMode = options.sandboxMode ?? "read-only";` — this line remains for the codex path, just moves to after the new dispatch `if` block
- Line 68: the `sandboxMode !== "read-only"` guard is **deleted** (D6: codex workspace-write is just a guard removal)

Codex path after dispatch:
```typescript
  // Codex path (D6: workspace-write is now allowed — guard at old :68 removed)
  const sandboxMode = options.sandboxMode ?? "read-only";
  const registryRoot = options.registryRoot ?? agentRunsRoot();
  // ... rest of codex path unchanged through line 123
```

### 2f. New function: `startClaudeBackgroundRun` (insert after the refactored `startBackgroundRun`)

```typescript
// WorkerInput is the data passed to claude-bg-worker via workerData.
interface WorkerInput {
  prompt: string;
  connectorOptions: ClaudeConnectorOptions;
  streamPath: string;
}

async function startClaudeBackgroundRun(options: StartBackgroundRunOptions): Promise<{
  status: "bg_started"; runId: string; streamPath: string;
}> {
  // D8: reject read-only for claude bg — claude.ts:43 hardcodes permissionMode:"acceptEdits"
  // with no SDK enforcement path for sandboxMode:"read-only". Explicit rejection prevents
  // a false read-only guarantee. Callers should omit sandboxMode or pass "workspace-write".
  if (options.sandboxMode === "read-only") {
    throw new Error(
      "claude background runs with sandboxMode='read-only' are not supported in v1. " +
      "Claude's permissionMode cannot be safely enforced via the SDK without a mapped " +
      "tool restriction list. Omit sandboxMode or pass 'workspace-write' explicitly.",
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
  // D4: default sandboxMode for claude bg = workspace-write (the primary use case)
  const sandboxMode = options.sandboxMode ?? "workspace-write";
  const workerInput: WorkerInput = {
    prompt: options.prompt,
    connectorOptions: {
      model,
      cwd: options.cwd,
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    },
    streamPath,
  };
  const worker = new Worker(new URL("./claude-bg-worker.js", import.meta.url), {
    workerData: workerInput,
  });
  const entry: ClaudeBgEntry = { worker, cancelling: false, finalizationClaim: null };
  claudeWorkerRegistry.set(runId, entry);

  // D9 + D13: exit handler — guarded by cancelling flag AND claimFinalization lock.
  // 'error' fires before 'exit' on worker exceptions, so the error handler atomically
  // claims the finalizationClaim first; the exit handler then sees it non-null and
  // discards its own doFinalize. This prevents duplicate sentinel writes.
  worker.once("exit", () => {
    if (entry.cancelling) return; // cancel path owns finalization
    void claimFinalization(entry, runId, () => writeSentinelIfAbsent(streamPath, 1));
  });

  // D9 + D13: error handler — absorbs uncaught worker exceptions. Without this listener
  // Node.js emits an unhandledRejection and crashes the MCP process. Fires before 'exit'
  // on worker exceptions so the null-check + set in claimFinalization is atomic — the
  // exit handler that follows will see finalizationClaim !== null and discard its work.
  worker.on("error", (err: Error) => {
    if (entry.cancelling) return; // cancel path owns finalization
    const errorLine = JSON.stringify({ type: "error", message: err.message.slice(0, 2000) }) + "\n";
    const sentinelLine = JSON.stringify({ [T2F5_DONE_SENTINEL]: 1 }) + "\n";
    void claimFinalization(entry, runId, () =>
      appendFile(streamPath, errorLine + sentinelLine, { encoding: "utf8" }),
    );
  });

  const meta: ClaudeRunMeta = {
    runId,
    agent: "claude",
    model,
    cwd: options.cwd,
    sandboxMode,
    promptChars: options.prompt.length,
    createdAt: new Date().toISOString(),
    streamPath,
    stderrPath,
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
  };
  await atomicWriteJson(join(runDir, "meta.json"), meta);
  return { status: "bg_started", runId, streamPath };
}
```

### 2g. Update `loadMeta` — accept `agent:"claude"` (line 187)

**Current (line 187):**
```typescript
    if (!isRecord(raw) || raw.runId !== runId || raw.agent !== "codex") return undefined;
```

**After:**
```typescript
    if (!isRecord(raw) || raw.runId !== runId || (raw.agent !== "codex" && raw.agent !== "claude")) return undefined;
```

**Line 188 also changes:** `if (typeof raw.childPid !== "number" || typeof raw.model !== "string") return undefined;` must become agent-discriminated — `childPid` is codex-only:

```typescript
    if (raw.agent === "codex" && typeof raw.childPid !== "number") return undefined;
    if (typeof raw.model !== "string") return undefined;
```

### 2h. Update `pollBackgroundRun` — add claude branch (lines 125–148)

**Current (lines 131–148):**
```typescript
  if (scan.exitCode === undefined) {
    if (await processIdentityMatches(loaded.meta.childPid, loaded.meta.procStartTime)) {
      return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
    }
    return {
      status: "error", runId, reason: "child_died_without_sentinel", textTail: text,
      stderrTail: await tailText(stderrPath), eventsSeen: scan.eventsSeen, streamPath,
    };
  }
  const telemetry = await terminalTelemetry(loaded.meta, streamPath);
  if (scan.exitCode === 0 && scan.error === undefined) {
    return { status: "complete", runId, text, usage: scan.usage, exitCode: 0, telemetry };
  }
  return {
    status: "error", runId, exitCode: scan.exitCode, textTail: text,
    stderrTail: await tailText(stderrPath), ...(scan.error ? { reason: scan.error } : {}), telemetry,
  };
```

**After — add claude branch before the `scan.exitCode === undefined` block:**
```typescript
  if (loaded.meta.agent === "claude") {
    // D10: liveness via in-memory registry (entry present = running; deleted = terminal).
    // Registry deletion always happens AFTER sentinel write so poll never misses a sentinel.
    if (scan.exitCode === undefined) {
      if (claudeWorkerRegistry.has(runId)) {
        return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
      }
      // Not in registry and no sentinel: worker died unexpectedly (MCP server restarted or
      // process was killed externally). Poll surfaces this as an error boundary.
      return {
        status: "error", runId, reason: "child_died_without_sentinel", textTail: text,
        stderrTail: await tailText(stderrPath), eventsSeen: scan.eventsSeen, streamPath,
      };
    }
    const telemetry = await terminalTelemetry(loaded.meta, streamPath);
    if (scan.exitCode === 0 && scan.error === undefined) {
      return { status: "complete", runId, text, usage: scan.usage, exitCode: 0, telemetry };
    }
    return {
      status: "error", runId, exitCode: scan.exitCode, textTail: text,
      stderrTail: await tailText(stderrPath), ...(scan.error ? { reason: scan.error } : {}), telemetry,
    };
  }

  // Codex path — unchanged:
  if (scan.exitCode === undefined) {
    if (await processIdentityMatches(loaded.meta.childPid, loaded.meta.procStartTime)) {
      return { status: "running", runId, textTail: text, eventsSeen: scan.eventsSeen, streamPath };
    }
    ...
  }
```

**Note:** `terminalTelemetry(loaded.meta, streamPath)` currently expects `BackgroundRunMeta` typed as codex. After the discriminated union change, `loaded.meta` is `BackgroundRunMeta`. Check that `terminalTelemetry` signature accepts this — it only uses `meta.createdAt` and `meta.model`, both present in `BackgroundRunMetaBase`. The function at line 292 accepts `BackgroundRunMeta` which now covers both variants — no change needed.

### 2i. Update `cancelBackgroundRun` — add claude branch (lines 150–162)

**Current (lines 150–162):**
```typescript
export async function cancelBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<Record<string, unknown>> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };
  const scan = await scanStream(loaded.streamPath);
  if (scan.exitCode !== undefined) return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
  const { childPid: pid, procStartTime: expected } = loaded.meta;
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  if (await processGroupId(pid) !== pid) return { status: "already_error", runId };
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  try { process.kill(-pid, "SIGTERM"); } catch { return { status: "already_error", runId }; }
  return { status: "cancelled", runId };
}
```

**After — add claude branch after the `not_found` guard:**
```typescript
export async function cancelBackgroundRun(runId: string, options: RegistryOptions = {}): Promise<Record<string, unknown>> {
  const loaded = await loadMeta(runId, options.registryRoot ?? agentRunsRoot());
  if (!loaded) return { status: "not_found", runId };

  if (loaded.meta.agent === "claude") {
    // Initial scan: if sentinel already present, run already terminal.
    const scan = await scanStream(loaded.streamPath);
    if (scan.exitCode !== undefined) {
      return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
    }
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return { status: "not_found", runId }; // server restart — no worker to kill

    // D9: claim before terminate so the exit handler's sentinel write is suppressed.
    entry.cancelling = true;
    // Death-confirmed: worker.terminate() returns a Promise that resolves when the thread
    // is truly dead — equivalent to SIGTERM + await for a process.
    await entry.worker.terminate();

    // D11: rescan after terminate. The worker can commit its own rc=0 sentinel BETWEEN
    // the initial scan above and the terminate() call (race: scan→worker writes→cancel
    // terminates). Setting cancelling=true suppresses the exit handler, but does not
    // undo a sentinel the worker already appended. Rescanning after death-confirmed
    // terminate is the authoritative check.
    const rescan = await scanStream(loaded.streamPath);
    if (rescan.exitCode !== undefined) {
      // Worker won the race. D13: route through claimFinalization() with a no-op doFinalize
      // so registry deletion happens via the shared lock, guarding a concurrent second cancel.
      void claimFinalization(entry, runId, () => Promise.resolve());
      return { status: rescan.exitCode === 0 && !rescan.error ? "already_complete" : "already_error", runId };
    }

    // D14: before claiming rc=130 finalization, check whether an error/exit handler already
    // claimed it before cancelling=true was set. Interleaving: worker throws → 'error' handler
    // fires with cancelling=false → claims finalizationClaim (appendFile in-flight) → cancel
    // starts → initial scan sees no sentinel (appendFile pending) → sets cancelling=true →
    // terminate (worker dead) → rescan (still no sentinel) → reaches here.
    // finalizationClaim is now non-null (error handler set it). Calling claimFinalization(rc=130)
    // would return the error handler's promise with OUR doFinalize discarded — we'd return
    // 'cancelled' while the committed sentinel is rc=1. Fix: if joined, await, rescan, return
    // the actual outcome. Return 'cancelled' ONLY when we own the rc=130 record.
    if (entry.finalizationClaim !== null) {
      // Joined a pre-existing claim — await its I/O, then report the actual terminal outcome.
      await entry.finalizationClaim;
      const finalScan = await scanStream(loaded.streamPath);
      if (finalScan.exitCode === 0 && !finalScan.error) {
        return { status: "already_complete", runId };
      }
      return { status: "already_error", runId };
    }
    // We own the terminal record. D13: claimFinalization() prevents a concurrent second cancel
    // from writing a second rc=130 sentinel (null-check + set is atomic at JS event-loop level).
    // D10: sentinel written inside doFinalize before .finally() deletes the registry entry.
    await claimFinalization(entry, runId, () => writeSentinelIfAbsent(loaded.streamPath, 130));
    return { status: "cancelled", runId };
  }

  // Codex path — unchanged:
  const scan = await scanStream(loaded.streamPath);
  if (scan.exitCode !== undefined) return { status: scan.exitCode === 0 && !scan.error ? "already_complete" : "already_error", runId };
  const { childPid: pid, procStartTime: expected } = loaded.meta;
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  if (await processGroupId(pid) !== pid) return { status: "already_error", runId };
  if (!await processIdentityMatches(pid, expected)) return { status: "already_error", runId };
  try { process.kill(-pid, "SIGTERM"); } catch { return { status: "already_error", runId }; }
  return { status: "cancelled", runId };
}
```

### 2j. Placement: `writeSentinelIfAbsent`

Place `writeSentinelIfAbsent` immediately after `scanStream` (current line 198 through 224). It references `scanStream`, `T2F5_DONE_SENTINEL`, and `appendFile`. The order in the file should be:

1. `scanStream` (current ~line 198)
2. `writeSentinelIfAbsent` (new, right after `scanStream`)
3. `completeJsonLines` (current ~line 226)
4. ... rest of file unchanged

---

## Step 3 — New File: `ts/src/connectors/claude-bg-worker.ts`

This is the Worker thread entry point. It runs in a separate thread, executes `ClaudeConnector`, normalizes events to the T2F5 JSONL format that `scanStream` parses.

```typescript
// ts/src/connectors/claude-bg-worker.ts
// Worker thread entry point for claude background runs.
// Receives workerData from background.ts, runs ClaudeConnector, writes normalized
// JSONL to the shared stream file in the same format as the Codex shell wrapper.
// This lets scanStream() parse both without branching per agent type (D2).
import { createWriteStream } from "node:fs";
import { workerData } from "node:worker_threads";
import type { ClaudeConnectorOptions } from "./claude.js";
import { ClaudeConnector } from "./claude.js";
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
  let inputTokens = 0;
  let outputTokens = 0;

  // Inject a query seam that intercepts SDK events and writes normalized JSONL
  // before yielding them to the connector's accumulator.
  const connector = new ClaudeConnector({
    ...connectorOptions,
    query: async function* ({ prompt: p, options }) {
      const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
      for await (const raw of sdkQuery({ prompt: p, options } as Parameters<typeof sdkQuery>[0])) {
        const r = raw as Record<string, unknown>;
        // Normalize assistant text blocks → item.completed records (D2)
        if (r.type === "assistant" && isRecord(r.message) && Array.isArray((r.message as Record<string, unknown>).content)) {
          for (const block of (r.message as Record<string, unknown>).content as unknown[]) {
            if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
              await writeLine({ type: "item.completed", item: { type: "agent_message", text: block.text } });
            }
          }
        }
        // Normalize result → turn.completed
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

run()
  .then(() => writeLine({ [T2F5_DONE_SENTINEL]: 0 }))
  .catch(async (err: unknown) => {
    // Write an error record then the sentinel. Both writes are best-effort:
    // if the stream is broken, the parent exit handler fires and writes the sentinel.
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    await writeLine({ type: "error", message: msg }).catch(() => { /* stream broken */ });
    await writeLine({ [T2F5_DONE_SENTINEL]: 1 }).catch(() => { /* stream broken */ });
  })
  .finally(() => { stream.end(); });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
```

**Import note:** `T2F5_DONE_SENTINEL` is exported from `background.ts` (line 12). The worker imports it directly to stay in sync. If a circular-import warning fires (worker imports background; background imports nothing from worker — no cycle), it is a false positive.

---

## Step 4 — `ts/src/connectors/runner.ts`

### 4a. Make `pid` optional in `runAgent` return type (line 30)

**Current (line 30):**
```typescript
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid: number; streamPath: string }> {
```

**After:**
```typescript
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string }> {
```

### 4b. Forward `allowedTools`/`disallowedTools` through the background path (lines 33–43)

**Current (lines 33–43):**
```typescript
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
    });
```

**After (add two spreads at the end):**
```typescript
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
      // NEW: carry tool filters through to background runs (D5 / BG-WRITE-A)
      ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
    });
```

**Note:** `AgentRunOptions` (lines 6–18) already declares `allowedTools?: string[]` and `disallowedTools?: string[]` — no type change needed there.

---

## Step 5 — `ts/src/mcp/server.ts`

### 5a. Read `allowedTools`/`disallowedTools` in `stratum_agent_run` handler (lines 111–121)

**Current (lines 111–121):**
```typescript
        case "stratum_agent_run": {
          const model = optionalString(request, "model");
          const sandboxMode = optionalString(request, "sandboxMode");
          const executed = await agentRun({
            agent: string(request, "agent") as "claude" | "codex", prompt: string(request, "prompt"), cwd: string(request, "cwd"),
            ...(model ? { model } : {}),
            ...(sandboxMode ? { sandboxMode: sandboxMode as "read-only" | "workspace-write" } : {}),
            ...(typeof request.background === "boolean" ? { background: request.background } : {}),
          });
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
          break;
        }
```

**After:**
```typescript
        case "stratum_agent_run": {
          const model = optionalString(request, "model");
          const sandboxMode = optionalString(request, "sandboxMode");
          // assertToolRequest (line 72) has already validated allowedTools/disallowedTools
          // element types via {"$array":"string"} in the contract — optionalArray() is safe.
          // Check Array.isArray() first to distinguish "not provided" from "provided as []".
          const allowedTools = Array.isArray(request.allowedTools)
            ? optionalArray(request, "allowedTools")
            : undefined;
          const disallowedTools = Array.isArray(request.disallowedTools)
            ? optionalArray(request, "disallowedTools")
            : undefined;
          const executed = await agentRun({
            agent: string(request, "agent") as "claude" | "codex",
            prompt: string(request, "prompt"),
            cwd: string(request, "cwd"),
            ...(model ? { model } : {}),
            ...(sandboxMode ? { sandboxMode: sandboxMode as "read-only" | "workspace-write" } : {}),
            ...(typeof request.background === "boolean" ? { background: request.background } : {}),
            ...(allowedTools !== undefined ? { allowedTools } : {}),
            ...(disallowedTools !== undefined ? { disallowedTools } : {}),
          });
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
          break;
        }
```

**Why `Array.isArray()` guard:** `optionalArray` (line 238) returns `[]` (empty array) when the key is absent — an empty array is truthy, so `if (allowedTools)` would always spread an `allowedTools: []`, incorrectly restricting tools. The `Array.isArray(request.allowedTools)` guard makes "not provided" map to `undefined` cleanly without a new helper.

---

## Step 6 — `ts/src/connectors/claude.ts`: BG-WRITE-B Allowlist Fix

### 6a. Fix `allowedTools` → SDK `tools` mapping (lines 46–48)

**Current (lines 46–48):**
```typescript
    if (this.options.allowedTools !== undefined) {
      sdkOptions.allowedTools = this.options.allowedTools;
      if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
```

**After (D5: map to SDK `tools` — availability restriction, not auto-approve):**
```typescript
    if (this.options.allowedTools !== undefined) {
      // D5: ClaudeConnectorOptions.allowedTools controls AVAILABILITY (which tools the model
      // is offered), not permission auto-approve. sdkOptions.allowedTools would set
      // auto-approve only — a different SDK field. Map to sdkOptions.tools instead.
      sdkOptions.tools = this.options.allowedTools;
      if (this.options.disallowedTools !== undefined) sdkOptions.disallowedTools = this.options.disallowedTools;
```

Lines 49–52 (the `else` branch setting preset) are **unchanged**.

**Breaking change for test:** `ts/tests/connectors/claude.test.ts:29` currently asserts:
```typescript
expect.objectContaining({
  cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", allowedTools: ["Read"],
}),
```
After the fix, the SDK options object will have `tools: ["Read"]` instead of `allowedTools: ["Read"]`. This test must be updated:
```typescript
expect.objectContaining({
  cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", tools: ["Read"],
}),
```

---

## Step 7 — Tests

### 7a. Update existing test that asserts old guard: `ts/tests/connectors/background.test.ts:101`

**Current (line 101):**
```typescript
    await expect(startBackgroundRun({ agent: "claude", prompt: "p", cwd: registryRoot, registryRoot })).rejects.toThrow("codex-only");
```

This test must change — `agent:"claude"` no longer throws "codex-only". The test should now cover:
1. Unknown agent still throws (the new discriminant validation)
2. Claude bg with `sandboxMode:"read-only"` throws (D8)
3. Codex workspace-write no longer throws (D6)

Replace that assertion with:
```typescript
    // Unknown agent rejected (D11 discriminant validation)
    await expect(startBackgroundRun({ agent: "gemini" as "claude", prompt: "p", cwd: registryRoot, registryRoot }))
      .rejects.toThrow("Unknown agent");
    // Claude bg with sandboxMode:read-only rejected (D8)
    await expect(startBackgroundRun({ agent: "claude", prompt: "p", cwd: registryRoot, registryRoot, sandboxMode: "read-only" }))
      .rejects.toThrow("sandboxMode='read-only' are not supported");
    // budgeted still rejected
    await expect(startBackgroundRun({ agent: "codex", prompt: "p", cwd: registryRoot, registryRoot, budgeted: true })).rejects.toThrow("cannot debit run budgets");
```

**Also update line 84:**
```typescript
    expect(meta.childPid).toBe(started.pid);
```
`started.pid` is now optional — TypeScript will complain. The codex golden flow still returns `pid` (defined in the codex path at line 104: `const pid = child.pid`). Update the assertion:
```typescript
    expect(typeof started.pid).toBe("number");
    expect(meta.childPid).toBe(started.pid);
```

### 7b. Update claude.ts test: `ts/tests/connectors/claude.test.ts:29`

As noted in Step 6a — change `allowedTools: ["Read"]` to `tools: ["Read"]`.

### 7c. New test file: `ts/tests/connectors/background-claude.test.ts`

Create this file to cover all BG-WRITE-A claude-specific test cases from the design's test plan. Key test scenarios (use Worker stub via `workerData` overrides and `registryRoot` seam):

**Setup pattern:** Claude bg tests cannot use a real Worker (requires built files). Use a `command` seam equivalent — the design calls for testing via worker stubs. Since Worker Threads are not as seam-friendly as subprocess command, the preferred approach is:

1. **Unit tests for registry/finalization logic:** Test `claimFinalization`, `writeSentinelIfAbsent`, and cancel/poll flows by writing sentinel files directly and checking registry state. Export `claudeWorkerRegistry` for test introspection (or test via the poll/cancel public API).
2. **Integration tests with a real worker:** `startBackgroundRun({ agent: "claude", ... })` with a real worker that uses the query seam to return a fake response quickly. These require the `claude-bg-worker.ts` file to be compiled first (vitest handles this via the TS config).

**Critical test cases to cover:**

```typescript
// 1. Claude bg start — meta.json has agent:"claude", no pid in response
it("claude background start writes meta.json with agent:claude and no pid", async () => {
  // Use query seam: worker runs ClaudeConnector with a mock query
  // Requires a way to inject query into workerData — see connector options
  const registryRoot = await root();
  const started = await startBackgroundRun({
    agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    // TODO: inject mock query via workerData.connectorOptions.query seam
  });
  expect(started.status).toBe("bg_started");
  expect(started.runId).toMatch(/^[0-9a-f]{12}$/);
  expect(started).not.toHaveProperty("pid");
  const meta = JSON.parse(await readFile(join(registryRoot, started.runId, "meta.json"), "utf8"));
  expect(meta.agent).toBe("claude");
});

// 2. loadMeta accepts agent:"claude"
it("loadMeta accepts agent:claude meta files", async () => {
  // Write a fake ClaudeRunMeta, poll, verify not_found is NOT returned
});

// 3. loadMeta still rejects unknown agents
it("loadMeta rejects unknown agent values in meta.json", async () => {
  // Write a meta.json with agent:"gemini", poll, verify not_found
});

// 4. sandboxMode:"read-only" rejected for claude bg (D8)
it("rejects sandboxMode:read-only for claude background runs", async () => {
  await expect(startBackgroundRun({ agent: "claude", sandboxMode: "read-only", ... }))
    .rejects.toThrow("sandboxMode='read-only' are not supported");
});

// 5. Discriminant validation (D11)
it("rejects unknown agent and sandboxMode values at startBackgroundRun entry", ...);
```

**Note on Worker seam:** The `ClaudeConnectorOptions.query` seam passes through to the worker via `workerData.connectorOptions.query`. However, functions cannot be serialized across Worker thread boundaries via `workerData` (structured clone algorithm rejects functions). The blueprint recommends one of:
- Test real Worker integration with a live (but cheap/mocked at the API layer) ClaudeConnector
- Or export an environment-variable-based test hook in `claude-bg-worker.ts` that substitutes a stub query when `process.env.STRATUM_TEST_WORKER=1` is set

The design's test plan acknowledges "test uses worker stub" — the implementer should decide the seam mechanism. Document the decision in the file.

---

## File Change Summary

| File | Type | Key changes |
|---|---|---|
| `ts/contracts/mcp-surface.json` | modify | Line 152: add `allowedTools?`/`disallowedTools?` with `{"$array":"string"}`; line 155: make `pid?` optional |
| `ts/src/connectors/background.ts` | modify | Add `appendFile`/`Worker` imports; `BackgroundRunMeta` → discriminated union; `StartBackgroundRunOptions` + `allowedTools`/`disallowedTools`; `startBackgroundRun` signature `pid?`; remove guards at :65/:68; add discriminant validation + claude dispatch; new `startClaudeBackgroundRun()`; `claudeWorkerRegistry`; `claimFinalization()`; `writeSentinelIfAbsent()`; update `loadMeta()` agent check :187; add claude branch to `pollBackgroundRun()` :131; add claude branch to `cancelBackgroundRun()` :150 |
| `ts/src/connectors/claude-bg-worker.ts` | **new** | Worker thread entry; query seam intercepts events; normalizes to T2F5 JSONL; sentinel on completion/error |
| `ts/src/connectors/runner.ts` | modify | Line 30: `pid?: number`; lines 33–43: add `allowedTools`/`disallowedTools` forwarding to `startBackgroundRun` |
| `ts/src/mcp/server.ts` | modify | Lines 111–121: read `allowedTools`/`disallowedTools` with `Array.isArray()` guard + `optionalArray()`; pass to `agentRun` |
| `ts/src/connectors/claude.ts` | modify | Line 47: `sdkOptions.allowedTools` → `sdkOptions.tools` (availability not auto-approve) |
| `ts/tests/connectors/background.test.ts` | modify | Line 84: `started.pid` optional type; line 101: replace "codex-only" guard test with discriminant validation + D8 tests |
| `ts/tests/connectors/claude.test.ts` | modify | Line 29: `allowedTools:["Read"]` → `tools:["Read"]` in expected options |
| `ts/tests/connectors/background-claude.test.ts` | **new** | Claude bg start/poll/cancel test suite |

---

## Verification Checklist

After implementation, run before committing:

```bash
cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/vitest run                          # full suite
./node_modules/.bin/vitest run tests/connectors/        # connector-focused
./node_modules/.bin/vitest run tests/mcp/               # contract validation
```

Gate conditions:
- [ ] `vitest run` passes with no new failures
- [ ] `tests/connectors/background.test.ts` still passes (regression: codex golden flow)
- [ ] `tests/connectors/claude.test.ts` passes with updated `tools` assertion
- [ ] `tests/connectors/background-claude.test.ts` all new cases pass
- [ ] `tests/mcp/contracts-grammar.test.ts` passes (validates mcp-surface.json shape grammar)
- [ ] TypeScript compiles with no errors on the modified files (vitest uses esbuild but `tsc --noEmit` catches type errors)
- [ ] `started.pid` is `undefined` for claude bg runs (no type error in tests)
- [ ] Existing codex background test at line 84 passes (codex still returns `pid`)

---

## Key Invariants to Preserve

1. **No double sentinel** (D13): exactly one `__t2f5_done__` line in `stream.jsonl` per run
2. **Registry deletion after sentinel** (D10): poll never sees "entry gone + no sentinel" window
3. **cancel/poll agreement** (D11, D14): the status cancel returns matches what a subsequent poll returns
4. **Worker error containment** (D9): `worker.on("error", ...)` listener present — no unhandled Node.js exception
5. **`scanStream` takes the last sentinel** — double-writes are wrong even if the last happens to be correct; the invariant is one write
6. **`optionalArray` returns `[]` not `undefined`** (server.ts:238) — always guard with `Array.isArray(request.X)` before using as optional pass-through
