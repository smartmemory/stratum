# STRAT-DISTILL — Design Brief

**Status:** PROPOSED · pre-design (promoted from forge-top ROADMAP 2026-06-14). Scope verified against `src/`; full design + blueprint pending the normal gate. This is a seed, not a committed design — do not review as shipped code.

**Source:** Xiaomi MiMoCode teardown (2026-06-13). MiMo's `/distill` command (`agent/prompt/distill.txt`) mines its session-trajectory DB for repeated *manual* workflows and packages the high-confidence ones into reusable skills / subagents / commands.

## Problem / gap

Stratum learns in two places today, and neither produces **new reusable assets from successful patterns**:

- `STRAT-LEARN-INLINE` — *failure-triggered*: when a `stratum_judge` predicate fails (`must-fix`/`not_met`), `judge/inline_learn.py:classify_fix_target` classifies the fix as transient / step-local / `durable`, and `durable` emits a **staged patch candidate** for an *existing* skill/MEMORY into the sidecar.
- `STRAT-JUDGE-POSTMORTEM` — mines transcripts for *judge calibration*, not asset synthesis.

Nothing watches for a workflow the operator performed **repeatedly and successfully** and offers to package it as a new asset.

## Verified scope (2026-06-14 vs `src/`)

Reusable as-is:
- **Transcript ingestion** — `judge/postmortem/loader.py:239` (`load_session`, walks `~/.claude/projects/*/*.jsonl`) + `segmenter.py`. Same path `stratum-learn` skill uses.
- **Candidate staging discipline** — `judge/inline_learn.py` `PatchCandidate` + `judge/postmortem/corpus.py:append_inline_candidates` (append-only, idempotent, `inline-1.0` schema sidecar) + `stratum_audit` surfacing.

Net-new (do **not** assume reuse):
- **Detector.** LEARN-INLINE keys off judge *verdicts*; DISTILL needs cross-session **recurrence counting over tool-call sequences** (MiMo's `(tool, input_preview) count(*) DESC` over the loaded trajectory + user-turn signals like "again"/"every time"). Confirmed: `grep distill src/` → 0 hits (genuinely net-new, not a stale row).
- **Candidate schema extension** — emit whole new assets (`SKILL.md` + frontmatter, `agent/<n>.md`, `command/<n>.md` w/ `$ARGUMENTS`), not just skill/MEMORY patches.

## Proposed mechanism (sketch — to be hardened at design gate)

LLM-driven, mirroring MiMo's 6-phase prompt: locate trajectory → inventory existing assets (extend-not-duplicate) → detect repeats from memory → confirm against raw trajectory → shortlist → pick smallest form → create + verify (Glob paths, Grep symbols).

Discipline carried over from MiMo + Stratum constraints:
- **Confidence bar:** a candidate counts only if it recurred **≥2×** with stable inputs + a clear stopping condition and isn't already covered by an existing asset.
- **Anti-slop guard:** "if nothing recurred, **create nothing** — that is a valid, successful outcome." Never manufacture an asset to justify the run.
- **Staged, not auto-applied** (STRAT-IMMUTABLE / `feedback_review_loop_roles`): candidates surface for review in the audit trace, never silently written to the working tree.
- **Source-of-truth:** raw trajectory authoritative, memory files a cache (matches the sidecar ≠ corpus rule).
- **Optional cron-like auto-run** (MiMo defaults distill every 30d, interval + debounce + project-age gated) — but **default manual/opt-in**, like the other learn gates (`learn.inline_patch` default OFF).

## Open design questions

- Detector form: pure-Python recurrence counter vs LLM-over-trajectory vs hybrid.
- Surface: new `stratum_distill` MCP tool, a CLI verb, or a skill wrapper over the postmortem loader?
- Where staged candidates land (own sidecar vs reuse `inline_candidates.jsonl`) — likely a new `distill_candidates.jsonl` to keep schemas clean.
- Auto-run config shape (`[learn.distill]`?) and default-OFF parity with `[learn.inline_patch]`.

## Non-goals

- Auto-applying generated assets to the working tree.
- Replacing `STRAT-JUDGE-POSTMORTEM` (calibration) or `STRAT-LEARN-INLINE` (failure-patch) — DISTILL is the success-pattern complement.
