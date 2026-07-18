# Decision Log

Decisions accumulate here during builds.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** revise
**Rationale:** Codex design-gate review round 1: 5 design-actionable findings (1 critical: claude sandboxMode declared but never enforced — claude.ts hardcodes acceptEdits; 2 high: cancel/exit sentinel race, contract arrays untyped; 2 medium: runner.ts bg_started pid contract, worker error containment). Full findings with file:line refs in docs/features/STRAT-AGENT-BG-WRITE-1/design-review-r1.md — read it and revise design.md to address all 5, verifying each claim against the cited source.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** revise
**Rationale:** Codex design-gate review round 2: 3 of 5 r1 findings resolved; 4 findings remain (full details in docs/features/STRAT-AGENT-BG-WRITE-1/design-review-r2.md — read it first). Key corrections: (1) 'string[]' is not valid mcp-surface grammar — use the structured shape {"$array": "string"}, which assertToolRequest already element-validates, dropping the need for optionalStringArray; (2) cancel must own the terminal record — worker can still commit rc=0 between scan and terminate, making cancel/poll disagree; (3) keep runtime validation of agent and sandboxMode discriminants when removing the codex-only guards; (4) delete claude worker registry entries at terminal, don't just mark dead.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** revise
**Rationale:** Codex design-gate review round 3: all 4 r2 findings verified resolved. ONE remaining high finding (full detail in docs/features/STRAT-AGENT-BG-WRITE-1/design-review-r3.md): terminal sentinel writes are still not serialized — error handler, exit handler, and concurrent cancels can each pass their own no-sentinel check and append, and scanStream takes the last sentinel, so terminal outcome is timing-dependent. Fix: one per-run finalization promise/lock on ClaudeBgEntry shared by error, exit, and cancel paths, committing at most one terminal record before registry deletion. This is the only change needed — do not rework the resolved sections.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** revise
**Rationale:** Codex design-gate review round 4: r3 finding resolved (claimFinalization serializes duplicate writes, no deadlock). ONE residual finding in the same seam (detail in docs/features/STRAT-AGENT-BG-WRITE-1/design-review-r4.md): a cancel that JOINS a pre-existing error/exit claim still returns 'cancelled' while the committed sentinel is rc=1, so cancel and poll disagree. Fix: claims must carry terminal ownership/outcome — cancel returns 'cancelled' only when it owns the rc=130 finalization; if it joins an existing claim it awaits, rescans, and returns already_complete/already_error. Add this interleaving to the test plan. Change ONLY this; everything else is settled.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** approve
**Rationale:** Codex design-gate review round 5: REVIEW CLEAN. D14 resolves the r4 cancel-ownership race (joined claims awaited+rescanned, 'cancelled' only from the owning path); diff confined to the seam, D9-D13 preserved; interleavings captured in the test plan. Five review rounds total: 5→4→1→1→0 findings. Design approved for PRD phase.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 1: 4 findings (3 P1, 1 P2), full detail in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r1.md — read it first. The plan under-delivers the approved design (do not change the design): (1) add runner.ts sync-path agent/sandboxMode validation + foreground rejection tests; (2) add worker stderr plumbing (.err path into WorkerInput, error-path assertion); (3) add the exact D9 callback-order interleaving tests (one rc=130 sentinel on synchronous exit-after-terminate, exit/error handler suppression under cancelling, single registry deletion); (4) turn the public-surface MCP tests and codex workspace-write command-seam flow from acceptance prose into concrete test-file tasks.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 2: plan.md resolves all 4 r1 findings, but blueprint.md was not updated to match — the implementer executes the blueprint, so the same 4 gaps live on there. Fix blueprint.md ONLY (plan.md is settled), mirroring plan Tasks 2f/3 (stderrPath plumbing + .err assertion), 4c (runAgent sync-path discriminant validation + rejection tests), 7c (the 4 D9 callback-order interleaving tests), and 7d (public MCP/command-seam test mechanics). Full detail with blueprint line refs in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r2.md.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 3: all r2 additions verified present. 2 remaining P1s in blueprint.md only (detail in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r3.md): (1) mirror the plan's normal-lifecycle test cases (plan.md:503-518 — sandbox positive/default, poll running/complete/error/restart, ordinary cancel/race) into blueprint Step 7c; (2) the worker test seam is unspecified — 7d requires STRATUM_TEST_WORKER=1 but Step 3 always invokes the real SDK query and 7c leaves the mechanism open. Choose ONE mechanism (env-gated stub query in the worker, or a Worker-constructor/entry-URL injection boundary matching the existing boundaries pattern in runner.ts), specify it concretely in Step 3, and make 7c/7d reference that same mechanism. Nothing else.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 4: r3 fixes verified. ONE remaining P1 + one cleanup (detail in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r4.md): the immediate-complete STRATUM_TEST_WORKER stub cannot produce a guaranteed running worker, so the poll-running and cancel-in-flight tests race the rc=0 path. Either extend the env seam with a held-worker mode (worker waits for a release file before writing the sentinel) or explicitly route the running/cancel-in-flight cases through the vi.mock Worker-constructor seam — pick one and spec it where those tests reference it. Also remove the superseded workerData-query TODO at blueprint.md:869 which contradicts the chosen seam. Nothing else.
