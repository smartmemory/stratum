# STRAT-SEARCH — Design

**Status:** Phase 1 design (2026-07-24). **Not yet design-gated.** Origin: evaluating
`mutable-state-inc/lean-collab` (MIT, multi-agent Lean 4 theorem proving) as a consumer, and finding
that the orchestration it hand-rolls is mostly primitives Stratum already has — plus three it does not.

**Maturity after Codex design-gate round 1: only S1 is buildable.** R1 returned 9 findings including
2 blockers, and 8 were accepted. The headline correction is that **the central "it's existing
machinery" claim was wrong for the nested case** — see "Central claim, as corrected" below. S2 is a
real engine change, not a validator relaxation. S3-S5 are scoped but each needs its own pass.

## Review R1 adjudication (Codex sol/xhigh, 2026-07-24)

8 accepted, 1 partially refuted. Verified independently before folding in — findings 1, 7 and 9 were
re-read from source rather than taken on the reviewer's word.

| # | Finding | Verdict |
|---|---|---|
| 1 | Fanout scheduling is root-only, so a nested fanout would never be scheduled | **ACCEPTED** — confirmed: `scheduleFanout(run, stepId)` takes no scope and resolves the step from the entry flow (`engine.ts:1069-1085`); the dedupe key reads `run.steps[stepId]`. This is the blocker; it invalidates the "three validator relaxations" framing. |
| 2 | A depth cap does not bound total work when width is uncapped | **ACCEPTED** — correct on its own terms. Items are materialised per array element before dispatch, so work grows as B^D. Retracts S4's safety argument. |
| 3 | `{status, children}` discards `status`; binding `children`→`over` alone recurses on `closed` and `failed` too | **ACCEPTED** — the contract needs cross-field invariants and an explicit status→engine transition. |
| 4 | `depth` is incompatible with the budget ledger | **ACCEPTED** — sharpens this doc's own open question 1. Depth is path-local and rises and falls; siblings at one depth must not sum into "depth spent". It is a scope invariant, not a debit axis. |
| 5 | "All three blockers must move" understates the IR/state redesign | **ACCEPTED** — `FanoutItemState` cannot own subflow state; only `StepState` has `sub`. Adds stage-kind exclusivity, lane call-graph analysis, `with` validation, recursive IDs and traversal. |
| 6 | S3/S4 do not map onto current `iterate`/`require` | **ACCEPTED**, and the sharpest catch in the set: re-running a *deterministic* evaluator reproduces identical children, so the reset target must be the **agent-attempt step**, which this doc never named. Also: unmet `require` takes the failure path immediately and does not redispatch. |
| 7 | "Raise the cap, continue" is incompatible with resume, and the cited dependency is stale | **ACCEPTED** — `STRAT-WORKFLOW-RESUME` and `T2-F5-RESUME` are both **COMPLETE (2026-05-31)**, and resume implements content-addressed result caching, not partial-tree continuation. The dependency was both stale and the wrong mechanism. Asserted from memory without verification — the exact failure this doc's own "stale row" section warns about. |
| 8 | Evaluator output and `route` have no dynamic landing zone | **ACCEPTED** — `contractForStep` recognises only `do`/`set`/`fanout`/`run`, and fanout `agent` is a static enum read as `stage.agent ?? "claude"`. The claim that `route` "targets a field that already exists" was wrong: the field exists but is statically authored, not dynamically bindable. |
| 9 | S5's current-code claims and precedent are wrong | **ACCEPTED IN PART.** Accepted: the status list omitted `waiting_gate`, and `RunStatus` **already includes `budget_exhausted`** — so this doc's "only one way to stop short" claim was false, and a non-failure terminal precedent already exists in-engine, which makes S5 *easier* than framed. Accepted: `inconclusive` touches every frozen `mcp-surface.json` variant, which default-deny undeclared statuses. **Refuted:** the `inconclusive` precedent cited is compose's judgment joint machine, in a different repo — the reviewer checked stratum's guard. The doc's fault was not naming the repo, not the precedent. |

