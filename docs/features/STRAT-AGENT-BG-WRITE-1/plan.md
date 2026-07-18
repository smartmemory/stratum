# STRAT-AGENT-BG-WRITE-1 Implementation Plan

**Status:** PLAN  
**Feature:** Workspace-Write Background Agent Mode + Tool Allowlists  
**Created:** 2026-07-18  
**Design:** [design.md](./design.md) (r5, approved after 5 review rounds)  
**Blueprint:** [blueprint.md](./blueprint.md) (all 25 file:line refs verified)

---

## Overview

Two independent sub-features, unified in one implementation pass:

- **BG-WRITE-A** — Enable claude background runs (Worker Threads) and unlock codex `workspace-write` background runs (guard removal). Adds discriminated `BackgroundRunMeta` union, in-memory `claudeWorkerRegistry`, `claimFinalization()` serialization lock, and a new `claude-bg-worker.ts` Worker thread entry point.
- **BG-WRITE-B** — Fix `ClaudeConnector.allowedTools` to map to the SDK `tools` param (availability restriction) instead of `sdkOptions.allowedTools` (auto-approve). Expose `allowedTools`/`disallowedTools` over the MCP wire via the `stratum_agent_run` contract.

**Execution order:** MCP contract → background.ts → claude-bg-worker.ts → runner.ts → server.ts → claude.ts → tests (unit + MCP surface). Each step is independently compilable; dependencies flow one way.

---

## Tasks

### Task 1 — MCP Contract (`ts/contracts/mcp-surface.json`)

**Depends on:** nothing  
**File:** `ts/contracts/mcp-surface.json`

Add tool-filter fields to the `stratum_agent_run` request schema and make `pid` optional in the `bg_started` response.

**Changes:**

- **Line 152** — Add `allowedTools?` and `disallowedTools?` to `stratum_agent_run.request`:
  ```json
  "request": { "agent": "string", "prompt": "string", "cwd": "string", "model?": "string", "sandboxMode?": "string", "background?": "boolean", "allowedTools?": { "$array": "string" }, "disallowedTools?": { "$array": "string" } },
  ```
  Use `{"$array": "string"}` — not `"string[]"`. `contracts.ts:46` LEAF_TYPES does not include `"string[]"`; the `{"$array":"string"}` shape causes `matchShape` (`contracts.ts:98-101`) to validate each element, providing free MCP-boundary validation without a custom helper.

- **Line 155** — Make `pid` optional in `bg_started`:
  ```json
  "bg_started": { "runId": "string", "pid?": "number", "streamPath": "string" }
  ```
  Claude Worker Threads expose `worker.threadId`, not an OS pid.

**Acceptance criteria:**
- [ ] `assertToolRequest` accepts `stratum_agent_run` calls with `allowedTools: ["Read", "Write"]`
- [ ] `assertToolRequest` accepts calls without `allowedTools` (field is optional)
- [ ] `assertToolRequest` rejects `allowedTools: ["Read", 42]` (element type validation)
- [ ] `bg_started` response validates without `pid` present
- [ ] `tests/mcp/contracts-grammar.test.ts` passes

---

### Task 2 — Core Background Implementation (`ts/src/connectors/background.ts`)

**Depends on:** Task 1 (contract defines the wire shape that this file implements)  
**File:** `ts/src/connectors/background.ts`

This is the largest change. Sub-tasks must be applied in order within the file.

#### Task 2a — New imports

Add `appendFile` to the `fs/promises` import (currently missing) and add `Worker` from `worker_threads`. Add a type-only import for `ClaudeConnectorOptions` (used in `WorkerInput`):

```typescript
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { ClaudeConnectorOptions } from "./claude.js";
```

**Acceptance criteria:**
- [ ] `appendFile` available for use in `writeSentinelIfAbsent` and error handler
- [ ] `Worker` available for use in `startClaudeBackgroundRun`

#### Task 2b — Replace `BackgroundRunMeta` with discriminated union (current lines 23–35)

Replace the existing `export interface BackgroundRunMeta` with:

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

**Acceptance criteria:**
- [ ] TypeScript compiler (`tsc --noEmit`) accepts the union with no errors
- [ ] `CodexRunMeta` still has `childPid: number` and `procStartTime?: string`
- [ ] `ClaudeRunMeta` has no `childPid` or `procStartTime` fields
- [ ] Downstream uses of `loaded.meta.childPid` in `cancelBackgroundRun` and `pollBackgroundRun` (codex branch) still type-check (discriminant narrows the union)

#### Task 2c — Add `allowedTools`/`disallowedTools` to `StartBackgroundRunOptions` (current lines 37–48)

Add two optional fields to the end of the interface:

