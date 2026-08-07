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

## Requirement: no unattended accumulation without gate 5 (added 2026-08-07)

- [ ] **An automatic trigger MUST NOT be composed with an apply path until the
  pre-commit admission gate (`../STRAT-DISTILL-APPLY/design.md` §"Apply-path guardrails"
  gate 5) is satisfied.** Auto-run that only *stages* is in scope as written. Auto-run
  plus `apply=True`, in any combination or convenience flag, is out of scope for this
  feature and blocked on gate 5.

**Why the split is drawn there.** This stub's scope is staging-only, and staged
candidates in the sidecar never enter the runtime decision context — so auto-staging on
its own does not grow the asset pool and does not start a contamination chain
(arXiv:2608.05810, summarized in the APPLY design). The risk is compositional: the moment
an automatic trigger sits upstream of a write, the pool grows with no critic in the loop,
which is precisely the unconditional-accumulation regime the paper measures degrading past
a critical pool size. Ordering matters more than either feature alone — if -APPLY lands
first, this feature becomes the thing that makes it unattended.

**Second-order concern, worth designing against even for staging-only:** a 30-day
unattended pass raises staged-candidate volume without raising review capacity. Human
review is v1's de-facto admission critic; high-volume review degrades into
rubber-stamping ([[feedback_pipeline_intent_specificity]]), which silently converts
"human-gated" into "ungated" without any code changing. Consider a per-run candidate cap
and a per-candidate marginal-gain score in the auto path's output, so the reviewer is
triaging a ranked shortlist rather than a queue.
