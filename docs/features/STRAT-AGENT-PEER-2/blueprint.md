# STRAT-AGENT-PEER-2 Blueprint

**Status:** BLUEPRINT (2026-09-19) · design only; implementation and verification below are future work
**Related:** [design.md](./design.md), [feature.json](./feature.json), PEER-1 [design](../STRAT-AGENT-PEER-1/design.md), [blueprint](../STRAT-AGENT-PEER-1/blueprint.md), [report](../STRAT-AGENT-PEER-1/report.md), [protocol research](../STRAT-AGENT-PEER-1/research-claude-code-peer-registry.md).
**Repo:** `stratum/ts`, `@smartmemory/stratum` 0.6.0, ESM, Node ≥22.15, vitest.

All grounding line references are to `main` at `8231e6d`, read on 2026-09-19. Proposed symbols and paths are explicitly distinguished from existing code. Design review has not been declared passed. Only `design.md` and this file are deliverables; do not change `feature.json` in this pass.

---

## Overlap scan

Searched feature blueprints for `background.ts`, `peer-sidecar`, `peer-registry`, `claude-bg-worker` and `peerLabel`, and checked matching feature manifests. The matching prior blueprints are STRAT-AGENT-PEER-1, STRAT-AGENT-BG-WRITE-1 and STRAT-FLOW-CANCEL-FG; all three manifests are COMPLETE. PEER-2 is PLANNED. No other matching blueprint was found; this is a repository scan, not proof that no unpublished work exists.

PEER-1 owns the shared peer writer, bounded callbacks, discovery metadata and cleanup. BG-WRITE-1 owns worker finalization/cancellation. FLOW-CANCEL-FG owns separate foreground process tracking and the `flow`/`cancellationId` admission rules. Reuse the first, add observational hooks to the second, and preserve the third. Current MCP completion instructions and sandbox/telemetry additions postdate parts of PEER-1's blueprint and must remain intact.

## File Plan

These are exact proposed implementation paths, **not files changed by this design pass**.

| # | File | Kind | Change |
|---|---|---|---|
| 1 | `ts/src/connectors/peer-registry.ts` | existing | Add `normalizePeerLabel`; extend `peerName` with optional agent/label options while preserving its old two-argument output. Discriminate process vs Claude-worker sidecar config; serialize/validate owner kind and worker run ID. Reuse registry, identity, key, callback and sweep helpers. |
| 2 | `ts/src/connectors/peer-sidecar.ts` | existing | Worker-mode IPC stdio and returned `PeerSidecarHandle`; process launch remains detached without IPC. Install early IPC listeners, serialize owner events with scans, rescan before terminal fallback, handle unavailable retention, and detach IPC during cleanup. Keep one registry/socket implementation. |
| 3 | `ts/src/connectors/peer-worker-lifecycle.ts` | **new** | Small per-run state latch: attach a handle, observe worker exit and finalization settlement in either order, finalize once, or abandon and disconnect a late handle. No worker cancellation, registry writes, or timers beyond those owned by the handle. |
| 4 | `ts/src/connectors/background.ts` | existing | Validate label before side effects; optional normalized label in initial metadata for either agent. Claude lifecycle latch attached before metadata await, registration after successful metadata write, optional `peerName` response, safe peer reads for both agents. Add source `.ts`/dist `.js` worker selection. Preserve cancel outcomes and terminal-write ordering. Add internal controlled-worker fixture option described below. |
| 5 | `ts/src/connectors/runner.ts` | existing | Add/validate background-only `peerLabel`, forward it through the background spread, leave foreground connectors untouched. Existing return union already permits `peerName`. |
| 6 | `ts/src/connectors/claude-bg-worker.ts` | existing | Test seam only: extend existing env-gated synthetic worker modes with a controlled-release fixture keyed by an optional worker-data path. Production SDK/output/sentinel behavior is unchanged. |
| 7 | `ts/src/mcp/server.ts` | existing | Validate background-only label and forward it into `agentRun`. Retain generic peer completion instructions and response passthrough. |
| 8 | `ts/contracts/mcp-surface.json` | existing | Add request `"peerLabel?":"string"` and describe its background-only display semantics. Existing start/poll response fields suffice; do not add `peer:"pending"`. |
| 9 | `ts/tests/connectors/peer-worker-lifecycle.test.ts` | **new** | Latch ordering, idempotence, abandonment and late attachment; focus on race outcomes. |
| 10 | `ts/tests/connectors/background-claude-peer.test.ts` | **new** | Real workers/sidecars/sockets golden flow, owner-process death, independent cancellation, labels, registration isolation/failure and source/dist launch coverage. |
| 11 | `ts/tests/connectors/peer-registry.test.ts` | existing | Label/name compatibility and config/env variants, including rejection of missing IPC-mode identifiers and invalid owner discriminators. |
| 12 | `ts/tests/connectors/peer-sidecar.test.ts` | existing | Worker-mode IPC message/disconnect/early-start cases; existing process-mode golden flow and protocol/error/cleanup tests remain regression coverage. |
| 13 | `ts/tests/connectors/background-claude-interleavings.test.ts` | existing | Finalization settles before/after exit, cancel/error races, missing terminal write and late sidecar attachment. Keep these mocked-worker race tests separate from real-worker integration. |
| 14 | `ts/tests/connectors/runner.test.ts` | existing | Label forwarding and foreground rejection before provider invocation. |
| 15 | `ts/tests/mcp/agent-run.test.ts` | existing | Request forwarding/validation, Claude start without executor PID, existing completionInstructions with Claude peerName, old responses still accepted. |
| 16 | `ts/tests/mcp-surface-peer.test.ts` | existing | Request shape accepts optional label; wrong types/unknown keys rejected; Claude peer responses conform; removed pending field stays rejected. |
| 17 | `README.md` | existing | Extend background-peer paragraph to Claude, labels, worker lifetime limits and historical registration semantics. |
| 18 | `CHANGELOG.md` | existing | Future implementation entry under Unreleased. |