## Related Documents

- `docs/features/STRAT-WORKFLOW-PIPELINE-FANOUT/design.md` — the bounded fan-out this extends; its
  deferred row `-PIPELINE-FANOUT-DYNAMIC` is superseded by S2 here (see "Stale row" below)
- `docs/features/STRAT-WORKFLOW-PIPELINE-ROUTE/design.md` — origin of the `skipped` terminal state
- `docs/plans/2026-07-11-agent-invocation-strategy.md` — D3/STRAT-FLOW-DETACH; the detachment story
- `SPEC.md` §2.4 `@refine`, §5.1 `stratum.parallel` — the library-side analogues of S3/S4
- Upstream reference: https://github.com/mutable-state-inc/lean-collab

## The problem

Stratum can fan out to a runtime-determined **width**, but only to a **depth of one**. Every
non-entry flow is leaf-only. That is enough for map-reduce, migrations, and triage sweeps. It is not
enough for any workload whose *shape is discovered while running it* — proof search, dependency
resolution, open-ended decomposition.

Lifting the depth restriction alone would be actively harmful. Depth without a stopping judgment is
breadth-first flailing, and the reference implementation demonstrates this: its README instructs
users to buy a higher rate-limit plan, start with 3-5 workers, and "watch for loops … agents
repeatedly backtracking on the same goals." That is a scheduling defect reported as a billing
caveat. **The judgment is the feature; the depth is the enabler.**

## What exists today (verified against `main`, 2026-07-24)

Every claim below was read from source this session. This matters because the roadmap on this epic
has gone stale once already.

| Capability | State | Evidence |
|---|---|---|
| Runtime-determined fan-out width, **uncapped** | **Exists** | `ts/src/engine/engine.ts:975-990` — `resolveFanoutOver` → runtime array, items materialised from it; no `K`, no cap |
| Subflow child state materialised at runtime | Exists | `engine.ts` `state.sub = { input, steps }` |
| Bounded convergence loop | Exists, `do`-steps only | `IterateSchema { max, until }`; step-kind allowlist grants `iterate` to `do` only |
| Deterministic predicates | Exists | `EnsurePredicateSchema`: `expr` / `file_exists` / `file_contains` |
| LLM predicate judge | Exists, **boolean only** | `judged.ts` — `JudgedResult { holds, reason, … }`; `judgedResultSchema` is strict `{ holds, reason }` |
| Judge as an injected port | **Exists** | `engine.ts:171` — injected runner, fail-closed when absent; three impls (`judged`, `codex_judged`, `fixture_judged`) |
| Stakes tiering | Exists | `STAKES_MODEL`: `cheap` / `default` / `paranoid` → model + reasoning effort |
| Budget enforcement | Exists | `BudgetSchema`: `usd`, `tokens`, `dispatches`, `ms`, at flow / subflow / step |
| Recursive or nested expansion | **Blocked, three ways** | `ir/validate.ts:539` `SUBFLOW_RECURSIVE` (no self-calls); `ir/validate.ts:565` `SUBFLOW_BODY_RESTRICTED` (non-entry flows are task-only); `FanoutStageSchema` is **`do`-only** — a lane cannot invoke a flow at all |
| Calling an external program from a predicate | **Absent** | `EnsurePredicateSchema` has exactly four variants; none invokes a command |
| A non-failure way to stop | **Partly exists** | `RunStatus` is `running \| completed \| failed \| budget_exhausted` — a non-failure terminal already exists (`state.ts:6-7`). `StepStatus` adds `waiting_gate`; `BgStatus` adds `paused_gate` and `cancelled`. S5 extends a precedent rather than inventing one. |
| Scope-aware fan-out scheduling | **Absent — the S2 blocker** | `scheduleFanout(run, stepId)` takes no scope; resolves from the entry flow and keys on `run.steps[stepId]` (`engine.ts:1069-1085`). Readiness collection scans root fanouts only. |
| Fan-out item owning subflow state | **Absent** | only `StepState` has `sub`; `FanoutItemState` has no child scope (`state.ts:33-55`, `124-151`) |