```typescript
allowedTools?: string[];
disallowedTools?: string[];
```

**Acceptance criteria:**
- [ ] `startBackgroundRun({ agent:"claude", allowedTools:["Read"], ... })` compiles
- [ ] Fields are `string[]`, not `{"$array":"string"}` (internal types use plain arrays)

#### Task 2d — Add module-level claude registry and helpers

Insert immediately before `export const T2F5_DONE_SENTINEL` (current line 12):

1. `ClaudeBgEntry` interface with fields: `worker: Worker`, `cancelling: boolean`, `finalizationClaim: Promise<void> | null`
2. `const claudeWorkerRegistry = new Map<string, ClaudeBgEntry>()`
3. `function claimFinalization(entry, runId, doFinalize): Promise<void>` — null-check + set is synchronous (JS event-loop atomic); `.finally()` deletes registry entry
4. `async function writeSentinelIfAbsent(streamPath, exitCode): Promise<void>` — place this **after** `scanStream`'s definition (around current line 198) to avoid forward-reference issues with `async function` expressions

**Acceptance criteria:**
- [ ] `claimFinalization()`: first caller's `doFinalize()` executes; subsequent callers get the same promise with their `doFinalize` discarded
- [ ] `claimFinalization()`: `.finally(() => claudeWorkerRegistry.delete(runId))` always runs exactly once
- [ ] `writeSentinelIfAbsent()`: no-ops when stream already has a sentinel; appends sentinel line otherwise

#### Task 2e — Update `startBackgroundRun` signature and guards (current lines 62–68)

- Return type: `pid?: number` (was `pid: number`)
- Replace the old guards (`agent !== "codex"`, `sandboxMode !== "read-only"`) with:
  1. Discriminant validation: `VALID_AGENTS = Set(["claude","codex"])` and `VALID_SANDBOX_MODES = Set(["read-only","workspace-write"])` — throw on unknown values
  2. `if (options.budgeted) throw ...` (unchanged)
  3. `if (options.agent === "claude") return startClaudeBackgroundRun(options)`
- Codex path continues after dispatch; remove the `sandboxMode !== "read-only"` guard (D6)

**Acceptance criteria:**
- [ ] `startBackgroundRun({ agent:"gemini", ... })` throws `"Unknown agent"`
- [ ] `startBackgroundRun({ agent:"codex", sandboxMode:"locked", ... })` throws `"Unknown sandboxMode"`
- [ ] `startBackgroundRun({ agent:"codex", sandboxMode:"workspace-write", ... })` succeeds (guard removed)
- [ ] `startBackgroundRun({ agent:"claude", ... })` dispatches to `startClaudeBackgroundRun`

#### Task 2f — New function `startClaudeBackgroundRun`

Insert immediately after the refactored `startBackgroundRun` (and after the `WorkerInput` interface):

Key behaviors:
- D8: throw if `options.sandboxMode === "read-only"` (enforcement not implemented in v1)
- D4: default `sandboxMode = "workspace-write"` when omitted
- Create run dir and three files (`stream.jsonl`, `.err`, `.in`) at mode `0o600`
- Build `workerInput: WorkerInput` (model, cwd, allowedTools, disallowedTools, env, streamPath, **stderrPath**). `WorkerInput` interface must include `stderrPath: string` so the worker can write caught errors there (design.md:648 — "stream errors written to stderr, never crash worker").
- Spawn `new Worker(new URL("./claude-bg-worker.js", import.meta.url), { workerData: workerInput })`
- Register entry: `{ worker, cancelling: false, finalizationClaim: null }`
- Wire `worker.once("exit", ...)` — D9 + D13: skip if `entry.cancelling`, else `claimFinalization(entry, runId, () => writeSentinelIfAbsent(streamPath, 1))`
- Wire `worker.on("error", ...)` — D9 + D13: skip if `entry.cancelling`, else `claimFinalization(entry, runId, () => appendFile(streamPath, errorLine + sentinelLine))`
- Write `ClaudeRunMeta` to `meta.json` via `atomicWriteJson`
- Return `{ status: "bg_started", runId, streamPath }` — **no `pid`**

**Acceptance criteria:**
- [ ] `startClaudeBackgroundRun({ sandboxMode:"read-only", ... })` throws with message containing `"sandboxMode='read-only' are not supported"`
- [ ] Returned object has no `pid` property
- [ ] `meta.json` written with `agent:"claude"` and `sandboxMode:"workspace-write"` (default)
- [ ] `claudeWorkerRegistry.has(runId)` is `true` immediately after start
- [ ] `stream.jsonl` file exists with mode 0o600
- [ ] `workerInput.stderrPath` equals the `.err` path alongside `stream.jsonl` (i.e. `streamPath + ".err"`)

