# STRAT-USAGE-SPLIT — Progress

## 2026-09-01 — core wiring shipped (same day as filing)

Implemented across both repos on branch `strat-usage-split`:

**stratum**: `ConnectorResult.split?` + `ConnectorSplit` (base.ts); Claude
connector returns split incl. cache detail; both Codex paths return split;
background scanner accumulates + returns split and the bg Claude worker
forwards cache fields on `turn.completed`; engine threads split alongside
`usdSource` (StepResult → fanout wrap → settleLegacyReceipt → buildReceipt);
`stratum_agent_run`/`stratum_agent_poll` complete responses declare `split?`;
surface 15 → 16.

**compose**: D2(b) fold adopts `runResult.split` (result-normalizer.js);
`usageRecordFromRaw` accepts/prefers a split; `runAgentText` usage records
prefer the envelope split. Receipt construction in build.js already read
`input_tokens`/`output_tokens` from these records, so `ReceiptRecord.split`
now receives real values with no change there.

Regression tests: claude connector asserts the returned split; compose
normalizer pins the exact anomaly scenario (436,736-token heavily-cached call
→ input 430k/cacheRead 400k, NOT `in=0, out=436736`) plus the legacy
split-less fallback.

## Acceptance criteria status

- [x] ConnectorResult carries split beside usage
- [x] claude.ts populates it (with cache detail)
- [x] codex.ts populates it at both return sites — **usd deferred**: neither
  codex path parses a price today; adding one is estimation work
  (`judge/pricing.ts`), split out rather than bundled here
- [x] buildReceipt call sites pass split (via settleLegacyReceipt threading;
  the engine-synthesized receipts at :753/:2230 have `usage: {}` and no split
  by construction)
- [x] result-normalizer.js:664 stops filing the aggregate as output when a
  split is present
- [x] stratum-mcp-client.js reads the split
- [ ] **DEFERRED — schema unmeasured-vs-zero**: `build-stream-schema.js`
  still requires numeric input/output. After split propagation the
  unmeasured case is only reachable from pre-surface-16 envelopes; a
  number|null schema change has consumer blast radius disproportionate to
  that residue. Revisit if legacy envelopes persist.
- [x] Golden regression tests (connector-level + normalizer-level; a full
  live-dispatch golden awaits the next real flow run)
- [ ] **RUNTIME — ±1% reconciliation**: a check against provider-billed
  dollars needs accumulated post-fix receipts; run after the first real flows.

## The $0.70 / 436,736 anomaly — explained

`usd` is provider-reported (`total_cost_usd`, `usdSource: "reported"`),
computed independently of the token columns; the token columns were the
aggregate filed as output. The $0.70 row was a heavily cache-read call
(cached input bills at 0.1×), the $4.36/25,638 row genuinely output-heavy.
Columns were never commensurable; post-fix they are.

## 2026-09-22 — verified in production, closed

The branch merged as `56529e2` (PR #28); Codex dollars followed in `9e6363a` /
`00ff4db` (`codexUsageFields`: estimated via `usdFromTokens`, labelled
`estimated`, never `reported`). Compose adopted the split on dispatch rows in
`e849aa1` (COMP-COST-OWNER).

**Live-dispatch golden (real data, not a fixture):** flow `14550460` (compose
build `7ae2118b`, BUG-27, 2026-09-19) — five `claude-sonnet-5` agent receipts,
every one carrying `split.input/output/cacheRead/cacheCreation`, e.g. the
`diagnose` step: input 30,465 / output 38,265 / cacheRead 9,657,548 /
cacheCreation 177,148, usd 4.6255 `reported`. Compose's build-history row for
the same build reads input 138,108 / output 69,093 / cache_read 17,865,690 —
non-zero input where every pre-fix row read 0. Dispatch-ledger rows since
2026-09-14: 23, `tokens_in` null on 0.

**Reconciliation:** sum of the five receipts' `usd` = 11.453682; compose's
`build-actuals` row for the build = 11.453682. Deviation 0.0% (criterion was
±1%). Caveat: both sides derive from the same provider-reported
`total_cost_usd`, so this checks the pipeline loses nothing, not the provider's
bill — there is no per-call billing surface to check against.

**Schema unmeasured-vs-zero — stays DEFERRED, residue named:** dispatch
`a31aac4a` (step `test`, outcome `error`, run cancelled before the step ran)
was recorded `tokens_in: 0, tokens_out: 0, usd: null`. Cause is the Claude
connector's error path (`claude.ts:229`), which attaches
`split: { input: 0, output: 0 }` even when no usage event was ever received —
the success path omits nothing it doesn't have, the failure path doesn't
distinguish. Filed as a follow-up (see roadmap, child of this ticket) rather
than bundled: it is a connector fix plus a compose consumer decision, not
split wiring.

Acceptance: all wiring, golden and reconciliation criteria met; the schema
criterion is superseded by the follow-up. Status → COMPLETE.