**Stale row.** `STRAT-WORKFLOW-PIPELINE-FANOUT-DYNAMIC` is filed PLANNED as "unbounded — needs mid-run
task injection into `ParallelExecutor`'s construction-fixed task set." That constraint was **Python**.
The TS engine does not construct a fixed task set. The row appears closed-by-port and should be
reconciled rather than built. This would be the ninth instance of the pattern in
`feedback_verify_roadmap_rows_vs_disk`.

## The insight: the evaluator returns the expansion

The design turns on one observation about the reference domain, which generalises.

Lean does not merely verify. Its LSP tactic state **enumerates the remaining proof obligations** —
apply a tactic, and Lean hands back the exact list of subgoals it left open. The decomposition is
not a judgment call. It is a deterministic consequence, produced free, and always correct.

So the loop separates cleanly:

| Operation | Decided by | Kind |
|---|---|---|
| Which tactic to attempt | agent | judgment |
| **What obligations that attempt leaves** | **the domain tool** | **deterministic, enumerated** |
| Whether the goal is closed | the domain tool | deterministic |
| Keep descending here, or climb back and try otherwise | **judge** | judgment |

This generalises past Lean. A type-checker returns the errors it could not resolve. A test runner
returns the failing cases. A build system returns unsatisfied dependencies. In each, the tool that
answers *"did it work?"* also answers *"what is still open?"* — in the same call.

Therefore the external evaluator is not an oracle bolted beside the engine. **It is the expansion
function.**

### Central claim, as corrected by R1

The original draft went one step further and claimed the recursion driver was therefore *free* — that
`children` simply feeds `fanout.over`, so this is a port rather than a scheduler. **That was wrong,
and it was the load-bearing sentence.** Stated precisely:

- **Still true:** an evaluator can produce an array suitable as fan-out input, and at the *root* that
  array drives an uncapped fan-out today with no engine change.
- **False:** that this composes into recursion for free. Fan-out scheduling is root-only —
  `scheduleFanout(run, stepId)` receives no scope and resolves its step from the entry flow
  (`engine.ts:1069-1085`). A fan-out inside a subflow would be marked `running`, never found by the
  scheduler, and never executed. Nested expansion needs **scope-aware scheduling**: new engine
  machinery, not three validator relaxations.

The honest framing: S1 is a genuinely small, independently valuable port. S2 is a real engine change,
and this design previously understated it by roughly an order of magnitude.

## Design

Five slices. S1 and S2 are the capability; S3-S5 make it affordable and honest.

### S1 — The evaluator port

A step may delegate to an external program, server-invoked, and receive a structured verdict.

- New step kind (`evaluate:`) declaring a command, an input binding, and a timeout.
- Contract — to live at `contracts/evaluator-result.json`, referenced, not described in prose:
  `{ status: "closed" | "open" | "failed", children: [...], reason: string, score?: number, route?: "claude" | "codex" }`
- Invoked **by the engine**, not by an agent. This is the trust anchor: a proof system that takes an
  agent's word for whether it proved something is not a proof system. Same reasoning as compose's
  `server_file_exists` edge predicates.
- `children` is the fan-out source for S2. `score` and `route` are optional and feed S4.
- Failure modes are first-class: non-zero exit, timeout, unparseable output → typed failure, never a
  silent `closed`.

**Why a new step kind rather than a fifth `ensure` variant:** `ensure` predicates answer a boolean
about a step's *own* output. An evaluator produces *new work*. Overloading `ensure` would give it a
second, incompatible return shape.

### S2 — Recursive expansion