Read but **no planned edits**: `ts/src/connectors/claude-bg-worker-hooks.mjs` (source-only loader), `ts/src/connectors/proc_identity.ts` (Codex process identity), `ts/src/connectors/claude.ts` (SDK), `ts/scripts/prepare-dist.mjs` (sidecar already listed), `ts/vitest.config.ts` (global registration kill switch remains). No additional sidecar entry, no new build copy rule, no feature-status automation, and no cross-repository changes are required.

## Grounding: what the code does today

### Claude worker ownership and terminal writes

- `ts/src/connectors/background.ts:19-48`: `claudeWorkerRegistry` holds Worker, cancelling flag and finalization claim. The first claim owns terminal I/O; failure is swallowed and map deletion still occurs in `.finally()`. A missing sentinel therefore cannot be handled solely by stream tailing.
- `background.ts:84-88,92-115`: Claude metadata has no PID; start options already carry peer directory/linger test seams but no label. `background.ts:146-148` dispatches to Claude before Codex registration code.
- `background.ts:294-320`: creates durable files, resolves Claude model and worker input. Default model is `options.model ?? process.env.CLAUDE_MODEL ?? "claude-sonnet-5"`; the design does not silently change this precedence.
- `background.ts:321-332`: starts `.ts` worker with `.mjs` loader hook and installs its map entry. Worker PID is not exposed; all threads belong to the host process.
- `background.ts:334-359`: exit/error listeners share `claimFinalization`. Error may claim before exit, and preserves any sentinel already committed by the worker. New peer observation must not create another stream finalizer.
- `background.ts:362-385`: initial metadata write is fatal; on failure worker is terminated and map entry removed. Peer registration belongs after this block, before the return, under its own best-effort budget.
- `background.ts:416-445`: Claude poll uses sentinel plus in-memory membership, rescanning after an absent entry before reporting `child_died_without_sentinel`. Restart loses worker ownership.
- `background.ts:485-535`: cancel terminates the actual worker, rescans, joins or owns the finalization claim, and writes rc 130 only when cancellation owns the terminal record. Preserve all branches, especially already-complete/error races.
- `claude-bg-worker.ts:12-18,34-59`: structured-clone worker input and existing env-gated synthetic modes. `:67-99` normalizes SDK output; `:102-116` emits rc 0/1 and closes the stream. No peer identity or lifecycle message is emitted by the worker today.
- `claude-bg-worker-hooks.mjs:15-62`: source import remapping/type stripping only. It has no run-lifecycle or peer responsibilities.

### Codex and shared sidecar precedent

