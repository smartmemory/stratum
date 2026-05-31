# T2-F5-RESUME — Implementation Plan (Phase 6)

**Status:** Phase 6 plan (2026-05-31). Derived from the gate-clean [blueprint](./blueprint.md)
slices S1–S6 and [design](./design.md). All `parallel_exec.py` / `codex.py` / `executor.py` /
`server.py` line anchors **re-verified against disk** at the start of this session — zero drift from
the blueprint's verification table.

All paths below are under `stratum-mcp/src/stratum_mcp/`. Test files under `stratum-mcp/tests/`.

## Execution model

TDD per the blueprint's test plan order. Each task: write the failing test first, watch it fail for
the right reason, implement the smallest correct change, watch it pass. Slices are ordered so each
builds on a persisted/observable artifact from the prior one. Existing codex/parallel tests are the
regression guard for the non-durable (today's) path — they must stay green throughout.

---

## Task 1 — S1: codex durable-stream mode  `connectors/codex.py` (+ `connectors/factory.py`)

**Test first** (`tests/test_codex_durable.py`, new):
- [ ] `_emit_for_codex_event(event, *, model, prompt)` maps one JSONL record → `Iterable[ConnectorEvent]` (stateless); existing event-translation cases still pass via the caller.
- [ ] Durable spawn (real `sh` wrapper in `tmp_path`): given `stream_path`, child writes codex JSONL → `$T2F5_OUT`, stderr → `$T2F5_ERR`, final `{"__t2f5_done__":rc}` line for rc=0 **and** rc≠0.
- [ ] **Jailed-codex durable** (Codex review #3 — highest-risk composition): when `_build_codex_cmd` returns a jail-wrapped final argv (`codex.py:164`), the `_T2F5_WRAPPER` sits **outside** it; result recovered from `$T2F5_OUT` for rc=0 and rc≠0.
- [ ] `_tail_stream(out_path, start_offset)` parses complete JSONL lines, stops at `T2F5_DONE_SENTINEL`; a **partial trailing line** is carried, never `json.loads`'d.
- [ ] Live durable completion: after sentinel, `await proc.wait()`, assert rc parity; `type=="error"` event → recorded, tail continues to sentinel, then fail with that message; `rc!=0` no-result → fail sourced from `$T2F5_ERR`.
- [ ] Non-durable path (`stream_path is None`) is **byte-identical** to today (regression: existing PIPE spawn unchanged).
- [ ] `interrupt()` in durable mode → `os.killpg(os.getpgid(self._proc.pid), SIGTERM)`.
- [ ] `finally` does **not** `_cleanup_jail`-kill in durable mode (only closes file handles).

**Implement** (blueprint S1.1–S1.8):
- [ ] Extract `_emit_for_codex_event` (stateless map of `codex.py:494-566`); caller keeps `agent_started`/`text_parts`/failure-decision state.
- [ ] `const T2F5_DONE_SENTINEL = "__t2f5_done__"`; `_T2F5_WRAPPER` shell script (`'"$@" >"$T2F5_OUT" 2>"$T2F5_ERR" <"$T2F5_IN"; printf "{\"__t2f5_done__\":%d}\n" "$?" >> "$T2F5_OUT"'`).
- [ ] Durable spawn gated on `self._stream_path` at `codex.py:434`: `["sh","-c",_T2F5_WRAPPER,"sh",*_build_codex_cmd(args,clean_env)]`, `start_new_session=True`, env `T2F5_OUT/ERR/IN`, std{in,out,err}=DEVNULL; write `actual_prompt` to `$T2F5_IN` (replaces stdin-pipe write `:451-453`).
- [ ] Emit synthetic `durable_spawned` ConnectorEvent (metadata: `child_pid, stream_path, stderr_path, proc_start_time`) **before** the read loop.
- [ ] `_tail_stream` async generator → feeds `_emit_for_codex_event`; live durable mode tails it instead of the PIPE.
- [ ] Gate `_cleanup_jail(proc)` in `finally` (`:586`) on `not self._durable`; durable `interrupt()` (`:589`) → `killpg`.
- [ ] `CodexConnector.__init__` gains `stream_path`/`stderr_path` (None = today); `make_agent_connector` (`factory.py`) threads them.

## Task 2 — S2: handle fields  `executor.py:917` `ParallelTaskState`

**Test first** (`tests/test_flowstate_parallel.py`, extend):
- [ ] All 7 new fields survive FlowState JSON round-trip with defaults; loading an **old** persisted state (without them) back-compat round-trips.

**Implement** (blueprint S2):
- [ ] Append `child_pid:int|None=None, stream_path:str|None=None, stderr_path:str|None=None, proc_start_time:str|None=None, stream_offset:int=0, reparentable:bool=False, dispatch_debited:bool=False`.

## Task 3 — S3: executor wiring  `parallel_exec.py` `_run_one` `:737`

**Test first** (`tests/test_parallel_server_dispatch.py`, extend):
- [ ] Codex + server-dispatch task gets a computed `stream_path`; `durable_spawned` event stamps `child_pid/stream_path/stderr_path/proc_start_time` + `reparentable=True` and persists **before** any codex output.
- [ ] Budget: a task re-attached after a simulated restart is **one dispatch total** (`dispatch_debited` persisted; debit fires only `not ts.dispatch_debited`).
- [ ] Detach-don't-kill: with `executor._detaching=True`, a `reparentable` task on cancel is **not** interrupted, **not** terminalized, worktree **not** removed, stays `running`; a non-reparentable task keeps today's interrupt+terminalize.

**Implement** (blueprint S3.1–S3.4):
- [ ] Compute `stream_path = <flow streams dir>/<task_id>.jsonl` for codex+server-dispatch at connector build (`:813-816`); pass to ctor.
- [ ] Handle `durable_spawned` in `_consume_streaming` (`:652`) — stamp + persist under lock before output.
- [ ] Guard finally debit (`:962`) on `not ts.dispatch_debited`; set it there.
- [ ] New `self._detaching` flag (set by S6 `shutdown_all`): gate the WHOLE finalizer (inner cancel `:860`, outer cancel `:924`, finally `:936-1018` — terminalize `:937`, `_task_done` `:948`, debit `:962`, `remove_worktree` `:1006`) on `not (ts.reparentable and self._detaching)`; persist handle, leave `running`.

## Task 4 — S4: classify + reattach runtime  `parallel_exec.py`, `server.py`

**Test first** (`tests/test_reattach.py`, new):
- [ ] `classify_interrupted_parallel_tasks`: (a) running+reparentable+pid-alive+start-time-match → `reparenting`; (b) dead pid → `failed`; (c) start-time mismatch (PID reuse) → `failed`. `_proc_start_time(pid)` darwin/Linux helper.
- [ ] `ReattachReader` single-flight: concurrent poll calls produce exactly one reader per `(flow_id,task_id)`.
- [ ] Reattach complete: reader tails `stream_path` from `stream_offset` to sentinel, produces correct `result`, `reparenting→complete`, removes worktree, persists under `_lock_for`. **Asserts accounting parity** (Codex review #4): `finished_at`, `elapsed_s`, `tokens`, `dollars_recorded`, dispatch-debit, `budget_exhausted` terminalization — the fields `_run_one`'s finalizer (`parallel_exec.py:943-1018`) owns and the reader bypasses.
- [ ] Reattach failure: wrapper pid gone, no sentinel → `failed` (also asserts the accounting fields set on the failed terminal).

**Implement** (blueprint S4.1–S4.3):
- [ ] Split `resume_interrupted_parallel_tasks` (`:1039`) → `classify_interrupted_parallel_tasks` (+ `_proc_start_time` from spike).
- [ ] **Retarget the startup hook** (`server.py:3984-3990`, currently calls `resume_interrupted_parallel_tasks(_FLOWS_DIR)`) to the new classifier (Codex review #2) — same best-effort try/except + import shape — so restarted reparentable tasks become `reparenting` and the poll-time reader has something to attach to.
- [ ] `ReattachReader` + `_REATTACH_READERS` registry in `server.py` (per-task lock, binds canonical `_flows[flow_id]`, tails via S1 `_tail_stream`, cert + delta-budget, terminal flip, persist under `_lock_for`). Reader **reproduces** the `_run_one` finalizer accounting (above) so audit/budget state is correct.
- [ ] Driver: `stratum_parallel_poll` (`:1330`) + `stratum_resume` (`:373`) lazily start readers for `reparenting` tasks before reporting status.

## Task 5 — S5: `reparenting` surfaces  `server.py`, `parallel_exec.py`, `executor.py`

**Test first** (extend `test_parallel_exec.py` / server tests):
- [ ] `reparenting` counts as non-terminal/in-flight at: `_require_unsatisfiable` (`:554`), `_item_counts` (`:520`), poll summary + `all_terminal` (`:1330`), `stratum_parallel_advance` `tasks_not_terminal` (`:1562`), both `ParallelTaskState→task_results` serializers, `stratum_parallel_start` re-start reject (`:1260`).
- [ ] Post-restart, a parallel/pipeline step with `running`/`reparenting` tasks returns **poll-not-dispatch** (`get_current_step_info`/`stratum_resume`).
- [ ] Cleanup: `streams/` removed on `delete_persisted_flow` (`:1312`); per-task terminal removes its own stream/stderr files.

**Implement** (blueprint S5).

## Task 6 — S6: shutdown  `parallel_exec.py:1095` `shutdown_all`, `server.py:4009` shutdown hook

**Test first** (`tests/test_reattach.py` or shutdown test):
- [ ] After `shutdown_all`, a reparentable child is **still alive**; a `ReattachReader` task is **cancelled**.

**Implement** (blueprint S6):
- [ ] The **server shutdown hook** (`server.py:4009` region) sets `._detaching=True` on **each `_PARALLEL_EXECUTORS` instance** *before* calling `_parallel_shutdown_all(_RUNNING_EXECUTORS)` (Codex review #1 — `shutdown_all(registry)` only receives the `(flow_id,step_id)→Task` handle dict and deliberately has no `server.py` dependency, so it cannot reach the executor objects to flip the flag itself).
- [ ] `shutdown_readers(_REATTACH_READERS)` helper called from server shutdown right after `_parallel_shutdown_all(_RUNNING_EXECUTORS)` (`server.py:4009`); cancels reader tasks best-effort (un-persisted tail recovered next boot via persisted `stream_offset`).

---

## Phase 7 exit criteria (all four, none skippable)

1. **All tasks executed** — every checkbox above, tests pass.
2. **E2E** — exercise the real survival path: spawn durable codex (or a `sh`-wrapper stand-in matching the spike), kill the executor reader mid-run, confirm a fresh reader recovers the full result + rc from the file. (No Vite/Playwright surface — this is a server-side kernel feature; the survival integration test IS the E2E.)
3. **Review loop clean** — Codex review of the implementation, loop until `REVIEW CLEAN` (max 5).
4. **Coverage sweep clean** — edge/error/integration tests, loop until `TESTS PASSING` (max 15).

Then full combined `pytest stratum-mcp/tests/` green before Phase 8/9/10.

## Landmines (from status.md — carry into execution)

- Re-verify `parallel_exec.py` anchors before each edit if any sibling merge lands mid-session.
- `_emit_for_codex_event` is **not** a pure extract — caller keeps state; durable mode's "record error, fail after sentinel" is an intentional behavior change (design round-4).
- `child_pid` is the **wrapper** pid (session leader); codex is its child — identity guard + killpg target both use the wrapper.