Depth is blocked in three independent places, and **all three must move**. An earlier draft of this
design tried to preserve `SUBFLOW_RECURSIVE` and derive depth purely from evaluator-fed fan-out;
that does not work. With no self-reference and lanes unable to invoke flows, depth would still be
bounded by the count of authored flows — fixed-depth nesting, which this feature exists to escape.

1. **`FanoutStageSchema` gains `run` / `with`.** A lane must be able to invoke a flow, not only a
   task. Today `do` is required and there is no `run`.
2. **Relax `SUBFLOW_BODY_RESTRICTED`** (`validate.ts:565`) to permit `fanout` and `run` in non-entry
   flows.
3. **Lift `SUBFLOW_RECURSIVE`** (`validate.ts:539`) for flows reached through a fan-out lane, so a
   flow may re-enter itself once per level of discovered structure.

**R1 added a fourth, and it is the blocker.** Fan-out scheduling is root-only. `scheduleFanout` takes
no scope, resolves its step from the entry flow, and keys its dedupe on `run.steps[stepId]`
(`engine.ts:1069-1085`); readiness collection scans root fanouts only. A nested fan-out would go
`running` and never execute. **Scope-aware scheduling is therefore the substance of S2** — the
validator relaxations are the easy part. It also drags in item-owned subflow state
(`FanoutItemState` has no `sub`), recursive scope IDs, and recursive traversal.

**The termination guarantee changes hands, and it needs two bounds, not one.** Today termination is
free: the call graph is statically acyclic, so validation proves it. Once a flow may re-enter itself
that proof is gone, and R1-2 showed a depth cap alone does not replace it — the engine materialises
one item per array element *before* dispatch, so with uncapped width, work grows as B^D. A depth of
12 with a branching factor of 20 is not a bound in any useful sense.

So S2 requires:

- **A depth bound**, expressed as a **scope invariant, not a budget axis** (R1-4). Depth is
  path-local: it rises and falls as the tree is walked, and siblings at one depth must not sum into
  "depth spent". Every existing budget key is monotonically debited spend, so cohabiting would be a
  category error even though the ledger is convenient.
- **A width or node-materialisation bound**, which the original draft lacked entirely. Without it the
  depth cap is not a failsafe against runaway work, only against runaway *nesting*.

Both must hold on replay and resume, not only first execution.

Nested gates are a known unsolved edge: the scoped gate state machine supports one-level subflow
gates only. v1 rejects gates below depth 1 at validation rather than guessing at a propagation
protocol.

**How S1 feeds S2, concretely:** one turn of the loop is agent attempts → evaluator returns
`{ status, children }` → **engine branches on `status`** → if and only if `open`, fan out over
`children`, each lane re-entering the flow at depth + 1.

The `status` branch is not optional decoration (R1-3). Binding `children` to `over` and ignoring
`status` would recurse on `closed` and on `failed` alike, and would leave `open` with an empty
`children` to be interpreted by `require` semantics — where empty `all` succeeds vacuously while
empty `any` fails. The contract needs cross-field invariants (`closed` ⇒ no children; `open` ⇒ at
least one) and an explicit status→engine transition table.

### S3 — Backtrack

Retrying a decomposition differently is the "climb back up" half, and it has no expression today:
`iterate` is granted to `do` steps only.

- Permit `iterate { max, until }` on `fanout` steps: when the fan-out's `require` is unsatisfied,
  retry the decomposition rather than failing outright.
- **Name the reset target — the agent-attempt step, never the evaluator (R1-6).** This is the
  sharpest R1 catch. `iterate` today re-pends *the same step* and feeds it its own prior failure. But
  the evaluator is deterministic: re-running it reproduces byte-identical children and the loop spins
  to `max` achieving nothing. The only reset that changes the outcome is the step that *chose the
  tactic*. Backtrack is therefore not "iterate on the fanout" — it is "invalidate this subtree and
  re-pend its producing attempt".
