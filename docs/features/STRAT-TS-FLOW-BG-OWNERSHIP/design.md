# STRAT-TS-FLOW-BG-OWNERSHIP — attempt-bound dispatch for the detached driver

**Status:** PARTIAL — sole-mutator lockout SHIPPED (2026-07-11); attempt/epoch-bound
dispatch for multi-branch revise remains (gated on multi-branch bg scope).
**Surfaced by:** STRAT-TS-FLOW-BG (adversarial codex review, 2026-07-11)

## Shipped (slice 1): sole-mutator lockout

The reachable vector in v1 (linear + fanout) is an **external `stepDone` on a
bg-driven run**. Closed directly: the public `StratumEngine.stepDone` refuses
when the run is actively bg-driven (`bg.status` running or paused_gate), and the
driver calls a private `stepDoneOwned` that bypasses the guard. Gates still
resolve through `gateResolve`. `stepDone` is now async so the refusal surfaces
as a rejection to every awaiting caller (including the MCP dispatcher). Once the
bg run reaches a terminal state the guard no longer applies — a normal "not
awaiting a client result" error surfaces instead. Proven by two process-backed
tests (lockout while in flight; permitted-again post-terminal). This makes the
external-`stepDone` reset — and therefore the stale-result acceptance — impossible.

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

## Remaining (slice 2): attempt/epoch-bound dispatch for multi-branch revise

Only reachable once multi-branch detached flows (a `ready` `do`-step concurrent
with a revisable gate) are in scope — not producible by v1 linear+fanout. When
that lands:
- Thread the dispatched `attempt` (and, once ordinary steps carry one, an
  `epoch`) from the `ReadyStep` into `stepDoneOwned`, and have `stepDoneLocked`
  reject a result whose `(attempt, epoch)` no longer matches the step's current
  expectation — under the run lock, so there is no TOCTOU window.
- Assign ordinary steps an epoch on `revise` (mirroring fanout's `fanoutEpoch`)
  so a pre-revision result is unambiguously stale.

## Acceptance criteria

- [x] An external `stepDone` on an actively bg-driven run is refused, so it cannot
      reset the driven step mid-dispatch — proven by a process-backed test that
      blocks the driver's connector, attempts an external stepDone (rejected), and
      asserts the driver completes the flow alone.
- [x] The guard is scoped to active bg states — post-terminal `stepDone` behaves
      normally (proven by a second test).
- [x] The session-driven (non-bg) `stepDone` path is unchanged (full suite green).
- [ ] Multi-branch (gate + independent `do`) detached flows are safe under revise
      racing an in-flight dispatch (slice 2, once multi-branch bg is in scope).
