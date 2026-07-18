# Plan-gate review round 5 (codex gpt-5.6-terra/high) — REVISE

r4 fixes verified (Worker seam assigned to running/cancel tests, MCP follow-up expects 'complete', TODO removed). ONE remaining P1 + one clarity fix:

1. **P1 — the two seams cannot coexist in a single background-claude.test.ts.** vi.mock('node:worker_threads') is hoisted/module-wide, so it would replace Worker for the env-stub completion/meta tests too, preventing claude-bg-worker.ts from ever running. The blanket env instruction at blueprint.md:916 also contradicts the "do not set" instructions at :926 and :939. Fix: EITHER split the mocked-Worker tests into a separate test file (e.g. background-claude-interleavings.test.ts) with vi.mock, keeping the env-seam tests in background-claude.test.ts unmocked — OR spec vi.doMock + vi.resetModules + dynamic imports. Splitting files is simpler and matches vitest idiom; scope the env seam to real-Worker tests only.
2. **Clarity — cancel-in-flight fixture must define terminate() to emit exit and resolve its promise.** cancelBackgroundRun awaits terminate() before writing rc=130; "call cancel, then emit exit" is underspecified and can hang the test. (blueprint.md:932)
