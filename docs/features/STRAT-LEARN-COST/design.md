# STRAT-LEARN-COST — Design

**Status:** DESIGN (2026-08-30, revised after design gate rounds 1–4; carrier pivoted at round 3; guarantees made explicit at round 4) · **Owner:** stratum · **Extends:** STRAT-TS-LEARN

## Related Documents

- Parent loop: `../STRAT-TS-LEARN/design.md` (harvest → classify → author → guarded apply), `../STRAT-TS-LEARN/report.md`
- Budget mechanism this writes to: STRAT-WORKFLOW-BUDGET (`ts/src/engine/ledger.ts`, `engine.ts::debit :1920`, `stepDone :499-573`, `terminalBudget`), STRAT-WORKFLOW-BUDGET-DOLLARS (`ts/src/judge/pricing.ts`, judge-only)
- Frozen contracts this extends: `ts/contracts/mcp-surface.json` (`"surface": 14`), `ts/contracts/events.json` (`"events": 1`), enforced by `ts/src/mcp/contracts.ts:121-167` and `server.ts:219-222`
- Checkpoints: `ts/src/engine/checkpoint.ts` (`CHECKPOINT_FIELDS` includes `flowSpent` and `events`; `revertCheckpoint :44-54`)
- Producer: compose `lib/build.js::context.recordBuildUsage` (`:2934-2952`, 20 call sites — the accounting funnel every model dispatch already passes through), `lib/result-normalizer.js` (`step_usage` fold `:432-445` incl. `calculateCost` estimate for Claude; `mergeUsage :264-274`), `lib/stratum-mcp-client.js` (`runAgentText :692-699` drops usage; `:217` usage mapping)
- SmartMemory ingest already used by compose: `compose/lib/smartmemory-client.js:305` (`POST /memory/add`, body `{content, memory_type, metadata, use_pipeline}`, header `X-Workspace-Id`); no upsert — `/memory/add` mints a fresh id per call (`memory_service/api/routes/crud.py:577-590`)
- SmartMemory type registry: `smart-memory-core/smartmemory/memory_types.py` (strict mode refuses unregistered types `:218/:251`; `SMARTMEMORY_EXTRA_MEMORY_TYPES` registers from env)
- Parked follow-up (classifier + notes): §7 → STRAT-LEARN-COST-2
- Roadmap row: `docs/plans/COMPOSE-ROADMAP.md` → Standalone Tickets → STRAT-LEARN-COST (parent STRAT-TS-LEARN)

---

## 1. Problem

STRAT-TS-LEARN closes the loop on *failures*. It reads nothing about *cost*. Stratum can cap spend and, for Codex, price it — but nothing records what each model call cost in a form that survives, is attributed, and can be learned from.

Three design-gate rounds against the real engine, compose, and corpus established that the classifier is the *last* thing to build: the data it would classify does not exist, and the engine actively destroys the part that does. They also established that **cost cannot ride on step lifecycle**: compose makes model calls that belong to no step outcome (gate Q&A, escalations after a step already reported, fixers that crash before reporting), and the engine has no single per-attempt finalization seam. This feature is therefore one primitive — **a receipt per model call** — plus the plumbing that makes every compose call emit one, survives resets and reverts, and mirrors to SmartMemory. The classifier is §7, gated on real data.

## 2. Corpus and engine census, and what it shows

Census of `~/.stratum/ts/flows`, 2026-08-30 (814 runs):

| Signal | Present | Of |
|---|---|---|
| `flowSpent` with any non-zero key | 811 | 814 runs (853,563 tokens · $76.42 · 2,057 dispatches) |
| step `spent.tokens` or `spent.usd > 0` | 238 | 1,832 step-states (13%) |
| top-level `steps[id].attempts[].usage` | **0** | 1,541 attempts |
| fanout `…fanout.items[].attempts[].usage` | **250** | 237 runs; Σ = 327,195 tokens = the *entire* step-level total |
| ordinary-step `result` events carrying usage | **0** | 1,567 |
| `fanout_ledger_debit` events carrying usage | all | per fanout debit, incl. `source: "judged"` |

