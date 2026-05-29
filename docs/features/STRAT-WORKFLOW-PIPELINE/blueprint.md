# STRAT-WORKFLOW-PIPELINE — Implementation Blueprint

> **This is a forward-looking PLAN, not a description of current code.** Every file:line below was
> read on branch `strat-workflow-pipeline` @ `0ba31e4` and is current as of 2026-05-30.

**Status:** Phase 4-5 (Compose build, 2026-05-30)
**Owner repo:** stratum · **Design:** [./design.md](./design.md)
**Scope:** v1 — linear stages, 1:1 per item, prev-stage output threading, item-scoped require.
Desugar `pipeline` → existing `depends_on` task graph; reuse `ParallelExecutor`.

The change is one cohesive slice across four modules. The single load-bearing insight: **the desugar
lives in one function (`_resolve_dispatch_tasks`, server.py:887) that start/poll/advance all call**, so
the N×S task graph is materialized identically and idempotently on every path.

---

## Touchpoints

### `stratum-mcp/src/stratum_mcp/spec.py` — IR surface + validation

| What | Location | Change |
|---|---|---|
| `IRStepDef` dataclass | `spec.py:128-153` | Add field `stages: tuple | None = None` (list of `{agent?, intent_template}` dicts) alongside the v0.3 parallel fields. |
| JSON-schema step `type` enum | `spec.py:541-543` | Add `"pipeline"` to the enum `["function","inline","flow","decompose","parallel_dispatch"]`. |
| JSON-schema properties | `spec.py:581-597` | Add `"stages"`: `{type: array, minItems: 1, items: {type: object, additionalProperties: false, required: ["intent_template"], properties: {agent: {type: string}, intent_template: {type: string}}}}`. |
| `_build_step` default max_concurrent | `spec.py:1189-1192` | Widen `if step_type == "parallel_dispatch"` → `if step_type in ("parallel_dispatch", "pipeline")` so pipeline also defaults `max_concurrent=3`. |
| `_build_step` field wiring | `spec.py:1255-1268` | Add `stages=tuple(s["stages"]) if s.get("stages") else None` to the `IRStepDef(...)` call (normalize each stage dict). |
| Semantic validation (pipeline branch) | `spec.py:1408-1483` | Widen the `step.step_type in ("decompose","parallel_dispatch")` gate (`:1408`) to include `"pipeline"`; add a `elif step.step_type == "pipeline":` branch (mirrors the parallel_dispatch branch at `:1440`): require `step.source`; require non-empty `step.stages`; each stage must have `intent_template` and permit only `agent` besides it (any other key → `IRSemanticError`); step-level `intent_template` forbidden (it lives per-stage); `reasoning_template` forbidden (same as parallel_dispatch `:1453`). The shared `depends_on` check (`:1462`), `score_expr` ban (`:1469`), `accumulate` ban (`:1477`), and the `continue` skip of legacy mode-checks (`:1483`) then apply to pipeline for free once `:1408` is widened. |
| Semantic validation (reject stray `stages`) — TWO sites | `spec.py:1408-1483` AND `spec.py:1493-1499` | **Codex findings (blueprint rounds 2+3):** `stages` must be rejected on every non-`pipeline` step, and there are two distinct control-flow paths: (a) **typed steps** (`decompose`/`parallel_dispatch`) hit the early `continue` at `:1483` *before* the legacy guard, so add an explicit check inside the widened `step.step_type in (...)` block — at the top, `if step.step_type != "pipeline" and step.stages is not None: raise IRSemanticError("Step '…' has 'stages' but is not a pipeline step")`. (b) **legacy steps** (`function`/`inline`/`flow`/`judge`) flow through the legacy guard at `:1494` — add `"stages"` to that tuple: `for pf in (*_parallel_dispatch_only, "intent_template", "stages")`. Both are required; neither alone covers all step types. |

