# STRAT-AGENT-BG — Background agent runs (design + implementation brief)

**Status:** COMPLETE (2026-07-10, see `./report.md`). First shipped slice of the
STRAT-AGENT-VIS umbrella (forge-top ROADMAP row).

## Related Documents
- Forge-top `ROADMAP.md` — STRAT-AGENT-VIS row (umbrella)
- `stratum-mcp/src/stratum_mcp/connectors/codex.py` — T2-F5 durable-stream machinery (reused wholesale)
- Follow-ups filed in the ROADMAP row: STRAT-AGENT-BG-CLAUDE, STRAT-AGENT-BG-BUDGET, STRAT-AGENT-BG-MONITOR, STRAT-JUDGE-BG

## Problem

`stratum_agent_run` is a synchronous MCP tool call: the whole Claude Code
session blocks until the codex/claude child finishes (minutes). MCP has no
async-task support in Claude Code, and MCP progress notifications are not
rendered. Claude Code's harness DOES track background Bash tasks: they are
listed below the statusline, stream output via `TaskOutput`, and re-invoke the
model on exit. The bridge: return immediately from the MCP call, let a tiny
CLI watcher (run via Bash `run_in_background`) tail the run's durable stream
until completion.

All server-side primitives already exist (T2-F5-RESUME): the codex connector's
durable-stream mode spawns a detached child (`start_new_session=True`) under
`_T2F5_WRAPPER` (`codex.py:89`) that owns a JSONL stream file and appends a
completion sentinel `{"__t2f5_done__": <rc>}` (`T2F5_DONE_SENTINEL`,
`codex.py:74`). `_stream_events_durable` (`codex.py:754`) emits a synthetic
`durable_spawned` event FIRST carrying `{child_pid, stream_path, stderr_path,
proc_start_time}` (`codex.py:807-815`), and its `finally` does NOT kill the
detached child.

## Which tools get background mode (decision)

Surveyed all agent-spawning MCP tools:

| Tool | Verdict |
|---|---|
| `stratum_agent_run` | **v1 target** — the only session-blocking direct agent spawner; codex type has detached-child machinery ready |
| `stratum_judge` | follow-up (STRAT-JUDGE-BG) — in-process kernel (T1/T2/T3 loop), needs a generic server-side bg-job registry, not the detached-child path |
| `stratum_goal` / `stratum_goal_decide` / `stratum_decompose` / `stratum_distill` | follow-up — same generic registry; shorter-running, lower pain |
| `stratum_flow_run_bg`, `stratum_parallel_start` | already backgrounded server-side |

v1 scope: `background=True` on `stratum_agent_run`, **codex-only** (the claude
connector is in-process `claude_agent_sdk.query()` — no detached child;
STRAT-AGENT-BG-CLAUDE will add a server-side asyncio task + stream tee, which
is backgroundable but not restart-survivable).

## Locked design

### 1. `stratum_agent_run(background: bool = False)`

New keyword param, default False (existing behavior byte-identical when False).

Fail-loud guards (ValueError, mirror the `write=` guard style at
`server.py:156-167`):
- `background=True` and `connector_base(type) != "codex"` → error naming
  STRAT-AGENT-BG-CLAUDE as the follow-up.
- `background=True` and `correlation_id` resolves to a live flow with
  `budget_state` → error: bg runs cannot debit run budgets yet
  (STRAT-AGENT-BG-BUDGET). Non-budgeted `correlation_id` is allowed and
  recorded in meta for attribution.

Behavior when True:
- `run_id = uuid.uuid4().hex[:12]` (re-roll on the astronomically-unlikely
  existing-dir collision).
- Run registry dir: `~/.stratum/agent_runs/<run_id>/` containing
  `stream.jsonl` (T2F5_OUT; `.in`/`.err` siblings per the durable convention)
  and `meta.json`: `{run_id, type, model_id, cwd, sandbox_mode, write,
  prompt_chars, correlation_id, created_at, child_pid, proc_start_time,
  stream_path, stderr_path}`. Registry root via a module-level helper that
  reads `Path.home()` at call time (same pattern as `_FLOWS_DIR` /
  `flow_streams_dir` in `executor.py:1462-1471`) so tests can point HOME at
  tmp.
- Build the connector exactly as the sync path does
  (`_make_agent_connector`), but with `stream_path=str(<dir>/stream.jsonl)`.
- Consume `connector.stream_events(...)` ONLY until the `durable_spawned`
  event; capture `child_pid`/`proc_start_time`; then `await agen.aclose()` —
  the durable generator's teardown does not kill the detached child
  (documented contract, `codex.py:770-771`). Write meta.json AFTER capturing
  the pid (atomic write: tmp + rename).
- Return immediately:
  `{status: "bg_started", run_id, stream_path, pid, watch_cmd:
  "stratum-mcp watch <run_id>"}`.

### 2. New MCP tool `stratum_agent_poll(run_id: str)`

Read-only, idempotent, restart-proof (reads only the registry dir — works
after an MCP server restart because the child + files are detached/durable).

- Unknown run_id → `{status: "not_found", run_id}`.
- Parse `stream.jsonl` line-by-line (tolerate a partial trailing line — same
  rule as `_tail_stream`). Map records through `_emit_for_codex_event`
  (import from `connectors.codex`) to accumulate assistant text and usage
  (reuse `accumulate_usage` / `new_usage_acc` from the run-budget module the
  sync path uses at `server.py:226`).