Real priced cost: 5 step-states in `…/forge/{stratum,compose}` `build`; ~230 more are gsd budget test fixtures (the STRAT-TS-LEARN §2.1 noise shape, again).

**Findings, each verified in code:**

1. **Ordinary steps report no cost.** Every priced token arrived through the fanout path. Ordinary compose steps call `stepDone` with no `usage` and no `telemetry` although the contract accepts both.
2. **Compose bills model calls the engine never sees, and several belong to no step outcome.** Retry fixer (`build.js:3396`), fatal errors that throw before `stepDone` (`:3503`), the review-gate fixer that ends in `gateResolve` (`:4186-4208`), gate Q&A (`:1866-1886`, via `runAgentText` which drops usage, `stratum-mcp-client.js:692`), escalations *after* the owning step already reported (`:3755` → `:3850-3863`), consumer stuck/abort with no `stepDone` (`:970-979`). All of them do call `context.recordBuildUsage` — that hook is compose's accounting funnel (20 call sites vs 7 dispatch sites).
3. **Compose already collapses dispatches and estimates dollars.** `runAndNormalize` folds a review-repair dispatch into one aggregate (`result-normalizer.js:642-681`); `mergeUsage` sums calls and keeps one model (`:264-274`); Claude `cost_usd` is a local `calculateCost` estimate (`:432-445`), forwarded by `toEngineUsage` indistinguishably from Codex's reported cost. Model/effort telemetry is not preserved past the normalizer.
4. **Gate revise erases step-level cost history.** `flowSpent.tokens` (853K) > Σ step `spent.tokens` (327K); `resetFrom` (`engine.ts:1955-1993`) resets every descendant step — `attempts = []`, `spent = {}`, `fanout` cleared, `sub` deleted, epoch bump — while `flowSpent` accumulates. Run `af922492` ($16.46 flow vs $4.85 surviving) is the flagship.
5. **Checkpoint revert rewrites the event stream.** `CHECKPOINT_FIELDS` snapshots `flowSpent` and `events`; `revertCheckpoint` (`checkpoint.ts:44-54`) overwrites both from the snapshot. Money spent between checkpoint and revert vanishes from the local record. **Neither `steps[].spent` nor `events` is append-only today.**
6. **There is no exactly-once per-attempt seam.** Usage is debited (`:508`) before the outcome is decided (`:522-573`); judged ensures debit again (`:1845`); the success record is pushed then possibly popped (`:564-573`); failures are pushed inside `failAttempt`; judged `set` and fanout have their own paths (`:1045`, `:1756`). Per-attempt aggregation would have to own a seam the engine does not have.
7. **Epoch does not identify subflow incarnations.** A root revise deletes `state.sub`; recreated children restart at `epoch` undefined (`:1109`, `:1990-1993`).
8. **Wire contracts are frozen JSON, not TS.** `contracts.ts` loads `mcp-surface.json` and `events.json` and rejects undeclared request keys and event kinds; a new field or event type that is not declared there is refused before the engine sees it, and breaks every audit/poll response.

**Design consequence.** One primitive, keyed by the *dispatch*, not the step: **`usage_report`**. A receipt is an accounting fact independent of whether the step succeeded, failed, was revised, or ever reported. It is idempotent on a client-chosen dispatch id, so crashy paths can retry. It debits the ledgers and appends one `usage_debit` event, and both the receipt spine and cumulative spend are declared **revert-immune**. Compose emits it from the one hook every dispatch already hits. Everything per-attempt, per-model, or per-step is a derived view a later harvester computes from complete inputs.

## 3. Architecture (v1)

```
compose: context.recordBuildUsage(usage, {dispatchId, stepId?, source}) ──▶ stratum_usage_report   (S0-compose)
                                                                                  │
engine.usageReport(runId, receipt) ── idempotent on (runId, dispatchId) ──▶ debit() ──▶ events[]: usage_debit   (S0-eng)
engine.resetFrom() ──▶ events[]: step_reset          engine.revertCheckpoint() ──▶ receipts carried, checkpoint_reverted  (S0b)
                                                                                  │
engine: same site ──▶ learn outbox (queue-before-send, receipt_id) ──▶ SmartMemory POST /memory/add   (S1b, egress only)
```

