# STRAT-WORKFLOW-PIPELINE — Implementation Plan

**Status:** Phase 6 (Compose build, 2026-05-30) · **Owner repo:** stratum
**Design:** [./design.md](./design.md) · **Blueprint:** [./blueprint.md](./blueprint.md)

Dependency-ordered TDD slices. Each slice: write failing test → implement → green → next.
All test files under `stratum-mcp/tests/` (per-directory convention; new
`tests/integration/test_pipeline.py` unless noted). Run `pytest stratum-mcp/tests/` per slice;
full suite + regression guard at the end.

## Slice 1 — Spec layer (no deps)

- [ ] `IRStepDef.stages: tuple | None = None` field (`spec.py:153`).
- [ ] JSON schema: add `"pipeline"` to `type` enum (`spec.py:542`); add `stages` array prop with
      `minItems:1`, items `{required:[intent_template], properties:{agent, intent_template}, additionalProperties:false}` (`spec.py:581-597`).
- [ ] `_build_step`: default `max_concurrent=3` for pipeline (`spec.py:1191`); wire
      `stages=tuple(...)` (`spec.py:1255-1268`).
- [ ] Validation: widen typed gate to include `pipeline` (`spec.py:1408`); add `pipeline` branch
      (require source + non-empty stages; each stage has intent_template + only agent; forbid
      step-level intent_template + reasoning_template). Reject stray `stages`: typed-block check
      (decompose/parallel_dispatch) + add `"stages"` to legacy guard tuple (`spec.py:1494`).
- [ ] **Tests:** accept well-formed pipeline; reject missing source / empty-or-missing stages /
      stage-without-intent_template / step-level intent_template / extra per-stage key /
      reasoning_template / stray `stages` on parallel_dispatch + decompose + inline.
- [ ] **Tests:** round-trip parse→serialize→parse preserves `stages` + per-stage agent/intent_template.

## Slice 2 — Executor helpers (deps: Slice 1)

- [ ] `_step_mode`: `pipeline` → `"parallel_dispatch"` (`executor.py:564`).
- [ ] `_is_pipeline_step(step)` helper (`executor.py:~577`).
- [ ] `expand_pipeline_tasks(step, source_items)` pure helper (`executor.py:~578`) — the N×S desugar
      (ids, depends_on, `_pipeline_item/_pipeline_stage/_intent_template/_agent/item`, dict-splat with
      reserved-key guard, scalar `{item}` binding).
- [ ] `compute_spec_checksum`: add `"stages"` to `_step_fingerprint` (`executor.py:887`).
- [ ] `get_current_step_info` parallel branch: when pipeline, `tasks = expand_pipeline_tasks(...)`,
      add `pipeline:True` + `stages` (`executor.py:1456`).
- [ ] **Tests:** desugar 3×2 → 6 tasks, correct ids/depends_on/`_pipeline_*`; scalar source binds
      `{item}`; dict source splats without clobbering reserved keys.
- [ ] **Tests:** checksum changes on stage intent_template/agent edit; stable on comment-only change.
- [ ] **Tests:** `get_current_step_info` advertises the desugared graph (== `_resolve_dispatch_tasks`).

## Slice 3 — Engine (deps: Slice 2 task shape)

- [ ] `ParallelExecutor.__init__`: `is_pipeline: bool = False` (`parallel_exec.py:152-205`).
- [ ] `_render_prompt`: per-task `_intent_template` override; `{prev}` (str/JSON) + `{prev_raw}` from
      single-dep predecessor `ts.result`; keep raw-template fallback (`parallel_exec.py:248`).
- [ ] `_run_one`: connector from `task["_agent"] or self.agent` (`parallel_exec.py:489`); cert gate
      `if task_reasoning_template and (not is_pipeline or (task['_agent'] or self.agent or 'claude').startswith('claude'))` (`parallel_exec.py:539`).
- [ ] `_require_unsatisfiable`: item-scoped when `is_pipeline` (`parallel_exec.py:264`).
- [ ] **Tests:** staggering proof (stub connector w/ per-stage delays → ≥1 item in stage 1 while
      another in stage 0); `{prev}`/`{prev_raw}` threading; per-stage agent connector types; codex
      stage skips cert / claude stage cert-checked.
- [ ] **Tests (regression guard):** existing `test_parallel_*` unchanged; a codex **parallel_dispatch**
      step still cert-validates unconditionally (is_pipeline off).

## Slice 4 — Server wiring (deps: Slices 2+3)

- [ ] `_resolve_dispatch_tasks`: pipeline → `expand_pipeline_tasks` (`server.py:887`).
- [ ] `_evaluate_parallel_results`: pipeline-aware item collapse + item-scoped require + `items`
      aggregate; per-task-agent cert gate (`server.py:585-661`).
- [ ] `stratum_parallel_start`: `is_pipeline=` kwarg on `ParallelExecutor` (`server.py:1083`).
- [ ] `stratum_parallel_advance`: widen raw gate to `_step_mode(step) == "parallel_dispatch"` (`server.py:1303`).
- [ ] **Tests (end-to-end via start→poll, and defer_advance→advance):** full pipeline runs; per-item
      isolation under `require:any` (one item fails → siblings finish, no cross-item cancel);
      item-scoped require (`all` fails iff ≥1 item fails; `2` passes iff ≥2 complete); budget debit
      once per stage task + budget_exhausted cascade; `ensure` reads `result.items` + `i['status']`.

## Exit criteria (Phase 7 gate)

- [ ] All slice tests green; new `test_pipeline.py` covers the 11 blueprint test targets.
- [ ] Full suite: `pytest stratum-mcp/tests/` green (per-directory convention).
- [ ] Codex review loop on the implementation → REVIEW CLEAN.
- [ ] Coverage sweep → TESTS PASSING.