#### Task 2g — Update `loadMeta` agent check (current line 187)

Current: `raw.agent !== "codex"` — returns `undefined` for claude meta  
After: `(raw.agent !== "codex" && raw.agent !== "claude")` — accepts both

Also update the `childPid` validation at line 188 to be codex-discriminated:

```typescript
if (raw.agent === "codex" && typeof raw.childPid !== "number") return undefined;
if (typeof raw.model !== "string") return undefined;
```

**Acceptance criteria:**
- [ ] `loadMeta` returns a valid object when `meta.json` has `agent:"claude"` (no `childPid`)
- [ ] `loadMeta` still returns `undefined` for `agent:"gemini"` or missing `model`
- [ ] `loadMeta` still returns valid object for `agent:"codex"` with `childPid`

#### Task 2h — Add claude branch to `pollBackgroundRun` (current lines 131–148)

Insert a claude branch **before** the existing `scan.exitCode === undefined` block (codex path):

```typescript
if (loaded.meta.agent === "claude") {
  if (scan.exitCode === undefined) {
    if (claudeWorkerRegistry.has(runId)) {
      return { status: "running", ... };
    }
    return { status: "error", reason: "child_died_without_sentinel", ... };
  }
  const telemetry = await terminalTelemetry(loaded.meta, streamPath);
  if (scan.exitCode === 0 && scan.error === undefined) {
    return { status: "complete", ... };
  }
  return { status: "error", ... };
}
// codex path unchanged below
```

**Acceptance criteria:**
- [ ] `pollBackgroundRun` returns `"running"` when registry has the entry and no sentinel
- [ ] `pollBackgroundRun` returns `"error"` with `reason:"child_died_without_sentinel"` when entry absent and no sentinel (MCP server restart case)
- [ ] `pollBackgroundRun` returns `"complete"` when sentinel has `exitCode:0` and no error record
- [ ] `pollBackgroundRun` returns `"error"` when sentinel has `exitCode:1`
- [ ] Codex poll path is unchanged

#### Task 2i — Add claude branch to `cancelBackgroundRun` (current lines 150–162)

Insert claude branch after the `not_found` guard. Full logic per D9/D11/D13/D14:

1. Initial scan — if sentinel present, return `already_complete`/`already_error`
2. Get registry entry — if absent, return `not_found` (server restart case)
3. Set `entry.cancelling = true` before terminate
4. `await entry.worker.terminate()` (death-confirmed)
5. Rescan after terminate — if worker won the race and wrote its own sentinel, route through `claimFinalization(entry, runId, () => Promise.resolve())` (no-op doFinalize for registry cleanup) and return `already_complete`/`already_error`
6. D14 check: if `entry.finalizationClaim !== null` (error handler claimed before `cancelling=true` was set), await the existing claim, rescan, return actual outcome — NOT `"cancelled"`
7. Own the terminal record: `await claimFinalization(entry, runId, () => writeSentinelIfAbsent(loaded.streamPath, 130))`; return `{ status: "cancelled" }`

**Acceptance criteria:**
- [ ] Cancel on running worker: returns `"cancelled"`, sentinel in stream has `exitCode:130`, subsequent poll returns `"error"`, registry entry gone
- [ ] Cancel after worker wrote rc=0 sentinel first: returns `"already_complete"`, registry entry cleaned up
- [ ] Cancel joins pre-existing error finalizationClaim: returns `"already_error"` (not `"cancelled"`), sentinel is rc=1
- [ ] Two concurrent cancel calls: exactly one rc=130 sentinel written; both calls resolve without error
- [ ] Cancel after sentinel already present (initial scan): returns `"already_complete"` or `"already_error"` immediately, no terminate called

---

### Task 3 — New Worker File (`ts/src/connectors/claude-bg-worker.ts`)

**Depends on:** Task 2 (imports `T2F5_DONE_SENTINEL` from `background.ts`, imports `ClaudeConnector` from `claude.ts`)  
**File:** `ts/src/connectors/claude-bg-worker.ts` (new)

Worker Thread entry point. Receives `workerData`, runs `ClaudeConnector` with a query seam that normalizes SDK events to T2F5 JSONL format.

```typescript
import { appendFileSync, createWriteStream } from "node:fs";
import { workerData } from "node:worker_threads";
import type { ClaudeConnectorOptions } from "./claude.js";
import { ClaudeConnector } from "./claude.js";
import { T2F5_DONE_SENTINEL } from "./background.js";
```