- `background.ts:194-230`: detached wrapper spawn, own-process identity, fatal initial metadata write, `child.unref()`.
- `background.ts:231-265`: independent two-second registration budget, gate, sweep, `spawnPeerSidecar`, tentative `peerName`. No label/flow reaches `peerName` at `:237`.
- `background.ts:395-410`: peer discovery is currently Codex-only; acquisition uses `O_NONBLOCK | O_NOFOLLOW`, descriptor regular-file/64 KiB checks, validates discovery fields, and never fails a run because peer metadata is bad.
- `background.ts:538-547`: Codex group cancellation has identity/group-leader checks. It is unrelated to worker-mode peer ownership and stays unchanged.
- `background.ts:580-595`: metadata loading validates run ID/agent/model and derives paths from the run directory. `:597-698` parses complete JSON lines, and `:648-663` avoids resurrecting deleted streams during finalization.
- `peer-sidecar.ts:11-34`: source/dist resolution already exists for the sidecar; launcher returns `Promise<void>`, waits only for spawn, catches errors and unrefs the detached process. A worker-mode handle is a new boundary.
- `peer-sidecar.ts:36-48`: bounded scan/identity coalescing. `:66-168` holds subscriptions, echoes mode and bounds callback work; preserve it rather than duplicating the protocol.
- `peer-sidecar.ts:188-233`: terminal state is sticky; a numeric sentinel triggers idle and rc detail. `:234-259` accepts the socket protocol; `:261-325` verifies ownership and drains on cleanup.
- `peer-sidecar.ts:327-345,404-417`: the process-specific assumption is child-start capture and repeated child-PID checks. Worker mode must bypass these, not disguise the MCP PID as a child PID.
- `peer-sidecar.ts:355-398`: bind, write key/record, then historical discovery metadata using sidecar PID. The same code can represent either executor type.
- `peer-registry.ts:15-18,148-187`: current name helper is Codex-only; current config/env parser requires a child PID. `:20-145` supplies reusable directory, identity, hashing, callback, gate and sweep logic.
- `proc_identity.ts:50-64,85-107`: high-resolution process identity differs from Claude registry `ps lstart`; unknown identity never establishes death. Worker mode needs neither a new process identity format nor synthetic identity.

### MCP request, response and packaging seams

- `runner.ts:13-40,49-52,94-124`: options, return union and explicit background forwarding; adding a contract field alone would not forward a label.
- `ts/src/mcp/server.ts:183-195`: background cannot carry flow/cancellationId. `:371-388` explicitly constructs agent options and needs label forwarding. `:396-405` spreads output, adds completion instructions based on peerName and delegates poll.
- `ts/contracts/mcp-surface.json:1081-1106,1126-1131`: request has no label; start already supports peerName and completionInstructions. `:1135-1178` describes historical registration and supplies optional poll peer shape.
- `ts/src/mcp/contracts.ts:80-86,122-132`: optional-key grammar is `key?`; undeclared keys are rejected. Length/background restrictions need runtime validation in addition to the string shape.
- `ts/scripts/prepare-dist.mjs:8-23,40-44` already prepares sidecar JS and copies contracts. `ts/tsconfig.build.json:4-11` emits TypeScript as JS from `src`; neither copies worker `.ts` or `.mjs`. Select the `.js` worker with no hooks in dist, source `.ts` plus existing hooks only when source exists.
- `ts/tests/connectors/peer-sidecar.test.ts:368-380` already exercises emitted JS in a temporary tree through TypeScript's `transpileModule`; it is not proof that the whole packaged Claude path works. A future built-artifact check is still required.
- `ts/tests/connectors/background-claude-interleavings.test.ts:1-27` isolates mocked Worker ordering; real-worker tests use the separate synthetic env seam. `ts/vitest.config.ts:3-6` disables ambient peer registration across the suite.

## Corrections table (spec assumption vs reality)

