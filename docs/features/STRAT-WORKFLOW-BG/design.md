# STRAT-WORKFLOW-BG — Design (server-driven background flow execution)

**Status:** Phase 1 design (2026-05-31), **rev 2** — Codex design-gate addressed (4 design-actionable findings folded in: envelope→result adapter + validation-parity caveat §3; BG-ownership rule for consumer parallel tools §3; split cancel-vs-shutdown semantics §5; terminal-snapshot persistence + explicit restart-reattach §4). Not yet implemented.
**Owner repo:** stratum · **Package:** `stratum-mcp`.
**Track:** STRAT-WORKFLOW epic, ticket 6 of 6 (last in the epic; `-NAMING`/`-IMPERATIVE`/`-PIPELINE*`/`-BUDGET*`/`-RESUME` shipped). The sibling `-PIPELINE-FANOUT-DYNAMIC` is deferred to the TS port (mid-run task injection — architecturally awkward in Python asyncio).
**Related:** [[project_strat_workflow_epic]], [[feedback_ship_narrow_first]], [[feedback_verify_isolation_primitives]], [[project_strat_workflow_resume]].

## Problem

Today a Stratum flow is **consumer-turn-driven**: the consumer (Claude Code) calls `stratum_plan`, receives one step, runs it, calls `stratum_step_done`, receives the next, and so on. The consumer's session is occupied for the whole flow — every step is a round-trip through the consumer's context. A single `parallel_dispatch`/`pipeline` step already runs server-side async (the consumer polls), but the **overall flow** never advances on its own.

Dynamic-workflow runners elsewhere run the entire multi-phase script in the background, leaving the session free. Stratum — the governed, cross-model answer ([[project_strat_workflow_epic]]) — should offer the same: a **server-driven flow-execution mode** that advances autonomously through steps, dispatching each step's agent itself, surfacing progress via the existing stream/poll channel, and **pausing only at real gates** (human decisions).

Verified against the source (2026-05-31):

- **Advancement is exclusively consumer-driven.** `stratum_plan` (`server.py:332`) returns the first step; `stratum_step_done` (`server.py:441`) validates a reported result via `process_step_result` (`executor.py:1915`), advances `current_idx`, returns the next. `get_current_step_info` (`executor.py:1640`) returns one step at a time. There is **no** server-initiated advance loop anywhere.
- **The server CAN dispatch an agent itself.** `stratum_agent_run` (`server.py:146`) builds a connector (`_make_agent_connector`, claude/codex), runs a prompt with an optional `schema` for structured JSON output, streams events via `ctx.report_progress`, accumulates budget, and returns `{text, result?}`. This is the per-step dispatch primitive a BG loop reuses.
- **A background-task pattern already exists.** `stratum_parallel_start` (`server.py:1272`) creates an `asyncio` task (`asyncio.create_task(executor.run())`), registers it in `_RUNNING_EXECUTORS`/`_PARALLEL_EXECUTORS` (`server.py:661/666`), and the consumer polls via `stratum_parallel_poll`. Shutdown drains these (`_parallel_shutdown_all`, `server.py:4112`).
- **Gates already pause.** `get_current_step_info` returns `{"status": "await_gate", ...}` for a gate step (`executor.py` gate branch); `_apply_policy_loop` (`server.py:74`) auto-resolves chained flag/skip gates but only inside a consumer call. `stratum_gate_resolve` resolves a real gate.

So everything BG needs already exists as primitives; what's missing is the **driver loop** that chains them server-side.

## Design

### 1. Scope (ship-narrow)

v1 adds a **server-driven advance loop** for an existing flow, opt-in per run.

