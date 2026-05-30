# T2-F5-RESUME — Design (live-process reparenting)

**Status:** Phase 1 design (2026-05-30) — revised after Codex design-gate **round 1** (12 findings
folded in: v1 narrowed to **codex + parallel-dispatch only** (opencode is rejected on the server path,
`stratum_agent_run` has no durable record); a **wrapper-written durable sentinel** replaces the false
"result already in the stream" claim; a **detach-don't-kill** shutdown path (clean shutdown currently
interrupts the child + removes the worktree); an explicit **reattach runtime + registry + single-flight**
owner (nothing drives re-attach after restart); a persisted **`dispatch_debited` marker** (budget would
double-charge on the persisted `started_at`); a **resume/start surface** that polls instead of
re-dispatching; stderr→durable file; the full `reparenting` surface enumeration; identity guard trimmed
to the spike-proven pid+start_time; child-opens-file matched to the spike; `streams/` cleanup owner). Revised again after **round 2**
(4 findings: the wrapper drops `exec`+inner `setsid` and wraps the **final** `_build_codex_cmd` argv via
`sh -c '"$@" …'` so it composes with the read-jail driver, with `killpg`-based process-group interrupt;
durable mode changes the **connector's teardown contract** so its `finally` no longer kills the child
(the generator-unwind `_cleanup_jail` was the real teardown, not `_run_one`) — kill is `interrupt()`-only;
the `ReattachReader` binds the canonical `_flows[flow_id]` instance and persists under the existing
per-flow lock). Revised after **round 3** (1 finding: an explicit live-completion contract — after the
sentinel, the live connector still `await proc.wait()`s and asserts rc parity, and preserves today's
`rc != 0`/no-result error behavior by sourcing the message from the durable `$T2F5_ERR` file; only
cancel-unwind skips the reap; the re-attach reader uses sentinel rc + stderr file, no `waitpid`).
Built on a passing feasibility spike (`spike/spike-findings.md`). Not yet implemented.
**Owner repo:** stratum
**Track:** T2-F5 (siblings `-DEPENDS-ON`, `-DIFF-EXPORT`, `-DEFER-ADVANCE` shipped); unblocks forge-top
`STRAT-WORKFLOW-RESUME` (content-addressed replay, which *extends* this).
**Related:** [[feedback_ship_narrow_first]], [[feedback_verify_isolation_primitives]].

## Problem

When the stdio MCP server restarts mid-run, **server-dispatched** agent work in flight is lost:
`resume_interrupted_parallel_tasks` (`parallel_exec.py:1039`) flips every `running` parallel task to
`failed` (`RESUME_INTERRUPTED_ERROR`, `:1036`). Its docstring defers the fix here: *"Real reparenting
(resuming an executor against a live child process) is tracked separately as T2-F5-RESUME"* (`:1049`).
A 20-minute codex run 90% done at restart is thrown away. `stratum_resume` (`server.py:373`) only
restores consumer-dispatched **position** (`current_idx`) — it has no child to hand back.

## Feasibility — spike result (read first)

The spike (`spike/spike-findings.md`) proved the primitive on darwin (graceful exit AND `kill -9`): a
child spawned **`start_new_session=True`** that **opens its own durable output file** (no server pipe)
**survives the parent's death** and a **fresh process re-opens the file from a persisted offset and
recovers the complete result**, gated by **pid-liveness + process-start-time**. No engine rewrite.

## Verified architecture (read the source, don't infer)

- **Only codex is a reparentable server-dispatch connector.**
  - `ClaudeConnector` runs **in-process** (`claude_agent_sdk.query()`, `claude.py:114`) — no child;
    a restart kills it. **Out of v1.**
  - `CodexConnector` spawns a subprocess (`codex.py:259`/`:434`, `stdout/stderr=PIPE`, no
    `start_new_session`); prompt → child stdin then closed (`:281-283`); JSONL on stdout. **In v1.**
  - `OpencodeConnector` spawns a subprocess (`opencode.py:94`) **but is rejected on the server path** —
    `_connector_type_from_agent` (`parallel_exec.py:67`) rejects `opencode`, and
    `make_agent_connector` (`connectors/factory.py:4`) only builds claude/codex. **Out of v1** (a
    separate enablement; re-attach generalizes to it once dispatchable).
- **The connector's `_result` sentinel is in-memory, not in the stream (round-1 #2).**
  `CodexConnector.stream_events()` synthesizes `_result` only *after* `await proc.wait()` from buffered
  text (`codex.py:~555`). It is **not** a durable record — a fresh reader of the raw JSONL file cannot
  use it. v1 derives completion from a **wrapper-written sentinel line** (§2).
