# STRAT-LEARN-COST — Implementation Plan

## Context

Stratum's learn loop (STRAT-TS-LEARN) learns from failures and nothing else. A four-round design gate established that it *cannot* learn from cost yet because the cost data does not exist: 0 of 1,541 ordinary step attempts in the corpus carry usage, compose bills model calls the engine never sees, a gate revise wipes step ledgers, and a checkpoint revert rewrites the event stream. This feature is the data half: **one idempotent receipt per model call** (`stratum_usage_report`), persisted on a revert-immune spine, mirrored to SmartMemory. The classifier is parked (design §7) until a month of receipts exists.

Design: `stratum/docs/features/STRAT-LEARN-COST/design.md` (approved, `25b5cbe`). Blueprint with corrections table + validated Boundary Map: `.../blueprint.md` (`93c025d`). This plan orders the blueprint's slices into tasks; file:line refs live in the blueprint and are not repeated here.

## Ordering and dependencies

```
S01 receipt spine + usage_report ──▶ S02 step_reset + revert immunity ──▶ S03 egress ──▶ S04 README/design corrections
        │
        └──────────────────────────────────────────────────────────────────▶ S05 compose producer (compose repo; needs S01 on the stratum it talks to)
```

S01–S04 land in `stratum` as one feature branch of commits on `main` (per project convention: commit direct to main). S05 lands in `compose` after the stratum side is on the machine.

## Tasks

### T1 — S01: types, exclusion, receipt builder (stratum)
- `ts/src/engine/state.ts`: `ReceiptRecord`, `PersistedRun.receipts?`, `PersistedRun.receiptCounter?`, `AuditEvent.type` += 3 kinds.
- `ts/src/engine/checkpoint.ts`: add both fields to `CHECKPOINT_EXCLUDED` (the `satisfies` clause fails compile until done — that is the first red test).
- `ts/src/engine/ledger.ts`: move `validConnectorTelemetry` here and export it (engine.ts re-imports).
- `ts/src/engine/receipts.ts` (new): `buildReceipt`, `findReceipt`, `spineSpent`.
- Tests first: `ts/tests/engine/receipts.test.ts` unit cases for the builder (duplicate detection, `dispatches` rejected, `usd` ⇒ `usdSource`, telemetry default `model:"unknown"`, seq monotonic).

### T2 — S01: engine method + legacy routing + contracts (stratum)
- `engine.ts`: `settleReceipt` (private) + `usageReport` (public, `withRunLock`); route the three legacy cost debits (`:508`, `:1676`, `:1845`) through `settleReceipt` with synthetic `legacy:<seq>` ids. Gate/no-step receipts debit flow(+subflow) only. Terminal runs: record, never `terminalBudget`.
- `mcp/server.ts`: `stratum_usage_report` case + `ToolName`.
- `contracts/mcp-surface.json` → surface 15; `contracts/events.json` → events 2.
- Tests: golden in `receipts.test.ts` — every legacy path yields exactly one `usage_debit`; **invariant** over the engine suite's runs: Σ `usage_debit.amount` == `flowSpent` absent reverts; contract-grammar fixtures updated (`tests/mcp/contracts-grammar.test.ts`, `schema-grammar.test.ts`).

### T3 — S02: `step_reset` + revert immunity (stratum)
- `resetFrom` emits `step_reset` between its two loops (needs a scope prefix from the caller at `:788`).
- Revert path: `flowSpent = spineSpent(run)`, `checkpoint_reverted` event + engine-source spine row.
- Tests: `ts/tests/engine/checkpoint-receipts.test.ts` — the two goldens from the blueprint (revise retains prior-epoch receipts; checkpoint→receipt→revert→receipt survives, re-run yields new seq).

### T4 — S03: SmartMemory egress (stratum)
- `ts/src/learn/smartmemory_egress.ts` (new): `LearnEgress` — drain over `pending` spine rows under the engine's run lock (`engine.withReceiptUpdate`), `/memory/add` body + `X-Workspace-Id`, 2xx→sent, 4xx-class→dead, else backoff. Startup reconciliation scan. Kill switch `STRATUM_LEARN_EGRESS=0`.
- `engine.ts`: drain trigger after `persist` (fire-and-forget for the drain only).
- `ts/src/cli/learn.ts`: `egress drain|verify|retry-dead`.
- Tests: `ts/tests/learn/egress.test.ts` — fake-fetch state machine; real-backend golden gated on `SMARTMEMORY_API_URL/KEY` (skips cleanly without).
- **Before any run of this suite:** confirm the shell env has no live SmartMemory creds unless the golden is intended to hit the real backend (test-run-discipline rule).

### T5 — S04: docs (stratum)
- `README.md` SmartMemory section (type registration env line, kill switch); fold blueprint corrections C1–C9 into `design.md` §3.0/§3.1b (minimal edits); `CHANGELOG.md` entry in the same commit as the last code change.

### T6 — S05: compose producer (compose repo)
- `lib/stratum-mcp-client.js`: `hasTool` (SDK `listTools`, cached), `usageReport`, `runAgentText({ onUsage })` (string return preserved).
- `lib/result-normalizer.js`: `usages[]` per dispatch with `usd_source`; repair dispatch as its own entry.
- `lib/build.js`: `receiptsMode` at run start; `recordBuildUsage(usage, meta)` reports every entry; `meta` at all sites; envelope `usage` omitted in receipts mode; usage fold moved above the main `stepDone`; gate Q&A latches flow exhaustion.
- `lib/gsd.js`: same for `recordTsAgentUsage` + `ordinaryUsage`.
- `lib/bug-escalation.js`: `onUsage` on both tiers.
- Tests: `test/usage-receipts.test.js` (fake stratum client) — one case per design §5 S0-compose criterion incl. surface-14 fallback; `scripts/cost-census.mjs`.
- `CHANGELOG.md` in compose, same commit.

## Dispatch (per subagent-model-routing)

Every slice is brief-bounded (locked design, verified file:line, test gate) — the Sonnet/Codex sweet spot. Standing directive: delegated work → Codex. Proposal:
- T1–T4, T6: **Codex `gpt-5.6-sol/high`** implementer, one dispatch per task, sequential (each depends on the previous); I (main session) adjudicate, run the targeted tests locally, and commit (Codex cannot commit).
- Review loop per task: **Codex** adversarial review of the diff until `REVIEW CLEAN` (cap 3 rounds; round 2 targets round-1 fixes).
- Full suite once at the end of the stratum side (807+ tests), once at the end of compose. Never `| tail` — redirect to a file, echo `$?`.
- T5 (docs): main session.

## Verification (Phase 7 exit)

1. Targeted suites green per task; full `stratum/ts` suite green once; full compose suite green once.
2. **Census gate** (design §5): one real `/compose build` against the new stratum → `scripts/cost-census.mjs` reports Σ `usage_debit.amount.tokens` == `flowSpent.tokens` == compose accumulator `tokens_total`, every receipt has `model`.
3. Egress golden against the real SmartMemory backend: `stratum learn egress verify --run <id>` → 0 missing; forced double-send → 1 duplicate reported.
4. Codex review `REVIEW CLEAN` on the final stratum diff and the final compose diff.
5. `git diff --stat ts/src/learn/{harvest,classify,candidate,apply}.ts ts/src/policy/` empty.

## Out of scope (parked, design §7 / §6)
Classifier and cost notes; compose-side receipt WAL; SmartMemory `/memory/add` upsert; policy-outbox extraction.
