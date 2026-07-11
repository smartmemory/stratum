# STRAT-TS-FLOW-BG — Build Brief (v1)

**Feature:** TS whole-flow **detached driver** + `flow_run_bg` / `flow_bg_poll` /
`flow_cancel_bg` MCP tools. The one piece the TS engine genuinely lacks: a
server-side loop that pumps a WHOLE pipeline to terminal (or to a paused gate)
**without the session calling `step_done` for every step**. Judged ensures run
through the EXISTING TS judge backend. Fanout already dispatches async in the
engine — reuse it, don't re-implement.

You (codex) implement in `write` mode on the `ts/` tree. The design below is
**LOCKED** — do not re-architect it. Fill in the mechanics, wire it, and prove
it with process-backed tests (real backends, no mocks of git/SDK internals).

---

## Reading list (read these BEFORE writing — they are the machinery you reuse)

1. `ts/src/engine/engine.ts`
   - `plan()` :206, `stepDone()` :225, `resume()`/`resumeLocked()` :318/:322,
     `gateResolve()`/`gateResolveLocked()` :353/:357, `flowPoll()` :339,
     `advance()` :410, `advanceScopeLoop()` :472 (gate → `waiting_gate` at :534),
     `scheduleFanout()` :623 (async fanout, already client-free),
     `collectReady()` :1283, `readyStep()` :1160.
   - Lifetime helpers: `retainRun`/`releaseRun` :182/:188, `withRunLock` :195,
     `activeRuns`/`scheduledFanouts` :163/:167.
   - Injected seams the constructor already holds: `this.connector`
     (`EngineConnector` :87) and `this.judge` (`JudgeRunner` :45). **The driver
     reuses BOTH — that is why it must live inside `StratumEngine`.**
   - Types: `ReadyStep` :78, `EngineConnector` :87, `EngineResponse` :105,
     `FlowPollResponse` :112.
2. `ts/src/mcp/server.ts` — tool dispatch switch (:63), `defaultEngine()` (:42,
   builds the judge). New tools register here.
3. `ts/src/mcp/contracts.ts` + `ts/contracts/mcp-surface.json` — frozen tool
   surface (request/response shapes, per-status discriminated responses). New
   tools need entries here.
4. `ts/tests/parity/p6.test.ts` — the process-backed test pattern: inject a fake
   `EngineConnector`, drive, `flowPoll`-poll to terminal. Fixtures:
   `ts/parity/{linear-gate,fanout,subflow}.v1.yaml`.
5. Python reference to MIRROR (shape, not code):
   `stratum-mcp/src/stratum_mcp/server.py:5162-5460` —
   `_background_flow_advance`, `_bg_dispatch_step`, `paused_gate` handling,
   `stratum_flow_run_bg`/`bg_poll`/`cancel_bg`.

---

## LOCKED design

### Where it lives
Add to `StratumEngine` (engine.ts). It MUST be engine-embedded so it reuses
`this.connector`, `this.judge`, `this.stepDone`, `this.resume`, `this.advance`,
`collectReady`, `retainRun`/`releaseRun`, and the per-run lock. Do NOT build a
standalone driver that re-injects its own connector — that would fork the
connector/judge from the ones fanout and ensures already use.

### In-process registry (v1)
```
type BgStatus = "running" | "paused_gate" | "completed" | "failed" | "budget_exhausted" | "cancelled";
interface BgFlowState { status: BgStatus; cancelRequested: boolean; loop?: Promise<void>; gateStepId?: string; }
private readonly bgFlows = new Map<string, BgFlowState>();
```
This registry is IN-PROCESS (v1, one engine process — same assumption as the
existing `runLocks` comment at :159). Durable run state stays in the store via
`persist`; a process restart loses the in-process loop but the run itself is
resumable via the existing `resume()` (rehydrating bg loops on startup is a
FOLLOW-UP, out of scope here — note it in a code comment).

### `flowRunBg(specInput, input, options): Promise<{ runId, status }>`
1. `const first = await this.plan(specInput, input, options)` — reuse plan; it
   validates, creates the run, and returns the first `EngineResponse`.
2. Register `bgFlows.set(first.runId, { status: "running", cancelRequested: false })`.
3. Kick the loop fire-and-forget, mirroring `scheduleFanout`'s lifetime
   discipline: `retainRun(runId, <the run>)` for the loop's duration, launch
   `void this.driveBg(runId, first)`, `releaseRun` in a `.finally`. (Load the
   run instance to retain via the same path plan used, or accept the runId and
   retain inside driveBg — either is fine as long as the loop and any in-flight
   fanout share ONE pinned instance.)
4. Return `{ runId: first.runId, status: "running" }` IMMEDIATELY (detached).

