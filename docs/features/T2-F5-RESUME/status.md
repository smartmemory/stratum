# T2-F5-RESUME — Status

**COMPLETE (2026-05-31).** Implemented on branch `t2-f5-resume`. Full suite green (1242 passed, 2
skipped). Codex impl review CLEAN @ round 2. See [report.md](./report.md).

## What shipped
Live-process reparenting for server-dispatched codex tasks — they survive an MCP server restart and a
fresh `ReattachReader` recovers the result from the durable stream the detached child kept writing.
Slices S1–S6 all delivered (design + blueprint were gate-clean; plan + impl Codex-reviewed clean).

- **Design/blueprint/plan/report:** in this folder. **Spike:** `spike/` (PASS, the proven primitive).
- **CHANGELOG:** entry under `## [Unreleased]` → `feat(T2-F5-RESUME)`.
- **Code:** `connectors/codex.py`, `connectors/factory.py`, `executor.py`, `parallel_exec.py`,
  `server.py`, new `proc_identity.py`. **Tests:** `test_codex_durable`, `test_reattach`,
  `test_t2f5_executor`, `test_t2f5_surfaces`, `test_t2f5_survival`.

## Follow-ups (out of v1 scope, named in design)
claude in-process resume · opencode reparenting · `stratum_agent_run` durable record ·
content-addressed replay (forge-top `STRAT-WORKFLOW-RESUME`, which extends this) · Windows/cross-host ·
reattach re-emits already-seen wire events (incremental-offset optimization deferred).
