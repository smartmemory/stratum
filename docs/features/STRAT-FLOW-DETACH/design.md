# STRAT-FLOW-DETACH — fully-detached stratum pipelines (design)

**Status:** DESIGN — codex-reviewed 2026-07-11, **GATED ON A CONSUMER CHECK
(likely PARK).** Scope: close the handoff gap so a whole pipeline (not just its
linear prefix) runs without the interactive session pumping it. **No
implementation until (a) a real consumer for full detachment is confirmed and
(b) the owner picks B-vs-PARK.** The review withdrew the original "build judge on
Python now" recommendation as throwaway debt.

## Related Documents

- Backward: [agent-invocation strategy](../../plans/2026-07-11-agent-invocation-strategy.md) (D3 — this is that feature; but see the Scope Correction below, which narrows D3)
- Backward: [STRAT-WORKFLOW-BG design](../STRAT-WORKFLOW-BG/design.md) (the driver this extends: `_background_flow_advance`, `stratum_flow_run_bg/bg_poll/cancel_bg`)
- Backward: [STRAT-CODEX-WRITE-DURABLE](../STRAT-CODEX-WRITE-DURABLE/design.md) (durable agent dispatch, now shipped — the optional per-step substrate)
- Sibling/tension: [STRAT-PY-RETIRE roadmap](../../plans/2026-07-11-strat-py-retire-roadmap.md) (the driver is Python-only; this feature interacts with retirement directly)
- Ideas: `idea_richer_gate_decisions`, `idea_nondestructive_branching`

## Scope Correction (grounded 2026-07-11 — narrows strategy D3)

D3 framed this as "compose the STRAT-WORKFLOW-BG driver WITH background agent
dispatch." Reading the code, most of that already exists:

- `_background_flow_advance` (server.py:5260) is a server-side asyncio task, one
  per flow in `_BG_FLOWS`. It **already** dispatches each function/inline step
  itself via `stratum_agent_run` (`_bg_dispatch_step`, server.py:5225), runs the
  retry/ensure loop via `process_step_result`, honors run budgets, **pauses at
  gates** (`paused_gate`, server.py:5300), and persists durable resumable
  snapshots (with a clean cancel-vs-shutdown-drain distinction).
- So a pipeline of **pure function/inline steps already runs fully detached**:
  `stratum_flow_run_bg` starts it, the session polls `stratum_flow_bg_poll`, the
  session is not the hostage. The hostage problem is already solved *for that
  shape*.

**The actual gap:** the driver **hands off** (finalizes `handoff:<kind>` and
stops) at every non-linear step kind — judge, flow, decompose, parallel_dispatch
(server.py:5339-5348; note `pipeline` is normalized to `parallel_dispatch` at
executor.py:845, so the status is `handoff:parallel_dispatch`). A realistic
pipeline contains judged ensures and fan-out, so today it detaches only up to its
first such step, then returns to the session. (Snapshots resume *between attempts*,
not an in-flight foreground agent — see durable-dispatch below.) STRAT-FLOW-DETACH = **teach the driver to autonomously execute the
handoff kinds**, so the *whole* pipeline detaches. This is precisely the
Phase-2 "keep + WIRE the validated primitives into a live flow" work, reached
from the invocation-research direction.

## The load-bearing fork: Python driver vs TS engine

The **whole-flow** background driver is Python-only: the TS server exposes plan /
step_done / resume / gate_resolve / flow_poll / agent_run / guard — no
`flow_run_bg`, no session-detached whole-flow driver. **But (codex review, 2026-07-11)
"only Python has server-driven execution" is FALSE and was a load-bearing error
here:** the TS engine already advances internally on `plan()` (engine.ts:206) and
**schedules + connector-dispatches native fanout asynchronously, without client
pumping** (engine.ts:541/623/789). So the TS engine already has the hard part of
autonomous parallel execution; what it lacks is only the whole-flow "run this flow
detached and poll it" wrapper.

