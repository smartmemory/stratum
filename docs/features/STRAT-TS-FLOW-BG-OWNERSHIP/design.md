# STRAT-TS-FLOW-BG-OWNERSHIP — attempt-bound dispatch for the detached driver

**Status:** PLANNED (follow-up filed from STRAT-TS-FLOW-BG v1 review)
**Surfaced by:** STRAT-TS-FLOW-BG (adversarial codex review, 2026-07-11)

## Problem

The v1 detached driver (`StratumEngine.driveBg`) is the sole intended mutator of
a bg-driven run: a session polls (`flowBgPoll`) and resolves gates
(`gateResolve`), but must not externally call `stepDone` on it. The driver
captures a `ready` step, dispatches its prompt through the connector, then
submits the result via `stepDone`. `stepDoneLocked` validates only that the step
is currently `ready` (`engine.ts` ~:268) — it does not bind the result to the
dispatch's attempt or epoch.

Consequence (out-of-contract concurrency only): if an external `stepDone` or a
gate `revise` resets the driven step to a fresh attempt/epoch **while the
driver's connector is in flight**, the driver's now-stale result is accepted
against the wrong attempt/epoch. The v1 defensive catch in `driveBg` only
handles the benign case where the step is no longer `ready` (it re-derives);
when the step is `ready` again for a new attempt, `stepDone` *succeeds* and the
catch never fires.

## Why it is deferred (not a v1 blocker)

Unreachable within v1's shipped scope:
- Pure bg operation dispatches each step sequentially — never two connector calls
  in flight for one step, so no self-race.
- The gate-`revise` vector requires a `ready` `do`-step in one branch coexisting
  with a revisable gate in another (multi-branch flows). v1 scope is **linear +
  fanout** only, which does not produce that concurrency.
- The remaining vector (external `stepDone` on a bg run) violates the sole-mutator
  contract documented on `driveBg`.

A driver-side best-effort guard (re-check attempt before submit) is leaky
(TOCTOU between check and `stepDone`) and would give false confidence. The
correct fix touches the shared mutation guard, which is deferred to avoid
regressing the session-driven path.

## Proposed fix

Make dispatch attempt/epoch-bound, atomically:
- Thread the dispatched `attempt` (and, once ordinary steps carry one, an
  `epoch`) from the `ReadyStep` into `stepDone`, and have `stepDoneLocked` reject
  a result whose `(attempt, epoch)` no longer matches the step's current
  expectation — under the run lock, so there is no TOCTOU window.
- Alternatively / additionally: lock out external `stepDone` on a bg-registered
  run (the driver calls an internal, un-gated path), while still allowing
  `gateResolve` (gates must resume the driver). This closes the external-`stepDone`
  vector cleanly without a shared-contract change.
- Assign ordinary steps an epoch on `revise` (mirroring fanout's `fanoutEpoch`)
  so a pre-revision result is unambiguously stale.

## Acceptance criteria

- [ ] A stale connector result from a pre-reset attempt is rejected (or diverted),
      never committed against a newer attempt/epoch — proven with a process-backed
      test that blocks the driver's connector, externally resets the step, releases,
      and asserts the stale result is not recorded.
- [ ] The session-driven (non-bg) `stepDone` path is unchanged (full suite green).
- [ ] Multi-branch (gate + independent `do`) detached flows are safe under revise
      racing an in-flight dispatch (once multi-branch bg is in scope).
