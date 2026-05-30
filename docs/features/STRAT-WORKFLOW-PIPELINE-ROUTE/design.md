# STRAT-WORKFLOW-PIPELINE-ROUTE — Design

**Status:** Phase 1 design (Compose build, 2026-05-30) — revised after Codex design-gate round 1 (7 findings addressed: `finally` clobbers the gate so the downstream dep-check learns `skipped` instead of overriding the terminal state; all server-side state surfaces enumerated; explicit AST name-validation pass instead of "reuse verbatim"; `exit_when` gated on post-cert success; `_collapse_pipeline_items` is on both paths and keeps its `stages` shape; both spec.py call sites named; predicate errors logged, not written to the failure-semantic `error` field). Round 2 added the `stratum_parallel_advance` terminal check (`:1497`) to the server-surface list and restricted predicate bindings to a fixed `{item, prev, prev_raw}` set (no spread source-field locals — they aren't statically knowable for the parse-time name pass). Round 3 widened the AST name pass to allow `_ENSURE_BUILTINS` (so `len(item['tags'])` validates). Round 4 fixed the `_evaluate_parallel_results` stage-level partitions to treat `skipped` as non-failure and dropped an unsupported "disallowed node" parse-error claim. Round 5 split the predicate binding contracts: `when` binds `{item, prev, prev_raw}` (the input), `exit_when` binds `{item, result, result_raw}` (this stage's output) — fixing an inconsistency where `exit_when` had no name for the result it gates on. Not yet implemented.
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP)
**Related:** [[project_strat_workflow_epic]], parent [`STRAT-WORKFLOW-PIPELINE`](../STRAT-WORKFLOW-PIPELINE/design.md), sibling [`STRAT-WORKFLOW-PIPELINE-STAGEOPTS`](../STRAT-WORKFLOW-PIPELINE-STAGEOPTS/design.md). Carved from `STRAT-WORKFLOW-PIPELINE-FANOUT` (see Scope).

## Problem

`-PIPELINE` v1 runs each source item straight down its stage chain: every item
executes every stage, no branching. Two real patterns can't be expressed:

1. **Conditional stage skip** — "if the summarize stage flags this doc as spam,
   don't fact-check it." A stage should be able to *not run* based on a result.
2. **Per-item early-exit** — "once the classify stage is confident, stop; don't
   run the remaining refinement stages for this item."

Both are *routing* decisions over the existing chain. They are the smaller,
engine-compatible half of the filed `-PIPELINE-FANOUT` row.

## Scope decision (carved from -PIPELINE-FANOUT)

The `-PIPELINE-FANOUT` row bundled three separable capabilities. Reading the
source pinned a hard constraint that splits them by cost:

> **`ParallelExecutor` fixes its task set at construction** — `__init__` takes
> `tasks: list[dict]` (`parallel_exec.py:160,176`), `run()` creates every
> asyncio task up-front (`:242`) and builds the completion-event map once
> (`:204`). There is no mechanism to inject tasks mid-run.

So:

| Capability | Fits static task set? | This feature? |
|---|---|---|
| Conditional stage skip + per-item early-exit | **Yes** — every task still pre-exists; some just don't dispatch | **v1 (this doc)** |
| Bounded fan-out (1→≤K) | Static-compatible but multiplies the grid, adds slot-threading + downstream widening | deferred → `-PIPELINE-FANOUT` |
| Unbounded fan-out (1→runtime K) | No — needs an engine change (mid-run task injection) | deferred → `-PIPELINE-FANOUT` |

v1 ships **conditional routing + early-exit only**, on the existing static N×S
grid, with **zero grid-shape change and no new concurrency machinery**. The skip
primitive it introduces is the prerequisite the deferred fan-out needs (an
unfilled fan-out slot is just a skipped task), so this is the natural first
increment. `-PIPELINE-FANOUT` stays PLANNED for the split.

## Verified architecture (read the source, don't infer)

- **Static desugar unchanged.** `expand_pipeline_tasks` (`executor.py:571`) emits
  the N×S grid of `step::item{i}::stage{j}` tasks, each depending on the same
  item's previous stage. This shape does **not** change — routing only affects
  whether a materialized task dispatches.
- **Two task-status notions already separated.** `_run_one` tracks a per-task
  *report* state `ts.state` (`pending/running/complete/failed/cancelled`,
  `parallel_exec.py:559` etc.) **and** a separate *gate* dict
  `self._task_terminal_state[tid]` consulted by downstream waiters
  (`parallel_exec.py:206,534`). A downstream task cancels itself if its
  predecessor's *gate* is not `"complete"` (`:534`). This separation is exactly
  what a transparent skip needs (see Design §3).
