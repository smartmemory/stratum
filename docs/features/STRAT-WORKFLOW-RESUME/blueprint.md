# STRAT-WORKFLOW-RESUME — Implementation Blueprint

**Status:** Phase 4 blueprint + Phase 5 verification (2026-05-31, **rev 2** — all line refs re-read against disk at HEAD `f3736fe` after a first cut shipped stale anchors; corrections below). Codex blueprint-gate pending.
**Source design:** `design.md` (Codex design-gate CLEAN @ round 2).
**Owner repo:** stratum · **Package:** `stratum-mcp` (v0.2.59).

> **Note on rev 1:** the first blueprint cut carried wrong line numbers (grep artifacts) and, worse, a wrong "correction" claiming guardrails were already in `compute_spec_checksum`. Reading the source confirms they are **not**. This rev fixes every anchor against disk and restores the guardrail fix.

## Integration points (verified against disk, HEAD f3736fe)

| # | File:line (verified) | Symbol | Change |
|---|---|---|---|
| A | `spec.py:80` `class IRStepDef` (fields run to ~:157; `next` at :103, `step_guardrails` at :127) | `IRStepDef` | Add field `cache: bool = False`. |
| B | `spec.py:44` `class IRFunctionDef` (`guardrails` at :59) | `IRFunctionDef` | Add field `cache: bool = False` (step-level wins on merge). |
| C | `spec.py:1278` (`skip_if=s.get(...)`), `:1300` (`step_guardrails=s.get("guardrails")`) — the step-dict→`IRStepDef` constructor; plus the function-block parser for B | YAML→IR | Add `cache=s.get("cache", False)` (step) and the function-level equivalent. |
| D | `spec.py` `_validate_semantics` (def at ~:1365); per-step loop with `is_gate_step` local (set ~:1699); the **non-gate** branch holds iteration/accumulate checks (~:1826+), the **gate** `else` branch holds the gate-`next` rejection (~:1943, message "Gate step … must not have next"). Exception class is **`IRSemanticError`** (not `SpecError`). | validator | Add the eligibility rejection (see §Eligibility). Mirror the existing `IRSemanticError(...)` raises. |
| E | `executor.py:1093` `_step_fingerprint` | checksum | Add `"cache": step.cache` **and** `"step_guardrails": step.step_guardrails or []`. |
| E2 | `executor.py:1138` `_fn_fingerprint` (returns `{name,mode,intent,ensure}`) | checksum | Add `"guardrails": fn_def.guardrails or []`. **Guardrails are currently absent** from both fingerprints — verified. |
| F | `executor.py:479` `resolve_ref` / `:543` `resolve_inputs` | key source | No change — reused verbatim to build the key's `resolved_input`. |
| G | `executor.py` near `:1168` (after `compute_spec_checksum`) | **new** `result_cache_key(state, step, resolved)` | `sha256(CACHE_VERSION ‖ flow_name ‖ step_id ‖ spec_checksum ‖ canonical_json(resolved))`; non-serializable resolved → `None` (forces miss). |
| H | **new module** `stratum-mcp/src/stratum_mcp/result_cache.py` | `result_cache_get/put`, `canonical_json`, `evict`, `cache_disabled` | Content-addressed store `~/.stratum/cache/results/<key>.json`; atomic tmp+`os.replace`; corrupt/version-skew → miss. |
| I | `executor.py:1518` `get_current_step_info`; the `if mode == "function":` branch at `:1595` (after `resolved = resolve_inputs(...)` at `:1588`, before the `return {` at `:1598`) | hit path | If `cache_enabled(step, fn_def)` and not `cache_disabled()`: compute key, `result_cache_get`; on hit, `_revalidate`, append cache-hit `StepRecord`, `state.step_outputs[step.id]=cached`, `state.current_idx += 1`, `return get_current_step_info(state)`. Mirrors `skip_if` tail-recurse at `:1538`/`:1542`. |
| J | `executor.py:1764` `process_step_result`, immediately after `state.step_outputs[step_id] = result` (`:1921`) and before the `next`/`current_idx` routing (`:1927`) | write path | If `cache_enabled`: recompute `resolve_inputs(step.inputs, state.inputs, state.step_outputs)`, `result_cache_put(key, result, …)`. Success path only (after ensure passes; the accumulator merge at `:1914` does not apply — accumulator steps are ineligible). |
| K1 | `executor.py:825` `class StepRecord` | record | Add `cache_hit: bool = False` and `cache_key: str | None = None` (defaulted → `dataclasses.asdict` in `persist_flow` `:1236` round-trips them; old JSON loads with defaults). |
| K2 | `executor.py:874` `_record_from_dict`, the **`StepRecord` branch** at `:903` | record restore | **Explicit kwargs** — must add `cache_hit=r.get("cache_hit", False)` and `cache_key=r.get("cache_key")`. Without this, a resumed cache-hit record reloads as `cache_hit=False` (audit corruption). **This is a required change site** (not automatic). |
| L | `executor.py:1334` `delete_persisted_flow` | cleanup | No change — cache lives at `~/.stratum/cache/` (run-independent), GC'd by `evict`. Documented decision. |

