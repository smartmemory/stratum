# STRAT-REOPEN-FAILED-1 — Design (reopen a terminally failed run)

**KILLED (2026-09-17):** do not build. An adversarial design review established that the
motivating problem is solvable with machinery the engine already has, and that the proposed
surface is unsafe in the general case. Superseded by compose `COMP-RESUME-CHECKPOINT-1`.

**Why killed — three findings, each verified against source:**

1. **A correctly placed checkpoint already solves it.** Compose's pipeline has a recovery
   boundary at the `execute_merge` gate, `on_approve: review_triage`
   (`compose/pipelines/build.stratum.yaml:249`): implementation has succeeded, its merge gate
   has been approved, and the review lenses have not started. Committing there and reverting
   there preserves the expensive implementation work and replays triage plus the lenses.
   `revert` retains cumulative `flowSpent` and the receipt spine (`engine.ts:964`).
   The original design's objection — that restoring `steps` necessarily loses succeeded work
   (`checkpoint.ts:12`) — is TRUE for an old checkpoint and FALSE for one placed at this
   boundary. That generalisation was the error at the heart of the proposal.
   Placement is narrow: checkpointing once lens descriptors exist is too late, because fanout
   activation sets the step `running` and commit refuses an in-flight fanout
   (`engine.ts:1735`, `engine.ts:3360`).

2. **A terminally failed run is not quiescent, so reopening is unsafe in general.**
   Independent fanouts can coexist; `terminalFailure` changes run status without burning
   outstanding issuances or invalidating every worker (`engine.ts:1748`, `:2095`, `:3431`).
   Reopening one failed step can make another step's old token acceptable again, or let a
   surviving worker's stale result land in the reopened run. Fresh tokens on selected items do
   not replace fanout-identity invalidation. A run lock does not cover connector work outside
   it. Any general recovery surface needs an explicit ownership and quiescence precondition,
   which this design did not have.

3. **"Failed" does not mean "retryable", so the proposed eligibility rule was wrong.**
   The design refused only `cancelled` runs. But a deliberate gate `kill` produces `failed`,
   and exhausting revision rounds produces `failed` (`engine.ts:1338`, `:1355`) — both are
   DELIBERATE stops. `on_fail` can also leave earlier failed steps in a run, so "names a failed
   step" does not prove that step caused termination. As specified, the surface would have
   resurrected runs a human intentionally killed.

**Also confirmed, and carried into the replacement:** the engine counts succeeded fanout items
toward `require: all` but does not establish that their outputs describe the CURRENT workspace
(`engine.ts:2133`); the revision digest covers the specification, not reviewed file contents.
Preserving clean lenses across a reopen could therefore produce a falsely successful review.
Re-running the whole review batch — which checkpoint recovery does naturally — avoids this.

**And on bounding recovery:** a reopen/revert count is a weak control. Spend is the thing that
hurts, and a count does not bound the cost of a single recovery. The engine supports budget
limits only for declared dimensions (`ledger.ts:28`), and dollars settle AFTER execution while
fanout admission reserves a dispatch rather than a worst-case amount (`engine.ts:2247`) — so no
dollar limit is a strict no-overshoot guarantee. This applies to repeated reverts too, and is
inherited by the replacement.

**Residual NOT covered by the replacement:** a run that has already failed with no suitable
checkpoint cannot be salvaged by any of this. Host B's measured flow is unrecoverable and stays
so. If checkpoint-less historical salvage is ever required, it is a separate requirement and
this design is not the answer to it.

Review: Codex `gpt-6-astra`, Stratum run `6ac0bd2061e6`, 2026-09-17. Claims 1, 2 and 3 were
re-verified by the controller against `build.stratum.yaml:249`, `engine.ts:1735` and
`engine.ts:1338-1355` before the kill was accepted.

The original design follows, unchanged, for provenance.

---

# STRAT-REOPEN-FAILED-1 — Design (reopen a terminally failed run)

