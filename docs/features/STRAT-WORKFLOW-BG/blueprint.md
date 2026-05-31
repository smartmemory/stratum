# STRAT-WORKFLOW-BG — Implementation Blueprint (v1: linear-step driver)

**Status:** Phase 4 blueprint + Phase 5 verification (2026-05-31). Anchors read against disk at the current `main` HEAD. Codex blueprint-gate pending.
**Source design:** `design.md` (rev 2, design-gate findings folded in). **v1 cut:** function/inline/gate/complete only; `parallel_dispatch`/`pipeline` + restart-reattach deferred to `STRAT-WORKFLOW-BG-PARALLEL` (handoff in v1).
**Owner repo:** stratum · **Package:** `stratum-mcp`.

## v1 surface

A server-driven loop that advances a flow through `function`/`inline` steps by dispatching each via the existing `stratum_agent_run` (reused wholesale — no refactor), pausing at gates and handing off at judge/flow/parallel/pipeline steps, persisting a terminal snapshot at the end. Three new tools + one consumer-side ownership guard.

## Integration points (verified against disk)

| # | File:line (verified) | Symbol | Change |
|---|---|---|---|
| A | `executor.py:1038` end of `FlowState` fields (after `budget_state`) | `FlowState` | Add `flow_mode: str = "consumer_turn"`, `bg_status: str \| None = None`, `bg_pause_reason: str \| None = None`. Defaults → back-compat (old persisted flows restore as consumer_turn). |
| B | `executor.py:1382` `persist_flow` payload dict (after `"budget_state"`) | persist | Add the 3 new keys. |
| C | `executor.py` `restore_flow` reconstruction (the `FlowState(...)` ctor / post-assignment block after `:1408`) | restore | Restore the 3 fields with `payload.get(..., default)`. |
| D | **new** `server.py` near the other registries (`_RUNNING_EXECUTORS`, `server.py:661`) | `_BG_FLOWS: dict[str, asyncio.Task]`, `_BG_SHUTTING_DOWN: bool` | One driver task per flow_id; the shutdown flag distinguishes cancel-vs-drain. |
| E | **new** `server.py` `_bg_dispatch_step(state, info, ctx)` | dispatch | Build prompt+`context`+`schema` from the `execute_step` dispatch dict (`intent`, `inputs`, `output_fields`/`output_contract`); `await stratum_agent_run(prompt, ctx, type=info["agent"] or "claude", schema=<json schema from output_fields>, context=<resolved inputs>, correlation_id=state.flow_id, cwd=state.cwd or None)`. Extract `env["result"]`; on `parseError`/missing/non-dict → return a sentinel `(_BG_DISPATCH_BAD, env)` so the loop routes it through the retry path (NOT a fabricated dict). Reuses budget/stream/connector verbatim. |
| F | **new** `server.py` `_background_flow_advance(flow_id, ctx)` | loop | The §3 loop: classify step, dispatch function/inline, `process_step_result`, advance, persist; pause at gate; handoff at judge/flow/parallel/pipeline; finalize on complete; honor cancel + budget. `finally` pops `_BG_FLOWS` and, unless `_BG_SHUTTING_DOWN`, leaves the chosen terminal/paused snapshot persisted (drain leaves a resumable in-progress snapshot). |
| G | **new** `server.py` tool `stratum_flow_run_bg(flow_id, ctx)` | tool | Preconditions: flow in `_flows` or restorable; not terminal; not already in `_BG_FLOWS` (live). Create the driver task, register in `_BG_FLOWS`, return `{status: "bg_started", flow_id, total_steps}`. |
| H | **new** `server.py` tool `stratum_flow_bg_poll(flow_id, ctx)` | tool | Return `{status, flow_id, current_step, steps_completed, total_steps, terminal_status?, paused_reason?}` from in-memory `_flows` or a restored terminal snapshot; `not_found` if neither. Reuses `_build_audit_snapshot` for counts. |
| I | **new** `server.py` tool `stratum_flow_cancel_bg(flow_id, ctx)` | tool | Cancel the `_BG_FLOWS` task (explicit → mark `terminal_status="cancelled"`, `bg_status="cancelled"`, persist terminal snapshot). `not_found` if no live driver. |
| J | `server.py:451` `stratum_step_done` (top, after flow lookup) | guard | If `flow_id` has a live `_BG_FLOWS` task → return `{status: "bg_owned", flow_id, message}` (no dual-driver mutation). Mirror in `stratum_resume`/`stratum_parallel_*` is deferred with the parallel work, but `step_done` is the one consumer entry that races the v1 linear driver. |
| K | `server.py:4106` shutdown `finally` (before/with `_parallel_shutdown_all`) | drain | Set `_BG_SHUTTING_DOWN = True`; cancel every live `_BG_FLOWS` task; await-with-timeout so each loop's `finally` persists a resumable snapshot. Mirrors the `_detaching` set-flag-before-cancel pattern (`server.py:4106`). |
| L | `server.py:1181` `_advance_after_parallel` | reuse | **No change** — not reached in v1 (parallel handed off). Named for the follow-up. |