`cache_enabled(step, fn_def)` = `(step.cache or (fn_def and fn_def.cache))`. Runtime needs no eligibility re-check — the parse-time validator (D) guarantees a `cache:true` step is a compute-function step.

## Eligibility rejection rule (validator D — exact IR terms)

The validator must apply **both** gates below; passing the first does NOT exempt a step from the second. (A compute function step can legally carry `max_iterations`/`accumulate`/`next` today, so those must be rejected explicitly even though they satisfy the necessary condition.)

**Gate 1 — necessary condition (reject `cache: true` if NOT met):** `step.function` is set **and** `fns[step.function].mode == "compute"`. This alone rejects: gate (`mode=="gate"`), judge (`mode=="judge"` or `step.judge` set), inline (no `step.function`), parallel/pipeline/decompose (`step.step_type in ("parallel_dispatch","pipeline","decompose")` → no `step.function`), flow (`step.flow_ref`, no `step.function`). Note: `step.parallel_tasks`/`step.pipeline` are **not** fields on `IRStepDef` — mode is `step.step_type` (`_step_mode`, `executor.py:754`).

**Gate 2 — additional rejection conditions (reject `cache: true` even when Gate 1 passes):** raise `IRSemanticError` (naming the step id) if **any** of:
- `step.max_iterations` set, or `step.exit_criterion` set, or `step.score_expr` set (iteration loop — nondeterministic);
- `step.accumulate` truthy (`str | None`, `spec.py:124` — accumulator carries cross-iteration state);
- `step.next` set (`spec.py:103` — routing; the hit path I only does `current_idx += 1`).

`fns` (the function table) is in scope in `_validate_semantics`; `is_gate_step` is the existing per-step local. One table-driven test per rejection reason across both gates.

## Corrections table (rev-1 blueprint vs. disk reality)

| Rev-1 said | Disk reality (verified) | Resolution |
|---|---|---|
| Guardrails **already** in `compute_spec_checksum`; "no checksum change beyond `cache`." | **False.** `_step_fingerprint` (`:1093–1136`) has no `step_guardrails`; `_fn_fingerprint` (`:1138–1150`) = `{name,mode,intent,ensure}` only. | Restored the fix (E, E2): add `step_guardrails` + `guardrails`. Original Codex design finding was correct. |
| Parallel/pipeline = `step.parallel_tasks`/`step.pipeline`. | No such fields on `IRStepDef`. Mode is `step.step_type in ("parallel_dispatch","pipeline")`. | Eligibility rule uses `step_type` (D). |
| Validator is `_validate_step`, raises `SpecError`, local `is_gate`. | No `_validate_step`, no `SpecError`. It's `_validate_semantics` (~:1365), `IRSemanticError`, `is_gate_step` (~:1699); gate-`next` rejection ~:1943. | D corrected. |
| `StepRecord` at `:95`; `_record_from_dict` auto-round-trips new fields via a filter-dict idiom. | `StepRecord` at `:825`; `_record_from_dict` (`:874`) uses **explicit kwargs** (`:903` branch). | K split into K1 (dataclass) + K2 (explicit `_record_from_dict` update). |
| `resolve_ref` `:466` / `resolve_inputs` `:508`; `IRFunctionDef` `:55` / `IRStepDef` `:103`; `delete_persisted_flow` `:1312`; resolved at `:1595`, return at `:1600`. | `:479`/`:543`; `:44`/`:80`; `:1334`; resolved `:1588`, `if mode=="function":` `:1595`, `return {` `:1598`. | All anchors corrected above. |
| Cited `_check_ensure` (`grep step_outputs[step_id]`=0). | No function `_check_ensure`. Ensure eval is **inline** in `process_step_result` `:1885–1895`. | Conclusion still holds (ensures read the `result` param; `step_outputs[step_id]=result` is later at `:1921`), so revalidating the cached output before assignment is correct. Verification note rewritten. |
| New `cache` field. | No `cache` token in spec.py (grep EXIT=1). | Genuinely new. |