| Ticket / old spec assumption | Current code / evidence | Blueprint resolution |
|---|---|---|
| Per-run registry requires the executor's own PID | Sidecar owns an independent PID already (`peer-sidecar.ts:50-54,389-393`) | Sidecar per worker; private lifecycle input replaces only executor-death monitoring. |
| Passing the MCP PID as `childPid` is sufficient | One worker can end while MCP lives; claim settles even after failed append (`background.ts:37-48`) | Explicit exit-plus-finalization latch; stream-first fallback; no MCP-PID proxy. |
| Flow supplied Codex labels | Name helper has two args; server rejects flow on background | New background-only `peerLabel` through contract, server, runner and metadata. |
| PEER-1 report's early `peer:"pending"` examples are the shipped contract | Final fix removed it; `mcp-surface-peer.test.ts:25-28` rejects it | Optional peerName only; retain completionInstructions. |
| `peer.registered` tracks current liveness | Discovery file survives cleanup; contract explicitly says historical | Generalize existing semantics to Claude, keep poll fallback. |
| Every worker terminal condition will leave a sentinel | Finalization catches I/O failure and still removes membership | On confirmed exit + settled claim, rescan then exited if no sentinel. |
| Cancel should always send exited | Claude cancellation writes rc 130; current sidecar maps every numeric sentinel to idle | Preserve idle-with-rc semantics; poll reports error/cancellation details. |
| Original PEER-1 “no server.ts change” applies here | New request field requires explicit forwarding at `server.ts:371-388` | Modify server request handling; response formatting already works. |
| Worker `.ts` entry works from dist | Compiled spawn still names source and unshipped hooks | Select source/dist entry in background manager; no new packaging copy mechanism. |
| Memory note's ref formula is unconditional | Research §1 includes stable-session hash and collision extensions; writer does not compute refs | Document reader-dependent refs; do not bake six-character ref derivation into the API. |

## Boundary Map

Three sequential implementation units: **S1 label/config/lifecycle primitives**, **S2 sidecar + background wiring**, **S3 MCP surface + integration/docs**. This is a work decomposition, not authorization to implement or delegate during the design pass.

| Symbol | Kind | File | Produced by | Consumed by |
|---|---|---|---|---|
| `normalizePeerLabel(value)` | new function | `ts/src/connectors/peer-registry.ts` | S1 | S2 background validation/name reconstruction; S3 runner/server validation |
| `peerName(model, runId, options?)` | existing function extended | `ts/src/connectors/peer-registry.ts` | S1 | S2 launch and poll, existing Codex callers |
| `PeerSidecarConfig` | existing type extended to union | `ts/src/connectors/peer-registry.ts` | S1 | S2 launcher/background/env parser |
| `sidecarEnv`, `configFromEnv` | existing functions extended | `ts/src/connectors/peer-registry.ts` | S1 | S2 source/dist sidecar launch |
| `PeerSidecarHandle` | new interface | `ts/src/connectors/peer-sidecar.ts` | S2 | S1 lifecycle latch via type-only import; S2 background |
| `spawnPeerSidecar` | existing async launcher extended | `ts/src/connectors/peer-sidecar.ts` | S2 | S2 background; S3 real-process tests |
| `createWorkerPeerLifecycle` | new function | `ts/src/connectors/peer-worker-lifecycle.ts` | S1 | S2 Claude start, exit listener and claim settlement |
| `PeerRecordFile` | existing type, unchanged shape | `ts/src/connectors/peer-registry.ts` | PEER-1 | S2 sidecar writes, generalized poll reads |
| `StartBackgroundRunOptions` | existing interface extended | `ts/src/connectors/background.ts` | S2 | S3 runner and tests |
| `AgentRunOptions` | existing interface extended | `ts/src/connectors/runner.ts` | S3 | MCP dispatcher and direct callers |

### Payloads and implementation contracts

**Name input:** `normalizePeerLabel(unknown)` returns normalized string or throws for an invalid supplied value; absence stays undefined. Apply the design's 1–64 trimmed-character/control/ASCII-slug rules consistently. Optional peerName helper options are `{agent?: "codex" | "claude"; label?: string}`; label is already validated. Persist normalized label in `BackgroundRunMetaBase` before initial metadata commit. For malformed optional disk metadata, omit the hint when deriving fallback name. Valid `peer.json` remains historical evidence of the actual registered name.

**Sidecar config:** common fields stay `runDir, streamPath, name, cwd, sessionsDir, sockDir, lingerMs?, firstLineDeadlineMs?`. Owner variants are `{ownerKind?:"process", childPid, childProcStartTime?}` and `{ownerKind:"claude-worker", runId}`. Missing discriminator defaults to process mode for existing tests/callers. Unknown mode or invalid 12-hex worker run ID is rejected. Worker mode must see a connected IPC channel at startup.

