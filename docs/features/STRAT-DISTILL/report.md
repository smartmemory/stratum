# STRAT-DISTILL — Implementation Report (v1)

**Status:** SHIPPED (v1 manual distiller) — 2026-06-14. TDD per slice; both per-directory suites green.

## Summary

Built the success-pattern **workflow → reusable-asset distiller**: a stateless
`stratum_distill` MCP tool + `distill` CLI that mine Claude Code session
transcripts for repeated tool-call workflows and **stage** asset candidates
(skill / subagent / command) for review. The complement to STRAT-LEARN-INLINE
(failure-triggered, patches existing scaffold): DISTILL is recurrence-triggered
and synthesizes *new* assets. Staged, never auto-applied (STRAT-IMMUTABLE).

## Delivered vs planned

| Slice | Planned | Delivered | Tests |
|---|---|---|---|
| S0 detector core | recurrence over tool-call sequences | `distill/detector.py` — `canonicalize_input`, `tool_steps`, `detect`, `WorkflowCandidate` | 6 |
| S1 candidate + sidecar | AssetCandidate + append_distill_candidates | `distill/candidate.py` + `postmortem/corpus.py` additions (`distill-1.0`, flock, idempotent) | 8 |
| S2 synthesis | heuristic + opt-in LLM, create-nothing | `distill/synthesize.py` — `synthesize`, `_heuristic_form`, fail-open `llm_form` | 10 |
| S3 CLI verb | extract/top/stats | `distill/cli.py` + shared `distill/runner.py` (`run_distill`) | 5 |
| S4 MCP tool + skill | stateless `stratum_distill` + wrapper | `server.py` tool + `~/.claude/skills/distill/SKILL.md` | 3 |

**32 new tests, all green.** Full suites: stratum library `743 passed` (14
pre-existing `test_e2e.py` real-LLM timeouts, unrelated/untouched); stratum-mcp
`1421 passed, 2 skipped, 0 failed`.

## Architecture decisions / deviations from plan

1. **Stateless tool, no FlowState carriers.** `stratum_distill` mirrors
   `stratum_decompose` (stateless), so no `FlowState` fields / `_build_audit_snapshot`
   changes were needed — simpler and verifiably no flow-state leakage (asserted by
   `test_distill_is_stateless`). This is what let auto-run be cleanly deferred.
2. **Whole-session step extraction (not segmenter work_spans) for v1.** The
   blueprint sketched goal-bounded spans via `segmenter.segment`; v1 reads the whole
   session event stream instead — deterministic, no dependency on segmenter heuristics.
   Goal-bounded spans (so n-grams don't cross unrelated goals) are a noted refinement.
3. **Shared `runner.py`.** Extracted `run_distill`/`load_sessions` so the CLI and the
   MCP tool share one orchestrator (no duplication).
4. **LLM pass = injectable sync `llm_form`.** Rather than threading async `agent_run`
   into the sync CLI, the opt-in LLM override is a sync callable (fail-open). v1 ships
   heuristic-only by default; the MCP tool can inject an LLM-backed `llm_form` later.

## Files changed

**New (src):** `src/stratum/judge/distill/{__init__,detector,candidate,synthesize,runner,cli}.py`
**Modified (src):** `src/stratum/judge/postmortem/corpus.py` (distill sidecar writer); `stratum-mcp/src/stratum_mcp/server.py` (`stratum_distill` tool)
**New (tests):** `tests/test_distill_{detector,corpus,synthesize,cli}.py`, `stratum-mcp/tests/test_server_distill.py`
**New (skill, vendored):** `stratum-mcp/src/stratum_mcp/skills/distill/SKILL.md` — bundled in the package (ships in the wheel; verified `stratum_mcp-0.2.68-py3-none-any.whl` contains it), installed/upgraded to `~/.claude/skills/distill/` by `stratum-mcp install` (idempotent content-compare + `.stratum-skills.json` manifest, same path as the other bundled skills). `EXPECTED_SKILLS` in `tests/integration/test_setup.py` extended to cover it (flow-instruction assertion scoped to `FLOW_SKILLS` since distill is a tool-wrapper, not a flow-orchestration skill).
**Docs:** `docs/features/STRAT-DISTILL/{design,blueprint,plan,report}.md`

## Known limits / follow-ups filed

- **`STRAT-DISTILL-AUTO`** — interval auto-run + `[learn.distill]` config (default OFF, byte-identical off-path) + trigger (mirror MiMo `auto-dream.ts`). Deferred per ship-narrow-first.
- **`STRAT-DISTILL-APPLY`** — graduate `apply=True` to actually scaffold the asset behind STRAT-GUARD authorization (currently reserved/no-op, always stages).
- **Goal-bounded spans** — use `segmenter.segment` work-spans so n-grams respect goal boundaries (v1 uses whole-session sequences).
- `window_days` is best-effort (session-file mtime), not event-timestamp based.

## Stratum audit trace

Flow `7022b74f-1144-4199-a7a6-4e43d1ca28b5` — completed, all 6 slices passed
their `ensure` postconditions on **attempt 1** (no retries / no reverts):

| Step | Function | Attempts | Result |
|---|---|---|---|
| s0_detector | build_s0 | 1 | ✅ detector + 6 tests green |
| s1_candidate_sidecar | build_s1 | 1 | ✅ AssetCandidate + sidecar + 8 tests |
| s2_synthesize | build_s2 | 1 | ✅ synthesis + 10 tests |
| s3_cli | build_s3 | 1 | ✅ CLI + runner + 5 tests |
| s4_mcp_skill | build_s4 | 1 | ✅ MCP tool + skill + 3 tests |
| s5_gate | build_s5 | 1 | ✅ full suites green (modulo pre-existing e2e) |

Postcondition `ensure` expressions enforced per slice: target files exist /
`corpus.py` contains `append_distill_candidates` / `server.py` contains
`stratum_distill` / `SKILL.md` exists / `tests_pass == True`.
