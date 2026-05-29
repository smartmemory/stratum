# STRAT-WORKFLOW-BUDGET — Implementation Report

**Shipped:** 2026-05-29 (Compose build) · **Repo:** stratum · **Epic:** STRAT-WORKFLOW (2 of 6)
**Docs:** [design.md](./design.md) · [blueprint.md](./blueprint.md)

## 1. Summary

A flow-execution-wide budget ceiling for the MCP server path. A flow may declare a
run budget; every **server-dispatched** agent debits it; when an enforced axis is
exhausted the flow is marked terminal (`budget_exhausted`) and in-flight parallel
siblings are cascade-cancelled. Promotes parked `idea_budget_ceilings`.

## 2. Delivered vs Planned

| Planned (design) | Status |
|---|---|
| Extend `IRBudgetDef`/`BudgetDef` with `max_agent_dispatches`/`max_tokens` | ✅ |
| `budget` in `compute_spec_checksum` (STRAT-IMMUTABLE) | ✅ |
| Usage capture in both connector paths | ✅ (claude+codex shapes) |
| `FlowState.budget_state` through both serializers | ✅ (executor + goal orchestrator) |
| Debit at parallel + `stratum_agent_run` chokepoints | ✅ |
| Hard cutoff via `_cancel_siblings` + `budget_exhausted` terminal | ✅ |
| `budget_exhausted` across advancement APIs + status surfaces + contracts | ✅ (expanded — see §3) |
| Enforce wall-clock (`ms`) + dispatches + tokens; record dollars | ✅ |
| Judge flow-attribution | ⚠️ **Fallback taken** — see §3/§4 |

## 3. Enforced axes & key decisions

- **Enforced:** `ms` (wall-clock as cumulative active-dispatch compute-seconds,
  resume-safe), `max_agent_dispatches`, `max_tokens`. **Recorded-only:** `usd`
  (dollars not computable server-side; codex emits 0).
- **`ms` reuse:** the pre-existing-but-unenforced flow-level `budget.ms` becomes
  the wall-clock axis. Verified zero real `.stratum.yaml` specs declared flow-level
  budget, so this is not a behavior change for any shipped pipeline.
- **Server-dispatched only:** normal steps are consumer-driven (server returns a
  dispatch descriptor; Claude Code runs the agent), so only parallel tasks and
  `stratum_agent_run` (attributed via `correlation_id`) debit.

## 4. Architecture deviations / accepted limitations

- **Judge attribution (deliberate fallback):** the judge verifier receives
  `stratum_agent_run` as an injected callable with no `flow_id` in scope.
  Threading it is multi-layer, and the judge is already governed by its own
  `BudgetCaps`. So judge-internal T2/T3 dispatches do **not** count against the
  run-wide budget in v1. Deferred to follow-up. Codex flagged this twice; it is
  an accepted, documented scope cut, not a gap.
- **Dollars not enforced:** filed `STRAT-WORKFLOW-BUDGET-DOLLARS` (token→USD
  pricing table). Consumer-reported usage for normal steps deferred to the same.

## 5. Test coverage

New: `test_run_budget.py` (13), `test_workflow_budget_ir.py` (7),
`test_workflow_budget_state.py` (5), `test_workflow_budget_parallel.py` (7),
`test_workflow_budget_server.py` (12). Full `stratum-mcp/tests/` green; goal
orchestrator suite green.

## 6. Codex review loop (the value)

Three implementation-review rounds, **4 → 1 → 0** findings — all real, none
caught by the initial tests:

1. **Debit skipped on error/cancel** (agent_run debit was after `try/finally`) → moved into `finally`.
2. **Incomplete hard-stop coverage** → added gates to `stratum_parallel_start` (design had listed it; I'd missed it), `stratum_check_timeouts`, `stratum_skip_step`, and a `budget_exhausted()` check in `stratum_resume`.
3. **Non-durable terminal status** (parallel path persisted before marking terminal; agent_run never marked terminal on cap-cross) → set terminal before persist / mark+persist in finally.
4. **Partial usage dropped on failed parallel tasks** (`_task_usage` registered only after normal loop completion) → register accumulator reference before consuming.

The design gate (2 rounds, 5 + 2 findings) earlier caught the IRBudgetDef
collision, usage-discard, attribution, and contract-enum gaps before any code.

## 7. Files changed

`spec.py`, `executor.py`, `parallel_exec.py`, `server.py`, `run_budget.py` (new),
`src/stratum/goal/orchestrator.py`, `contracts/{flow-state,query-flows}.v1.schema.json`,
+ 5 test files.

## 8. Lessons

- **Verify the ROADMAP's premise.** "dollars + wall-clock, the gap is scope not
  mechanism" was wrong for the MCP path — dollars have no server-side mechanism.
- **Impl review loops catch wiring, not logic.** Every Codex finding was an
  unwired/edge path (error debit, missed entry points, persist ordering) — the
  happy-path tests were green throughout. Cf. `feedback_review_loops_catch_unwired`.
