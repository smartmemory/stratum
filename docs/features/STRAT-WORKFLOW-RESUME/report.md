# STRAT-WORKFLOW-RESUME — Implementation Report

**Status:** COMPLETE (2026-05-31). Owner repo: stratum · Package: `stratum-mcp`.
**Source chain:** [design.md](design.md) → [blueprint.md](blueprint.md) → [plan.md](plan.md) → this report.
**Track:** STRAT-WORKFLOW epic, ticket 4 of 6 (`-NAMING`/`-IMPERATIVE`/`-PIPELINE*`/`-BUDGET*` shipped).

## 1. Summary

Added opt-in, content-addressed **result caching** for side-effect-free `compute`
function steps. When a flow is re-run or iterated, an unchanged prefix step
returns its prior *validated* output from a shared store (`~/.stratum/cache/`)
instead of re-dispatching the agent. A cache hit dispatches no agent, debits no
budget, and is recorded as `cache_hit` in the trace so the audit never passes a
replay off as a fresh run. This is the governed, cross-model analogue of
dynamic-workflow result caching ("same workflow + same inputs → 100% hit").

## 2. Delivered vs Planned

All plan slices S1–S8 delivered, plus two findings from the Codex review loop.

| Slice | Planned | Delivered |
|---|---|---|
| S1 | `result_cache.py` store | ✅ (pre-existing WIP; verified + greened) |
| S2 | `cache` IR field + parse + checksum guardrail-fix | ✅ (tests had wrong schema version — fixed) |
| S3 | validator eligibility (two gates) | ✅ + function-level-cache gate (R1) |
| S4 | `result_cache_key` + `cache_enabled` | ✅ — **per-step** fingerprint keying (see §3) |
| S5 | hit path + `StepRecord.cache_hit/cache_key` | ✅ incl. `_record_from_dict` round-trip |
| S6 | write path | ✅ |
| S7 | audit visibility | ✅ (`cache_hits` count + per-step trace fields) |
| S8 | golden e2e + full suite | ✅ (7 e2e cases) |

## 3. Architecture Deviations (deliberate, approved)

- **Per-step cache key, not global `spec_checksum`.** The written design's key
  formula folded the whole-flow `spec_checksum`. But `compute_spec_checksum`
  fingerprints the *entire* flow, so editing any step would bust *every* step's
  key — defeating the prefix property the design's own acceptance criteria and
  the headline value require ("an unchanged prefix returns instantly"). Resolved
  (with the user) by keying on **only the step's own `_step_fingerprint` + its
  function's `_fn_fingerprint`**. Editing a later step now changes only that
  step's key; the unchanged prefix still hits, and the suffix misses via the
  resolved-input cascade. To make this a single source of truth, the two
  fingerprint helpers were promoted from nested closures of
  `compute_spec_checksum` to module level — the cache key and whole-flow tamper
  detection now share identical fingerprints.

## 4. Key Implementation Decisions

- **Fingerprints are the soundness surface.** A step's cached output is sound
  only if the key captures everything that determines what the agent is asked to
  produce and what's required to accept the result. The fingerprints therefore
  cover (beyond intent/ensure/mode): `step_guardrails`, function `guardrails`,
  `cache`, `step.output_schema`, and the function `output_contract` + its
  resolved contract field shape. Folding these in fixed a pre-existing
  tamper-detection gap (guardrail/schema/contract edits weren't checksummed)
  *and* the cache key in one edit.
- **Effective-enablement validation.** Caching activates on `step.cache OR
  fn.cache`, so the parse-time eligibility gates apply to that OR — a
  function-level `cache: true` cannot smuggle a routing/iteration/accumulator
  step past the validator (Codex R1).
- **Best-effort, never wrong.** Miss / disabled / corrupt / version-skew always
  falls back to a normal dispatch. Only `ensure`-passing results are written.
  The hit path re-validates the cached output against the current
  schema/guardrails/ensure before trusting it (behind the key, belt-and-suspenders).
- **Write-path key recompute.** `process_step_result` recomputes `resolve_inputs`
  from the now-frozen `step_outputs` to derive the key — byte-identical to the
  read-side key, with a smaller call-signature blast radius than threading the
  resolved dict through.

## 5. Test Coverage

5 new files, 47 tests:
- `test_result_cache.py` — store unit (round-trip, corrupt, version-skew, atomic write, evict, disable).
- `test_result_cache_ir.py` — `cache` parse + checksum; guardrail-edit invalidation.
- `test_result_cache_validate.py` — both eligibility gates incl. function-level-cache bypass (reject/accept).
- `test_result_cache_key.py` — key determinism + sensitivity (resolved input, fn intent, contract shape, output_schema, flow name) + non-serializable → miss.
- `test_result_cache_e2e.py` — golden flow: identical re-run (4 hits / 0 dispatches), edit-late-step prefix hits, flow-input cascade, kill switch, only-successes-cached, persist/restore round-trip.

Full `stratum-mcp/tests/`: **1289 passed, 2 skipped**.

## 6. Files Changed

- `stratum-mcp/src/stratum_mcp/result_cache.py` (new) — content-addressed store.
- `stratum-mcp/src/stratum_mcp/spec.py` — `cache` field on `IRStepDef`/`IRFunctionDef`, schema entries, parse, two-gate eligibility validator (effective enablement).
- `stratum-mcp/src/stratum_mcp/executor.py` — module-level `_step_fingerprint`/`_fn_fingerprint` (extracted + extended), `cache_enabled`, `result_cache_key`, `_revalidate_cached`, hit path in `get_current_step_info`, write path in `process_step_result`, `StepRecord.cache_hit/cache_key` + `_record_from_dict`.
- `stratum-mcp/src/stratum_mcp/server.py` — `cache_hits` count in the audit snapshot.
- 5 new test files.

## 7. Known Issues & Tech Debt

- **Named follow-ups (out of scope, by design):** caching side-effecting steps
  (durable worktree-delta capture/replay); caching `parallel_dispatch`/`pipeline`
  results (`STRAT-WORKFLOW-RESUME-PARALLEL`); `next:`/routing-step caching
  (`STRAT-WORKFLOW-RESUME-ROUTING`); cross-host/shared-team cache;
  `stratum_agent_run` standalone result caching.
- The whole-flow checksum now covers `output_schema`/`output_contract`/contract
  shape. Any externally-stored checksums computed before this change will differ
  (expected; `CACHE_VERSION` + checksum are recomputed per run, not pinned).

## 8. Lessons Learned

- A design can be internally inconsistent (global-checksum key vs. prefix-hit
  acceptance criteria); the acceptance criteria + headline are the load-bearing
  contract. Surfacing the conflict as one decision was cheaper than discovering
  it in the e2e test.
- The Codex review loop earned its keep: each round caught a class the prior
  missed (validator bypass → fingerprint-omission staleness → clean), exactly
  the "review loops catch unwired/under-specified" pattern.