### `stratum-mcp/src/stratum_mcp/executor.py` — mode mapping, checksum, surface

| What | Location | Change |
|---|---|---|
| `_step_mode` | `executor.py:562-567` | Add `if step.step_type == "pipeline": return "parallel_dispatch"` (before the existing parallel_dispatch line). This single line makes `get_current_step_info`, `stratum_parallel_start` (`server.py:1022`), and `stratum_parallel_done` (`server.py:712`) accept pipeline with zero further edits — both use `_step_mode`. |
| New helper `_is_pipeline_step` | `executor.py` (near `_step_mode`, ~`:577`) | `def _is_pipeline_step(step) -> bool: return getattr(step, "step_type", None) == "pipeline"`. Exported for server.py + parallel_exec construction. |
| **New shared desugar helper `expand_pipeline_tasks`** | `executor.py` (near `_is_pipeline_step`, ~`:578`) | `def expand_pipeline_tasks(step, source_items) -> list[dict]:` — the pure N×S expansion (design §2). Lives in executor.py (not server.py) so **both** the server resolver and `get_current_step_info` call the same function → the advertised surface and the dispatched graph are byte-identical. Takes the already-resolved `source_items` list (caller does `resolve_ref`), returns the desugared task dicts. No I/O, deterministic. |
| `compute_spec_checksum._step_fingerprint` | `executor.py:887-917` | Add `"stages": [dict(sorted(st.items())) for st in (step.stages or [])]` to the `fp` dict (alongside `"source"`/`"require"` at `:905-906`). Only checksum delta (design §5). |
| `get_current_step_info` parallel branch | `executor.py:1456-1477` | **Codex finding (blueprint round):** today this resolves `step.source` and returns the raw list as `tasks` (`:1460, :1468`) — for a pipeline that would advertise *source items*, not the `item×stage` graph start/poll/advance operate on (half-wired surface). Fix: when `_is_pipeline_step(step)`, set `tasks = expand_pipeline_tasks(step, source_tasks)` (same helper as the server resolver), and add `"pipeline": True` + `"stages": [dict(st) for st in step.stages]`. Now the advertised graph matches the dispatched one. `intent_template` stays `step.intent_template` (None for pipeline — harmless). |

### `stratum-mcp/src/stratum_mcp/server.py` — desugar, evaluator, gates

| What | Location | Change |
|---|---|---|
| **Desugar** in `_resolve_dispatch_tasks` | `server.py:887-896` | When `_is_pipeline_step(step)`: resolve `step.source` via existing `resolve_ref`, then `return expand_pipeline_tasks(step, source_items)` (the shared executor.py helper — same one `get_current_step_info` uses, so surface == dispatch). The helper performs the N×S expansion per design §2 (`id=f"{step.id}::item{i}::stage{j}"`, `depends_on=[prev_stage_id] if j>0 else []`, `_pipeline_item=i`, `_pipeline_stage=j`, `_intent_template=stages[j]["intent_template"]`, `_agent=stages[j].get("agent")`, `item=src[i]`, splat dict fields with reserved-key guard). Non-pipeline path unchanged (`return list(resolve_ref(...))`). Pure + deterministic → idempotent across start/poll/advance. |
| `_evaluate_parallel_results` | `server.py:585-661` | When `_is_pipeline_step(step)`: before the require block (`:631`), collapse `task_results` into per-item verdicts grouped by `_pipeline_item` (item `complete` iff its `_pipeline_stage == S-1` task is complete; `failed` if any stage failed/cancelled). Evaluate `require` over **items** not raw tasks. Build `items=[{item, status, result(final-stage), stages:[…]}]`; set `aggregate` (the value `process_step_result` records as `result`) to `{"items": items, "require_satisfied": …, "merge_status": …}`. Non-pipeline path = existing task-scoped code, byte-unchanged. **Cert loop (Codex finding, blueprint round):** the existing claude-gate is *step-level* — `(step.agent or "claude").startswith("claude")` (`:613`). In pipeline mode, agents are per-stage, so a `step.agent` of None would claude-gate *all* stage tasks (including codex stages). Fix: in the pipeline branch, gate the per-task cert check on the task's resolved agent — `(task.get("_agent") or step.agent or "claude").startswith("claude")` — so a codex stage task isn't claude-cert-gated and vice versa. (Step-level `task_reasoning_template` still applies uniformly in v1; only the *agent gate* becomes per-task.) |
| `ParallelExecutor` construction | `server.py:1083-1096` | Add kwarg `is_pipeline=_is_pipeline_step(cur_step)`. `intent_template`/`agent` stay as-is (per-task `_intent_template`/`_agent` override them; they remain the fallback). `task_timeout=cur_step.task_timeout` already step-level (`:1081`) — matches v1 (uniform per stage). |
| **Raw gate widen** in `stratum_parallel_advance` | `server.py:1303` | `getattr(step, "step_type", None) != "parallel_dispatch"` → `_step_mode(step) != "parallel_dispatch"` (accepts pipeline). This is the **only** raw `step_type` gate; `_done` (`:712`) and `_start` (`:1022`) already use `_step_mode`. |

