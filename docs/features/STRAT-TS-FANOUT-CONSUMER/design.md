# STRAT-TS-FANOUT-CONSUMER — consumer-dispatched native fanout

**Status:** DRAFT — REVISED 2026-07-12 (metadata-boundary + fenced dispatch descriptor; supersedes the bare-`ReadyStep` / no-wire-change v1) · **Branch:** `ts-cutover` · **Epic:** STRAT-PY-RETIRE Phase 2

## Problem

The TS engine has one parallel primitive, native `fanout`, but currently executes every fanout item itself through its configured connector (`engine.ts:890-1253`). Compose needs the other ownership model already used for ordinary TS steps: Stratum schedules work, the client executes it, and the client reports the result.

The Python-era `parallel_dispatch` surface supplied that ownership model through four special tools and two lifecycles:

- consumer dispatch: compose created worktrees, ran agents, captured/applied diffs, then called `parallelDone` (`../compose/lib/build.js:4499-4918`);
- server dispatch: compose called start, polled task state, optionally merged returned diffs, then called advance (`../compose/lib/build.js:3693-4003`).

Porting those tools would duplicate a lifecycle that TS already expresses as `plan -> ready[] -> step_done`. This feature instead makes dispatch ownership a property of native fanout. It must preserve current engine dispatch as the default, retain per-item retry/ensure/require semantics, keep state restart-safe, and let compose continue to own worktrees and merges without teaching the engine about compose diffs.

## Metadata boundary (governs D2–D5; added 2026-07-12)

The producer owns **authoring intent** (the source spec it wrote). The engine owns the **effective run revision** and **every effective dispatch descriptor**. The earlier cut — "producer derives statically-declared metadata from its own local spec; engine surfaces only runtime-resolved state" — is too coarse: metadata can be statically declared yet impossible for a restart-safe or stateless consumer to *locate* (consumer-fanout stage cursors are the proof case, D2). Corrected rules for this feature:

1. `plan` returns an **immutable effective-run revision + digest** (engine applies defaults — e.g. `dispatch: "engine"` injection — so the persisted effective spec already differs from the submitted object; the digest is what the producer retains and, if it wishes, re-fetches). This makes the "compile boundary" real rather than assumed.
2. Every consumer-fanout `ready` entry is a **self-contained, token-fenced effective dispatch descriptor** (D2) — the contract for one authorized execution, not a spec mirror.
3. **Contract invariant:** every issued dispatch has a *fixed* effective output contract; it may originate at compile time or via a governed runtime plan revision, but **cannot change after issuance**. (This supersedes any "output contracts are always compile-time-fixed" phrasing, which needlessly blocks tool-discovery / planner-synthesised / heterogeneous-fanout workflows.)
4. Topology-preserving runtime decisions (model choice, cache hit, budget-admission) surface as **events / policy provenance**, not hidden state (consistent with the STRAT-TS-PORT observability contract). Topology- or contract-changing decisions require a **new explicit plan revision + authored→effective origin map + audit event** — "optimization" does not make graph mutation internal.

This section is the reason D2 changed; keep D3–D5 consistent with it.

## Decision record

### D1. `dispatch` selects execution ownership; `engine` remains the default

`fanout.dispatch` is `"engine" | "consumer"`, defaulting to `"engine"`. An omitted field is byte-for-byte current behavior: engine workers enforce `concurrency`, invoke connectors, optionally create worktrees, capture patches, run `pre_merge`, and merge sequentially.

With `dispatch: "consumer"`, the fanout step still owns enumeration, concurrency, attempts, budgets, ensures, persistence, `require`, output ordering, and downstream advancement. Only execution ownership moves: executable item stages appear in the ordinary `ready[]` response and the consumer reports them through `stratum_step_done`.

This is an extension of the TS execution model, not a second parallel subsystem and not a revival of `parallel_dispatch`.

### D2. A ready consumer-fanout item is a self-contained, fenced dispatch descriptor

**REVISED 2026-07-12 (codex architecture critique, code-verified).** The original D2 assumed a bare `ReadyStep` (`{id, do, agent, attempt, epoch, previousFailure}` — `engine.ts:79`) plus producer-side reconstruction of stage/contract from the local spec. That is not restart-safe. A multi-stage consumer item reuses one runtime id across stages that can each declare a different `out` contract and `when` (`schema.ts:33`); `attempt` is cumulative across stages (`engine.ts:1119`); and the engine alone owns the stage cursor. A stateless or restarted consumer seeing `review/2` cannot locate which stage — hence which contract — applies without re-implementing engine state recovery. **Statically-declared does not imply producer-locatable** (the general boundary — see "Metadata boundary" above).

