# T2-F5-RESUME — Implementation Blueprint

**Status:** Phase 4-5 (2026-05-31). Maps the gate-clean [design](./design.md) to verified touchpoints.
All file:line anchors **verified against disk** this session (see Verification Table). Scope: **codex +
parallel-dispatch only** (per design §1).

## Corrections table (design assumption → reality)

| Design statement | Reality on disk | Resolution |
|---|---|---|
| "the connector tails the file instead of the PIPE" | `stream_events()` JSONL parse (`codex.py:470-566`) is inlined in the pipe read-loop, not factored out | S1 **extracts** the per-line parse into `_emit_for_codex_event(event)` so pipe-read AND file-tail feed the same emitter |
| handle fields "added to `ParallelTaskState`" | `ParallelTaskState` is a `@dataclass` (`executor.py:916`) persisted by field; adding Optional fields w/ defaults round-trips + stays back-compat | S2 appends 7 Optional fields |
| "`finally` does not kill in durable mode" | the kill is `await self._cleanup_jail(proc)` at `codex.py:586` inside `stream_events()`'s `finally` | S1 gates `_cleanup_jail`'s teardown on a `self._durable` flag |
| "interrupt killpg" | `interrupt()` sends `SIGTERM` to `self._proc` only (`codex.py:589-599`) | S1 durable branch → `os.killpg(os.getpgid(self._proc.pid), …)` |
| budget "dispatch_debited marker" | `_run_one` finally debits `dispatches=1` if `started_at` (`parallel_exec.py:959-966`); `started_at` persists | S3 guards the debit on `ts.dispatch_debited` |
| "reattach driven by next poll" | no post-restart executor; poll only drains live `_RUNNING_EXECUTORS` (`server.py:629`) | S4 adds `ReattachReader` + registry, started by poll/resume |
| "detach-don't-kill = skip `interrupt()`" (blueprint-review #1) | the destructive teardown is the **outer** `except CancelledError` (`:924-935`) + `finally` (`:936-1018`): terminalize→failed (`:937-942`), commit `_task_done` (`:948-949`), debit (`:959-966`), `remove_worktree` (`:1006`), persist (`:1012`) | S3 gates the WHOLE finalizer on a `self._detaching` flag for reparentable tasks |
| "after spawn, stamp the handle on `ts`" (blueprint-review #2) | spawn is inside `CodexConnector.stream_events()` (`codex.py:434`); `_run_one` only sees streamed events — no seam, and a crash before the first event loses the handle | S1 emits a synthetic **`durable_spawned`** ConnectorEvent first (carrying pid/paths/start_time); S3 stamps+persists it in `_consume_streaming` (`:652`) BEFORE any codex output |
| `_emit_for_codex_event` "pure extract, no behavior change" (blueprint-review #3) | the pipe loop (`codex.py:469-579`) is **stateful**: dedupes `thread.started`, accumulates `text_parts`, raises immediately on `type=="error"` (`:565`) | S1: the helper does the stateless per-event→event mapping; the **caller** keeps `agent_started`/`text_parts` state; durable mode's "record error, fail after sentinel" is an **intentional** behavior change (design round-4), not a no-op extract |

## Boundary Map

- `interface DurableStreamHandle` (type, S2) — the 7 `ParallelTaskState` fields
  `{child_pid, stream_path, stderr_path, proc_start_time, stream_offset, reparentable, dispatch_debited}`.
  Producer: S1/S3 (spawn). Consumer: S4 (classify + reattach), S3 (budget).
- `function _emit_for_codex_event` (function, S1) — codex JSONL record → `ConnectorEvent|None`. Producer:
  S1. Consumer: S1 pipe-read + file-tail.
- `const T2F5_DONE_SENTINEL = "__t2f5_done__"` (const, S1) — durable completion key. Producer: wrapper
  (S1). Consumer: S1 tailer, S4 reattach reader.
- `class ReattachReader` (class, S4) — owns one `reparenting` task's tail-to-completion. Producer: S4
  driver. Consumer: `stratum_parallel_poll`/`stratum_resume` (S5).
- `function classify_interrupted_parallel_tasks` (function, S4) — the split-out classify half of
  `resume_interrupted_parallel_tasks`. Producer: S4. Consumer: server startup call (`server.py:3990`;
  `:3986` is the import).

## Implementation slices (ordered)

### S1 — codex durable-stream mode  (`connectors/codex.py`)
1. **Extract emitter (stateless map; state stays in caller — review #3):** factor the per-event
   *mapping* (`codex.py:494-566`) into `_emit_for_codex_event(event, *, model, prompt) ->
   Iterable[ConnectorEvent]`. The **caller loops** keep their state: `agent_started_yielded` dedup
   (`:494`), `text_parts` accumulation (`:512`), and the failure decision. Live pipe mode keeps
   raise-immediately on `type=="error"` (`:565`); **durable mode records the first error and fails
   after the sentinel** (intentional, design round-4 — not a pure extract). Existing codex tests
   regression-guard the live path.
2. **Handle handoff — `durable_spawned` first event (review #2):** in durable mode, immediately after
   `create_subprocess_exec` returns (before the read loop), `yield ConnectorEvent(kind="durable_spawned",
   metadata={child_pid, stream_path, stderr_path, proc_start_time})`. This is the seam that gets the
   handle to the executor (S3) before any codex output, so a crash right after spawn is still
   reparentable.
3. **Durable spawn (gated on `stream_path`):** in `stream_events()` before the spawn (`:434`), when
   `self._stream_path` is set, build:
   `["sh","-c", _T2F5_WRAPPER, "sh", *self._build_codex_cmd(args, clean_env)]`, `start_new_session=True`,
   `env={**clean_env, T2F5_OUT/ERR/IN}`, `stdin/stdout/stderr=DEVNULL`; write `actual_prompt` to the IN
   file (replaces the stdin-pipe write at `:451-453`). `_T2F5_WRAPPER` = the §2 `'"$@" >…<…; printf …'`
   script. Non-durable path (`stream_path is None`) stays the verbatim PIPE spawn (`:434-453`).
4. **File tailer:** `_tail_stream(out_path, start_offset)` async-generates complete JSONL lines
   (partial-trailing-line safe), feeding `_emit_for_codex_event`; stops at the `T2F5_DONE_SENTINEL`
   record. Used by live durable mode here AND by `ReattachReader` (S4) — one reader.
5. **Completion (durable):** after the sentinel — live mode `await proc.wait()`, assert rc == sentinel
   rc; `type=="error"` event recorded → fail with its message; `rc!=0 && no result` → fail from the
   `$T2F5_ERR` file (parity with `:569-573`). Re-attach path (S4) uses sentinel-rc + error-event +
   `$T2F5_ERR`, no `proc.wait()`.
6. **finally (`:580-587`):** gate `await self._cleanup_jail(proc)` on `not self._durable` (durable mode
   only closes file handles; the detached child outlives the connector). Kill stays available via
   `interrupt()`.
7. **interrupt (`:589`):** durable branch → `os.killpg(os.getpgid(self._proc.pid), SIGTERM)` (the
   `self._proc` is the wrapper = session leader).
8. **Ctor:** `CodexConnector.__init__` gains `stream_path/stderr_path` (None → today). `make_agent_connector`
   (`connectors/factory.py`) threads them.

### S2 — handle fields  (`executor.py:916` `ParallelTaskState`)
Append Optional fields (defaults → JSON round-trip + back-compat):
`child_pid:int|None=None, stream_path/stderr_path:str|None=None, proc_start_time:str|None=None,
stream_offset:int=0, reparentable:bool=False, dispatch_debited:bool=False`.

### S3 — executor wiring  (`parallel_exec.py`, `_run_one` at `:737`)
1. **Durable connector creation:** at the connector build (`:813-818`, `make_agent_connector`), when the
   task is codex + server-dispatch, compute `stream_path = <flow streams dir>/<task_id>.jsonl` and pass
   it to the connector ctor.
2. **Handle handoff (review #2):** `_consume_streaming` (`:652`) handles the new `durable_spawned` event
   (S1.2) — stamp `ts.child_pid/stream_path/stderr_path/proc_start_time` + `reparentable=True` and
   **persist immediately** (under the lock), so a crash between spawn and first codex output is still
   reparentable. (Not "after spawn in `_run_one`" — `_run_one` never sees the spawn directly.)
3. **Budget idempotency:** the finally debit (`:959-966`) only fires when `not ts.dispatch_debited`;
   set `ts.dispatch_debited=True` there. Re-attach (S4) debits delta tokens, never the dispatch.
4. **Detach-don't-kill — bypass the WHOLE finalizer (review #1):** `shutdown_all` sets a new
   `self._detaching=True` (S6). In `_run_one`, when `ts.reparentable and self._detaching`, the
   destructive path must be skipped at **both** seams:
   - inner cancel (`:860-866`) and outer `except CancelledError` (`:924-935`): do NOT `interrupt()`, do
     NOT set `ts.state="cancelled"`.
   - `finally` (`:936-1018`): do NOT terminalize running→failed (`:937-942`), do NOT mark
     `_task_terminal_state`/fire `_task_done` as failed (`:948-949` — on shutdown the loop is tearing
     down so leaving the event unset is fine), do NOT debit (`:959-966`), do NOT `remove_worktree`
     (`:1006` — the child still uses the cwd). DO persist the handle and leave `ts.state="running"`.
   Non-reparentable, and genuine cascade/budget cancels (`_detaching` false), keep today's full path.

### S4 — classify + reattach runtime  (`parallel_exec.py`, `server.py`)
1. **Split `resume_interrupted_parallel_tasks` (`parallel_exec.py:1039`)** into
   `classify_interrupted_parallel_tasks`: `running` + `reparentable` + pid alive (`os.kill(pid,0)`) +
   `proc_start_time` matches → set `reparenting`; else today's `running→failed`
   (`RESUME_INTERRUPTED_ERROR`). Identity helpers `_proc_start_time(pid)` (darwin `ps`/Linux `/proc`)
   from the spike.
2. **`ReattachReader` + `_REATTACH_READERS` registry (new, `server.py`):** per `(flow_id,task_id)`,
   single-flight (per-task lock). Binds canonical `_flows[flow_id]`; tails `stream_path` from
   `stream_offset` via S1's `_tail_stream`; applies cert + delta-budget; `reparenting→complete|failed`;
   removes worktree; persists under `_lock_for(flow_id)` (`parallel_exec.py:70`).
3. **Driver:** `stratum_parallel_poll` (`server.py:1330`) + `stratum_resume` (`:373`) — before draining,
   if the flow has `reparenting` tasks, lazily start their readers (single-flight), then report status.

### S5 — surfaces  (`server.py`, `parallel_exec.py`, `executor.py`)
- `reparenting` = non-terminal, already-dispatched at: `stratum_parallel_start` reject (`server.py:1260`),
  poll summary + `all_terminal` (in `stratum_parallel_poll`, `:1330`), **`stratum_parallel_advance`
  terminal set (`:1497`, the `tasks_not_terminal` gate at `:1562` — review #4)**, both
  `ParallelTaskState→task_results` serializers, `_item_counts` (`parallel_exec.py:520`),
  `_require_unsatisfiable` (`:554`).
- `get_current_step_info`/`stratum_resume`: a parallel/pipeline step with `running`/`reparenting` tasks →
  poll-not-dispatch.
- `delete_persisted_flow` (`executor.py:1312`): rm the flow `streams/` dir; per-task terminal removes its
  own stream/stderr files.

### S6 — shutdown  (`parallel_exec.py:1095` `shutdown_all`, `server.py:629` registries)
- `shutdown_all` sets `executor._detaching=True` (consumed by S3.4) before cancelling, so reparentable
  children survive (it cancels the executor reader tasks, not the children).
- **Reattach-reader ownership (review #5 — decided):** add a `shutdown_readers(_REATTACH_READERS)`
  helper and call it from the server shutdown path right after `shutdown_all(_RUNNING_EXECUTORS)`
  (`server.py:3990`-region shutdown hook); it cancels each reader task (best-effort, swallow). Readers
  only *read*-and-persist-incrementally, so a cancel loses at most the un-persisted tail, recovered on
  the next boot's re-attach (their `stream_offset` is persisted). A test asserts readers are cancelled
  and children survive.
- Test: a reparentable child is alive after `shutdown_all`; a reader is cancelled.

## Test plan (TDD order)
1. S1 connector: durable spawn writes sentinel (rc=0/≠0); tailer parses; `type=="error"` → fail; partial
   line; non-durable byte-identical; jailed-codex durable; killpg interrupt; finally-no-kill.
2. S2/S3: handle round-trips; budget one-dispatch across a simulated re-attach; cancel leaves running.
3. S4: classify (3 cases); single-flight reader; reattach complete + failed; pid-reuse.
4. S5: `reparenting` non-terminal everywhere; poll-not-dispatch; start-reject; cleanup.
5. S6: child survives `shutdown_all`.
6. Full combined suite green.

## Verification Table (Phase 5 — every anchor read on disk this session)

| Anchor | Claim | Verdict |
|---|---|---|
| `codex.py:434-453` | durable spawn site; PIPE + stdin write | ✅ verified |
| `codex.py:470-566` | JSONL parse loop to extract | ✅ verified |
| `codex.py:565-566` | `type=="error"` raises | ✅ verified |
| `codex.py:568-573` | `proc.wait()` + rc≠0/no-result error from stderr | ✅ verified |
| `codex.py:580-587` | `finally`→`_cleanup_jail(proc)` kill | ✅ verified |
| `codex.py:589-599` | `interrupt()` SIGTERM `self._proc` | ✅ verified |
| `codex.py:164` `_build_codex_cmd` | returns final (jail-wrapped) argv | ✅ verified (round-2/3 gate) |
| `claude.py:114` | in-process `query()`, no child | ✅ verified |
| `connectors/factory.py` | builds claude/codex only | ✅ verified (round-1 gate) |
| `parallel_exec.py:67` | `_connector_type_from_agent` rejects opencode | ✅ verified (round-1 gate) |
| `parallel_exec.py:70` | `_lock_for` per-flow lock | ✅ re-verified (was cited 515) |
| `parallel_exec.py:515` | `_persist` | ✅ re-verified |
| `parallel_exec.py:520` | `_item_counts` | ✅ re-verified (was cited 395) |
| `parallel_exec.py:554` | `_require_unsatisfiable` | ✅ re-verified (was cited 422) |
| `parallel_exec.py:737` | `_run_one` | ✅ re-verified |
| `parallel_exec.py:813-818` | connector creation in `_run_one` | ✅ re-verified (was cited 675-681) |
| `parallel_exec.py:860-866` | inner `except CancelledError` (interrupt) | ✅ re-verified (was cited 765-776) |
| `parallel_exec.py:924-935` | outer `except CancelledError` | ✅ re-verified |
| `parallel_exec.py:936-1018` | `finally`: terminalize/done-event/debit/worktree/persist | ✅ re-verified |
| `parallel_exec.py:959-966` | budget debit on `started_at` | ✅ re-verified (was cited 800-803) |
| `parallel_exec.py:1039` | `resume_interrupted_parallel_tasks` classify | ✅ verified |
| `parallel_exec.py:1095` | `shutdown_all` | ✅ verified |
| `executor.py:916-943` | `ParallelTaskState` dataclass | ✅ verified |
| `executor.py:1312` | `delete_persisted_flow` | ✅ verified (round-1 gate) |
| `server.py:373` | `stratum_resume` position-restore | ✅ verified |
| `server.py:629` | `_RUNNING_EXECUTORS` registry | ✅ re-verified |
| `server.py:1260` | `stratum_parallel_start` re-start reject | ✅ re-verified |
| `server.py:1330` | `stratum_parallel_poll` (summary/all_terminal) | ✅ re-verified |
| `server.py:1497`/`:1562` | `stratum_parallel_advance` `tasks_not_terminal` (review #4) | ✅ re-verified |
| serializers `ParallelTaskState→task_results` | the two -ROUTE serializer sites | ✅ verified (-ROUTE) |
| `server.py:3990` | startup resume hook **call** (`:3986` = the import) | ✅ re-verified |

*All paths are under `stratum-mcp/src/stratum_mcp/` (the MCP package) — NOT the sibling
`src/stratum/` library, which has its own `executor.py`.*

**Stale line numbers corrected (blueprint-review #6 — my own FANOUT merge shifted `parallel_exec.py`
~150 lines after I first read it). Zero remaining stale entries. Zero Boundary Map violations.** Ready
for Phase 6 (plan) / Phase 7 (TDD).