- Two current behaviours must change, not just be reused: unmet `require` takes the failure/`on_fail`
  path immediately with no redispatch, and `iterate`'s reset target is itself.
- The children of a superseded attempt must be cancelled and recorded, not orphaned.
- Backtrack is bounded by `iterate.max` and debits the same budget as everything else.

### S4 — The judge, narrowed

The judge answers exactly one question: **continue descending, or abandon this branch?**

- Extend the judged result with an optional `score`, and add a threshold at which a branch is
  abandoned. Preserve `{ holds, reason }` for existing predicates — this must be additive.
- **Evaluate cheap-first.** Deterministic predicates and evaluator-supplied `score` resolve before
  any LLM judge runs. This is the one lesson worth taking from the reference implementation, which
  resolves most goals with free syntactic checks and pays for a model only on the residual. Promotes
  the parked `idea_tiered_gate_evaluation` from idea to shipped behaviour.
- `route` lets the evaluator pick the agent (`claude` / `codex`), which is far cheaper than ranking.
  **Correction (R1-8):** the original claim that this "targets a field that already exists" was
  wrong. `agent` exists per step and per fan-out stage but is a *static enum* read as
  `stage.agent ?? "claude"`. A returned `route` needs a new dynamic binding and validation rule.
  Likewise `contractForStep` recognises only `do`/`set`/`fanout`/`run`, so a repo-level
  `contracts/evaluator-result.json` is not automatically in a spec's contract map — S1 must say how
  `evaluate.output.children` becomes a valid typed reference.
- **Abandonment needs an outcome algebra, and there isn't one (R1-6).** Fan-out items are only
  `succeeded` / `failed` / `skipped`, and `require: all` counts an abandoned item as batch failure.
  "Pruned deliberately" and "failed" must be distinguishable or the judge cannot be a control
  surface at all.
- **Deferred for v1, on a weaker argument than before:** no frontier, no priority queue, no
  best-first scheduling. The original justification — that a hard depth cap bounds total work, making
  ranking merely an efficiency concern — **was retracted by R1-2**: depth does not bound work when
  width is uncapped. The deferral now rests entirely on the node-materialisation bound in S2. If that
  bound is not built, ranking moves from efficiency to safety and this non-goal must be revisited.

### S5 — Ending without succeeding

*"Searched within the budget you set, found no proof"* is a result, not an error, and conflating the
two destroys the most valuable output — the partial tree.

- A terminal `inconclusive` status, distinct from `failed`, carrying a structured partial result:
  what closed, what remains open, why it stopped.
- **The precedent is in-engine already (R1-9).** An earlier draft claimed failure was Stratum's only
  way to stop short. False: `RunStatus` already includes `budget_exhausted`, and `BgStatus` adds
  `paused_gate` and `cancelled`. So this slice extends an accepted pattern rather than introducing
  one — which makes it easier than originally framed.
- The richer precedent for *carrying what was learned* is **compose's** judgment joint machine
  (`lib/judgment-write-guard.js`, a different repo — R1 looked for it in stratum's guard and
  correctly did not find it). There `inconclusive` is a first-class state whose edge demands
  `resolution { outcome: inconclusive, learned, would_have_settled }` — a recorded finding, not a
  failure. Worth copying the shape, explicitly not the code.
- **Resumable**: the partial tree is a checkpoint. Raise the cap, continue, do not restart.

**Corrected dependency (R1-7).** An earlier draft claimed resumption was blocked on
`STRAT-WORKFLOW-RESUME`, "filed and unbuilt". Both that feature and `T2-F5-RESUME` are **COMPLETE
(2026-05-31)**, and neither is the mechanism needed here: resume implements content-addressed result
caching, and `resume` accepts only a `runId`, returning immediately for any run not marked `running`.
So "raise the cap and continue" needs a **new mutation-or-clone protocol** on a terminal run — it
cannot ride existing resume. This is larger than the original framing, not smaller.