**Environment:** retain existing `STRATUM_PEER_*` fields and add `STRATUM_PEER_OWNER_KIND`, `STRATUM_PEER_RUN_ID`. Serialize only the active variant's identity fields; explicitly clear inactive inherited `STRATUM_PEER_CHILD_PID`, `STRATUM_PEER_CHILD_START` or run ID values. Avoid ambient stale mode leakage into Codex launches. No peer label needs a separate sidecar env field; the fully derived name travels in existing `STRATUM_PEER_NAME`.

**Launcher handle:** extend return to `Promise<PeerSidecarHandle | undefined>`; Codex callers continue ignoring the result. A successful worker-mode spawn returns `{finalize():void, abandon():void}` whose operations are idempotent and never throw into run handling. Install parent message/error/disconnect listeners immediately when creating the child, before awaiting spawn. Queue a finalize request until a matching `{type:"owner-ready",runId}` arrives; then send `{type:"run-finalized",runId}` once and disconnect on send completion or after a one-second bound. Readiness has a two-second deadline from spawn; expiry abandons the channel. `abandon` disconnects immediately without a terminal claim. Clear timers/listeners on handle termination. Spawn/open failure returns undefined with existing logging. No PID kill operation is exposed.

**Lifecycle latch:** `createWorkerPeerLifecycle()` returns `attach(handle)`, `markExited()`, `markFinalized()`, `abandon()`. Both marks are sticky; finalized alone cannot emit a message. Both true plus attached means call finalize exactly once. Abandon wins over future attachments and disconnects an attached handle; it never changes the worker. Integrate marks without awaits in the existing observer paths. The exit listener marks before its cancelling early-return; claim `.finally()` deletes the map entry then marks finalized. Peer exceptions must be contained so `.finally()` cannot turn an otherwise completed claim into a rejection.

**Late startup:** create the latch with the worker entry before the first metadata await. Skip/timeout/failed registration abandons it. Check cancellation of the registration attempt after gate/sweep and before spawn; if spawn is already pending when timeout wins, attach the late handle to the abandoned latch so it disconnects. If worker finalized before metadata commit or before sidecar spawn, both marks are retained and replayed on attachment. No global finished-run map is added.

**Sidecar lifecycle queue:** extend `PeerWorkQueue`'s coalesced work kinds with owner processing, or an equivalent bounded sticky owner flag; never enqueue one closure per repeated IPC frame. Accept only the matching private run-finalized message. Install listeners before async startup and send owner-ready immediately; this is listener readiness, not registration success. If already disconnected before the handshake, stop without publishing. Then process stream and latched owner state before record publication. On disconnect/finalized, rescan before fallback. Guard all publication/terminal paths with the same sticky terminal state. Extend terminal handling to allow unavailable with retention for lost owner channels, while retaining immediate cleanup for unrecoverable I/O errors. Cleanup releases IPC and any owner listeners, drains callbacks, and preserves existing identity-checked file removal.

**Worker fixture seam:** add internal `workerTestReleasePath?: string` on `StartBackgroundRunOptions`, copied as `testReleasePath?` in both declarations of `WorkerInput`. Do not expose it on MCP or `AgentRunOptions`. Only `STRATUM_TEST_WORKER="controlled"` activates it: emit the usual synthetic start/output record, await the per-run release file with a bounded test deadline, then return through normal sentinel writing. Require a supplied fixture path; do not fall through into the SDK on malformed controlled-test configuration. Two workers receive distinct paths without mutating process.env between concurrent starts. All integration fixtures terminate remaining workers/sidecars in finally blocks.

**Public results:** no new response schema. Claude start still omits top-level pid and optionally includes peerName; poll adds the already-declared peer object. `completionInstructions` stays generated at MCP dispatch. No lifecycle fields or IPC identities enter the caller contract.

## Verification Table (Phase 5)

Phase 5 here is **static grounding only**, checked by reading the indicated files. Phases 6/7 below are planned gates, not executed results. No source edits, builds, tests, peer registrations or live messages were made in this pass.

