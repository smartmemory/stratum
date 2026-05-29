# STRAT-WORKFLOW-IMPERATIVE — Design

**Status:** Implementing (Compose build, 2026-05-29)
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP) — ticket 3 of 6
**Related:** [[project_strat_workflow_epic]], [[feedback_verify_roadmap_rows_vs_disk]]

## Scope reconciliation (read first)

The ticket was filed as "imperative control flow in the IR" with three motivating gaps:
`while (count < N)`, loop-until-dry, and in-flow dedup against an accumulating set. A
verify-first pass against `stratum-mcp/src/stratum_mcp/executor.py` (the standing rule)
found the framing **substantially stale**:

| Original claim | Reality | Verdict |
|---|---|---|
| `while (count < N)` | `max_iterations` (counted cap) + `exit_criterion` (deterministic until-guard with `iteration`/`best_score`/`prior_scores` in scope) — STRAT-ENG-4, `executor.py:1860-2076` | **Already shipped** |
| loop-until-dry (K empty rounds) | K-window stagnation auto-exit exists (`_STAGNATION_WINDOW=3`) but keyed on **identical result fingerprints**, not **zero-new items**. A re-search that finds nothing but returns a differently-shaped payload never trips it. | **Partial** |
| in-flow dedup against an accumulating set | No accumulator construct. `iteration_best` holds one best result; `iterations[step_id]` holds history; nothing accumulates deduped items across iterations. | **Genuine gap** |

So `while (count < N)` is **done** and is explicitly out of scope. This design covers only
the genuine residual: **(1) a governed accumulator-with-dedup** carried across iterations
and **(2) a loop-until-dry exit predicate** keyed on consecutive zero-new rounds — both as a
minimal extension to the existing per-step iteration loop, **not** a new control-flow IR.

## Problem

An iteration loop today can re-run a step up to `max_iterations` times and exit when
`exit_criterion` matches or results stagnate. But for the canonical "keep finding things
until you stop finding new things" pattern (loop-until-dry over a discovery step — bugs,
edge cases, sources), the loop has no way to:

- **Accumulate** the items each iteration emits into a single growing set.
- **Dedup** new items against everything seen in prior iterations.
- **Know it's dry** — i.e. that the last K iterations added zero *new* items, as distinct
  from emitting the same payload twice (which is all stagnation detects).

Without this, a flow author must either over-run to `max_iterations` (wasteful) or hand-roll
accumulation in the consumer's head across `stratum_iteration_report` calls (unauditable,
defeats the point of a governed loop).

## Goals / Non-Goals

**Goals**
- Declare accumulation on an iteration step with two new IR fields.
- Carry the deduped accumulator in `FlowState` (persist/restore/checkpoint/clear-safe).
- Expose `accumulator`, `accumulated_count`, `new_count`, `dry_streak` to `exit_criterion`.
- Surface those metrics in each iteration report and the final accumulated set on exit.