**Status:** PLANNED (2026-09-17)
**Owner repo:** stratum
**Surfaced by:** compose `COMP-RESUME-FAILED-PHASE-1` (gap G2 of `COMP-HOST-PORTABILITY-1`)
**Related:** T2-F5-RESUME (live-process reparenting — a DIFFERENT problem: that is server-restart
reattachment of in-flight work, this is reopening work the engine has already terminalized).

## Problem

A terminally failed run cannot be reopened through any existing engine surface, so a consumer
failure late in a flow strands every succeeded step before it.

Measured: compose's `COMP-HOST-PORTABILITY-1` host B lost a flow at the review step after
18m51s, 208,080 tokens and **$14.04** of completed implementation work. The implementation
output was intact on disk. Every recovery route refused it, and the run had to be restarted
from design.

## Why the existing surface cannot do it

Verified by reading source, 2026-09-17:

- **`resume(runId)`** — `src/engine/engine.ts:1013`. `resumeLocked` returns the existing
  response when the run is not `running`. It emits `resumed` and changes nothing. This is why
  compose's measured `stratum_resume` call *completed* yet restored nothing: it did exactly
  what it is written to do.
- **`stepDone`** — `src/engine/engine.ts:749`. Requires a running run; cannot revive exhausted
  items.
- **`revert(runId, label)`** — `src/engine/engine.ts:964`. Can restore a terminal run from a
  checkpoint, but `CHECKPOINT_FIELDS` (`src/engine/checkpoint.ts:12`) includes `steps` and
  `events`, so restoration replaces them wholesale and rolls back succeeded work and attempt
  history. That defeats the entire purpose: the succeeded work is what we are trying to save.

**Non-obvious constraint.** Item retry accounting counts retained historical attempts —
`stageAttempts < (stage.attempts ?? step.attempts ?? 2)` at `src/engine/engine.ts:2059`. A
reopen that preserves attempt history without granting a fresh allowance would re-exhaust on
the first dispatch. Preservation and retryability are therefore in tension and must be
resolved explicitly, not incidentally.

## Proposed surface

```ts
reopenFailed(runId: string, stepId: string): Promise<RevisionedEngineResponse>
```

exposed over MCP as `stratum_reopen_failed({ runId, stepId })`.

An engine-owned, locked transition. It must:

- **Validate** that the run is terminally `failed` and that `stepId` names its failed step.
  Refuse anything else — and refuse a `cancelled` run specifically: cancelled runs stay
  abandoned by deliberate design (see the D5 comment at `engine.ts:1013`), and this must not
  become a back door into that.
- **Preserve** run identity, every succeeded step's output, the event history, the attempt
  history, and `flowSpent`. Money spent is spent — the same principle `revert` already applies
  at `engine.ts:964`.
- **Reset only** the exhausted failed step and its failed items, to a resumable state.
- **Issue fresh dispatch tokens** for what it reopens.
- **Grant a fresh retry allowance** for the reopened items, independent of the retained
  historical attempts, per the constraint above.
- **Emit a durable event** so a reopen is auditable and distinguishable from a clean run.
- Follow the same guards as its siblings: run lock, sole-mutator enforcement
  (`assertExternalMutationAllowed`), and revision digest handling.

## Open questions for implementation

1. Should `stepId` be required, or inferred from the run's failure? Required is safer (it makes
   the caller state its intent and makes a mismatch loud) but needs the caller to know it.
2. What does the fresh retry allowance look like on the wire — a reset counter, or an explicit
   allowance field? This determines whether a second reopen of the same step is bounded.
3. Should repeated reopens of the same step be capped? An unbounded reopen is an unbounded
   spend loop, which is the failure mode this whole gap is about.

## Consequences

**Version sync.** This is a new engine surface, so it lands as a stratum MINOR. Per
`.claude/rules/versioning.md` in compose, compose and stratum share a minor, so compose moves
to the same minor at or before the same release, and compose-mcp with it.

**Compose wiring is separate.** `COMP-RESUME-FAILED-PHASE-1` part A consumes this once it
exists. Parts B (honest refusal message) and C (rehydrate step history) are compose-side and
do not depend on it.
