# STRAT-WORKFLOW-IMPERATIVE — Implementation Blueprint

> **This is a forward-looking PLAN, not a description of current code.** Every "add / merge /
> pop" below names an insertion point and the change to make there. The cited anchors point at
> *existing* structure (verified accurate); `accumulate`/`accumulate_key`/`iteration_accumulator`
> do **not** exist in the tree yet — implementing them is Phase 7.

**Status:** Implementing (Compose build, 2026-05-29)
**Owner repo:** stratum · **Design:** [./design.md](./design.md)

All file:line refs verified against working tree on `strat-workflow-imperative` @ `3dd88b3`.
Single cohesive slice over the STRAT-ENG-4 iteration subsystem — **no Boundary Map** (not a
multi-work-unit feature with cross-slice producer/consumer contracts; intentionally omitted so
Phase-5 skips `validateBoundaryMap`).

## Touchpoints (all in `stratum-mcp/src/stratum_mcp/`)

### `spec.py` — IR surface
| What | Location | Change |
|---|---|---|
| `IRStepDef` fields | `spec.py:117-120` (after `score_expr`) | add `accumulate: str \| None = None`, `accumulate_key: str \| None = None` |
| YAML parse | `_build_step` `spec.py:1238-1240` | add `accumulate=s.get("accumulate")`, `accumulate_key=s.get("accumulate_key")` |
| JSON schema (v0.2) | `spec.py:387-390` | add `"accumulate": {"type":"string"}`, `"accumulate_key": {"type":"string"}` |
| JSON schema (v0.3) | `spec.py:565-568` | same two props |
| Validation | `spec.py:1674-1697` (next to exit_criterion/score_expr block) | `accumulate` requires `max_iterations`; `accumulate_key` requires `accumulate`; dunder guard on both |
| Gate-step rejection | `spec.py:1524-1533` (next to score_expr gate reject) | reject `accumulate`/`accumulate_key` on gate steps |

### `executor.py` — state, eval, finalize
| What | Location | Change |
|---|---|---|
| `compile_value_expr(expr, bind)` (new) | after `compile_score_expr` `executor.py:329-361` | mirror score-expr compiler: dunder guard + restricted builtins, value-returning (any type), local binding name parameterized (`result` for `accumulate`, `item` for `accumulate_key`); caller canonicalizes keys to JSON string |
| `FlowState` field | `executor.py:754-759` (next to `iteration_best`) | `iteration_accumulator: dict[str, dict] = field(default_factory=dict)` |
| persist | `persist_flow` `executor.py:987-991` | add `"iteration_accumulator": state.iteration_accumulator` |
| restore | `restore_flow` `executor.py:1056-1060` | add `iteration_accumulator=payload.get("iteration_accumulator", {})` |
| checkpoint snapshot | `commit_checkpoint` `executor.py:1125-1129` | add deep-copied `iteration_accumulator` |
| checkpoint restore | `revert_checkpoint` `executor.py:1156-1160` | restore `iteration_accumulator` |
| revise-round clear | `_clear_from` `executor.py:580-591` | `state.iteration_accumulator.pop(sid, None)` in the steps_to_clear loop |
| spec checksum | `_step_fingerprint` `executor.py:875-876` | add `"accumulate"`/`"accumulate_key"` to `fp` |
| accumulation + kwargs | `report_iteration` `executor.py:1945-2076` | see "report_iteration changes" below |
| authoritative output merge | `process_step_result` **success path** `executor.py:1626` (immediately *before* `state.step_outputs[step_id] = result`) | merge `accumulated`/`accumulated_count` into `result` (dict only) **after** schema/guardrail/ensure validation has passed — never at 1520 (would feed injected keys through `output_schema`/guardrails/ensures and corrupt validation + `on_fail` preserve) |
| success pop | `process_step_result` `executor.py:1626-1627` | `state.iteration_accumulator.pop(step_id, None)` next to the `iteration_best.pop` |
| on_fail / retries-exhausted pop | `process_step_result` on_fail branches `executor.py:1549-1554`, `1572-1577`, `1590-1595`, `1617-1622` | `state.iteration_accumulator.pop(step_id, None)` after `state.step_outputs[step_id] = result` — the loop's attempt-chain is terminal on these routes; popping my new state is strictly safe and removes the latent stale-contamination Codex flagged. (Re-entry is *already* blocked by the `iteration_outcome` guard at `executor.py:1896`, which `on_fail` does not clear — so no stale accumulator is reachable today; this pop is defense-in-depth against a future change that unblocks it.) |

