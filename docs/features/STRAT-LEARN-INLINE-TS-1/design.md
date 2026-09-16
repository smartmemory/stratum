# STRAT-LEARN-INLINE-TS-1 — Surface harvested lessons automatically (the trigger, not the machinery)

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-09-16
**Supersedes-in-part:** [`STRAT-LEARN-INLINE`](../STRAT-LEARN-INLINE/report.md) (SHIPPED 2026-06-08, Python)

## Related Documents

- [`STRAT-LEARN-INLINE/report.md`](../STRAT-LEARN-INLINE/report.md) — the Python v1 that shipped and
  then silently stopped firing. Its design/blueprint/plan remain the specification of intent.
- [`STRAT-CONFIG-PREFS-1`](../STRAT-CONFIG-PREFS-1/design.md) — the config layer that surfaced this,
  and the layered home this feature's switch belongs in.
- `git show python-legacy:src/stratum/judge/inline_learn.py` — the retired harvester edge.

## The finding

`STRAT-LEARN-INLINE` shipped 2026-06-08 as a **default-OFF automatic edge on the judge path**. The
user enabled it 2026-06-11, recording the preference in `compose/stratum.toml` (deleted 2026-09-16,
compose `b34b188`) *"so working-style lessons get harvested automatically instead of requiring
manual correction."*

**The 2026-07 TS cutover ported the machinery but not the trigger.** `ts/src/learn/` has
`harvest.ts`, `classify.ts`, `candidate.ts`, `apply.ts`. The only importer outside `ts/src/learn/`
is `ts/src/cli/learn.ts` — `harvest()` became an operator-invoked sweep. Nothing on the judge path
calls it, so the feature reverted to exactly the manual mode the preference was set to escape.

## The measurement (2026-09-16) — the machinery works; nobody is listening

Run by hand over the real flow store (`~/.stratum/ts/flows`, 1350 flows):

```
608 failure records (0 runs skipped, 0 events dropped)
1190 clusters → 4 durable
  stratum: 1 actionable    compose: 2 actionable
```

The classifier is conservative by design (`classify.ts`: keys on the violated contract, never the
offending value; refuses mixed or unattributed provenance; `durable` needs ≥2 runs and ≥3
run-step pairs). 4 durable from 1190 is the filter working, not failing.

**Measurement caveat, recorded so it is not repeated:** candidates are filtered by
`cluster.scope.workspaceRoot !== root` (`cli/learn.ts:70`). Running from `stratum/ts` rather than
`stratum` reports `0 for this project` and looks like a dead feature. Always harvest from the repo
root.

### The lessons it found are real

```
build: recurring schema failure on outcome (stratum)
  steps blueprint, explore_design, plan, verification returned approved/done/pass/revised/success
  where the contract allows complete/failed/skipped — 14 times across 2 runs / 6 pairs.
  Every one recovered on retry, so each cost an extra agent dispatch and nothing surfaced it.

build: recurring schema failure on outcome (compose)
  steps docs, explore_design returned exists/short_circuited_existing_approved_design/success
  — 9 times across 8 runs / 9 pairs.

build: recurring schema failure on commit_hash (compose)
  steps docs, explore_design returned null where the contract allows string
  — 7 times across 6 runs / 7 pairs.
```

**The third one is the proof of cost.** That is the same defect the CHANGELOG records being fixed by
hand on 2026-09-15 ("the canonical case is an agent reporting that it made no commit as
`commit_hash: null`", flow `00540397-0bec-4aa5-b6d5-2eb5634f7201`). The harvester had seven
attributed occurrences of it. No human ran the command, so the bug was found the expensive way,
months later, from a single failing run.

**This is not a yield problem. It is a delivery problem.** The lessons exist and are good; the only
thing missing is that something has to *say* them without being asked.

## Scope

Restore the automatic surfacing. Reuse `ts/src/learn/` as-is — this is wiring, gating and delivery,
not a reimplementation of the classifier.

- Re-establish the harvester edge on the judge path. Python v1 scoped this to the MCP judge-step
  path and explicitly excluded guard transitions (a lifecycle gate is not a dev-work diagnosis) —
  keep that boundary.
- Express the switch through the STRAT-CONFIG-PREFS-1 chain, not a new bare env var. It is that
  layer's second citizen and a natural test of it.
- Default OFF, matching Python v1. Candidates are staged and described, never applied.
- **Harvest from the workspace root, not the cwd**, or the scope filter silently yields nothing.

## Acceptance criteria

- [ ] Judge-path `must-fix` verdicts trigger harvest+classify automatically when enabled.
- [ ] The switch resolves through the STRAT-CONFIG-PREFS-1 chain and reports its winning layer.
- [ ] Default OFF. With the switch off, the judge path is byte-identical to today.
- [ ] Scope resolution uses the workspace root; a run from a subdirectory must not silently drop
      every candidate. Regression test for the `stratum/ts` vs `stratum` case above.
- [ ] Candidates are staged only, never auto-applied. `STRATUM_LEARN_APPLY_ENABLED` continues to
      govern application, separately from harvesting.
- [ ] Guard transitions stay excluded.
- [ ] Tests assert the trigger fires on the judge path, the off-path no-op, and layer provenance.
- [ ] A durable lesson reaches a human without anyone running a command.

## Explicitly NOT in scope

- Retuning the classifier thresholds. The measurement says they are calibrated correctly; changing
  them without evidence would trade real lessons for noise.
- Auto-applying candidates. That stays behind `STRATUM_LEARN_APPLY_ENABLED`.
- Reviving the Python `postmortem/` CLI surface.

## Immediate follow-up, independent of this feature

The `outcome` enum mismatch is actionable now and costs an agent dispatch every time it fires:
steps return `approved`/`done`/`pass`/`revised`/`success`/`exists` against a contract allowing only
`complete`/`failed`/`skipped`. Either widen the contract or fix the step instructions. File
separately — it should not wait on the trigger.

## Origin

Found 2026-09-16 while resolving the `compose/stratum.toml` fossil during STRAT-CONFIG-PREFS-1.
The file was about to be deleted as configuring a nonexistent feature; checking `ts/src/learn/`
first showed the feature half-exists. A first pass then measured zero yield and nearly killed it —
that zero was an artifact of harvesting from `ts/` instead of the repo root. Running it correctly
produced three real lessons, one of which had been silently predicting a bug that was later fixed
by hand.
