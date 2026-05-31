# STRAT-WORKFLOW-BG — Implementation Report (v1 linear driver)

**Status:** COMPLETE (2026-05-31). Owner repo: stratum · Package: `stratum-mcp`.
**Source chain:** [design.md](design.md) → [blueprint.md](blueprint.md) → [plan.md](plan.md) → this report.
**Track:** STRAT-WORKFLOW epic, ticket 6 of 6 — closes the epic (only the TS-port-coupled `-PIPELINE-FANOUT-DYNAMIC` remains as a deferred follow-up).

## 1. Summary

Added a **server-driven background flow-execution mode**. A `_background_flow_advance`
loop drives a flow through `function`/`inline` steps autonomously — dispatching
each step's agent itself via `stratum_agent_run` — instead of the consumer
round-tripping every step. It pauses at gates, hands off (never mis-executes) at
judge/flow/parallel/pipeline steps, halts on budget exhaustion or an
unrecoverable error, and finalizes a durable terminal snapshot. The consumer's
session is free after `stratum_flow_run_bg`; progress is polled via
`stratum_flow_bg_poll`.

## 2. Delivered vs Planned

All plan slices S1–S6 delivered.

| Slice | Delivered |
|---|---|
| S1 | `FlowState.flow_mode`/`bg_status`/`bg_pause_reason` + persist/restore round-trip |
| S2 | `_bg_dispatch_step` (envelope→result adapter) + `_bg_output_schema` |
| S3 | `_background_flow_advance` loop + `_bg_finalize` (durable terminal snapshot) + `_BG_FLOWS` |
| S4 | tools `stratum_flow_run_bg`/`_bg_poll`/`_cancel_bg` + `stratum_step_done`/`stratum_resume` `bg_owned` guards |
| S5 | shutdown drain (resumable) vs explicit cancel (terminal), per-flow `_BG_CANCEL_REQUESTED` |
| S6 | golden e2e (15 tests) + full suite green |

## 3. Scope cut (ship-narrow, deliberate)

**v1 hands off at `parallel_dispatch`/`pipeline` steps** rather than driving them.
Autonomous parallel execution + mid-parallel restart-reattach (the design's
riskiest surface — the dual-driver race across the three parallel tools and the
`_ensure_reattach_readers` recovery) are deferred to **`STRAT-WORKFLOW-BG-PARALLEL`**.
v1 also hands off `judge`/`flow` steps (**`STRAT-WORKFLOW-BG-NESTED`**) and does
not auto-restart the driver after a server restart (**`STRAT-WORKFLOW-BG-RESUME`**;
the consumer re-arms). This kept v1 to a reviewable linear-step driver while
landing the core value (autonomous linear advance, session free).

## 4. Key Implementation Decisions

- **Reuse `stratum_agent_run` wholesale.** The loop dispatches each step through
  the existing connector primitive (budget debit, streaming, structured-output
  schema all reused), then feeds the extracted `result` to `process_step_result`
  — the same acceptance machinery (schema/guardrails/ensure/retries) a
  consumer-reported result gets. No second execution engine.
- **Envelope→result adapter.** `stratum_agent_run` returns a transport envelope
  (`{text, result?, parseError?}`), not a step dict. A `parseError`/non-dict
  result is routed through `process_step_result` as `{}`, consuming a real,
  persisted `state.attempts` under the step's retry cap (durable across resume)
  — *not* a separate ad-hoc counter (Codex R1).
- **Exactly one driver mutates a flow.** A live `_BG_FLOWS` task makes
  `stratum_step_done` and `stratum_resume` return `bg_owned`; a second
  `stratum_flow_run_bg` is refused. Closes the dual-driver race the design-gate
  flagged (Codex R1 extended the guard to `stratum_resume`).
- **Cancel vs shutdown are distinct.** Explicit cancel marks the flow in
  `_BG_CANCEL_REQUESTED` *before* `task.cancel()` → terminal `cancelled`; a
  shutdown drain (global `_BG_SHUTTING_DOWN` set before cancel) persists a
  **resumable** in-progress snapshot — a restart must not look like a user
  cancel. The marker is cleared in both the loop's and the tool's `finally` so a
  cancel-vs-finish race can't leave a stale bit for a future run (Codex R1/R2).
- **No unfinalized exits.** Any unexpected exception (e.g. a connector
  `RuntimeError`) is caught and finalized to a durable resumable `error`
  snapshot — never an orphaned `running` flow (Codex R1).
- **Durable poll.** BG `finalize` persists a terminal snapshot instead of
  deleting (unlike consumer-driven delete-on-complete), so `stratum_flow_bg_poll`
  stays accurate after completion.

## 5. Test Coverage

`test_workflow_bg_e2e.py` — 15 tests: BG-field round-trip + legacy default;
autonomous linear advance to complete (0 consumer `step_done`); bad-dispatch →
durable retries → `error`; gate pause; handoff at a parallel step; budget halt;
`run_bg` not-found; poll-complete; `step_done`/`resume` `bg_owned`; explicit
cancel terminal; explicit-cancel-authoritative-under-shutdown-race;
connector-exception → durable error; shutdown-drain resumable.

Full `stratum-mcp/tests/`: **1304 passed, 2 skipped**.

## 6. Files Changed

- `stratum-mcp/src/stratum_mcp/executor.py` — 3 `FlowState` BG fields + persist/restore.
- `stratum-mcp/src/stratum_mcp/server.py` — `_BG_FLOWS`/`_BG_SHUTTING_DOWN`/`_BG_CANCEL_REQUESTED`, `_bg_live`/`_bg_output_schema`/`_bg_dispatch_step`/`_bg_finalize`/`_background_flow_advance`, tools `stratum_flow_run_bg`/`_bg_poll`/`_cancel_bg`, `bg_owned` guards on `stratum_step_done`+`stratum_resume`, shutdown drain in `main()`.
- `stratum-mcp/tests/test_workflow_bg_e2e.py` (new).

## 7. Known Issues & Tech Debt

- Follow-ups: `STRAT-WORKFLOW-BG-PARALLEL` (autonomous parallel/pipeline + restart-reattach), `STRAT-WORKFLOW-BG-NESTED` (judge/flow), `STRAT-WORKFLOW-BG-RESUME` (auto-restart the driver).
- Progress streaming after `run_bg` returns is best-effort: the `ctx` passed to the detached task may be stale (same limitation as `stratum_parallel_start`); the durable channel is the persisted state + `stratum_flow_bg_poll`.
- A `function` step with neither `output_schema` nor `ensure` will accept an empty `{}` result on a bad dispatch (no guard to fail it) — an unusual spec; documented.

## 8. Lessons Learned

- The Codex review loop again caught what tests didn't (3 rounds: unfinalized-exception-exit + non-durable retry + resume-race → cancel-tool race → docs). Server-driven concurrency has many quiet failure modes (unfinalized exits, stale per-flow markers, dual-driver races) that only adversarial review surfaces.
- Cutting parallel/pipeline from v1 was the right call: the design-gate had already flagged it as the riskiest surface, and deferring it kept the review tractable.
