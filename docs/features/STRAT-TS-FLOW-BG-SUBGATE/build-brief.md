# STRAT-TS-FLOW-BG-SUBGATE — build brief

**Epic:** STRAT-TS-FLOW-BG (TS engine detached-flow primitive)
**Siblings:** STRAT-TS-FLOW-BG (v0.2.102), -OWNERSHIP (v0.2.103–104), -REHYDRATE (v0.2.105)
**Status:** DESIGNED — awaiting build
**Surfaced by:** the one deferred item from every flow-bg v1: gates only pause the driver at the TOP level.

## Problem

A `gate:` step **inside a `run:` sub-flow** wedges a detached flow. Today gate handling
is root-only in three places:

1. `driveBg` (`ts/src/engine/engine.ts:643-648`) detects a pausing gate via
   `Object.entries(run.steps).find(([, state]) => state.status === "waiting_gate")` —
   scans ONLY the root `run.steps` map. A child gate lives in
   `run.steps[parent].sub.steps[child]`, so it is never found. The driver falls through
   to the `delay(25) + reAdvance` path and **spins forever** (session mode: the run sits
   at `running` with nothing able to resolve it).
2. `gateResolveLocked` (`:518-557`) resolves via `run.steps[stepId]` + root
   `flow.steps.find` — cannot act on a scoped `parent/child` gate id (throws
   "gate is not awaiting a decision").
3. The registry carries a single `gateStepId?: string` (`:129,133,474,492,501,646`) and
   the poll surface exposes one gate — no room for concurrent gates.

A subflow step DOES already reach `waiting_gate`: `advanceScopeLoop:791-796` sets it for
any scope and emits `gate_waiting` with the scoped id (`this.scopedId(scope, step.id)`).
The state machine is ready; only detection, resolution, and the poll protocol are root-bound.

## Scope bounds (inherited from the engine — do NOT expand)

- **Nesting is exactly one level.** `locateStep:1537` rejects anything but `parent/child`
  (`parts.length !== 2` → undefined); `collectReady:1548` descends root→child only. Subflow-
  within-subflow (depth ≥ 2) is already out of engine scope; this feature stays 1-deep.
- **Fanout and `run` are mutually exclusive per step** (`advanceScopeLoop:798` vs `:823`).
  So there is **no fanout-of-subflow and no gate-inside-a-fanout-item** — a fanout body is a
  single `do`. The scoped-id space (`parent/child`) needs no fanout-item dimension. Do not add one.
- **Concurrent gates are real but bounded:** the only way to get N simultaneous gates is N
  independent sibling subflows, or a root gate + a subflow gate. Never a fanout explosion.

## Design decisions (LOCKED)

### D1 — Set-valued gates ("both at once"), symmetric with `collectReady`
The driver only reaches the gate-check after it has drained ALL ready work across every
scope (the `ready` branch batches across scopes via `reAdvance`). At that point the full
set of steps in `waiting_gate` is exactly "every gate currently blocking further progress."
Expose that whole set, computed the same way `collectReady` computes ready `do` steps —
NOT a single-slot pause. Rationale: the engine already recomputes the full DAG readiness
every `advance`; a single `gateStepId` artificially hides state the engine already knows,
and forces N poll round-trips for N sibling-subflow gates.

### D2 — Subflow-scoped terminal targets (option a)
A terminal gate target (`on_approve: null` / `on_kill: null` / revise-exhausted) inside a
subflow terminalizes **just that subflow**, not the whole run:
- terminal kill / revise-exhausted → route into `failScope(run, spec, contracts, childScope, reason)`
  (`:1597`) → the child fails → its parent `run:` step fails → normal `on_fail` routing applies.
- terminal approve (`on_approve: null`) → route into `completeSubflow(...)` (`:1621`) with the
  subflow's resolved output.
A root gate keeps its existing whole-run semantics (`terminalFailure` / `completeTerminalGate`).
Rationale: a subflow behaves as a self-contained, composable unit — least surprising, and it
reuses the child-scope termination paths that already exist.

### D3 — MCP surface is additive (no breaking change during SOAK)
`stratum_flow_bg_poll` gains `pendingGates: string[]`. Keep `gateStepId` populated as
`pendingGates[0]` (or omitted when the set is empty) so existing readers keep working while
Python is still the default engine. Bump the surface version and update the frozen-parity test.

## Acceptance criteria

Engine:
- [ ] New `collectWaitingGates(run, spec): string[]` mirrors `collectReady` (`:1548`): root scope
      + one level of subflows; returns the SCOPED id (`parent/child`, or bare id at root) of every
      step whose status is `waiting_gate`. Deterministic order (root steps first, then per parent).
