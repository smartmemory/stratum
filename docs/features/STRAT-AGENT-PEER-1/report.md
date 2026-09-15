# STRAT-AGENT-PEER-1 Implementation Report

**Related:** [design.md](./design.md), [blueprint.md](./blueprint.md), [plan.md](./plan.md), [feature.json](./feature.json), research and review artifacts in this folder, Codex run transcripts in [sessions/](./sessions/)
**Date:** 2026-09-15
**Commits (stratum):** `817eb43` design, `1c59a33` blueprint+plan, `93ada9e`/`c643c27` plan hardening + verified dial-back, `bdef29f` slice 1, `917c3d2` slice 2 + test isolation fix. Review-fix commits, if any, are listed at the end.

## 1. Summary

Codex background runs started through `stratum_agent_run(agent="codex", background=true)` now appear in every Claude Code session's `ListAgents` as `codex-<model>-<runId6> · bg · busy`, flip to `idle` when the run ends, answer `SendMessage(notify_when_idle=true)` with a real `[Cross-session idle notice]`, and disappear 15 s later. The caller no longer needs a `kill -0` Bash wait loop. Implemented as one detached sidecar process per run that owns the registry record, key file and socket, and reads (never writes) the run's durable stream.

## 2. Delivered vs planned

| Planned (plan.md) | Delivered |
|---|---|
| Task 1 pure helpers (`peer-registry.ts`) | Yes, 22 unit tests |
| Task 2 sidecar (`peer-sidecar.ts`) | Yes: bind, key, record, `peer.json`, stream tail, child-death watch, `notify_when_idle` acceptance rule (replace on `from`, cap 32), `user` refusal, dial-back with the requester's token, linger, drain, cleanup |
| Task 3 wiring + contract | Yes: `startBackgroundRun` spawns after `child.unref()`, `bg_started` carries `peerName` + `peer:"pending"`, poll reports `peer.{name,registered,pid,sock}`; `mcp-surface.json` additive optional fields; `prepare-dist.mjs` entry; `runner.ts` type widening + test-seam passthrough |
| Task 4 tests | Golden flow with controlled-release child, error harness, contract test (`mcp-surface-peer.test.ts`), regression on legacy background tests |
| Task 5 docs | CHANGELOG `[Unreleased]` entry, README paragraph |
| Live verification | Done from this session against the built dist (see §5) |
| Not planned, added | `ts/vitest.config.ts` (`STRATUM_PEER_REGISTER=0` for all test workers) after legacy fixtures were caught registering four sidecars in the real registry; configurable first-line deadline (`STRATUM_PEER_FIRST_LINE_MS`) so the 30 s socket test runs in 300 ms; `from_mode` echo on notices (see §4) |

## 3. Architecture deviations from the design

- **Peer name has no step label.** The design allowed `-<stepId>`; the blueprint found a background run can never carry `flow` (server requires `cancellationId` with `flow` and rejects it for background runs). Name is `codex-<short>-<runId6>`.
- **`from_mode` must be echoed.** Not in the original design; discovered by probe: a `peer_idle_notice` without the requester's `from_mode` is not admitted to the subscriber's model. Design updated before implementation.
- Everything else (owner = sidecar, linger window, sidecar-owned `peer.json`, acceptance rule, write-set invariant, cancel untouched) shipped as designed after four Codex design rounds.

## 4. Key implementation decisions

- **Per-run detached sidecar** rather than the codex pid or the MCP server: Claude Code lists only records whose socket answers, and idle subscriptions verify that the socket-answering pid equals the record's filename pid. Only a process that owns its own pid can satisfy both; detaching makes it survive MCP restarts like the run it shadows.
- **Shadow, never authority.** The sidecar reads `stream.jsonl` and writes only files named for its own pid plus `<runDir>/peer.json`. `cancelBackgroundRun` is byte-for-byte unchanged; cancel kills the wrapper's group, the sidecar (own group) sees "child dead, no sentinel" and reports `exited`.
- **Registration is best effort and gated**: `STRATUM_PEER_REGISTER=0` kill switch; skipped when the sessions dir is absent or any live record advertises `peerProtocol > 1`; no version-string allowlist (records from 2.1.238 to 2.1.272 all list, so a string gate would only go stale).
- **Tests never touch the real registry**: vitest env sets the kill switch for every worker; peer tests opt back in with temp `sessionsDir`/`sockDir` under `/tmp/sp-*` (macOS `sun_path` limit).

## 5. Verification

Targeted (controller, no `STRATUM_PEER` env in shell): `peer-registry`, `peer-sidecar`, `background`, `background-codex-lifecycle`, `mcp-surface-peer` → 5 files, 79 tests passed, real `~/.claude/sessions` unchanged, no sidecar processes left. `npm run typecheck` and `npm run build` pass.

Live (this Claude Code 2.1.272 session, bypass permissions, built dist, real registry):