**Also in scope (R1-9):** `inconclusive` is not merely a new `RunStatus`. Every strict response
variant in `ts/contracts/mcp-surface.json` — plan, step-done, revert, resume, audit, poll, bg-poll —
default-denies undeclared statuses, so each must admit it. The upside is that `budget_exhausted`
already proves the pattern is acceptable in this engine.

## S1 Implementation Blueprint (added 2026-07-24 after source-code review)

Read against `main` before writing code. The design's prose could not be taken literally — the
name `evaluator` already means something else in this engine. Corrections table first.

| Spec assumption | Actual code | Correction |
|---|---|---|
| "the evaluator" is the S1 external-program concept | `Evaluator` / `EvaluatorContext` (`engine.ts:18-35`, `eval/expr.ts`) is the **expression evaluator** — it evaluates `when` / `expr` / `until`. Required option `evaluator:`. | S1's port is named **`EvaluateRunner`**, its result **`EvaluatorResult`**, its step kind **`evaluate:`**. The name `Evaluator` is never reused. |
| Contract lives at file `contracts/evaluator-result.json`, "referenced, not prose" | Spec contracts are an **inline `contracts:` map** in the spec (`schema.ts:114-118`, `CONTRACT_NAME = /^[A-Z][a-zA-Z0-9_]*$/`). `ts/contracts/*.json` are engine-internal (events, mcp-surface), not spec contracts, and are not loaded into a spec's contract map. | The engine owns a **fixed** `evaluatorResultSchema` (zod) — this is the trust anchor and the source of the typed failures; it does not depend on author declaration. `ts/contracts/evaluator-result.json` ships as the **canonical documented shape** authors copy into their own `contracts:` map when they want to reference fields. |
| "new step kind declaring a command, input binding, timeout" | A step kind is four coordinated edits: a field on `StepShape`, membership in the `kinds` list, a `STEP_FIELDS` allow-list row, and superRefine rules (`schema.ts:53-100`). | Add an `evaluate` object field carrying `{ command, in, timeout_ms }`; register it in all four places. |
| "Invoked by the engine, not an agent" | Server-side kinds (`set`/`run`/`fanout`) are handled in `advanceScopeLoop` **before** the `do` guard at `engine.ts:1031` (`"construct is outside P1 engine scope"`). `do` is the only agent-dispatched kind. | Add an `if (step.evaluate !== undefined)` branch just above line 1031. `await` the runner inline and settle like an async `set` (validate output, set `state.output`, run ensures, `succeeded` / typed `failAttempt`). Persist **only** the terminal outcome — no intermediate `running` — so a crash mid-evaluate leaves the step `pending` and it re-runs, matching `set`'s atomicity and keeping resume trivial. (Concurrency with sibling steps is an S2 concern, explicitly not S1.) |
| injected external program | Precedent is `judge?: JudgeRunner` (`engine.ts:172`), absent ⇒ fail **closed** (`engine.ts:1651-1652`). | `evaluateRunner?: EvaluateRunner` option, absent ⇒ distinct typed fail-closed (`evaluate: no evaluate runner configured`). Default `createEvaluateRunner()` spawns the command with the timeout; wired into `StratumEngine` construction in `cli/stratum.ts:234`, `mcp/server.ts:83`, `cli/query_gate.ts:307` exactly where `createEvaluator()` already is. |
| `evaluate.output.children` becomes a typed reference (R1-8) | `contractForStep` (`validate.ts:296-301`) recognises `do`/`set`/`fanout`/`run` only. | Add `if (step.evaluate !== undefined) return step.out;`. `out` is optional on `evaluate` (like `do`); referencing a field of an evaluate step with no `out` fires the existing `REF_OUTPUT_CONTRACT_REQUIRED` (`validate.ts:397`) for free. The author's `out` contract governs what is **referenceable**; the engine's fixed schema governs what the **data** must be. That separation is deliberate — an author cannot loosen the trust schema by declaring a weaker `out`. |

