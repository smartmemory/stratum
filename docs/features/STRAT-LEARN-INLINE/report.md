# STRAT-LEARN-INLINE — Implementation Report

**Status:** SHIPPED (v1) · **Owner:** stratum · **Date:** 2026-06-08
**Design/Blueprint/Plan:** `./design.md`, `./blueprint.md`, `./plan.md`

## 1. Summary

A default-OFF **inline self-patch harvester edge** on the judge kernel. When `stratum_judge` returns a `must-fix` finding, the harvester classifies each failed predicate's fix target (`transient` / `step-local` / `durable`) and, for `durable`, emits a **staged, described** skill/MEMORY patch *candidate* into (a) the `stratum_audit` trace and (b) a dedicated inline sidecar (`.stratum/postmortem/inline_candidates.jsonl`). Candidates are never applied and never touch the running spec. Closes the gap between within-step self-correction (regenerate-until-met) and across-run learning (offline postmortem `--all`).

## 2. Delivered vs Planned

| Slice | Planned | Delivered |
|-------|---------|-----------|
| S0 | `[learn.inline_patch]` config + env override | `LearnConfig`, `StratumConfig.learn`, `resolve_inline_learn` (env precedence) ✓ |
| S1 | pure classify+emit | `inline_learn.py` — `FixTarget`, `PatchCandidate`, heuristic + fail-open LLM classifier, `emit_candidates` ✓ |
| S2 | flock sidecar writer | `postmortem/corpus.py` — `append_inline_candidates`, turn-scoped idempotent, `flock`-guarded ✓ |
| S3 | FlowState carriers | `learn_candidates` + `learn_inline_evaluated`, omit-when-empty persist/restore ✓ |
| S4 | MCP harvest + audit | `_harvest_inline_learn` (fail-open, ctx-threaded) at the `stratum_judge` seam; `learn_inline` + `staged_patch_candidates` audit keys ✓ |

## 3. Key Decisions / Deviations

- **Harvest at the MCP consumer edge, not the kernel** (blueprint C1). The judge contract permits extra props (no `additionalProperties:false`), so a `JudgeResult` field wouldn't break validation — but threading harvester data through a cross-repo contract is a coupling smell. Net: **zero kernel / `JudgeResult` / judge-contract change**; off-path byte-identity is structural.
- **Separate inline sidecar, not the transcript corpus.** `candidates.jsonl` readers dereference transcript fields and treat `label` as replay ground-truth; inline rows use their own `inline-1.0` schema with `origin:"inline"` and no `label`.
- **v1 scope = the `stratum_judge` judge-step seam only.** `run_judge` also runs from the goal orchestrator and guard transitions; goal is deferred (`-GOAL`), guard is deliberately excluded (a lifecycle gate, not a dev-work diagnosis).
- **Described intent, not literal diffs** (design D2). `patch_type` is the intended op; the curator authors the final string.

## 4. Test Coverage

- `tests/test_project_config.py` (+10): default-disabled, valid parse, invalid classifier / non-table / non-bool → `StratumCompileError`, `resolve_inline_learn` env precedence.
- `tests/test_inline_learn.py` (12): classification table, durable-only emission, memory/skill targeting, LLM fail-open + honors-response.
- `tests/test_inline_corpus.py` (6): inline schema/no-label, turn-scoped idempotency, distinct turns, empty no-op, 8-thread flock concurrency.
- `stratum-mcp/tests/test_server_inline_learn.py` (5): off-path byte-identity (judge dict + persisted JSON + audit), evaluated-but-no-durable, durable harvest end-to-end, fail-open, **LLM ctx-threading regression**.
- Full suites green: `tests/` 711, `stratum-mcp/tests/` 1418 (2 Docker-gate skips).

## 5. Review

- Codex design gate: CLEAN (3 rounds, 8→2→0).
- Codex blueprint gate: CLEAN (2 rounds, 6→1→0).
- Implementation review: Codex was rate-limited; used the documented fallback (independent reviewer agent). Found **1 medium** (LLM classifier silently dead — `ctx` not threaded to `stratum_agent_run`, masked by over-permissive `**kwargs` test stubs) + 3 low. Medium fixed (ctx-bound `_agent_run` closure + real-signature regression test); low #2 (substring parse) fixed (word-boundary + ambiguity fallback). Low nits (`\bskill\b` hint over-match, crash-only torn-line) accepted as documented/non-load-bearing.

## 6. Files Changed

- `src/stratum/judge/inline_learn.py` (new), `src/stratum/judge/postmortem/corpus.py` (new)
- `src/stratum/project_config.py`, `stratum-mcp/src/stratum_mcp/executor.py`, `stratum-mcp/src/stratum_mcp/server.py`
- Tests: `tests/test_inline_learn.py` (new), `tests/test_inline_corpus.py` (new), `tests/test_project_config.py` (+), `stratum-mcp/tests/test_server_inline_learn.py` (new)

## 7. Known Issues & Follow-ups

- `STRAT-LEARN-INLINE-ENSURE` — extend the trigger to the executor `ensure`-failure path (needs structured violations first).
- `STRAT-LEARN-INLINE-CORRECTION` — inline user-correction trigger (lift postmortem `signals.py` into the live loop).
- `STRAT-LEARN-INLINE-APPLY` — opt-in literal old→new synthesis + guarded apply path.
- `STRAT-LEARN-INLINE-GOAL` — harvest the goal-orchestrator `run_judge` loop (needs the goal FlowState serializer to carry `learn_*`).

## 8. Lessons Learned

- An impl-level review caught a dead deliverable a green test suite hid: `**kwargs` stubs that don't mirror the real callee signature mask wiring bugs ([[feedback_review_loops_catch_unwired]]). The regression test now stubs `stratum_agent_run` with its real `(prompt, ctx, type=...)` signature.
- Verify-first paid off again: the row was genuinely unbuilt, but the substrate (judge kernel, postmortem corpus) was shipped — so this was small additive work on real seams, not a rebuild.
