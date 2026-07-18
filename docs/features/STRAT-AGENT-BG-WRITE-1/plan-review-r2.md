# Plan-gate review round 2 (codex gpt-5.6-terra/high) — REVISE

plan.md resolves all 4 r1 findings. blueprint.md was NOT updated to match — fix blueprint.md ONLY (plan.md is settled):

1. **P1 — stderr plumbing absent from blueprint.** WorkerInput lacks stderrPath, workerData construction omits it, worker catch writes only JSONL — following the blueprint would never write .err. Mirror plan Task 2f/Task 3. (blueprint.md:279, :312, :564)
2. **P1 — sync-path discriminant validation missing from blueprint.** Step 4 jumps 4b→5; no runAgent() guards, no foreground rejection tests. Mirror plan Task 4c. (blueprint.md:647; design.md:286)
3. **P1 — D9 callback-order tests absent from blueprint 7c.** Only generic/start-validation cases; missing synchronous exit-after-terminate (exactly one rc=130 sentinel), cancellation-suppressed exit/error handlers, exactly-once registry deletion. Mirror plan Task 7c. (blueprint.md:817; plan.md:534)
4. **P2 — Task 7d (public MCP/command-seam tests) not described in blueprint.** It jumps from 7c to the file summary; the public-surface coverage is non-executable from the blueprint. Mirror plan Task 7d mechanics (ts/tests/mcp/agent-run.test.ts). (blueprint.md:873; plan.md:548)