Meanwhile STRAT-PY-RETIRE lists `flow_bg_*` as **unused, pending disposition**
(roadmap D2) and mandates usage-driven parity ("verify a real, non-redundant
caller before porting"). Three options:

- **A — Build v1 on the Python driver now.** Fastest, but builds new autonomous
  logic on the exact surface the retirement is trying to delete → deliberate
  throwaway debt. **Rejected.**
- **B — TS-native.** Add the whole-flow detached wrapper to the TS engine and wire
  the step kinds around its EXISTING connector/fanout machinery (not a literal
  Python port). Aligns with retirement; leverages the TS engine's existing async
  fanout. Larger up-front.
- **PARK** — do nothing until a real consumer for a fully-detached pipeline is
  identified. The linear Python driver + handoff already serves today's shapes,
  and `flow_bg_*` shows no live caller.

**Recommendation (revised after review): verify a consumer FIRST, then PARK-or-B —
never C/A.** Per the retirement's own rule, this feature should not be built until
a real consumer needs a *fully*-detached pipeline (one that contains a judged
ensure or fan-out). If none exists, PARK. If one does, build **B** (TS-native),
because (a) putting new autonomous logic on the retiring Python driver is throwaway
debt, and (b) the TS engine already does the async fanout dispatch that the parallel
case needs. The original recommendation C (judge-in-driver on Python now) is
withdrawn — it violated the "verify a real caller first" principle. This is the
owner's cross-epic call.

## Design (independent of the fork)

### Autonomous step-kind execution (the core)

Replace each `handoff:<kind>` branch with an in-driver executor, added one kind
at a time. Priority: **judge → parallel/fanout → flow/decompose**.

- **judge**: evaluate via the REAL `stratum_judge` path — not a hand-rolled
  kernel call, and not a reduced "verdict". Codex review flagged three traps:
  (a) `process_step_result` expects the **full `JudgeResult`** shape the current
  caller protocol supplies (server.py:2894/3014) — a reduced verdict will not
  validate; (b) bypassing `stratum_judge` skips contract validation, judge-history
  recording, and learning hooks — the driver must route through the same tool
  surface a consumer would; (c) the judged step's required `artifacts` /
  `modified_files` provenance must be defined (where does the driver source them
  autonomously?). Open until specified.
- **parallel_dispatch**: drive fan-out. On TS this reuses the engine's EXISTING
  async fanout scheduling (engine.ts:541/623/789); on Python it is gated on
  STRAT-WORKFLOW-BG-PARALLEL (deferred). This is the strongest argument for B.
- **flow / decompose**: sub-flow execution — but "nested driver invocation" is
  NOT sufficient (see child-gate protocol below).

### Gates STAY paused — never auto-approve (hard constraint)

Detached ≠ unattended. The driver already finalizes `paused_gate` and returns; a
HITL gate MUST continue to surface to the session (poll shows `paused_gate` +
the gate id) and wait for `stratum_gate_resolve`. A detached pipeline that
auto-approved its own gates would undo the entire write-safety story from a layer
above. Richer gate decisions (approve/edit/reject/respond) are `idea_richer_gate_decisions`.

**Child-flow gate propagation (codex review — a real protocol, not a footnote).**
"Gates stay paused" is proven only for the CURRENT flow. Parent polling reports
only the parent step/reason (server.py:5425). A gate inside a `flow`/`decompose`
sub-flow needs explicit propagation up the chain: child flow id, gate id,
resolution target, and how resolving it resumes the parent. Sub-flow execution
CANNOT ship until this propagation protocol is designed — otherwise a nested gate
silently strands a detached pipeline. This alone argues flow/decompose is a later,
separate slice, not part of v1.

### Durable per-step agent dispatch (optional enhancement)

`_bg_dispatch_step` dispatches agents **foreground** (in-process asyncio), so an
in-flight step dies if the server restarts (only the flow snapshot is resumable,
not the live agent). With WRITE-DURABLE shipped, long/write steps MAY instead be
dispatched via the durable background path (`background=True`) and polled by the
driver, so the agent survives a server restart and the driver reattaches. This is
an enhancement, not required for v1; scope it only if restart-survival of a
mid-step agent is a real requirement.

### Distributability door-keeper (hard constraint — from the strategy doc)

All per-step run lifecycle — dispatch, liveness, poll, cancel — routes through
the connector/agent-run interface with an **opaque run handle**. The driver loop
must contain no `kill -0 <pid>`-shaped assumptions; PID/`terminate_verified` is
the local connector's private detail. The driver reads/writes flow state through
the store seam, never raw `~/.stratum` paths. Rationale: the spec IR, contracts,
content-addressed step cache, and judge/guard certificates are already
location-independent; keeping the driver PID-free leaves detached execution
one-connector-away from remote (codex cloud, Routines) instead of one-rewrite-away.
Build no distributed anything in v1.

### Budget attribution

The driver already threads `correlation_id=flow_id` into `stratum_agent_run`, so
foreground per-step dispatch debits the flow budget. Durable/background dispatch
cannot debit run budgets yet (STRAT-AGENT-BG-BUDGET, server.py:496). If durable
per-step dispatch is in scope, that gap is a prerequisite; if v1 stays foreground,
budget already works.

## Slice plan (only if a consumer is confirmed → option B, TS-native)

- **Slice 0 — consumer check (gate).** Identify a real pipeline that needs FULL
  detachment (contains a judged ensure or fan-out) and cannot use the linear
  driver + handoff. If none, PARK here — do not build.
- **Slice 1 — STRAT-TS-FLOW-BG.** Add the whole-flow "run detached + poll"
  wrapper to the TS engine (the piece it genuinely lacks), reusing its existing
  internal advance + async fanout dispatch.
- **Slice 2 — judge-in-driver (TS).** Route `handoff:judge` through the real judge
  tool surface (full `JudgeResult`, contract validation, history, learning hooks
  preserved). Add a **remediation/re-stage step between adverse verdicts** —
  re-judging unchanged evidence is bounded by the retry cap but pointless and
  expensive; the loop must either re-stage inputs or fail fast, not spin.
- **Slice 3 — parallel/fanout-in-driver (TS).** Wire the whole-flow wrapper to the
  engine's existing async fanout so a fan-out step runs detached end-to-end.
- **Slice 4 — flow/decompose sub-flows.** ONLY after the child-flow gate
  propagation protocol is designed and shipped.

## Acceptance criteria (if built — option B; per slice)

- [ ] TS whole-flow detached wrapper: a flow runs to terminal `complete` without
      any `stratum_step_done` / consumer pumping (Slice 1)
- [ ] A judged-ensure flow detaches end-to-end via the REAL judge tool surface
      (full `JudgeResult`; contract validation, history, learning hooks preserved);
      adverse verdicts re-stage or fail fast, never spin on unchanged evidence
- [ ] Gates still `paused_gate` and wait for `stratum_gate_resolve` (no auto-approve);
      child-flow gates propagate id/target/resume to the parent (Slice 4 gate)
- [ ] Driver loop touches no PID/process primitive directly; lifecycle via the
      connector interface with an opaque handle; state via the store seam
- [ ] Full green; no regression to the existing linear background driver

## Open questions (resolved-or-owner, post-review)

1. **RESOLVED by review — the fork.** A (Python-now) is throwaway debt; the honest
   options are B (TS-native) or PARK. Owner picks B-vs-PARK, gated on Q2.
2. **The gating question: is there a real consumer** for a *fully* detached pipeline
   today (one with a judged ensure or fan-out that the linear driver + handoff
   can't serve)? The retire roadmap lists `flow_bg_*` as unused. If no consumer →
   PARK. This is the decision that blocks everything else.
3. Judge autonomous provenance: where do `artifacts` / `modified_files` come from
   when the driver (not a consumer) drives a judged step? Must be specified before
   Slice 2.
4. Durable per-step dispatch (background+poll so a mid-step agent survives server
   restart): real requirement, or YAGNI? If in scope, STRAT-AGENT-BG-BUDGET is a
   prerequisite (background dispatch can't debit run budgets yet).
