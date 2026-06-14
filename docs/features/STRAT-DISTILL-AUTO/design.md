# STRAT-DISTILL-AUTO — Design stub

**Status:** PLANNED (follow-up to STRAT-DISTILL v1, filed 2026-06-14). Pre-design.

**Problem:** STRAT-DISTILL v1 ships a manual, stateless distiller (`stratum_distill`
tool + `distill` CLI). The interval auto-run was deliberately deferred — a stateless
manual tool is inherently opt-in (not calling it = zero effect), so the default-OFF /
byte-identical discipline only becomes load-bearing once there is an *automatic*
trigger.

**Scope:**
- `[learn.distill]` config block in `project_config.py` — `enabled: bool = False`,
  `classifier: "heuristic"|"llm"`, `interval_days: int = 30` — mirroring
  `[learn.inline_patch]` (incl. `STRATUM_LEARN_DISTILL_ENABLED` env override and a
  `resolve_distill_learn` resolver). **Default OFF, verified byte-identical off-path.**
- Interval auto-run trigger mirroring MiMo's `auto-dream.ts`: time-since-last-run
  (config interval, default 30d), project-age guard, in-process debounce. Fires
  `run_distill` as a background pass.
- Decide the trigger seam (session-start hook vs MCP-startup vs a `stratum_distill_auto`
  internal entry) — must not block or slow the hot path; wholly fail-open.

**Non-goals:** changing v1's manual tool/CLI behavior; applying assets (that's
STRAT-DISTILL-APPLY).

**Dependencies:** STRAT-DISTILL v1 (shipped). Reuse `runner.run_distill`,
`distill_sidecar_path`, the `[learn.inline_patch]` config + `auto-dream.ts` patterns.
