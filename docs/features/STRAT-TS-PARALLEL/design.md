# STRAT-TS-PARALLEL — Port the parallel kernel to the TS engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 2

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 2)
- Python reference: `stratum-mcp/src/stratum_mcp/server.py:1274-2340`
  (`_evaluate_parallel_results`, `_advance_after_parallel`, the 4 tools),
  `parallel_exec.py` (ParallelExecutor), `worktree.py` (pre-merge gate),
  `executor.py:1015-1058` (ParallelTaskState)
- TS side today: `ts/src/engine/state.ts:33-46` (FanoutState — the
  engine's NATIVE parallelism), `ts/src/connectors/` (runner, background)
- Consumer: compose `lib/build.js:3760-4086`
  (`executeParallelDispatchServer`), `lib/gsd.js`,
  `lib/stratum-mcp-client.js:411-476`
- Pinning tests: `tests/test_par_merge_queue.py`,
  `test_parallel_server_dispatch.py`, `test_parallel_exec.py`

## Problem

Compose batch builds are driven through 4 Python tools
(`stratum_parallel_start/poll/advance/done`) wrapping a server-side
ParallelExecutor with worktree isolation, pre-merge gates, a structured
merge-bounce queue (COMP-PAR-MERGE-QUEUE), per-task certificates
(STRAT-CERT-PAR), budget accounting, and live-process reparenting
(T2-F5-RESUME). The TS engine has its own native fanout but none of this
consumer-facing surface.

## Contract facts that drive the design (2026-07-11 recon)

1. **Compose branches on exact envelopes**: `outcome.status ∈
   {awaiting_consumer_advance, already_advanced, budget_exhausted,
   ensure_failed, schema_failed}`, `tasks[].state`, `require_satisfied`,
   `violations`, `bounced_tasks`, plus the ParMergeBounce shape
   `{task_id, reason: gate_failed|merge_conflict, files, command,
   exit_code, excerpt}`.
2. **Python's error envelopes are INCONSISTENT** — some sites return
   `{status:"error", error_type}` while parallel_poll/advance return bare
   `{error: ...}`. Compose handles both. The port replicates the
   inconsistency EXACTLY (fidelity over aesthetics); normalizing is a
   post-retirement cleanup, never a port-time change.
3. **Two dispatch modes** share one evaluation core: consumer-dispatch
   (compose runs agents, calls `parallel_done`) and server-dispatch
   (executor spawns agents; poll → optional deferred advance).
   `require` semantics differ pipeline vs non-pipeline (skipped counts as
   FAILED in non-pipeline — anti-bypass; settled-non-failure in
   pipeline).
4. **Merge-retry loop**: gate failure → `gate_bounce` on task state →
   next re-dispatch injects bounce context into the prompt; compose
   re-dispatches on `ensure_failed`/`schema_failed` with `tasks[]`,
   bounded by its own depth guard while stratum's `step_retries`
   (default 2) terminates authoritatively.
5. **Known port edge (from recon):** compose computes `hasServerMerge`
   from `dispatchResponse.capture_diff`, but the Python dispatch envelope
   may not actually include `capture_diff` — verify live behavior BEFORE
   porting; port the observed truth, not the assumed one.
6. **Flow state is drain-and-cutover safe** (epic D1): parallel state
   lives inside per-flow `~/.stratum/flows/<id>.json`; flows are
   short-lived. No cross-engine state compatibility needed — unlike guard.

## Design

### Decision 1 — same wire contract, TS-native internals

The 4 tools land on the TS server contract-identical (envelopes, field
names, the error-shape inconsistency, ParMergeBounce). Internally they
are implemented over the TS engine's existing machinery — connectors
(`runAgent`, background runs) and a `ParallelRunState` persisted inside
`PersistedRun` (extending `state.ts` alongside FanoutState) — NOT a
line-by-line ParallelExecutor transliteration. The engine's native
fanout stays as-is; this surface serves v0-style consumer driving until
compose's build pipeline migrates to native fanout (explicitly out of
scope here; candidate follow-up after TS-2).

### Decision 2 — scope cuts, stated not silent

- **T2-F5-RESUME reparenting (`reparenting` state, child_pid/stream
  handles): NOT ported.** It exists to survive Python server restarts;
  the TS stdio server has a different lifecycle. `reparenting` remains a
  legal task state in shapes (compose reads it) but is never produced by
  TS. Recorded as a capability delta; revisit only if soak shows restart
  pain.
- **STRAT-CERT-PAR certificate validation: ported** (compose relies on
  cert-failed → task flipped failed with `cert_violations`).
- **Worktree isolation + pre-merge gate: ported** (batch builds depend on
  them; `worktree.py` semantics incl. exit-code classes 127/None/real).
- **Budget fields (tokens/elapsed/dollars, dispatch_debited): ported** —
  wired to the TS BudgetLedger (same keys).

### Decision 3 — verification is compose's suite, not just ported tests

Port the Python pinning tests (merge-queue shapes, require matrix,
evaluation core) as TS contract tests, THEN run compose's batch-build
golden flow against the TS engine end to end (worktree isolation, a
forced gate-failure bounce, a forced merge conflict, re-dispatch, budget
exhaustion). The golden flow is the acceptance bar; unit parity alone is
not.

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/src/parallel/exec.ts` (new) | add | task scheduling over connectors; worktree + pre-merge gate |
| `ts/src/parallel/evaluate.ts` (new) | add | evaluation core: require matrix, cert validation, bounce aggregation |
| `ts/src/parallel/state.ts` (new) | add | ParallelTaskState (shape-identical) inside PersistedRun |
| `ts/src/mcp/server.ts` + `ts/contracts/mcp-surface.json` (existing) | modify | 4 tools registered, envelopes pinned in the surface contract |
| `ts/tests/parallel/*.test.ts` (new) | add | ported pinning tests + envelope-inconsistency tests |

## Acceptance criteria

- [ ] `capture_diff` port edge resolved with a live probe against Python
      first; observed dispatch envelope recorded here
- [ ] 4 tools contract-identical incl. bare-`{error}` vs
      `{status:error}` site-by-site parity and ParMergeBounce shape
- [ ] Require matrix (all/any/N; pipeline vs non-pipeline skipped
      semantics) table-driven-tested
- [ ] Merge-retry loop: gate bounce persisted, injected on re-dispatch;
      compose re-dispatch path exercised
- [ ] STRAT-CERT-PAR: cert-failed task flips to failed with
      cert_violations
- [ ] Budget: task usage debits the flow ledger; budget_exhausted
      envelope parity
- [ ] Compose batch-build golden flow green against TS (worktree +
      bounce + conflict + re-dispatch + exhaustion), recorded here
- [ ] Reparenting delta recorded (shapes legal, never produced)

## Open questions

- None blocking. Native-fanout migration of compose's build pipeline is
  a separate post-TS-2 conversation, deliberately not entangled here.
