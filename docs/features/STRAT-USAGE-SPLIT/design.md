# STRAT-USAGE-SPLIT — Design

**Status:** PLANNED (filed 2026-09-01) · **Owner:** stratum + compose · **Priority:** HIGH — blocks `STRAT-LEARN-COST` §7 (the cost classifier) and every context-cost measurement downstream · **Surfaced by:** `STRAT-LEARN-COST`

## Related Documents

- Surfaced by: `../STRAT-LEARN-COST/design.md` — its §2 census first recorded this gap ("top-level `steps[id].attempts[].usage`: **0** of 1,541 attempts"); its §7 classifier is gated on the data this ticket unblocks.
- Budget mechanism: `../STRAT-WORKFLOW-BUDGET/design.md`, `../STRAT-WORKFLOW-BUDGET-DOLLARS/design.md` (`ts/src/engine/ledger.ts`)
- Receipt primitive this populates: `ts/src/engine/receipts.ts` (`ReceiptRecord.split`)
- Roadmap row: `docs/plans/COMPOSE-ROADMAP.md` → Standalone Tickets → STRAT-USAGE-SPLIT
- Consumer outside forge: `~/reg/my/strategy/llm_gateway_evaluation_2026-09-01.md` → `MOPS-CTX-1` Phase A. That evaluation cannot answer "is agent cost dominated by context volume or model choice?" while input tokens read zero.

---

## 1. Problem

**Every input token in the system is recorded as an output token.**

Observed across both build histories (`.compose/data/build-history.jsonl`, compose and stratum):

```
COMP-GUARD-CLAIM-1      in=0  out=436736  usd=0.697
COMP-GUARD-CLAIM-1      in=0  out=25638   usd=4.356
STRAT-AGENT-BG-WRITE-1  in=0  out=243712  usd=14.215
```

`input_tokens = 0` on **every row**, while `output_tokens` and `cost_usd` are populated. In the 40 most recent flows under `~/.stratum/ts/flows` (858 total), only aggregate `tokens` and `usd` are ever non-zero — no input/output split and no cache fields appear at all.

Two consequences:

1. **The cost columns are not commensurable.** `usd` derives from `total_cost_usd` (provider-reported, `usdSource: "reported"`), computed independently of the token columns. So dollars are right while tokens are mislabeled. The $0.70/436,736 row is a heavily cache-read call whose real input was cheap cached tokens; the $4.36/25,638 row is genuinely output-heavy. Codex dispatches contribute tokens at $0 (see §2.3), mixing two provenances in one column. Any per-token analysis over this data is invalid.
2. **The `STRAT-LEARN-COST` §7 classifier cannot be built.** Its planned categories — retry-waste, outlier, **model-mismatch** — all require knowing how much of a call was prompt versus generation. That signal does not currently survive to storage.

## 2. Root cause — four links, traced 2026-09-01

### 2.1 The origin constraint is deliberate

`ts/src/engine/ledger.ts:3`

```ts
export const BUDGET_KEYS = ["usd", "tokens", "dispatches", "ms"] as const;
export type Budget = Partial<Record<BudgetKey, number | undefined>>;
```

`Budget` admits four scalars and has no slot for a split. This is correct for its job — it is a *limit* type, and limits are enforced on totals. The defect is not here; it is that no other channel carried the detail.

### 2.2 The connector reads the split correctly, then discards it

`ts/src/connectors/claude.ts:115-124` reads all four fields from the SDK and emits them:

```ts
if (isRecord(raw.usage)) {
  inputTokens  = finiteNonnegative(raw.usage.input_tokens);
  outputTokens = finiteNonnegative(raw.usage.output_tokens);
  await this.emit({ kind: "step_usage", metadata: {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: finiteNonnegative(raw.usage.cache_creation_input_tokens),
    cache_read_input_tokens:     finiteNonnegative(raw.usage.cache_read_input_tokens),
    model: requestedModel,
  }});
}
```

**The data exists at source.** But the returned `usage` must satisfy `Budget`, so `:135` collapses it:

```ts
usage: { ...(costUsd > 0 ? { usd: costUsd } : {}), tokens: inputTokens + outputTokens, ms: durationMs },
```

### 2.3 Codex does the same, and reports no dollars

`ts/src/connectors/codex.ts:227` and `:316`