The runtime id stays `<fanout-step-id>/<zero-based-item-index>` (opaque, like subflow `<parent>/<child>` — `engine.ts:1621-1637,1708-1710`), not a legal authored `StepId`. But a consumer-fanout `ready` entry is a **self-contained effective dispatch descriptor**, not a bare `ReadyStep`. It carries, in engine-native terms (never compose vocabulary):

- `dispatchToken` — opaque, unique per issuance (see fencing below);
- authored origin: `flow`, `step`, and the fanout `stage` + `itemIndex`;
- the rendered instruction (`do`);
- effective `agent` and execution policy;
- the **effective output-contract id + shape hash** for the current stage;
- `attempt` and structured `previousFailure`;
- the effective run-revision digest (see IR changes).

This is not spec-mirroring — it is the contract for one authorized execution. The consumer executes exactly what the descriptor states and never re-derives stage/contract from a local cursor. Engine-dispatch fanout is unchanged; only the consumer-dispatch `ready` entry gains these fields. `locateStep` still resolves the root parent then discriminates by construct (`run` → child step; consumer `fanout` → numeric item index).

**Fencing must be real on the wire — it currently is not.** `stepDone`'s stale check only fires when the caller supplies `expectedEpoch` (`engine.ts:365`), but the MCP server calls `engine.stepDone(runId, stepId, result)` with no epoch (`server.ts:94`) and the request schema has no epoch field (`mcp-surface.json:30`). So over MCP **no stale report is ever rejected**: after a revision or stage advance returns the same scoped id to `ready`, an old result silently satisfies the new readiness. The fix: `step_done` must echo the `dispatchToken`, and the engine rejects any report whose token is not the current issuance for that item. This is a REQUIRED `step_done` request-shape addition — the earlier "no request-shape change" claim was wrong.

### D3. Existing failure machinery owns retry and bounce

Reporting `result.failure`, failing the stage output contract, or failing an engine-evaluable `ensure` records a normal fanout attempt. If attempts remain (`stage.attempts ?? fanout-step.attempts ?? 2`), that same item becomes ready again with structured `previousFailure`; other successful items are not re-run. When attempts are exhausted, the item becomes terminal `failed` and its concurrency slot is released.

The consumer may run worktree-local gates before reporting. A local gate, agent, or diff-capture failure is reported as `result.failure` and therefore follows the same retry path. The engine continues to evaluate output expressions and judged ensures after `step_done`. It cannot truthfully evaluate filesystem predicates inside a consumer-owned worktree; validation rejects `file_exists`/`file_contains` on consumer fanout stages when `isolation: "worktree"`. Worktree-local verification belongs in the consumer's gate and is reported as a failure.

No `parallelDone`, bounced-task envelope, or fanout-specific done tool is added.

### D4. `require` is evaluated once all items are terminal

The engine does not settle early when `any` or `N` first becomes true: already-dispatched consumer work has no cancellation handshake, and final output must preserve one position per input item. It waits until every item is `succeeded`, `failed`, or `skipped`, then computes:

- `all`: required successes = input length;
- `any`: required successes = 1;
- positive integer `N`: required successes = `N`.

Only `succeeded` counts. A final-stage skip produces `null` in the ordered output and does not count. Thus an empty fanout satisfies `all`, but fails `any` and every positive `N`. If the threshold is not met, the fanout takes its existing terminal/on-fail path; it never retries the whole batch. If met, output is the existing index-aligned array (`output | null`) and the fanout step succeeds.

### D5. Merge is an explicit downstream gate

Consumer mode never creates worktrees, captures patches, runs engine-side `pre_merge`, applies diffs, or interprets merge status. The consumer owns those artifacts and operations.

The deferred merge handshake is composition: a merge gate is authored immediately after the fanout. Once `require` is satisfied, the fanout succeeds and the gate enters `waiting_gate`. The consumer applies its retained diffs in its chosen deterministic order, then resolves the existing gate:

