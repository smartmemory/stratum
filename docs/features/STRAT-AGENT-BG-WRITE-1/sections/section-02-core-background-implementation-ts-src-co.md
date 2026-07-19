# Section 02 — Core Background Implementation (`ts/src/connectors/background.ts`)

**Task ID:** T2
**Depends on:** —
**Files:** loaded.meta.childPid, .finally(() => claudeWorkerRegistry.delete(runId)), meta.json, claudeWorkerRegistry.has(runId), stream.jsonl, workerInput.stderrPath

## Plan

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
