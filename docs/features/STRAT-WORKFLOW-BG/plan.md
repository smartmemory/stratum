# STRAT-WORKFLOW-BG — Implementation Plan (v1 linear driver)

**Source:** `design.md` (rev 2), `blueprint.md` (verified). TDD per slice; full `stratum-mcp/tests/` stays green.

## S1 — FlowState BG fields + persist/restore
- `executor.py`: add `flow_mode: str = "consumer_turn"`, `bg_status: str | None = None`, `bg_pause_reason: str | None = None` to `FlowState` (after `budget_state`). Add to `persist_flow` payload + `restore_flow` reconstruction (`.get` defaults).
- [ ] Fields default correctly; round-trip through persist→restore; old persisted JSON (no keys) restores as `consumer_turn`/None.

## S2 — `_bg_dispatch_step` + output-schema builder
- `server.py`: `_bg_output_schema(info)` builds a JSON schema `{type:object, properties:{field:{type}}, required:[...]}` from the dispatch dict's `output_fields`. `_bg_dispatch_step(state, info, ctx)` builds prompt (`intent`) + context (resolved `inputs`) + schema, calls `stratum_agent_run(...)`, extracts `result`; `parseError`/missing/non-dict → `(_BG_DISPATCH_BAD, env)` sentinel.
- [ ] Good envelope → result dict returned. parseError → bad sentinel. Non-dict result → bad sentinel. budget_exhausted envelope → propagated. (Tests monkeypatch `server.stratum_agent_run`.)

## S3 — `_background_flow_advance` loop + finalize + `_BG_FLOWS`
- `server.py`: `_BG_FLOWS`, `_BG_SHUTTING_DOWN`; `_bg_classify(info)`; `_bg_finalize(state, status)`; the loop (dispatch function/inline, `process_step_result`, advance/retry, gate→pause, judge/flow/parallel/pipeline→handoff, complete→finalize, budget/cancel checks). `finally` pops `_BG_FLOWS`.
- [ ] Linear 3-step function flow runs to `complete` (0 consumer step_done); records present; `flow_mode=server_driven`. Retryable ensure-fail re-dispatches then halts `error` at cap. Gate → `paused_gate`. parallel/pipeline → `handoff:<mode>`. Terminal snapshot persisted (not deleted).

## S4 — tools + ownership guard
- `server.py`: `stratum_flow_run_bg` (single-runner guard), `stratum_flow_bg_poll`, `stratum_flow_cancel_bg`; `stratum_step_done` top guard → `bg_owned` when a live `_BG_FLOWS` task owns the flow.
- [ ] run_bg starts a driver + returns `bg_started`; second run_bg on a live flow → refused. poll reports running/complete/paused/handoff/cancelled. cancel_bg → `cancelled` terminal. step_done during BG → `bg_owned`.

## S5 — shutdown drain vs explicit cancel
- `server.py`: shutdown `finally` sets `_BG_SHUTTING_DOWN=True`, cancels `_BG_FLOWS` with await-timeout; loop `finally` leaves a **resumable** snapshot on drain (no terminalize), vs explicit cancel → `terminal_status=cancelled`.
- [ ] A drained flow is re-armable (current_idx intact, no terminal_status); an explicitly cancelled flow is terminal.

## S6 — golden e2e + full suite
- `test_workflow_bg_e2e.py` (new): autonomous linear flow → complete (0 step_done); gate pause → resolve → re-arm → complete; handoff at a parallel step; budget halt mid-stream; cancel.
- [ ] `pytest stratum-mcp/tests/` full suite green.

## Phase 9/10
- [ ] report.md; CHANGELOG; stratum ROADMAP row COMPLETE; forge-top ROADMAP `-BG` row COMPLETE + `-PIPELINE-FANOUT-DYNAMIC` defer note; commit.
