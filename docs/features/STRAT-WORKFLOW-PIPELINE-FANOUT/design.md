# STRAT-WORKFLOW-PIPELINE-FANOUT — Design

**Status:** Phase 1 design (2026-05-30) — revised after Codex design-gate **round 1** (6 findings
folded in: (H) one explicit split-output contract — JSON-string parsed, else must already be a list;
(H) `when`/`exit_when` **banned in the fanout region** in v1, which also removes the "filled lane ends
`skipped`" ambiguity so unfilled-lane skips are the only skips in a region; (H) empty-list require is
uniform — zero filled lanes satisfies only `all`, `any`/`N` make it unsatisfiable; (H) a single shared
lane-input helper feeds both the lane's `{item}` and the first per-lane stage's `{prev}`
as `L[k]` (not the whole split result); (M) explicit parse-time rejection of route predicates on
split/lane/join stages; (M) the join cancellation is a **new** join-specific dep-gate branch, not reuse
of the single-dep path). Revised again after **round 2** (3 new findings: (H) the lane helper is split
into a two-part API — `_resolve_fanout_list` + `_lane_is_filled` (fill test) vs `_effective_lane_input`
(`L[k]` lookup, only on filled lanes) — so an unfilled lane never indexes a missing `L[k]`; (M) removed
a stale `fanout.over` reference (the IR has no source-path field; only the split-result parse is new);
(M) a concrete `_collapse_pipeline_items` K-way reduction rule — per-item stages map to `stages[]`,
per-lane stage indices emit none, the full lane-id graph is enumerated for the client-report guard).
Revised again after **round 3** (2 findings: (H) the split-output contract now has an explicit
executable hook — a **split-role validation branch in `_run_one`**, post-cert/pre-terminal, that fails
the split task on a bad/over-cap list and memoizes `len(L)`; (M) the server derives filled-vs-unfilled
from **lane status** (`skipped` ⇒ unfilled, valid because predicates are banned in-region) with no
list re-resolver, and fan-out *execution* is server-dispatched only, mirroring `-ROUTE`). Revised after
**round 4** (1 finding: the status-fill inference is sound only on executor-produced traces, so a
fanout/join pipeline submitted via `stratum_parallel_done` is **rejected** in v1 rather than risk
mis-aggregating arbitrary client-reported `skipped` lanes).
Carved from the original `-PIPELINE-FANOUT` row; v1 = **bounded, data-driven
map-reduce** only (split a runtime list into ≤K parallel lanes, reduce survivors in a join stage).
Unbounded fan-out and fixed-count replicate are deferred (see Out of scope). Not yet implemented.
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP)
**Related:** [[project_strat_workflow_epic]], [[feedback_ship_narrow_first]]; builds directly on
[`STRAT-WORKFLOW-PIPELINE`](../STRAT-WORKFLOW-PIPELINE/design.md) (the desugar + item-scoped require)
and [`STRAT-WORKFLOW-PIPELINE-ROUTE`](../STRAT-WORKFLOW-PIPELINE-ROUTE/design.md) (the `skipped`
task state, which unfilled lanes reuse verbatim).

## Problem

`-PIPELINE` runs each source item straight down its stage chain (1 task per stage, exactly one
predecessor each). `-ROUTE` added conditional skip/early-exit on that chain. Neither can express the
other half of the dynamic-workflow `pipeline()`/`parallel()` idiom: **fan-out** — one stage produces
a list, each element runs its own downstream lane in parallel, and a later stage **reduces** the lane
outputs back into one result. Concretely:

```
doc → list sections → [summarize §1] ┐
                      [summarize §2] ┼→ synthesize one summary → …
                      [summarize §3] ┘
```

Two real patterns are blocked today:
1. **Map** — run a stage once per element of a runtime-discovered list, in parallel.
2. **Reduce / join** — collapse those parallel lane outputs into a single downstream stage. This
   requires a task with **more than one predecessor**, which the engine has never had (every task
   binds exactly one `{prev}`).

## Scope decision (carved from -PIPELINE-FANOUT)

The original `-PIPELINE-FANOUT` row bundled three separable capabilities. Reading the source
(`parallel_exec.py` in full) pins the split by cost:

