# STRAT-CODEX-WRITE-DURABLE — safe codex write + background (design)

**Status:** IMPLEMENTED (2026-07-11) · **Scope decision:** NARROW v1 (kill-on-controller-loss)

**IMPLEMENTED note:** Slices 3 and 4 add a persistence-before-exec launch gate,
kill/classification of standalone writable runs on shutdown/restart, focused
process-backed coverage, and the updated durable-write operational contract.
The original gap analysis and slice history below are retained.

## Related Documents

- Origin non-goal + filed follow-up: `docs/plans/2026-07-09-codex-write-mode-design.md`
  (Non-Goals → "Write with the durable/reparentable stream")
- The guard being lifted: `stratum-mcp/src/stratum_mcp/connectors/codex.py:313-319`
- Grounded investigation (2026-07-11, codex sol/high) — this doc is its synthesis.

## Problem

`stratum_agent_run(type="codex", write=True, background=True)` is rejected today.
Rationale is real: the durable/reparentable stream (T2-F5-RESUME) was built to
**survive** a server restart — read-only review children keep running and are
re-attached. A write-capable child under that same machinery could keep EDITING
files after cancel or during a server-restart outage. So the guard protects
against a runaway-write hazard, and cannot simply be deleted.

## Chosen semantics (NARROW v1)

**"Durable output, non-reparentable writes."** A write+background run gets a
durable stream (run_id, poll, death-confirmed cancel), but a write-capable child
**must never execute without a live controller**:

- Cancel is **death-confirmed**: SIGTERM → bounded grace → SIGKILL → confirm the
  exact identity/group is gone, and only then report `cancelled`.
- On **controller loss** (server exit/restart), the write child is **terminated**,
  not paused/resumed. It is explicitly NOT reparentable.
- Identity handling is **fail-closed** for writes: if a verified (pid,
  proc_start_time, pgid) identity cannot be persisted before the child may run,
  the run fails rather than leaving an unstoppable writer.

Deferred to a full follow-up (NOT in v1): a pause/resume supervisor that keeps a
write child across a restart. v1 kills instead.

## Gaps found today (all grounded, must be closed or preserved)

1. `stratum_cancel_agent_run` (server.py:747-779) sends ONE SIGTERM and returns
   `cancelled` immediately — no death wait, no SIGKILL. → death-confirmed cancel.
2. Parallel timeout/cascade (parallel_exec.py:986-1005) marks terminal right
   after a one-shot SIGTERM. → await termination before terminalizing.
3. Reparent cascade kill (`_maybe_cascade_cancel_siblings`,
   parallel_exec.py:1437-1462) checks only `pid_alive()`, not start-time or
   `pgid==pid` → **latent PID-reuse bug today**. → use the identity predicate.
4. Server shutdown deliberately leaves durable children alive
   (`shutdown_readers`, parallel_exec.py:1563-1581; proven by
   test_t2f5_survival.py:113-124). Read-only survival MUST be preserved; write
   children MUST instead be terminated on controller loss.
5. Spawn-to-persist window (codex.py:789 vs server.py:413-429): wrapper can start
   codex before identity is persisted. → launch gate: persist identity BEFORE the
   child may exec; fail closed otherwise.
6. Identity token fail-open: known `proc_start_time is None` regression. → writes
   fail closed without a verified identity.

## Slice plan (each a codex write dispatch, verified locally + reviewed, committed before the next)

- **Slice 1 — `proc_identity.py` termination helper (pure additive).**
  `async terminate_verified(pid, proc_start_time, *, require_pgid_is_pid=True, grace_s)`:
  verify identity (pid + start-time, optional pgid==pid) → SIGTERM → bounded wait
  for that exact identity to vanish → SIGKILL → wait → return only after death;
  identity mismatch is a safe no-op. Process-backed unit tests (TERM-ignoring
  fixture escalates to KILL; mismatch no-ops; already-dead is clean).

