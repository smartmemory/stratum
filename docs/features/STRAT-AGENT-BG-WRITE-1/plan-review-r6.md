# Plan-gate review round 6 (codex gpt-5.6-terra/high) — REVISE

Split itself is correct (7c unmocked, 7e owns the hoisted mock, cancel fixture emits exit synchronously then resolves). 2 remaining P1s — both wording/placement fallout from the split:

1. **P1 — env-seam scoping contradiction.** 7d still requires STRATUM_TEST_WORKER=1 (blueprint.md:958, :967) while 7c says "this file only" and 7e says the seam belongs only to background-claude.test.ts. Fix the WORDING, not 7d's usage: scope the env seam to "real-Worker test files (7c background-claude.test.ts AND 7d agent-run.test.ts)", with 7e (mocked Worker) the only file where it must NOT be set.
2. **P1 — 7e's stderr-plumbing test cannot execute under the module-wide Worker mock** (the real claude-bg-worker.ts never runs, so nothing writes .err; blueprint.md:1033). Fix: MOVE the stderr test to a real-Worker file (7c) and add a failure mode to the env seam — e.g. STRATUM_TEST_WORKER=fail makes the worker's run() throw before the sentinel, driving the catch block to write .err and the rc=1 sentinel. Spec that mode in Step 3 alongside the '1' mode.