**SmartMemory is a sink, never a source.** Nothing in stratum reads it back. The STRAT-TS-LEARN §5.1 tripwire is untouched because no authoring exists in this feature. **No classifier, no candidates, no apply in v1** (§7).

### 3.0 S0-eng — `usage_report`: a receipt per model call (stratum)

**Receipt:**

```ts
interface UsageReceipt {
  dispatchId: string;                 // client-unique per model call; idempotency key with runId
  stepId?: string;                    // scoped step id the call was made on behalf of; absent = run-level
  source: string;                     // "main" | "fixer" | "gate_fixer" | "gate_qa" | "escalation" | "consumer" | "judged" | …
  usage: Budget;                      // tokens, usd?, ms? — never dispatches (engine-accounted, rejected like stepDone :520)
  telemetry: { model: string; effort?: string; durationMs: number };
  split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };  // informational, never debited
  usdSource?: "reported" | "estimated";   // required when usage.usd is present; engine-internal legacy receipts carry "legacy" (provenance unknown) and callers may not send it
  at?: string;                        // dispatcher's completion time; engine stamps receipt time separately
}
```

**Engine semantics** (`engine.usageReport(runId, receipt)`, under `withRunLock`, no dispatch token — it is an accounting write, not a step outcome; requires only that the run exists):