- **Slice 2 — wire the helper into existing kill sites (tightens cancel; no write yet).**
  cancel, durable `interrupt()`, parallel timeout/cascade, reattach cascade all
  route through the helper; cancel/terminal only reported after confirmed death;
  reattach cascade uses identity not `pid_alive`. **Preserve** read-only survival
  (graceful shutdown still leaves read-only durable children alive) — the helper
  is invoked on cancel/timeout/controller-loss paths, never on graceful shutdown
  of a read-only child.

- **Slice 3 — enable write+durable with kill-on-controller-loss.**
  Replace the `stream_path is not None` write rejection (codex.py:313) with a
  gated durable-write path: launch gate (persist verified identity before exec;
  fail closed), controller-loss → terminate the writer, restart policy = a
  writable standalone run is terminated + persisted failed/cancelled (never
  resumed) + startup sweep of `~/.stratum/agent_runs`. `ParallelExecutor` stays
  read-only (no flow write policy in v1 — never infer write from agent/task).

- **Slice 4 — docs + full-suite green.**
  Update the 2026-07-09 non-goal to reflect v1; document the cancel guarantee and
  its bounded exception (an OS write already in flight cannot be rolled back);
  full pytest green (baseline 1517 passed / 2 skipped) incl. backward-compat.

## Acceptance criteria

- [ ] write+background dispatch succeeds: returns run_id/stream_path; poll works
- [ ] cancel returns `cancelled` ONLY after the child's exact identity is gone;
      TERM-resistant child escalates to KILL
- [ ] controller loss (server exit) terminates a write child; read-only durable
      survival (test_t2f5_survival) unchanged
- [ ] restart classifies a writable standalone run as terminated+failed, never
      resumed; startup sweep reaps orphaned writable agent_runs
- [ ] identity unavailable → write run fails closed (no unstoppable writer)
- [ ] reattach cascade kill uses (pid, start-time, pgid), never bare pid_alive
- [ ] backward-compat contracts unchanged: default `--sandbox read-only`, factory
      defaults, no-jail review behavior, read-only durable byte-for-byte
- [ ] full pytest suite 1517 passed / 2 skipped

## Residual risk (documented, bounded)

SIGTERM/SIGKILL cannot undo an FS write already entered by codex/kernel. Bound
with: short termination grace, atomic-write expectations in the agent prompt,
optional dedicated worktree per writer, terminal audit/diff after recovery.

### Kill-on-controller-loss is NOT unconditional (codex review, 2026-07-11)

The "controller loss terminates the write child" guarantee is delivered by two
sweeps: the **graceful-shutdown** sweep (`main()` finally, reason
`controller_loss`) and the **startup** sweep (reason `server_restart`). Two
windows remain OPEN in NARROW v1 and are accepted as bounded residual risk for a
stopgap (per strategy doc D1: narrow, no expansion):

1. **Hard-killed controller (SIGKILL/crash) that never restarts.** The graceful
   sweep is bypassed and no startup sweep runs, so the writer continues until it
   completes (the realistic outcome — codex builds are bounded tasks) or, if it
   hangs, indefinitely. A next server start reaps it. Closing this window
   requires a controller-liveness mechanism (a lifetime-held pipe the child
   monitors for EOF, self-terminating on controller death) — filed as
   **STRAT-CODEX-WRITE-DURABLE-LIVENESS**, deliberately out of NARROW v1.
2. **`setsid()`-escaping payload.** The persisted identity is the wrapper
   (`pgid==pid`, group leader); a payload that calls `setsid` starts a new
   session and escapes `killpg`. The launch gate verifies the *wrapper* at
   spawn, but nothing prevents the codex payload from later re-parenting a
   writer out of the group. v1 relies on the workspace-write sandbox + the
   atomic-write prompt convention; active detection/prohibition is deferred to
   LIVENESS. A cancel/sweep that kills only the wrapper group will report the
   run terminated while an escaped writer survives.

The sweep itself only records a terminal `failed` fate once death is positively
confirmed (`terminated`/`killed`/`already_gone`); an unconfirmed-alive writer is
left for the next sweep to retry, and a run that completes in the scan race is
re-scanned and wins over `failed` (codex findings 3 & 4, fixed 2026-07-11).
