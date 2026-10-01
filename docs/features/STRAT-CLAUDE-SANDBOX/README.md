# STRAT-CLAUDE-SANDBOX — enforced isolation for Claude agent runs

**Status:** PLANNED (filed 2026-10-01 by owner decision; no work started).
**Origin:** SmartMemory FULL-ALIGN-1 P0 capability probe,
`smart-memory-docs/docs/features/FULL-ALIGN-1/ring1-plan/pipeline/p0-probe.md`.

## Problem (verified 2026-10-01)

- `ts/src/connectors/runner.ts:276` rejects `networkAccess` (and `writableRoots`, `approvalPolicy`) for `agent=claude`.
- `ts/src/connectors/background.ts:462` resolves `sandboxMode` for Claude background runs but never forwards it into
  `connectorOptions` (`:466-475`).
- Probe run `8e399def1365`: a Claude background run reached `https://example.com` (HTTP 200). A write outside the
  workspace was refused only by Claude Code's acceptEdits path check, not by any OS sandbox. No `sandboxAudit` is
  recorded for Claude runs. Codex runs (`75f733d4d34d`) were OS-blocked on both.

## Proposed fix

The Claude Agent SDK exposes `sandbox?: SandboxSettings` (allowed write paths, allowed network domains; SDK 0.3.206
`sdk.d.ts:1817`). Map Stratum's `sandboxMode` / `networkAccess` / `writableRoots` onto it, stop rejecting them for
Claude, and emit the same `sandboxAudit` (policy + provenance) Codex runs return. Acceptance: the P0 isolation probe
(outbound curl + outside-workspace write) fails for Claude with `networkAccess:false`, and the audit shows the policy.

## Interim rule (consumers)

Until this ships, Claude-authored work gets no sensitive packets (FULL-ALIGN-1 design.md §5).
