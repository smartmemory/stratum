# STRAT-TS-FANOUT-CONSUMER — consumer-dispatched native fanout

**Status:** DRAFT (2026-07-12) · **Branch:** `ts-cutover` · **Epic:** STRAT-PY-RETIRE Phase 2

## Problem

The TS engine has one parallel primitive, native `fanout`, but currently executes every fanout item itself through its configured connector (`engine.ts:890-1253`). Compose needs the other ownership model already used for ordinary TS steps: Stratum schedules work, the client executes it, and the client reports the result.

The Python-era `parallel_dispatch` surface supplied that ownership model through four special tools and two lifecycles:

- consumer dispatch: compose created worktrees, ran agents, captured/applied diffs, then called `parallelDone` (`../compose/lib/build.js:4499-4918`);
- server dispatch: compose called start, polled task state, optionally merged returned diffs, then called advance (`../compose/lib/build.js:3693-4003`).

Porting those tools would duplicate a lifecycle that TS already expresses as `plan -> ready[] -> step_done`. This feature instead makes dispatch ownership a property of native fanout. It must preserve current engine dispatch as the default, retain per-item retry/ensure/require semantics, keep state restart-safe, and let compose continue to own worktrees and merges without teaching the engine about compose diffs.

## Decision record

### D1. `dispatch` selects execution ownership; `engine` remains the default

`fanout.dispatch` is `"engine" | "consumer"`, defaulting to `"engine"`. An omitted field is byte-for-byte current behavior: engine workers enforce `concurrency`, invoke connectors, optionally create worktrees, capture patches, run `pre_merge`, and merge sequentially.

With `dispatch: "consumer"`, the fanout step still owns enumeration, concurrency, attempts, budgets, ensures, persistence, `require`, output ordering, and downstream advancement. Only execution ownership moves: executable item stages appear in the ordinary `ready[]` response and the consumer reports them through `stratum_step_done`.

This is an extension of the TS execution model, not a second parallel subsystem and not a revival of `parallel_dispatch`.

### D2. A ready fanout item uses a scoped runtime id

The runtime id is `<fanout-step-id>/<zero-based-item-index>`, for example `review/2`. Like the existing subflow `<parent>/<child>` ids (`engine.ts:1621-1637,1708-1710`), it is an opaque dispatch id, not a legal authored `StepId`.

Each ready entry keeps the existing `ReadyStep` shape. Its `do`, `agent`, `attempt`, `previousFailure`, and `epoch` describe the current stage of that item. A multi-stage item therefore reappears under the same id as it advances; the engine persists the current stage cursor. `locateStep` first resolves the root parent and then discriminates by construct: `run` resolves a child step, while consumer `fanout` resolves a numeric item index. Authored constructs are mutually exclusive, so the spelling is unambiguous.

Each item has its own monotonic epoch. Moving to another stage or retry increments it. Epoch enforcement is engine-side: `step_done` carries no epoch on the wire (no request-shape change — see MCP surface below), and the engine matches the report against the item's current persisted epoch exactly as it already derives `expectedEpoch` for ordinary steps (the `stepDone` dispatcher, `engine.ts:333-367`). A late result for a prior stage/attempt — or one arriving after a revision bumped the item epoch — no longer matches the ready item at its current epoch and is rejected under the stable item id.

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

`stratum_step_done.request.stepId` is already `string`; scoped fanout item ids require no request-shape or tool-name change in `ts/contracts/mcp-surface.json`. `ready` is already an opaque array in every engine response. The implementation and tests must nevertheless pin that `step_done` accepts both ordinary/subflow ids and `<fanout>/<index>` ids.

Background consumer dispatch needs one minimal addition: the `running` response for `stratum_flow_bg_poll` gains optional `ready: array`. Its `bg.status` remains a contract `string` and may be `awaiting_consumer`. Because the frozen surface changes, increment `surface` and update both P4/P5 exact-version assertions. No fanout-specific MCP tool or response status is added.

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
| `ts/src/engine/state.ts`, `engine.ts` | `ts/tests/engine/p4.test.ts` | concurrent ready cap; stable scoped ids; multi-stage cursor; item-local retry/ensure; stale epoch rejection; ordered output; all/any/N including empty input; no connector/diff/merge calls in consumer mode |
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