| Capability | Fits the static task set? | This feature? |
|---|---|---|
| **Bounded, data-driven fan-out** (split a list into ≤K lanes; K is an author-set cap) + **join** | **Yes** — always materialize K lanes; lanes past the runtime list length ride the `-ROUTE` `skipped` path; the join is a >1-dep task on the *same* static graph | **v1 (this doc)** |
| Fixed-count replicate (always K lanes on the same input, best-of-N) | Static-compatible | deferred (fast follow) |
| Unbounded fan-out (runtime K, no author cap) | **No** — needs mid-run task injection into `ParallelExecutor`'s construction-fixed task set | deferred → `-PIPELINE-FANOUT-DYNAMIC` |

v1 ships bounded data-driven map-reduce on the existing N×S(×K) static grid, **no new concurrency
engine and no mid-run task injection**. The single genuinely new primitive is the **multi-predecessor
join** (a stage with >1 dep + a list-of-survivors binding). `-PIPELINE-FANOUT-DYNAMIC` stays PLANNED.

## Verified architecture (read the source, don't infer)

- **Desugar is a pure, deterministic grid.** `expand_pipeline_tasks` (`executor.py:638`) emits
  `f"{step.id}::item{i}::stage{j}"`, each depending on the same item's previous stage. Re-derived
  byte-identically on every start/poll/advance call. Fan-out extends the id with a lane dimension and
  emits the join's multi-dep edge — still pure and deterministic from `(source, stages, K)`.
- **The static-task-set wall.** `ParallelExecutor.run()` creates **every** asyncio task up front
  (`parallel_exec.py:251`) and seeds the completion-event map once (`:209`). No task can be injected
  mid-run. **This is why fan-out must be bounded:** K lanes are materialized at construction; lanes
  the runtime list doesn't fill are *skipped*, not *added*.
- **`skipped` already exists** (`-ROUTE`). `_route_skip` (`parallel_exec.py:318`) skips a task before
  dispatch (no `started_at`, no budget charge), carries a passthrough result, and the dep-gate at
  `parallel_exec.py:628` already treats a `skipped` predecessor as a proceed-signal
  (`not in ("complete", "skipped")`). An unfilled lane is exactly a skipped task — **zero new task
  state.**
- **Per-item runtime flags pattern exists.** `_item_exited` (`parallel_exec.py:215`, set at `:388`,
  read at `:334`) is a plain dict mutated in the single-flow async context, observed by downstream
  tasks via the done-event. Fan-out adds an identical `_item_fanout_count[item_idx]` recording the
  runtime list length so lanes know fill-vs-skip. No lock (same context as `_task_terminal_state`).
- **Single-predecessor is hard-wired in two places** — both must grow a multi-dep branch:
  - `_render_prompt` (`parallel_exec.py:264`) binds `{prev}`/`{prev_raw}` only `if len(deps) == 1`
    (`:277`). The join (>1 dep) needs `{prevs}`/`{prevs_raw}`.
  - the dep-gate (`parallel_exec.py:628`) cancels a task if its single predecessor isn't terminal-ok.
    For a join it must wait for **all** lanes terminal, then apply lane-require over survivors.
- **Item completion is computed in two places** that must learn lanes (both already pipeline-aware):
  `_item_counts` (`parallel_exec.py:395`, groups by `_pipeline_item`) and the server-side
  `_collapse_pipeline_items` / `_evaluate_parallel_results`. A skipped lane is settled-non-failure
  (handled by `-ROUTE` already); the new case is **lane-require unsatisfiable → item fails**.
- **Safe expression jail exists** but **fan-out introduces no predicates** in v1 (lane count is
  data-driven, not expression-driven; route predicates are banned in the region) — so **no new jail
  usage and no new IR source-path field.** The `fanout` block is just `{max, require}`; the only new
  runtime resolution is parsing/coercing the split stage's own result into the lane list `L` (§2
  split-output contract).
- **IR validation has two sites.** The pipeline-stage JSON schema (`spec.py:596-613`) and the semantic
  `_STAGE_KEYS` allowlist + per-stage checks (`spec.py:1534`). Both must admit `fanout`/`join`.

## Design

### 1. IR surface — two markers on the flat `stages` list

