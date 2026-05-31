# T2-F5-RESUME — Implementation Report

**Status:** COMPLETE (2026-05-31). Branch `t2-f5-resume`. Full suite green (1242 passed, 2 skipped).
Codex impl review CLEAN @ round 2.

## 1. Summary

Server-dispatched **codex** tasks now survive an MCP server restart mid-run. A codex task in a
`parallel_dispatch`/`pipeline` step is spawned **detached** (`start_new_session=True`) under a thin
POSIX-shell wrapper that writes codex JSONL to a durable file the child owns, plus a final
`{"__t2f5_done__": rc}` sentinel. The child keeps running and writing after the server dies; on restart
the boot classifier marks the live, identity-matched task `reparenting`, and the next poll/resume starts
a `ReattachReader` that tails the durable file to completion and recovers the full result + accounting —
no engine rewrite, just a spawn-site change + a durable-stream reader.

## 2. Delivered vs Planned

All 6 blueprint slices delivered as planned:

| Slice | Delivered |
|---|---|
| S1 durable-stream mode | `connectors/codex.py`: `_emit_for_codex_event` (stateless map), `_T2F5_WRAPPER`, `T2F5_DONE_SENTINEL`, durable spawn, `_tail_stream`, `durable_spawned` handoff, killpg interrupt, finally-no-kill; `factory.py` threads `stream_path`/`stderr_path` |
| S2 handle fields | `ParallelTaskState`: 7 Optional fields, JSON round-trip + back-compat |
| S3 executor wiring | `_run_one`: durable stream_path for codex, `durable_spawned` stamp+persist, `dispatch_debited` guard, `_detaching` gates the whole finalizer |
| S4 classify + reattach | `classify_interrupted_parallel_tasks` + `_proc_start_time` (new `proc_identity.py`), `ReattachReader` + `_REATTACH_READERS` registry, poll/resume driver, startup hook retargeted |
| S5 reparenting surfaces | non-terminal/in-flight at `_item_counts`, `_require_unsatisfiable`, poll summary/`all_terminal`, advance gate, start-reject, resume poll-not-dispatch; `streams/` cleanup |
| S6 shutdown | server hook sets `_detaching` on `_PARALLEL_EXECUTORS` before `shutdown_all`, then `shutdown_readers` |

## 3. Architecture Deviations

- **`proc_identity.py`** added as a leaf module (not inlined) so both `connectors/codex.py` (stamps the
  handle at spawn) and `parallel_exec.py` (classifies on restart) import it without a cycle.
- **Wrapper re-exits with codex's rc** (`rc=$?; …; exit "$rc"`) rather than exiting with `printf`'s
  status — so the live `proc.wait()` exit status and the durable sentinel rc agree (caught by a test).

## 4. Key Implementation Decisions

- **Terminal-only offset/debit/result persist in `ReattachReader`** (correctness over the incremental
  persist the blueprint sketched): a reader cancelled mid-tail persists nothing new and the next boot
  re-reads from the persisted offset — never double-charging budget, never losing result text.
- **Reattach reproduces the `_run_one` finalizer accounting** (`finished_at`, `elapsed_s`, `tokens`,
  `dollars_recorded`, one-time dispatch debit, `budget_exhausted`, worktree removal) — Codex review #4.
- **Persist-before-delete** in both finalizers (Codex review #2): the terminal snapshot hits disk before
  the durable replay files are removed, so a crash in between never loses both recovery sources.
- **Detach only an in-flight task** (Codex review #1): the detach short-circuit fires only when the task
  is still `pending`/`running`; a task that reached terminal in the try-body finalizes normally.
- **Restart-time sibling cascade** (Codex review #3): `ReattachReader` takes `require` + sibling ids and,
  on a terminal that tips the budget or makes `require` unsatisfiable, killpg's the sibling reparented
  children (their readers then terminalize them) — reproducing `_run_one`'s cascade with no executor.

## 5. Test Coverage

5 new test files (all green): `test_codex_durable.py` (14 — emitter, tailer partial-line, durable spawn
rc/sentinel, jailed-codex compose, killpg, finally-no-kill), `test_reattach.py` (13 — classify 4 cases,
reader complete/failure/error/stderr/worktree, accounting parity, cascade decision, single-flight),
`test_t2f5_executor.py` (7 — handoff stamp-before-output, stream_path, dispatch_debited, detach), 
`test_t2f5_surfaces.py` (6 — start-reject, advance gate, poll summary, resume, cleanup, require), 
`test_t2f5_survival.py` (2 — **the E2E golden flow**: real detached child survives `shutdown_all` and a
fresh reader recovers the result written after teardown; reader cancellation). Existing connector/parallel
tests are the regression guard for the non-durable PIPE path (byte-identical).

## 6. Files Changed

`connectors/codex.py`, `connectors/factory.py`, `executor.py`, `parallel_exec.py`, `server.py`,
new `proc_identity.py`; tests above + updated `test_connector_factory.py`, `test_flowstate_parallel.py`,
`test_pipeline.py` (stub factory signatures accept the new kwargs).

## 7. Known Issues & Tech Debt

- **Re-attach re-emits already-seen wire events** (it tails from the persisted offset = 0 for a freshly
  reparented task). Correct for budget/result; the incremental-offset optimization is deferred.
- Out of scope (named follow-ups, unchanged from design): claude in-process resume, opencode
  reparenting, `stratum_agent_run` durable record, content-addressed replay (STRAT-WORKFLOW-RESUME),
  Windows/cross-host.

## 8. Lessons Learned

- The `_run_one` finalizer owns more accounting than the result (budget, timing, worktree) — any
  alternate completion path (reattach) must reproduce ALL of it or silently corrupt audit/budget state.
- A `gather(return_exceptions=True)` in `run()` silently swallows finalizer exceptions — bare fake
  states (no `terminal_status`) mask bugs; richer fakes are needed to exercise the budget tail.
- Shell wrapper exit-status parity (`exit "$rc"`) matters when the live path asserts `proc.wait()` ==
  sentinel rc.
