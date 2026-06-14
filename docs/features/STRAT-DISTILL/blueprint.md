# STRAT-DISTILL — Blueprint (slices + boundary map)

**Status:** PRE-IMPLEMENTATION design. Grounded in a 2026-06-14 read of the actual stratum source (file:line refs below). Do not review as shipped code.

## v1 scope (ship-narrow-first)

**v1 = the manual distiller.** A stateless `stratum_distill` MCP tool + a `distill` CLI verb that: load Claude Code transcripts → detect repeated tool-call workflows → synthesize **staged** asset candidates (skill / subagent / command) → write a sidecar + return them. Always-available, manual, additive.

**Deferred to `STRAT-DISTILL-AUTO` follow-up:** cron-like auto-run, the `[learn.distill]` config flag, and the interval trigger. Rationale: a stateless manual tool is inherently opt-in (not calling it = zero effect), so there is no off-path to keep byte-identical and no dead config in v1. Auto-run is where the default-OFF + byte-identical discipline becomes load-bearing — it ships with its own trigger.

This mirrors how `stratum_decompose` (stateless) and `STRAT-LEARN-INLINE` (the auto-edge) were split.

## Reuse vs net-new (verified 2026-06-14)

| Concern | Source | Reuse / net-new |
|---|---|---|
| Transcript load | `judge/postmortem/loader.py:193,238` (`load_session`, `iter_sessions`) | **reuse as-is** |
| Event/Session model | `loader.py:15-43` (`Event{kind,tool_name,tool_input,...}`, `Session.events`) | **reuse** — `kind=="tool_use"` carries `tool_name` + `tool_input` |
| Per-goal tool sequence | `judge/postmortem/segmenter.py:148-160` (`Candidate.work_span`) | **reuse** — work_span is a ready-made tool-call sequence |
| input canonical keys | `signals.py:125` (`command/file_path/path/pattern/url/notebook_path`) | **reuse** the key list |
| text similarity | `signals.py:397` (`_token_overlap`) | **reuse** for trigger-text clustering |
| Cross-session recurrence aggregator | — | **net-new** (n-gram over tool_name sequences + `(tool,input_preview)` counting) |
| Candidate staging | `judge/inline_learn.py:47-74` (`PatchCandidate`), `postmortem/corpus.py:28-103` (`append_inline_candidates`, flock+idempotent) | **mirror** (new `AssetCandidate` + `append_distill_candidates`) |
| MCP tool shape | `stratum-mcp/.../server.py:2743-2777` (`stratum_decompose`, stateless, fail-open) | **mirror** |
| LLM fail-open | `inline_learn.py:95-128` (injected `agent_run`, `except Exception: pass` → heuristic) | **mirror** (Pattern A) |
| byte-identical / off-path test | `stratum-mcp/tests/test_server_inline_learn.py:87-103` | **mirror** test discipline |

## Boundary map

| Slice | Files | New/mod |
|---|---|---|
| S0 detector core | `src/stratum/judge/distill/__init__.py`, `src/stratum/judge/distill/detector.py` | new |
| S1 candidate + sidecar | `src/stratum/judge/distill/candidate.py` (new), `src/stratum/judge/postmortem/corpus.py` (+`append_distill_candidates`, `distill_sidecar_path`, `DISTILL_SCHEMA_VERSION`) | new + mod |
| S2 synthesis | `src/stratum/judge/distill/synthesize.py` | new |
| S3 CLI verb | `src/stratum/judge/distill/cli.py` (new), wire into existing CLI entry | new + mod |
| S4 MCP tool + skill | `stratum-mcp/src/stratum_mcp/server.py` (+`stratum_distill`), `~/.claude/skills/distill/SKILL.md` (thin wrapper) | mod + new |

Topology: **S0 → S1 → S2 → {S3, S4}** (S3/S4 both depend on S2, independent of each other).

## Slices

### S0 — detector core (pure, net-new)
- `canonicalize_input(tool_input) -> str` using the `signals.py:125` key priority (`command`→`file_path`→`path`→`pattern`→`url`→`notebook_path`→`json.dumps(...)[:120]`).
- `tool_sequences(session) -> list[list[str]]` from `segment(session)` work_spans (`[ev.tool_name for ev in span if ev.kind=="tool_use"]`).
- `detect(sessions, *, min_count=2, window_days=30) -> list[WorkflowCandidate]` — counts `(tool, canonical_input)` singletons AND tool-name n-grams (n=2..5) across sessions; a `WorkflowCandidate` carries `signature`, `count`, `evidence_session_ids`, `sample_inputs`, `stopping_condition_seen: bool`.
- **Bar:** keep only `count >= min_count` with ≥2 distinct sessions (stable-input + recurrence). Empty result is a valid success.
- `ensure`: deterministic (same sessions → same candidates); never raises on malformed events (skip).