**Non-Goals**
- No arbitrary code execution / scripting hatch (the ticket's hard design-gate).
- No new control-flow construct, no new MCP tools, no new outcome verb (reuse `exit_success`).
- No counted-loop / until-condition work — already shipped (STRAT-ENG-4).
- No compose-side consumer plumbing — there is no iteration-loop consumer today; building
  speculative orchestration is out of scope.
- No change to stagnation detection — dryness is a separate, opt-in signal.

## Approaches considered

### Approach A — Accumulator state + derived kwargs on `exit_criterion` (CHOSEN)

Add two IR fields — `accumulate` (expression extracting the per-iteration item list from
`result`) and `accumulate_key` (optional per-item dedup-key expression). In
`report_iteration`, after the result is in hand and before `exit_criterion` is evaluated:
extract items, dedup against the step's accumulator, compute `new_count`, update
`dry_streak`. Then inject `accumulator` / `accumulated_count` / `new_count` / `dry_streak`
as kwargs into the existing `exit_criterion` evaluation.

Loop-until-dry is then **just a predicate**: `exit_criterion: "dry_streak >= 2"`. Accumulate-
to-target is `exit_criterion: "accumulated_count >= 10"`. Both compose:
`"dry_streak >= 2 or accumulated_count >= 50"`.

- **Pros:** Reuses the already-sandboxed `compile_ensure` surface (dunder guard + restricted
  builtins). Adds *data*, not a new construct. One exit path, not two. Composable predicates.
  Mirrors the `score_expr` precedent exactly (extra field → extra kwargs).
- **Cons:** Exit reason records as generic `exit_success`, not a dedicated "dry" verb (we
  surface the metrics in the trace to compensate — see Decision 1).

### Approach B — First-class `until_dry: K` field with a dedicated `exit_dry` outcome

A standalone declarative field with its own exit path and outcome verb.

- **Pros:** Self-documenting; audit shows `exit_dry`.
- **Cons:** Second exit mechanism competing with `exit_criterion`/stagnation/max; can't be
  combined with other conditions; more validation surface and interaction edge cases. The
  "dry" label would be *wrong* whenever the author also wanted an OR-ed count cap. Heavier
  for no expressive gain over A.

**Decision: Approach A.** It is the governed-minimal answer the ticket's design-gate
demands, and aligns with the "no pointless indirection" standard.

## Design (Approach A)

### New IR fields (`IRStepDef`)
- `accumulate: str | None` — expression returning the iteration's item list from the
  result, e.g. `"result.findings"`. Presence enables accumulation. Requires `max_iterations`.
- `accumulate_key: str | None` — optional per-item dedup key expression evaluated with
  `item` in scope, e.g. `"item.id"` or `"str(item.file) + ':' + str(item.line)"`. Absent →
  dedup on canonical JSON of the whole item. Requires `accumulate`.

### Accumulator state (`FlowState`)
`iteration_accumulator: dict[str, dict]` keyed by `step_id`:
```
{"items": [<deduped items in first-seen order>],
 "seen":  [<canonical-string dedup keys>],   # list for JSON round-trip; set in-memory for O(1)
 "dry_streak": <int>}                         # consecutive iterations with new_count == 0
```
Dedup keys are **always canonicalized to a stable string** (`json.dumps(key, sort_keys=True)`)
before membership/storage, so a non-hashable `accumulate_key` result (dict/list) is handled
and the in-memory set stays valid.

Round-trips through `persist_flow` / `restore_flow` / checkpoint snapshot+restore and is
cleared in **every** path that today clears `iteration_best`, not just `clear_steps_from`:
- `clear_steps_from` (revise rounds) — pop alongside `iteration_best` (`executor.py:580-591`).
- the `stratum_step_done` **validation-failure retry path** — when `process_step_result`
  returns `ensure_failed`/`schema_failed`/`guardrail_blocked`, the server clears
  `iteration_outcome` + `iteration_best` before allowing retry (`server.py:~508`); the
  accumulator MUST be popped here too, or a restarted loop inherits stale `seen`/`dry_streak`.

### `report_iteration` flow (additions only)
1. After `result` is known and the score block runs, if `step.accumulate` is set:
   - eval `accumulate` → list. **On non-list or eval error → this is an `accumulate_error`,
     not a dry round** (see Decision 5): record the error, leave `dry_streak` **unchanged**,
     and report `new_count = null`. The loop stays live and a dry-based predicate cannot fire
     off an extraction bug.
   - on success: for each item compute its key (`accumulate_key` with `item` in scope, else
     the item itself), canonicalize the key to a string; per-item key error → fall back to the
     canonical-JSON of the whole item. If the canonical key is unseen, append to `items` +
     `seen`, count as new.
   - `new_count` = items added this iteration; `dry_streak` = `prev + 1` if `new_count == 0`
     else `0`.
2. Build a single `eval_kwargs` dict (subsumes the current score-only branch): add
   `best_score`/`prior_scores`/`iteration` when `score_expr` present, add
   `accumulator`/`accumulated_count`/`new_count`/`dry_streak` when `accumulate` present, then
   call `exit_criterion` once as `fn(result, **eval_kwargs)`. Extra unreferenced kwargs are
   harmless (compile_ensure binds them as locals).
3. Record `new_count` / `dry_streak` / `accumulated_count` (+ `accumulate_error` if any) on
   the per-iteration report. On exit, add `accumulated` (the deduped item list) and
   `accumulated_count` to the response.

Ordering is unchanged: `exit_criterion` is still evaluated before stagnation/max, so a
dry-predicate exit wins as `exit_success`, consistent with today's precedence.

### Making the accumulated set the authoritative step output
The iteration response is advisory; a step's output only becomes authoritative when
`stratum_step_done` calls `process_step_result`, which today substitutes `iteration_best` for
scored loops and otherwise stores the caller-supplied result (`server.py:~404`,
`executor.py:~1520`/`~1626`). To make "the accumulated union is the loop output" actually
true, `process_step_result` MUST, for an accumulating step, **merge `{"accumulated": [...],
"accumulated_count": N}` into the finalized step output** — the same substitution seam
`iteration_best` already uses. This keeps the handshake server-side and auditable rather than
relying on the consumer to echo the accumulator back (no compose plumbing required; the
existing `step_done` call already carries the step through).

### Validation (`spec.py`)
- `accumulate` requires `max_iterations`; `accumulate_key` requires `accumulate`.
- dunder guard on both; rejected on gate steps (mirrors `score_expr`/`exit_criterion`).
- JSON-schema: add `accumulate` / `accumulate_key` string props to the step schema (v0.2 +
  v0.3); parse in `_build_step`.

### Spec-checksum integrity (`executor.py`)
The live-flow integrity fingerprint at `executor.py:~860` hashes `max_iterations` /
`exit_criterion` so loop semantics can't be tampered with mid-run. `accumulate` and
`accumulate_key` MUST be added to that fingerprint too, or accumulator semantics could be
swapped under a running flow undetected.

### MCP / server surface
No new tools. `stratum_iteration_report`'s response gains the metric fields above; docstrings
note accumulator availability. No outcome verb added.

## Key decisions

1. **No `exit_dry` outcome verb.** Loop-until-dry exits as `exit_success` via
   `exit_criterion`; the `dry_streak`/`new_count`/`accumulated_count` metrics in the trace
   make the reason auditable without a verb that would mislabel OR-ed exits.
2. **`seen` persisted as a list, used as a set in-memory.** JSON has no set type; the list is
   the durable form, rebuilt to a set per call for O(1) membership. N is small (loop-bounded).
3. **Reuse `compile_ensure`/`compile_score_expr` infra** for the key expression (new tiny
   `compile_key_expr` binding `item`), keeping the dunder guard + restricted-builtins jail.
   Key results are canonicalized to a string before use (handles non-hashable returns).
4. **The accumulated union is substituted into the step output server-side** by
   `process_step_result`, mirroring the `iteration_best` seam — so it is authoritative and
   auditable without any consumer echo or compose plumbing.
5. **Accumulator-eval failure is *not* a dry round.** A malformed `accumulate`/`accumulate_key`
   freezes `dry_streak` (no increment) and reports `new_count = null` — it must never
   manufacture a false dry streak that satisfies `dry_streak >= K` and kills the loop on an
   extraction bug rather than true exhaustion. The loop stays live and governed.

## Risks / unproven assumptions
- `compile_ensure` tolerates extra unreferenced kwargs (verified in research: evaluator
  signature is `(result, **extra_locals)`). Blueprint will pin the exact line.
- Items must be JSON-serializable (they originate from the JSON result) — holds by
  construction; canonical-JSON keying assumes the same.

## Acceptance criteria
- [ ] `accumulate` + `accumulate_key` parse, validate (require `max_iterations`/`accumulate`;
      dunder-guarded; rejected on gate steps), and round-trip in the IR.
- [ ] `accumulate`/`accumulate_key` are included in the live-flow spec checksum.
- [ ] `iteration_accumulator` persists/restores/checkpoints and clears with the step in **both**
      `clear_steps_from` and the `step_done` validation-failure retry path (`server.py:~508`).
- [ ] Dedup keys are canonicalized to a stable string (non-hashable key results handled).
- [ ] `report_iteration` dedups items, exposes `accumulator`/`accumulated_count`/`new_count`/
      `dry_streak` to `exit_criterion`, and `exit_criterion: "dry_streak >= K"` exits the loop.
- [ ] A malformed accumulate/key expression records `accumulate_error`, **freezes `dry_streak`**
      (cannot trigger a dry exit), and the loop stays live.
- [ ] `process_step_result` merges `accumulated`/`accumulated_count` into the finalized step
      output for an accumulating step (authoritative loop output).
- [ ] Exit response carries the deduped `accumulated` set; reports carry the metrics.
- [ ] Existing iteration/stagnation/score_expr tests unaffected.
