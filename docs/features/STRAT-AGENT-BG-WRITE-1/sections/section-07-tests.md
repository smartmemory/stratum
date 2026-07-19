# Section 07 — Tests

**Task ID:** T7
**Depends on:** —
**Files:** tests/connectors/claude.test.ts, meta.json, stream.jsonl, worker.terminate(), entry.cancelling = true, finalizationClaim.finally, Array.isArray, sdkOptions.allowedTools, tests/connectors/background.test.ts, tests/connectors/background-claude.test.ts, tests/mcp/contracts-grammar.test.ts, tests/mcp/agent-run.test.ts, started.pid

## Plan

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