Consistent with how `-ROUTE` (`when`/`exit_when`) and `-STAGEOPTS` (`task_timeout`/cert) extended the
model: per-stage optional fields, **no nested structure**.

```yaml
- id: process
  type: pipeline
  source: $.input.docs            # ITEM-scoped source (unchanged from -PIPELINE)
  max_concurrent: 8               # bounds TOTAL concurrent agents across items × lanes × stages
  require: all                    # ITEM-scoped require (unchanged)
  stages:
    - intent_template: "List the sections of {item}. Return a JSON array of section objects."
      fanout: { max: 8, require: any }     # ← split: result is the list to fan out over (see §2 contract)
    - intent_template: "Summarize section {item[title]} of doc {source[id]}."   # PER-LANE: {item}=L[k]
    - intent_template: "Synthesize one summary from these: {prevs}"             # JOIN (>1 dep)
      join: true
```

- **`fanout`** (object, on the **split** stage): `{ max: <int K ≥ 1>, require: "all"|"any"|<int> }`.
  `max` (**K**) is the lane cap. `require` is **lane-scoped** (default `"all"`). The split stage runs
  once per item and its result is the list to fan out over.
- **`join: true`** (bool, on the **reduce** stage): this stage depends on all K lane-terminal tasks
  and binds `{prevs}` (see §4). Runs once per item.
- **Region** = the stages strictly between the `fanout` stage and the `join` stage run **per-lane**;
  the `fanout` stage and everything from `join` onward run **per-item**. The **fanout region** =
  the `fanout` (split) stage, the per-lane stages, and the `join` stage.
- **v1 shape constraint (validated loud):** exactly **one** `fanout` stage and exactly **one** `join`
  stage, the `join` strictly after the `fanout`, with **≥1 per-lane stage** between them,
  `fanout.max ≥ 1`, `fanout.require ∈ {"all","any",int ≥ 1}`. Anything else (a `fanout` with no
  `join`, a `join` with no `fanout`, two of either, `join` before `fanout`, zero per-lane stages,
  nested fan-out) is a parse-time spec error.
- **Route predicates are banned in the fanout region in v1 (Codex round-1 H2/H5/M5).** A `fanout`,
  per-lane, or `join` stage may **not** carry `when`/`exit_when` — rejected at parse time. Rationale:
  the only `skipped` lanes in a region are then the unfilled ones (`k ≥ len(L)`), which carry no real
  data, so excluding them from `{prevs}` (§4) is unambiguous. (`when`/`exit_when` on **pre-fanout** and
  **post-join** stages — normal single-chain stages — stay valid; combining routing *inside* a lane is
  a deferred follow-up.)

### 2. Desugar — bounded lanes on the static grid

`expand_pipeline_tasks` (`executor.py:638`) gains a lane dimension only for per-lane stages. For
source item `i`, fanout stage at index `f`, per-lane stages `j ∈ (f, join_idx)`, join at `join_idx`:

- **Pre-fanout** stages `0..f` (inclusive): one task each, `item{i}::stage{j}`, straight chain
  (unchanged).
- **Per-lane** stages: **K** tasks each, `item{i}::stage{j}::lane{k}` for `k ∈ [0,K)`.
  - first per-lane stage, lane `k`: `depends_on = [item{i}::stage{f}]` (the split stage).
  - subsequent per-lane stage, lane `k`: `depends_on = [item{i}::stage{j-1}::lane{k}]`.
- **Join** stage: one task `item{i}::stage{join_idx}`, `depends_on = [item{i}::stage{last_lane}::lane{k}
  for k in [0,K)]` — **the K-way multi-dep edge** (the new primitive).
- **Post-join** stages: one task each, straight chain from the join (unchanged).

**Split-output contract (Codex round-1 H1 — the engine stores connector output verbatim;
`parallel_exec.py:733` does no list coercion).** When the split stage completes, its `ts.result` is
resolved to the fan-out list `L` by a single rule:
- already a Python `list` → used as-is;
- a `str` → parsed with `json.loads`; result must be a JSON array (→ `list`), else the **split stage
  task fails** (`"fanout stage result is not a JSON array"`);
- anything else (dict, number, etc.) → split stage task fails (`"fanout stage result is not a list"`).
This is the one place fan-out parses output; it is intentionally narrow (JSON array or native list),
documented as the v1 contract. The split stage's prompt is expected to return a JSON array (per the §1
example); a stage that needs structured-list output can attach a step-level `task_reasoning_template`
cert as usual.

