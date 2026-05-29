# STRAT-WORKFLOW-BUDGET — Design

**Status:** Phase 1 design (Compose build, 2026-05-29) — revised after Codex design gate round 1 (5 findings addressed: schema collision, usage capture, flow attribution, terminal-state surfacing, second serializer). Not yet implemented.
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP) — ticket 2 of 6
**Related:** [[project_strat_workflow_epic]], [[idea_budget_ceilings]] (this promotes it)

## Problem

A Stratum flow execution can fan out many agents (parallel tasks, judge loops,
decompose calls). Today nothing bounds the *aggregate* cost of a whole flow run:
`parallel_exec` enforces only a **per-task** `timeout`, and `BudgetCaps`
(`max_turns`/`max_dollars`/`max_wall_clock_s`) is scoped to a single
`stratum_judge` invocation. A runaway flow — retry storms, a wide fan-out that
keeps re-dispatching, an iteration loop that won't converge — has no run-wide
ceiling and no hard cutoff. This is the parked [[idea_budget_ceilings]]:
"hard caps on iteration count, wall-clock time, action count for runaway agents."

## Verified architecture (read the source, don't infer)

Two distinct flow paths exist; **only one has the gap.**

| Path | Budget today | Verdict |
|---|---|---|
| **Library** (`@flow`/`FlowScope`/`execute_infer`, `src/stratum/`) | `Budget(ms, usd)` cloned into `_FlowContext`, accumulates cost across nested `@infer`, enforced before each attempt (`executor.py:259`) | **Already has flow-wide budget.** Out of scope. |
| **MCP server** (`FlowState` + `stratum_plan`/`step_done` + `ParallelExecutor`) | per-task `timeout` only | **This is the gap.** |

Two facts verified in source that reshape the ROADMAP's premise:

1. **Dollars are not computable on the MCP path.** Connectors emit token-count
   `usage` events (`connectors/claude.py:280`, `codex.py:552`); `cost_usd` is
   hardcoded `0` for codex, absent for claude, pass-through only for opencode.
   `litellm.completion_cost` lives **only** in the library executor
   (`src/stratum/executor.py:365`), not the MCP path. (This is why the judge's
   `max_dollars` is "recorded but not enforced.") The ROADMAP's "the gap is
   scope, not mechanism" is **wrong for dollars on this path** — the mechanism
   is absent.

2. **Normal steps are consumer-dispatched.** `stratum_plan`/`stratum_step_done`
   return a *dispatch descriptor*; Claude Code runs the step's agent and reports
   back. The server runs a connector itself in exactly **two** places:
   `stratum_agent_run` (`server.py:133`, also the path judge/decompose use) and
   `ParallelExecutor._consume_streaming` (`parallel_exec.py:344`). So
   "every dispatched agent debits" can robustly mean **every server-dispatched
   agent**; normal consumer steps debit only what the consumer reports.

## Scope decision (gate-approved axes)

Enforce the three axes that are genuinely measurable server-side. **Dollars
recorded-not-enforced**; true dollar enforcement deferred to a follow-up.

| Axis | Enforced? | Source | Resume-safe? |
|---|---|---|---|
| `max_agent_dispatches` | **Yes** (hard count) | increment per server-dispatched agent | yes (persisted counter) |
| `max_tokens` | **Yes** | sum `input_tokens + output_tokens` from `usage` events | yes (persisted counter) |
| `max_wall_clock_s` | **Yes** | accumulated active-dispatch wall-time (Σ per-dispatch `finished−started`) | yes (persisted counter) |
| `max_dollars` | **Recorded only** | connector `cost_usd` where present (else 0) | yes |

**Follow-up filed:** `STRAT-WORKFLOW-BUDGET-DOLLARS` — token→USD pricing table to
promote `max_dollars` to enforced. Out of scope here.