### `stratum-mcp/src/stratum_mcp/parallel_exec.py` — engine (the 3 surgical changes)

| What | Location | Change |
|---|---|---|
| `__init__` flag | `parallel_exec.py:152-205` | Add param `is_pipeline: bool = False`; store `self.is_pipeline = is_pipeline`. Defaults off → parallel_dispatch behavior unchanged. |
| `_render_prompt` (per-task template + `{prev}`) | `parallel_exec.py:248-257` | (1) `template = task.get("_intent_template") or self.intent_template`. (2) Build kwargs `= dict(task)`; if exactly one `depends_on`, look up `self.state.parallel_tasks[dep].result`, bind `prev_raw=<raw>` and `prev=<str: result if str else json.dumps(result, default=str, ensure_ascii=False)>`. (3) `return template.format(**kwargs)` keeping the existing `KeyError/IndexError → raw template` fallback (`:256`). |
| `_run_one` per-stage agent | `parallel_exec.py:489` | `_connector_type_from_agent(self.agent)` → `_connector_type_from_agent(task.get("_agent") or self.agent)`. |
| `_require_unsatisfiable` item-scoped | `parallel_exec.py:264-285` | When `self.is_pipeline`: group `self.tasks` by `_pipeline_item`; an item is `complete` iff its final-stage (`_pipeline_stage == max`) task state is `complete`, `failed` if any of its stage tasks is `failed/cancelled`, else `pending`. Apply the same `all`/`any`/int logic (`:277-283`) over **item** counts. Non-pipeline path unchanged. This drives cascade-cancel (`:641-642`) over items — design §3. |
| **Per-task-agent cert gate** in `_run_one` | `parallel_exec.py:539-548` | **Codex finding (blueprint round 2):** this is the *live server-dispatch* cert path — it runs `validate_certificate(self.task_reasoning_template, result)` **unconditionally** today (no agent gate), *before* `_evaluate_parallel_results`. For a mixed-agent pipeline, a `_agent="codex"` stage would be failed against a claude-structured cert here. Fix: gate it `if self.task_reasoning_template and (not self.is_pipeline or (task.get("_agent") or self.agent or "claude").startswith("claude")):`. The `not self.is_pipeline` short-circuit keeps **parallel_dispatch byte-identical** (still unconditional); pipeline mode applies the per-task claude-gate, mirroring `_evaluate_parallel_results` (`server.py:613`). So a codex stage with a step-level `task_reasoning_template` skips cert on both paths. |

---

## Boundary Map

