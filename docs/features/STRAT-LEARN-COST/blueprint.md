# STRAT-LEARN-COST — Implementation Blueprint

**Status:** BLUEPRINT (2026-08-30) · **Design:** `design.md` (approved at gate 2026-08-30, commit `25b5cbe`) · **Owner:** stratum (S01–S04), compose (S05)

## Related Documents

- Design: `./design.md` — carrier decision (§3), guarantees (§6 Q8), parked classifier (§7)
- Parent: `../STRAT-TS-LEARN/design.md`
- Contracts touched: `ts/contracts/mcp-surface.json`, `ts/contracts/events.json` (frozen; tests `ts/tests/mcp/contracts-grammar.test.ts`, `ts/tests/mcp/schema-grammar.test.ts`)
- Compose side ships in the compose repo; this blueprint pins its file plan so the two halves agree on the wire.

---

## 1. Corrections table (design assumption vs. code)

| # | Design said | Code says | Resolution |
|---|---|---|---|
| C1 | One compose funnel: `context.recordBuildUsage` (`build.js:2934`) | Two funnels. GSD routes through `recordTsAgentUsage` (`gsd.js:1430`) via `ctx.onUsage` (`gsd.js:521`, consumed at `build.js:1013` and `build.js:975`) | Both funnels gain `meta` and call `usageReport`. S05 lists both. |
| C2 | Compose "feature-detects the surface" | `stratum-mcp-client.js` has no tool listing; `#callTool` sends blind and the server throws `unknown MCP tool` from `assertToolRequest` (`contracts.ts:139`) | Add `hasTool(name)` on the client using the MCP SDK `client.listTools()`, cached per connection. Fallback when listing fails: treat as absent (envelope mode). |
| C3 | "Server-dispatched calls need no client receipt — the engine records `stratum_agent_run` itself" | `stratum_agent_run` is **not run-bound**: request is `{agent, prompt, cwd, …}` with no `runId` (`mcp-surface.json:163`); it returns `{text, usage, telemetry}` to the caller. The only engine-owned, run-bound dispatch is `this.connector(...)` at `engine.ts:860`, whose usage already settles via the internal `stepDone` path (`:508`). | Engine-connector dispatches get the legacy synthetic receipt (S01, no extra work). `stratum_agent_run` usage is reported by compose like any other dispatch — it already flows into the funnels. Design §3.0 paragraph "Server-dispatched calls" is corrected to this. |
| C4 | `dispatchId` is minted by compose with `randomUUID()` | The server already returns a `dispatchId` per agent run (`result-normalizer.js:651-656`, `dispatchIds.primary/repair`; the client's dispatch event carries `dispatch_id`, `stratum-mcp-client.js:206`) | Use the server's id when present; mint only for paths without one (fatal `err.usage` without `err.dispatchId`). |
| C5 | `seq` drawn from `generationCounter` | `generationCounter` is documented as the *fanout enumeration* counter (`state.ts:170`, `engine.ts:2369`); fanout tests may assert exact generation numbers | Add a sibling `receiptCounter` on `PersistedRun`, same excluded-from-checkpoint treatment (`checkpoint.ts:CHECKPOINT_EXCLUDED`). |
| C6 | `usage_report` response `{ status, budget?, ledger }` | Every engine response carries `ledger: { spent, budget? }` via `this.response(run)` (`engine.ts:2547`) and the surface declares it per status | Response shape: `ok: { runId, seq, budget?, ledger }`, `duplicate: { runId, seq, ledger }`. |
| C7 | `telemetry` optional on legacy path → `model: "unknown"` | `validConnectorTelemetry(undefined)` returns `true` (`engine.ts:2640`) and `telemetryFields` yields `{}`; but `AttemptTelemetry.model` is required on the *receipt* | Receipt builder fills `{ model: "unknown", durationMs: 0 }` when telemetry is absent; `usage_debit` event `model` is `"string"` (never optional). |
| C8 | `step_reset` emitted "after the descendant set is computed, before states are cleared" | `resetFrom` (`engine.ts:1955-1993`) has exactly that structure: closure loop, then the `for (const id of descendants)` clearing loop | Insert the event emit between the two loops; `subflowsDropped` = ids in `descendants` with `state.sub !== undefined` before clearing. |
| C9 | Egress rows for `step_reset`/`checkpoint_reverted` "from a small `egressEvents` list on the spine" | Simpler: those two are also appended to `run.receipts` as records with `source: "engine"` and `amount: {}` | One spine, one drainer; `amount: {}` rows never touch a ledger. |

## 2. Files touched — stratum (`stratum/ts`)

| File | Status | Change |
|---|---|---|
| `src/engine/state.ts` | existing | `PersistedRun.receipts?: ReceiptRecord[]`, `PersistedRun.receiptCounter?: number`; `ReceiptRecord` type; `AuditEvent.type` union += `"usage_debit" \| "step_reset" \| "checkpoint_reverted"` (`:157`) |
| `src/engine/checkpoint.ts` | existing | `CHECKPOINT_EXCLUDED` += `receipts`, `receiptCounter` (`:18-32`; the `satisfies Record<Exclude<…>>` forces this at compile time); `revertCheckpoint` recomputes `flowSpent` from spine and appends `checkpoint_reverted` (`:44-54`) |
| `src/engine/receipts.ts` | **new** | `buildReceipt(run, input): ReceiptRecord` (validation, `seq`, defaults), `findReceipt(run, dispatchId)`, `spineSpent(run): Budget`, `EGRESS_STATES` |
| `src/engine/engine.ts` | existing | `usageReport(runId, input)` public method; private `settleReceipt(run, receipt, scope?, step?, state?)` used by `usageReport`, `stepDone` (`:508`), judged (`:1845`), fanout (`:1676`); `resetFrom` emits `step_reset` (`:1976`); `revert` path calls checkpoint helper; drain trigger after `persist` (`:2536`) |
| `src/mcp/server.ts` | existing | `case "stratum_usage_report"` (`:135` block); `ToolName` union (`:48`) |
| `contracts/mcp-surface.json` | existing | `"surface": 15`; `stratum_usage_report` request/responses |
| `contracts/events.json` | existing | `"events": 2`; `usage_debit`, `step_reset`, `checkpoint_reverted` kinds |
| `src/learn/smartmemory_egress.ts` | **new** | `LearnEgress` class: `drain(run)` over `receipts[].egress === "pending"`, `/memory/add` body builder, dead-letter transitions, backoff; `verifyRun(runId)`; `retryDead(runId)` |
| `src/cli/learn.ts` | existing | `egress verify --run`, `egress retry-dead --run`, `egress drain` subcommands (`:36-50` switch) |
| `README.md` | existing | SmartMemory section: `SMARTMEMORY_EXTRA_MEMORY_TYPES` registration line, `STRATUM_LEARN_EGRESS` |
| `tests/engine/receipts.test.ts` | **new** | S01/S02 unit + golden |
| `tests/engine/checkpoint-receipts.test.ts` | **new** | revert immunity golden |
| `tests/mcp/contracts-grammar.test.ts`, `tests/mcp/schema-grammar.test.ts` | existing | surface 15 / events 2 fixtures |
| `tests/learn/egress.test.ts` | **new** | drainer against a real SmartMemory backend (skipped without creds) + fake-fetch state machine |

## 3. Files touched — compose (`compose/lib`)

| File | Status | Change |
|---|---|---|
| `stratum-mcp-client.js` | existing | `hasTool(name)` (SDK `listTools`, cached); `usageReport(runId, receipt)` wrapper on `#callTool('stratum_usage_report')`; `runAgentText` gains `opts.onUsage` and keeps its string return (`:692-699`); dispatch event unchanged (`:206-230`) |
| `build.js` | existing | `context.recordBuildUsage(usage, meta)` (`:2934`) → also `stratum.usageReport` when `context.receiptsMode`; `context.receiptsMode = await stratum.hasTool('stratum_usage_report')` set once at run start; envelope `usage` omitted in receipts mode at `:1046`; `meta` at all `recordBuildUsage` sites (`:3396-3400`, `:3503-3505`, `:3551-3553`, `:4198-4204`) and `onUsage` sites (`:975`, `:1013`); receipt-before-`stepDone` ordering at `:3755` (fold at `:3871` moves above the call); `makeAskAgent` passes `onUsage` and latches `budget` (`:1863-1890`) |
| `result-normalizer.js` | existing | `runAndNormalize` returns `usages: UsageRecord[]` alongside `usage` (`:636-690`); `step_usage` fold records `usd_source` (`:432-445`); `mergeUsage` untouched (callers report each side first) |
| `gsd.js` | existing | `recordTsAgentUsage(ctx, usage, meta)` (`:1430`) → also `usageReport`; `ordinaryUsage` envelope omitted in receipts mode (`:589`) |
| `bug-escalation.js` | existing | `runAgentText(..., { onUsage })` at `:119` and `:316` |
| `test/usage-receipts.test.js` | **new** | funnel → `usageReport` for each path in design §5; envelope omission in receipts mode; surface-14 fallback |

## 4. Slice plan

### S01 — receipt spine + `usage_report` (engine, contracts)

1. `state.ts`: add types; extend `AuditEvent.type`.
   ```ts
   export interface ReceiptRecord {
     seq: number; dispatchId: string; stepId?: string; source: string;
     amount: Budget; telemetry: AttemptTelemetry;
     split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
     usdSource?: "reported" | "estimated"; reportedAt?: string; at: string;
     egress: "pending" | "sent" | "dead"; egressStatus?: number;
   }
   ```
2. `checkpoint.ts`: add `receipts`, `receiptCounter` to `CHECKPOINT_EXCLUDED` (compile fails until done — that is the test).
3. `receipts.ts`: `buildReceipt` validates (`validUsage` from `ledger.ts:43`, `validConnectorTelemetry` — export it from `engine.ts:2639` or move to `ledger.ts`), rejects `dispatches`, requires `usdSource` when `usd` present, defaults telemetry to `{ model: "unknown", durationMs: 0 }`, assigns `seq = ++run.receiptCounter`.
4. `engine.ts::settleReceipt(run, receipt, located?)`: idempotency check via `findReceipt`; ledger debit via existing `debit()` — pass `step`/`state`/`scope` when the receipt names an *executable* step, a flow-only `BudgetLedger` path when it names a gate or nothing; push to `run.receipts`; `this.event(run, "usage_debit", stepId, detail)`; return `"flow" | "subflow" | "task" | undefined` like `debit`.
5. `engine.ts::usageReport(runId, input)`: `withRunLock` → `loadRun` → `locateStep` if `stepId` → `settleReceipt` → on `"flow"` and `run.status === "running"` → `terminalBudget`; on `"flow"` and terminal run → response `budget: "flow_exhausted_after_terminal"`; `persist`; return `{ status, runId, seq, budget?, ledger }`.
6. Route legacy debits: replace the three `this.debit(run, step, state, usage, "settle", …)` cost calls (`:508`, `:1676`, `:1845`) with `settleReceipt` using synthetic `dispatchId = \`legacy:${seq}\`` (seq allocated first) and `source` `"step_done" | "fanout" | "judged"`. `fanout_ledger_debit` emit stays.
7. `mcp-surface.json`: surface 15, tool declared; `server.ts` case; `events.json`: events 2, three kinds.
8. Tests: `receipts.test.ts` — duplicate no-op; terminal-run receipt; gate flow-only; `dispatches` rejected; legacy paths each yield one `usage_debit`; **invariant test:** walk every engine test fixture run and assert `Σ usage_debit.amount == flowSpent` when no checkpoint revert occurred. Contract-grammar fixtures.

### S02 — `step_reset` + revert immunity (engine)

1. `resetFrom`: between the closure loop and the clearing loop, compute `reset[]` and `subflowsDropped[]`, `this.event(run, "step_reset", target, {...})`. Note `resetFrom` receives `flow, steps, target` — scoped ids need the scope; add a `scopedPrefix` parameter from the caller at `:788`.
2. `revertCheckpoint` (or a wrapper in `engine.ts::revert` around it): after restore, `run.flowSpent = spineSpent(run)`; `this.event(run, "checkpoint_reverted", undefined, { label, receiptsAtRevert: run.receiptCounter ?? 0, stepsRestored })`; append an `engine`-source spine row so egress mirrors it.
3. Golden (`checkpoint-receipts.test.ts`, real engine, in-memory `StateStore` root): plan → step_done with usage → commit `cp` → usage_report → revert `cp` → assert receipt in spine, `flowSpent` == spine sum, event present, re-run step → new receipt (`status: "ok"`, new seq). Revise golden: gated flow → revise → `step_reset` lists descendants with epochs; prior `usage_debit`s untouched.

### S03 — SmartMemory egress (stratum)

1. `smartmemory_egress.ts`: constructor reads `SMARTMEMORY_API_URL/KEY/WORKSPACE_ID`, `STRATUM_LEARN_EGRESS`; `enabled()`; `drain(run, store)` — for each `pending` row: build body, `POST /memory/add` (copy `request()` shape from `policy/smartmemory_client.ts:131-150` incl. 5 s abort and `X-Workspace-Id`), 2xx → `sent`; 400/401/403/404/422 → `dead` + `egressStatus`; else stay `pending`, backoff (copy `recordFailure/resetBackoff`). Persist through the engine's run lock — expose `engine.withReceiptUpdate(runId, fn)` so the drainer never writes the run file outside the lock.
2. Body: `content` one-liner; `memory_type` per row (`stratum_usage_debit` | `stratum_step_reset` | `stratum_checkpoint_reverted`); `metadata` = row + `run_id, workspace_root, flow_name, spec_digest, receipt_id: \`${run.id}:${seq}\`, origin: "cli:stratum"`; `use_pipeline: false`.
3. Trigger: in `engine.ts` after `persist()` resolves, `void egress.drain(run.id).catch(warn)` when enabled (fire-and-forget only for the drain — the row is already durable). Also on engine construction: scan `store.list()` for runs with `pending` rows (startup reconciliation).
4. CLI: `stratum learn egress drain [--run]`, `verify --run <id>` (search `memory_type` exact + `metadata.receipt_id` prefix `run:`; report missing/duplicate counts), `retry-dead --run <id>`.
5. Tests: fake fetch state machine (2xx/422/503 transitions, backoff, no write when disabled, policy dir untouched); real-backend golden gated on creds: 3 receipts → drain → verify 0 missing; forced double-send → 1 duplicate reported.

### S04 — README + design corrections

README SmartMemory section; fold C1–C9 back into `design.md` §3.0/§3.1b (minimal edits).

### S05 — compose producer (compose repo)

1. `stratum-mcp-client.js`: `hasTool`, `usageReport`, `runAgentText({ onUsage })`.
2. `result-normalizer.js`: collect `usages[]` per `step_usage` message (`:432`), tag `usd_source`; return alongside `usage` (`:678`, `:686`). Repair dispatch appended as its own entry (`:656`).
3. `build.js`: `receiptsMode` at run start; `recordBuildUsage(usage, meta)` reports each entry of `usage.usages ?? [usage]`; pass `meta` at every site; omit envelope `usage` at `:1046` when `receiptsMode`; move the usage fold above `stepDone` at `:3755`; `makeAskAgent` `onUsage` + latch `budget === "flow_exhausted*"`.
4. `gsd.js`: `recordTsAgentUsage(ctx, usage, meta)`; omit `ordinaryUsage` at `:589` in receipts mode; `ctx.onUsage` passes meta through.
5. `bug-escalation.js`: `onUsage` on both tiers.
6. Tests: `test/usage-receipts.test.js` with a fake stratum client recording `usageReport` calls — one case per design §5 S0-compose criterion; the census script from design §2 becomes `scripts/cost-census.mjs` (run against a real build in Phase 7 step 2).

## File Plan

| Path | Action | Slice |
|---|---|---|
| `stratum/ts/src/engine/state.ts` | modify | S01 |
| `stratum/ts/src/engine/checkpoint.ts` | modify | S01, S02 |
| `stratum/ts/src/engine/receipts.ts` | create | S01 |
| `stratum/ts/src/engine/engine.ts` | modify | S01, S02, S03 |
| `stratum/ts/src/engine/ledger.ts` | modify | S01 — export `validConnectorTelemetry` here |
| `stratum/ts/src/mcp/server.ts` | modify | S01 |
| `stratum/ts/contracts/mcp-surface.json` | modify | S01 |
| `stratum/ts/contracts/events.json` | modify | S01, S02 |
| `stratum/ts/src/learn/smartmemory_egress.ts` | create | S03 |
| `stratum/ts/src/cli/learn.ts` | modify | S03 |
| `stratum/README.md` | modify | S04 |
| `stratum/ts/tests/engine/receipts.test.ts` | create | S01 |
| `stratum/ts/tests/engine/checkpoint-receipts.test.ts` | create | S02 |
| `stratum/ts/tests/learn/egress.test.ts` | create | S03 |
| `compose/lib/stratum-mcp-client.js` | modify | S05 |
| `compose/lib/result-normalizer.js` | modify | S05 |
| `compose/lib/build.js` | modify | S05 |
| `compose/lib/gsd.js` | modify | S05 |
| `compose/lib/bug-escalation.js` | modify | S05 |
| `compose/test/usage-receipts.test.js` | create | S05 |
| `compose/scripts/cost-census.mjs` | create | S05 |

## Boundary Map

### S01: receipt spine + usage_report
Produces:
  stratum/ts/src/engine/state.ts → ReceiptRecord (interface)
  stratum/ts/src/engine/receipts.ts → buildReceipt, findReceipt, spineSpent (function)
  stratum/ts/src/engine/engine.ts → usageReport (function)
  stratum/ts/src/engine/ledger.ts → validConnectorTelemetry (function)

Consumes: nothing (leaf node)

### S02: step_reset + revert immunity
Produces: nothing (integration only)

Consumes:
  from S01: stratum/ts/src/engine/receipts.ts → spineSpent
  from S01: stratum/ts/src/engine/state.ts → ReceiptRecord

### S03: SmartMemory egress
Produces:
  stratum/ts/src/learn/smartmemory_egress.ts → LearnEgress (class)

Consumes:
  from S01: stratum/ts/src/engine/state.ts → ReceiptRecord
  from S01: stratum/ts/src/engine/receipts.ts → findReceipt

### S05: compose producer
Produces:
  compose/lib/stratum-mcp-client.js → hasTool, usageReport (function)

Consumes:
  from S01: stratum/ts/src/engine/engine.ts → usageReport

## Verification Table

Every reference below was read in the blueprint session (2026-08-30) against `stratum` `25b5cbe` and the compose working tree.

| Ref | Claim | Verified |
|---|---|---|
| `engine.ts:508` | ordinary settle debit before outcome | ✔ `const budgetFailure = this.debit(run, step, state, usage, "settle", scope);` |
| `engine.ts:1676` | fanout settle debit | ✔ `const settled = this.debit(run, step, state, usage, "settle");` |
| `engine.ts:1845` | judged settle debit | ✔ `hasBudget(usage) ? this.debit(…, "settle", scope)` |
| `engine.ts:1920-1937` | `debit` writes flow/subflow/task ledgers, returns first exceeded | ✔ |
| `engine.ts:1955-1993` | `resetFrom` closure loop then clearing loop; clears attempts/spent/fanout/sub; epoch bump | ✔ |
| `engine.ts:788` | `resetFrom` caller inside `gateResolveLocked` | ✔ |
| `engine.ts:2369-2373` | `nextGeneration` bumps `generationCounter` | ✔ |
| `engine.ts:2463-2470` | `terminalBudget` unconditionally sets `budget_exhausted` | ✔ |
| `engine.ts:2536-2542` | `persist` serialises via `store.save` | ✔ |
| `engine.ts:2639-2646` | `validConnectorTelemetry(undefined) === true`; requires non-empty `model` | ✔ |
| `engine.ts:860` | engine-owned connector dispatch | ✔ `result = await this.connector({` |
| `ledger.ts:1-3, 43-48` | `BUDGET_KEYS`, `validUsage` | ✔ |
| `state.ts:157-161` | `AuditEvent.type` union | ✔ |
| `state.ts:170, 176-183` | `generationCounter`, `flowSpent`, `events` on `PersistedRun` | ✔ |
| `state.ts:221-228` | `StateStore.save` temp+rename single file | ✔ |
| `checkpoint.ts:12-14` | `CHECKPOINT_FIELDS` includes `flowSpent`, `events` | ✔ |
| `checkpoint.ts:18-32` | `CHECKPOINT_EXCLUDED` with `satisfies Record<Exclude<…>>` | ✔ |
| `checkpoint.ts:44-54` | `revertCheckpoint` overwrites listed fields | ✔ |
| `server.ts:48` | `ToolName` union | ✔ |
| `server.ts:135, 141` | `stratum_step_done`, `stratum_gate_resolve` cases | ✔ |
| `server.ts:219-222` | events validated on audit/poll; `assertToolResponse` | ✔ |
| `contracts.ts:121-124, 139-167` | undeclared-key rejection; `assertToolRequest/Response/Event` | ✔ |
| `mcp-surface.json:2, 58-59, 163-167` | `"surface": 14`; step_done request; agent_run request without `runId` | ✔ |
| `events.json:2, 5-60` | `"events": 1`; kinds list | ✔ |
| `policy/smartmemory_client.ts:58, 68-100, 131-150, 191-206` | outbox dir; send-then-queue; request shape; cap eviction | ✔ |
| `cli/learn.ts:36-50` | subcommand switch | ✔ |
| `build.js:975` | consumer abort → `onUsage` | ✔ |
| `build.js:1013-1015` | fanout `onUsage` | ✔ |
| `build.js:1046-1047` | fanout envelope `usage` | ✔ |
| `build.js:1863-1890` | `makeAskAgent` → `runAgentText` | ✔ |
| `build.js:2934-2952` | `recordBuildUsage` | ✔ |
| `build.js:3380-3407` | retry fixer + `recordBuildUsage` in try/catch | ✔ |
| `build.js:3503-3506` | fatal `recordBuildUsage` then throw | ✔ |
| `build.js:3528-3563` | policy revision, `mergeUsage` | ✔ |
| `build.js:3755` | main `stepDone` | ✔ |
| `build.js:3850-3871` | post-stepDone escalation, then usage fold | ✔ |
| `build.js:4186-4212` | review-gate fixer + `gateResolve` via `resolveGateWithConsumerMerge` | ✔ |
| `result-normalizer.js:264-274` | `mergeUsage` keeps one model | ✔ |
| `result-normalizer.js:432-445` | `step_usage` fold, `calculateCost` fallback | ✔ |
| `result-normalizer.js:642-690` | repair dispatch fold, `dispatchIds` | ✔ |
| `stratum-mcp-client.js:206-230` | dispatch event with `dispatch_id` | ✔ |
| `stratum-mcp-client.js:551-560` | `stepDone` wrapper | ✔ |
| `stratum-mcp-client.js:692-699` | `runAgentText` returns string | ✔ |
| `gsd.js:521, 586-589, 1430-1437` | `onUsage` → `recordTsAgentUsage`; `ordinaryUsage` envelope | ✔ |
| `bug-escalation.js:119, 316` | `runAgentText` without usage | ✔ |
| SmartMemory `memory_types.py:218, 251` | strict refusal of unregistered types; env registration | ✔ |
| SmartMemory `crud.py:577-590` | `/memory/add` mints new item | ✔ (per Codex r4 #7; not re-read here) |

### Boundary Map validation (Phase 5)

`validateBoundaryMap` (`compose/lib/boundary-map.js`) against this file, repo root `/Users/ruze/reg/my/forge`, 2026-08-30: **0 violations, 1 warning** (header-row parse of the File Plan table, informational). Every `from S##` reference points to an earlier slice; every produced symbol is on a File Plan path.