- **Receipt spine.** Accepted receipts are appended to a new `PersistedRun.receipts: ReceiptRecord[]` — `{ seq, dispatchId, stepId?, source, amount, telemetry, split?, usdSource?, reportedAt, at, egress: "pending" | "sent" | "dead" }` — where `seq` is drawn from the existing run-global `generationCounter` (`engine.ts:2370`), which checkpoints never roll back (`checkpoint.ts:23`). `receipts` is **excluded from `CHECKPOINT_FIELDS`**: it is the append-only source of record; `events` and `steps[].spent` remain derived/live views that a revert may legitimately restore.
- **Idempotent.** `(runId, dispatchId)` present in `receipts` → no ledger change, no event, response `{ status: "duplicate", seq }`.
- **Any run status, no transition on terminal runs.** A receipt on a `completed`/`failed`/`budget_exhausted` run is recorded and debited but **never** calls `terminalBudget` (which unconditionally rewrites status, `engine.ts:2463`); it returns `{ status: "ok", budget: "flow_exhausted_after_terminal" }` when the flow limit is crossed. Only a receipt on a *running* run may terminalize.
- **Step attribution.** With `stepId` (scoped) naming an *executable* step, the receipt debits flow + subflow + task ledgers via `debit(…, "settle")` exactly as `stepDone` usage does. With `stepId` naming a **gate** step, or with no `stepId`, it debits the **flow (and enclosing subflow) ledger only** — gates never reserve (`engine.ts:1059`), so a task ledger on a gate has no enforcement point; charging gates flow-only is the honest rule (round-4 #4). An unknown `stepId` is a contract error (`invalid_step`), never silently run-level.
- **Budget exhaustion on settle.** Over-limit usage is still recorded (resources are consumed). On a running run, flow-level exhaustion → `terminalBudget` (same path as `:509`); task/subflow-level → recorded, `{ status: "ok", budget: "task_exhausted" | "subflow_exhausted" }`, and the *next reserve* on that executable step refuses as today (`:1208-1216`). A receipt never fails an attempt. Compose's gate Q&A loop (`build.js:1866`) reads `budget` on the response and refuses the next gate dispatch once the **flow** is exhausted (the only ledger a gate can exhaust).
- **Validation:** `usage` per `validUsage`; `telemetry` per `validConnectorTelemetry`; `usd` present ⇒ `usdSource` present; `dispatches` key ⇒ contract error.
- **Event:** exactly one `usage_debit` per accepted receipt (§3.0b), carrying `seq`.

**`stepDone` and `gateResolve` are unchanged.** `stepDone`'s existing `usage` continues to work and is routed through the same internal path with a synthetic `dispatchId = "legacy:<seq>"` (`seq` from `generationCounter`, so a step re-run after a checkpoint revert never collides with the receipt it superseded — round-4 #5) and `source: "step_done"`, `telemetry.model = "unknown"` when the caller sent none (`StepResult.telemetry` is optional, `engine.ts:124`; the per-model invariant is "every receipt has a `model` field", not "every model is known" — round-4 #9). The judged-ensure debit (`:1845`) and fanout settle (`:1676`) route through it likewise (`source: "judged"` / `"fanout"`), so **every ledger debit with cost keys has a receipt** — the invariant the golden test checks.

**One owner per model call (round-4 #1).** Compose's consumer-fanout path today reports the same usage twice — `context.onUsage` (`build.js:1013`) *and* the `stepDone` envelope (`:1041`). On a stratum whose surface advertises `stratum_usage_report`, compose emits receipts and **omits `usage` from every `stepDone`/fanout envelope**; on an older surface it keeps today's envelope behavior and emits no receipts. Feature-detected once per run from the surface, never mixed. The engine does not try to dedupe across the two channels.

**Server-dispatched calls need no client receipt.** Agents the engine itself dispatches (`stratum_agent_run`, parallel fan-out workers) return usage to the engine; the engine records their receipts itself with `source: "server_dispatch"`. Only client-side dispatches depend on the compose funnel.

**MCP + contracts:** new tool `stratum_usage_report` `{ runId, receipt }` → `{ status: "ok" | "duplicate", budget?: string, ledger }`; declared in `mcp-surface.json` (`surface` 14 → 15); frozen-contract tests updated. Compose's `stratum-mcp-client.js` gains `usageReport()`.

### 3.0b S0b — `usage_debit`, `step_reset`, and revert immunity (stratum)

**`usage_debit`** (declared in `events.json`, `events` 1 → 2):

```ts
{ type: "usage_debit", stepId?: <scoped>,
  detail: { dispatchId, source, amount: Budget, epoch?: number, attempt?: number,
            item?: { itemIndex, stage, generation }, model, effort?, durationMs,
            split?, usdSource?, reportedAt?: string } }
```

`epoch`/`attempt`/`item` are copied from the target step state at debit time when `stepId` is present. `stepId` is the scoped id (`this.scopedId`), so subflow children are distinguishable (finding 7 handled by `step_reset` below, not by identity). The existing `fanout_ledger_debit` event stays exactly as is.

**`step_reset`** — emitted by `resetFrom` (`:1955`) after the descendant set is computed, before states are cleared:

```ts
{ type: "step_reset", stepId: <target scoped id>,
  detail: { reason: "revise", reset: [{ stepId: <scoped>, fromEpoch, toEpoch }], subflowsDropped: string[] } }
```

Supersession is a stream fact: every `usage_debit` for a listed `stepId` (or any scoped id under a dropped subflow prefix) that precedes the `step_reset` is superseded.

**Revert immunity** (finding 5). The receipt spine (`run.receipts`) is not a checkpoint field, so `revertCheckpoint` (`checkpoint.ts:44`) cannot touch it; no positional slicing of `events` is needed (the snapshot is *not* a prefix once a run has reverted between retained labels — round-4 #5). After restoring the snapshot, revert:
1. sets `flowSpent = Σ receipts[].amount` — recomputed from the spine, never carried from either side (cumulative actual spend; ledger *limits* are unaffected — a flow that was over budget stays over budget after revert, which is correct: the money is gone);
2. appends `{ type: "checkpoint_reverted", detail: { label, receiptsAtRevert: seq, stepsRestored: string[] } }` so a harvester can tell which receipts predate the restored state.
`steps[].spent` and `events` are restored from the snapshot as today — they are live/derived views; only the spine is money-shaped. `checkpoint.ts` enters the slice with golden coverage: checkpoint → receipt → revert → receipt still in `receipts`, `flowSpent` equals the spine sum, `checkpoint_reverted` present, re-running the step produces a *new* receipt (not `duplicate`).

### 3.0c S0-compose — every dispatch emits a receipt (compose)

- **One hook, not seven sites.** `context.recordBuildUsage(usage, meta)` (`build.js:2934`) gains an optional `meta = { dispatchId, stepId?, source }` and, when a stratum run is active, also calls `stratum.usageReport(runId, receipt)`. The 20 existing call sites pass `meta`; a call site that cannot name a step passes none (run-level). The local accumulator behavior is unchanged.
- **Per-dispatch, not per-fold.** The normalizer stops being the place dispatches merge: `runAndNormalize` returns `usages: UsageRecord[]` (one per underlying model call, with `model`, `effort`, `duration_ms`, split counts, `cost_usd?`, `usd_source?`) alongside the existing merged `usage`; `mergeUsage` callers (`:3528-3563`) report each entry before merging. `runAgentText` **keeps its string return** (callers pass the text straight to `normalizeReviewResult`) and gains `opts.onUsage(usages)`; the bug-escalation tiers (`compose/lib/bug-escalation.js:119`, `:316`) pass it (round-4 #2).
- **Dollars are labelled, never invented.** `usd_source: "reported"` only when the *provider* returned a price. The Codex connector returns tokens and ms but no USD (`stratum/ts/src/connectors/codex.ts:225`) and its narration hardcodes `cost_usd: 0` (`:363`) — that zero is not a reported price and is never sent. Claude's `calculateCost` figure (`result-normalizer.js:445`) is sent as `"estimated"`. No price → no `usd` key. (Round-4 #8.)
- **Producer durability is best-effort, and says so.** The receipt is sent from the funnel *before* the owning `stepDone` (ordering fix at `build.js:3755`/`:3871`), and hook failures are logged rather than swallowed (`:3503`). A crash between the model returning and the receipt being acknowledged **loses that receipt**; there is no producer-side outbox in v1 (a compose-side WAL keyed by `(runId, dispatchId)` is a follow-up, filed). The census gate (Σ receipts == `flowSpent` == accumulator) measures the loss rate rather than assuming zero; server-dispatched calls are exempt because the engine records them itself. (Round-4 #3.)
- **Crash paths.** A fixer/gate-fixer that throws (`:3377-3407`, `:4186-4208`): the `catch` already calls `recordBuildUsage(err.usage)` — with `meta` that now emits the receipt before the rethrow. Consumer stuck/abort (`:970-979`): same. Nothing new to remember at each site; the funnel does it.
- **`dispatchId`** = `randomUUID()` minted where the dispatch is made and carried on the result/error object; a retry of a *failed transport* reuses the id (idempotent), a retry that makes a *new model call* mints a new one.
- **Acceptance is the census:** after one real `/compose build`, `Σ usage_debit.amount.tokens == flowSpent.tokens` for that run **and** `Σ usage_debit.amount.tokens == compose's build accumulator tokens_total` (the two books agree), and every `usage_debit` has `model`.

### 3.1b S1b — Mirror receipts to SmartMemory (egress)

**Not the policy channel.** `policy/smartmemory_client.ts` posts to `/memory/policy/events` (server accepts three enforcement kinds only, `smartmemory/policy/models.py:11`); it sends first and queues only on failure (`:84-100`); a rejected event stalls the drain (`:191`); the cap evicts oldest-first (`:296`). **The policy client, endpoint, and `~/.stratum/policy-outbox` are not touched.**

`learn/smartmemory_egress.ts` (new), mechanics *copied* from the policy client, with three deliberate differences:

- **The queue is the spine.** There is no separate outbox file. Each `ReceiptRecord` carries `egress: "pending" | "sent" | "dead"` inside the run file, so enqueue is atomic with the receipt by construction (`persist()` writes one file via `StateStore.save`, `engine.ts:2536`; a second file could never be committed atomically with it — round-4 #7). The drainer scans runs for `pending` rows on every engine start and after every persist (fire-and-forget `void … .catch` only for the *drain*, never for the enqueue) and flips them under the run lock. `step_reset`/`checkpoint_reverted` rows are mirrored from a small `egressEvents` list on the same spine.
- **At-least-once, stated plainly.** `/memory/add` creates a fresh item per call (`crud.py:577-590`); `receipt_id` is metadata, not a server idempotency key. A lost 2xx followed by a retry **creates a duplicate row**. v1 delivers at-least-once: rows carry `metadata.receipt_id = "<run_id>:<seq>"`, consumers dedupe on it, and `stratum learn egress verify --run <id>` measures missing/duplicate counts by `receipt_id` (exact `memory_type` filter + metadata search). A server-side idempotency/upsert on `/memory/add` is filed against SmartMemory as the follow-up that upgrades this to exactly-once; the acceptance criterion says "0 missing, duplicates reported", not "0 duplicates".
- **Dead-letter, not delete.** 5xx/network → backoff retry, row stays `pending`. 400/422 (bad row) and 401/403/404 (configuration) → `egress: "dead"` with the response status, counted, drain continues. `stratum learn egress retry-dead --run <id>` flips `dead` back to `pending` after configuration is fixed. Nothing is forgotten without a 2xx.

**Wire:** `POST /memory/add` `{ content, memory_type, metadata, use_pipeline: false }`, header `X-Workspace-Id: $SMARTMEMORY_WORKSPACE_ID` (the SmartMemory team id — not the compose project slug, `compose/lib/smartmemory-config.js:58-64`). `content` is a one-line summary; `metadata` carries the full event detail plus `run_id`, `workspace_root`, `flow_name`, `spec_digest`, `event_ordinal`, `receipt_id`, `origin: "cli:stratum"`. Types: `stratum_usage_debit`, `stratum_step_reset`, `stratum_checkpoint_reverted` — registered on the server via `SMARTMEMORY_EXTRA_MEMORY_TYPES=stratum_usage_debit:append:false,stratum_step_reset:append:false,stratum_checkpoint_reverted:append:false` (append, not searchable — telemetry rows, same reasoning as `snapshot`); documented in the stratum README. Unregistered deployment → 422 → dead-letter, never a retry storm.

**Explicit opt-in (revised at implementation review, 2026-08-30):** egress runs only when `STRATUM_LEARN_EGRESS=1` *and* `SMARTMEMORY_API_URL`/`API_KEY`/`WORKSPACE_ID` are all set. Default is OFF. Reason: the credentials are shared with the policy/enforcement channel, so "on with creds" would make a process configured only for enforcement start shipping receipts, and start background reconciliation in every engine construction, tests included. `X-Workspace-Id` is required; an unset workspace id refuses to enable rather than posting unscoped rows. Not in scope: any read path.

## 4. Slice plan

| Slice | Deliverable | Files | Gate |
|---|---|---|---|
| **S0-eng** | `usageReport` engine method (idempotent, any status, settle semantics), receipt spine `run.receipts` + `seq`, `stratum_usage_report` tool; `stepDone`/judged/fanout/server-dispatch debits routed through it | `stratum/ts/src/engine/engine.ts` (existing: new method; `:508`, `:1676`, `:1845` route through; server-dispatch settle), `stratum/ts/src/engine/state.ts` (existing: `PersistedRun.receipts`), `stratum/ts/src/engine/checkpoint.ts` (existing: `receipts` in the non-checkpoint map `:20-32`), `stratum/ts/src/mcp/server.ts` (existing), `stratum/ts/contracts/mcp-surface.json` (existing, surface 15), `stratum/ts/tests/contracts/*` (existing, frozen-contract tests) | contract tests; golden: every cost debit has exactly one `usage_debit`; duplicate receipt → no-op |
| **S0b** | `usage_debit` + `step_reset` + `checkpoint_reverted` events; revert immunity | `stratum/ts/src/engine/engine.ts` (existing: `resetFrom :1955`), `stratum/ts/src/engine/checkpoint.ts` (existing: `revertCheckpoint :44`), `stratum/ts/src/engine/state.ts` (existing: `AuditEvent.type :157`), `stratum/ts/contracts/events.json` (existing, events 2) | golden on the real engine: revise → prior-epoch receipts retained + `step_reset`; checkpoint → receipt → revert → receipt retained, `flowSpent` includes it |
| **S0-compose** | `recordBuildUsage` meta + `usageReport`; surface-detected envelope-vs-receipt owner; per-dispatch `usages[]` from the normalizer; `runAgentText` `onUsage`; `usd_source` labels; `dispatchId` minting; receipt-before-`stepDone` ordering | `compose/lib/build.js` (existing: `:2934`, all 20 `recordBuildUsage` sites, `:1013`/`:1041`, `:1866`, `:3528-3563`, `:3755`, `:3871`), `compose/lib/result-normalizer.js` (existing: `:264-274`, `:432-445`, `:642-681`), `compose/lib/stratum-mcp-client.js` (existing: `:217`, `:692`), `compose/lib/bug-escalation.js` (existing: `:119`, `:316`), `compose/lib/gsd.js` (existing) | **census:** Σ receipts == `flowSpent` == compose accumulator for one real build |
| **S1b** | egress drainer over the spine, dead-letter, `receipt_id`, `learn egress verify|retry-dead`; README registration note | `stratum/ts/src/learn/smartmemory_egress.ts` (new), `stratum/ts/src/engine/engine.ts` (existing: drain trigger after `persist`), `stratum/ts/src/cli/learn.ts` (existing), `stratum/README.md` (existing) | golden against a real SmartMemory backend: rows land with `receipt_id`; 422 → `dead`; verify reports 0 missing, duplicates counted |

Order: S0-eng → S0b → S1b (all stratum, one release) → S0-compose (compose repo, against that stratum release). S0-compose is the only cross-repo edge and it is additive (compose keeps working against an older stratum by feature-detecting the tool in the surface).

## 5. Acceptance criteria

- [ ] S0-eng: `usage_report` with a repeated `(runId, dispatchId)` returns `duplicate`, changes no ledger, appends no event
- [ ] S0-eng: receipt on a terminal run is accepted, debited, spine-appended, and leaves `run.status` unchanged (`budget: "flow_exhausted_after_terminal"` when over); receipt with `dispatches` or unknown `stepId` is a contract error; `usd` without `usdSource` is a contract error
- [ ] S0-eng: on a running run, flow-level exhaustion via receipt → `terminalBudget`; task-level → recorded, `budget: "task_exhausted"`, next reserve on that step refuses; a receipt on a gate step debits flow only
- [ ] S0-eng: `run.receipts` is absent from `CHECKPOINT_FIELDS`; legacy `stepDone` usage without telemetry yields a receipt with `model: "unknown"`
- [ ] S0-eng: legacy `stepDone` usage, judged-ensure debit, and fanout settle each produce exactly one `usage_debit` with the documented `source`; golden invariant "every cost debit has a receipt" holds across the engine suite
- [ ] S0-eng/S0b: `mcp-surface.json` and `events.json` bumped; frozen-contract tests updated; undeclared-key tests still pass
- [ ] S0b: `resetFrom` emits one `step_reset` naming every reset step with from/to epochs and every dropped subflow; prior `usage_debit`s untouched
- [ ] S0b: checkpoint → receipt → revert: receipt present in `run.receipts`, `flowSpent` == Σ spine, `checkpoint_reverted` appended, `steps[].spent` restored from snapshot, re-running the step yields a new receipt (not `duplicate`)
- [ ] S0-compose: after one real `/compose build`, Σ `usage_debit.amount.tokens` == `flowSpent.tokens` == build accumulator `tokens_total`; every `usage_debit` has `model`
- [ ] S0-compose: gate Q&A, review-gate fixer, post-`stepDone` escalation, and a fixer that throws each produce a receipt (one fixture per path)
- [ ] S0-compose: a dispatch that reports no usage produces no receipt; Claude receipts carry `usd` + `usdSource: "estimated"`; Codex receipts carry **no `usd` key**
- [ ] S0-compose: on a surface-15 stratum, no `stepDone`/fanout envelope carries `usage` (one owner); on surface 14 no receipts are sent and envelopes are unchanged
- [ ] S0-compose: bug-escalation tier 1 and tier 2 produce receipts; gate Q&A stops dispatching after `budget: "flow_exhausted"`
- [ ] S0-compose: compose against a stratum without `stratum_usage_report` in its surface → no receipt calls, no errors
- [ ] S1b: a receipt is `egress: "pending"` in the run file the moment `usage_report` returns, before any network call; policy outbox dir receives no learn traffic; policy tests unchanged
- [ ] S1b: 422 and 403 → `egress: "dead"` with status, drain continues; 503 → stays `pending`, retried with backoff; 2xx → `sent`; `retry-dead` flips `dead` → `pending`
- [ ] S1b: `learn egress verify --run` reports 0 missing after a drain against a real backend; a forced double-send is reported as 1 duplicate by `receipt_id` (at-least-once is the stated guarantee)
- [ ] S1b: `STRATUM_LEARN_EGRESS` unset/`0`, or any of URL/key/workspace unset → no fetch, no row transition
- [ ] `git diff --stat stratum/ts/src/learn/{harvest,classify,candidate,apply}.ts stratum/ts/src/policy/` empty at merge

## 6. Open questions for the gate

1. Should `usage_report` require *any* authorization? Today `stepDone` needs a dispatch token because it decides an outcome; a receipt only spends budget, and refusing receipts would hide cost. Recommendation: none beyond run existence; a hostile client can already exhaust a budget by making the calls.
2. `stepId` on a receipt is *scoped*; compose knows only the plain step id for root steps. Recommendation: accept a plain id when it resolves uniquely at root scope, require scoped ids only for subflow children (the engine already has `scopedId`).
3. ~~Claude pricing~~ **Decided:** send compose's estimate, labelled `estimated`.
4. ~~`flowSpent` vs step `spent` gap~~ **Resolved:** `resetFrom`; §2 finding 4.
5. ~~Egress default~~ **Decided, then reversed 2026-08-30:** explicit opt-in `STRATUM_LEARN_EGRESS=1`, default OFF (§3.1b). Shared credentials with the policy channel made "on with creds" unsafe.
6. ~~Extract the policy outbox~~ **Decided:** copy, don't refactor; dedup follow-up filed.
7. ~~Carrier~~ **Decided at round 3:** receipt-per-call primitive; `stepDone`/`gateResolve` unchanged.
8. **Decided at round 4 (guarantees, explicitly weaker than round 3 claimed):** producer → engine is best-effort with a measured loss rate (no compose WAL in v1); engine → SmartMemory is at-least-once with consumer dedupe on `receipt_id` (server upsert is a SmartMemory follow-up); gates are charged flow-only; late receipts on terminal runs never change status. Each is a scope choice a reviewer can disagree with, not a claim the code contradicts.

## 7. Parked: the classifier (STRAT-LEARN-COST-2)

Preserved from rounds 1–2 so the follow-up does not re-derive it:

- Harvest from `usage_debit` + `step_reset` + `checkpoint_reverted` only, never from `steps[].spent`/`attempts[]`. Pre-S0 runs are unusable for ordinary steps; `fanout_ledger_debit` sequences would need pairing to `fanout_attempt_result` by order.
- Identity: unique key `(runId, dispatchId)`; series key for retry pairing `(runId, scopedStepId, item?)` excluding attempt; supersession from `step_reset`, never from epoch comparison alone.
- Per-model baselines are computable because each receipt carries its own `model`; tokens are the primary metric; `usd` aggregates separate `reported` from `estimated` and exclude missing, never coerce to 0.
- Shapes: `retry-waste` (Σ superseded + failed-then-succeeded per series, ≥ `minRuns`/`minPairs`) and `outlier` (> k× per-model median across ≥ 2 runs). `model-mismatch` cut.
- Join to failure clusters by evidence intersection on `(runId, stepId)`; links may resolve to clusters with no staged revision.
- Candidates surface-only; the apply path is typed on `FailureRecord[]` (`apply.ts:8/113/225`) and is STRAT-TS-LEARN's unexercised half.
- Thresholds cannot be fitted until S0 has produced real priced runs. Gate for filing: one month of receipts, or ≥ 20 real `build` runs with census parity.