| Symbol | Kind | Produced by | Consumed by |
|---|---|---|---|
| `IRStepDef.stages` | type (field) | `spec._build_step` (`:1255`) | desugar (`server._resolve_dispatch_tasks`), checksum (`executor:887`), surface (`executor:1456`), validation (`spec:1440`) |
| `_is_pipeline_step(step)` | function | `executor.py` (new, ~`:577`) | `server._resolve_dispatch_tasks`, `server._evaluate_parallel_results`, `server.stratum_parallel_start`, `server.stratum_parallel_advance`, `executor.get_current_step_info` |
| `expand_pipeline_tasks(step, source_items)` | function | `executor.py` (new, ~`:578`) | `server._resolve_dispatch_tasks` (`:887`) AND `executor.get_current_step_info` (`:1456`) — shared so surface == dispatch |
| desugared task dict (`_pipeline_item`/`_pipeline_stage`/`_intent_template`/`_agent`/`item`) | const (shape) | `executor.expand_pipeline_tasks` | `ParallelExecutor._render_prompt`, `_run_one`, `_require_unsatisfiable`; `server._evaluate_parallel_results` |
| `ParallelExecutor(is_pipeline=…)` | interface (ctor param) | `server.stratum_parallel_start` (`:1083`) | `ParallelExecutor._require_unsatisfiable` (`:264`) |
| pipeline step result `{items, require_satisfied, merge_status}` | type | `server._evaluate_parallel_results` | `process_step_result` → `ensure` exprs / downstream `depends_on` (bracket access on `items[]` elements) |

**Topology:** every consumer references a producer defined earlier in the slice (spec field → executor
helper/checksum → server desugar/evaluator → engine). No forward references.

---

## Phase 5 — Verification table

| Ref | Claim | Verified |
|---|---|---|
| `spec.py:128-153` | `IRStepDef` is a frozen dataclass with v0.3 parallel fields; adding `stages` fits | ✅ read |
| `spec.py:541-543` | step `type` enum is exactly `function/inline/flow/decompose/parallel_dispatch` | ✅ read |
| `spec.py:581-597` | parallel fields declared as JSON-schema props; `stages` slots in here | ✅ read |
| `spec.py:1189-1192` | max_concurrent defaults to 3 for `parallel_dispatch` only | ✅ read |
| `spec.py:1255-1268` | `IRStepDef(...)` kwargs list — `stages=` adds cleanly | ✅ read |
| `spec.py:1408-1483` | validation gate keys on `step_type in (decompose, parallel_dispatch)`; parallel branch `:1440`, reasoning_template ban `:1453`, depends_on `:1462`, score_expr ban `:1469`, accumulate ban `:1477`, `continue` skip-legacy `:1483` | ✅ read |
| `spec.py:1493-1499` | legacy-step guard forbids `(*_parallel_dispatch_only, "intent_template")`; `+ "stages"` rejects stray `stages` on non-pipeline steps | ✅ read |
| `spec.py:1404-1407` | `_parallel_dispatch_only` guard runs only inside the decompose branch (`:1433`) + the legacy guard (`:1494`); pipeline's parallel fields unaffected | ✅ read |
| `executor.py:562-576` | `_step_mode` maps step_type→mode; adding pipeline→parallel_dispatch is one line | ✅ read |
| `executor.py:887-917` | `_step_fingerprint` covers `source`/`require`/etc but NOT other parallel fields; `+ stages` is the only delta | ✅ read |
| `executor.py:290-292` | `compile_ensure` wraps only top-level dict in SimpleNamespace; nested elements stay dicts → bracket access on `items[]` | ✅ read |
| `executor.py:1456-1477` | parallel_dispatch surface branch; gated by `mode`, so pipeline flows through; `+pipeline/+stages` additive | ✅ read |
| `parallel_exec.py:152-205` | `__init__` signature; adding `is_pipeline=False` is back-compatible | ✅ read |
| `parallel_exec.py:248-257` | `_render_prompt` formats from task dict with KeyError fallback; per-task template + `{prev}` slot in | ✅ read |
| `parallel_exec.py:264-285` | `_require_unsatisfiable` counts raw task states; item-scoping is gated additive | ✅ read |
| `parallel_exec.py:489` | `_run_one` reads `self.agent` for connector type; per-task `_agent` override slots in | ✅ read |
| `parallel_exec.py:538, 641-642` | upstream `ts.result` set on complete; cascade-cancel fires off `_require_unsatisfiable` | ✅ read |
| `parallel_exec.py:539-548` | `_run_one` validates `task_reasoning_template` UNCONDITIONALLY (no agent gate) — the live server-dispatch cert path; needs pipeline-scoped per-task-agent gate | ✅ read |
| `server.py:585-661` | `_evaluate_parallel_results` computes require + aggregate over raw tasks; pipeline-aware branch additive | ✅ read |
| `server.py:887-896` | `_resolve_dispatch_tasks` is the single resolver for start(`:1056`)/poll(`:1165`)/advance(`:1328`) | ✅ read |
| `server.py:712-713, 1022-1023` | `_done` + `_start` gates use `_step_mode` (accept pipeline once mapped) | ✅ read |
| `server.py:1303` | `stratum_parallel_advance` uses RAW `step.step_type` check — must widen to `_step_mode` | ✅ read |
| `server.py:1083-1096` | `ParallelExecutor` construction site; `is_pipeline=` kwarg slots in | ✅ read |