- `approve`: merge was clean; advance to the post-merge step;
- `revise`: merge needs repair; route to the gate's authored repair/re-dispatch target, bounded by existing `max_rounds`;
- `kill`: merge cannot safely continue.

This is preferred over making the fanout wait for a new merge-status report because a waiting fanout would conflate two owners, require a new persisted state and MCP status, and recreate `parallelAdvance`. The gate makes the side-effect boundary visible in IR, is auditable through existing events, and reuses the existing bounded revision protocol. A consumer fanout that writes files MUST be followed by such a gate; this is an authoring/compose invariant, not something the engine can infer from agent output.

## IR & contract changes

### IR

`ts/src/ir/schema.ts` adds one optional strict field:

```ts
dispatch: z.enum(["engine", "consumer"]).default("engine")
```

Defaulting must occur in the validated value so persisted specs and all engine branches observe `engine`; raw specs without the field remain valid. No new step kind is introduced. `over`, `steps`, `concurrency`, `isolation`, `require`, `merge`, and `pre_merge` remain source-compatible. In consumer mode, `isolation`/`merge`/`pre_merge` are consumer instructions; the engine must not execute them.

Semantic validation adds:

- consumer + worktree + stage filesystem ensure: reject with a targeted diagnostic;
- consumer fanout in a subflow remains rejected because fanout is currently root-only;
- numeric `require > item count` is legal and deterministically fails at runtime, as today.

### MCP surface

`stratum_step_done.request.stepId` is already `string`, so scoped `<fanout>/<index>` ids need no id-shape change. But consumer fanout requires two REAL surface additions (the earlier "no request-shape change" claim was wrong):