### `server.py` — retry reset + docs
| What | Location | Change |
|---|---|---|
| validation-failure retry clear | `server.py:512-514` | `state.iteration_accumulator.pop(step_id, None)` next to `iteration_best.pop` |
| `stratum_iteration_report` docstring | `server.py:1725-1729` | note accumulator kwargs + metric fields (no schema change) |

## report_iteration changes (`executor.py:1945-2076`)

Insert an accumulation block **after** the score block (ends ~`1964`) and **before** the
exit-criterion eval (`~1966`). Current code calls `exit_criterion` two ways — with score
kwargs (`1972-1984`) or bare `fn(result)` (`1986`). Replace with a single `eval_kwargs` dict:

```python
# --- Accumulation (STRAT-WORKFLOW-IMPERATIVE) ---
acc_new_count = None
accumulate_error = None
acc = state.iteration_accumulator.setdefault(
    step_id, {"items": [], "seen": [], "dry_streak": 0})
if ai.get("accumulate"):
    try:
        # Compile BOTH expressions up front — a malformed accumulate/accumulate_key
        # is an accumulate_error (freeze dry_streak), NOT a swallowed identity fallback.
        extract = compile_value_expr(ai["accumulate"], bind="result")
        key_fn = (compile_value_expr(ai["accumulate_key"], bind="item")
                  if ai.get("accumulate_key") else None)
        items = extract(result)                      # may raise → accumulate_error
        if not isinstance(items, list):
            raise EnsureCompileError("accumulate did not return a list")
        seen = set(acc["seen"])
        added = 0
        for item in items:
            try:
                raw_key = key_fn(item) if key_fn else item
            except Exception:
                raw_key = item        # TRUE per-item eval failure only → identity fallback
            key = json.dumps(raw_key, sort_keys=True, default=str)
            if key not in seen:
                seen.add(key); acc["items"].append(item); acc["seen"].append(key); added += 1
        acc_new_count = added
        acc["dry_streak"] = acc["dry_streak"] + 1 if added == 0 else 0
    except EnsureCompileError as exc:
        accumulate_error = str(exc)     # FROZEN dry_streak — not a dry round (Decision 5)

# --- Single exit_criterion eval ---
eval_kwargs = {}
if score_expr_str:
    eval_kwargs.update(best_score=..., prior_scores=..., iteration=count)  # existing values
if ai.get("accumulate"):
    eval_kwargs.update(accumulator=list(acc["items"]),
                       accumulated_count=len(acc["items"]),
                       new_count=acc_new_count, dry_streak=acc["dry_streak"])
exit_met = fn(result, **eval_kwargs)
```

- `ai` (`active_iteration`) must carry `accumulate`/`accumulate_key`, set in `start_iteration`
  (`executor.py:1902-1911`) from `step.accumulate`/`step.accumulate_key` alongside
  `exit_criterion`/`score_expr`.
- Report record (`executor.py:2034-2047`): add `new_count`/`dry_streak`/`accumulated_count`
  (+ `accumulate_error` when set) when accumulating.
- Exit response (`executor.py:2068-2076`): add `accumulated` + `accumulated_count` when
  accumulating (alongside the existing `final_result`/`best_score`).

