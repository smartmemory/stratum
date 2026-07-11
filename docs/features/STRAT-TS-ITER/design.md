# STRAT-TS-ITER — Port the iteration kernel to the TS engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 2

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 2)
- Python reference: `stratum-mcp/src/stratum_mcp/executor.py:2502-2824`
  (`start_iteration`, `report_iteration`, `abort_iteration`),
  `server.py:2691-2747, 3807-3829` (tool wrappers)
- Consumer: compose `lib/stratum-mcp-client.js:329-364` (wrappers) —
  note compose ALSO has its own higher-level
  `mcp__compose__*_iteration_*` tools; those are compose-owned and
  unaffected
- Pinning tests: `tests/integration/test_iterations.py`,
  `test_stagnation.py`, `test_score_expr.py`, `test_accumulator.py`

## Problem

Iteration loops (`stratum_iteration_start/report/abort`) drive
retry-until-good and accumulate-until-dry work inside a flow step. The
TS engine has no equivalent; compose's client wraps all three.

## Contract facts that drive the design (2026-07-11 recon)

1. Loop config lives on the step IR: `max_iterations` (required),
   `exit_criterion` (ensure-expr), `score_expr`, `accumulate`,
   `accumulate_key`. ONE active loop per flow (`active_iteration`).
2. Report semantics: count increments first; best-score tracked on
   strictly-greater (ties keep earlier); accumulate dedups by
   canonical-JSON key with `new_count`/`dry_streak` (a malformed
   accumulate expr FREEZES dry_streak rather than counting a dry round);
   exit-criterion eval context is enriched (best_score/prior_scores/
   iteration or accumulator/accumulated_count/new_count/dry_streak);
   compile errors set `exit_criterion_error` with `exit_met=false`.
3. Stagnation: window 3, fingerprint-identical OR score-not-improved;
   SUPPRESSED for accumulate loops.
4. Outcome precedence: `exit_success > exit_stagnation > exit_max >
   continue`; abort writes `exit_abort` with iteration=count (not
   count+1).
5. Exit payload: `final_result` = best.result when score tracked else
   last result; `accumulated` + `accumulated_count` when accumulating.
6. State keys persisted per flow: `iterations{}`,
   `archived_iterations[]`, `active_iteration`, `iteration_outcome{}`,
   `iteration_best{}`, `iteration_accumulator{}` — flow-scoped, so epic
   D1 (drain-and-cutover) applies; no cross-engine state concerns.
7. Errors are `{status:"error", error_type, message}` via
   MCPExecutionError; distinct types for: no max_iterations, loop
   already active, pending iteration_outcome ("call stratum_step_done
   first"), gate step, step mismatch, no active loop, wrong step.

## Design

Port with one prerequisite the v1 IR must absorb (round-2 review
finding, CONFIRMED): today's v1 `iterate` accepts only `{max, until}`
(`ts/src/ir/schema.ts:21`) and the migration checker explicitly labels
score/accumulate UNSUPPORTED (`ts/src/migrate/check.ts:37`) — so the
loop config this port needs cannot currently exist on a TS run.

- **IR extension first:** `iterate` gains optional `score_expr`,
  `accumulate`, `accumulate_key` (v0→v1 mapping: `max_iterations`→`max`,
  `exit_criterion`→`until`, rest name-identical). `ir/validate.ts`
  validates the new fields; `migrate/check.ts` flips score/accumulate
  from unsupported→mapped. This is part of THIS feature, not assumed.
- **Exclusive ownership — auto vs manual (round-3 finding, CONFIRMED):**
  the TS engine ALREADY auto-drives `step.iterate` inside `stepDone`
  (increments the counter and redispatches, `engine.ts:281`). Two
  drivers over one config would double-count or advance mid-loop. The
  IR therefore gains `iterate.mode: "auto" (default) | "manual"`:
  - `auto` — engine-owned progression exactly as today;
    `stratum_iteration_start` on an auto step errors
    (`iteration_auto_managed`, new error_type, TS-only).
  - `manual` — the three MCP tools own progression; a manual-iterate
    step NEVER enters the engine's auto-iterate branch, in any state:
    (a) active loop → `stepDone` refuses ("call
    stratum_iteration_report", matching Python's pending-outcome
    refusal), no counting; (b) terminal handoff (round-4 finding) —
    after `iteration_report` exits the loop it clears
    `active_iteration` and leaves a pending `iteration_outcome`, which
    the NEXT `stepDone` must CONSUME as the step's final result
    (Python semantics: `executor.py:2738`,
    `test_iterations.py:392`) with zero auto-iterate counting or
    redispatch. **Result authority (round-5 finding):** the persisted
    step result at terminal handoff is the ENGINE-DERIVED
    `final_result` recorded at loop exit (best when score-tracked,
    else last report) — `stepDone`'s caller-supplied output is IGNORED
    for persistence on this path (today's `stepDone` trusts its
    argument, `engine.ts:300`, which would let a best-A/last-B score
    loop complete with B). **Abort routes as failure, not output
    (round-6 finding):** an `exit_abort` handoff must NOT pass the
    abort record through the step's output schema/ensures (a typed
    step's contract would reject `{aborted: true}` and spin the retry
    path) — it bypasses output validation and resolves via the step's
    failure routing (`on_fail` target if declared, else terminal flow
    error `iteration_aborted`), with the abort record and any
    `best_result` attached to the failure payload; (c) no loop
    ever started → `stepDone` refuses ("call
    stratum_iteration_start"), so a manual step cannot silently
    complete un-looped.
  Mixed-use attempts are tested in both directions PLUS the terminal
  handoff. v0→v1 migration maps v0 tool-driven loops to
  `mode: "manual"`.

Otherwise a straight port — self-contained state-machine logic with no
subprocess/concurrency surface:

- **Expressions**: `exit_criterion` and `score_expr` compile through the
  TS engine's existing expression evaluator (`ts/src/eval/expr.ts` — the
  same evaluator `ensure` already uses), with the enriched eval-context
  variables added. Python's `compile_ensure`/`compile_score_expr`
  behavior differences (compile error → recorded, never thrown) are
  preserved.
