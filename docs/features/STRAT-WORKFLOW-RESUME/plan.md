# STRAT-WORKFLOW-RESUME — Implementation Plan

**Source:** `design.md` (gate CLEAN), `blueprint.md` (gate CLEAN). TDD per slice: write test → watch fail → implement → watch pass. Run `pytest stratum-mcp/tests/` after each slice; full suite must stay green.

## Slice S1 — `result_cache.py` module (no deps, pure)
- File: `stratum-mcp/src/stratum_mcp/result_cache.py` (new)
- File: `stratum-mcp/tests/test_result_cache.py` (new)
- [ ] `CACHE_VERSION = 1`; `_cache_dir()` → `~/.stratum/cache/results` (honors `STRATUM_FLOWS_DIR`-style test override via a module-level `Path.home()` seam patchable in tests).
- [ ] `canonical_json(value) -> str | None` — `json.dumps(sort_keys=True, separators=(",",":"))`; returns `None` on `TypeError`/`ValueError` (non-serializable).
- [ ] `result_cache_get(key) -> dict | None` — load JSON; return `output` only if `key` and `cache_version` match; corrupt/missing/skew → `None` (never raises).
- [ ] `result_cache_put(key, output, *, flow_name, step_id, spec_checksum, source_flow_id)` — atomic tmp + `os.replace`; samples `evict()` ~1/50 writes.
- [ ] `evict(*, max_age_days=30, max_entries=2000)` — GC by `created_at`; env overrides `STRATUM_CACHE_MAX_AGE_DAYS`/`STRATUM_CACHE_MAX_ENTRIES`.
- [ ] `cache_disabled() -> bool` — `STRATUM_DISABLE_RESULT_CACHE` truthy.
- Tests: round-trip get after put; corrupt file → miss; version skew → miss; non-serializable → `canonical_json` None; disabled env; evict removes old, keeps fresh; atomic write leaves no `.tmp`.

## Slice S2 — IR `cache` field + parse + fingerprint (+ guardrail checksum fix)
- File: `stratum-mcp/src/stratum_mcp/spec.py` — `IRStepDef` (class :80) `cache: bool = False`; `IRFunctionDef` (class :44) `cache: bool = False`; parse `cache=s.get("cache", False)` at the step ctor (:1278 area) and `cache=d.get("cache", False)` at the fn ctor (`IRFunctionDef(` :1128); add `cache` + `guardrails` to the JSON schemas (:357/:403/:535/:584 blocks).
- File: `stratum-mcp/src/stratum_mcp/executor.py` — `_step_fingerprint` (:1093): add `"cache": step.cache` AND `"step_guardrails": step.step_guardrails or []`. `_fn_fingerprint` (:1138): add `"guardrails": fn_def.guardrails or []`.
- File: `stratum-mcp/tests/` — extend a spec-parse test + a checksum test.
- [ ] `cache:` parses on step and function; defaults `False`; absent → `False`.
- [ ] Toggling `cache` changes `compute_spec_checksum`.
- [ ] **Guardrail fix:** editing a `guardrails` / `step_guardrails` pattern changes the checksum (currently it does NOT — this slice fixes it).

## Slice S3 — Validator eligibility (two gates)
- File: `stratum-mcp/src/stratum_mcp/spec.py` `_validate_semantics` (:1365), per-step loop (`is_gate_step` ~:1699). Exception: `IRSemanticError`.
- [ ] **Gate 1 (necessary):** reject unless `step.function` set and `fns[step.function].mode == "compute"`. Covers gate/judge/inline/parallel/pipeline/decompose/flow.
- [ ] **Gate 2 (additional, even when Gate 1 passes):** reject if `step.max_iterations`/`step.exit_criterion`/`step.score_expr` set, or `step.accumulate` truthy, or `step.next` set.
- [ ] One table-driven test per rejection reason across both gates; plus an accept case (compute function step, no disqualifiers).

## Slice S4 — key + enable helpers
- File: `stratum-mcp/src/stratum_mcp/executor.py` — `result_cache_key(state, step, resolved)`; `cache_enabled(step, fn_def)`.
- [ ] Key = `sha256(CACHE_VERSION ‖ flow_name ‖ step_id ‖ spec_checksum ‖ canonical_json(resolved))`; non-serializable resolved → sentinel that forces miss (key returns `None`).
- [ ] Same `(flow, step, resolved, checksum)` → identical key; any component change → different key.

## Slice S5 — hit path
- File: `stratum-mcp/src/stratum_mcp/executor.py` — `StepRecord` (:95) add `cache_hit: bool = False`, `cache_key: str | None = None`; `get_current_step_info` (:1518) function branch, after `resolve_inputs` (:1595), before `execute_step` return (:1600).
- [ ] On enabled + key + `result_cache_get` hit: `_revalidate` (schema + ensure + guardrails) against cached output; on pass → append `StepRecord(cache_hit=True, cache_key=...)`, set `step_outputs[step.id]`, `current_idx += 1`, tail-recurse.
- [ ] On miss / disabled / revalidate-fail → normal `execute_step` (fall through).
- [ ] `StepRecord.cache_hit`/`cache_key` round-trip through `persist_flow`/`restore_flow` (verified `_record_from_dict` field-filter).

## Slice S6 — write path
- File: `stratum-mcp/src/stratum_mcp/executor.py` — `process_step_result` (:1764) after `step_outputs[step_id]=result` (:1921), before routing (:1927).
- [ ] On enabled success: recompute `resolve_inputs`, `result_cache_put`. Failures/`ensure`-fail never cached.

## Slice S7 — audit visibility
- File: `stratum-mcp/src/stratum_mcp/server.py` `stratum_audit` (+ trace serializers).
- [ ] Audit/trace shows `cache_hit: true` + key for replayed steps; fresh steps unchanged. Add assertion to an audit test.

## Slice S8 — golden integration + full suite
- File: `stratum-mcp/tests/test_result_cache_e2e.py` (new).
- [ ] 4-step all-`cache:true` compute flow: run once (populate) → re-run unchanged → 4 hits, 0 dispatches. Edit step-3 fn intent → steps 1–2 hit, 3–4 miss. Change flow input consumed by step-1 → all miss.
- [ ] `STRATUM_DISABLE_RESULT_CACHE=1` → byte-identical dispatch trace to a no-`cache:` run.
- [ ] Budget: a hit debits zero (assert `budget_state`).
- [ ] `pytest stratum-mcp/tests/` full suite green.

## Phase 9 docs / Phase 10 ship
- [ ] CHANGELOG entry; SPEC.md/README `cache:` field doc + side-effect caveat; stratum `ROADMAP.md` row (owner repo); correct stale `T2-F5` clause in forge-top `ROADMAP.md`; `report.md`.
- [ ] Bump `stratum-mcp` version; commit; `stratum_audit` trace in ship commit.