| Ref | Claim checked | Result |
|---|---|---|
| `background.ts:19-48,334-359,485-535` | Worker entry, finalization ordering and cancel ownership | Verified; drives the two-fact lifecycle latch |
| `claude-bg-worker.ts:34-59,102-116` | Existing synthetic seams and shared sentinel | Verified; no new production result format needed |
| `claude-bg-worker-hooks.mjs:15-62` | Loader-only responsibilities | Verified; retain for source path only |
| `peer-sidecar.ts:50-54,355-398` | Actual sidecar PID owns files/socket, discovery published last | Verified |
| `peer-sidecar.ts:66-168,234-259` | Mode echo, callback bounds, auth/framing/refusal | Verified; shared protocol stays in one place |
| `peer-sidecar.ts:188-233,327-345,404-417` | Sentinel terminal state and process-only liveness assumption | Verified; replace only worker-mode death observation |
| `peer-registry.ts:15-50,148-187` | Current naming/env config and identity/hash conventions | Verified; helper API needs extension |
| `background.ts:395-410`, surface `:1136` | Safe discovery reads and historical registered semantics | Verified; apply to Claude |
| `server.ts:183-195,371-405`, `runner.ts:94-124` | Flow restriction, explicit option forwarding, generic completion guidance | Verified |
| `tsconfig.build.json:4-11`, `prepare-dist.mjs:8-44`, `background.ts:321-330` | Source-only worker URL does not match emitted package layout | Static mismatch verified; runtime reproduction deferred |
| PEER-1 research/report | Filename authority, socket probe and model-admitted idle notices | Historical evidence only; not re-probed against installed Claude |
| Boundary Map | Every proposed symbol has a named producer and consumer | Manually cross-checked; no automated boundary validator run |

### Phase 6 — future implementation checks

| Piece | Check / fixture | Pass criterion |
|---|---|---|
| **Golden flow first** | Two controlled real Claude workers in one host, real sidecars, isolated sessions/sockets, one requester subscribes to both with distinct IDs/modes | Two distinct real sidecar PIDs/rows. Release A: A idle and exactly one correlated authenticated callback, B still busy. Release B: separate callback. Poll returns correct report; cleanup removes each owned row/key/socket. |
| Naming and label path | Unit vectors plus real start → meta → registry → poll; equal labels on concurrent runs; no label, whitespace, controls, punctuation, non-ASCII-only, 64/65 characters | Same normalized name at each stage; invalid input rejected before spawn; legacy Codex two-arg names unchanged; valid old metadata still readable. |
| Wire interoperability subset | Extend real socket harness for worker owner mode | Requester's token used; from_mode echoed unchanged; no synchronous ACK required; empty probes work; user messages refused; capacity/replace/deadline/drain behavior unchanged. |
| Completion-before-registration | Immediate synthetic worker plus deliberately delayed attachment/startup | Terminal evidence retained; terminal row published and late subscription answered during linger, then cleanup. |
| Finalization/exit races | Existing mocked-worker interleaving suite plus latch tests | No early “worker ended” on error alone; both event orders finalize once; no extra sentinel, changed cancellation status, blocked map deletion or unhandled rejection. |
| Failed terminal append | Real worker exit with unavailable/deleted stream plus controlled finalizer failure | Confirmed exit + settled claim gives exited; no stream recreation by peer code; no indefinite busy row while MCP stays alive. |
| Independent cancellation | Cancel A while B remains held; include existing sentinel-wins/error-claim-wins races | Only A changes. rc 130 gives idle notice with rc detail; poll/cancel outcomes follow existing authority. |
| Owner process death | Host real workers in a separate controllable Node process; subscribe, then kill the host | Sidecar observes IPC closure, rescans, sends unavailable if no sentinel, and exits after bounded retention/drain. New host poll reports durable result or missing-sentinel error. |
| IPC errors/startup/timeout | Missing IPC, missing/late owner-ready, wrong run ID, duplicate finalize, disconnect before bind, finalize requested before listener readiness, timeout during spawn, child exit before send | Readiness orders message delivery; failures stay in peer subsystem; no leaked late sidecar, duplicate callback, false successful run or post-timeout new launch. |
| Registration isolation | Kill switch, absent sessions, live protocol >1, foreign record, socket bind failure, unreadable peer.json/FIFO, sidecar crash | Worker and poll/cancel continue; optional peer data remains safe; foreign files untouched; no real registry modifications. |
| Codex regression | Existing background, Codex lifecycle, peer-registry and sidecar tests | Process mode still monitors wrapper identity, survives MCP loss, retains old names and cancellation semantics. No IPC requirement for Codex. |
| Request/response integration | Contract tests and dispatcher/runner tests | Optional string label accepted and forwarded; foreground/wrong type/invalid hint rejected; Claude peerName triggers existing instructions, no top-level executor PID or pending field. |
| Source vs JS | Source real-worker harness; emitted sidecar test; later built package with no sibling source files | Source uses existing hooks; dist launches `.js` worker without hooks; both register/notify/clean up. |
| Cleanup/resource bounds | Repeat concurrent runs, count surviving handles/processes/files after linger + drain | No per-run growth after completion; no referenced IPC retaining owner; historical peer.json intentionally remains; measure overhead rather than assert an unmeasured limit. |