Key behaviors:
- `writeLine(record)`: wraps `stream.write()` in a Promise
- `run()`: creates `ClaudeConnector` with a `query` option that wraps the real SDK `sdkQuery`; intercepts events to write:
  - Assistant text blocks → `{ type:"item.completed", item:{ type:"agent_message", text } }`
  - Result events → `{ type:"turn.completed", usage:{ input_tokens, output_tokens } }` (cumulative)
  - Yields original events to the connector's accumulator
- `run().then(() => writeLine({ [T2F5_DONE_SENTINEL]: 0 }))` — success sentinel
- `.catch(async (err) => { await writeLine({type:"error", message:msg}); await writeLine({[T2F5_DONE_SENTINEL]: 1}) })` — both best-effort; **also write err.message to `workerData.stderrPath`** using `appendFileSync` (synchronous avoids timing issues in the catch block)
- `.finally(() => stream.end())`
- `isRecord(v)` guard function at bottom

**Stderr plumbing (design.md:648 — "stream errors written to stderr, never crash worker"):**  
The worker receives `stderrPath` in `workerData`. On error in the catch block, after writing the error JSONL record to `stream.jsonl`, write the error message to `stderrPath`:
```typescript
.catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message.slice(0, 2000) : String(err);
  // Write error to stderr path (best-effort; never throw from catch)
  try { appendFileSync(workerData.stderrPath, `${msg}\n`, "utf8"); } catch {}
  await writeLine({ type: "error", message: msg });
  await writeLine({ [T2F5_DONE_SENTINEL]: 1 });
})
```
The `try/catch` wrapper around `appendFileSync` ensures a filesystem failure writing the `.err` file never causes the sentinel write to be skipped.

**Note on Worker seam for tests:** Functions cannot be passed via `workerData` (structured-clone rejects them). The implementer should choose one of:
- A `STRATUM_TEST_WORKER=1` env var that enables a stub query in the worker (avoids real SDK calls in tests)
- Integration tests that rely on a real (but cheap/mocked-at-API-layer) ClaudeConnector

Document the chosen approach in the file. For initial implementation, the env-var stub approach is recommended.

**Acceptance criteria:**
- [ ] File compiles with `tsc --noEmit` without errors
- [ ] `T2F5_DONE_SENTINEL` exported from `background.ts` and importable in worker without circular-import error
- [ ] No circular imports: worker imports background (for constant) and claude (for connector); background imports worker URL only at runtime via `new URL(...)` — not a TS import
- [ ] On successful run: `stream.jsonl` ends with `{"__t2f5_done__":0}` line
- [ ] On error: `stream.jsonl` ends with `{"__t2f5_done__":1}` line; `stream.end()` always called
- [ ] On error: error message written to `stderrPath` (the `.err` file); test asserts `stderrPath` is non-empty after simulated query failure
- [ ] `appendFileSync` write failure to `.err` file does NOT prevent sentinel write or crash the worker
- [ ] `scanStream` can parse the worker's JSONL output without changes (D2 invariant)

---

### Task 4 — Runner Plumbing (`ts/src/connectors/runner.ts`)

**Depends on:** Task 2 (calls `startBackgroundRun` which now accepts `allowedTools`/`disallowedTools`)  
**File:** `ts/src/connectors/runner.ts`

Three changes:

#### Task 4a — Make `pid` optional in return type (current line 30)

```typescript
// Before:
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid: number; streamPath: string }> {

// After:
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string }> {
```

#### Task 4b — Forward `allowedTools`/`disallowedTools` to `startBackgroundRun` (current lines 33–43)

Add two optional spreads at the end of the `startBackgroundRun()` call:

```typescript
...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
```

Note: `AgentRunOptions` (lines 6–18) already declares `allowedTools?: string[]` and `disallowedTools?: string[]` — no interface change needed.

**Acceptance criteria:**
- [ ] TypeScript compiles without error when destructuring `bg_started` result with `pid` as optional
- [ ] `allowedTools` passed to `runAgent` reaches `startBackgroundRun` (verifiable via `meta.json` test)
- [ ] Codex path still returns `pid: number` (the codex code sets `pid = child.pid`)
- [ ] Existing `tests/connectors/background.test.ts:84` passes: `expect(meta.childPid).toBe(started.pid)` — update to `expect(typeof started.pid).toBe("number")` first

#### Task 4c — Sync-path discriminant validation in `runAgent()` (current lines 44–61)

Design.md:286 requires the same agent/sandboxMode guards in the synchronous foreground path. Currently `runAgent()` dispatches `options.agent === "codex"` to CodexConnector and everything else to ClaudeConnector with no validation — unknown agent values silently fall through to ClaudeConnector.

Insert the following constants and guards at the top of the `runAgent()` body (before both the `background` and connector dispatch branches, i.e. before line 32):