- **Consume seam is connector-agnostic.** `_run_one` → `_consume_streaming` (`parallel_exec.py:652`) →
  `connector.stream_events()`/`_consume`; events → result + budget usage. The re-attach reader produces
  the same `result` directly (it bypasses the live connector — the child is already detached).
- **Persistence point.** `ParallelTaskState` (`@dataclass`, `executor.py:917`) is JSON-persisted per
  task; the handle fields attach here.
- **Startup hook.** `resume_interrupted_parallel_tasks(_FLOWS_DIR)` runs on boot (`server.py:3986`).
- **Budget double-charge hazard (round-1 #6).** `_run_one`'s finally debits `dispatches=1` for any task
  with `started_at` (`parallel_exec.py:~955`+`debit_budget`), and `started_at` **is persisted/restored**
  — so a naive re-attach re-charges the dispatch. Needs an explicit debited marker.
- **Clean-shutdown tears down children (round-1 #3).** `shutdown_all` (`parallel_exec.py:1095`) cancels
  executor tasks; `_run_one`'s `CancelledError` path calls `connector.interrupt()` (kills the child),
  captures diff, and removes the worktree (`:~927/:978`). That destroys exactly what we need to survive.
- **Resume re-dispatches (round-1 #4).** After restart `get_current_step_info` (`executor.py:1487`)
  returns the `parallel_dispatch` step again and `stratum_parallel_start` (`server.py:1256`) does not
  treat an in-flight task as already-started — so the consumer would re-dispatch.
- **No post-restart re-attach owner (round-1 #5).** `_PARALLEL_EXECUTORS`/`_RUNNING_EXECUTORS`
  (`server.py:629`) are in-memory and empty after restart; `stratum_parallel_poll` (`:1337`) only drains
  a live executor's queue.

## Design

### 1. Scope (ship-narrow)

v1 reparents **codex, server-dispatched via parallel_dispatch / pipeline only**. Out: claude
(in-process), opencode (not server-dispatchable yet), `stratum_agent_run` (in-memory `_AGENT_RUN_TASKS`,
no durable record — round-1 #7). Re-attach is **best-effort**: a live, identity-matched child → tail to
completion; dead / mismatched → `failed` (today's behavior) → consumer re-runs.

### 2. Durable, detached spawn + wrapper sentinel (the connector change)

`CodexConnector` gains a **durable-stream mode**, on when the executor passes a `stream_path` (off →
today's PIPE behavior verbatim, for tests / any non-flow call):

- Spawn under a thin POSIX-shell wrapper that **stays alive** (no `exec`) to append a completion record
  even if the server is gone, wrapping the **final argv** (round-2 #1/#3):
  ```
  create_subprocess_exec(
    "sh", "-c",
    '"$@" > "$T2F5_OUT" 2> "$T2F5_ERR" < "$T2F5_IN"; '
    'printf "{\"__t2f5_done__\":%d}\\n" "$?" >> "$T2F5_OUT"',
    "sh", *final_argv,                       # "$@" = the FINAL argv from _build_codex_cmd
    start_new_session=True,                   # Python sets up the new session — NO inner `setsid`
    env={**clean_env, "T2F5_OUT":out, "T2F5_ERR":err, "T2F5_IN":inp},
    stdout=DEVNULL, stderr=DEVNULL, stdin=DEVNULL,
  )
  ```
  - **No `exec`** — the shell waits for the command and then appends the sentinel (round-2 #1).
  - **No inner `setsid`** — `start_new_session=True` already makes the wrapper the session leader
    (round-2 #1); the persisted `child_pid` is the wrapper = the **process-group/session leader**.
  - **`"$@"` = the final argv returned by `_build_codex_cmd` (`codex.py:164`)** — i.e. the *already
    jail-wrapped* command when read-jail is active (`DockerJailDriver.wrap_argv` injects its own
    `bash -lc 'exec codex …'`, `judge/sandbox.py:414`). The durable wrapper sits **outside** that, so it
    composes with jailed and non-jailed codex alike (round-2 #3); redirecting the jail wrapper's stdout
    to `$T2F5_OUT` captures the forwarded codex JSONL. An acceptance case covers jailed codex.
  - codex JSONL → `$T2F5_OUT`, stderr → `$T2F5_ERR` (durable, no pipe → no `SIGPIPE`/`EPIPE` after
    parent death, round-1 #8), prompt fed from `$T2F5_IN` (no stdin pipe). The wrapper appends a final
    `{"__t2f5_done__": <rc>}` line — the durable completion sentinel (round-1 #2). The shell **opens its
    own files via redirection** — matches the spike primitive (round-1 #11).
- **`interrupt()` must be process-group-aware in durable mode (round-2 #1).** Today
  `CodexConnector.interrupt()` signals only `self._proc` (`codex.py:589`) — now the wrapper. To actually
  kill codex (its child) on a genuine cancel (require-cascade / budget-exhaust), durable mode signals the
  **group**: `os.killpg(os.getpgid(wrapper_pid), SIGTERM→SIGKILL)`.
- **Live mode = durable mode + a tailer.** When the server *is* alive, the connector tails `$OUT`
  (parsing codex JSONL, stopping at `__t2f5_done__`) instead of reading a PIPE, so the live path and the
  re-attach path read the **same** durable file the same way — one reader, proven by the same tests.
- **Partial trailing line:** the tailer consumes only up to the last `\n`, carrying the remainder
  (round-1 spike residual) — a crash mid-write never reaches `json.loads`.
- The `_CODEX_STDOUT_LIMIT` pipe bound (`codex.py:266`) becomes a per-read chunk size on the file.

### 3. The reparent handle (persisted in `ParallelTaskState`)

New optional fields on `ParallelTaskState` (`executor.py:917`), written at durable spawn, JSON-persisted:
- `child_pid: int | None` — the **wrapper** pid (the session leader; codex is its child).
- `stream_path: str | None`, `stderr_path: str | None`
- `proc_start_time: str | None` — wrapper start time (darwin `ps -o lstart=`; Linux `/proc/<pid>/stat`
  field 22) — the spike-proven PID-reuse guard. (No "stream session-id" second guard in v1 — round-1
  #10 — codex's `thread.started.thread_id` is noted as a *future* hardening, not relied on now.)
- `stream_offset: int` — bytes consumed (re-attach resumes here; updated as the tailer drains).
- `reparentable: bool` — true only for codex durable-stream tasks.
- `dispatch_debited: bool` — set true the first time the dispatch is charged, persisted, so re-attach
  never re-charges the dispatch (round-1 #6); the reader debits only *delta* token usage parsed past
  `stream_offset`.

### 4. Detach-don't-kill shutdown (round-1 #3, round-2 #2)

Skipping `connector.interrupt()` in `_run_one` is **not sufficient** — `CodexConnector.stream_events()`
runs `_cleanup_jail(proc)` in its `finally` (`codex.py:580`/`:193`), which reaps/terminates the child;
when `shutdown_all` cancels the executor task, that generator unwinds **innermost-first**, so the
`finally` fires *before* `_run_one`'s `except` can intervene. So the kill must be suppressed *inside the
connector*, not at `_run_one`:

- **Durable mode changes the connector's teardown contract:** a durable-stream `CodexConnector`'s
  `finally` does **NOT** kill/reap the child (it only closes its own tail file handle). The child is a
  detached, durable-output process meant to outlive the connector. **Killing the child happens ONLY via
  explicit `interrupt()`** (the require-cascade / budget-exhaust path that genuinely wants it dead, now
  `killpg`-based per §2).
- **Live completion contract (round-3 #1) — parity with today's error handling.** When the server is
  alive and the connector is the parent, after the tailer reads `{"__t2f5_done__": rc}` it still
  `await proc.wait()`s the wrapper (the connector IS the parent in live mode) and asserts the wrapper
  exit status == the sentinel `rc` (a mismatch is a connector error). Today's behavior is preserved:
  `rc != 0` with no usable result → raise, sourcing the message from **`$T2F5_ERR`** (the durable stderr
  file) instead of the old in-memory `stderr` pipe (`codex.py:568`). The **re-attach** reader is NOT the
  parent (child reparented to init), so it cannot `waitpid` — it relies solely on the sentinel `rc` +
  `$T2F5_ERR` for the same complete/failed verdict. **Only generator cancel/unwind** (shutdown) skips
  the reap so the child survives for re-attach.
- **Two failure channels, not one (round-4 #1).** codex fails today via EITHER `rc != 0` OR an explicit
  JSONL **`{"type":"error"}`** event that `stream_events()` raises on immediately (`codex.py:565`). Both
  the live durable tailer AND the `ReattachReader` parse the JSONL in `$T2F5_OUT` and treat a
  `type=="error"` record as an **authoritative failure**, preserving current semantics. For parity (and
  so a detached child isn't terminalized before it's actually done): the reader **records the first
  `error` event but keeps tailing to `{"__t2f5_done__"}`**, then resolves the task `failed` with that
  error message (live mode additionally `await proc.wait()`s). The re-attach reader derives the identical
  verdict purely from the durable stream (`error` event ∪ sentinel `rc` ∪ `$T2F5_ERR`) — no `waitpid`.
- **`_run_one` cancel branch:** for a reparentable task, do NOT `interrupt()`, do NOT remove the
  worktree, do NOT terminalize — leave it `running` with its handle persisted. (With the connector
  teardown change above, this is now actually honored end-to-end.)
- `shutdown_all` cancels the executor's reader tasks (not the children). The worktree is removed only
  when the task reaches a terminal state, by the re-attach reader.

### 5. Restart classify + reattach runtime (round-1 #4, #5)

- **Startup classify (sync, `resume_interrupted_parallel_tasks`):** for each `running` task — if
  `reparentable` and the wrapper pid is **alive AND `proc_start_time` matches**, set state
  **`reparenting`**; else today's `running→failed`. Pure file/`os.kill(pid,0)`/`ps`, no async.
- **Reattach runtime (new):** a `ReattachReader` per `reparenting` task + a `_REATTACH_READERS`
  registry keyed by `(flow_id, task_id)` with **single-flight** ownership (a per-task `asyncio.Lock`/flag
  so concurrent polls/resumes don't double-attach). The reader is an `asyncio.Task` that tails
  `stream_path` from `stream_offset` to `__t2f5_done__`, parses codex JSONL into the task `result`,
  applies the cert + delta-budget via the shared helpers, flips `reparenting→complete` (or `→failed` if
  the wrapper pid dies with no sentinel), removes the worktree, and persists.
- **Canonical state binding + per-flow lock (round-2 #4).** The reader binds to the **canonical
  `_flows[flow_id]` `FlowState` instance** (the same object poll/start/resume restore-and-cache,
  `server.py:1238`/`:1352`), not a private copy, and every mutation persists through the **existing
  per-flow lock** (`_lock_for(flow_id)` / the executor's `_persist`, `parallel_exec.py:515`) — so the
  background reader, a concurrent `stratum_parallel_poll`, and a `stratum_resume` can't race on
  `stream_offset` / terminal state / the aggregate. The driver acquires-or-creates the canonical state
  before starting any reader.
- **Driver:** the first `stratum_parallel_poll` / `stratum_resume` touching a flow with `reparenting`
  tasks **lazily creates+starts** the readers (single-flight), then returns current status; later polls
  observe progress/terminal — mirroring how `stratum_parallel_start` spawns the executor and poll drains
  it.

### 6. Resume / start surface (round-1 #4)

- `get_current_step_info` / `stratum_resume`: a `parallel_dispatch`/`pipeline` step with any
  `running`/`reparenting` task returns an **"in progress — poll, don't dispatch"** status (the existing
  defer-advance/poll surface), not a re-dispatch.
- `stratum_parallel_start` (`server.py:1256`): reject re-start when any task is `running` **or**
  `reparenting` (extends the existing "already past pending" guard) — kicks the caller to poll.

### 7. `reparenting` state-surface enumeration (round-1 #9)

`reparenting` is **non-terminal** and **already-dispatched** everywhere the existing terminal set is
special-cased — mirroring how `-ROUTE` threaded `skipped`:
- `stratum_parallel_start` re-start rejection; `_require_unsatisfiable` / `_item_counts`
  (`reparenting` = in-flight, neither complete nor failed); poll summary counter; `all_terminal`
  (= not terminal); both `ParallelTaskState→task_results` serializers (`reparenting`→a status the
  advance logic treats as in-flight); restart re-classify.

### 8. Cleanup (round-1 #12)

`~/.stratum/flows/<flow_id>/streams/` is created on first durable spawn; `delete_persisted_flow`
(`executor.py:1312`) is extended to remove it; a task reaching terminal removes its own
`stream_path`/`stderr_path` (kept until then for re-attach). Partial restart leftovers (a stream with no
live child and no sentinel) are cleaned when classify fails the task.

### 9. Result shape / contract

Unchanged — a re-attached task produces the same `ParallelTaskState.result`; `_evaluate_parallel_results`
/ `_collapse_pipeline_items` / `ensure` see no difference. The only observable additions: the transient
`reparenting` state between restart and re-attach, and the handle fields in the persisted trace.

## Acceptance criteria

- [ ] **Durable-stream mode (codex):** given a `stream_path`, codex spawns the detached `setsid sh -c`
      wrapper writing JSONL→`$OUT`, stderr→`$ERR`, and a final `{"__t2f5_done__":rc}` line; the live
      tailer parses `$OUT` to that sentinel. With no `stream_path`, byte-identical to today (PIPE).
      Claude/opencode unchanged.
- [ ] **Survival (the spike against the real path):** kill the executor's reader (simulating restart)
      mid-run; assert the codex wrapper keeps writing `$OUT` and a fresh reader recovers the full result
      + exit code from the file.
- [ ] **Handle persisted/round-trips:** `child_pid/stream_path/stderr_path/proc_start_time/
      stream_offset/reparentable/dispatch_debited` on `ParallelTaskState` survive FlowState JSON.
- [ ] **Startup classify:** `running` reparentable + live + identity-matched → `reparenting`; dead or
      identity-mismatched → `failed`; non-reparentable (claude / no handle) `running` → `failed`
      (regression-guarded).
- [ ] **Reattach runtime:** a `reparenting` task, on the next poll, is owned by exactly one
      `ReattachReader` (single-flight under concurrent polls), tails to the sentinel, produces the
      correct `result`, flips `→complete`, removes the worktree.
- [ ] **Reattach failure:** wrapper pid gone with no sentinel → `failed` → consumer re-runs.
- [ ] **PID-reuse guard:** live pid with mismatched `proc_start_time` → treated as dead.
- [ ] **Partial trailing line** is read without a JSON error; remainder consumed next read.
- [ ] **Budget idempotency:** a task re-attached after restart is one dispatch total
      (`dispatch_debited` persisted); only delta token usage past `stream_offset` is charged.
- [ ] **Durable wrapper composes with jail:** the `sh -c '"$@" …'` wrapper wraps the final
      `_build_codex_cmd` argv; an acceptance case runs **jailed** codex in durable mode and recovers the
      result from `$T2F5_OUT`. The wrapper appends `{"__t2f5_done__":rc}` (verified for rc=0 and rc≠0).
- [ ] **Process-group interrupt:** a genuine `interrupt()` (require-cascade / budget-exhaust) in durable
      mode `killpg`s the wrapper's group so codex (the child) actually dies — no orphan.
- [ ] **Live completion parity:** live durable mode `await proc.wait()`s after the sentinel and asserts
      rc parity; a codex `rc != 0` with no result raises sourced from `$T2F5_ERR` (parity with today's
      stderr-pipe behavior); the re-attach reader reaches the same verdict from sentinel rc + `$T2F5_ERR`
      without `waitpid`.
- [ ] **Codex error-event channel:** a JSONL `{"type":"error"}` in `$T2F5_OUT` is an authoritative
      failure for BOTH the live tailer and the re-attach reader (recorded, tail continues to the
      sentinel, task → `failed` with that message) — parity with `stream_events()` today
      (`codex.py:565`).
- [ ] **Connector teardown doesn't kill in durable mode:** cancelling a durable-stream codex connector's
      generator (shutdown) leaves the child alive (its `finally` no longer runs `_cleanup_jail`'s
      teardown); only `interrupt()` kills.
- [ ] **Detach-don't-kill (end-to-end):** on shutdown/cancel a reparentable task is NOT interrupted, its
      worktree is NOT removed, it stays `running`; a non-reparentable task keeps today's
      interrupt+terminalize.
- [ ] **Reattach state ownership:** the `ReattachReader` binds the canonical `_flows[flow_id]` instance
      and persists under `_lock_for(flow_id)`; a concurrent poll + resume + reader don't corrupt
      `stream_offset` / terminal state / aggregate (single-flight + per-flow lock).
- [ ] **Resume/start surface:** post-restart, a parallel/pipeline step with `running`/`reparenting`
      tasks returns poll-not-dispatch; `stratum_parallel_start` rejects re-start while any task is
      `running`/`reparenting`.
- [ ] **`reparenting` surfaces:** treated as non-terminal/in-flight at `_require_unsatisfiable`,
      `_item_counts`, both serializers, poll summary, `all_terminal`, start-rejection.
- [ ] **Cleanup:** `streams/` created on spawn, removed on flow delete and on per-task terminal.
- [ ] Full combined suite green; CHANGELOG + report; track/forge-top row updated. Codex design gate +
      impl review → REVIEW CLEAN.

## Out of scope (named follow-ups)

- **Claude (in-process) resume** — needs a claude-SDK-session feature; claude interrupted tasks stay
  `running→failed`.
- **Opencode reparenting** — blocked on making opencode server-dispatchable
  (`_connector_type_from_agent`/factory); re-attach generalizes once it is.
- **`stratum_agent_run` resume** — needs a durable run record (today `_AGENT_RUN_TASKS` is in-memory);
  its own follow-up.
- **Content-addressed prefix-cache replay** — `STRAT-WORKFLOW-RESUME` (caching, not reattach), extends
  this.
- **Windows / cross-host** — Unix, local-pid-bound.