### Phase 7 — future human/live exit check

1. Build and use the actual intended MCP artifact in an environment permitting local process identity and Unix sockets. Record the installed Claude version and actual peer-list command. Do not silently classify permission-blocked checks as passes.
2. Launch two labeled real Claude background runs long enough to overlap. Confirm two independently named `bg · busy` rows through `ListAgents` and the installed peer-list command. Check filename PID equals the socket-serving sidecar PID, distinct from the MCP PID.
3. Subscribe to both via `SendMessage(to=peerName, notify_when_idle=true)`. Observe a correlated idle notice admitted to the requesting **model context** when each finishes, with the original from_mode echoed. Text refusal accompanying a subscription is expected; an idle transport write alone does not prove model admission.
4. Poll each report; confirm peer.registered remains historical after rows disappear. Check failure/cancel outcomes still require polling. Confirm no abandoned sidecar remains after terminal retention/drain.
5. Record results in a future implementation report. Human review controls feature status. If current Claude cannot list/subscribe under its installed protocol, leave live interoperability unverified and diagnose before claiming shipment.

## Tests

| Changed code | Test file(s) | Action |
|---|---|---|
| Name/config helpers | `ts/tests/connectors/peer-registry.test.ts` | Extend |
| Private lifecycle latch | `ts/tests/connectors/peer-worker-lifecycle.test.ts` | Add |
| Sidecar transport/lifecycle | `ts/tests/connectors/peer-sidecar.test.ts` | Extend, retain Codex harness |
| Background worker/registration/entry selection | `ts/tests/connectors/background-claude-peer.test.ts`, `ts/tests/connectors/background-claude-interleavings.test.ts` | Add real integration; extend controlled ordering |
| Public forwarding/contracts | `ts/tests/connectors/runner.test.ts`, `ts/tests/mcp/agent-run.test.ts`, `ts/tests/mcp-surface-peer.test.ts` | Extend |
| Existing background execution | `ts/tests/connectors/background.test.ts`, `ts/tests/connectors/background-codex-lifecycle.test.ts`, `ts/tests/connectors/background-claude.test.ts` | Run regression coverage |

**Future implementation commands** (from `ts/`; do not run during this design pass):

```sh
npx vitest run tests/connectors/peer-registry.test.ts tests/connectors/peer-worker-lifecycle.test.ts
npx vitest run tests/connectors/peer-sidecar.test.ts tests/connectors/background-claude-peer.test.ts tests/connectors/background-claude-interleavings.test.ts
npx vitest run tests/connectors/background.test.ts tests/connectors/background-codex-lifecycle.test.ts tests/connectors/background-claude.test.ts tests/connectors/runner.test.ts tests/mcp/agent-run.test.ts tests/mcp-surface-peer.test.ts
npm run typecheck
npm run build
npx vitest run
```

Run targeted checks after their implementation unit, then typecheck/build and the full suite once. Peer tests explicitly opt in with temporary sessions/socket/run directories; keep the suite-wide `STRATUM_PEER_REGISTER=0` default. Use short `/tmp/sp-*` socket roots for macOS path limits, real process fixtures for process boundaries, and deterministic release signals instead of arbitrary sleeps. The built-artifact and live checks above are additional exit evidence; do not infer them from source tests.

## Documentation

- [ ] Future implementation: update `README.md` background-agent section with Claude rows, background-only peerLabel examples, subscribe-then-poll flow, and worker loss on MCP restart.
- [ ] Future implementation: add `CHANGELOG.md` Unreleased entry.
- [ ] Future implementation: update MCP tool description alongside the request contract; retain completionInstructions and historical peer.registered wording.
- [ ] Future verification: record actual results, version and corrections in this feature's implementation report, without rewriting PEER-1's historical evidence.
- [ ] Human review: decide feature status separately. This pass leaves `feature.json` PLANNED and does not create an implementation report or plan file.

No SmartMemory service, SDK, client, contracts repository or website is involved. This blueprint's documentation work is confined to Stratum; no unrelated cross-project checklist applies.
