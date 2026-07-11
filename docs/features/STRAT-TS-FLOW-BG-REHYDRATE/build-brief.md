# STRAT-TS-FLOW-BG-REHYDRATE — Build Brief

Make detached bg flows survive a server restart. Today the `bgFlows` registry
(who's driving what) is in-process only: after a restart the durable run state
survives on disk but no driver re-attaches, so a detached flow stalls. Add
startup rehydration that re-attaches a driver to every non-terminal bg run.

Design is **LOCKED**. WRITE mode on `ts/`. Do NOT `git commit` (sandbox can't) —
leave the tree dirty; the controller commits. Baseline origin/main @ v0.2.104.

Verify: `export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"; cd
/Users/ruze/reg/my/forge/stratum/ts` then `./node_modules/.bin/tsc --noEmit`,
`./node_modules/.bin/tsc --noEmit --erasableSyntaxOnly`, `./node_modules/.bin/vitest run`.
Known flake: `tests/parity/p6.test.ts` fanout ENOTEMPTY — passes isolated; ignore
if it's the only full-run failure.

## Reading list
- `ts/src/engine/engine.ts`: `flowRunBg` (~:239), `driveBg` (~:530), `reAdvance`,
  `resume`/`resumeLocked` (~:318), `flowBgPoll`/`flowCancelBg`, `retainRun`/
  `releaseRun`, the `bgFlows` map + `BgFlowState`/`BgStatus` types (~:120).
- `ts/src/engine/state.ts`: `PersistedRun` (has `cancelRequested?`), `StateStore`
  (`save`/`load`, `root`; NO list yet).
- `ts/src/cli/query_gate.ts:93-114` — the exact readdir+filter+load pattern to mirror.
- `ts/src/mcp/server.ts`: `defaultEngine()` (~:42), `createMcpServer` (~:137),
  `serveStdio` (~:151) — the startup wiring point.

## LOCKED design

### 1. Persist a bg-driven marker
Add `bgDriven?: boolean` to `PersistedRun` (state.ts). In `flowRunBg`, after
`plan()` returns, under the run lock set `run.bgDriven = true` and persist it
(before/at registering the loop). Keep it OPTIONAL (older runs load fine).

### 2. Store listing
Add `async list(): Promise<string[]>` to `StateStore`: `readdir(this.root)`,
return run ids for `*.json` files (strip `.json`). On ENOENT (dir absent) return
`[]` — mirror `query_gate.ts` `isNotFound` handling. Do not throw on an empty root.

### 3. `engine.rehydrateBgFlows(): Promise<void>`
Public method. Idempotent (safe to call once at startup; skip any run already in
`bgFlows`). For each run id from `store.list()`, `load` it (tolerate a load
failure per-run: log to stderr and skip, like query_gate). Then:
- `if (!run.bgDriven) continue;` — never drive a session-driven run.
- `if (bgFlows.has(run.id)) continue;` — idempotency.
- **Terminal** (`run.status !== "running"`): register
  `bgFlows.set(id, { status: run.status, cancelRequested: false })` so a
  post-restart `flowBgPoll` still resolves. No driver.
- **Cancelled** (`run.cancelRequested === true`): register
  `{ status: "cancelled", cancelRequested: true }`. No driver.
- **Live** (`running`, not cancelled): register `{ status: "running",
  cancelRequested: false }`, then re-attach the driver with the SAME lifetime
  discipline as `flowRunBg`:
  `retainRun(id, <loaded run>)`, `resp = await this.resume(id)` (re-advances,
  re-schedules running fanouts, returns the current EngineResponse), launch
  `void this.driveBg(id, resp)` with a `.finally(() => releaseRun(id) + clear bg.loop)`.
  Do NOT special-case paused_gate — `driveBg` detects a `waiting_gate` step from
  the `resume` response and re-registers `paused_gate` itself (the existing
  `gateResolve` re-kick then resumes it after approval).

Comment the AT-LEAST-ONCE semantics: a step whose connector was in flight when
the process died was persisted as `ready`; `resume`+`driveBg` re-dispatches it,
so a step may run twice across a restart (acceptable for the read-only default;
callers doing writes must be idempotent).

### 4. Startup wiring
In `serveStdio` (server.ts), build the engine explicitly, rehydrate, then serve:
```
const engine = defaultEngine();
await engine.rehydrateBgFlows();
const server = await createMcpServer({ engine });
```
`defaultEngine` returns a concrete `StratumEngine`, which satisfies the
`McpDependencies.engine` Pick — but that Pick must also expose the methods the
dispatcher already uses; add nothing new to it (rehydrate is called directly on
the concrete engine here, NOT through the dispatcher). Keep the test seam
(`createMcpServer(deps)` / `createToolDispatcher(deps)`) unchanged.

## Tests (process-backed, real backends, NO mocks — `tests/engine/`)
Simulate a restart with TWO engines sharing one `stateRoot` (a fresh
`StratumEngine` on the same root = a restarted process). You MUST cover:
- [ ] **Resumes a live detached flow.** Engine A: connector BLOCKS forever on the
      first step; `flowRunBg` a linear 2-step flow; await the first dispatch. Then
      Engine B on the SAME stateRoot with a NON-blocking connector; `await
      B.rehydrateBgFlows()`; `B.flowBgPoll` reaches `completed`. (Proves B
      re-attached and drove it home.)
- [ ] **Rehydrates a paused gate without driving past it.** Engine A: `flowRunBg`
      `linear-gate`, wait for `paused_gate`. Engine B same root; rehydrate;
      `B.flowBgPoll` shows `paused_gate` (not completed); then
      `B.gateResolve(review, approve)` drives it to `completed`.
- [ ] **Does not drive a session-driven (non-bg) run.** Plan a run via `A.plan`
      (not flowRunBg) and leave it; Engine B rehydrate; that run is NOT in
      `bgFlows` (`B.flowBgPoll` rejects /not found/).
- [ ] **Re-registers a terminal bg run for poll consistency.** A bg run that
      completed before "restart" is still pollable on B (`bg.status: "completed"`),
      with no driver re-dispatching it.
- [ ] **Does not re-drive a cancelled run.** Cancel a live bg flow on A, then
      rehydrate on B: `bg.status: "cancelled"`, no further connector dispatch.
- [ ] **Idempotent:** calling `rehydrateBgFlows()` twice does not double-register
      or double-drive.
- [ ] **Empty/missing state root** rehydrates to a no-op (no throw).
- [ ] Full existing suite still green.

## Constraints
- v1 IR only; no new deps; distributability held (state via the store seam, opaque
  runId, connector-only dispatch — rehydrate touches NO pid/process primitive).
- Match engine style; comment the load-bearing lines.
- Report: files touched; how each test checkbox is met (name the test); exact
  tsc + vitest output; any deviation + reason.

## Review outcomes (codex sol/high adversarial review — 4 findings)
- **F3 (bad/stalled run blocks or aborts startup) — FIXED.** `rehydrateBgFlows`
  no longer awaits `resume` per run; it launches `driveBg` with a synthesized
  `running` initial (self-discovers via `reAdvance`, which also re-schedules
  in-flight fanout). A malformed/slow run now fails in its own background driver
  instead of blocking the scan or hanging startup, and the retain can't leak
  (retain and launch are adjacent, no throwing await between). Regression test:
  "does not let a malformed persisted run block rehydration of a valid one".
- **F1 (two live engines on one state root double-drive) — OUT OF SCOPE / documented.**
  Rehydration assumes single-process ownership (the prior engine is gone) — the
  same v1 assumption as the run-lock model. Cross-process leasing is a deferred
  distributed feature; the distributability constraint says build no distributed
  anything.
- **F2 (re-dispatched step not re-ledgered) — documented bound.** A corollary of
  the accepted at-least-once restart semantics: an in-flight-at-crash dispatch may
  run again without a second ledger debit (a dispatch budget can under-count by
  the in-flight count). Callers doing writes must be idempotent.
- **F4 (worktree fanout merge not restart-idempotent) — PRE-EXISTING / noted.**
  The fanout merge's apply-before-persist crash window is an existing accepted
  residual, not introduced here; a restart can re-trigger it. Out of scope for
  this feature.

Also fixed a pre-existing driver test flake: `driveBg`'s error path now flips the
registry status to `failed` AFTER the durable terminalization persists (consistent
with the response-driven terminal paths), so a poller that sees `failed` can trust
the state is written and test cleanup can't race the persist.
