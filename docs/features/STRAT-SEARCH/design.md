# STRAT-SEARCH — Design

**Status:** Phase 1 design (2026-07-24). **Not yet design-gated.** Origin: evaluating
`mutable-state-inc/lean-collab` (MIT, multi-agent Lean 4 theorem proving) as a consumer, and finding
that the orchestration it hand-rolls is mostly primitives Stratum already has — plus three it does not.

**Maturity is uneven and deliberately so.** S1 and S2 are designed to the point of being buildable.
S3-S5 are scoped and justified but not worked through; each needs its own pass before implementation.
Read the sequencing table as an epic shape, not a plan. One contradiction was already caught and
fixed in self-review (see S2's opening paragraph) — assume more remain, and gate accordingly.

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
| A non-failure way to stop | **Absent** | step status is `pending \| ready \| running \| succeeded \| failed \| skipped`; budget exhaustion routes through `terminalBudget` as failure |

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
function.** And its output lands on machinery that already exists: the `children` array it returns
*is* a `fanout.over` array.

That is what makes this feature small enough to be worth doing. The recursion driver is not new
scheduling logic; it is an existing uncapped fan-out, fed by a new port.

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

**The termination guarantee changes hands, and this is the crux of the slice.** Today termination is
free: the call graph is statically acyclic, so validation proves it. Once a flow may re-enter itself,
that proof is gone and something must replace it. That replacement is the `depth` budget — a new
axis alongside `usd` / `tokens` / `dispatches` / `ms`.

So `depth` is a failsafe against infinite iteration in exactly the sense intended: the judge (S4) is
the control surface and should end branches long before the cap is approached, and a run that hits
the cap has usually revealed a bad judge rather than a hard problem. But it is **load-bearing, not
decorative** — it is the only thing standing where static acyclicity used to stand. It must be
enforced unconditionally, on every path, including replay and resume.

Nested gates are a known unsolved edge: the scoped gate state machine supports one-level subflow
gates only. v1 rejects gates below depth 1 at validation rather than guessing at a propagation
protocol.

**How S1 feeds S2, concretely:** an `evaluate:` step's `children` array is bound as the `over` source
of a following `fanout` step, whose lanes `run` the same flow that produced them. One turn of the
loop is: agent attempts → evaluator returns `{ status, children }` → fan-out over `children` → each
lane re-enters the flow. Depth grows by one per turn and is charged against the `depth` budget.

### S3 — Backtrack

Retrying a decomposition differently is the "climb back up" half, and it has no expression today:
`iterate` is granted to `do` steps only.

- Permit `iterate { max, until }` on `fanout` steps: when the fan-out's `require` is unsatisfied,
  re-run the producing step with feedback so the agent attempts a different decomposition.
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
- `route` lets the evaluator pick the agent (`claude` / `codex`), which is far cheaper than ranking
  and targets a field that already exists per step and per fan-out stage.
- **Explicit non-goal for v1:** no frontier, no priority queue, no best-first scheduling. Fan-out
  remains a batch primitive. With a hard depth cap bounding total work, ranking is an *efficiency*
  optimisation, not a *safety* requirement. Defer until a consumer proves batch-plus-pruning
  insufficient.

### S5 — Ending without succeeding

Today Stratum has one way to stop short: failure. For search that is wrong. *"Searched within the
budget you set, found no proof"* is a result, not an error, and conflating them destroys the most
valuable output — the partial tree.

- A terminal `inconclusive` status, distinct from `failed`, carrying a structured partial result:
  what closed, what remains open, why it stopped.
- Deliberately mirrors the judgment layer's joint machine, where `inconclusive` is first-class and
  its edge demands `resolution { outcome: inconclusive, learned, would_have_settled }`. That pattern
  has already been designed, shipped, and defended in this codebase.
- **Resumable**: the partial tree is a checkpoint. Raise the cap, continue, do not restart.

**Accepted dependency:** resumption collides with `STRAT-WORKFLOW-RESUME`, which is filed, unbuilt,
and blocked on `T2-F5-RESUME`. The owner has accepted this knowingly. It is recorded here so the
sequencing decision is explicit rather than smuggled in with S5.

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
| S1 evaluator port | — | The trust anchor and the expansion function. Independently useful to any workload with a test runner, compiler, or linter. |
| S2 recursion | S1 | Needs a source of children worth recursing on. |
| S3 backtrack | S2 | Only meaningful once there is a subtree to abandon. |
| S4 judge | S2 | Only meaningful once branches compete. |
| S5 inconclusive | S2 | Only meaningful once a run can legitimately not finish. |

S1 ships alone and earns its keep alone. That is deliberate: it is the slice most likely to be
useful if the rest is never built.

## Acceptance criteria

- [ ] S1: an `evaluate:` step invokes a declared command server-side and validates output against
      `contracts/evaluator-result.json`
- [ ] S1: non-zero exit, timeout, and unparseable output each produce a distinct typed failure; none
      can yield `status: "closed"`
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