- `stratum_step_done.request` gains a **`dispatchToken: string`** that the consumer echoes from the descriptor it was handed. The engine rejects a report whose token is not the item's current issuance (D2 fencing).

  **Fencing scope (AMENDED 2026-07-15, post whole-port review).** The original cut — "for ordinary/engine-owned ids the token is optional/ignored" — would have CEMENTED the very defect this fencing exists to close: the 2026-07-15 adversarial review confirmed ordinary client-executed steps are equally unfenced over MCP (the engine's `expectedEpoch` staleness check exists but the server never supplies it, so a stale or duplicate report can satisfy post-revision readiness — `server.ts:94`, `mcp-surface.json` step_done request). Fencing is therefore UNIVERSAL, delivered in two phases:

  - **Phase 1 (landed 2026-07-15, pre-fanout, surface 7):** `step_done.request` declares optional `epoch`; the server forwards it to the engine's existing `expectedEpoch` check; compose echoes `ready[].epoch` on every report. A mismatched echo is rejected; a missing echo is still accepted (migration compat). This closes the live revision-staleness hole for the only current consumer. Per-revision epochs do not fence same-epoch duplicates (late retry reports) — acceptable for a sequential single-report consumer, not as the end state.
  - **Phase 2 (this feature):** every client-executed issuance — ordinary step, subflow child, consumer-fanout stage — carries a per-issuance `dispatchToken` in its ready entry; `step_done` must echo it; the engine rejects missing or mismatched tokens once compose echoes tokens (flag-day on the coordinated `develop` branches, before the atomic merge). The token is strictly stronger than the epoch (per-issuance beats per-revision, closing late-retry duplicates too); the Phase-1 `epoch` request field is then subsumed and retired with a surface bump. Only consumer-fanout entries carry the full dispatch DESCRIPTOR; ordinary ready entries gain just the token.
- Each consumer-fanout entry in `ready` is a **dispatch descriptor object** (D2 fields: `dispatchToken`, authored origin incl. `stage`/`itemIndex`, rendered `do`, effective `agent`/policy, effective output-contract id + shape hash, `attempt`/`previousFailure`, run-revision digest), not a bare `ReadyStep`. `ready` stays an array; its consumer-fanout element shape is richer. Ordinary/subflow ready entries are unchanged.
- `stratum_plan` (and `resume`) responses expose the **effective-run-revision digest** (Metadata boundary rule 1) so the producer can pin/verify what actually runs.

Background consumer dispatch also adds: the `running` response for `stratum_flow_bg_poll` gains optional `ready: array` (of the same descriptor shape). Its `bg.status` remains a contract `string` and may be `awaiting_consumer`.

Because the frozen surface changes, increment `surface` and update both P4/P5 exact-version assertions. No fanout-specific MCP *tool* or response *status* is added — the changes are additive request/response fields on existing tools.

### Events

No new event kind is needed. Consumer mode reuses:

- `fanout_item_ready` when a slot exposes an item stage;
- `fanout_attempt_result` when `step_done` accepts an attempt;
- `fanout_item_skipped` for a skipped stage;
- `fanout_ledger_debit` for dispatch/usage/judge debits;
- ordinary `result`, `gate_waiting`, and `gate_resolved` at aggregate boundaries.

`fanout_item_dispatched` remains engine-dispatch-only: the engine cannot know when an external consumer actually starts work. Therefore `ts/contracts/events.json` needs no shape or version change. `flow_poll` and `flow_bg_poll` remain the canonical durable progress spine; compose-local worktree/diff narration stays compose-local.

## Engine mechanics

### Scheduling and state

`FanoutItemState` gains a consumer-ready state plus persisted `stage` and `epoch` fields. Initialization remains index ordered. For consumer dispatch, the scheduler promotes at most `concurrency` pending items to `ready`; a slot stays assigned across all stages of an item, matching the current worker model. A terminal item releases a slot and immediately promotes the next pending item.

Rendering uses the same `${item}` and `${prev}` context as engine dispatch. Dispatch budget is reserved exactly once when an item stage first becomes ready, not on every `plan`, `resume`, or poll that returns the same readiness. Usage settlement, output-contract validation, ensure evaluation, attempt recording, and budget terminalization are factored from ordinary `stepDoneLocked`/`executeFanoutItem` so the two dispatch owners cannot drift semantically.

Settlement runs only under the per-run lock after the last item terminalizes. It performs `require`, records the aggregate result, persists, and advances. Its merge branch is guarded by `dispatch === "engine"`.

### Locking and persistence

Consumer execution has no in-process worker and no retained mutable run object outside the lock. Enumeration, readiness promotion, every `step_done`, and settlement are lock-wrapped and atomically persisted. A restart simply returns persisted ready items; terminal items never redispatch. The item epoch rejects duplicate/late reports.

The foreground `commit`/`revert` fanout guard remains conservative while either dispatch mode has a running fanout. Revision invalidates the fanout epoch and all item epochs; stale consumer reports fail exactly like stale ordinary-step reports.

### Background flows

The detached driver must not execute consumer items through its connector. When its ready set contains consumer fanout ids it records `bg.status = "awaiting_consumer"`, stops its drive loop, and exposes those entries through `flow_bg_poll.ready`. Public `step_done` is allowed as a narrow ownership exception only for a currently-ready scoped consumer item on that bg run; ordinary bg steps remain driver-owned and rejected.

After each accepted item result, the engine either remains `awaiting_consumer` with the next ready set, pauses at a downstream gate, or re-kicks the driver if advancement exposes only engine-owned ordinary work. Cancellation leaves already-reported state durable and promotes no further items. Rehydration restores `awaiting_consumer` from persisted fanout readiness without dispatching a connector.

Mixed ready sets are partitioned by owner: the bg driver may run ordinary/engine-owned entries, while consumer entries remain poll-visible. All mutations still serialize through the run lock.

## Compose consumption mapping

| Python-era compose action | Native TS fanout action |
|---|---|
| Receive `parallel_dispatch` task list | Receive consumer item entries in `ready[]`; scoped id identifies task index |
| Create per-task worktree and run agent | Unchanged compose responsibility; use ready `do`/`agent` and local task metadata |
| Capture diff / run `pre_merge_verify` | Unchanged compose responsibility; report a local failure with `stratum_step_done` so only that item retries |
| `parallelDone(flow, step, taskResults, mergeStatus)` | One `stratum_step_done` per scoped item/stage; no aggregate call |
| `ensure_failed` / `schema_failed` subset retry | Failed scoped item reappears in `ready[]` with `previousFailure`; compose reruns only it |
| Apply the union before/around `parallelDone` | Retain successful diffs locally until fanout reaches the downstream merge gate, then apply once |
| `parallelAdvance(..., "clean")` | `stratum_gate_resolve(..., "approve")` |
| `parallelAdvance(..., conflict)` | `stratum_gate_resolve(..., "revise" | "kill")` according to the authored repair policy |
| `parallelStart` + `parallelPoll` server lifecycle | Delete: `dispatch: "engine"` is scheduled by native fanout; observe progress with `flow_poll`/`flow_bg_poll` |
| GSD `runOneStep` special parallel branch (`gsd.js:477`) | Use the same ready/step_done pump as ordinary work; retain only local progress, stuck detection, and merge-gate handling |

Compose must re-author each v0 parallel step to native fanout and add the explicit merge gate where the tasks can write. During cutover, its consumer loop should key local worktrees/diffs by scoped ready id and keep them until the gate resolves; the engine never receives diff text.

## Open questions

1. **Repair topology:** should compose standardize merge-gate `on_revise` on a single repair step, or regenerate the fanout with locally injected conflict context? The engine supports either; the first avoids rerunning successful items, while the second more closely matches today's bounce loop but can rerun the batch.
2. **Consumer filesystem attestation:** v1 deliberately rejects engine filesystem ensures against consumer worktrees. A future signed artifact/working-directory attestation could restore engine verification, but it is not required for this cutover.
3. **Mixed-owner bg readiness:** supporting mixed ordinary and consumer-ready siblings is specified above, but compose's first consumer may not need it. Implementation may stage this after the foreground path only if the frozen background tests retain an explicit unsupported diagnostic meanwhile; it must not silently connector-dispatch consumer work.

## Test plan

| Changed code | Test file | Required exercise |
|---|---|---|
| `ts/src/ir/schema.ts` | IR/schema tests | omitted dispatch defaults to engine; both values accepted; unknown value/field rejected; consumer-worktree filesystem ensure rejected |
| `ts/src/engine/state.ts`, `engine.ts` | `ts/tests/engine/p4.test.ts` | concurrent ready cap; stable scoped ids; multi-stage cursor; **each ready descriptor is self-contained (stage/itemIndex + effective contract id/hash + dispatchToken + run-revision) — reconstructable with NO local spec**; item-local retry/ensure; **token fencing over the wire: a report echoing a superseded `dispatchToken` (after a stage advance or a revision re-issues the same scoped id) is REJECTED, and the current-token report is accepted**; ordered output; all/any/N including empty input; no connector/diff/merge calls in consumer mode |
| `stratum_step_done` / `stratum_plan` MCP boundary | `ts/tests/mcp/p5.test.ts` | `step_done` accepts+requires `dispatchToken` for consumer items and rejects a stale token; `plan`/`resume` expose the effective-run-revision digest; **ordinary/subflow ids: a report echoing the current token is accepted, a missing or stale token is rejected once the Phase-2 flag-day lands (until then the Phase-1 optional-`epoch` mismatch rejection is the enforced gate — do NOT pin a bare-`stepId` acceptance test as the end state)** |
| locking/persistence/bg paths | engine flow-bg/flowctl tests | restart returns the same ready epoch without re-debit; duplicate report rejected; revise invalidates reports; bg awaits consumer, poll exposes ready, cancellation promotes nothing, mixed ownership stays serialized |
| `ts/contracts/mcp-surface.json` | `ts/tests/mcp/p5.test.ts` | real MCP plan -> scoped `ready[]` -> scoped `stratum_step_done` retry -> completion; `flow_bg_poll.ready`; frozen surface version and every response variant still covered |
| events | P4 frozen-contract test | consumer run emits only declared kinds; full bidirectional event-vocabulary gate remains green |
| compose adapter | compose parallel/GSD tests | old `parallelDone`/start/poll/advance calls absent on TS path; worktrees/diffs remain local; clean merge approves gate; conflict revises/kills; failed item alone retries |

**Commands:**

```bash
cd ts && npm test
npm test -- tests/engine/p4.test.ts tests/mcp/p5.test.ts
# In ../compose, run the repository's focused parallel-dispatch and GSD suites,
# then its full test command recorded by that repo at implementation time.
```

## Documentation

- [ ] Update `docs/features/STRAT-TS-PARALLEL/design.md` pause note to link this replacement.
- [ ] Update `docs/plans/2026-07-11-strat-py-retire-roadmap.md` Phase 2/TS-2 status.
- [ ] Document `fanout.dispatch` and the required consumer merge-gate pattern in the TS authoring reference.
- [ ] Record compose's v0-to-v1 migration and removal of the four parallel lifecycle calls.