## New module: `result_cache.py`

```
CACHE_VERSION: int = 1
_cache_dir() -> Path            # ~/.stratum/cache/results ; reads Path.home() at call time (test-patchable)
def canonical_json(value) -> str | None     # json.dumps(sort_keys, compact); non-serializable -> None
def result_cache_get(key) -> dict | None    # load+verify key/version; corrupt/missing/skew -> None (never raises)
def result_cache_put(key, output, *, flow_name, step_id, spec_checksum, source_flow_id) -> None
def evict(*, max_age_days=30, max_entries=2000) -> None   # GC by created_at; env overrides
def cache_disabled() -> bool    # STRATUM_DISABLE_RESULT_CACHE truthy
```

Record shape per `design.md §3`. Writes: tmp + `os.replace` (atomic; identical-bytes concurrent writers safe under content-addressing). **Eviction wiring:** `result_cache_put` samples `evict()` ~1/50 writes (counter modulo) so it is not dead code and never scans the fs on the hot path. A swept key is at worst a future miss, never corruption.

## Boundary Map

- `IRStepDef.cache` — **type** (bool field, `spec.py:80` class). Producer: spec parse (C). Consumers: validator (D), `_step_fingerprint` (E), `cache_enabled` (I/J).
- `IRFunctionDef.cache` — **type** (bool field, `spec.py:44` class). Consumer: `cache_enabled` (step-level overrides).
- `result_cache_key` — **function** (`executor.py` near `:1168`). Consumes `FlowState.spec_checksum`, `resolved`, `flow_name`, `step.id`. Produces the key for I and J.
- `result_cache_get` — **function** (`result_cache.py`). Consumed by hit path (I).
- `result_cache_put` — **function** (`result_cache.py`). Consumed by write path (J).
- `cache_enabled` — **function** (`executor.py`). Consumed by I and J.
- `StepRecord.cache_hit` / `StepRecord.cache_key` — **type** (fields, `executor.py:825`). Producer: hit path (I). Consumer: `stratum_audit` / trace serializers; round-tripped by `_record_from_dict` (K2).

Prose (not Boundary Map entries): on-disk record is JSON at `~/.stratum/cache/results/<sha256>.json`; env kill-switch `STRATUM_DISABLE_RESULT_CACHE`; key is a SHA-256 hex digest. Invariant: a cache hit dispatches no agent and debits no budget, and is always recorded with `cache_hit=true` (audit ≠ silent replay).

## Verification table (Phase 5)

| Ref | Read? | Matches blueprint? |
|---|---|---|
| `executor.py:1518` `get_current_step_info` | ✓ | Yes — `skip_if` `:1538`/`:1542`; `resolved=resolve_inputs` `:1588`; `if mode=="function":` `:1595`; `return {` `:1598`; inline/judge branches follow. |
| `executor.py:1764` `process_step_result` | ✓ | Yes — guardrail scan (`fn.guardrails`/`step_guardrails`); ensure eval inline `:1885–1895`; `step_outputs[step_id]=result` `:1921`; `next`/`current_idx` routing `:1927–1932`. |
| `executor.py:1093` `_step_fingerprint` | ✓ | **No `step_guardrails`** (E adds it); has next/max_iterations/exit_criterion/score_expr/accumulate. |
| `executor.py:1138` `_fn_fingerprint` | ✓ | Returns `{name,mode,intent,ensure}` — **no guardrails** (E2 adds it). |
| `executor.py:479/543` `resolve_ref`/`resolve_inputs` | ✓ | Deterministic from `(flow_inputs, step_outputs)`. |
| `executor.py:825` `StepRecord`; `:874/:903` `_record_from_dict` | ✓ | Explicit kwargs → K2 required. |
| `executor.py:1334` `delete_persisted_flow` | ✓ | No change. |
| `spec.py:44/80` `IRFunctionDef`/`IRStepDef`; `:1278/:1300` parse; `_validate_semantics` ~:1365, `is_gate_step` ~:1699, gate-next ~:1943 | ✓ | `IRSemanticError`; no `cache` token (grep EXIT=1). |

**Zero stale entries (rev 2).** No Boundary Map violations (all entries name concrete symbols with kinds).