1. `startBackgroundRun({agent:"codex", command:["sh","-c","printf …; sleep 75"]})` → `peerName: "codex-terra-900931", peer: "pending"`; record `19048.json` written with `kind:"bg"`, `status:"busy"`, `procStart` in UTC `ps lstart` format.
2. `ListAgents` → `codex-terra-900931 [388e01] · bg · busy · started 11s ago`.
3. `pollBackgroundRun` (new dist) → `peer: { name, registered: true, pid: 19048, sock }`. (The MCP server in this session still ran the pre-change code, so `stratum_agent_poll` through it showed no `peer`; restarting the MCP server is the user's call.)
4. `SendMessage(to="codex-terra-900931", notify_when_idle=true, message=…)` → subscription accepted; the text was refused with a `[Cross-session delivery notice] … refused` as designed (`peer.err`: `peer user message refused`).
5. Child exit → `[Cross-session idle notice] "codex-terra-900931" … is idle now` received in this session's model context.
6. 63 s after start: record, key and socket gone, sidecar exited.

Full suite (once, after all review fixes, `./node_modules/.bin/vitest run` from `ts/`, no `STRATUM_PEER` env in shell): 92 files passed, 2 skipped; 1379 tests passed, 3 skipped (pre-existing); 0 failures; real registry unchanged; no sidecar processes left. Log: [sessions/full-suite.log](./sessions/full-suite.log).

## 5a. Review loop

| Round | Model | Outcome |
|---|---|---|
| impl r1 (`798d549bbde5`) | gpt-6-astra/medium | must-fix: legacy tests registered in the real registry (fixed: `vitest.config.ts`); should-fix: dead child without start time never terminates; non-terminal I/O failure announced `idle` |
| impl r2 (`09a8a0733e41`) | gpt-6-astra/medium | should-fix: blocking registry reads; sweep not correlated to recorded endpoint; unbounded work queue and callbacks; first-line deadline not forwarded |
| impl r3 (`3d34aeeea2a1`) | gpt-5.6-sol/high | must-fix (same as r1 false-idle); should-fix: `peer.json` read unguarded in poll; cleanup trusts pathnames; `peer?: "string"` accepts any value |
| impl r4 (`8a10eda1854c`) | gpt-5.6-sol/high | should-fix ×5, all narrower: sweep ordering, lstat/read race on `peer.json`, callback timeout not covering token lookup, pid reuse when no start time recorded (all fixed in fix 5); pathname-unlink race at cleanup **accepted** as a same-user limitation (see §7) |

The loop was closed after r4: findings had converged to check-then-act races inside the same-user trust boundary, which is the signal that the remaining surface is the OS API (unlink by pathname), not the design.

Fix commits: `917c3d2` (slice 2 + test isolation), `28a5003` (blocking reads, 2 s deadline), `70696b9` (r1-r3 fixes), `247d9e0` (identity-checked cleanup, drop `peer:"pending"`, file PEER-2).

## 6. Files changed

New: `ts/src/connectors/peer-registry.ts`, `ts/src/connectors/peer-sidecar.ts`, `ts/tests/connectors/peer-registry.test.ts`, `ts/tests/connectors/peer-sidecar.test.ts`, `ts/tests/mcp-surface-peer.test.ts`, `ts/vitest.config.ts`.
Modified: `ts/src/connectors/background.ts`, `ts/src/connectors/runner.ts`, `ts/contracts/mcp-surface.json`, `ts/scripts/prepare-dist.mjs`, `README.md`, `CHANGELOG.md`.

## 7. Known issues and tech debt

- **Accepted same-user race (review r4-3):** cleanup verifies the record's pid/sessionId, the key's token and the socket's identity before unlinking, but `unlink` is by pathname, so another process running as the same user could swap a file in between the check and the unlink. Exploiting it requires owning the user account already, and the files live in a directory Claude Code treats with the same trust. Not fixed; documented in design.md "Safety".
- Coupled to an undocumented Claude Code internal (2.1.272). Mitigations: shadow design, protocol gate, kill switch, pinned research report. Expect to revisit when `peerProtocol` moves.
- `peer.registered:false` is reported indefinitely when registration was skipped (poll cannot distinguish "skipped" from "starting"). Accepted for v1.
- Linux `pidDomain` formula reproduced from the bundle, not observed live; failure mode is "listed with fewer process checks", not "hidden".
- Claude background runs (worker threads in the MCP server) are not registered: follow-up `STRAT-AGENT-PEER-2`.
- Codex full-suite runs inside its own session reported three flaky failures (`foreground_registry`, `agent_registry`, `p5` timing) that passed on rerun; unrelated to this feature, pre-existing.

## 8. Lessons learned

- Reverse-engineer, then **probe live before designing**: the roadmap row's `kind:"codex"`, "list only in Phase 1", and "reuse the codex pid" were all wrong, and a 20-line probe settled each in minutes.
- The Codex sandbox denies `ps` and Unix-socket bind; socket features need an unsandboxed `codex exec` run plus controller-side verification (memory `stratum-agent-run-sandbox` updated).
- **Controller error, worth remembering:** two astra implementation reviews were read as "ended with no findings" because the controller's completion check grepped the stream for the sentinel string `__t2f5_done__`, and Codex had just printed `background.ts`, which contains that literal. Both reviews had in fact completed with full findings. Anchor sentinel checks to the line start (`^{"__t2f5_done__"`) or use `stratum_agent_poll`. One design-review run (r1) did genuinely end early; the "findings first" instruction is still a good habit.
- Run the legacy test files yourself, plainly: the implementer kept them clean only via a shell variable, and a plain run put four rows in the real registry.
