# STRAT-WORKFLOW-IMPERATIVE — Implementation Report

**Status:** COMPLETE (2026-05-29) · **Owner repo:** stratum · branch `strat-workflow-imperative`
**Design:** [./design.md](./design.md) · **Blueprint:** [./blueprint.md](./blueprint.md)

## 1. Summary

Added a governed accumulator-with-dedup + loop-until-dry exit predicate to the stratum-mcp
per-step iteration loop (STRAT-ENG-4). A step can now declare `accumulate` (and optional
`accumulate_key`) to collect deduped items across iterations; `exit_criterion` additionally
sees `accumulator` / `accumulated_count` / `new_count` / `dry_streak`, so loop-until-dry is
expressed as `exit_criterion: "dry_streak >= K"`. No new control-flow construct, no new MCP
tools, no new outcome verb.

## 2. Delivered vs Planned

| Planned (design acceptance criteria) | Delivered |
|---|---|
| `accumulate`/`accumulate_key` parse + validate + round-trip | ✅ spec.py fields, schema v0.2+v0.3, `_build_step`, validation (requires, dunder, gate + parallel/decompose reject) |
| Included in spec checksum | ✅ `_step_fingerprint` |
| `iteration_accumulator` persists/restores/checkpoints + clears in all paths | ✅ persist/restore/checkpoint + `_clear_from` + server retry-reset + success + all 4 terminal-failure routes |
| Canonical-string dedup keys (non-hashable handled) | ✅ `json.dumps(key, sort_keys=True, default=str)` |
| accumulator kwargs on `exit_criterion`; `dry_streak >= K` exits | ✅ unified `eval_kwargs` |
| Malformed accumulate freezes `dry_streak` | ✅ `accumulate_error`, no dry exit on extraction bug |
| Authoritative output merge | ✅ `process_step_result` merges after validation |
| Existing iteration/stagnation/score_expr tests unaffected | ✅ full suite 1044 passed, 2 skipped |

## 3. Architecture deviations

- **Stagnation suppression (added during review).** Original design left stagnation untouched.
  Codex found that fingerprint-stagnation (`_STAGNATION_WINDOW=3`) preempts a `dry_streak >= K`
  loop when `K > 3` (repeated dry rounds share a fingerprint). Resolution: skip fingerprint
  stagnation entirely when `accumulate` is set — accumulator loops are governed solely by
  `exit_criterion` + `max_iterations`. Narrow (gated on `ai.get("accumulate")`), so existing
  non-accumulator loops keep their stagnation safety net.
- **Parallel/decompose rejection (added during review).** `accumulate`/`accumulate_key` are
  rejected on `decompose`/`parallel_dispatch` steps (mirrors the existing `score_expr`
  rejection) — they don't run the per-step iteration loop.

## 4. Key implementation decisions

1. **Reuse `exit_criterion` over a new `until_dry` field** (design Approach A) — loop-until-dry
   is a predicate, not a construct. Composable: `"dry_streak >= 2 or accumulated_count >= 50"`.
2. **`compile_value_expr(expr, bind)`** — one value-returning compiler (mirrors
   `compile_score_expr`), parameterized binding (`result`/`item`), dunder guard + restricted
   builtins. Self-guards dunder at runtime (defense-in-depth beyond spec validation).
3. **accumulate_error freezes `dry_streak`** — a broken extractor can't manufacture a dry exit.
4. **Authoritative merge after validation** — injected `accumulated`/`accumulated_count` keys
   never pass through `output_schema`/guardrails/ensures.

## 5. Test coverage

`tests/integration/test_accumulator.py` — 20 tests: validation (requires/dunder/gate/parallel
reject), dedup (default + custom key + non-hashable key), loop-until-dry (incl. threshold >
stagnation window, reset-on-new), accumulate_error freeze, per-item identity fallback,
authoritative merge, on_fail/ensure-terminal cleanup, persist/restore + checkpoint round-trip,
tamper-detection checksum, accumulate-to-max, accumulate+score_expr combined.

## 6. Files changed

- `stratum-mcp/src/stratum_mcp/spec.py` — IR fields, schema ×2, parse, validation
- `stratum-mcp/src/stratum_mcp/executor.py` — `compile_value_expr`, FlowState field,
  persist/restore/checkpoint/clear, `_step_fingerprint`, `start_iteration`, `report_iteration`,
  `process_step_result`
- `stratum-mcp/src/stratum_mcp/server.py` — retry-reset clear + `stratum_iteration_report` docstring
- `stratum-mcp/tests/integration/test_accumulator.py` (new) — 20 tests
- `CHANGELOG.md`, `SPEC.md` — docs

Commits: `3dd88b3` design · `38876c1` blueprint · `d92eb0c` impl+tests · `5f0fb82` review fixes.

## 7. Known issues & tech debt

- **`score_expr` is not in the spec checksum** (pre-existing — `_step_fingerprint` never hashed
  it). `accumulate`/`accumulate_key` ARE now hashed; the `score_expr` gap is left as-is
  (out of scope). Worth a separate one-line follow-up.
- **No consumer yet** — this is a pure Stratum IR capability; compose does not drive iteration
  loops. When a consumer adopts loop-until-dry, validate the end-to-end handshake.

## 8. Lessons learned

- `replace_all` on a shared code shape silently missed a sibling branch at a different
  indentation depth (the 12-space ensure-terminal block vs 16-space schema/guardrail/cert
  blocks) — Codex review caught the stale-state leak. Indentation-sensitive bulk edits need
  per-site verification.
- Verify-first against shipped code reconciled an over-scoped roadmap row (6th instance):
  `while (count < N)` was already STRAT-ENG-4; only the accumulator + dry-predicate were real.