**Trust / typed-failure taxonomy (acceptance criterion 2).** The runner reports a *transport* outcome
distinct from the evaluator's *domain* verdict. Five distinct typed failures, none of which can be
mistaken for a `closed` verdict:

1. no runner configured (fail-closed)
2. non-zero exit
3. timeout
4. stdout not valid JSON
5. JSON valid but fails `evaluatorResultSchema` (incl. cross-field invariants: `closed` ⇒ empty `children`; `open` ⇒ non-empty `children`)

A domain verdict of `status: "failed"` is **not** an engine failure — it is a well-formed result and
becomes the step's `output`. The step *succeeded at running the evaluation*; the verdict is the payload.
The `status` → engine transition (does `open` recurse? does `failed` route to `on_fail`?) is **S2's**
job (the transition table in R1-3), explicitly out of S1 scope. For S1 an evaluate step **succeeds**
iff the runner returns a contract-valid result, and typed-**fails** on 1-5 above.

**Files:** `ir/schema.ts` (EDIT — kind), `ir/validate.ts` (EDIT — `contractForStep`, STEP_FIELDS parity),
`engine/engine.ts` (EDIT — types, option, branch, `evaluatorResultSchema`), `engine/evaluate.ts` (NEW —
`createEvaluateRunner`, spawn + timeout + parse, mirrors `eval/expr.ts` export style),
`cli/stratum.ts` · `mcp/server.ts` · `cli/query_gate.ts` (EDIT — wire the port),
`ts/contracts/evaluator-result.json` (NEW — canonical shape). Tests: happy path, all five typed
failures, `closed`-never-synthesised-on-failure, and a contract-ref-through-`out` typing test.

### S1 implementation review (R2, Codex sol/xhigh, 2026-07-24)

6 findings; 4 real and fixed with tests, 1 already fixed, 1 refuted.

| # | Finding | Disposition |
|---|---|---|
| 1 | The engine trusted the runner's `ok` discriminant without runtime validation — a malformed envelope (`ok: "false"`) could launder a `closed` payload through. | **FIXED.** `evaluateRunResultSchema` (discriminated union) validates the whole envelope at runtime, same trust posture as the judge verdict. Test: "rejects a malformed runner envelope". |
| 2 | A thrown/rejected runner escaped as an unhandled `plan()` rejection instead of a typed failure; resume would repeat it. | **FIXED.** The runner call is wrapped in try/catch → typed `runner threw` failure. Test: "converts a thrown runner into a typed failure". |
| 3 | Closed-stdin EPIPE could crash the engine process. | **ALREADY FIXED** pre-review (self-adversary pass): `child.stdin.on("error", …)` swallows it. |
| 4 | Timeout killed only `/bin/sh`, orphaning backgrounded grandchildren holding stdio. | **FIXED.** Spawn `detached`, `process.kill(-pid)` the group on timeout. Test: "kills backgrounded grandchildren when the command times out". |
| 5 | `evaluate.in` references were collected by the validator but NOT by the engine's own dependency mirror (`stringLeaves`), so an evaluate step bound to a prior step's output ran before that output existed and failed terminally. | **FIXED** (the sharpest catch). Added `evaluate.in` to `stringLeaves`. Test: "waits for a step referenced by its input binding". |
| 6 | No `ensure` settlement on evaluate steps. | **REFUTED.** Deliberate scope decision — `ensure` was intentionally excluded from the evaluate field allowlist; it is not in S1's acceptance criteria, and the trust schema + `out` contract already validate the output. Not a defect. |

## Non-goals

- Best-first search, priority queues, frontier re-ranking (deferred; see S4).
- Unbounded recursion. `SUBFLOW_RECURSIVE` is lifted only for flows reached through a fan-out lane,
  and only under an enforced `depth` budget. Arbitrary mutual recursion in ordinary `run:` steps
  stays rejected.