**Wall-clock semantics (documented choice):** `max_wall_clock_s` is the sum of
active server-dispatched-agent wall-time, **not** real elapsed since flow
creation. Rationale: (a) resume resets `flow_start` (`restore_flow` sets it to
`time.monotonic()`), so real-elapsed is unmeasurable without an epoch anchor;
(b) a flow parked at a human gate for hours should not trip a "runaway" budget.
This measures *compute consumed*, which is the runaway signal. Will be named/
documented to avoid the "kill after N real minutes" misread. (Design-gate item.)

## Design

### 1. Declaration (IR) — extend the existing flow budget, don't collide

**Finding 1 fix.** `IRFlowDef.budget: IRBudgetDef | None` **already exists**
(`spec.py:151`, schema `$ref BudgetDef` at `spec.py:426,635`) with shape
`{ms, usd}` — and is currently **parsed but unenforced on the MCP path** (the
only `.budget` reference in `executor.py` is a comment). So we **extend
`IRBudgetDef` / `BudgetDef` additively**, not invent a colliding `flows.<name>.budget`:

```yaml
flows:
  my_flow:
    budget:
      ms: 1800000             # EXISTING — reused as the wall-clock axis (resolves open-Q1)
      usd: 5.00               # EXISTING — recorded-only (not enforced; see follow-up)
      max_agent_dispatches: 50  # NEW (optional)
      max_tokens: 2000000       # NEW (optional)
    steps: [...]
```

`IRBudgetDef` gains two optional fields (`max_agent_dispatches: int | None`,
`max_tokens: int | None`); `BudgetDef` JSON schema gains the two keys
(`additionalProperties: False` stays satisfied). `ms` is the wall-clock cap
(milliseconds → compute-seconds, see semantics note); `usd` recorded-only. All
fields optional ⇒ existing `{ms, usd}` specs unaffected; budget-less flows
unaffected.

**Finding 1b fix (checksum):** `compute_spec_checksum` (`executor.py:901`)
currently fingerprints `name/steps/functions/max_rounds` but **not** `budget`.
Add a `budget` entry to the fingerprint so the run-wide caps are covered by
STRAT-IMMUTABLE tamper-detection on resume (consistent with the comment at
`executor.py:871` that budget must not be altered mid-run undetected).

### 2. Usage capture (Finding 2 — usage is discarded today)

**This is a prerequisite, not an afterthought.** Verified: `stratum_agent_run`
only accumulates assistant text/final result (`server.py:193`) and
`ParallelExecutor._consume_streaming`/`_consume` (`parallel_exec.py:344,381`)
forward envelopes but **ignore `usage` events**. Token/wall accounting is
impossible until usage is retained. Subdesign:

- A small `_accumulate_usage(events_or_stream) → {tokens, dollars}` that sums
  `input_tokens + output_tokens` (and `cost_usd` where present) from the `usage`
  events both connectors already emit (`claude.py:280`, `codex.py:552`).
- `ParallelExecutor._consume_streaming` captures per-task usage into the task's
  record; `_run_one` reads it in the `finally` for the debit.
- `stratum_agent_run`'s stream loop captures usage into a local total available
  at completion.

`ParallelTaskState` gains additive `tokens`/`dollars_recorded` fields (+
`elapsed_s`) so per-task consumption is auditable in the trace and persisted.

### 3. Storage & accumulation (`FlowState`)

Add one additive field:

```python
budget_state: dict[str, Any] | None = None
# {"caps": {ms?, max_agent_dispatches?, max_tokens?, usd?},
#  "consumed": {wall_s, dispatches, tokens, dollars}}
```

Threaded through **both** serializers (Finding 5):
1. `persist_flow`/`restore_flow` (`executor.py:957/993`) — add one payload key,
   `payload.get("budget_state")` → `None` default (established additive pattern,
   cf. `test_restore_flow_handles_missing_parallel_tasks_field`).
