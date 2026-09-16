# STRAT-LEARN-INLINE-TS-1 — Restore the automatic inline harvest trigger lost in the TS cutover

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-09-16
**Supersedes-in-part:** [`STRAT-LEARN-INLINE`](../STRAT-LEARN-INLINE/report.md) (SHIPPED 2026-06-08, Python)

## Related Documents

- [`STRAT-LEARN-INLINE/report.md`](../STRAT-LEARN-INLINE/report.md) — the Python v1 that shipped and
  then silently stopped existing. Its design/blueprint/plan remain the specification of intent.
- [`STRAT-CONFIG-PREFS-1`](../STRAT-CONFIG-PREFS-1/design.md) — the config layer whose strict
  unknown-key rejection surfaced this. Provides the layered home this feature's switch belongs in.
- `git show python-legacy:src/stratum/judge/inline_learn.py` — the retired harvester edge.

## The finding

`STRAT-LEARN-INLINE` shipped on 2026-06-08 as a **default-OFF automatic edge on the judge path**:
when `stratum_judge` returned a `must-fix` finding, the harvester classified each failed predicate
and staged a described patch candidate — with no human in the loop. The user enabled it on
2026-06-11, recording the preference in `compose/stratum.toml`:

```toml
# Enabled 2026-06-11 per user request so working-style lessons
# get harvested automatically instead of requiring manual correction.
[learn.inline_patch]
enabled = true
classifier = "heuristic"
```

**The 2026-07 TS cutover ported the machinery but not the trigger.** `ts/src/learn/` has
`harvest.ts`, `classify.ts`, `candidate.ts`, `apply.ts` — the parts are all there. But the only
importer outside `ts/src/learn/` is **`ts/src/cli/learn.ts`**: `harvest(flowsDir)` is now an
operator-invoked sweep over a directory. Nothing on the judge path calls it.

So the feature did not disappear — it **silently reverted to the manual mode the user's preference
was set to escape**. `grep -rni inline_patch ts/src` returns nothing; the TOML section that turned
it on has had no reader for three months, and under STRAT-CONFIG-PREFS-1's strict loader it is now
a hard unknown-key error.

This is the failure class STRAT-CONFIG-PREFS-1 exists to prevent, caught by that feature's own
first use — a preference that was set, recorded, and then silently inert.

## Scope

Restore the automatic trigger in TypeScript. Reuse the existing `ts/src/learn/` modules; this is a
wiring and gating feature, not a reimplementation.

- Re-establish the harvester edge on the judge path (Python v1 scoped this to the MCP judge-step
  path only, explicitly excluding guard transitions — keep that boundary).
- Express the switch through **STRAT-CONFIG-PREFS-1's layered config**, not a new bare env var.
  It is the second citizen of that layer, and a natural test of it.
- Default OFF, matching Python v1. Candidates are staged and described, never applied, and never
  touch the running spec.

## Acceptance criteria

- [ ] Judge-path `must-fix` verdicts trigger harvest+classify automatically when enabled.
- [ ] The switch resolves through the STRAT-CONFIG-PREFS-1 chain and reports its winning layer.
- [ ] Default OFF. With the switch off, the judge path is byte-identical to today.
- [ ] Candidates are staged only — never auto-applied. `STRATUM_LEARN_APPLY_ENABLED` keeps
      governing application, separately from harvesting.
- [ ] Guard transitions stay excluded (a lifecycle gate is not a dev-work diagnosis).
- [ ] Tests assert the trigger fires on the judge path, the off-path no-op, and layer provenance.
- [ ] The user's 2026-06-11 preference is expressible again, and a report records that it is.

## Explicitly NOT in scope

- Reviving the Python `postmortem/` CLI surface. The TS CLI sweep stays as-is.
- Auto-applying candidates. That remains behind `STRATUM_LEARN_APPLY_ENABLED`.

## Origin

Found 2026-09-16 while resolving the `compose/stratum.toml` fossil during STRAT-CONFIG-PREFS-1.
The fossil was going to be deleted as configuring a nonexistent feature; checking `ts/src/learn/`
first showed the feature half-exists, which turned a cleanup into a real regression ticket.