### S1 — AssetCandidate + sidecar (mirror staging)
- `AssetCandidate` (frozen, `to_dict`): `asset_kind: Literal["skill","subagent","command"]`, `patch_type="create"` (locked), `asset_name`, `target_path` (intended), `trigger_pattern`, `rationale`, `suggested_content`, `evidence_session_ids: list[str]`, `cluster_id`, `confidence:int`.
- `corpus.py`: `DISTILL_SCHEMA_VERSION="distill-1.0"`, `distill_sidecar_path(root)→.stratum/postmortem/distill_candidates.jsonl`, `append_distill_candidates(...)` — copy `append_inline_candidates` flock + `_existing_ids` + idempotency verbatim; id = `distill:{cluster_id}`, `origin="distill"`, envelope key `distill_candidate`.
- `ensure`: append-only, idempotent on `cluster_id`, concurrent-safe, canonical `candidates.jsonl`/`inline_candidates.jsonl` untouched.

### S2 — synthesis (heuristic + opt-in LLM, fail-open)
- `synthesize(workflow, *, agent_run=None) -> AssetCandidate | None`. Heuristic "smallest form": parameterized single repeated prompt → `command`; multi-step procedure with stable shape → `skill`; delegatable bounded specialist → `subagent`. Below-bar / ambiguous → `None` ("create nothing").
- Opt-in LLM clustering/worth-packaging pass (Pattern A): `if agent_run is None` → heuristic; `except Exception: pass` → heuristic. Never fabricates; rejects ambiguous multi-label replies.
- **Described, not written:** `suggested_content` is a description, no file is created (STRAT-IMMUTABLE; staged in sidecar + tool result only).

### S3 — `distill` CLI verb (mirror postmortem cli.py)
- Subcommands `extract` / `stats` / `top`, mirroring `postmortem/cli.py:330-397` (`build_parser`, `_project_dirs`, `_resolve_out`). `--project` default `~/.claude/projects/-Users-ruze-reg-my-forge`, `--all`, `--out .stratum/postmortem/distill_candidates.jsonl`, `--min-count 2`, `--window-days 30`.

### S4 — `stratum_distill` MCP tool + skill wrapper (mirror stratum_decompose)
- `@mcp.tool` stateless: `stratum_distill(project_dir="", window_days=30, min_count=2, apply=False, ctx)` → lazy import, `asyncio.to_thread(run_distill, ...)`. Returns `{candidates: [AssetCandidate.to_dict()], evaluated: int, written: int, reason: str}`. `apply` is reserved/no-op in v1 (always staged; documented).
- Thin `~/.claude/skills/distill/SKILL.md` human entry that calls the tool and presents the shortlist with the MiMo output format (Shortlist / Created-or-nothing / Skipped / Needs-more-evidence).

## Test plan
- S0: in-memory `Session`/`Event` lists (no JSONL fixture factory — `test_postmortem_signals_v22.py:18` pattern). Repeated 3× sequence → detected; 1× → not; malformed events → skipped not raised; determinism.
- S1: `AssetCandidate.to_dict` shape; append idempotent on `cluster_id` (2nd append writes 0); concurrent flock no loss; schema `distill-1.0`; other sidecars untouched.
- S2: heuristic form-selection table; `agent_run=None` → heuristic; LLM raises → heuristic; below-bar → `None`.
- S3: CLI `extract` end-to-end on a temp project dir → sidecar rows; `top --min-count` filters.
- S4: tool returns candidates + writes sidecar; **empty corpus → `evaluated:0, written:0` + "nothing to distill" reason** (the create-nothing path); per-directory pytest (`asyncio_mode=auto`).

## Deferred follow-ups
- `STRAT-DISTILL-AUTO` — interval auto-run + `[learn.distill]` config (default OFF, byte-identical off-path) + project-age/debounce trigger (mirror MiMo `auto-dream.ts`).
- `STRAT-DISTILL-APPLY` — graduate `apply=True` to actually scaffold the asset (behind STRAT-GUARD-style authorization), not just stage.
