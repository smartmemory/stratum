# STRAT-WORKFLOW-RESUME — Implementation Blueprint

**Status:** Phase 4 blueprint + Phase 5 verification (2026-05-31). All file:line refs read against disk at HEAD `b8b5d52`. Codex blueprint-gate pending.
**Source design:** `design.md` (Codex design-gate CLEAN @ round 2).
**Owner repo:** stratum · **Package:** `stratum-mcp` (v0.2.59).

## Integration points (verified against disk)

| # | File:line (verified) | Symbol | Change |
|---|---|---|---|
| A | `stratum-mcp/src/stratum_mcp/spec.py:103` | `IRStepDef` | Add field `cache: bool = False`. |
| B | `stratum-mcp/src/stratum_mcp/spec.py:55` | `IRFunctionDef` | Add field `cache: bool = False` (step-level wins on merge). |
| C | `spec.py` parse (where `IRStepDef`/`IRFunctionDef` are built from YAML) | YAML→IR | Parse `cache:` on step and function blocks. |
| D | `stratum-mcp/src/stratum_mcp/spec.py:1900` `_validate_step` (uses `is_gate`, raises `SpecError`) | validator | Reject `cache: true` on ineligible steps (see §Eligibility). Mirror the existing gate-`next` rejection pattern at `spec.py:~1905`. |
| E | `stratum-mcp/src/stratum_mcp/executor.py:1093` `_step_fingerprint` | checksum | Add `"cache": step.cache` to the fingerprint dict (per its own "keep in sync" note at `:1122`). **Guardrails already present** — no other checksum change. |
| F | `stratum-mcp/src/stratum_mcp/executor.py:466` `resolve_ref` / `:508` `resolve_inputs` | key source | No change — reused verbatim to build the cache key's `resolved_input`. |
| G | `stratum-mcp/src/stratum_mcp/executor.py:1093` near fingerprints | **new** `result_cache_key(state, step, resolved)` | Compute `sha256(CACHE_VERSION ‖ flow_name ‖ step_id ‖ spec_checksum ‖ canonical_json(resolved))`. |
| H | **new module** `stratum-mcp/src/stratum_mcp/result_cache.py` | `result_cache_get/put`, `_cache_dir`, `evict` | Content-addressed store at `~/.stratum/cache/results/<key>.json`; atomic tmp+`os.replace`; corrupt/version-skew → miss. |
| I | `stratum-mcp/src/stratum_mcp/executor.py:1518` `get_current_step_info`, in the `mode == "function"` branch after `resolved = resolve_inputs(...)` (`:1595`) and before the `execute_step` return (`:1600`) | hit path | If `cache_enabled(step)` and not disabled: compute key, `result_cache_get`; on hit, `_revalidate`, append cache-hit `StepRecord`, `state.step_outputs[step.id]=cached`, `state.current_idx += 1`, `return get_current_step_info(state)`. Mirrors the `skip_if` tail-recurse at `:1538`/`:1542`. |
| J | `stratum-mcp/src/stratum_mcp/executor.py:1764` `process_step_result`, immediately after `state.step_outputs[step_id] = result` (`:1921`) and before the `next`/`current_idx` routing (`:1927`) | write path | If `cache_enabled(step)`: recompute `resolve_inputs(step.inputs, state.inputs, state.step_outputs)`, `result_cache_put(key, result, …)`. Only on the success path (after ensure passes). |
| K | `stratum-mcp/src/stratum_mcp/executor.py:95` `StepRecord` | record | Add `cache_hit: bool = False` and `cache_key: str | None = None` (defaulted → JSON back-compat; `dataclasses.asdict` in `persist_flow` and `_record_from_dict` restore round-trip them). |
| L | `stratum-mcp/src/stratum_mcp/executor.py:1312` `delete_persisted_flow` | cleanup | No change required (cache is run-independent at `~/.stratum/cache/`, GC'd by `evict`). Documented decision. |

`cache_enabled(step)` = `(step.cache or fn_def.cache) and not eligibility-excluded` — eligibility is enforced at parse time (D), so at runtime it reduces to the boolean.

## Eligibility rejection rule (validator D — exact IR terms)

**Positive rule (v1):** `cache: true` is accepted **only** on a function step whose function is `mode: compute` — i.e. `step.function` is set and `fns[step.function].mode == "compute"`. `cache: true` anywhere else raises `SpecError` with the step id. This single rule subsumes every exclusion below; they are spelled out so the error messages are specific:
- gate — `fn.mode == "gate"`;
- `judge` — `fn.mode == "judge"`;
- **inline step** — no `step.function` (dispatches via the `inline` branch of `get_current_step_info`, which the hit path I does not cover) → reject (closes Codex finding 3: an inline `cache:true` would otherwise be a silent no-op);
- parallel/pipeline — `step.parallel_tasks` truthy **or** `step.pipeline` truthy;
- iteration loop — `step.max_iterations` **or** `step.exit_criterion` **or** `step.score_expr` set;
- accumulator — `step.accumulate is True`;
- routing — `step.next` set.

(All these step fields are confirmed present in `_step_fingerprint`, `executor.py:1093–1122`. `fns` is in scope in `_validate_step(self, step, fns, contracts, step_ids)`, verified `spec.py:1900`.)

## Corrections table (design assumption vs. disk reality)

| Design said | Disk reality (verified) | Resolution |
|---|---|---|
| `compute_spec_checksum` **omits** guardrails (`_fn_fingerprint` only `{name,mode,intent,ensure}`; `_step_fingerprint` omits `step_guardrails`) — "required fix, add them." | **False.** `_step_fingerprint` (`executor.py:1093`) already has `"step_guardrails": step.step_guardrails`; `_fn_fingerprint` (`:1138`) already has `"guardrails": fn.guardrails`. The Codex round-1 finding was a false positive. | Design §2/§7/AC corrected. **No `compute_spec_checksum` change** beyond adding the new `cache` field. Guardrail invalidation already holds. A regression test asserts a guardrail-only edit changes the checksum (locks the behavior in). |
| `process_step_result` advances via `current_idx += 1`. | Confirmed, **plus** a `next:` branch at `:1927` (`_find_step_idx` + `_clear_from`). | Routing (`next`) steps excluded from caching (D) — the hit path (I) only does `+= 1`, which is correct for all eligible steps. |
| Interception "after skip_if, before execute_step." | Confirmed: `skip_if` at `:1538`, `resolve_inputs` at `:1595`, `execute_step` return at `:1600`. Note there are **three** dispatch branches (`function`/`inline`/`judge`). | Hit path lands in the `function` branch (v1 caches `mode: compute`/function steps). `inline`/`judge` not cached in v1. |
| New `cache` field. | No `cache` token anywhere in `spec.py` (grep EXIT=1). | Genuinely new; safe to add. |

## New module: `result_cache.py`

```
CACHE_VERSION: int = 1
_CACHE_DIR = Path.home()/".stratum"/"cache"/"results"   # sibling of ~/.stratum/flows
def result_cache_get(key: str) -> dict | None        # load+verify key/version; corrupt→None
def result_cache_put(key, output, *, flow_name, step_id, spec_checksum, source_flow_id) -> None
def canonical_json(value) -> str | None              # sort_keys, compact; non-serializable→None
def evict(*, max_age_days, max_entries) -> None       # GC by created_at; never touches live read path
def cache_disabled() -> bool                          # env STRATUM_DISABLE_RESULT_CACHE
```

Record shape per `design.md §3`. Writes are tmp-file + `os.replace` (atomic; identical-bytes concurrent writers are safe under content-addressing).

**Eviction wiring (closes Codex finding 4):** `result_cache_put` samples eviction so it is not dead code and never scans the fs on the hot path — it calls `evict(...)` only ~1/N writes (a cheap counter modulo, N≈50), with defaults `max_age_days=30`, `max_entries=2000` (env-overridable `STRATUM_CACHE_MAX_AGE_DAYS` / `STRATUM_CACHE_MAX_ENTRIES`). A swept key is at worst a future miss, never corruption — consistent with "best-effort, never wrong."

## Boundary Map

- `IRStepDef.cache` — **type** (bool field on the step dataclass, `spec.py:103`). Producer: spec parse (C). Consumers: validator (D from `_validate_step`), `_step_fingerprint` (E from S-checksum), `cache_enabled` (I/J).
- `IRFunctionDef.cache` — **type** (bool field, `spec.py:55`). Consumer: `cache_enabled` (step-level overrides).
- `result_cache_key` — **function** (`executor.py`, near `:1093`). Consumes `FlowState.spec_checksum`, `resolved` input, `flow_name`, `step.id`. Produces the cache key string used by I and J.
- `result_cache_get` — **function** (`result_cache.py`). Consumed by hit path (I).
- `result_cache_put` — **function** (`result_cache.py`). Consumed by write path (J).
- `StepRecord.cache_hit` / `StepRecord.cache_key` — **type** (fields, `executor.py:95`). Producer: hit path (I). Consumer: `stratum_audit` / trace serialization.
- `cache_enabled` — **function** (`executor.py`). Consumed by I and J.

Endpoints/formats in prose: the on-disk record is JSON at `~/.stratum/cache/results/<sha256>.json`; the env kill-switch is `STRATUM_DISABLE_RESULT_CACHE`; the key is a SHA-256 hex digest. Invariant: a cache hit dispatches no agent and debits no budget; a hit is always recorded with `cache_hit=true` so audit ≠ silent replay.

## Verification table (Phase 5)

| Ref | Read? | Matches blueprint? |
|---|---|---|
| `executor.py:1518` `get_current_step_info` (full body) | ✓ | Yes — skip_if tail-recurse `:1538/1542`; `resolve_inputs` `:1595`; function/inline/judge branches; `execute_step` dict `:1600`. |
| `executor.py:1764` `process_step_result` (full body) | ✓ | Yes — guardrail scan top (`step_guardrails ∪ fn.guardrails`); `step_outputs[step_id]=result` `:1921`; `next`/`current_idx` routing `:1927`. |
| `executor.py:1093` `_step_fingerprint` | ✓ | Yes — includes `step_guardrails`, `next`, `max_iterations`, `exit_criterion`, `score_expr`, `accumulate`; **no** `cache` yet. "Keep in sync" note `:1122`. |
| `executor.py:1138` `_fn_fingerprint` | ✓ | Yes — includes `guardrails`. |
| `executor.py:466/508` `resolve_ref`/`resolve_inputs` | ✓ | Yes — deterministic from `(flow_inputs, step_outputs)`. |
| `executor.py:95/116` `StepRecord`/`SkipRecord` | ✓ | Yes — defaulted fields; asdict-serialized. |
| `spec.py:55/103` `IRFunctionDef`/`IRStepDef` | ✓ | Yes — `guardrails` at `:59`; step fields present; no `cache`. |
| `spec.py:1900` `_validate_step` + gate-`next` rejection `~:1905` | ✓ | Yes — `SpecError`, `is_gate` in scope; mirrorable pattern. |
| `spec.py` grep `cache` | ✓ | EXIT=1 — field is new. |
| `executor.py:1340` `_record_from_dict` | ✓ | Uses `cls(**{k:v for k,v in d.items() if k in dataclasses.fields(cls)})` → new defaulted `StepRecord.cache_hit`/`cache_key` round-trip automatically; old records default cleanly (Codex finding 1 — **safe, verified**). |
| `_check_ensure(result, exprs, state, step_id)` | ✓ | `grep -c "step_outputs[step_id]"` = 0 → current step's result read only from the passed `result`, not from `state.step_outputs`. So hit-path order (revalidate cached output **before** assigning `step_outputs[step.id]`) is correct (Codex finding 2 — **safe, verified**). |

**Zero stale entries.** No Boundary Map violations expected (all entries name concrete code symbols with kinds). Codex blueprint-gate round 1: 2 must-verify (both confirmed safe against source) + 2 completeness gaps (eligibility positive-rule, eviction wiring) — folded in above.
