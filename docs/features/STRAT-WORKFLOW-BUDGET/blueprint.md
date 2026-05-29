# STRAT-WORKFLOW-BUDGET — Implementation Blueprint

**Status:** Phase 4 blueprint (2026-05-29). Verified against disk — all line refs current.
**Design:** [design.md](./design.md)

## Verification table (Phase 5 — every site read from disk via targeted research)

| # | Site | File:line | Verified | Note |
|---|---|---|---|---|
| 1a | `IRBudgetDef` | spec.py:26 | ✅ `{ms, usd}` frozen dataclass | add 2 optional fields |
| 1b | `BudgetDef` schema ×**3** | spec.py:210, 315, 490 | ✅ v0.1/v0.2/v0.3 all identical, `additionalProperties:False` | all 3 need the 2 keys |
| 1c | budget parse ×3 | spec.py:1060 (`_build_function`), 1079 (`_build_flow`), 1150 (`_build_step`) | ✅ `IRBudgetDef(ms=..., usd=...)` | extend all 3 |
| 1d | `IRFlowDef.budget` | spec.py:151 | ✅ exists | no change |
| 2a | `FlowState` | executor.py:781 (last field `synthetic`) | ✅ | add `budget_state` after |
| 2b | `ParallelTaskState` | executor.py:715 (last field) | ✅ | add `tokens`/`elapsed_s`/`dollars_recorded` |
| 2c | `compute_spec_checksum` | executor.py:901 | ✅ fingerprints name/steps/functions/max_rounds | add `budget` |
| 2d | `create_flow_state` | executor.py:1154 | ✅ | init `budget_state` from `flow_def.budget` |
| 2e | `persist_flow` | executor.py:957 | ✅ payload dict | add 1 key |
| 2f | `restore_flow` | executor.py:1024 | ✅ | add `payload.get("budget_state")` |
| 3c | `_consume_streaming` | parallel_exec.py:344 | ✅ ignores usage | capture |
| 3d | `_consume` | parallel_exec.py:381 | ✅ ignores usage | capture |
| 3e | `_run_one` finally | parallel_exec.py:535 | ✅ `_require_unsatisfiable`→`_cancel_siblings` at :592 | add debit + budget cascade |
| 3f | `_cancel_siblings`/`_require_unsatisfiable` | parallel_exec.py:255/278 | ✅ | reuse for budget |
| 4a | `stratum_agent_run` | server.py:133 | ✅ mints flow_id when no correlation_id (:167) | capture+debit+gate |
| 4b–4j | resume/step_done/poll/advance/_advance_after_parallel/gate_resolve/parallel_start/audit/_flow_status | server.py:318/352/1047/1211/838/1378/926/1320/3353 | ✅ only `"killed"` special-cased | add `budget_exhausted` |
| 5 | status enum ×2 | flow-state.v1.schema.json:13, query-flows.v1.schema.json:17 | ✅ `[running,awaiting_gate,complete,killed]` | add `budget_exhausted` |
| 6 | connector usage | claude.py:280 (`type:"usage"`), codex.py:668 (`kind:"step_usage"`, `metadata.type:"usage"`) | ✅ | capture must handle **both** shapes |
| 7a | judge verifier agent_run ×3 | verifier.py:117 (T2), 271/282 (T3) | ✅ no correlation_id | thread `flow_id` |
| 7b/7c | orchestrator 2nd serializer | orchestrator.py:152 (`_flow_state_to_dict`), 236 (`_restore_flow_state_from_path`) | ✅ manual field mirror | round-trip `budget_state` (None for synthetic) |

**Zero corrections.** No stale entries. No Boundary Map (single coherent work unit threaded across files). Phase 5 gate: clean.

## Ordered implementation slices (TDD per slice)

**S1 — IR extension (foundation, no behavior).**
`IRBudgetDef` +`max_agent_dispatches:int|None=None`, `max_tokens:int|None=None`. All 3 `BudgetDef` schemas +2 optional integer props (`minimum:1`). All 3 parse sites read the new keys. `compute_spec_checksum` adds `"budget": dataclasses.asdict(flow_def.budget) if flow_def.budget else None`.
*Tests:* parse a flow with new budget keys; existing `{ms,usd}` spec unaffected; budget-less flow unaffected; checksum changes when budget changes (immutability).