- [ ] `driveBg` (`:643-648`) pauses when `collectWaitingGates(...)` is non-empty; sets
      `bg.pendingGates` to the full set (replaces the root-only `.find`). No behavioural change to
      the ready/terminal/cancel branches.
- [ ] `BgFlowState` + `BgFlowPollResponse` (`:125-134`): `gateStepId?: string` →
      `pendingGates: string[]`. All read sites updated (`:474`, `:492`, `:501`, `:646-647`).
      `flowCancelBg` clears the whole set on a paused-gate cancel.
- [ ] `gateResolveLocked` (`:518`) resolves a scoped id via `locateStep(run, spec, stepId)` →
      `{scope, step, state}`. Decision routing (`on_approve`/`on_revise`/`on_kill`) operates within
      that scope:
      - [ ] revise: reset + re-advance the CHILD scope (scope-aware `resetFrom` over
            `scope.flow.steps` + `scope.steps`). Two counters, both scoped to the subflow, NOT
            `run.rounds`: (a) the gate-local revision counter is already scope-local — the child
            step's `state.iterations` (as root does at `:544`) — keep it there; (b) the subflow-wide
            round total (compared against the subflow's `scope.flow.max_rounds`) has no home today —
            add `state.sub.rounds` on the parent step's sub structure, mirroring `run.rounds`.
            Root gate revise keeps `run.rounds` + root `resetFrom` unchanged.
      - [ ] terminal targets follow **D2** (`failScope` / `completeSubflow` for child scopes;
            `terminalFailure` / `completeTerminalGate` for root).
      - [ ] non-terminal target: set `routed` on the target step **within the child scope's** step
            map, not root `run.steps`.
- [ ] `gateResolve` re-kick (`:499-514`): after resolving one gate while others remain, relaunch
      `driveBg` (safe — `paused_gate` means no live driver). The driver drains the newly-unblocked
      scope and re-pauses on the remaining set. No double-drive.

MCP:
- [ ] `stratum_flow_bg_poll` output adds `pendingGates: string[]`; `gateStepId` kept =
      `pendingGates[0]` for back-compat (**D3**). `ts/contracts/mcp-surface.json` bumped (v2→v3);
      frozen-parity gate (`tests/mcp/p5.test.ts`) updated to exercise the new field.

Rehydrate:
- [ ] No new persistence: the gate set lives on the in-memory `bg` registration (`PersistedRun`
      has no gate field), so a rehydrated paused-gate run recomputes the set on its first pause via
      `collectWaitingGates`. Add a regression test proving a rehydrated run with a subflow gate
      re-pauses with the correct `pendingGates`.

Tests (`tests/engine/`):
- [ ] Two independent sibling subflows each hit a gate → poll shows BOTH in `pendingGates`.
- [ ] Resolve one (approve) → driver drains that scope, re-pauses with only the other gate.
- [ ] Resolve the second → both subflows settle → run completes.
- [ ] Subflow gate revise → re-runs steps WITHIN that subflow only; sibling subflow untouched;
      subflow-scoped rounds cap enforced independently of `run.rounds`.
- [ ] Subflow gate `on_kill: null` → subflow fails → parent `run:` step fails → parent `on_fail`
      routes (D2), whole run does NOT terminate on that basis.
- [ ] Root gate behaviour unchanged (regression).

## Gates (must pass before commit)

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"; cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit --erasableSyntaxOnly   # NO enum/namespace/param-props/decorators
./node_modules/.bin/vitest run tests/engine tests/mcp
```
Baseline ~507 pass / 1 skip. Pre-existing load-dependent flakes (NOT this feature; rerun if seen):
`tests/parity/p6.test.ts` ENOTEMPTY, `tests/mcp/p5.test.ts` frozen-status agent-poll window.

## Reading list (ranked)
1. `ts/src/engine/engine.ts` — `driveBg` (:588), `gateResolveLocked` (:518), `collectReady` (:1548),
   `locateStep` (:1529), `resetFrom` (:1364), `failScope` (:1597), `completeSubflow` (:1621),
   `advanceScopeLoop` gate branch (:791).
2. `ts/src/engine/state.ts` — `PersistedRun`, `StepState` (`.sub`, `.epoch`, `.iterations`).
3. `ts/contracts/mcp-surface.json` + `ts/src/mcp/server.ts` — poll tool + frozen-parity gate.
4. `docs/features/STRAT-TS-FLOW-BG-REHYDRATE/build-brief.md` — the prior slice's shape + review outcomes.

## Build model
Opus authors this brief + adjudicates; **codex WRITES** (write mode, `gpt-5.6-sol/high`,
`cwd=/Users/ruze/reg/my/forge/stratum`) against this file path; **codex REVIEWS** the working
diff (read-only) — adjudicate every finding against code evidence, verify gates locally, then
Opus commits directly to `main` (codex sandbox cannot commit). No Co-Authored-By.
