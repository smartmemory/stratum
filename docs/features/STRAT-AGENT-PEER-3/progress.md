# STRAT-AGENT-PEER-3 progress ledger

Recovery map: this file + `git log --oneline -- docs/features/STRAT-AGENT-PEER-3 ts/`. Plan: [plan.md](./plan.md). Design: [design.md](./design.md).

Loop per slice: Codex astra/medium implements → controller verifies (targeted tests, unsandboxed) → Codex astra/medium review → fix → controller commits. Full suite only at baseline and S5 end.

## Commits
- `148af46` design r3 + owner decisions
- `430ecd5` side fix: background Codex polls report cached tokens + estimated USD
- `af99636` plan (5 slices) + design corrections

## Pre-slice probes (2026-09-25)
- node v22.22.3, codex-cli 0.155.1.
- `initialize` → `{"userAgent":"stratum-peer3-probe/0.155.1 (Mac OS 26.7.0; arm64) iTerm.app/3.6.11 (stratum-peer3-probe; 0.1.0)","codexHome":…,"platformFamily":"unix","platformOs":"macos"}`. Version = segment after the first `/` in userAgent, up to the first space. The prefix before the `/` is the client name we send.
- Idle app-server on stdin EOF: exits rc 0 within 3s. Active-turn EOF is still to be proven in S5.
- dist rebuilt at `430ecd5` (cost fix in `ts/dist/connectors/background.js`). The MCP server process still holds old modules until it reconnects.

## Full-suite baseline (before S1)
- Run on a clean `git archive af99636` export, with Stripe/Resend env unset: 1803 passed, 2 failed, 3 skipped. The 2 failures (`cli/distill` git-root discovery, `mcp/flow_cancel` T-S03-3) are environmental: the export is not a git repo, and load was ~6.6 with 2 Codex jobs running. Both pass in the real repo (26/26). Baseline treated as green.

## Live probe evidence (2026-09-25, luna/low, disposable CODEX_HOME)
- **sandbox-baseline (exec):** in workspace-write with default config, workspace, extra writable root, `$TMPDIR` and `/tmp` are all writable. This matches design §4 `excludeTmpdirEnvVar:false, excludeSlashTmp:false` for exec. App-server parity is still S5 AC03. Override run recorded in `sandbox/override.json`.
- **server-requests (rc=1 by design: fails on unexercised methods):** real handshake identity `stratum/0.155.1 (Mac OS 26.7.0; arm64) iTerm.app/3.6.11 (stratum; 0.1.0)` passed the gate. `item/commandExecution/requestApproval` → `{decision:"decline"}` accepted (server logged "rejected by user"), run `completed`. `mcpServer/elicitation/request` → decline accepted, run `completed`. **9 methods not elicitable in this config** (fileChange approval, legacy execCommand/applyPatch approvals, permissions, tool/requestUserInput, auth refresh, attestation, tool/call, unknown). For those, AC05 rests on generated-type checks, the strict fake, and the 120s stall watchdog. **Controller adjudication:** AC05 accepted with this documented gap; S5 reruns the probe.
- **server-requests rerun after the S2 fixes (rc=0):** proven on the real server: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` (new dedicated trigger: on-request + read-only + patch prompt), `mcpServer/elicitation/request`. Unreached, each with its trigger recorded: execCommandApproval, applyPatchApproval (legacy, not sent by the modern server even when prompted), item/permissions/requestApproval, item/tool/requestUserInput, auth refresh, attestation, item/tool/call, unknown. Live evidence gate `STRATUM_LIVE_PEER3=1 … codex-appserver.live.test.ts`: 9/9. Evidence: `peer3-evidence/requests2/`.
- Evidence dir: `/private/tmp/claude-501/-Users-ruze-reg-my-forge/a0b33df7-0e94-469a-b181-8b5ea924ff6d/scratchpad/peer3-evidence/` (scratch, not durable; S5 report retains a copy).

## Slices
| Slice | Status | Commit | Notes |
|---|---|---|---|
| side: cache_write key | DONE | `6638c5e` | luna/medium; 34 targeted passed (controller rerun) |
| S1 protocol pin + policy encoder | DONE | `c966ffc` | review s1-r1 NOT CLEAN (2), both fixed. Verified on isolated HEAD+S1: typecheck, build, pin --check, 416/416. prepare-dist staged without S2's driver-entry line. peer3-probe.mjs deferred to the S2 commit. **S2 must switch to `assertAppServerIdentity(userAgent, clientInfo)`**, since it was written against the old 1-arg form. |
| S2 driver vs fake app-server | DONE | (this commit) | r1 NOT CLEAN (6) → fixed; r2 NOT CLEAN (1 new HIGH: exit × backpressure drops buffered completion, reproduced) → fixed. Controller accepted without r3: narrow fix, the reviewer's own repro now gives completed 200/200 with one sentinel 0, locked as a regression test. Verified: typecheck, build, 175 passed / 1 skipped. Live gate 9/9 (requests2): 3 methods proven, 8 unreached with triggers. Design AC05 amended. |
| S3 sidecar owner/auth/reservations | next | | |
| S4 selector + launch | pending S3 | | |
| S5 live exit gate | pending S4 | | |
