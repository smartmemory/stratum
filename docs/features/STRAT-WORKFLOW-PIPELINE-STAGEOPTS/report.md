# STRAT-WORKFLOW-PIPELINE-STAGEOPTS — Implementation Report

**Status:** COMPLETE (2026-05-30) · **Owner repo:** stratum · branch `strat-workflow-pipeline-stageopts`
**Design:** [./design.md](./design.md) · **Epic:** STRAT-WORKFLOW — follow-up to `-PIPELINE` (same day).

## 1. Summary

Pipeline stages can now carry their own `task_reasoning_template` (cert) and `task_timeout`, overriding
the step-level defaults — a fast `claude` clean stage and a slow `codex` verify stage no longer share
one timeout, and a stage that must emit structured output can carry its own cert while a free-text stage
carries none. Precedence is one rule everywhere: **stage value if present (`is not None`), else step,
else default.**

The non-obvious half of the work was cert *instructions*: the parallel path historically only
*validated* a cert post-hoc and never injected the instructions into the prompt, so an explicit
per-stage cert would have failed (the agent was never told to produce it). `_render_prompt` now injects
the effective cert's instructions (pipeline-only, graceful-degrade), so per-stage certs actually work.

## 2. Delivered vs Planned

| Criterion | Delivered |
|---|---|
| Stage accepts `task_timeout` + `task_reasoning_template`; rejects `task_timeout:0` / malformed cert | ✅ schema + `_apply_cert_defaults` per stage; tests |
| Desugar stamps `_task_timeout`/`_task_reasoning_template`; precedence stage→step→default | ✅ `expand_pipeline_tasks`; presence-based; tests |
| Per-stage timeout fires; sibling with step-default completes | ✅ executor timing test |
| Explicit per-stage cert on codex **is** validated + injected; step-level on codex is **not** | ✅ shared `effective_pipeline_task_cert`; executor + server tests |
| Stage cert overrides step cert; `{}` inherits default sections | ✅ presence-based + defaults pass; tests |
| Cert instructions injected into stage prompt; parallel_dispatch byte-identical | ✅ `_render_prompt` (is_pipeline-gated); test asserts `do t1` unchanged |
| Checksum changes on stage opt change (no fingerprint edit) | ✅ `stages` fingerprint already serializes the dicts; test |
| Regression: `-PIPELINE` + `parallel_dispatch` unchanged | ✅ full suite 1780 passed |

## 3. Architecture deviations

- **Pipeline-only helper, not an `is_pipeline`-parametrized one.** Design round 3 + a blueprint-time
  catch: the two *non-pipeline* cert sites are already asymmetric (`_run_one` unconditional,
  `_evaluate_parallel_results` claude-gated), so a single helper can't represent both. The helper
  `effective_pipeline_task_cert` is pipeline-only; each call site keeps `if is_pipeline:` → helper,
  `else:` → its existing non-pipeline branch verbatim. Provably zero non-pipeline regression.
- **Injection degrades gracefully.** A malformed cert template (e.g. string sections) would crash
  `inject_cert_instructions` at render time and fail the task; wrapped in try/except → skip injection,
  validation still runs. Surfaced by a `-PIPELINE` regression test whose fake fixture had string sections.

## 4. Key decisions

1. Same field names as step-level (`task_reasoning_template`/`task_timeout`) so precedence is obvious.
2. Explicit per-stage cert bypasses the claude agent-gate (explicit beats heuristic); step-level
   fallback keeps it.
3. One shared helper across all three pipeline cert sites (validate ×2 + inject) so they can't drift.

## 5. Test coverage

13 new tests in `stratum-mcp/tests/test_pipeline.py` (STAGEOPTS section): validation (4), desugar
precedence (1), helper (2), per-stage timeout (1), explicit-codex-cert validated executor+server (2),
injection present / parallel_dispatch-unchanged (2), checksum (1). Combined suite: **1780 passed, 2 skipped.**

## 6. Files changed

`spec.py`, `executor.py`, `parallel_exec.py`, `server.py` (+`tests/test_pipeline.py`).

## 7. Known issues & tech debt

- Per-stage `isolation` / `max_concurrent` / `require` / `merge` remain step-level (pipeline-wide) by
  design — out of scope.

## 8. Lessons learned

- Codex design-gate found the *real* meat here (rounds 2-3): the missing prompt-injection touchpoint and
  the non-pipeline cert asymmetry — neither obvious from the one-line roadmap scope. The impl was then
  clean in one review round because the design had already resolved the hard parts.