- **Predecessor result already threaded.** `_render_prompt` reads
  `self.state.parallel_tasks[deps[0]].result` for `{prev}`/`{prev_raw}`
  (`parallel_exec.py:268-276`). A skipped task that carries its predecessor's
  result as its own `ts.result` is therefore transparent to the next stage's
  prompt *and* to the next stage's `when` check.
- **Item completion is computed in two places** that both must learn about a
  skipped state:
  - executor: `_item_counts` (`parallel_exec.py:305`) feeds `_require_unsatisfiable`.
    Today: item complete iff its *highest-stage* task is `"complete"` — **breaks
    on a skipped tail** (early-exit leaves the final stage skipped).
  - server (client-dispatched path): `_collapse_pipeline_items`
    (`server.py`, see `-PIPELINE` design §safety) enumerates the full desugared
    graph; a `skipped` stage must count as settled-non-failure, not `incomplete`.
- **Safe expression jail exists.** `compile_ensure` (`executor.py:278`) and
  `compile_value_expr` (`executor.py:364`) compile predicates over a bound name
  in a restricted environment — reused verbatim for `when`/`exit_when`. No new
  evaluator.

## Design

### 1. IR — two optional per-stage predicates

A pipeline `stage` gains two optional fields (both `str` expressions):

```yaml
flows:
  triage:
    steps:
      - id: p
        pipeline:
          source: "$.input.docs"
          stages:
            - intent_template: "Classify: {item}"
              exit_when: "result_raw['confidence'] >= 0.95"  # classify was sure → stop
            - intent_template: "Fact-check: {prev}"
              when: "prev_raw['label'] != 'spam'"            # skip fact-check if spam
```

- **`when`** (evaluated *before* the stage dispatches): if it returns falsy, the
  stage is **skipped** — not dispatched — and the previous stage's result flows
  through unchanged.
- **`exit_when`** (evaluated *after* the stage completes, over **this stage's own
  result**): if truthy, the item **early-exits** — all of its later stages are
  skipped and the item completes with this stage's output.
