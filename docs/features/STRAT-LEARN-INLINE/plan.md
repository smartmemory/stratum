# STRAT-LEARN-INLINE — Implementation Plan

**Status:** PLAN (Phase 6) · Slices + Boundary Map in `./blueprint.md`. TDD per slice (test first → red → implement → green). Per-directory test runs.

## Task order (topology: S0 → S1 → S2 → S3 → S4)

### T0 — S0 config (`src/stratum/project_config.py`)
- [ ] Test (`tests/test_project_config.py`): default `learn.inline_patch_enabled is False`; valid `[learn.inline_patch]` parse; invalid `classifier` + non-table section → `StratumCompileError`; `resolve_inline_learn` env precedence (set/unset).
- [ ] Impl: `LearnConfig` dataclass; additive `StratumConfig.learn`; `load` parses `raw.get("learn",{}).get("inline_patch",{})`; module-level `resolve_inline_learn(workspace_root)` with env override `STRATUM_LEARN_INLINE_PATCH_ENABLED`.
- [ ] Green: `pytest tests/test_project_config.py`.

### T1 — S1 pure classify+emit (`src/stratum/judge/inline_learn.py`, new)
- [ ] Test (`tests/test_inline_learn.py`): classification table over `(type, verdict, reason)`; only `judged`+`not_met` → `durable` candidate; `transient`/`step-local` → no candidate; `build_candidate` default `target_path == ".claude/memory/MEMORY.md"`, no literal diff; LLM-classifier raises → falls back to heuristic.
- [ ] Impl: `FixTarget`, `InlineLearnConfig`, `PatchCandidate(+to_dict)`, `_heuristic_classify`, `_llm_classify` (fail-open), `classify_fix_target`, `build_candidate`, `async emit_candidates`.
- [ ] Green: `pytest tests/test_inline_learn.py`.

### T2 — S2 sidecar writer (`src/stratum/judge/postmortem/corpus.py`, new)
- [ ] Test (`tests/test_inline_corpus.py`): append → row with `origin:"inline"`, `_schema_version:"inline-1.0"`, no `label`; idempotent on `(flow,step,predicate,turn)` (2nd append writes 0); distinct turns → distinct rows; concurrent appends under flock → no loss/dup; canonical `candidates.jsonl` untouched.
- [ ] Impl: `append_inline_candidates(...)` with `fcntl.flock(LOCK_EX)` (mirror `guard/store.py:344`), read-existing-ids → write-missing, `LOCK_UN` in finally.
- [ ] Green: `pytest tests/test_inline_corpus.py`.

### T3 — S3 FlowState carriers (`stratum-mcp/src/stratum_mcp/executor.py`)
- [ ] Impl: add `learn_candidates: list[dict]` + `learn_inline_evaluated: int` after `judge_outcome` (`:1064`); `persist_flow` omit-when-empty append (`:1434`); `restore_flow` `.get(...)`.
- [ ] (Covered by T4 round-trip test; optionally a focused persist/restore unit.)

### T4 — S4 MCP harvest + audit (`stratum-mcp/src/stratum_mcp/server.py`)
- [ ] Test (`stratum-mcp/tests/test_server_inline_learn.py`): **off-path byte-identity** (flag off → `stratum_judge` return + persisted JSON + audit byte-identical to baseline, no new keys); enabled flow with a `judged not_met` predicate → `_harvest_inline_learn` writes sidecar + `state.learn_*`; `stratum_audit` returns `learn_inline:{evaluated,durable}` + `staged_patch_candidates`; enabled-but-non-durable → `learn_inline` with `durable:0`, no `staged_patch_candidates`; harvest exception → judge result still returned (fail-open).
- [ ] Impl: `_inline_sidecar(workspace_root)`, `async _harvest_inline_learn(...)` (fail-open, blueprint §5), call at `server.py:2422` between `record_judge_turn` and `persist_flow`; `_build_audit_snapshot` conditional keys.
- [ ] Green: `pytest stratum-mcp/tests/test_server_inline_learn.py`.

## Exit gate (Phase 7)
- [ ] Per-directory suites green: `pytest tests/` and `pytest stratum-mcp/tests/` (bounded, exclude live `test_e2e`).
- [ ] Codex implementation review loop → REVIEW CLEAN.
- [ ] Coverage sweep → TESTS PASSING.
- [ ] Docs (CHANGELOG, ROADMAP row, feature.json/report).