```typescript
const VALID_AGENTS = new Set<string>(["claude", "codex"]);
const VALID_SANDBOX_MODES = new Set<string>(["read-only", "workspace-write"]);

if (!VALID_AGENTS.has(options.agent)) {
  throw new Error(
    `Unknown agent ${JSON.stringify(options.agent)}; must be "claude" or "codex"`
  );
}
if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
  throw new Error(
    `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only" or "workspace-write"`
  );
}
```

These constants can be defined as module-level `const` sets in `runner.ts` (not re-created per call) or inlined as literals inside the guard — either is acceptable. They are distinct from the ones in `background.ts` to avoid adding an import; the check is a one-liner per value and duplication is intentional for isolation.

**Acceptance criteria:**
- [ ] `runAgent({ agent: "gemini" as "claude", prompt: "p", cwd: "/tmp" })` throws with message containing `"Unknown agent"`
- [ ] `runAgent({ agent: "codex", sandboxMode: "locked" as "read-only", prompt: "p", cwd: "/tmp" })` throws with message containing `"Unknown sandboxMode"`
- [ ] `runAgent({ agent: "claude", ... }, { claudeQuery: stubQuery })` succeeds (foreground positive path)
- [ ] `runAgent({ agent: "codex", sandboxMode: "read-only", ... }, { codexSpawn: stubSpawn })` succeeds (foreground codex positive path)

---

### Task 5 — MCP Server Handler (`ts/src/mcp/server.ts`)

**Depends on:** Tasks 1 and 4 (contract declares fields; runner accepts them)  
**File:** `ts/src/mcp/server.ts`

Update `stratum_agent_run` handler (current lines 111–121) to read and forward `allowedTools`/`disallowedTools`.

Critical detail — use `Array.isArray()` guard before `optionalArray()`:

```typescript
const allowedTools = Array.isArray(request.allowedTools)
  ? optionalArray(request, "allowedTools")
  : undefined;
const disallowedTools = Array.isArray(request.disallowedTools)
  ? optionalArray(request, "disallowedTools")
  : undefined;