- **Two binding contracts (round-5 finding) — different because the predicates
  fire at different times.** No spread source-item field locals (round-2
  finding 2: those are only materialized at runtime, `executor.py:586`, so they
  can't be parse-time validated). Field access is always by subscript
  (`item['label']`), never bare field-name locals.
  - **`when`** binds **`item`** (whole source item), **`prev`** (predecessor
    result, JSON string), **`prev_raw`** (predecessor result, raw) — it decides
    whether to run *given the input*. Stage 0 has no predecessor → binds `{item}`
    only.
  - **`exit_when`** binds **`item`**, **`result`** (this stage's output, JSON
    string), **`result_raw`** (this stage's output, raw) — it decides whether to
    stop *given what this stage produced*. Available on **every** stage including
    stage 0 (a stage always has a result after it runs); it does **not** bind
    `prev`/`prev_raw`. (`result`/`result_raw` mirror the existing `prev`/`prev_raw`
    naming; the executor binds `ts.result` here.)
- **Explicit name-validation pass (round-1 finding 3; round-3/5 refinements).**
  The jail compilers only reject syntax/dunders — they do **not** validate free
  names (extra locals pass through at eval). So a small AST pass walks the
  expression's `ast.Name` nodes and checks them against the predicate's allowed
  set **∪ the jail's safe globals `_ENSURE_BUILTINS.keys()`** (`executor.py:263`:
  `len`/`bool`/`int`/`str`/`max`/`min`/`file_exists`/`file_contains`/…):
  - `when`: `{item, prev, prev_raw}` (stage ≥1) or `{item}` (stage 0) ∪ builtins.
  - `exit_when`: `{item, result, result_raw}` (all stages) ∪ builtins.
  So `len(item['tags']) > 0` validates; a stage-0 `when` referencing `prev`, an
  `exit_when` referencing `prev`, or any unknown name is a parse-time spec error.
  (Allowing builtins is required — the jail evaluates with them enabled, so a
  data-names-only pass would reject otherwise-valid predicates.)
- **Schema + semantic validator are two sites (round-1 finding 6).** Adding
  `when`/`exit_when` touches **both** the pipeline-stage JSON schema
  (`spec.py:603`) **and** the semantic key allowlist + error text
  (`spec.py:1531`) — today both admit only `intent_template`/`agent`/
  `task_reasoning_template`/`task_timeout`. Both optional;
  `additionalProperties: False` preserved. **Checksum:** the `stages` dict is
  fingerprinted wholesale (`executor.py:975`), so the new keys are covered with
  no checksum change (confirmed against source).
- **Non-pipeline steps** reject `when`/`exit_when` (pipeline-stage-only),
  consistent with the existing stray-`stages` rejection.

### 2. Malformed-predicate degradation

A `when`/`exit_when` that raises at runtime (e.g. references a missing key) must
**not** crash the task. Policy, mirroring `-IMPERATIVE`'s `accumulate_error`
freeze and the cert graceful-degrade:

- **`when` raises → treat as `True`** (run the stage). Failing *open* is safer
  than silently dropping work.
- **`exit_when` raises → treat as `False`** (don't exit). Failing *closed* keeps
  the chain running rather than truncating an item on a buggy predicate.
- **The error is logged (round-1 finding 7), not written to
  `ParallelTaskState.error`.** That field is failure-semantic — poll/done
  handling partitions tasks by it — so stamping it on a `complete`/`skipped`
  task is ambiguous and easy to mishandle downstream. A runtime predicate error
  is surfaced via `logging.warning` (same degrade-and-warn pattern as
  `-BUDGET-DOLLARS`'s unpriced model), leaving the task's terminal semantics clean.

A *parse-time* malformed expression is a spec error, rejected up front: the jail
rejects syntax errors and dunder (`__`) usage (`executor.py:281`), and the §1 AST
name pass rejects disallowed/unknown free names. (The jail does **not** enforce a
node allowlist beyond dunders — so "disallowed node" is not a category here.)

### 3. Execution — skip on the static grid (server-dispatched)

All N×S tasks still materialize. The change is entirely inside
`ParallelExecutor._run_one`, after the dependency-wait succeeds
(`parallel_exec.py:541`) and **before** the semaphore acquire / dispatch:

**New report state `skipped`** added to the task-state vocabulary
(`pending/running/complete/failed/cancelled` → `+skipped`).

**Skip check (before dispatch).** A pipeline task skips iff either:
  1. its own `when` is present and evaluates falsy, **or**
  2. its item has already early-exited at an *earlier* stage
     (`self._item_exited.get(item_idx)` is set and `< this stage`).

On skip:
- `ts.state = "skipped"`, `ts.result = <predecessor's result>` (passthrough; for
  stage 0, the source item), `ts.finished_at` set, then `return` — no dispatch,
  no cert. The existing `finally` runs: it leaves `ts.state == "skipped"`
  untouched (the defensive `pending/running → failed` guard at `:663` doesn't
  fire), records `_task_terminal_state[tid] = "skipped"` (`:674`), and fires the
  done-event. Because `started_at` was never set (skip returns before the
  semaphore at `:543`/`:560`), the budget debit block (`:684`) charges nothing —
  a skipped stage is **not** a dispatch.
- **Downstream proceeds via the dep-gate, not a gate override (round-1
  finding 1).** The `finally` unconditionally writes `_task_terminal_state[tid] =
  ts.state` (`:674`), so any attempt to override it to `"complete"` in the skip
  branch would be clobbered back to `"skipped"`. Instead, **the downstream
  dependency check learns `skipped`**: `_run_one`'s gate at `:534` currently
  cancels when a predecessor's terminal state `!= "complete"`; change it to treat
  both `"complete"` and `"skipped"` as proceed-signals. The skipped predecessor's
  `ts.result` (passthrough) then flows into the next stage's `{prev}` via the
  existing `_render_prompt` lookup (`:269`) — transparent, no special-casing in
  the prompt path.

**Early-exit (after dispatch, only once terminal-successful — round-1
finding 4).** Cert validation (`:638-647`) is what flips a successful connector
result between `complete` and `failed`. `exit_when` must be evaluated **only when
the task's final state is `complete`** (i.e. after the cert branch resolves at
`:647`, not on the raw connector result) — otherwise an invalid stage output
could mark the item exited before it's correctly marked `failed`. On a `complete`
task, evaluate `exit_when` with `result`/`result_raw` bound to `ts.result` (this
stage's output) plus `item`; if truthy, set `self._item_exited[item_idx] =
this_stage_j`. This happens inside the task body
**before** the `finally` fires the done-event, so the immediate downstream task —
waiting on that event — reliably observes the flag and takes the skip path above.
(`_item_exited` is a plain dict mutated in the same single-flow async context as
`_task_terminal_state`; no lock needed.)

**Server-side state surfaces that must recognize `skipped` (round-1 finding 2).**
`skipped` is a new terminal state, so every place that special-cases the existing
terminal set needs it — mirroring how `-BUDGET` taught every advancement surface
about `budget_exhausted`:
- `stratum_parallel_start` re-start rejection (`server.py:1198`) — add `skipped`
  to the "already past pending" set, else an all-skipped run looks restartable.
- poll summary dict (`server.py:1336`) — add a `skipped` counter key.
- `all_terminal` (`server.py:1343`) — add `skipped` to the terminal set.
- `stratum_parallel_advance` terminal check (`server.py:1497`, round-2 finding 1)
  — add `skipped` to the `(complete, failed, cancelled)` set, else with
  `defer_advance: true` an all-`skipped` terminal set is wrongly blocked as
  `tasks_not_terminal`.
- the two `ParallelTaskState → task_results` serializers (`server.py:1365`,
  `:1511`) — map `ts.state == "skipped"` to `status: "skipped"` (not the current
  `else "failed"`), so the aggregation below sees it correctly.

**Scope: predicate evaluation is server-dispatched only.** Predicates are
evaluated inside `ParallelExecutor`, so routing fires on the
`stratum_parallel_start` (server-dispatched) path. The client-dispatched
`stratum_parallel_done` path has no server-side execution to skip — `when`/
`exit_when` are not evaluated there (documented limitation). The *aggregation*
(`_collapse_pipeline_items`, §4) treats a `skipped` status as settled-non-failure
regardless of source, so the server-dispatched skips it produces aggregate
correctly and a future client-reported `skipped` wouldn't break it.

### 4. Completion + require semantics (skipped ≠ failure)

Both item-status computations are updated so a `skipped` task is **settled and
non-failing**:

- **`_item_counts` (`parallel_exec.py:305`)** — replace the "highest-stage task
  is complete" rule (which a skipped tail breaks) with: per item,
  - `failed` iff any task is `failed`/`cancelled`;
  - else `complete` iff no task is `pending`/`running` (all settled into
    `complete`/`skipped`);
  - else in-flight.
  This makes an early-exited tail (skipped) and a `when`-skipped final stage both
  read as a complete item, while a real failure still dominates.
- **`_collapse_pipeline_items` (`server.py:637`) — on BOTH dispatch paths.** The
  server-dispatched poll/advance path converts `ParallelTaskState` → `task_results`
  (the serializers above) → `_evaluate_parallel_results` → this function, so it is
  not client-only. Update its per-item verdict (`:669-674`): `failed` iff any
  stage status is `failed`/`cancelled`; `complete` iff every stage status is
  `complete`-**or**-`skipped` (was: all `complete`); else `incomplete`. The
  `-PIPELINE` require-bypass guard (a `missing` stage ≠ complete) stays intact —
  `skipped` is a *reported* status, `missing` still means absent.
- The early-exited item's `result`: the final stage is `skipped` and carries the
  passthrough (the exit-stage output propagated down the skipped tail), so the
  existing `final_sr` result extraction (`:680`) yields the exit-stage output for
  a `complete` (skipped-tail) item — the desired "completes with this stage's
  output" semantics, no change needed there.
- **`_evaluate_parallel_results` stage-level partitions (round-4 finding 1).**
  Beyond `_collapse_pipeline_items`, this function partitions raw stage
  task_results into `completed`/`failed` (`server.py:754-755`, `failed = status
  != "complete"`) and reports `n_failed`/`n_failed_tasks` (`:804,:808`). A
  `skipped` stage (status `"skipped"`) would land in `failed` and inflate those
  diagnostic counts on a *routed* pipeline, even though the item verdict (which
  drives the actual pipeline require decision at `:760-781`) is correct. Fix: the
  failed partition + failed counts treat `skipped` as **non-failure** — `failed =
  status not in ("complete", "skipped")`. No effect on non-pipeline
  `parallel_dispatch` (it never produces `skipped`); the non-pipeline require math
  (`:784-793`, based on `completed`) is unchanged.
- **`_evaluate_parallel_results` stage-level partitions (round-4 finding 1).**
  Beyond `_collapse_pipeline_items`, this function partitions raw stage
  task_results into `completed`/`failed` (`server.py:754-755`, `failed = status
  != "complete"`) and reports `n_failed`/`n_failed_tasks` (`:804,:808`). A
  `skipped` stage would land in `failed` and inflate those diagnostic counts on a
  *routed* pipeline, even though the item verdict (which drives the pipeline
  require decision at `:760-781`) is correct. Fix: the failed partition + failed
  counts treat `skipped` as **non-failure** — `failed = status not in
  ("complete", "skipped")`. No effect on non-pipeline `parallel_dispatch` (never
  produces `skipped`); its require math (`:784-793`, based on `completed`) is
  unchanged.
- `_require_unsatisfiable` is unchanged — it consumes `_item_counts`, which now
  handles skips.

### 5. Surfacing

- **`items[].stages` shape is unchanged (round-1 finding 5).** It is a bare list
  of stage *results* (`server.py:681`), consumed by `ensure` via bracket access;
  changing it to carry per-stage state would break that contract. A skipped stage
  appears there with its passthrough result. The authoritative `skipped` **state**
  is visible in the per-task **trace/records** (`ts.state == "skipped"`), which is
  where execution detail belongs — not promoted into the `ensure`-facing items
  contract. (Rich per-stage state in `items[]` is a possible later enhancement;
  out of scope here to keep the contract stable.)
- An item that early-exited reports `status: complete` with `result` = the
  exit-stage's output (via the passthrough chain).

## Acceptance criteria

- [ ] `stages[].when`/`stages[].exit_when` added to **both** the JSON schema (`spec.py:603`) and the semantic key allowlist + error text (`spec.py:1531`); optional, `additionalProperties: False` preserved; non-pipeline steps reject them; no checksum change (stages fingerprinted wholesale).
- [ ] Two binding contracts (subscript access; no spread source-field locals): `when` binds `{item, prev, prev_raw}` (stage ≥1) / `{item}` (stage 0); `exit_when` binds `{item, result, result_raw}` (all stages, `result*`=this stage's output, evaluated post-complete). Neither binds the other's names.
- [ ] **Explicit AST name-validation pass** per predicate: allowed = that predicate's data bindings ∪ `_ENSURE_BUILTINS.keys()`; disallowed/unknown free name → parse-time spec error (stage-0 `when` referencing `prev`, `exit_when` referencing `prev`, unknown name all rejected; `len(item['tags'])` validates).
- [ ] New task state `skipped`; a `when:false` task does not dispatch (no `started_at`, no budget charge), carries its predecessor's result (passthrough), reports `skipped`. The **downstream dep-gate (`parallel_exec.py:534`) treats a `skipped` predecessor as proceed** (no terminal-state override — the `finally` at `:674` would clobber it); next stage's `{prev}` is the passthrough.
- [ ] `exit_when` evaluated **only on a terminal-`complete` task** (after cert resolution at `:647`), over `ts.result`; if truthy, skips all later stages for that item only; `_item_exited` set before the done-event fires so downstream observes it; other items unaffected.
- [ ] Malformed `when` → runs the stage (fail-open); malformed `exit_when` → does not exit (fail-closed); runtime error **logged, not written to `ParallelTaskState.error`** (failure-semantic); parse-time malformed predicate is a spec error.
- [ ] `_item_counts` (`parallel_exec.py:305`) treats `skipped` as settled-non-failure (complete = no pending/running, no failure); early-exited tail reads complete; `require: all` satisfied with a skipped tail.
- [ ] All server-side terminal-state surfaces recognize `skipped`: re-start rejection (`:1198`), poll summary (`:1336`), `all_terminal` (`:1343`), `stratum_parallel_advance` terminal check (`:1497`), both serializers map skipped→`status:"skipped"` (`:1365`,`:1511`).
- [ ] `_collapse_pipeline_items` (`server.py:637`, BOTH paths) — item complete iff every stage `complete`-or-`skipped`, none failed; require-bypass guard (`missing`≠complete) intact; early-exited item's `result` = exit-stage output via passthrough.
- [ ] `_evaluate_parallel_results` stage-level partitions/counts (`:754-755`,`:804`,`:808`) treat `skipped` as non-failure (`failed = status not in ("complete","skipped")`), so routed-pipeline diagnostic counts don't miscount skips; non-pipeline math unchanged.
- [ ] `items[].stages` contract unchanged (bare results); `skipped` state visible in per-task trace, not the `ensure`-facing items contract.
- [ ] Predicate evaluation is server-dispatched only (documented); client-dispatched pipelines don't get routing.
- [ ] A pipeline with no `when`/`exit_when` behaves byte-identically to today (regression); no grid-shape change; no new concurrency machinery; non-pipeline `parallel_dispatch` untouched.
- [ ] Codex design gate: REVIEW CLEAN.

## Out of scope

- **Fan-out / split (1→many)** — bounded or unbounded; stays in `-PIPELINE-FANOUT`.
- **Multi-predecessor merge** — no stage has >1 dep in v1 (no fan-out → no join).
- **Client-dispatched predicate evaluation** — server-dispatched only.
- **Cross-item routing** — predicates see only their own item's chain.