```ts
usage: { tokens: inputTokens + outputTokens, ms: durationMs },
```

No `usd` key at all, so Codex dispatches land as tokens against $0.

### 2.4 Compose never receives the event, then files the aggregate as output

`compose/lib/result-normalizer.js:655-658` (comment, verbatim):

> the TS agent_run path returns a synchronous `complete` envelope with aggregate usage (`{usd?, tokens, ms}`) and streams NO step_usage progress events

So the `step_usage` event carrying the split never reaches compose on the live TS route (only the retired python/factory-shim path streamed it). Then `:664`:

```js
if (typeof runUsage.tokens === 'number') usageTotals.output_tokens += runUsage.tokens;
```

The aggregate is added **directly to the output column**. `compose/lib/stratum-mcp-client.js:733-737` reconstructs identically (`input = usage.input_tokens ?? 0` → `0`; `output = usage.tokens - input` → everything).

## 3. Fix

**Do not widen `BUDGET_KEYS`.** It is a frozen contract surface, and widening it changes ledger limit semantics (a limit on `input` is not a thing the engine should enforce).

Use the receipt channel that already exists beside the ledger. `ts/src/engine/receipts.ts:10` already declares the exact shape:

```ts
split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
```

fully validated at `:84-90` — **and populated by no caller anywhere.** Verified 2026-09-01: every `buildReceipt` call site (`engine.ts:656`, `:753`, `:2170`, `:2230`) omits `split`; the only other occurrence, `:2152`, re-emits an already-present value. The field was built for precisely this and never wired.

### Acceptance criteria

- [ ] `ConnectorResult` carries the split beside `usage` (as `usdSource` already does), so it survives the `Budget` narrowing — `ts/src/connectors/base.ts` (existing)
- [ ] `claude.ts` populates it from the values already computed at `:116-124` — `ts/src/connectors/claude.ts` (existing)
- [ ] `codex.ts` populates it at both return sites (`:227`, `:316`), and reports `usd` + `usdSource` where the CLI provides a price — `ts/src/connectors/codex.ts` (existing)
- [ ] Every `buildReceipt` call site passes `split` when the connector supplied one — `ts/src/engine/engine.ts` (existing, 4 sites)
- [ ] `result-normalizer.js:664` stops filing the aggregate as output. Where no split is available, the aggregate is recorded as `tokens` with input/output left **null, not zero** — `compose/lib/result-normalizer.js` (existing)
- [ ] `stratum-mcp-client.js` reads the receipt split rather than reconstructing from `usage.tokens` — `compose/lib/stratum-mcp-client.js` (existing)
- [ ] `build-stream-schema.js` distinguishes "unmeasured" from "zero" for input tokens — `compose/lib/build-stream-schema.js` (existing)
- [ ] Golden flow: a real dispatch through the TS route persists non-zero `input`, and `cacheRead`/`cacheCreation` when the provider reports them — `ts/tests/` + `compose/test/` (new)
- [ ] Reconciliation check: summed receipt dollars match provider-reported `total_cost_usd` within ±1% over a run — (new)
- [ ] The $0.70/436,736 anomaly is explained in `progress.md` with the corrected split for that specific run

### Explicitly out of scope

- Backfill. Input tokens were never captured and cannot be reconstructed. The input-side series starts at the fix date; the existing ~858 flows stay valid for dollars, duration and output only.
- The `STRAT-LEARN-COST` §7 classifier. This ticket unblocks it; it does not build it.

## 4. Why this is prioritized

- It is **cheap**: the type, the validator, and the connector-side reads all exist. This is wiring, not construction.
- It **blocks a parked deliverable** (`STRAT-LEARN-COST` §7) that was correctly gated on "real data" — this is the reason that data is not real.
- **The clock is running.** Every day unfixed is another day of flows that cannot answer the context-cost question, and the gap cannot be backfilled.
- It **silently corrupts** an existing dashboard surface: anything reading `output_tokens` today is reading prompt volume mislabeled as generation.

## 5. Risk

Low. The change is additive on the stratum side (a new optional field on an existing validated shape) and corrective on the compose side. The one behavioural change is `result-normalizer.js:664` — consumers that today read `output_tokens` as "all tokens" will see it drop to true output. That is the point, but it will move existing charts, so land it with a note in `CHANGELOG.md`.
