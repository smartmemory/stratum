# STRAT-TS-FLOW-BG follow-ups 1+2+3 — Build Brief

Three follow-ups on the TS engine's detached driver. Designs are **LOCKED** — fill
in mechanics, wire, and prove with process-backed tests. WRITE mode on `ts/`.
Do NOT `git commit` (sandbox can't). Leave the tree dirty; the controller commits.

Baseline: origin/main @ v0.2.103. `ts/src/engine/engine.ts` holds the engine +
`driveBg`; `ts/tests/engine/flow_bg.test.ts` holds the driver tests. Verify with
`./node_modules/.bin/{tsc --noEmit, tsc --noEmit --erasableSyntaxOnly, vitest run}`
(no pnpm in sandbox). Known flake: `tests/parity/p6.test.ts` fanout ENOTEMPTY —
passes isolated; ignore if it's the only full-run failure.

---

## Item 1 — no-pointless-re-judge (fail fast on unchanged evidence)

**Problem.** When a step fails an ensure and retries, if the retry produces
BYTE-IDENTICAL output to the prior attempt, re-running the (expensive, e.g.
judged) ensure on identical evidence is wasted — the design says "adverse verdict
on unchanged evidence must re-stage or fail fast, not spin to the retry cap."

**LOCKED design.** In `failAttempt` (`engine.ts:1102`), the retry decision is
`if (!forceExhausted && attempt < maximum)`. Before that branch, compute whether
the current attempt's `result` is deep-equal to the IMMEDIATELY-PRECEDING
attempt's recorded `result`:
- Only when BOTH are defined (`result !== undefined` AND
  `state.attempts[state.attempts.length - 1]?.result !== undefined`) — a
  connector-dispatch failure (no result) must NOT trigger fail-fast.
- Use a structural deep-equal (a small local helper; do NOT add a dependency).
- If they are deep-equal, treat this as exhausted: force the terminal/on_fail
  path (i.e. behave as `forceExhausted = true`). The attempt is still recorded
  with its failure; only the *next* retry is skipped.
- The failure `reason` on the terminal path should note the cause, e.g. append
  `(no retry: identical evidence)` so the audit is legible.

This is global (session + bg) and sound: identical evidence re-fails expr/contract
ensures deterministically, and the design endorses fail-fast for judged ones.

**Tests** (`tests/engine/`):
- [ ] A step with `attempts: 3` and a failing ensure whose connector returns
      IDENTICAL output each attempt fails after exactly **2** dispatches (not 3) —
      the second (identical) attempt fails fast. Assert dispatch count and terminal.
- [ ] A step whose connector returns DIFFERENT output each failing attempt still
      consumes the full `attempts` budget (no premature fail-fast) — regression guard.

---

## Item 2 — parallel top-level dispatch in the bg driver

**Problem.** `driveBg` dispatches `response.ready[0]` and re-loops — sequential.
Independent top-level ready steps should dispatch concurrently.

**LOCKED design.** In `driveBg`'s `response.status === "ready"` branch, replace
the single-step dispatch with:
1. `const steps = response.ready;`
2. Dispatch ALL connectors concurrently:
   `const results = await Promise.all(steps.map(async (s) => ({ s, result: <connector call, same shape/args as today incl. the try/catch→{failure}> })))`.
   Reuse the exact connector-arg construction currently in the loop (agent,
   prompt=s.do, attempt=s.attempt, cwd, previousFailure, sandbox: "read-only").
3. Apply each result under the engine's own lock, SEQUENTIALLY (order = `results`):
   `for (const { s, result } of results) { try { await this.stepDoneOwned(runId, s.id, result); } catch { /* concurrent advance — tolerated, reAdvance below reconciles */ } }`
   (`stepDoneOwned` is run-locked, so sequential application is race-free.)
4. `response = await this.reAdvance(runId);` then `continue;`

Keep the `bg.cancelRequested` check at the loop top (cooperative: in-flight
connectors finish, then the next iteration observes cancel). Do NOT change the
`running`/gate/terminal branches.

**Tests** (`tests/engine/`):
- [ ] A spec with TWO independent top-level `do` steps (neither `after` the other,
      both depend only on input) detaches and completes; assert BOTH connectors
      were called and the flow completed. (Prove concurrency: e.g. both connectors
      block on a shared barrier that only releases once BOTH have started, then
      resolve — a sequential driver would deadlock, a parallel one completes.)
- [ ] Existing linear + fanout + gate driver tests still pass unchanged.

---

## Item 3 — OWNERSHIP slice 2: attempt/epoch-bound dispatch

**Problem.** A result dispatched for one attempt/epoch could be committed after a
`revise` reset the step to a fresh epoch (the sole-mutator lockout closes the
external-stepDone vector; this closes the revise vector). Not reachable as a RACE
in v1 single-branch flows, but the guard mechanism is real and testable via a
sequential gate `revise`.

**LOCKED design.**
1. Add `epoch?: number` to `StepState` (`ts/src/engine/state.ts`), default-absent
   (treat absent as 0). In `resetFrom` (`engine.ts:1297`), bump it for EVERY reset
   step (right where `fanoutEpoch` is bumped): `state.epoch = (state.epoch ?? 0) + 1;`
2. Add `epoch: number` to the `ReadyStep` interface (`engine.ts:78`). Populate it
   in BOTH `readyStep` (`engine.ts` ~:1160) and `collectReady` (~:1283) with
   `state.epoch ?? 0`.
3. Add an OPTIONAL `expectedEpoch?: number` param to `stepDone` and `stepDoneOwned`.
   In `stepDoneLocked`, after locating the step and BEFORE recording the attempt,
   if `expectedEpoch !== undefined` and `(state.epoch ?? 0) !== expectedEpoch`,
   throw `Error("step result is stale: dispatched for a superseded epoch")`.
   Backward-compat: the public MCP path and session callers omit `expectedEpoch`
   → no check → unchanged behavior. Do NOT add epoch to the MCP `stratum_step_done`
   surface — it stays session-facing and epoch-free.
4. In `driveBg`, pass the dispatched step's epoch:
   `await this.stepDoneOwned(runId, step.id, result, step.epoch)` (and in the Item-2
   parallel form, `this.stepDoneOwned(runId, s.id, result, s.epoch)`). The existing
   defensive catch already converts the stale-epoch throw into a reAdvance.

**Tests** (`tests/engine/`):
- [ ] Epoch guard rejects a superseded submission: plan `[A(do) → B(gate, on_revise: A)]`;
      `stepDone(A)`; `gateResolve(B,"revise")` (resets A, epoch 0→1, A ready again);
      then `stepDone(runId, "A", result, /*expectedEpoch*/ 0)` REJECTS with /stale/.
      A submit with the current epoch (1) succeeds.
- [ ] `resetFrom` bumps `epoch` on an ordinary reset step (assert via audit that
      A's epoch incremented after the revise).
- [ ] Normal bg run (no revise) still completes — the driver's epoch always matches,
      so no false rejection (existing driver tests cover this; add one explicit
      assertion if cheap).

---

## Global constraints
- v1 IR only; no new IR; no new deps; no new abstractions beyond what's specified.
- Match surrounding engine style (terse, comment-the-WHY on load-bearing lines).
- Full suite must stay green (modulo the known p6 ENOTEMPTY flake).
- Report: files touched; how each test checkbox is met (name the test); exact
  output of both tsc gates + `vitest run`; any deviation + reason.