> Note: `compile_value_expr(expr, bind=...)` is one small value-returning compiler
> (mirrors `compile_score_expr` 329-361: dunder guard + restricted builtins) parameterized
> by the local binding name — `result` for `accumulate`, `item` for `accumulate_key`. Both
> are compiled **once, outside the item loop**: a compile failure or a global-eval failure of
> the extract expr is an `accumulate_error` that freezes `dry_streak`; only a per-item
> exception from an already-compiled `key_fn` identity-falls-back (that item lacks the keyed
> field — legitimately distinct from a broken expression).

## Corrections table (spec assumption → reality)

| Design assumption | Reality | Resolution |
|---|---|---|
| exit_criterion always gets kwargs | Bare `fn(result)` when no `score_expr` (`1986`) | unify into one `eval_kwargs` call — verified harmless (evaluator is `(result, **extra)`) |
| `score_expr` is in the spec checksum | It is **not** (`_step_fingerprint` 875-876 lists only `max_iterations`/`exit_criterion`) | add `accumulate`/`accumulate_key`; leave `score_expr` pre-existing-gap (out of scope, noted) |
| accumulator output is the loop return | Step output is authoritative only via `process_step_result` (`1626`); only `iteration_best` substituted at `1520` | merge `accumulated` into result at the **success path** (`1626`, after validation), NOT at `1520` — keeps injected keys out of `output_schema`/guardrails/ensures; pop at `1627` + on_fail routes |
| `active_iteration` exposes accumulate cfg | It snapshots `exit_criterion`/`score_expr` only (`1902-1911`) | add `accumulate`/`accumulate_key` to the snapshot |

## Phase 5 — Verification table

| Ref | Claim | Verified |
|---|---|---|
| `spec.py:117-120` | `IRStepDef` has `max_iterations`/`exit_criterion`/`score_expr`, insertion point for new fields | ✅ read |
| `spec.py:1238-1240` | `_build_step` parses those three via `s.get(...)` | ✅ read |
| `spec.py:387-390` / `565-568` | step JSON schema (v0.2/v0.3) lists the three as string/int props | ✅ (explorer-verified) |
| `spec.py:1674-1697` | exit_criterion/score_expr `requires max_iterations` + dunder guards | ✅ (explorer-verified) |
| `spec.py:1524-1533` | gate steps reject `max_iterations`/`score_expr` | ✅ (explorer-verified) |
| `executor.py:329-361` | `compile_score_expr` shape to mirror for `compile_key_expr` | ✅ (explorer-verified) |
| `executor.py:278-322` | `compile_ensure` evaluator is `(result, **extra_locals)` → extra kwargs harmless | ✅ (explorer-verified) |
| `executor.py:580-591` | `_clear_from` pops `iteration_outcome`/`iteration_best`/`iterations` per step | ✅ read |
| `executor.py:754-759` | FlowState iteration fields incl. `iteration_best` | ✅ (explorer-verified) |
| `executor.py:855-879` | `_step_fingerprint` hashes `max_iterations`+`exit_criterion`, NOT `score_expr` | ✅ read |
| `executor.py:987-991`/`1056-1060`/`1125-1129`/`1156-1160` | persist/restore/checkpoint of iteration fields | ✅ (explorer-verified) |
| `executor.py:1520-1524` | `iteration_best` substituted into `result` before validation | ✅ read |
| `executor.py:1626-1627` | success: store `step_outputs[step_id]=result`, pop `iteration_best` | ✅ read |
| `executor.py:1902-1911` | `start_iteration` snapshots `exit_criterion`/`score_expr` into `active_iteration` | ✅ read |
| `executor.py:1945-2076` | `report_iteration` score → exit_criterion(±kwargs) → stagnation → outcome | ✅ read |
| `server.py:508-514` | validation-failure retry clears `iteration_outcome`+`iteration_best` only | ✅ read |
| `server.py:1725-1729` | `stratum_iteration_report` docstring | ✅ (explorer-verified) |

**Zero stale entries.** All insertion points confirmed against source.
