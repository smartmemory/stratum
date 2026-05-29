# STRAT-WORKFLOW-PIPELINE — Design

**Status:** Phase 1 design (Compose build, 2026-05-30)
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP) — ticket 3 of 6 (`-NAMING`, `-IMPERATIVE`, `-BUDGET` COMPLETE)
**Related:** [[project_strat_workflow_epic]], [[feedback_verify_roadmap_rows_vs_disk]], [[feedback_ship_narrow_first]]

## Scope reconciliation (read first)

The STRAT-WORKFLOW epic verifies every gap against source before building (the `-IMPERATIVE`
row turned out substantially stale). This row was re-verified by reading
`stratum-mcp/src/stratum_mcp/parallel_exec.py` in full and the `parallel_dispatch` surface in
`spec.py` / `server.py`. Verdict: **the gap is real, but one mechanic already exists.**

| Original claim (ROADMAP) | Reality in source | Verdict |
|---|---|---|
| "`ParallelExecutor.run()` fans out one task list and `gather`s to a barrier" | True — `run()` creates all tasks then `await asyncio.gather(*tasks, ...)` at `parallel_exec.py:235-242`. The gather is the only completion barrier. | **Accurate** |
| "multi-step flows barrier between steps" | True — flow `current_idx` only advances after a step's `process_step_result` completes (`executor.py`); the next step is not dispatched until the prior step fully drains. | **Accurate** |
| "Per-item state already exists in `parallel_tasks`" | True — `ParallelTaskState` per task, seeded at `parallel_exec.py:202-205`. | **Accurate** |
| "the gap is cross-stage streaming without the inter-step barrier" | Partially shipped *mechanic*: `depends_on` waiters **do not hold semaphore slots** (`parallel_exec.py:445-457`), so item-level staggering already works inside one dispatch — item A can be running stage 2 while item B is still queued for stage 1. **What is genuinely absent:** (a) a *stage abstraction* — `ParallelExecutor` carries a single `intent_template` (`parallel_exec.py:177, 248-257`), so there is no notion of stage 0 → stage 1 → stage 2; (b) *per-stage output threading* — a downstream task cannot read its predecessor's `ts.result` when rendering its prompt; (c) *any way to author a pipeline over a list* without hand-writing the N×S `depends_on` DAG. | **Gap is real** — same shape as `-IMPERATIVE`: the scheduling *mechanic* exists, the *primitive* does not. |

**Conclusion:** build the primitive. The cheapest correct path reuses the verified scheduler
rather than adding a second concurrency engine (decision below).

## Problem