**Where the contract executes (Codex round-3 H — there was no hook; `_run_one` commits the connector
result verbatim and marks the task `complete` at `parallel_exec.py:733`/`:755` before any fanout
point).** v1 adds a **split-role validation branch in `_run_one`**, evaluated *after* the connector
result + cert resolve (`:733`–`:755`) but *before* terminal completion is committed: when
`_pipeline_role == "split"`, resolve `L` via `_resolve_fanout_list` and apply the contract **plus the
`len(L) > K` cap check**. On any violation (non-list / non-array string / over-cap) the **split task is
marked `failed`** (with the documented message) instead of `complete`; otherwise it commits `complete`
and `_item_fanout_count[i] = len(L)` is memoized here, so downstream lanes read a value that is already
resolved and validated (they never re-parse or re-fail). This is the single eager resolution point;
`_effective_lane_input` (§ runtime fill) only *reads* the memoized list for a filled lane.

The grid is fully materialized at construction (K is the author cap, known statically). **Runtime
fill** happens once `L` is resolved.

**Two-part helper API (Codex round-2 H1 — a single "return `L[k]`" helper can't also describe an
unfilled lane, which has no `L[k]`).** Lane resolution is split into a fill test and an input lookup,
both backed by one cached list resolution so they can't drift:
- **`_resolve_fanout_list(split_id) → list`** — fetch the split task's `ts.result`, apply the §2
  split-output contract, and memoize `_item_fanout_count[i] = len(L)`. **Called once per item, by the
  split-role branch at split completion** (above); by the time any lane runs, the split task is already
  terminal — `complete` with a memoized valid `L`, or `failed` (and its lanes auto-cancel via the
  existing upstream-not-complete path). Lanes therefore never call this or re-parse.
- **`_lane_is_filled(task) → bool`** — `task["_fanout_lane"] < _item_fanout_count[i]`. Used by the
  skip path: an **unfilled** lane (`k ≥ len(L)`) **skips** via the `-ROUTE` machinery (`_route_skip`
  extended to return skip for an over-cap lane) — state/budget/done-event handled, **no `L[k]`
  lookup**.
- **`_effective_lane_input(task) → L[k]`** — returns `L[task["_fanout_lane"]]`. **Only ever called for
  a filled lane** (after `_lane_is_filled` passed and the lane dispatched), so the index is always in
  range. Consumed by `_render_prompt` for `{item}` and the first-lane `{prev}` (§3).

So the fill decision and the input lookup share one list resolution but are distinct calls: unfilled
lanes never reach `_effective_lane_input`, and a filled lane's `{item}`/first-`{prev}` are guaranteed
the same in-range `L[k]`.

New internal task fields (underscored, never shadow user item fields):
`_fanout_lane` (k, lane index), `_pipeline_role ∈ {plain, split, lane, join}`, and on lane/join tasks
a back-pointer `_fanout_split_id = item{i}::stage{f}` so the helper can fetch `L`.

### 3. Lane input binding — `{item}` re-bound, `{source}` preserved

In a **per-lane** stage, `_render_prompt` rebinds (all lane input via `_effective_lane_input`, §2):
- **`{item}`** = `L[k]` — the lane's element of the split list (scalar or dict; dict fields splat as
  `{item[field]}` via `str.format` field access, matching the existing dict-source convention).
- **`{source}`** / **`{source_raw}`** = the **original source item** (the doc that was split), so a
  lane can reference both its element and its parent (`"summarize {item[title]} of {source[id]}"`).
  `{source}` is the JSON-stringified form, `{source_raw}` the raw object (mirrors `prev`/`prev_raw`).
  Bound from the lane task's own `item` field (the source item, carried on every task by the desugar).