### `driveBg(runId, resp)` — the loop (private)
Holds NO lock between iterations (so `stepDone`/fanout interleave normally).
```
loop forever:
  if bg.cancelRequested: bg.status = "cancelled"; persist a cancel note if cheap; return
  switch resp.status:
    "ready":
      // v1: sequential dispatch is correct. Dispatch the FIRST ready step,
      // then re-loop on the fresh response (stepDone returns newly-ready
      // siblings). Parallel top-level dispatch is a FOLLOW-UP.
      const s = resp.ready[0]
      let result: StepResult
      try {
        result = await this.connector({
          agent: s.agent, prompt: s.do, attempt: s.attempt,
          ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
          ...(s.previousFailure ? { previousFailure: s.previousFailure } : {}),
          sandbox: "read-only",
        })
      } catch (err) {
        // A connector throw is a real dispatch failure — feed it as a failed
        // step result so the engine's retry/attempt-cap machinery owns it.
        result = { failure: message(err) }
      }
      resp = await this.stepDone(runId, s.id, result)
      continue
    "completed" | "failed" | "budget_exhausted":
      bg.status = resp.status; return
    "running":
      // Ambiguous: a gate is waiting OR async fanout/subflow is in flight.
      if (some step in this run has status "waiting_gate"):
        bg.status = "paused_gate"; bg.gateStepId = <that step id>; return   // HAND OFF — never auto-resolve
      else:
        // async work in flight — yield, then re-advance to observe progress.
        await delay(BG_POLL_MS)
        resp = await this.resume(runId)   // re-advances; returns ready steps once fanout settles
      continue
```
Notes:
- `workspaceRoot` = the run's persisted `workspaceRoot` (canonicalized at plan
  time). Read it off the loaded run.
- Detecting `waiting_gate`: load the run (or reuse the pinned instance) and check
  `run.steps[*].status === "waiting_gate"` in the entry flow. `resume()` /
  `stepDone()` return `{status:"running"}` for BOTH gate-waiting and
  fanout-in-flight, so you MUST disambiguate by inspecting step state.
- `BG_POLL_MS`: small (e.g. 25ms) constant. The engine advances fanout on its
  own microtasks; the poll only re-checks for terminal / newly-ready.
- `resume()` emits a `resumed` event each call. To avoid audit-spam in the
  poll loop, prefer a private re-advance that does NOT emit `resumed` (e.g.
  factor the advance path resume uses, or gate the event). If that is too
  invasive for v1, using `resume()` is acceptable — but call it out in the diff.
- Wrap the whole loop body so any thrown error → `bg.status = "failed"` and, if
  the run is still `running`, drive it to a terminal failure via the existing
  terminal-failure path (mirror `scheduleFanout`'s catch at :636). A bg loop
  must NEVER leave an unhandled rejection.

### Gate resume (so a linear+gate flow actually finishes)
Gates STAY paused — the driver hands off. The human/session resolves via the
existing `stratum_gate_resolve`. To auto-continue bg driving after that:
- In `gateResolveLocked` (or a thin wrapper `gateResolve`), AFTER a successful
  resolve, if `bgFlows.get(runId)?.status === "paused_gate"` and the returned
  response is non-terminal, flip bg back to `running` and re-kick
  `driveBg(runId, response)` (same retain/release fire-and-forget discipline).
- This keeps the gate contract intact (a human still decides) while the server
  resumes pumping — "session polls, server drives".

### `flowBgPoll(runId): Promise<FlowPollResponse & { bg: { status, cancelRequested } }>`
Reuse `this.flowPoll(runId, cursor)` and merge the `bgFlows` entry's
`{ status, cancelRequested }` (plus `gateStepId` when paused). Unknown runId →
throw (same as flowPoll). Accept an optional `cursor` like flowPoll.

### `flowCancelBg(runId): Promise<{ status }>`
Set `bg.cancelRequested = true`. The loop observes it at the next boundary and
stops with `status:"cancelled"`. Cancel is COOPERATIVE — an in-flight connector
dispatch is allowed to finish (do not hard-kill; the connector is the only
process seam and v1 owns no pid primitive). Return the current bg status.

---

## HARD CONSTRAINTS (from `docs/features/STRAT-FLOW-DETACH/design.md` — honor exactly)

- **Judge via the REAL path.** Judged ensures are evaluated INSIDE `stepDone` →
  `runEnsures` using `this.judge`. The driver adds ZERO judge wiring — it just
  calls `stepDone`, and the full `JudgeResult` flows through the same ensure /
  retry / judge-history machinery a session would hit. Do NOT hand-roll a
  reduced verdict path in the driver.
- **No pointless re-judge.** Rely on the engine's existing attempt-cap + retry
  behavior: an adverse verdict re-stages the step (back to `ready` with
  `previousFailure`), the driver re-dispatches (NEW connector evidence), and the
  engine fails the run when attempts exhaust. Do NOT add a re-judge loop in the
  driver. (Skipping re-judge on byte-identical evidence is a FOLLOW-UP.)
- **Gates STAY paused — never auto-approve.** Child-flow (sub-flow) gate
  propagation is OUT OF SCOPE for v1: v1 = judged ensures in a **linear + fanout**
  detached flow. A top-level gate pauses + hands off as specified above.
- **Distributability door-keeper.** The driver loop touches NO pid/process
  primitive. All dispatch goes through `this.connector`; the run handle is the
  OPAQUE `runId`; all durable state goes through the store seam (`persist`),
  never raw `~/.stratum` paths. Keep it one-connector-away from remote. Build no
  distributed anything, no filesystem pokes.

---

## MCP wiring

- Add tool names to the `ToolName` union (server.ts:22) and the dispatch switch
  (server.ts:63): `stratum_flow_run_bg`, `stratum_flow_bg_poll`,
  `stratum_flow_cancel_bg`.
- `stratum_flow_run_bg` request: `{ spec: any, input: any, workspaceRoot?: string }`
  (same shape as `stratum_plan`) → response `{ status: "running", runId }`.
- `stratum_flow_bg_poll` request: `{ runId: string, cursor?: number }` → response
  mirrors `stratum_flow_poll`'s per-status responses PLUS a `bg` object. Add `bg`
  to each status variant (or a shared shape) in the surface.
- `stratum_flow_cancel_bg` request: `{ runId: string }` → response
  `{ status: "cancelled" | "running" | ... }`.
- Register all three in `ts/contracts/mcp-surface.json`. Response shapes MUST
  pass `assertToolResponse`.
- **CRITICAL parity gate — `tests/mcp/p5.test.ts:166-168`** asserts that for
  every non-guard tool, the set of response STATUSES actually exercised in the
  test equals the set of statuses DECLARED in the surface. So: (a) keep each new
  tool's declared response variants MINIMAL (only statuses you will actually
  drive), and (b) EXTEND the p5 exercise block to hit every declared variant of
  all three new tools (run_bg → running; bg_poll → its status variants;
  cancel_bg → cancelled + the not-found/steady variants you declare). If the
  surface has a version number, bump it and update any digest the test checks.