2. **`goal/orchestrator.py:152/223`** — the *second* custom `FlowState`
   serializer/restorer for synthetic goal flows. Synthetic goal flows already
   carry the judge `BudgetCaps`, so v1 **explicitly excludes** them from the
   run-wide budget (`budget_state=None` always), and the orchestrator serializer
   is updated to round-trip the field as `None` so it can never silently drop a
   value. Documented exclusion, not an accident.

Populated at flow creation from the extended `IRBudgetDef`; `None` when no budget
declared (zero overhead, zero behavior change).

### 4. Debit points (the two server chokepoints + flow attribution)

A single helper `debit_budget(state, *, dispatches=0, tokens=0, wall_s=0,
dollars=0.0)` mutates `budget_state["consumed"]` under the existing per-flow lock
(`_lock_for(flow_id)`, `parallel_exec.py:49`) and persists.

- **`ParallelExecutor._run_one`** — in the `finally` block (`parallel_exec.py:583`):
  debit `dispatches=1`, `tokens`/`wall_s` from the captured usage (§2).
- **`stratum_agent_run`** — after the stream completes, debit **only when a
  `correlation_id` resolves to a live budgeted `FlowState`** (Finding 3). When no
  flow identity is supplied, the call is un-attributed and does **not** debit —
  documented limitation.
- **Flow attribution for judge/decompose (Finding 3):** the judge verifier
  (`src/stratum/judge/verifier.py:117,271`) calls the injected agent-run **without
  a `correlation_id`**, so those server-dispatched T2/T3 runs do not map to a
  `FlowState` today. v1 **threads `flow_id` through** the judge/decompose agent-run
  call sites so their dispatches debit and gate. (If threading proves invasive,
  fallback: judge runs debit via the judge's own `BudgetCaps` and are documented
  as out of the run-wide count — but the threading is preferred and is the plan.)

### 5. Check & hard cutoff

`budget_exhausted(state)` = any enforced consumed axis (`wall_s`, `dispatches`,
`tokens`) ≥ its cap. `usd` never trips it.

- **Pre-dispatch gate:** before `executor.run()` fans out
  (`stratum_parallel_start`), before each task acquires its slot in `_run_one`,
  **and inside `stratum_agent_run` before dispatch** (Finding 3 — so a multi-call
  judge T2/T3 loop stops dispatching once exhausted; `stratum_agent_run` returns a
  budget-exhausted sentinel its callers treat as a hard stop).
- **Post-dispatch cutoff (parallel):** in `_run_one` finally, after debiting,
  reuse the existing cascade-cancel — call `_cancel_siblings()`
  (`parallel_exec.py:278`) when `budget_exhausted(state)`, exactly as
  `_require_unsatisfiable()` does. Set `terminal_status="budget_exhausted"`.
- **Sequential / step transition:** `stratum_step_done` checks `budget_exhausted`
  before returning the next dispatch; if exhausted, returns a flow-terminal
  payload instead of the next step.

#### 6. Surfacing terminal state (Findings 4, 6, 7 — `"budget_exhausted"` recognized everywhere `"killed"` is)

`terminal_status="budget_exhausted"` is added to **every** site that special-cases
`"killed"` so a persisted exhausted flow doesn't read `in_progress`/`running`
after restart or in query surfaces:

- `stratum_resume` (`server.py:330`) — refuse/short-circuit resume of an exhausted flow.
- `_build_audit_snapshot` (`server.py:3355`) — surface budget exhaustion + `budget_state`.
- `_flow_status` (`server.py:3353`) — report `budget_exhausted`, not `running`.
- `stratum_audit` output + flow-complete payload include `budget_state` (consumed-vs-cap).

**Finding 7 fix — hard-stop EVERY advancement API, not just `step_done`.** The MCP
flow advances from several entry points; all must treat
`terminal_status=="budget_exhausted"` as a hard stop (return the terminal payload,
do not route the next step):
`stratum_step_done`, `stratum_parallel_poll` (`server.py:1135`),
`stratum_parallel_advance` (`server.py:1288`), `_advance_after_parallel`
(`server.py:850`), and `stratum_gate_resolve` (`server.py:1378`). A shared
`_assert_not_terminal(state)` guard (already implicitly needed for `"killed"`) is
the single chokepoint.