- No sentinel yet → check child liveness via the pid + `proc_start_time`
  identity check (`proc_identity.py` — the reparent-safe way; never trust a
  bare pid). Alive → `{status: "running", run_id, text_tail, events_seen,
  stream_path}`. Dead without sentinel → `{status: "error", reason:
  "child_died_without_sentinel", stderr_tail, ...}`.
- Sentinel present → rc==0: `{status: "complete", run_id, text, result,
  usage, exit_code: 0}`; rc!=0: `{status: "error", exit_code, text_tail,
  stderr_tail}`. `result` = parsed final agent message when a `schema` was
  used (same parse the sync path applies), else omitted.
- **Cap every text field** (`text`/`text_tail`/`stderr_tail`) at 20_000 chars
  (tail-truncate with a `[truncated, full stream at <path>]` prefix) — MCP
  tool results must not blow the token cap; the full stream is on disk.

### 3. Cancel: extend `stratum_cancel_agent_run`

Existing tool (`server.py:375`) cancels in-flight sync runs via
`_AGENT_RUN_TASKS[correlation_id]`. Extend: when the id has no live asyncio
task, check the bg registry for `<id>` as run_id; if the run dir exists, no
sentinel, and the pid passes the `proc_identity` check → `os.killpg(pid,
SIGTERM)` (the wrapper is the process-group leader via
`start_new_session=True`; mirror the interrupt path the durable connector
already has). Return `{status: "cancelled", run_id}`; already-terminal →
`{status: "already_complete"|"already_error"}`; unknown → existing not-found
shape.

### 4. CLI: `stratum-mcp watch <run_id> [--json]`

Add to the `main()` dispatch (`server.py:5113-5152`) as `_cmd_watch(argv)` —
synchronous stdlib code, no asyncio, no MCP import cost beyond what server.py
already loads.

- Resolve the registry dir; missing → stderr message, exit 2.
- Tail `stream.jsonl` from offset 0: read-loop with 0.5s sleep, carrying
  partial trailing lines. All prints `flush=True` (line-buffered for Bash
  `run_in_background` / Monitor consumers).
- Default output: one compact human line per meaningful event —
  assistant text lines verbatim, tool/command events as `[tool] <summary>`;
  skip noise kinds. `--json`: raw JSONL passthrough.
- Sentinel → print `run <run_id> finished rc=<rc>` and **exit with rc** (so
  the Bash task's exit code mirrors the agent's).
- Liveness backstop: no sentinel + pid identity check says dead (poll it
  every ~5s, not every tick) → print diagnostic + stderr tail, exit 1.

### 5. Tests (`tests/test_agent_run_bg.py`, mirror `test_codex_durable.py` conventions)

Real child processes via the fake-codex sh-script pattern
(`_fake_codex_argv` / `_patch_codex_cmd`, `test_codex_durable.py:36-54`);
HOME pointed at tmp_path so the registry lands in the sandbox. MUST cover:

1. Golden flow: `background=True` returns `bg_started` with run_id +
   stream file on disk BEFORE the fake child finishes (use a `sleep`-ing fake);
   poll → `running`; after child completes → poll `complete` with text +
   exit_code 0; meta.json has pid + proc_start_time.
2. rc!=0 fake → poll `error` with exit_code + stderr_tail.
3. Guards: `background=True, type="claude"` → ValueError;
   budgeted-flow correlation_id → ValueError; unknown run_id poll →
   not_found.
4. Cancel: long-sleeping fake child; cancel → process group dead; poll →
   terminal (error/child_died or cancelled), never `running`.
5. Watch CLI: pre-written stream file + sentinel → captured stdout has the
   text lines and the exit code equals the sentinel rc; missing run → exit 2.
   (Invoke `_cmd_watch` in-process with capsys, or via subprocess — either,
   but assert exit codes.)
6. Poll text cap: oversized assistant text → tail-truncated with marker.
7. Sync path regression: `background=False` (default) — existing
   `test_agent_run_streaming.py` suite must stay green untouched.

### 6. Docs
- `CHANGELOG.md` `[Unreleased]` entry (same commit).
- Tool descriptions (`@mcp.tool(description=...)`) are the doc surface for
  the new/changed tools — make them precise, including the watch-CLI bridge
  recipe (one sentence: launch bg, then run `stratum-mcp watch <run_id>` via
  Bash run_in_background).
- `_cmd_help()` gains the `watch` line.

## Out of scope (filed as follow-ups)
- STRAT-AGENT-BG-CLAUDE — claude-type background via server-side task + tee.
  **RE-SCOPED (2026-07-11):** the server-side task + tee approach is dead —
  Claude Code now ships a native local background runtime (`claude --bg` +
  `claude agents --json` + `stop`, verified live). If stratum ever needs a
  claude background run, it is a thin adapter over that runtime (+
  `terminate_verified` for cancel), built only when a real consumer exists.
  Decision D2 in `docs/plans/2026-07-11-agent-invocation-strategy.md`.
- STRAT-AGENT-BG-BUDGET — budget debit for bg runs (idempotent
  debit-on-completion-observation).
- STRAT-AGENT-BG-MONITOR — per-event streaming into the session via the
  Monitor tool (`watch --json` is already Monitor-compatible; this ticket is
  the curated `--events` filter + skill/docs recipe).
- STRAT-JUDGE-BG — background judge kernel runs via a generic bg-job registry.