- **State**: the six iteration keys added to `PersistedRun`
  (`ts/src/engine/state.ts`), shape-identical to the Python persisted
  JSON so envelopes match.
- **Tools**: 3 tools registered via the standard surface-contract path
  (`ts/contracts/mcp-surface.json` + ToolName union + dispatcher case).
- **Fidelity rule**: canonical-JSON dedup keys must match Python's
  canonicalization for `accumulate_key` (same hazard class as guard —
  but flow-scoped only, so ASCII-escape parity matters only within one
  engine's lifetime; still reuse the STRAT-TS-GUARD canonicalizer for
  one implementation, not two).

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/src/ir/schema.ts` + `ir/validate.ts` (existing) | modify | iterate extension: score_expr/accumulate/accumulate_key |
| `ts/src/migrate/check.ts` (existing) | modify | score/accumulate unsupported → mapped |
| `ts/src/engine/iteration.ts` (new) | add | start/report/abort state machine |
| `ts/src/engine/state.ts` (existing) | modify | six iteration keys on PersistedRun |
| `ts/src/eval/expr.ts` (existing) | modify | enriched eval-context variables (if not already expressible) |
| `ts/src/mcp/server.ts` + `ts/contracts/mcp-surface.json` (existing) | modify | 3 tools |
| `ts/tests/engine/iteration.test.ts` (new) | add | ported pinning tests: outcome precedence, stagnation window+suppression, score ties, dry-streak freeze, error types |

## Acceptance criteria

- [ ] v1 `iterate` extension validated + migration checker updated
      (score/accumulate no longer flagged unsupported; v0 tool-driven
      loops map to mode:"manual"); v0→v1 field mapping table recorded
      here
- [ ] Auto/manual exclusivity: iteration_start on auto step →
      `iteration_auto_managed`; manual step never enters the
      auto-iterate branch in ANY state (active-loop refusal, terminal
      outcome consumed by stepDone with no counting/redispatch,
      no-loop refusal); all paths tested
- [ ] Terminal result authority: engine-derived final_result persisted,
      caller output ignored on the handoff path; best-not-last tested
- [ ] Abort routing: exit_abort bypasses output schema/ensures and
      resolves via failure routing (on_fail / `iteration_aborted`);
      abort-at-zero on a TYPED step tested (no schema-retry spin)
- [ ] 3 tools contract-identical (params, success envelopes incl.
      optional fields, all error_types)
- [ ] Outcome precedence + stagnation (window 3, accumulate suppression)
      table-driven-tested
- [ ] Score semantics: strictly-greater updates, tie keeps earlier,
      final_result = best when tracked
- [ ] Accumulate semantics: canonical-key dedup, new_count, dry_streak
      freeze on malformed expr
- [ ] exit_criterion_error / accumulate_error surfaced not thrown
- [ ] Compose iteration wrappers exercised against TS in one golden loop
      (start → N reports → exit_success; plus one abort)

## Open questions

- None.
