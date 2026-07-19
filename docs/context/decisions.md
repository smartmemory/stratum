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

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 5: r4 fixes verified. ONE remaining P1 + one clarity fix (detail in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r5.md): vi.mock('node:worker_threads') hoists module-wide, so the mocked-Worker interleaving tests and the real-Worker env-stub tests cannot share one test file as currently specified (and blueprint.md:916's blanket env instruction contradicts :926/:939). Split the mocked tests into a separate file (background-claude-interleavings.test.ts) and scope the env seam to the real-Worker file — simplest vitest-idiomatic fix. Also spec the cancel-in-flight fixture's terminate() to emit exit and resolve its promise, since cancelBackgroundRun awaits it (otherwise the test hangs). Nothing else.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 6: the r5 split is correct; 2 remaining P1s are wording/placement fallout (detail + prescribed fixes in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r6.md): (1) rescope the env-seam wording to 'real-Worker test files (7c and 7d)' — 7e is the only file where it must not be set — resolving the 7c-only vs 7d contradiction; (2) move the stderr-plumbing test from 7e (mocked Worker — real worker never runs, nothing can write .err) into 7c, and add a STRATUM_TEST_WORKER=fail mode to Step 3's env seam (run() throws before the sentinel → catch writes .err + rc=1 sentinel) to drive it. Nothing else.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** revise
**Rationale:** Codex plan-gate review round 7: everything verified except TWO literal wording edits (exact replacements in docs/features/STRAT-AGENT-BG-WRITE-1/plan-review-r7.md): (1) blueprint.md:921 'this file only' → 'real-Worker test files (7c background-claude.test.ts and 7d agent-run.test.ts)'; (2) blueprint.md:998 and :1053 → 7e prohibits STRATUM_TEST_WORKER entirely (any value), not just =1. Apply exactly these two edits and nothing else.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — design_gate
**Outcome:** approve
**Rationale:** design.md r5 unchanged since codex REVIEW CLEAN (5 gate rounds in prior flow b0a68e21, killed only by the flow-level max_rounds exhaustion — see stratum 84cc343 and compose #48). Findings trail: design-review-r1..r4.md. Approving the settled artifact.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan
**Outcome:** complete
**Rationale:** plan.md committed and current at 84cc343. Went through 7 plan-gate review rounds in prior flow (all findings resolved): stderrPath plumbing in Task 2f/3, sync-path discriminant validation in Task 4c, 4 D9 callback-order interleaving tests in Task 7c, concrete MCP-surface test cases in Task 7d, vi.mock/env-seam split into background-claude-interleavings.test.ts (Task 7e), env seam scoped to real-Worker files (7c+7d), 7e prohibits STRATUM_TEST_WORKER entirely. Prior flow failed only at gate-revision-rounds exhaustion after round 7 revise applied 2 literal wording edits — plan artifact is settled.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — plan_gate
**Outcome:** approve
**Rationale:** Codex plan-gate round 8: REVIEW CLEAN. The two r7-prescribed wording edits verified correctly applied at 84cc343 with no other blueprint changes and no new contradictions. Plan approved after 8 total review rounds (findings: 4→4→2→1→1→2→2-wording→0). Proceed to decompose/implementation.

## [2026-07-18] STRAT-AGENT-BG-WRITE-1 — execute_merge
**Outcome:** revise
**Rationale:** MERGE_WITNESS_PRECOMPUTE_FAILED: consumer merge witness precompute failed: Command failed: git apply --cached --binary -
error: patch failed: ts/contracts/mcp-surface.json:149
error: ts/contracts/mcp-surface.json: patch does not apply