`finalize(state, status)`: set `state.bg_status=status`, set `state.terminal_status` for `{complete,error,budget_exhausted,cancelled}` (NOT for paused/handoff — those stay resumable), `persist_flow(state)` and **do not** `delete_persisted_flow` (durable poll, design §4). A terminal-snapshot GC (age-based, `STRATUM_BG_SNAPSHOT_MAX_AGE_DAYS`) reuses the `result_cache.evict` sampling pattern.

## Loop classification (exact step kinds)

`get_current_step_info` returns a dict with `status ∈ {execute_step, await_gate, complete}` (+ `step_mode`). Classify:
- `status == "complete"` or `None` → finalize `complete`.
- `status == "await_gate"` → pause `paused_gate` (stop loop, resumable).
- `status == "execute_step"` and `step_mode in {"function","inline"}` → dispatch (E) then `process_step_result`.
- `status == "execute_step"` and `step_mode in {"judge","flow","decompose","parallel_dispatch","pipeline"}` → handoff `handoff:<mode>` (stop, resumable). (`_step_mode`, `executor.py:756`; modes confirmed at `executor.py:1717/1767/1792/1870`.)

`process_step_result` outcome handling mirrors `_advance_after_parallel` (`server.py:1194-1248`): `ok`→continue; `ensure_failed`/`schema_failed`/`guardrail_blocked`→re-dispatch same step (retry remains); `retries_exhausted`/`on_fail_routed`→`error`/continue; check `_flow_budget_hard_stop` after `ok`.

## Boundary Map

- `FlowState.flow_mode` / `bg_status` / `bg_pause_reason` — **type** (str fields, `executor.py:1038`). Producer: BG loop (F). Consumers: `stratum_flow_bg_poll` (H), `_build_audit_snapshot`, persist/restore (B/C).
- `_BG_FLOWS` — **const** (module dict, `server.py` near `:661`). Producer: `stratum_flow_run_bg` (G). Consumers: loop `finally` (F), `stratum_flow_cancel_bg` (I), `stratum_step_done` guard (J), shutdown drain (K).
- `_background_flow_advance` — **function** (`server.py`). Consumes `flow_id`, `ctx`. Produces persisted state transitions.
- `_bg_dispatch_step` — **function** (`server.py`). Consumes the `execute_step` dispatch dict + `ctx`; produces `result` dict or bad-dispatch sentinel. Calls `stratum_agent_run`.
- `stratum_flow_run_bg` / `stratum_flow_bg_poll` / `stratum_flow_cancel_bg` — **function** (MCP tools, `server.py`).

Prose (not Boundary Map): statuses `bg_started`/`bg_owned`/`running`/`paused_gate`/`handoff:<mode>`/`complete`/`error`/`budget_exhausted`/`cancelled`/`not_found`; env `STRATUM_BG_SNAPSHOT_MAX_AGE_DAYS`. Invariant: exactly one driver mutates a flow at a time (single-runner guard G + ownership guard J); a shutdown drain never terminalizes (resumable), an explicit cancel does.

## Verification table (Phase 5)

| Ref | Read? | Matches blueprint? |
|---|---|---|
| `executor.py:1038` `FlowState` last field `budget_state` | ✓ | Append-after point confirmed; all fields have defaults. |
| `executor.py:1349` `persist_flow` explicit-key payload | ✓ | Explicit dict — new fields must be added here (B) AND restore (C). Not asdict. |
| `executor.py:1387` `restore_flow` | ✓ | Reconstructs from payload; `.get(default)` keeps back-compat. |
| `server.py:146` `stratum_agent_run` | ✓ | Returns `{text, result?, parseError?}`; `correlation_id`→budget flow; `schema`→structured `result`. Reusable as-is. |
| `server.py:661/666` `_RUNNING_EXECUTORS`/`_PARALLEL_EXECUTORS` | ✓ | Registry pattern to mirror for `_BG_FLOWS`. |
| `server.py:451` `stratum_step_done` | ✓ | Top-of-function guard insertion point (J). |
| `server.py:1181` `_advance_after_parallel` | ✓ | Outcome handling to mirror in the loop; not called in v1. |
| `server.py:4098-4127` shutdown `finally` | ✓ | `_detaching` set-flag-before-cancel pattern; add `_BG_SHUTTING_DOWN` + `_BG_FLOWS` drain (K). |
| `executor.py:756` `_step_mode` | ✓ | function/inline/judge/flow/decompose/parallel_dispatch/pipeline classification. |

**Zero stale entries.** No Boundary Map violations (all entries name concrete symbols with kinds).