- The `McpDependencies.engine` `Pick<>` (server.ts:14) must gain the three new
  methods so tests can inject a fake engine.

---

## Tests (process-backed, real backends, NO mocks of git/SDK) — MUST all pass

Put these in `ts/tests/engine/` (driver-level) and `ts/tests/mcp/` (tool-level).
Inject a fake `EngineConnector` and a fake `JudgeRunner` into a real
`StratumEngine` (see p6.test.ts:21-25 for the connector pattern; judge is the
`judge:` constructor option). You MUST cover ALL of:

- [ ] **Detached linear flow completes with NO `stepDone` calls from the test.**
      `flowRunBg` a linear spec (mirror `linear-gate` minus the gate, or a small
      inline spec); poll `flowBgPoll` until terminal; assert `completed` and the
      connector was called once per `do` step. The test NEVER calls `stepDone`.
- [ ] **Judged ensure is evaluated through the real judge path in bg mode.**
      Spec with a `judged:` ensure on a step. Inject a fake `JudgeRunner`; assert
      it WAS consulted (spy count > 0) and a passing verdict → `completed`.
- [ ] **Adverse verdict retries then fails fast at the attempt cap** (does NOT
      spin forever). Fake judge returns adverse; assert the run reaches `failed`
      within the step's attempt cap and the connector was called exactly
      `attempts` times for that step (bounded re-dispatch, no infinite loop).
- [ ] **A gate PAUSES the detached flow** (never auto-approves). Use
      `linear-gate`; `flowBgPoll` shows `bg.status === "paused_gate"` with the
      gate step id; the run is NOT completed. Then `gateResolve(..,"approve")`
      and assert the bg flow RESUMES and reaches `completed` without the test
      pumping the post-gate steps.
- [ ] **A fanout step runs detached** (mirror the `fanout` fixture): `flowRunBg`
      → poll to `completed`; the engine's async fanout drove it; the test never
      pumped anything.
- [ ] **`flowCancelBg` stops the loop cooperatively**: cancel mid-flight; poll
      shows `bg.status === "cancelled"`; no further connector dispatches after
      cancel is observed.
- [ ] **MCP tool round-trip**: `stratum_flow_run_bg` → `stratum_flow_bg_poll` →
      terminal, through `createToolDispatcher`, responses pass `assertToolResponse`.
- [ ] **No regression**: the FULL existing suite still passes (`pnpm test`).

---

## Build/verify commands (codex sandbox has no pnpm — use node_modules binaries)

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"
cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/tsc --noEmit                       # typecheck
./node_modules/.bin/tsc --noEmit --erasableSyntaxOnly  # strip-only gate: NO enum/namespace/param-props/decorators in touched code
./node_modules/.bin/vitest run tests/engine/ tests/mcp/  # focused
./node_modules/.bin/vitest run                          # full suite (baseline ~459-462 pass / 1 skip; p6 ENOTEMPTY is a KNOWN flake, passes isolated)
```

## Ground rules
- v1 IR only (`do/set/gate/fanout/run`, `version:1`). No new IR.
- Match surrounding engine style (terse, comment-the-why on the load-bearing
  concurrency lines). No new abstractions beyond the registry + driver.
- Do NOT `git commit` (sandbox can't — index.lock). Leave the tree dirty; the
  controller commits.
- Report: files touched, how each test checkbox is satisfied, any deviation from
  this brief with the reason.