- Any Lean, Mathlib, or theorem-proving knowledge inside Stratum. The domain lives entirely behind
  the S1 evaluator contract. If Stratum ever imports a Lean concept, this design has failed.
- Porting lean-collab. It is a consumer and a test case, not a deliverable.

## Sequencing

| Slice | Depends on | Rationale |
|---|---|---|
| S1 evaluator port | — | The trust anchor and the expansion function. Independently useful to any workload with a test runner, compiler, or linter. **The only slice R1 left intact.** |
| S2 recursion | S1 | Needs a source of children worth recursing on. **Re-scoped by R1 from "three validator relaxations" to scope-aware fan-out scheduling + item-owned subflow state + two independent bounds.** Sizeable engine work; deserves its own design pass before any plan. |
| S3 backtrack | S2 | Only meaningful once there is a subtree to abandon. |
| S4 judge | S2 | Only meaningful once branches compete. |
| S5 inconclusive | S2 | Only meaningful once a run can legitimately not finish. |

S1 ships alone and earns its keep alone. That is deliberate: it is the slice most likely to be
useful if the rest is never built.

## Acceptance criteria

- [x] S1: an `evaluate:` step invokes a declared command server-side and validates output against
      the engine-owned `evaluatorResultSchema` (documented canonically in `ts/contracts/evaluator-result.json`)
- [x] S1: no runner, non-zero exit, timeout, unparseable output, and contract-invalid output each
      produce a distinct typed failure; none can yield `status: "closed"`
- [ ] S2: a fan-out lane may `run` a flow (`FanoutStageSchema` accepts `run` / `with`)
- [ ] S2: a non-entry flow may declare `fanout` and `run`
- [ ] S2: a flow reached through a fan-out lane may re-enter itself; a self-call in an ordinary
      `run:` step is still rejected by `SUBFLOW_RECURSIVE`
- [ ] S2: an evaluator's `children` array drives a fan-out without an author-declared cap
- [ ] S2: exceeding the `depth` budget terminates the run and is reported as a cap hit, not a defect
- [ ] S2: the `depth` budget is enforced on replay and resume, not only on first execution — a run
      resumed near its cap cannot exceed it
- [ ] S2: a gate below depth 1 is rejected at validation time with a named error
- [ ] S3: `iterate` is accepted on a `fanout` step; an unsatisfied `require` re-runs the producer
      with feedback, and superseded children are cancelled and recorded
- [ ] S4: `{ holds, reason }` judged predicates behave byte-identically to today
- [ ] S4: deterministic predicates and evaluator `score` are evaluated before any LLM judge; a branch
      resolved by a free check costs zero tokens
- [ ] S5: a run that exhausts its cap terminates `inconclusive`, not `failed`, and its partial result
      names what closed and what remains open

## Open questions

1. **Does `depth` belong in `BudgetSchema`?** Every current axis is a cost that accrues monotonically
   and is *spent*; depth is a structural bound that rises and falls as the tree is walked. Sharing an
   exhaustion path with `tokens` may be actively wrong — "spent 12 of 12 depth" is not a meaningful
   sentence. The convenience is real (one ledger, one enforcement site, resume already threads it) and
   so is the category error. This is the single most likely thing in this design to be wrong.
2. **What cancels a subtree?** S3 requires cancelling in-flight descendants of a superseded attempt.
   The engine cancels fan-out siblings under `require`, but subtree cancellation across depth is
   unproven.
3. **Sandboxing for S1.** The evaluator is a user-declared command run by the engine. Worktree
   isolation exists for fan-out; whether an evaluator inherits it is undecided.
4. **Is `decomposer.md` evidence against itself?** The reference implementation carries a 23 KB
   decomposer prompt for work Lean appears to enumerate for free. Worth confirming before citing
   this design's central claim as settled — it may be doing tactic *selection*, which is judgment,
   rather than decomposition.
