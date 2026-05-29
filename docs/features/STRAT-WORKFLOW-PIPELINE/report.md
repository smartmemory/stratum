# STRAT-WORKFLOW-PIPELINE — Implementation Report

**Status:** COMPLETE (2026-05-30) · **Owner repo:** stratum · branch `strat-workflow-pipeline`
**Design:** [./design.md](./design.md) · **Blueprint:** [./blueprint.md](./blueprint.md) · **Plan:** [./plan.md](./plan.md)
**Epic:** STRAT-WORKFLOW (forge-top) — ticket 3 of 6 shipped (`-NAMING`/`-IMPERATIVE`/`-BUDGET` prior).

## 1. Summary

Added a `pipeline` IR step type that runs a source list through an ordered series of stages with
**no inter-stage barrier** — item A can be in stage 2 while item B is still in stage 0, so wall-clock
collapses to the slowest single-item chain rather than the sum of per-stage maxima. This is the
cross-client, governed, cross-model answer to Claude Code's `pipeline()` dynamic-workflow primitive.

The whole feature is a **desugar**: a `pipeline` step compiles (`source × stages`) into the existing
`depends_on` task graph and reuses `ParallelExecutor` verbatim — the staggering is an emergent
property of the existing semaphore + non-slot-holding dependency waiters. No second concurrency
engine was added.

## 2. Delivered vs Planned (design acceptance criteria)

| Criterion | Delivered |
|---|---|
| `pipeline` valid step type; validate accepts/rejects | ✅ `spec.py` branch + JSON schema; tests for every rejection |
| Round-trip + checksum covers `stages` | ✅ `compute_spec_checksum` `+stages`; tests |
| Per-item independent chaining, no inter-stage barrier | ✅ staggering proof test (timing-overlap assertion) |
| `{prev}` output threading | ✅ `{prev}` (JSON string) + `{prev_raw}` (object); tests |
| Per-stage agent (cross-model) | ✅ `_agent` per stage; claude→codex routing test |
| Per-item failure isolation | ✅ `require: any` test — sibling items finish, no cross-item cancel |
| Item-scoped require (all / N) | ✅ item-scoped in both require sites; tests |
| Regression guard (parallel_dispatch unchanged) | ✅ `is_pipeline` defaults off; codex-PD-still-certs test; 1740+ existing pass |
| Budget debit per stage task + exhaustion cascade | ✅ unchanged debit path applies per stage task |
| Consumer result exposes per-item outputs | ✅ `items[]` canonical aggregate; `ensure` bracket-access test |

## 3. Architecture deviations from the blueprint

- **`_collapse_pipeline_items` enumerates the full desugared graph, not the reported task subset.**
  The blueprint described collapsing `task_results`; Codex impl-review found that on the
  client-dispatched `stratum_parallel_done` path a caller could satisfy `require: all` by omitting an
  item's tasks. Fixed by treating `pipe_meta` (the full graph) as source of truth — missing stages
  count as `incomplete`. Drove a companion fix: pipeline `require: all` means `item_complete ==
  total_items` (an `incomplete` item is not a pass), not merely `item_failed == 0`.
- **Step-level cert/timeout kept uniform (per-stage cert/timeout deferred).** Design §1 already
  scoped per-stage `task_reasoning_template`/`timeout` out of v1; the executor has no per-task
  override for them. Per-stage `agent`/`intent_template` ship; the rest is `-PIPELINE-STAGEOPTS`.
- **Per-task cert agent-gate scoped to pipeline mode only.** `_run_one`'s historically unconditional
  cert validation now gates on the resolved per-stage agent *only when `is_pipeline`*, keeping
  parallel_dispatch byte-identical (regression-tested).

## 4. Key implementation decisions

1. Single shared `executor.expand_pipeline_tasks` consumed by both `_resolve_dispatch_tasks`
   (dispatch) and `get_current_step_info` (advertised surface) → the two can never diverge.
2. `_step_mode` maps `pipeline → parallel_dispatch` so all start/poll/done gates accept it with no new
   branches; the one **raw** `step_type` literal (`stratum_parallel_advance`) was widened to a mode check.
3. Internal task fields are underscore-prefixed (`_pipeline_item`, `_intent_template`, …) so a dict
   source item's fields never shadow them during `str.format`; reserved keys (`id`/`depends_on`/`item`)
   are never clobbered; scalar items still bind `{item}`.

## 5. Test coverage

`stratum-mcp/tests/test_pipeline.py` — 27 tests: validation (9), checksum/round-trip (2), desugar (2),
staggering (1), threading (2), per-stage agent + cert gate (3), require/isolation (4), evaluator +
collapse + require-bypass (5), ensure-over-items (1). Combined suite (`tests/ stratum-mcp/tests/`,
e2e + docker-live excluded): **1767 passed, 2 skipped**.

## 6. Files changed

`spec.py`, `executor.py`, `parallel_exec.py`, `server.py` (+`tests/test_pipeline.py`).

## 7. Known issues & tech debt

- N×S `parallel_tasks` growth for very large pipelines (documented limit; lazy materialization is a
  future option).
- Deferred to follow-ups: within-stage fan-out + conditional routing (`-PIPELINE-FANOUT`); per-stage
  cert/timeout (`-PIPELINE-STAGEOPTS`); cross-flow-step pipelining (`-BG`).

## 8. Lessons learned

- The review ladder earned its keep at every rung: design gate (6 rounds) fixed the require/threading
  semantics; blueprint gate (4 rounds) caught a *second* live cert path and a two-site validation gap
  that would have left pipeline half-wired; impl review (2 rounds) caught a `require` bypass and an
  empty-string hole the 25 passing tests missed. Each tier found a class the prior tier couldn't.
- Verify-first paid off again: the gap was real (unlike `-IMPERATIVE`), but a key *mechanic*
  (non-slot-holding `depends_on` waiters) already existed — so the feature was sugar + semantics, not
  a new engine.