Dynamic-workflow runtimes (Claude Code's `pipeline(items, stage1, stage2, …)`, Temporal, Airflow)
let an item flow through an ordered series of stages **independently of its siblings**: item A can
be in stage 3 while item B is still in stage 1. Wall-clock collapses to the *slowest single-item
chain*, not the *sum of the slowest task in each stage*.

Stratum today can only express this two ways, both wrong for the use case:

1. **One `parallel_dispatch` per stage, chained as flow steps.** Each step `gather`s to a barrier
   (`parallel_exec.py:242`) and the flow barriers between steps, so stage 2 cannot start for *any*
   item until stage 1 finishes for *every* item. Wall-clock = Σ(slowest-per-stage). This is the
   exact anti-pattern the dynamic-workflow `pipeline()` primitive exists to avoid.
2. **Hand-write an N×S `depends_on` DAG inside one `parallel_dispatch`.** The scheduler would
   stagger correctly, but: you must enumerate N×S tasks by hand; every task shares the single
   `intent_template` so all stages run the *same* prompt; and a downstream task cannot read its
   predecessor's output. Unusable as an authoring surface.

We want the `pipeline()` primitive: a list source, an ordered stage list, per-item independent
chaining, prev-stage output threaded into the next stage's prompt — **governed and cross-model**,
the way Stratum already does fan-out.

## Goals / Non-Goals

**Goals (v1)**
- A new `pipeline` IR step type: `source` (item list) + ordered `stages` (each an agent intent),
  `max_concurrent`, `require`, `merge`.
- Per-item independent chaining with **no inter-stage barrier** — item A reaches stage *k* without
  waiting for item B's stage *k-1*.
- **Per-stage output threading**: stage *j*'s prompt can reference stage *j-1*'s result.
- **Per-item failure isolation**: a stage failure drops *that item's* remaining stages but does not
  kill sibling items (matches `pipeline()` "stage throws → item drops to null, others continue").
- `require` evaluated over **source items that completed the full chain**, not over individual
  stage tasks.
- Reuse the existing `ParallelExecutor` scheduler, semaphore, budget debit, cancellation, and
  persistence — **no second concurrency engine**.
- `stratum validate` accepts/round-trips the new step type; spec checksum covers it.

**Non-Goals (v1) — deferred to follow-ups**
- Within-stage fan-out (one item → many items in the next stage / nested parallel). → `-PIPELINE-FANOUT`.
- Conditional stage skipping / routing / early-exit predicates. → `-PIPELINE-FANOUT`.
- Per-stage `isolation: worktree` differences (v1: one isolation policy for the whole pipeline).
- Per-stage `task_reasoning_template` (cert) and per-stage `timeout` — step-level only in v1; the
  executor has no per-task override for these today. → `-PIPELINE-STAGEOPTS`.
- Cross-*flow-step* pipelining (an item streaming from one flow step into the next). → `-PIPELINE-FANOUT` / `-BG`.
- Whole-flow background execution (that is `-BG`).

## Approaches considered

### Approach A — Desugar `pipeline` to the existing `depends_on` DAG (CHOSEN)

A `pipeline` step is compiled, at dispatch time, into a flat task list with `depends_on` edges:
for source items `i ∈ [0,N)` and stages `j ∈ [0,S)`, emit task `p{i}_s{j}` with
`depends_on: [p{i}_s{j-1}]` (stage 0 has no dep). Each task carries the stage's own
`intent_template` and a back-pointer to its source item. The existing `ParallelExecutor.run()`
then runs the whole graph unchanged: the semaphore bounds total concurrent agents, `depends_on`
waiters don't hold slots, so items stagger across stages for free; the `gather` barrier sits only
at *pipeline drain* (correct — the flow step is done when all chains settle).

Three surgical engine changes are required (none a rewrite):
1. **Per-task intent template.** `_render_prompt` (`parallel_exec.py:248`) prefers a per-task
   template field over `self.intent_template`, so each stage renders its own prompt.
2. **Prev-stage output in the render namespace.** When a task has a single `depends_on`
   predecessor, expose that predecessor's `ts.result` as `prev` (and its raw item fields) to
   `str.format`. Safe because `depends_on` guarantees the predecessor is terminal-complete before
   the dependent renders (`parallel_exec.py:457-465`, `538`).
3. **Item-scoped require + no cross-item cascade.** In pipeline mode, `_require_unsatisfiable`
   counts *items whose final-stage task completed* (not all N×S tasks), and `_cancel_siblings` is
   **not** triggered by a single item's failure. Per-item downstream cancellation already happens
   correctly via the existing "upstream did not complete → cancelled" path (`parallel_exec.py:458-465`).

**Pros:** smallest diff; reuses the verified scheduler, budget debit (`parallel_exec.py:577-593`),
cancellation, persistence, and event stream verbatim; staggering is a property we already have, not
new code; risk concentrated in three well-understood functions.
**Cons:** require/cascade semantics must become mode-aware (a real subtlety — see Key decisions);
the desugared task list is N×S entries, so very large pipelines produce large task graphs (bounded
by `max_concurrent` at runtime, but the `parallel_tasks` dict grows N×S — acceptable for v1,
documented as a known limit).

### Approach B — New streaming queue engine

Each stage is a worker pool consuming from an inter-stage `asyncio.Queue`; items flow as queues
drain. More faithful to a "true" streaming pipeline and naturally supports within-stage fan-out
later.
**Cons:** a second concurrency engine alongside `ParallelExecutor` — duplicate budget accounting,
duplicate cancellation/interrupt, duplicate persistence, duplicate event-stream wiring, a much
larger test matrix, and two code paths to keep in sync. Violates "no second engine." The staggering
benefit is identical to Approach A for the linear 1:1 case; the extra machinery only pays off for
the deferred fan-out goal.

**Decision: Approach A.** It delivers the entire v1 goal set by reusing a scheduler we have already
hardened and budget-instrumented, and concentrates new logic in three named functions. Approach B's
only advantage (native fan-out) is explicitly out of v1 scope; if `-PIPELINE-FANOUT` later needs a
variable graph, the desugar can emit it without a new engine, or we revisit B then with data.

## Design (Approach A)

### 1. IR surface — new `pipeline` step type

Extend the step-type enum (`spec.py:542`) to include `pipeline`. New step shape:

```yaml
- id: clean_and_verify
  type: pipeline
  source: $.steps.discover.files        # resolves to a list (same resolver as parallel_dispatch source)
  max_concurrent: 8                      # bounds TOTAL concurrent agents across all stages
  require: all                           # "all" | "any" | int — evaluated over ITEMS (see §3)
  merge: sequential_apply                # reuse parallel_dispatch merge vocabulary
  isolation: none                        # one policy for the whole pipeline (v1)
  task_timeout: 1800                     # STEP-level per-task timeout (the real IR field, spec.py:143); applies to every stage in v1
  task_reasoning_template: {...}         # STEP-level cert (v1: applies to every stage's result), optional
  stages:
    - agent: claude
      intent_template: "Clean up dead code in {item}. Return the cleaned summary."
    - agent: codex
      intent_template: "Verify the cleanup of {item}. Prior result: {prev}. Output PASS/FAIL."
```

- `source` resolution reuses `_resolve_parallel_tasks`' source path (`server.py:888-895`).
- `stages[]` is ordered; each stage carries only **`agent`** and **`intent_template`** in v1.
- **Per-stage `task_reasoning_template` and `timeout` are explicitly NOT in v1.** (Codex design-gate
  High finding: the executor today only threads a step-wide `task_timeout` / `task_reasoning_template`
  — `parallel_exec.py:162, 516, 539` — and adding per-task overrides is its own design.) v1 keeps
  these at the **step level**, applied uniformly to every stage task. Per-stage cert/timeout is a
  named follow-up (`-PIPELINE-FANOUT` or `-PIPELINE-STAGEOPTS`). This keeps the per-task dict to the
  two fields the engine can already honor via the surgical render/agent changes (§engine changes).
- Validation (mirroring `parallel_dispatch` rules at `spec.py:1440-1462`): `pipeline` requires
  `source` and a non-empty `stages` list with ≥1 stage; each stage requires `intent_template` and
  permits only `agent` besides it (any other per-stage key is a validation error in v1, so the
  deferred fields fail loud rather than silently no-op); step-level `intent_template` is forbidden
  (it lives per-stage); existing `parallel_dispatch`-only fields (`source`, `isolation`, `require`,
  `merge`, `task_timeout`, `task_reasoning_template`) remain valid at the step level; `decompose`-style
  fields stay forbidden. Spec checksum: see §5 — v1 adds `stages` to the fingerprint.

### 1a. Step-mode integration — how `pipeline` threads through the existing plumbing

(Codex design-gate High finding: `type: pipeline` must be recognized everywhere `parallel_dispatch`
is, or start/poll/advance silently reject it.) The chosen integration is **"pipeline IS a
parallel_dispatch at the mode layer."** The desugar (§2) runs at task-list construction and produces
a normal parallel_dispatch task graph; the *step mode* stays `parallel_dispatch` for every gate that
checks it, and only the `ParallelExecutor` + the advance-evaluator learn it's a pipeline (via an
`is_pipeline` flag) for the require/threading semantics. Concretely:

- **`_step_mode` (`executor.py:562`)** maps `step_type == "pipeline"` → returns `"parallel_dispatch"`
  (the execution mode), so `get_current_step_info` and the advertised surface (`executor.py:1456`)
  treat it uniformly. A separate predicate (`_is_pipeline_step`, reads `step.step_type == "pipeline"`)
  marks where the desugar + executor flag + evaluator need to diverge.
- **Gates that do a RAW `step.step_type == "parallel_dispatch"` check must be widened — this is NOT
  zero-branch** (correcting the first design-gate's over-claim). Audited raw checks that reject a
  non-`parallel_dispatch` step:
  - `stratum_parallel_advance` (`server.py:1300`) → `wrong_step_type` on raw equality. **Must** accept
    `pipeline` (switch to `_step_mode(step) == "parallel_dispatch"` or `step_type in {parallel_dispatch,
    pipeline}`), else deferred-advance pipelines are rejected.
  - `stratum_parallel_done` mode-check (`server.py:713`) and `stratum_parallel_start` gate
    (`server.py:1022`) — same treatment; verify each in the blueprint's touchpoint table.
  The blueprint MUST enumerate every `== "parallel_dispatch"` literal in server.py and convert it to a
  mode/membership check. (Blueprint action item.)
- **Idempotent re-materialization.** Start/poll/advance re-resolve the task list on each call. The
  pipeline desugar is **pure and deterministic**: task ids are `f"{step_id}::item{i}::stage{j}"`
  derived only from the (ordered) source list and stage count, and `depends_on` is positional. So
  re-deriving the graph across calls yields byte-identical task ids — the existing
  `state.parallel_tasks` seeding (`parallel_exec.py:202-205`) and poll re-resolution stay correct,
  exactly as they do for `parallel_dispatch` today.
- **No new MCP tool.** `stratum_parallel_start/poll/done/advance` serve pipelines unchanged because
  the mode is `parallel_dispatch`.

### 2. Desugar — `pipeline` → task graph

At dispatch (where `parallel_dispatch` builds its task list, server.py around the
`ParallelExecutor` construction at `server.py:996`), a `pipeline` step compiles its `source` ×
`stages` into the flat task list `ParallelExecutor` already consumes. Each task dict gains three
internal fields (underscored so they never collide with user item fields used in `str.format`):

```python
task = {
  "id": f"{step_id}::item{i}::stage{j}",
  "depends_on": [f"{step_id}::item{i}::stage{j-1}"] if j > 0 else [],
  "_pipeline_item": i,          # source-item index → item-scoped require (§3)
  "_pipeline_stage": j,         # stage index → final-stage detection
  "_intent_template": stages[j]["intent_template"],   # per-task template (§ engine change 1)
  "_agent": stages[j].get("agent"),                   # per-stage agent override (None → step agent)
  "item": source[i],            # ALWAYS bound — scalar or dict; {item} resolves for every source
}
# Only splat extra named fields when the source element is a mapping, so {field}
# placeholders resolve for dict items WITHOUT clobbering reserved keys.
if isinstance(source[i], dict):
    for k, v in source[i].items():
        if k not in task and not k.startswith("_"):
            task[k] = v
```

(Codex design-gate Medium finding: the source can be a list of **scalars** — `["a.py", "b.py"]` —
not only dicts. v1 therefore guarantees an `{item}` binding for every element and only splats extra
fields when the element is a mapping. Reserved/underscore keys are never overwritten by item fields.)

The per-stage `agent` means a single pipeline can route stage 0 to `claude` and stage 1 to `codex`
— the cross-model property Stratum already has on the fan-out path, now per stage. (Engine today
reads one `self.agent`; §engine-change lets `_run_one` prefer `task["_agent"]`, falling back to the
step-level agent when the stage omits it.)

### 3. Item-scoped require + per-item isolation (the subtle part)

This is where naive reuse breaks. Today `require: all` + `_require_unsatisfiable` (`parallel_exec.py:264-285`)
returns `True` on *any* task failure, which fires `_cancel_siblings()` (`parallel_exec.py:641-642`)
and kills every other task. For a pipeline that is **wrong** — one bad item must not abort the whole
batch (dynamic-workflow `pipeline()` drops the failed item to null and continues).

There are **two** distinct places require is computed, and both must become item-scoped (the first
design-gate pass conflated them — this is the fix):

1. **`ParallelExecutor._require_unsatisfiable` (`parallel_exec.py:264-285`)** — drives *cascade-cancel
   during the run*. Made item-scoped via the `is_pipeline` flag.
2. **`_evaluate_parallel_results` (`server.py:585-659`)** — drives the *advance decision* for
   `stratum_parallel_poll` / `_done` / `_advance` (it computes `require_satisfied`, `can_advance`,
   `completed`, `failed`, and the `aggregate` **over raw stage tasks** today). This helper **must
   also** be made pipeline-aware: when the step is a pipeline, it collapses the N×S task states into
   per-item verdicts (§5) before evaluating `require`, and emits the `items` aggregate. Without this,
   poll/advance would stay task-scoped even with the executor-side fix — so it is a blueprint
   touchpoint of equal weight to the executor change.

v1 makes require/cascade **mode-aware** in both places:
- A `pipeline` executor evaluates `require` over **items**, where an item is `complete` iff its
  *final-stage* task (`_pipeline_stage == S-1`) reached `complete`, and `failed`/`cancelled` iff any
  of its stages did. `require: all` → every item must finish its chain; `require: any` → ≥1 item
  must; `require: N` → ≥N items must.
- **Cascade-cancel is driven solely by item-scoped `_require_unsatisfiable`, never by a raw
  per-stage failure.** (Resolving the Codex gate question + the §3 wording contradiction.) The rule
  is single and consistent: `_cancel_siblings()` fires *iff the item-scoped require policy has become
  unsatisfiable*. The consequences follow from that one rule:
  - `require: all` + any item fails its chain → policy unsatisfiable → cascade-cancel in-flight
    siblings immediately (cost-saving, byte-identical in spirit to parallel_dispatch's behavior,
    just computed over items). This is the v1 answer to the gate question.
  - `require: any` / `require: N` + a single item fails → policy still satisfiable (enough items can
    still finish) → **no** cascade; sibling items keep running. A failed item only drops *its own*
    downstream stages.
  There is no separate "single failure cancels everything" path in pipeline mode — that path
  (`parallel_exec.py:641-642` evaluating require over raw tasks) is exactly what the `is_pipeline`
  flag replaces with the item-scoped computation.
- Per-item downstream cancellation (item i's stage j fails → stage j+1 auto-cancels) is **already
  correct** via the existing upstream-not-complete path (`parallel_exec.py:458-465`); no change.

Budget cutoff (`parallel_exec.py:644-649`) is orthogonal and unchanged — `budget_exhausted` cascade
still applies in pipeline mode (a run-budget breach *should* kill everything).

### 4. Output threading — `{prev}` in stage prompts

`_render_prompt` (`parallel_exec.py:248-257`) gains a predecessor lookup: when the task has exactly
one `depends_on` entry, fetch `self.state.parallel_tasks[dep].result` and add it to the format
kwargs. The predecessor is guaranteed terminal-`complete` before this task renders (the `depends_on`
wait at `parallel_exec.py:457-465` returns only on complete, else the dependent is cancelled before
render).

**Canonical threading rule** (Codex design-gate Medium finding — connector results are not
guaranteed strings; `parallel_exec.py:426-436` returns `output`/`content`/raw payload which may be a
dict/list). v1 binds **two** names so `str.format` never emits a Python `repr`:
- `{prev}` → the predecessor result as a **string**: returned verbatim if already `str`, otherwise
  `json.dumps(result, default=str, ensure_ascii=False)`. This is the safe default for prompt text.
- `{prev_raw}` → the raw object, for templates that index into structured output (e.g.
  `{prev_raw[verdict]}` via `str.format`'s field access). Documented as best-effort on shape.

Keep the existing `KeyError/IndexError → raw template` fallback so a stage that references neither is
fine. Stage 0 has no predecessor → neither name is bound (referencing `{prev}` in stage 0 is a
template error surfaced via the fallback, documented as author error).

### 5. Result shape returned to the consumer

`_evaluate_parallel_results` / the poll-advance path (`server.py:585-659`) returns task results
keyed by task id. For a pipeline the consumer wants **per-item final outputs**, not N×S raw tasks.

**`items` is the canonical aggregate, not a side projection** (Codex design-gate Medium finding —
the result/`ensure` contract must be explicit). For a pipeline step, `process_step_result` builds the
step output as:

```
{
  "items": [ {"item": <source elem>, "status": <item-scoped verdict §3>,
              "result": <final-stage output>, "stages": [<per-stage outputs in order>]} , ... ],
  "require_satisfied": <bool>, "merge_status": <str>,   # existing parallel_dispatch fields, item-scoped
}
```

**The step result is the whole top-level dict above** (`{items, require_satisfied, merge_status}`) —
*not* the bare `items` array. That dict is what `process_step_result` records as the step's `result`
and what `ensure` expressions / downstream `depends_on` steps receive.

**Access contract:** `ensure` wraps only the *top-level* result dict in `SimpleNamespace`
(`executor.py:290`); nested list elements stay plain dicts. So the array is reached by attribute
access on the top-level object — `result.items` — and each element then uses **bracket** access,
e.g. `ensure: "len([i for i in result.items if i['status'] == 'complete']) >= 2"`. v1 keeps `items[]`
entries as plain dicts (no per-element normalization — consistent with how every other nested-list
result behaves today); the blueprint must use bracket access on elements in all pipeline `ensure`
examples/tests. The flat `state.parallel_tasks` dict remains populated (N×S entries) for debugging
and the event stream, but it is **not** the advertised step result.

It is `_evaluate_parallel_results` (§3, item 2) that builds the `items` array inside this result dict
and the item-scoped `require_satisfied`/`can_advance` for the poll/advance path.

**Checksum (precise).** `compute_spec_checksum()` (`executor.py:887`) today fingerprints only
`step_type`, `source`, `require`, `capture_diff`, and `defer_advance` for parallel steps — it does
**not** currently cover `max_concurrent`, `isolation`, `merge`, `task_timeout`, or
`task_reasoning_template`. v1 makes one targeted addition: include the `stages` list (each stage's
`agent` + `intent_template`) in the fingerprint, because `stages` is *spec-defining* — it changes
what the step actually does, so editing a stage prompt must invalidate the cached spec. v1
**deliberately leaves the pre-existing omissions unchanged** (those runtime knobs are out of scope;
widening checksum coverage generally is a separate concern, not this feature's). So the only
checksum delta is: `+ stages`.

## Key decisions

1. **Desugar, don't re-engine.** Pipeline is a compile-to-`depends_on` transform plus three
   surgical executor changes. The staggering we want is an emergent property of the existing
   semaphore + non-slot-holding waiters; we are buying the authoring surface and the
   require/threading semantics, not a new scheduler.
2. **`require` is item-scoped in pipeline mode.** This is the one place pipeline semantics diverge
   from `parallel_dispatch`, and it is deliberate: items are the unit of work, stages are internal.
   Mode-awareness is gated on the executor knowing it's a pipeline (a constructor flag), so
   `parallel_dispatch` behavior is byte-for-byte unchanged.
3. **Per-item failure isolation by default.** A failed item drops its own chain; siblings continue
   unless item-scoped `require` is already unsatisfiable. Matches `pipeline()` semantics and is the
   only sane default for "process this list through these stages."
4. **Per-stage `agent` (cross-model pipelines).** Each stage may name its own connector, so a
   pipeline can interleave Claude and Codex stages — the cross-model property the epic positions as
   Stratum's differentiator, now per stage.
5. **Internal fields are underscore-prefixed** (`_pipeline_item`, `_intent_template`, …) so they
   never shadow a user's source-item field during `str.format`, and they're stripped from anything
   user-facing.
6. **Reuse, not fork, the merge vocabulary.** `merge` keeps its `parallel_dispatch` meaning; v1
   does not add pipeline-specific merge modes.

## Risks / unproven assumptions

- **Require/cascade mode-awareness touches a hot, well-tested function.** Mitigation: gate every
  change behind an `is_pipeline` flag defaulting off; add table-driven tests asserting
  `parallel_dispatch` behavior is unchanged (regression guard), then add pipeline-mode cases.
- **`{prev}` threading assumes single-predecessor.** True by construction for v1 linear pipelines
  (each stage task has exactly one dep). Multi-dep arrives only with fan-out (`-PIPELINE-FANOUT`),
  which will define its own merge-of-inputs semantics. v1 asserts single-dep and falls back to raw
  template otherwise.
- **N×S `parallel_tasks` growth.** A 500-item × 4-stage pipeline seeds 2000 task-state records.
  Runtime concurrency is still bounded by `max_concurrent`, but the persisted `FlowState` grows.
  Acceptable for v1; documented limit. If it bites, a follow-up can lazily materialize downstream
  stage tasks.
- **Stage output is a string (or connector payload), not a typed contract.** `{prev}` interpolates
  whatever the connector returned. Per-stage `task_reasoning_template` gives a cert gate if a stage
  must produce structured output; richer typed stage I/O is out of v1 scope.

## Acceptance criteria

- [ ] `pipeline` is a valid step type; `stratum validate` accepts a well-formed pipeline step and
      rejects: missing `source`, empty/missing `stages`, a stage without `intent_template`, and a
      step-level `intent_template`.
- [ ] Spec round-trip (parse → serialize → parse) preserves `stages`, per-stage `agent`, and
      per-stage `intent_template`; spec checksum changes when `stages` change.
- [ ] A 3-item × 2-stage pipeline runs all 6 tasks via the existing `ParallelExecutor`, and an
      asserted-on event/timeline trace shows **at least one item in stage 1 while another item is
      still in stage 0** (staggering proof — the core capability).
- [ ] Stage *j*'s prompt successfully interpolates stage *j-1*'s result via `{prev}`.
- [ ] Per-stage `agent` routes different stages to different connectors (claude vs codex), verified
      via connector-type assertion.
- [ ] **Per-item isolation:** with `require: any`, one item failing its stage 0 cancels only that
      item's stage 1 and leaves sibling items running to completion (no `_cancel_siblings` across
      items).
- [ ] **Item-scoped require:** `require: all` fails the step iff ≥1 item fails its chain;
      `require: N` passes iff ≥N items complete their full chain.
- [ ] **Regression guard:** existing `parallel_dispatch` require/cascade/cert/budget tests pass
      byte-for-byte unchanged (mode flag defaults off).
- [ ] Budget debit (`debit_budget`) fires once per dispatched stage task, and `budget_exhausted`
      still cascade-cancels the whole pipeline.
- [ ] Consumer result exposes per-item final outputs (`items[].result` / `items[].status`).
- [ ] Full `stratum-mcp` suite green (per-directory convention); CHANGELOG + report written.

## Design-gate resolution (Codex, 2026-05-30)

First Codex design-gate pass raised five design-actionable findings; all folded into the design above:
1. **(High) Per-stage `task_reasoning_template`/`timeout` not wired in the engine** → dropped from
   v1; kept step-level (§1), deferred to `-PIPELINE-STAGEOPTS`; per-stage keys other than
   `agent`/`intent_template` now fail validation loud.
2. **(High) Step-type plumbing incomplete** → added §1a: `pipeline` maps to `parallel_dispatch`
   mode via `_step_mode`, so start/poll/advance gates accept it with zero new branches; desugar is
   deterministic → idempotent re-materialization holds.
3. **(Medium) Scalar vs dict source items** → §2 always binds `{item}`; splats extra fields only for
   dict elements, never clobbering reserved keys.
4. **(Medium) `{prev}` underspecified for structured output** → §4 defines `{prev}` (JSON-stringified)
   + `{prev_raw}` (raw object) threading rule.
5. **(Medium) Result/checksum contract** → §5 declares `items` the canonical aggregate `ensure`
   reads; checksum covers per-stage `agent`/`intent_template`.

**Gate question (cascade on `require: all`)** — resolved in §3: cascade-cancel is driven *solely* by
item-scoped `_require_unsatisfiable`; under `require: all` the first item failure makes the policy
unsatisfiable → immediate sibling cancel (cost-saving, consistent with parallel_dispatch). No
separate raw-failure cancel path in pipeline mode.

Second Codex design-gate pass raised three more, all folded in:
6. **(High) `stratum_parallel_advance` (and the start/done gates) use a RAW `step_type ==
   "parallel_dispatch"` check, not a mode check** → §1a corrected: "zero new branches" was wrong;
   every raw literal must be widened to a mode/membership check (enumerated as a blueprint action).
7. **(High) `_evaluate_parallel_results` computes require/aggregate over raw stage tasks and feeds
   poll/done/advance** → §3 (item 2) + §5: this helper must itself become pipeline-aware (collapse
   to per-item verdicts, emit `items`), not just the executor's cascade. Two require sites, both
   item-scoped.
8. **(Medium) Step-level timeout field is `task_timeout`, not `timeout`** → §1 corrected to the real
   IR field (`spec.py:143`).

Third Codex design-gate pass raised one more:
9. **(Medium) Checksum claim inaccurate** — `compute_spec_checksum` only covers
   `step_type`/`source`/`require`/`capture_diff`/`defer_advance`, not the other parallel fields → §5
   corrected: v1's only checksum delta is `+ stages`; pre-existing omissions left unchanged by design.

Fourth Codex design-gate pass raised one more:
10. **(Medium) `ensure` access contract for `items`** — `ensure` wraps only the top-level result in
    `SimpleNamespace` (`executor.py:290`); nested list elements stay dicts, so `i.status` fails → §5
    corrected: `items[]` entries are plain dicts, use **bracket** access (`i['status']`); blueprint
    uses bracket access in all pipeline ensure examples/tests.