**S2 — FlowState.budget_state + persistence (both serializers).**
Add `budget_state: dict|None=None` to `FlowState`; thread through `persist_flow`/`restore_flow` and `orchestrator._flow_state_to_dict`/`_restore_flow_state_from_path` (synthetic → always `None`). `create_flow_state` initializes `{"caps": {...}, "consumed": {wall_s:0, dispatches:0, tokens:0, dollars:0}}` from `flow_def.budget` when any run-wide cap is set, else `None`.
*Tests:* round-trip persist/restore; legacy payload missing key → `None`; synthetic goal flow round-trips `None`; create_flow_state populates caps from spec.

**S3 — usage capture + ParallelTaskState fields.**
`ParallelTaskState` +`tokens:int=0`, `elapsed_s:float=0.0`, `dollars_recorded:float=0.0`. A module helper `accumulate_usage_event(acc, ev_dict)` that reads `input_tokens+output_tokens` and `cost_usd` from either shape (`type=="usage"` dict, or `kind=="step_usage"` with `metadata.type=="usage"`). `_consume_streaming`/`_consume` accumulate into a per-call total and return `(final, usage)` (or stash on a local the finally reads).
*Tests:* helper sums both connector shapes; cache tokens excluded from the billed total (count input+output only); stub connector emitting usage → captured total.

**S4 — debit helper + flow-wide accounting.**
`debit_budget(state, *, dispatches, tokens, wall_s, dollars)` mutates `budget_state["consumed"]` (no-op when `budget_state is None`) under `_lock_for(flow_id)`, persists. `budget_exhausted(state)` → any enforced consumed axis (`wall_s` vs `caps.ms/1000`, `dispatches` vs `max_agent_dispatches`, `tokens` vs `max_tokens`) ≥ cap; `usd`/dollars never trips.
*Tests:* each axis independently trips; dollars never trips; None budget → never exhausted; concurrent debits serialized correctly.

**S5 — parallel debit + cascade cutoff.**
`_run_one` finally: compute `elapsed_s`, set `ts.tokens/elapsed_s/dollars_recorded`, call `debit_budget(...)`, then add `if budget_exhausted(self.state): state.terminal_status="budget_exhausted"; self._cancel_siblings()` alongside the existing `_require_unsatisfiable` check. Pre-slot gate: skip dispatch if already exhausted. `stratum_parallel_start`: refuse launch if exhausted.
*Tests:* 3 parallel tasks, max_tokens trips after task 1 → siblings cancelled + `terminal_status` set (mirror `test_require_all_one_failure_cancels_others`); dispatch-count cap; already-exhausted → no launch.

**S6 — stratum_agent_run capture + debit + gate + judge attribution.**
Capture usage in both stream/run loops. Before dispatch: if `correlation_id` resolves to a budgeted live `FlowState` and `budget_exhausted` → return `{"status":"budget_exhausted", ...}` sentinel. After completion: debit when attributed. Thread `correlation_id=flow_id` through the 3 judge verifier calls (verifier needs the flow_id in scope — check call chain; if not threaded, document the limitation and debit only direct agent_run callers).
*Tests:* attributed agent_run debits; un-attributed doesn't; pre-dispatch gate returns sentinel when exhausted; judge call carries correlation_id.

**S7 — terminal-state surfacing (all advancement APIs + status + contracts).**
`_assert_not_terminal(state)` helper recognizing `killed`+`budget_exhausted`. Wire the `budget_exhausted` hard-stop into `stratum_step_done`, `_advance_after_parallel`, `stratum_parallel_poll`, `stratum_parallel_advance`, `stratum_gate_resolve`, `stratum_resume`. `_flow_status` + `_build_audit_snapshot` recognize it; audit includes `budget_state`. Both JSON contracts +`budget_exhausted` enum value.
*Tests:* exhausted flow → `_flow_status=="budget_exhausted"`; resume refuses; each advancement API returns terminal payload; audit snapshot carries budget_state; contract validates the new enum.

**S8 — follow-up + docs.**
File `STRAT-WORKFLOW-BUDGET-DOLLARS` (forge-top ROADMAP). CHANGELOG entry (note contract enum change). README/SPEC: document the flow-level `budget:` run-wide axes + wall-clock = compute-seconds semantics.

## Risks / watch-items
- **Judge flow attribution (S6):** verifier may not have `flow_id` in scope; if threading is invasive, fall back to documented limitation (judge runs debit only when caller passes correlation_id). Don't over-engineer.
- **Wall-clock parallel semantics:** Σ per-task wall-time can exceed real elapsed under concurrency — intended (compute-seconds), must be documented to avoid misread.
- **`ms` unit:** caps.ms is milliseconds; consumed wall_s is seconds — convert at the comparison (`wall_s >= caps.ms/1000`).