**Zero stale entries.** All insertion points confirmed against source on `strat-workflow-pipeline` @ `0ba31e4`.

---

## Test plan (Phase 7 TDD targets)

New `stratum-mcp/tests/integration/test_pipeline.py` (per-directory convention):
1. **Validation:** pipeline accepted; rejects missing `source`, empty/missing `stages`, stage without
   `intent_template`, step-level `intent_template`, extra per-stage key, `reasoning_template`. Also:
   a stray `stages` key is rejected on `parallel_dispatch`, `decompose` (typed-block check) AND on
   `function`/`inline`/`flow` (legacy guard) — both rejection paths covered.
2. **Round-trip + checksum:** parse→serialize→parse preserves `stages`; checksum changes when a stage
   `intent_template`/`agent` changes; unchanged when an unrelated comment changes.
3. **Desugar:** `_resolve_dispatch_tasks` on a 3×2 pipeline yields 6 tasks with correct ids/`depends_on`/
   `_pipeline_*`/`item`; scalar source binds `{item}`; dict source splats fields without clobbering reserved keys.
4. **Staggering proof (core capability):** stub connector with per-stage delays; assert via event/timeline
   trace that ≥1 item is in stage 1 while another is still in stage 0.
5. **Output threading:** stage 1 prompt interpolates stage 0 result via `{prev}` (string) and `{prev_raw}`
   (object field access).
6. **Per-stage agent:** stage 0 → claude, stage 1 → codex; assert connector types. Also: a codex
   stage with a step-level `task_reasoning_template` **skips** cert validation on both the `_run_one`
   path and `_evaluate_parallel_results` (claude-gate is per-task in pipeline mode); a claude stage is
   still cert-checked. Regression: a codex **parallel_dispatch** step still cert-validates unconditionally.
7. **Per-item isolation:** `require: any`, item 0 fails stage 0 → only item-0 stage-1 cancelled; siblings
   complete; no cross-item `_cancel_siblings`.
8. **Item-scoped require:** `require: all` fails iff ≥1 item fails chain; `require: 2` passes iff ≥2 items complete.
9. **Regression guard:** existing `test_parallel_*` / require/cascade/cert/budget suites pass unchanged
   (is_pipeline defaults off).
10. **Budget:** `debit_budget` fires once per dispatched stage task; `budget_exhausted` cascade-cancels the pipeline.
11. **`ensure` over `items`:** `result.items` + `i['status']` bracket access evaluates correctly.