- `{prev}`/`{prev_raw}` on the **first** per-lane stage = the lane element `L[k]` (via the helper, **not**
  the split task's verbatim result `L`); on a **subsequent** per-lane stage = the previous per-lane
  stage's single-dep result (the existing `{prev}` path, unchanged).

So for lanes, `{item}` and the first-stage `{prev}` are the *same* value (`L[k]`) — the helper is the
single resolver, eliminating any chance that one sees `L[k]` and the other sees the whole `L`.

### 4. The join — multi-predecessor reduce (the one new primitive)

A `join: true` task has K predecessors. Two engine changes, both gated on a `_pipeline_role == "join"`
check so single-dep behavior is byte-for-byte unchanged:

- **`_render_prompt` (multi-dep branch).** When the task is a join, bind:
  - **`{prevs}`** = JSON list of the **surviving** lane results — i.e. results of the **filled** lanes
    (`k < len(L)`) whose terminal state is `complete`. Unfilled lanes (`k ≥ len(L)`, `skipped`) are
    excluded because they carry no real data; failed/cancelled filled lanes are excluded as
    non-survivors. (Filled lanes cannot end `skipped` in v1 — route predicates are banned in the
    region, §1 — so `skipped` unambiguously means "unfilled".) `json.dumps(list, default=str,
    ensure_ascii=False)`.
  - **`{prevs_raw}`** = the raw Python list of those surviving results.
  - `{source}`/`{source_raw}` also bound (the join is per-item; the original item is available).
- **Dep-gate — a NEW join-specific branch (Codex round-1 M6), not the single-dep path.** The existing
  gate (`parallel_exec.py:628`) cancels a task the moment its *first* predecessor is not
  `complete`/`skipped`; it neither waits for all predecessors nor evaluates `require`, so a join cannot
  reuse it. A `_pipeline_role == "join"` task takes a distinct branch: **wait for all K predecessor
  lanes to reach a terminal state** (`complete`/`failed`/`cancelled`/`skipped`), then evaluate
  **lane-require** over the **filled** lanes (`k < _item_fanout_count[i]`; unfilled/skipped lanes are
  not counted):
  - filled-complete count satisfies `fanout.require` → **dispatch the join** over survivors.
  - unsatisfiable → **mark the join cancelled and fail the item** (reduce-impossible). This is new
    cancellation logic in the join branch (it sets the join's terminal state directly), *not* the
    existing first-bad-predecessor early cancel.
- **`require` evaluation is uniform, including the empty case (Codex round-1 H3).** Let `c` =
  filled-complete count, `n` = filled count (`= len(L)`). `all` → satisfied iff `c == n`; `any` →
  iff `c ≥ 1`; `N` → iff `c ≥ N`. **Empty list (`n = 0`) is not special-cased** — it falls out of the
  same rule: `all` → `0 == 0` satisfied → join runs with `{prevs} = []`; `any` → `0 ≥ 1` false →
  unsatisfiable → item fails; `N (≥1)` → `0 ≥ N` false → item fails. So "join runs on empty" holds
  **only for `require: all`**; under `any`/`N` an empty split fails the item, consistently with a
  non-empty split where too few lanes completed.

### 5. Two require scopes (both reuse `all|any|N`)

- **lane-require** (`fanout.require`, default `all`): how many **filled** lanes must complete for the
  join to run. New, evaluated in the join dep-gate (§4).
- **item-require** (step-level `require`, default unchanged): how many **items** complete their full
  chain. Unchanged from `-PIPELINE`.

`_item_counts` (`parallel_exec.py:395`) is extended: an item is **failed** iff any **non-lane** stage
failed/cancelled, **or** its lane-require is unsatisfiable (so the join can't run). A lane failure
alone — when lane-require still holds — is **not** an item failure. An item is **complete** iff no
non-lane stage and no required lane-set is failing and nothing is pending/running. Skipped lanes are
settled-non-failure (already true via `-ROUTE`).

### 6. Failure & edge semantics

- **Lane fails →** dropped from `{prevs}`; the join runs over survivors if lane-require holds (else
  the item fails). Matches `pipeline().filter(Boolean)`.
- **`len(L) > K` →** the **split stage task fails** with a clear message
  (`"fanout list length {len} exceeds max {K}"`). This is the honest boundary of *bounded* fan-out —
  the author asserts ≤K; unbounded is `-PIPELINE-FANOUT-DYNAMIC`. A split-stage failure is a non-lane
  failure → the item fails (no partial map over a truncated list).
- **`L` not resolvable to a list →** per the §2 split-output contract: a JSON-string that doesn't
  parse to an array, or any non-`list`/non-`str` result, **fails the split stage task** (fails closed;
  cannot be caught at parse time since it's runtime output).
- **`L` empty (`len 0`) →** all K lanes skip; lane-require is evaluated **uniformly** (§4): only
  `require: all` is satisfied at zero (join runs with `{prevs} = []`, "reduce of empty"); `require:
  any`/`N` are unsatisfiable at zero → the item fails. No special-case — same rule as a non-empty
  split with too few completes.
- **Budget:** a skipped (unfilled) lane never dispatches → no `started_at`, no debit (existing skip
  path). Filled lanes and the join debit normally. `budget_exhausted` cascade still applies.
- **No new task state** — fan-out is entirely expressed with `complete`/`failed`/`skipped`.

### 7. Server-side surfaces

`pipeline` already maps to `parallel_dispatch` mode (`_step_mode`, `executor.py:698`), so
start/poll/advance accept it unchanged. `skipped` is already recognized at every terminal-state
surface (`-ROUTE`). Fan-out adds **no new task state and no new MCP tool**.

**`_collapse_pipeline_items` reduction rule (Codex round-2 M3 — it groups by `_pipeline_stage` and
emits one `stages[]` entry per reported task; lane tasks share a stage index, so a K-way reduction
must be defined).** The collapse reconstructs the **expected** desugared graph (pure/deterministic
from `source × stages × K`, the same enumeration the desugar uses), classifies each task id by its
role (`plain` / `split` / `lane` / `join` / post-join `plain`), and per item `i`:

- **`items[i].stages`** carries one entry **per per-item stage index in order** — i.e. the pre-fanout
  `plain` stages, the `split` stage, the `join` stage, and any post-join `plain` stages, each mapped to
  that stage's single task result. **Per-lane stage indices emit no `stages[]` entry** (lane-level
  detail lives in the per-task trace, §8) — so the array stays a clean per-item stage list with stable
  ordering, and no stage index ever maps to >1 entry.
- **`items[i].result`** = the `join` task's result (the reduce). If there are post-join stages, the
  last post-join `plain` task's result (existing `final_sr` extraction, unchanged).
- **Per-item verdict:** `failed` iff any per-item-stage task (`plain`/`split`/`join`) is
  `failed`/`cancelled`, **or** the `join` was cancelled by unsatisfiable lane-require (§4). `complete`
  iff every per-item stage is `complete` **and** every per-lane stage index is *settled* — where a
  per-lane stage is settled iff **all K** of its lane tasks are terminal (`complete`/`skipped`/`failed`),
  with the filled ones satisfying lane-require. Else `incomplete`.
- **Filled-vs-unfilled is read from lane status, not re-resolved — on the executor-produced trace only
  (Codex round-3 M / round-4 M).** The collapse and `_evaluate_parallel_results` do **not** need a
  fanout-list resolver: in an **executor-produced** trace (`stratum_parallel_start`/`poll`/`advance`),
  `_route_skip` is the *only* in-region skip source once predicates are banned (§1), so **`skipped` ⇒
  unfilled, any dispatched terminal state (`complete`/`failed`/`cancelled`) ⇒ filled.** Lane-require is
  evaluated over `complete` filled lanes vs the filled count, both derived purely from those statuses.
  (Empty `L` ⇒ all K lanes `skipped` ⇒ filled-count 0 ⇒ `require: all` satisfied / `any`·`N` not —
  matching §4, no list re-resolution.) The executor resolves `L` once (to *make* the skip decisions);
  the server only *reads* the statuses those decisions produced, so the two agree by construction. This
  inference is trusted **only** for executor output — it is **not** valid for arbitrary client-submitted
  statuses (a client could report `skipped` for any reason), which is exactly why fanned-out
  client-dispatch is unsupported (below).
- **Client-reported validation:** the `-PIPELINE` require-bypass guard (a `missing` expected task ≠
  complete) is enumerated over the **full** expected graph **including all K lane ids per per-lane
  stage** — a client that omits some lane ids leaves that stage `incomplete`, never silently complete.

This mirrors the executor's `_item_counts` change (§5) so the server-dispatched and client-reported
paths agree on the item verdict.

**Scope: fan-out is server-dispatched only, and a fanned-out graph via `stratum_parallel_done` is
rejected in v1 (Codex round-4 M; mirrors `-ROUTE`).** Lane-fill skipping and the require-aware join
gate run inside `ParallelExecutor`, so they only fire on `stratum_parallel_start`. Because the
status-based fill inference above is sound **only** for executor-produced traces, v1 does not accept a
client driving a fanout/join graph itself: `stratum_parallel_done` **rejects** a pipeline step whose
`stages` contain a `fanout`/`join` (a clear "fanned-out pipelines are server-dispatched only" error)
rather than silently mis-aggregating client-reported `skipped` lanes. Non-fanout pipelines and plain
`parallel_dispatch` keep their existing `stratum_parallel_done` support unchanged.

### 8. Result shape

Unchanged top-level contract (`{items, require_satisfied, merge_status}` from `-PIPELINE`). For a
fanned-out item, `items[].result` = the **join stage's** output (the reduce), and `items[].stages`
carries the per-stage results in order (the fanout region appears as the split result, then the join
result — lane-level detail lives in the per-task trace, not the `ensure`-facing `items[]` contract,
consistent with `-ROUTE` §5).

## Acceptance criteria

- [ ] `fanout: {max, require}` and `join: true` added to **both** the pipeline-stage JSON schema
      (`spec.py:596-613`) and the semantic `_STAGE_KEYS` allowlist (`spec.py:1534`); both optional,
      `additionalProperties: False` preserved.
- [ ] **Shape validation:** exactly one `fanout` stage + exactly one `join` stage, `join` strictly
      after `fanout`, ≥1 per-lane stage between them, `fanout.max ≥ 1`, `fanout.require ∈ {all,any,int≥1}`.
      A `fanout` without a `join`, a `join` without a `fanout`, two of either, `join` before `fanout`,
      or zero per-lane stages → parse-time `IRSemanticError`. Non-pipeline steps reject both keys.
- [ ] **Route predicates banned in the region:** a `when`/`exit_when` on the `fanout`, any per-lane, or
      the `join` stage → parse-time `IRSemanticError`; the same predicates on pre-fanout / post-join
      stages still validate.
- [ ] **Split-output contract:** the split stage's result is a `list` (used as-is) or a JSON-array
      string (parsed); a non-array string, or any non-list/non-str result, **fails the split stage** with
      the documented message.
- [ ] **Two-part lane API:** `_resolve_fanout_list` (parse/memoize `len(L)`) backs both `_lane_is_filled`
      (the skip test — an unfilled lane skips and never indexes `L`) and `_effective_lane_input` (the
      `L[k]` lookup, only reached on a filled lane); an asserted test shows the first per-lane stage
      receives `L[k]`, never the whole split list `L`, and an over-cap lane resolves to `skipped` with no
      index error.
- [ ] **Server collapse:** `_collapse_pipeline_items` emits one `items[].stages` entry per **per-item**
      stage (pre-fanout, split, join, post-join) in order and **none** for per-lane stage indices;
      `items[].result` = join (or last post-join) result; a per-lane stage counts settled only when all K
      lane ids are terminal; the client-report `missing`-guard enumerates the full lane-id graph.
- [ ] Spec round-trips `fanout`/`join`; the `stages` dict is fingerprinted wholesale
      (`executor.py` checksum), so editing `fanout.max`/`require` or `join` invalidates the cached spec
      with no separate checksum change (confirm against source).
- [ ] **Desugar:** the §1 example (P items; stages = split, 1 per-lane, join) materializes exactly
      `P×(2 + K)` tasks — `P` split (per-item) + `P×K` lane + `P` join; lane ids are
      `item{i}::stage{j}::lane{k}`; each join task's `depends_on` lists all K of its item's last-lane
      tasks; ids are byte-identical across re-materialization. (General form: per-item stages count
      once, per-lane stages count K times.)
- [ ] **Runtime fill via skip:** split stage returns a list of length `m ≤ K`; lanes `0..m-1` dispatch
      with `{item}=L[k]`; lanes `m..K-1` are `skipped` (no `started_at`, no budget debit). Asserted on
      the trace.
- [ ] **Split-role validation hook:** a `_pipeline_role == "split"` task runs the contract + `len(L) > K`
      check inside `_run_one` *after* cert resolves and *before* terminal commit; a violation marks the
      split task `failed` (not `complete`); a valid list commits `complete` and memoizes `_item_fanout_count`.
- [ ] **Server reads fill from status:** `_collapse_pipeline_items`/`_evaluate_parallel_results` treat a
      `skipped` lane as unfilled and any dispatched terminal lane as filled — no fanout-list re-resolution;
      empty `L` (all K skipped) gives filled-count 0 so `require: all` runs the join and `any`/`N` fail the item.
- [ ] **Server-dispatched only:** lane-fill skipping + the join require-gate fire on `stratum_parallel_start`;
      `stratum_parallel_done` **rejects** a pipeline whose `stages` contain a `fanout`/`join` with a clear
      error; non-fanout pipelines + plain `parallel_dispatch` keep `_done` support unchanged.
- [ ] **`len(L) > K`** fails the split stage with the documented message → item fails; **empty list**
      → all lanes skip and require is uniform: `require: all` runs the join with `{prevs}=[]`, while
      `require: any`/`N` make it unsatisfiable → the item fails.
- [ ] **Lane binding:** a per-lane stage interpolates `{item}` = lane element and `{source}` =
      original source item (dict field access works for both); first per-lane stage's `{prev}` = the
      lane element.
- [ ] **Join binding:** a `join` task binds `{prevs}` (JSON list of surviving lane outputs) and
      `{prevs_raw}` (raw list); single-dep `{prev}` behavior unchanged for non-join tasks.
- [ ] **lane-require:** with `fanout.require: any`, one lane failing leaves the join running over the
      surviving lanes and the item completing; with `require: all`, one lane failing makes lane-require
      unsatisfiable → join cancelled, item fails; `require: N` passes iff ≥N filled lanes complete.
- [ ] **item-require unchanged:** step-level `require` still evaluated over items; a fanned-out item is
      complete iff no non-lane stage failed and lane-require held.
- [ ] **Regression guard:** a pipeline with no `fanout`/`join` behaves byte-identically to today; a
      non-pipeline `parallel_dispatch` is untouched; single-dep `{prev}` path unchanged; mode flag /
      role gates default to the pre-fanout behavior.
- [ ] **Staggering proof:** an asserted trace shows at least one lane of item A running while another
      lane (or item B's split) is still earlier in the grid — the existing non-slot-holding waiters
      give this for free; confirm it survives the multi-dep join.
- [ ] Full combined suite green (`tests/ stratum-mcp/tests/`); CHANGELOG entry in the same commit;
      report written; forge-top ROADMAP row flipped with evidence.
- [ ] Codex design gate: REVIEW CLEAN.

## Out of scope (named follow-ups)

- **Unbounded fan-out** (runtime lane count with no author cap) → `-PIPELINE-FANOUT-DYNAMIC`. The real
  engine change: mid-run task injection into `ParallelExecutor`'s construction-fixed task set.
- **Fixed-count replicate / best-of-N** (always K lanes on the same input, `{lane}` index, prompt
  diverges by index) → fast follow on this feature's grid (it's the same lane machinery without the
  list-split source).
- **Nested fan-out** (a lane that itself fans out) and **multiple fanout regions** in one pipeline.
- **Fan-out combined with `when`/`exit_when`** inside a lane (routing within lanes) — each primitive
  works; their interaction is a separate validation matrix, deferred. **Pre-fanout `exit_when` is also
  banned** (impl-review): an item early-exiting before the region would skip the whole region, which the
  join's require-gate would misread as unfilled lanes — so pre-fanout early-exit is rejected at parse
  time. (Pre-fanout `when` is allowed; post-join `exit_when` is allowed.)
- **Per-lane `agent` differing from the per-lane stage's `agent`** beyond the existing per-stage
  `agent` field — lanes of one stage share that stage's connector in v1.
- **Cross-item fan-out** (splitting across the source list rather than within an item) — predicates
  and lanes see only their own item's chain.
- **Client-dispatched fan-out** — lane-fill skipping and the join require-gate are executor-side
  (server-dispatched) only, mirroring `-ROUTE`; a fanout/join pipeline submitted via
  `stratum_parallel_done` is **rejected** in v1 (not silently mis-aggregated).