```

**Why:** `optionalArray` (line 238) returns `[]` (empty array) when the key is absent — an empty array is truthy, so a naive `if (allowedTools)` spreads `allowedTools: []`, incorrectly restricting tools to zero when the caller provided no list. The `Array.isArray(request.allowedTools)` guard makes "not provided" map to `undefined`.

Then spread conditionally:
```typescript
...(allowedTools !== undefined ? { allowedTools } : {}),
...(disallowedTools !== undefined ? { disallowedTools } : {}),
```

**Acceptance criteria:**
- [ ] `stratum_agent_run` with `allowedTools: ["Read"]` passes `allowedTools` through to `agentRun`
- [ ] `stratum_agent_run` without `allowedTools` does NOT pass `allowedTools: []` to `agentRun`
- [ ] `stratum_agent_run` with `allowedTools: ["Read", 42]` rejected by `assertToolRequest` before reaching handler
- [ ] Existing `stratum_agent_run` calls without `allowedTools`/`disallowedTools` unaffected

---

### Task 6 — SDK Mapping Fix (`ts/src/connectors/claude.ts`)

**Depends on:** nothing (independent fix, but logically tied to BG-WRITE-B)  
**File:** `ts/src/connectors/claude.ts`

Fix `allowedTools` → SDK `tools` mapping at current lines 46–48.

**Current (WRONG):**
```typescript
if (this.options.allowedTools !== undefined) {
  sdkOptions.allowedTools = this.options.allowedTools;
```

**After (D5: maps to availability, not auto-approve):**
```typescript
if (this.options.allowedTools !== undefined) {
  // D5: ClaudeConnectorOptions.allowedTools controls AVAILABILITY (which tools the model
  // is offered), not permission auto-approve. Map to sdkOptions.tools instead.
  sdkOptions.tools = this.options.allowedTools;
```

The `else` branch (lines 49–52, preset `claude_code`) is unchanged.

**Breaking change:** Any internal callers that relied on the old `sdkOptions.allowedTools` (auto-approve) behavior must now pass `permissionMode: "acceptEdits"` separately. Audit: `grep -r "allowedTools" ts/src/` shows only `runner.ts` passes this field, and it receives it from MCP callers where availability semantics are the correct intent.

**Acceptance criteria:**
- [ ] `ClaudeConnector` instantiated with `allowedTools: ["Read"]`: verify `sdkOptions.tools === ["Read"]` and `sdkOptions.allowedTools` is NOT set
- [ ] `ClaudeConnector` instantiated without `allowedTools`: verify `sdkOptions.tools` is `{ type:"preset", preset:"claude_code" }` (unchanged default)
- [ ] `ClaudeConnector` instantiated with `disallowedTools: ["Write"]`: verify `sdkOptions.disallowedTools === ["Write"]`

---

### Task 7 — Tests

**Depends on:** Tasks 2–6 (all implementation must be in place)

#### Task 7a — Update `ts/tests/connectors/background.test.ts`

**Line 84:** `started.pid` is now optional. Update:
```typescript
// Before:
expect(meta.childPid).toBe(started.pid);

// After:
expect(typeof started.pid).toBe("number");
expect(meta.childPid).toBe(started.pid);
```

**Line 101:** The `"codex-only"` guard is gone. Replace with three targeted assertions:
```typescript
// Unknown agent rejected (D11 discriminant validation):
await expect(startBackgroundRun({ agent: "gemini" as "claude", prompt: "p", cwd: registryRoot, registryRoot }))
  .rejects.toThrow("Unknown agent");

// Claude bg with sandboxMode:read-only rejected (D8):
await expect(startBackgroundRun({ agent: "claude", prompt: "p", cwd: registryRoot, registryRoot, sandboxMode: "read-only" }))
  .rejects.toThrow("sandboxMode='read-only' are not supported");

// budgeted still rejected:
await expect(startBackgroundRun({ agent: "codex", prompt: "p", cwd: registryRoot, registryRoot, budgeted: true }))
  .rejects.toThrow("cannot debit run budgets");
```

**Acceptance criteria:**
- [ ] All existing codex golden flow tests still pass (regression)
- [ ] New discriminant and D8 assertions pass
- [ ] No "codex-only" assertion remains

#### Task 7b — Update `ts/tests/connectors/claude.test.ts`

**Line 29:** Change `allowedTools: ["Read"]` to `tools: ["Read"]` in the `expect.objectContaining` assertion (the SDK options object now has `tools`, not `allowedTools`):

```typescript
// Before:
expect.objectContaining({
  cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", allowedTools: ["Read"],
})

// After:
expect.objectContaining({
  cwd: "/work", model: "claude-sonnet-4-6", permissionMode: "acceptEdits", tools: ["Read"],
})
```

**Acceptance criteria:**
- [ ] `tests/connectors/claude.test.ts` passes with updated assertion
- [ ] No `allowedTools` property appears in captured `sdkOptions` when `allowedTools` is passed to connector

#### Task 7c — New `ts/tests/connectors/background-claude.test.ts`

Create a new test file covering all claude-specific test cases from the design's test plan (§ BG-WRITE-A).

**Recommended test seam:** Use `STRATUM_TEST_WORKER=1` env var in `claude-bg-worker.ts` to substitute a stub query that writes one `item.completed` record and exits immediately, avoiding real SDK calls in CI.

**Required test cases (all must pass):**

**Start / meta:**
- [ ] Claude bg start: `startBackgroundRun({ agent:"claude", ... })` returns `{ status:"bg_started", runId, streamPath }` with no `pid`
- [ ] `meta.json` written with `agent:"claude"`, `sandboxMode:"workspace-write"` (default), no `childPid`
- [ ] `loadMeta` accepts `agent:"claude"` meta files
- [ ] `loadMeta` still rejects unknown agent values (`agent:"gemini"`)

**sandboxMode enforcement (D8):**
- [ ] `startClaudeBackgroundRun` with `sandboxMode:"read-only"` throws
- [ ] `sandboxMode:"workspace-write"` explicit: succeeds
- [ ] `sandboxMode` omitted: defaults to `workspace-write`

**Poll:**
- [ ] Poll while running: returns `{ status:"running" }`
- [ ] Poll after completion: returns `{ status:"complete", text, usage }` with rc=0 sentinel
- [ ] Poll after error: returns `{ status:"error" }` with rc=1 sentinel
- [ ] Poll after MCP server restart (no registry entry, no sentinel): returns `{ status:"error", reason:"child_died_without_sentinel" }`

**Cancel:**
- [ ] Cancel in-flight: `{ status:"cancelled" }`, sentinel at rc=130, subsequent poll `{ status:"error" }`
- [ ] Cancel after already complete (sentinel present): `{ status:"already_complete" }`
- [ ] Cancel with no registry entry (server restart, no sentinel): `{ status:"not_found" }`
- [ ] Worker wins the race (writes rc=0 between scan and terminate): cancel returns `"already_complete"`, subsequent poll also `"complete"` (no cancel/poll disagreement)

**Sentinel serialization (D13 — r3 finding):**
- [ ] Error + exit both fire: exactly ONE sentinel record in `stream.jsonl` (error handler claims lock; exit handler discards its work)
- [ ] `finalizationClaim` is non-null synchronously after error event fires (before appendFile resolves)
- [ ] Two concurrent cancel calls: exactly one rc=130 sentinel written, both calls resolve

**Cancel-joins-error-claim race (D14 — r4 finding):**
- [ ] Cancel joins error handler's claim: returns `"already_error"`, subsequent poll returns `"error"` — no cancel/poll disagreement
- [ ] Cancel that owns rc=130 (finalizationClaim was null): returns `"cancelled"`, subsequent poll returns `"error"`
- [ ] Concurrent second cancel joins first cancel's claim: second returns `"already_error"` (after first writes rc=130 and poll reads it), no second sentinel written

**Worker error containment (D9 — r1 finding):**
- [ ] Worker emits `error` event: no uncaught exception propagates to MCP process; poll returns `{ status:"error" }`
- [ ] Registry entry deleted after worker error

**D9 callback-order interleaving tests (worker-stub precision — r1 plan-gate finding):**

These tests require a controllable worker stub that fires events in a specific synchronous order. The stub can be a plain `EventEmitter` placed into the registry in place of a real `Worker` (mock the `Worker` constructor or use the test-only `startClaudeBackgroundRun` boundary).

- [ ] **Synchronous exit-after-terminate proves rc=130**: stub `worker.terminate()` to emit `exit(1)` synchronously (simulating the OS signal path); with `entry.cancelling = true` already set before the event fires, verify the exit handler does NOT call `writeSentinelIfAbsent` and the cancel path writes exactly one sentinel with `exitCode:130`
- [ ] **Exit-handler suppressed when `cancelling=true`**: inject a stub that emits `exit(1)` after `entry.cancelling = true` is set; verify `stream.jsonl` contains no sentinel from the exit handler and the cancel path's own sentinel at rc=130 is the only terminal record
- [ ] **Error-handler suppressed after cancellation**: inject a stub that emits `error(new Error("late"))` after `entry.cancelling = true` is set; verify the error handler returns without calling `claimFinalization`; cancel path writes rc=130 sentinel (not rc=1); `stream.jsonl` has exactly one sentinel
- [ ] **Single registry deletion via `finalizationClaim.finally`**: spy on `claudeWorkerRegistry.delete`; drive each terminal path (error, exit, cancel) in isolation; verify `delete(runId)` is called exactly once per run in every path

**Registry cleanup (D10 — r2 finding):**
- [ ] Registry entry deleted after completion
- [ ] Registry entry deleted after cancel
- [ ] Registry entry deleted after worker error

#### Task 7d — New `ts/tests/mcp/agent-run.test.ts`

**Depends on:** Tasks 1, 2, 3, 4, 5, 6 (full stack must be in place)  
**File:** `ts/tests/mcp/agent-run.test.ts` (new)

Create a new MCP-level test file using the `createMcpServer` + `InMemoryTransport` pattern (same as `tests/mcp/p5.test.ts`) to test `stratum_agent_run` at the **public MCP surface** — not by calling `startBackgroundRun()` or `runAgent()` directly. The design requires these tests to exercise the full request→handler→connector path, including contract validation, handler routing, and tool-filter forwarding.

**Setup:**
```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, type McpDependencies } from "../../src/mcp/server.js";

async function connected(dependencies: McpDependencies) {
  const server = await createMcpServer(dependencies);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-run-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
```

Inject test boundaries via `McpDependencies` (`agentRun` stub or `runAgent` boundary stubs) to avoid real SDK/codex process spawning. Use `STRATUM_TEST_WORKER=1` for claude bg runs.

**Required test cases:**

**Codex workspace-write via command seam (design.md:681):**
- [ ] `stratum_agent_run { agent:"codex", sandboxMode:"workspace-write", background:true, prompt:"p", cwd:"/tmp" }` via MCP client returns `{ status:"bg_started", runId, streamPath }` — uses `backgroundCommand` stub so no real codex process spawns
- [ ] Follow-up `stratum_agent_poll { runId }` via MCP client returns `{ status:"running" }` or `{ status:"complete" }` (stub writes sentinel immediately on poll for determinism)

**Claude bg via MCP (design.md:682-683):**
- [ ] `stratum_agent_run { agent:"claude", background:true, prompt:"p", cwd:"/tmp" }` via MCP client returns `{ status:"bg_started", runId, streamPath }` with no `pid` field; `meta.json` written with `agent:"claude"` — uses `STRATUM_TEST_WORKER=1` stub
- [ ] Follow-up `stratum_agent_poll { runId }` via MCP client returns `{ status:"running" }` immediately after start

**MCP forwarding and rejection (design.md:697-701):**
- [ ] `stratum_agent_run { agent:"claude", allowedTools:["Read"], background:false, prompt:"p", cwd:"/tmp" }` via MCP: captured `agentRun` call (spy/stub) receives `allowedTools: ["Read"]` — verifies `optionalArray` is forwarded correctly
- [ ] `stratum_agent_run { agent:"claude", allowedTools:["Read", 42], background:false, ... }` via MCP: `McpError` thrown by `assertToolRequest` before `agentRun` is called (mixed-type array rejected at contract boundary)
- [ ] `stratum_agent_run` without `allowedTools` via MCP: captured `agentRun` call does NOT receive `allowedTools` property (not `allowedTools: []`) — verifies the `Array.isArray` guard in `server.ts` Task 5

**Foreground claude allowlist flow (design.md:750):**
- [ ] `stratum_agent_run { agent:"claude", allowedTools:["Read"], background:false, prompt:"p", cwd:"/tmp" }` via MCP with `claudeQuery` boundary stub: captured SDK options have `tools: ["Read"]` (not `sdkOptions.allowedTools`) — end-to-end path from MCP wire → `server.ts` → `runAgent()` → `ClaudeConnector` → SDK options

**Acceptance criteria:**
- [ ] All 9 test cases above pass
- [ ] No real codex or claude SDK process is spawned (all boundary stubs)
- [ ] `McpError` path asserts `agentRun` was NOT called (contract rejects before handler body)
- [ ] `stratum_agent_run` without `allowedTools` test asserts `agentRun` was called with exactly the expected keys (no extra `allowedTools: undefined` or `allowedTools: []`)

---

## File Change Summary

| # | File | Type | Tasks |
|---|---|---|---|
| 1 | `ts/contracts/mcp-surface.json` | modify | Task 1 |
| 2 | `ts/src/connectors/background.ts` | modify | Tasks 2a–2i |
| 3 | `ts/src/connectors/claude-bg-worker.ts` | **new** | Task 3 |
| 4 | `ts/src/connectors/runner.ts` | modify | Tasks 4a–4c |
| 5 | `ts/src/mcp/server.ts` | modify | Task 5 |
| 6 | `ts/src/connectors/claude.ts` | modify | Task 6 |
| 7 | `ts/tests/connectors/background.test.ts` | modify | Task 7a |
| 8 | `ts/tests/connectors/claude.test.ts` | modify | Task 7b |
| 9 | `ts/tests/connectors/background-claude.test.ts` | **new** | Task 7c |
| 10 | `ts/tests/mcp/agent-run.test.ts` | **new** | Task 7d |

---

## Key Invariants (must hold in the final implementation)

1. **No double sentinel** (D13): exactly one `__t2f5_done__` line per run in `stream.jsonl` — `claimFinalization()` guarantees this
2. **Registry deletion after sentinel** (D10): `claimFinalization().finally()` deletes after `doFinalize` settles — no window where poll sees "entry gone + no sentinel"
3. **cancel/poll agreement** (D11, D14): the status cancel returns must match what a subsequent poll returns for the same run
4. **Worker error containment** (D9): `worker.on("error", ...)` listener always present — prevents MCP process crash on worker exception
5. **`scanStream` is agent-agnostic** (D2): the worker writes identical JSONL format as Codex shell wrapper — `scanStream` needs no branching
6. **`optionalArray` empty-array gotcha** (Task 5): always guard with `Array.isArray(request.X)` before calling `optionalArray()` to distinguish "not provided" from "provided as empty array"

---

## Verification

Run after all tasks complete, before committing:

```bash
cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/vitest run                          # full suite
./node_modules/.bin/vitest run tests/connectors/        # connector focus
./node_modules/.bin/vitest run tests/mcp/               # contract validation
```

Gate conditions:
- [ ] `vitest run` passes with no new failures
- [ ] `tests/connectors/background.test.ts` still passes (codex golden flow regression)
- [ ] `tests/connectors/claude.test.ts` passes with updated `tools` assertion
- [ ] `tests/connectors/background-claude.test.ts` all new cases pass (including D9 callback-order interleaving tests)
- [ ] `tests/mcp/contracts-grammar.test.ts` passes
- [ ] `tests/mcp/agent-run.test.ts` all new MCP-surface cases pass
- [ ] `started.pid` is `undefined` for claude bg runs (TypeScript and runtime)
- [ ] Existing codex background test at line 84 still asserts a real `pid` number
- [ ] `runAgent({ agent:"gemini", ... })` throws (sync-path validation, Task 4c)

---

## Out of Scope

- Compose-side wiring (`consumer_dispatch_bg_unsupported` guard in `engine.ts:291-299`) — follow-on
- Claude background event streaming (SSE/push) — follow-on
- Durability of claude bg runs across MCP server restarts — intentionally in-memory (D3)
- `budgeted` support for background runs — existing guard preserved
- Tool allowlists for Codex — Codex uses `sandboxMode` for access control by design