> **v1 cut (2026-05-31):** `parallel_dispatch`/`pipeline` integration and mid-parallel **restart-reattach** are **deferred to a follow-up** (`STRAT-WORKFLOW-BG-PARALLEL`). They carry the design's riskiest surface — the dual-driver race across `stratum_parallel_poll`/`_advance`/`_start` (design-gate finding 2) and the explicit `_ensure_reattach_readers` recovery (finding 4). v1 therefore **hands off** at a `parallel_dispatch`/`pipeline` step (same `status: bg_handoff` as judge/flow), keeping the blast radius to a linear-step driver. The parallel design below (§3 `_bg_run_parallel`, §4 reattach) is retained as **designed-but-deferred** for that follow-up. This keeps v1 reviewable and lands the core value (autonomous linear advance, session free) first. [[feedback_ship_narrow_first]]

**The loop autonomously handles (v1):**
- `function` and `inline` steps — dispatched server-side via the connector path (reusing `stratum_agent_run`'s machinery), with the step's `output_schema`/contract requested as structured output, then fed to `process_step_result`.
- `complete` — finish, clean up, persist a terminal snapshot.

**Designed but deferred to `STRAT-WORKFLOW-BG-PARALLEL`:**
- `parallel_dispatch` / `pipeline` steps — run via the existing `ParallelExecutor`, awaited to terminal, collected via `_advance_after_parallel`; plus the BG-ownership guard on the parallel tools and mid-parallel restart-reattach. v1 hands these off instead.

**The loop pauses (hands back to the consumer), NOT a failure:**
- `await_gate` — a real human decision. The loop stops with `status: bg_paused_gate`; the consumer resolves via `stratum_gate_resolve` and re-arms the loop with `stratum_flow_run_bg` (idempotent resume from `current_idx`).
- `judge`, `flow` (`flow_ref`), and (v1) `parallel_dispatch`/`pipeline` steps — the loop stops with `status: bg_handoff` naming the step kind; the consumer runs that step the normal way and may re-arm. v1 does **not** silently mis-execute them. `judge`/`flow` → `STRAT-WORKFLOW-BG-NESTED`; parallel/pipeline → `STRAT-WORKFLOW-BG-PARALLEL`. [[feedback_ship_narrow_first]]

**The loop halts (terminal):**
- `budget_exhausted` — surfaced via the existing budget machinery (a server-dispatched step debits; exhaustion sets `terminal_status`).
- `error` — a step that exhausts retries / fails schema; the loop stops with the failure, leaving the flow resumable.
- `cancelled` — explicit cancel (see §5).

**Default off.** A flow runs consumer-driven exactly as today unless BG is explicitly started. No IR/schema change — BG is a **runtime mode**, not a language feature.

### 2. Entry & surface

- **`stratum_flow_run_bg(flow_id)`** — new MCP tool. Preconditions: the flow exists (in `_flows` or restorable), is not terminal, and no BG loop is already running for it. Creates `asyncio.create_task(_background_flow_advance(flow_id))`, registers it in a new `_BG_FLOWS: dict[str, asyncio.Task]` registry (mirroring `_RUNNING_EXECUTORS`), and returns immediately with `{status: "bg_started", flow_id, step_count}`. The consumer's session is now free.
- **Progress** reuses the existing channels: each dispatched step streams events through `ctx.report_progress` (same envelope as `stratum_agent_run`), and the flow state is persisted after every step so `stratum_audit` / a poll reflects live progress.
- **`stratum_flow_bg_poll(flow_id)`** — new MCP tool (thin): returns `{status, current_step, steps_completed, total_steps, terminal_status?, paused_reason?}` from the persisted/in-memory state. `status ∈ {running, paused_gate, handoff, complete, error, budget_exhausted, cancelled, not_found}`. (Reuses `_build_audit_snapshot` internally where possible.)
- A BG-paused/handed-off flow re-enters consumer-driven mode transparently: the consumer calls `stratum_gate_resolve` (gate) or `stratum_step_done` (handoff step it ran itself), then optionally `stratum_flow_run_bg` again to resume autonomous advance.

### 3. The loop (`_background_flow_advance`)

```
async def _background_flow_advance(flow_id):
    state = _flows[flow_id]
    state.flow_mode = "server_driven"          # for audit/poll
    while True:
        if cancelled(state):        -> persist; return        # §5
        if budget_exhausted(state): -> mark terminal; persist; return
        info = get_current_step_info(state)     # may skip/auto-gate (policy loop)
        info = _apply_policy_loop(state, info)
        if info is None or info.status == "complete":
            finalize(state); return
        kind = classify(info, state)
        if kind == "gate":          -> state.bg_pause = "gate"; persist; return
        if kind in ("judge","flow"):-> state.bg_pause = f"handoff:{kind}"; persist; return
        if kind in ("function","inline"):
            result = await _bg_dispatch_step(state, info)        # connector, schema
            status, violations = process_step_result(state, info.step_id, result)
            if status not in ("ok", ...advance...):
                state.bg_error = {...}; persist; return          # retries handled inside
        elif kind in ("parallel_dispatch","pipeline"):
            await _bg_run_parallel(state, info)                  # reuse ParallelExecutor
            # advance via the same internals stratum_parallel_advance uses
        persist_flow(state)
    # registry cleanup in finally
```

- **`_bg_dispatch_step`** factors the connector-dispatch core out of `stratum_agent_run` (prompt = intent + resolved inputs; `schema` = the step's output contract → structured JSON `result`). Budget is debited on the same path that already debits (`correlation_id == flow_id`).
  - **Envelope→result adapter (design-gate finding 1).** `stratum_agent_run` returns a *transport envelope* (`{text, result?, parseError?}`, `server.py:295`), **not** a plain validated step dict. `_bg_dispatch_step` must extract `result` (the schema-parsed dict) and treat a `parseError` or a non-dict / missing `result` as a **dispatch failure**, routed through `process_step_result`'s retry path (consume a retry, re-dispatch; on cap → `error`, halt resumable) — never fabricate a dict. The extracted dict is then validated by `process_step_result` exactly as a consumer-reported result would be.
  - **Validation-parity caveat (design-gate finding 1).** `process_step_result` enforces `output_schema` **only for `function` steps** (`executor.py:1939`); for `inline` it forces `output_schema = None` (`executor.py:1946`), so only guardrails + `step_ensure` gate an inline result. v1 therefore claims structural-validation parity for **function** steps only; an inline step's structured output is requested from the connector but accepted under the same (looser) inline contract a consumer-reported inline result gets — no new gap introduced, but no new guarantee claimed either.
- **Retries** are already inside `process_step_result` (it returns `ensure_failed` with retries remaining); the loop re-dispatches the same step on a retryable failure up to the function's retry cap, then stops on `retries_exhausted`.
- **`_bg_run_parallel`** reuses `stratum_parallel_start`'s executor construction + `_RUNNING_EXECUTORS` registration, awaits the handle, then runs the same terminal-collection/advance internals (`_advance_after_parallel`) the poll path runs — no second engine.
  - **BG-ownership rule (design-gate finding 2).** The per-flow lock in `parallel_exec.py:74` serializes *persistence*, not in-memory `FlowState` mutation — so a consumer `stratum_parallel_poll`/`_advance`/`parallel_start` racing the BG driver on the same step is a real correctness hazard (poll itself advances + pops the executor registries, `server.py:1507/1535`). **Rule:** while a flow is BG-owned (`flow_id in _BG_FLOWS` with a live task), the consumer-facing `stratum_parallel_poll` / `stratum_parallel_advance` / `stratum_parallel_start` and `stratum_step_done` **refuse with `status: bg_owned`** for that flow. Exactly one driver mutates a flow at a time. The guard releases when the BG task terminates (loop `finally` pops `_BG_FLOWS`).

### 4. Persistence & restart

- The flow state is persisted after **every** step (already the consumer-driven contract via `persist_flow`), so a BG flow interrupted by a server restart is recoverable to its last completed step.
- **Terminal snapshot for durable poll (design-gate finding 4).** The consumer-driven completion / budget-hard-stop helpers **delete** persisted state (`delete_persisted_flow`, `server.py:1181/3788`), so a completed flow's poll would 404. BG **diverges deliberately**: `finalize(state)` persists a **terminal snapshot** (`terminal_status ∈ {complete, error, budget_exhausted, cancelled}`) and does **not** delete it, so `stratum_flow_bg_poll` stays durable after completion. A separate GC (age-based, reusing the cache-eviction pattern) reaps old terminal BG snapshots so they don't accumulate.
- **Restart reattach for mid-parallel BG (design-gate finding 4).** Restart reattachment of live codex children is driven by `_ensure_reattach_readers`, invoked from `stratum_resume`/`stratum_parallel_poll` (`server.py:401/1467`) — **not** from `ParallelExecutor`. A re-armed BG loop that finds the current step mid-parallel must **explicitly run the reattach path** (`_ensure_reattach_readers` + await readers) before awaiting advance internals; otherwise mid-parallel restart recovery stalls. v1's re-arm entry (`stratum_flow_run_bg` on a flow whose current step is a live/`reparenting` parallel step) calls the same reattach the `stratum_resume` path already calls.
- A BG loop does **not** auto-resume on restart in v1 (the `asyncio.Task` is gone). On restart the flow is in a normal persisted state at `current_idx`; the consumer re-arms it with `stratum_flow_run_bg(flow_id)` (or continues consumer-driven). Auto-restart of the BG driver is a named follow-up (`STRAT-WORKFLOW-BG-RESUME`). Composes with `T2-F5-RESUME` per the reattach path above.

### 5. Cancel, budget, concurrency guards

- **Cancel vs shutdown are different (design-gate finding 3).** The existing shutdown is best-effort `task.cancel()` on executor handles/readers (`parallel_exec.py:1442`); the only existing cancel tool is for ad-hoc `stratum_agent_run`, not flows (`server.py:313`). BG needs **two distinct semantics:**
  - **Explicit cancel** — new `stratum_flow_cancel_bg(flow_id)`: cancels the `_BG_FLOWS` task, drains any in-flight parallel executor via the existing cascade, and **marks the flow `terminal_status = cancelled`** (persisted terminal snapshot). Intentional, terminal.
  - **Shutdown drain** — extend the shutdown path to cancel `_BG_FLOWS` tasks but **persist a resumable in-progress snapshot and exit WITHOUT terminalizing** (the flow stays at `current_idx`, re-armable next session). Confusing the two would destroy the resumability story — a server restart must not look like a user cancel. The loop's `finally` distinguishes them via a `_shutting_down` flag (set by the shutdown handler before cancelling), mirroring T2-F5's `executor._detaching` detach-don't-kill pattern.
- **Budget:** unchanged — every server-dispatched step (BG single-step + parallel tasks) debits `FlowState.budget_state` via the existing path; exhaustion → `terminal_status = budget_exhausted` + the loop stops. BG makes the budget *more* useful: a runaway autonomous flow is hard-capped.
- **Single-runner guard:** `stratum_flow_run_bg` refuses if `(flow_id) in _BG_FLOWS` with a live task, or if a parallel step for the flow is already live in `_RUNNING_EXECUTORS` (the existing last-writer-wins hazard, [[project_compose_idempotency_gaps]]). One driver per flow.

### 6. Governance & auditability (this is Stratum)

- **Every BG-dispatched step is a normal `StepRecord`** in the trace — `stratum_audit` shows the same records a consumer-driven run would, plus `flow_mode: "server_driven"` on the snapshot so it's clear the server drove it. No step is invisible.
- **Gates are never auto-approved by BG.** The loop pauses at a real gate (`policy: gate`); only the existing flag/skip policies (already author-declared) auto-resolve, exactly as in consumer-driven mode. BG does not weaken the gate contract. [[feedback_verify_isolation_primitives]]
- **A handoff is explicit**, never a silent skip: judge/flow steps stop the loop with a typed reason.

## Acceptance criteria

- [ ] **Opt-in, default-off:** a flow not started with `stratum_flow_run_bg` behaves byte-identically to today (consumer-driven). No IR/schema change.
- [ ] **Autonomous linear advance:** a flow of N `function`/`inline` steps, started with `stratum_flow_run_bg`, runs to `complete` with **zero** consumer `stratum_step_done` calls; the trace shows N `StepRecord`s and `flow_mode: server_driven`.
- [ ] **Server-side dispatch parity:** a BG-dispatched step's result goes through the same `process_step_result` (schema + guardrails + ensure + retries); a step whose ensure fails is retried up to the cap, then halts the loop with `error` (flow remains resumable).
- [ ] **Gate pause/resume:** the loop stops at a gate with `status: paused_gate`; after `stratum_gate_resolve`, re-arming with `stratum_flow_run_bg` continues autonomously.
- [ ] **Handoff (not mis-execution):** a BG flow reaching a `judge`/`flow`/`parallel_dispatch`/`pipeline` step stops with `status: handoff` naming the kind; it never silently runs them wrong. (Parallel/pipeline autonomous execution is the `STRAT-WORKFLOW-BG-PARALLEL` follow-up.)
- [ ] **Budget halt:** a BG flow with a run budget halts at `budget_exhausted` mid-stream; `terminal_status` set, partial trace intact.
- [ ] **Cancel:** `stratum_flow_cancel_bg` stops a running BG loop promptly, draining any in-flight parallel executor; state left resumable/terminal as appropriate.
- [ ] **Single-runner guard:** a second `stratum_flow_run_bg` for a live BG flow is refused (no double-drive).
- [ ] **BG-ownership guard:** while a flow is BG-owned, consumer `stratum_parallel_poll`/`_advance`/`parallel_start`/`step_done` for that flow return `status: bg_owned` (no dual-driver race); the guard releases when the BG task terminates.
- [ ] **Dispatch adapter:** a connector `parseError` / non-dict / missing `result` is routed through the retry path (never fabricated), and on retry-cap halts `error` resumable.
- [ ] **Cancel vs shutdown distinct:** explicit `stratum_flow_cancel_bg` → `terminal_status: cancelled` (terminal snapshot); a shutdown drain persists a **resumable** in-progress snapshot and does NOT terminalize (verified the flow re-arms next session).
- [ ] **Durable terminal poll:** after a BG flow completes, `stratum_flow_bg_poll` still returns `complete` (terminal snapshot not deleted), unlike consumer-driven delete-on-complete.
- [ ] **Poll surface:** `stratum_flow_bg_poll` reports running/paused/complete/error/budget/cancelled accurately against state.
- [ ] **Persistence:** state persisted after each step; an interrupted BG flow is resumable to its last completed step (re-armed by the consumer).
- [ ] **Shutdown drain:** server shutdown cancels live BG loops cleanly (no orphaned tasks).
- [ ] Full combined suite green; CHANGELOG + report; stratum ROADMAP row; Codex design gate + impl review → REVIEW CLEAN.

## Out of scope (named follow-ups)

- **BG over `judge`/`flow` (nested-flow) steps** (`STRAT-WORKFLOW-BG-NESTED`) — v1 hands these back. Judge loops are caller-driven dispatch; nested flows spawn child FlowStates — both need their own BG integration.
- **Auto-restart of the BG driver after a server restart** (`STRAT-WORKFLOW-BG-RESUME`) — v1 requires the consumer to re-arm. Pairs with `T2-F5-RESUME`'s reparenting.
- **Unbounded dynamic fan-out** (`STRAT-WORKFLOW-PIPELINE-FANOUT-DYNAMIC`) — deferred to the TS port; orthogonal to BG.
- **Multi-flow scheduler / concurrency across flows** — v1 is one driver per flow, started on demand; a server-wide scheduler is a separate concern.
