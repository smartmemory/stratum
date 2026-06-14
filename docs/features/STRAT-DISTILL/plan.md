# STRAT-DISTILL — Implementation Plan

**Status:** PLAN. Slices + boundary map in `./blueprint.md`. TDD per slice (test first → red → implement → green). Per-directory test runs (`cd <dir> && pytest`, `asyncio_mode=auto`).

## Task order (topology: T0 → T1 → T2 → {T3, T4})

### T0 — S0 detector core (`src/stratum/judge/distill/detector.py`, new)
- [ ] Test (`tests/test_distill_detector.py`): build in-memory `Session`/`Event` lists (pattern: `test_postmortem_signals_v22.py:18`); a tool-call sequence repeated across ≥2 sessions → one `WorkflowCandidate` with `count>=2`; a 1× sequence → no candidate; malformed/empty events → skipped, never raises; determinism (same input → same output); `canonicalize_input` uses the `signals.py:125` key priority.
- [ ] Impl: `canonicalize_input`, `tool_sequences(session)` (over `segment()` work_spans), `detect(sessions, min_count=2, window_days=30)`, `WorkflowCandidate` dataclass. Reuse `loader`, `segmenter.segment`, `signals._token_overlap`.
- [ ] Green: `cd stratum && pytest tests/test_distill_detector.py`.

### T1 — S1 candidate + sidecar (`src/stratum/judge/distill/candidate.py` new; `src/stratum/judge/postmortem/corpus.py` mod)
- [ ] Test (`tests/test_distill_corpus.py`): `AssetCandidate.to_dict` flat shape with `patch_type=="create"`; `append_distill_candidates` → row with `origin:"distill"`, `_schema_version:"distill-1.0"`, envelope key `distill_candidate`; idempotent on `cluster_id` (2nd append writes 0); concurrent flock no loss/dup; canonical `candidates.jsonl` + `inline_candidates.jsonl` untouched.
- [ ] Impl: `AssetCandidate` (frozen, mirror `PatchCandidate`; `asset_kind` skill|subagent|command, `patch_type="create"` locked, `cluster_id`/`asset_name`/`trigger_pattern`/`evidence_session_ids`); in `corpus.py` add `DISTILL_SCHEMA_VERSION`, `distill_sidecar_path`, `append_distill_candidates` (copy `append_inline_candidates` flock + `_existing_ids` verbatim; id `distill:{cluster_id}`).
- [ ] Green: `cd stratum && pytest tests/test_distill_corpus.py`.

### T2 — S2 synthesis (`src/stratum/judge/distill/synthesize.py`, new)
- [ ] Test (`tests/test_distill_synthesize.py`): heuristic form-selection table (param prompt→`command`; multi-step→`skill`; specialist→`subagent`); `agent_run=None` → heuristic; `agent_run` raises → heuristic (fail-open, `except Exception`); ambiguous LLM reply → heuristic; below-bar workflow → `None` (create-nothing); `suggested_content` is described text, no file created.
- [ ] Impl: `synthesize(workflow, agent_run=None) -> AssetCandidate | None`; `_heuristic_form`, `_llm_cluster` (Pattern A, fail-open per `inline_learn.py:95-128`).
- [ ] Green: `cd stratum && pytest tests/test_distill_synthesize.py`.

### T3 — S3 CLI verb (`src/stratum/judge/distill/cli.py`, new; wire into CLI entry)
- [ ] Test (`tests/test_distill_cli.py`): `extract` over a temp `--project` dir with a planted repeated sequence → sidecar rows; `top --min-count 3` filters; `stats` summarizes; `--out` resolves + mkdirs (mirror `_resolve_out`).
- [ ] Impl: mirror `postmortem/cli.py:330-397` (`build_parser`, `_project_dirs`, `_resolve_out`); subcommands `extract`/`stats`/`top`; wire into the existing CLI entry point.
- [ ] Green: `cd stratum && pytest tests/test_distill_cli.py`.

### T4 — S4 MCP tool + skill (`stratum-mcp/src/stratum_mcp/server.py` mod; `~/.claude/skills/distill/SKILL.md` new)
- [ ] Test (`stratum-mcp/tests/test_server_distill.py`): tool returns `{candidates,evaluated,written,reason}`; a temp project with a repeated sequence → ≥1 candidate + sidecar written; **empty/no-recurrence corpus → `evaluated:0, written:0` + "nothing to distill" reason** (create-nothing path); tool is stateless (no FlowState mutation, no `learn_*`/`distill_*` keys leak into any flow persistence).
- [ ] Impl: `@mcp.tool stratum_distill(project_dir="", window_days=30, min_count=2, apply=False, ctx)` mirroring `stratum_decompose:2743-2777` (lazy import, `asyncio.to_thread`); `run_distill` orchestrates load→detect→synthesize→append→return. Thin `distill/SKILL.md` wrapper presenting the MiMo Shortlist/Created/Skipped/Needs-evidence format.
- [ ] Green: `cd stratum-mcp && pytest tests/test_server_distill.py`.

### T5 — full-suite + review gate
- [ ] `cd stratum && pytest tests/` green; `cd stratum-mcp && pytest tests/` green (per-directory convention).
- [ ] Codex blueprint + impl review loop → CLEAN (independent reviewer; verify the detector isn't double-counting and the off-path/stateless claim holds).
- [ ] `report.md` with the `stratum_audit` trace.

## Out of scope (v1) — filed as follow-ups
- `STRAT-DISTILL-AUTO`: interval auto-run + `[learn.distill]` config (default OFF, byte-identical) + trigger.
- `STRAT-DISTILL-APPLY`: `apply=True` actually scaffolds the asset behind STRAT-GUARD authorization.