**Finding 6 fix — widen the status contracts.** `_flow_status` feeds CLI query
responses governed by `contracts/flow-state.v1.schema.json:13` and
`contracts/query-flows.v1.schema.json:17`, whose `status` enum currently admits
only `running|awaiting_gate|complete|killed`. Add `budget_exhausted` as an
additive enum value (backward-compatible for readers, same move `killed` already
represents). Bump the contract's `_source`/comment; no major version bump needed
for an additive enum, but note the change in CHANGELOG.

## Acceptance criteria

- [ ] `IRBudgetDef`/`BudgetDef` extended with optional `max_agent_dispatches`/`max_tokens`; existing `{ms, usd}` specs and budget-less flows unaffected.
- [ ] `budget` added to `compute_spec_checksum` fingerprint (STRAT-IMMUTABLE coverage).
- [ ] Usage (`input+output tokens`, `cost_usd` where present) captured in `ParallelExecutor._consume_streaming` and `stratum_agent_run`; `ParallelTaskState` gains additive `tokens`/`elapsed_s`/`dollars_recorded`.
- [ ] `FlowState.budget_state` persists/restores via **both** serializers (`executor.py` + `goal/orchestrator.py`); synthetic goal flows carry `None` by design; legacy-missing-field test.
- [ ] Every **server-dispatched, flow-attributed** agent (parallel task + `stratum_agent_run` with a resolving `correlation_id`) debits dispatches/tokens/wall_s; `flow_id` threaded through judge/decompose agent-run calls.
- [ ] `ms` (wall-clock), `max_agent_dispatches`, `max_tokens` each independently trip exhaustion.
- [ ] Exhaustion mid-fan-out cascade-cancels in-flight siblings (reuses `_cancel_siblings`) and sets `terminal_status="budget_exhausted"`.
- [ ] `stratum_agent_run` pre-dispatch gate stops a multi-call judge loop after exhaustion (returns budget-exhausted sentinel).
- [ ] `stratum_step_done` halts advancement when exhausted.
- [ ] `"budget_exhausted"` recognized by `stratum_resume`, `_build_audit_snapshot`, `_flow_status` (no exhausted flow reads `running`).
- [ ] `"budget_exhausted"` is a hard stop on **every** advancement API: `stratum_step_done`, `stratum_parallel_poll`, `stratum_parallel_advance`, `_advance_after_parallel`, `stratum_gate_resolve`.
- [ ] `status` enum widened with `budget_exhausted` in `flow-state.v1.schema.json` + `query-flows.v1.schema.json` (additive); CHANGELOG notes the contract change.
- [ ] `usd` recorded in `budget_state` but never trips a cutoff; documented as recorded-only.
- [ ] Dollars-enforcement follow-up `STRAT-WORKFLOW-BUDGET-DOLLARS` filed.
- [ ] No behavior change for flows without a `budget:` block.
- [ ] Codex design gate: REVIEW CLEAN.

## Resolved gate questions

1. **Wall-clock semantics** — RESOLVED: reuse the existing `budget.ms` field as the wall-clock cap, with **active-compute-seconds** semantics (Σ per-dispatch wall-time; resume-safe since `flow_start` resets on restore; excludes gate-idle time). Documented so it doesn't misread as "kill after N real minutes."
2. **Declaration site** — RESOLVED: extend the existing flow-level `budget:` block (avoids the `IRBudgetDef` collision Finding 1 caught); no new top-level key.
3. **Consumer-reported usage** — DEFERRED to follow-up: v1 debits only server-dispatched agents. Whether `stratum_step_done` accepts optional `usage`/`cost` for normal consumer steps is left to `STRAT-WORKFLOW-BUDGET-DOLLARS`/a consumer-reporting follow-up; v1 documents that consumer-driven steps don't debit.
