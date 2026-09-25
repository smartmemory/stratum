> **Related Documents**
>
> [Design r3](./design.md) · [Feature metadata](./feature.json)

# STRAT-AGENT-PEER-3 implementation plan

Planning baseline: `148af460f9b6755e4edcdb29eaeac8fce4b7b6b0`, 2026-09-25. The design was read in full. References below are against this checkout; locate the named symbol again before editing, especially in `background.ts`. This document proposes work only; no implementation, tests, live model calls, or commits were performed while writing it. Protocol bindings were generated successfully into `/tmp/peer3-ts` with installed `codex-cli 0.155.1`.

Five independently committable slices. Implement the sidecar before exposing the background selector: the existing `workerHandle` closes its IPC channel after finalization and is unsuitable as a persistent steer channel (`ts/src/connectors/peer-sidecar.ts:20`). This order avoids shipping a selectable strategy with only half its peer path implemented. Each slice includes its own tests and must pass its per-slice gate before the next slice starts. Commit boundaries are recommendations, not authorization to commit.

AC identifiers below number the 16 bullets under the design's **Acceptance criteria**, in their existing order. Each AC has exactly one owning slice; earlier harness work and later reruns supply evidence without changing ownership. Refer to design §1–§6 for behavior and payload tables rather than duplicating them here.

## Current code constraints and design discrepancies

- `startBackgroundRun` constructs policy at `ts/src/connectors/background.ts:157`, frames the prompt at `:179`, builds argv at `:181`, selects `options.env ?? process.env` at `:187`, and spawns the detached shell at `:201`. An explicit environment replaces the ambient environment; it is not a per-key overlay. Preserve that meaning of §1 precedence, including the missing-key case.
- Keep `CodexTransport` (`ts/src/connectors/codex.ts:21`) and `CodexConnector` transport selection (`:249`) unchanged. Refactor only the argv encoder reached through `codexExecArgs` (`:162`) / `codexCommand` (`:197`). Preserve full-access authorization (`assertCodexSandboxAllowed`, `:96`) before dispatch.
- The Codex branch of `cancelBackgroundRun` (`ts/src/connectors/background.ts:577`) matches §2's acknowledgement/outcome distinction. `pollBackgroundRun` already rescans after failed identity checks (`:494`); preserve that race protection. The design's `background.ts:472` death citation points into the Claude branch; the corresponding Codex failure is `:500` (controller-verified at `148af46`).
- `scanStream` (`ts/src/connectors/background.ts:636`) confirms the documented cached-token mismatch at `:664`; it also reads `cache_creation_input_tokens` rather than the proposed exec `cache_write_input_tokens` at `:665`. Do not repair accounting readers in this feature. **Update (controller, 2026-09-25):** `430ecd5` (after this plan's baseline) fixed the cached-token read and added estimated USD for Codex background polls via `usdFromTokens(meta.model)`. So “non-zero accounting” in AC07 now covers token counts **and** an `estimated` USD. The `cache_creation_input_tokens` vs. exec `cache_write_input_tokens` mismatch at `:665` is still open (zero in every observed run) and stays out of scope.
- **Version-gate claim needs correction:** generated `/tmp/peer3-ts/InitializeResponse.ts:6` declares `userAgent`, not a dedicated `version` field. Probe the actual value before implementing a parser. A pinned, recognized user-agent version can be checked; do not invent `result.version`, accept unknown strings, or claim that a version check detects schema changes within the same version.
- **Existing-code contradiction:** design Risks says PEER-1 version-allowlists Claude Code. Current `shouldRegister` (`ts/src/connectors/peer-registry.ts:107`) checks registration settings, directory availability, and live `peerProtocol > 1`; it has no Claude CLI version allowlist. Add a Codex-specific contract gate without changing that existing peer gate.
- **Ambient-default claim is broader than current argv:** `codexExecArgs` explicitly sets network/roots/approval but not `exclude_tmpdir_env_var` or `exclude_slash_tmp` (`ts/src/connectors/codex.ts:173`). §4's proposed `false` fields cannot be assumed to match an installation that overrides those settings. Probe built-in/default behavior and an override configuration; if parity requires changing exec argv or the approved app-server payload, resolve the design before implementation, rather than breaking byte parity.
- §2/source-dist AC require a durable run after MCP parent exit. Interpret the cancellation AC's “MCP parent exit” as **continue, then finish and reap**, not immediate cancellation. The real process-tree test must verify both stages.

## Verification discipline

All commands below run from the repo root. Test files and scripts marked **(new)** are planned deliverables; their commands become runnable in the slice that introduces them. Do not execute paid/live gates in ordinary `npm test`. Use a dedicated opt-in live suite; an explicitly requested live gate must fail, not silently skip, when prerequisites are missing.

**Per-slice gate (serial):** typecheck, build, and that slice's **targeted** commands only.

```sh
npm --prefix ts run typecheck
npm --prefix ts run build
# + the slice's targeted test command(s)
```

**Full suite (`npm --prefix ts test`, the suite used by `.github/workflows/test.yml:9`): exactly twice.** Once as a baseline before S1, and once at the end of S5 before the feature is marked complete. Per the owner's test-run discipline, it is not rerun per slice; targeted runs cover each slice's delta. (Controller amendment 2026-09-25; the original draft ran the full suite after every slice.) The root Makefile's Python target is retired. If the baseline is red or sandbox restrictions block sockets/process inspection, record the exact failure and repair/retest in a suitable environment before calling any slice green. Do not overlap full Vitest runs. Every fake-process test must reap its own children and clean only its temporary registry/socket paths.

## Pre-slice probes and stop conditions

These are execution prerequisites, not claims of completed live verification. Capture stdout/stderr, exit status, CLI versions, and probe paths in temporary evidence, then link retained evidence from S5's report.

| Before | Risk / unknown | Exact probe command and required evidence |
|---|---|---|
| S1 | Generated schema/version drift | `codex --version` then `codex app-server generate-ts --out /tmp/peer3-ts`; inspect the generated request, response, notification and policy types listed in S1. Re-run into a fresh directory on upgrades. Planning verified 0.155.1 only. |
| S1 | Native type stripping and generated extensionless imports | `node --version`; `cat ts/tsconfig.json ts/tsconfig.build.json`; `rg -n 'moduleUrl|baseUrl' ts/src/connectors/peer-sidecar.ts ts/src/connectors/peer-registry.ts`. Preserve NodeNext; S1's generator adapter must rewrite relative type-import suffixes deterministically rather than relaxing the whole project's module settings. |
| S1 identity gate; S2 ownership gate | `initialize` identity shape; stdin EOF exit behavior | Run the standalone Python probe below. An unrecognized identity or app-server surviving EOF blocks reliance on §2's driver-death assumption. Repeat with an active turn in S5; idle EOF alone is insufficient. |
| S2 | Exec temp defaults and ambient overrides | `codex exec --help`; `rg -n 'exclude_tmpdir_env_var|exclude_slash_tmp|sandbox_workspace_write' "$HOME/.codex/config.toml"`. Missing settings are not proof of OS enforcement. Run the S1 probe script: `node ts/scripts/peer3-probe.mjs sandbox-baseline --model gpt-6-luna/low --out /tmp/peer3-sandbox-baseline`. It must compare ordinary exec configuration to a temporary override config, including `$TMPDIR` and `/tmp`; no writes to the real config. |
| S3 | IPC survives independently of run completion; callback budget | `npm --prefix ts test -- tests/connectors/peer-sidecar.test.ts tests/connectors/peer-registry.test.ts tests/connectors/background-claude-peer.test.ts`. Examine `workerHandle`, `pumpCallbacks`, `drainCallbacks`; no reuse of the one-shot worker handle for steering. |
| S4 | Concurrent edits; complete emitted dependency graph | `git diff -- ts/src/connectors/background.ts`; `rg -n 'startBackgroundRun|killDetachedProcessGroup|cancelBackgroundRun' ts/src/connectors/background.ts`; `npm --prefix ts run build`. Rebase symbol-level changes on the current file; inspect the two explicit emitted-test module lists cited in S1/S3. |
| S5 | Real Claude peer capability, auth, model access, OS sandbox enforcement | `codex --version`; `claude --version`; `codex login status`; `node ts/scripts/peer3-probe.mjs preflight --out /tmp/peer3-preflight`. The script must validate a live Claude session/peer endpoint and resolved executable, without printing tokens. A failed fetch alone is not evidence of sandbox denial: require a successful network-on control in the same environment. |

Standalone pre-S1/S2 probe (no model turn, bounded cleanup; does not modify repo files):

```sh
python3 - <<'PY'
import json, subprocess, threading
p = subprocess.Popen(['codex', 'app-server'], stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
killed = threading.Event()
def stop():
    killed.set()
    p.kill()
limit = threading.Timer(8, stop)
limit.start()
try:
    p.stdin.write(json.dumps({'id': 1, 'method': 'initialize', 'params': {
        'clientInfo': {'name': 'stratum-peer3-probe', 'version': '0.1.0'},
        'capabilities': None}}) + '\n')
    p.stdin.flush()
    response = None
    for line in p.stdout:
        frame = json.loads(line)
        if frame.get('id') == 1:
            response = frame
            print(json.dumps(frame))
            break
    if response is None or 'error' in response:
        raise RuntimeError('initialize did not succeed')
    p.stdin.write(json.dumps({'method': 'initialized'}) + '\n')
    p.stdin.close()
    p.wait(timeout=3)
    print('stdin_eof_exit', p.returncode)
    if killed.is_set():
        raise RuntimeError('probe watchdog killed server')
finally:
    limit.cancel()
    if p.poll() is None:
        p.kill()
    p.wait()
PY
```

## SLICE 1 — Pin the protocol and extract the policy encoder

**Goal:** establish the compile-time contract and preserve today's exec bytes while adding the §4 app-server encoding. **Dependencies:** none; baseline and S1 probes pass.

**Files and symbols**

- `ts/contracts/codex-appserver/0.155.1/` **(new)** — immutable raw generated binding fixture, version/generation-command manifest and hashes. Pin the default generator output, not hand-written approximations. Include `Initialize*`, `ServerRequest`, `ServerNotification`, thread/turn start/steer, `UserInput`, usage, approval and elicitation types and their transitive dependencies.
- `ts/scripts/pin-codex-appserver.mjs` **(new)** — `checkContract` / deterministic generation adapter. Check raw fixture hashes; generate the required type closure with `.js` relative type imports into `ts/src/connectors/codex-appserver-protocol/` **(new)**. Retain original provenance headers; verify only import-specifier normalization changes the generated bytes. Production must never depend on `tests/` or `/tmp`.
- `ts/src/connectors/codex-appserver-contract.ts` **(new)** — `SUPPORTED_APP_SERVER_VERSIONS` and `assertAppServerIdentity`, tied to the manifest and observed initialize identity. Unknown/missing/malformed identities fail closed. No runtime `generate-ts` spawn on every run.
- `ts/src/connectors/codex-policy.ts` **(new)** — `encodeCodexPolicy` producing ordered exec flags and typed thread/turn policy fields from the same `SandboxPolicy`; use `modelIdentity` without creating a `codex.ts` import cycle. App-server `on-failure` is an explicit encoding error; exec still supports it.
- `ts/src/connectors/codex.ts` **(existing)** — `codexExecArgs` delegates policy encoding, keeping its public signature, defaults, argv ordering, quoting, model/effort placement and final stdin marker (`:162`). No transport-selection change.
- `ts/tests/connectors/codex-policy.test.ts` **(new)** — frozen pre-refactor argv fixtures, encoder payload matrix and mutation-sensitive byte comparisons; include roots with spaces, quotes/backslashes, no effort, explicit effort, all approval modes and all filesystem modes/network settings.
- `ts/tests/connectors/codex-appserver-contract.test.ts` **(new)** — fixture integrity, version guard and typed §4 response constants using `satisfies` on each method's generated response. Error-only methods use JSON-RPC error fixtures, not fabricated successful response values. Include required elicitation `_meta:null` and text input `text_elements:[]`.
- `ts/tests/connectors/background-claude-peer.test.ts` **(existing)** — emitted-JS module list at `:119`: add the new runtime dependency of `codexExecArgs` in this slice, so the existing Claude test remains green.
- `ts/scripts/peer3-probe.mjs` **(new)** — bounded `sandbox-baseline` command described above, using real exec runs, disposable paths/config, recorded tool results and PID cleanup. Also add the reusable evidence/timeout helpers needed by later probe modes. Do not run paid probes in unit tests.

**Acceptance**

- [ ] **AC02:** the complete regression matrix proves exec argv is byte-identical to the frozen old output and app-server policy fields match §4. Tests distinguish omitted effort, read-only network=false, workspace roots, temp flags, and authorized full access. The baseline is not computed with the new encoder.

**Targeted commands**

```sh
node ts/scripts/pin-codex-appserver.mjs --check
npm --prefix ts test -- tests/connectors/codex-policy.test.ts tests/connectors/codex-appserver-contract.test.ts tests/connectors/codex.test.ts tests/connectors/background-claude-peer.test.ts
```

Then the per-slice gate. The new driver is not launched by this slice.

## SLICE 2 — Build the standalone driver against a fake app-server

**Goal:** implement §2–§4 as an independently runnable process with one terminal owner and a testable steer service for §5. **Dependencies:** S1; pre-S2 probes resolved.

**Files and symbols**

- `ts/src/connectors/codex-appserver-driver.ts` **(new)** — direct-entry `main`, `runAppServerDriver`, request correlation, `claimTerminal`, `cleanup`, `writeExecRecord`, `respondToServerRequest`, `armStallWatchdog`, and `steer`. Keep process effects behind injectable spawn/clock/writer/peer-attachment boundaries; production timings remain the design values. Register signal/error handlers before spawning. Match notifications to the active thread/turn; de-duplicate start notifications versus RPC responses. Bound frame buffering and clear pending requests/timers on teardown.
- `ts/src/connectors/codex-appserver-ipc.ts` **(new)** — typed §5 request/result union plus internal owner-ready, active-turn-state and finalized messages. Define the driver-side peer attachment interface now; no sidecar process is required for S2 tests. The active-state message enables pre-admission refusal; the server remains authoritative for completion races.
- `ts/tests/helpers/fake-app-server.mjs` **(new)** — `serveScenario`: real stdio JSONL fake, staged handshake, interleaved notifications and server requests, strict response validation, EOF/exit/malformed-frame controls, ignored SIGTERM and explicit barriers. Wrong responses fail the fixture rather than advancing automatically.
- `ts/tests/connectors/codex-appserver-driver.test.ts` **(new)** — protocol/stream/request/watchdog/terminal tables, using fake time for long deadlines and real child-process tests for pipe closure and signals. Feed emitted streams into public `pollBackgroundRun` with a temporary metadata fixture, not a duplicate parser.
- `ts/scripts/peer3-probe.mjs` **(existing)** — add bounded `server-requests` mode and real-server evidence capture; use temporary tools/configuration to elicit §4 requests and verify continuation or termination after each response.
- `ts/tests/connectors/codex-appserver.live.test.ts` **(new)** — opt-in `server requests` group validates the real-server transcripts. The explicit live command fails if required evidence is unavailable; the ordinary suite skips paid activity.
- `ts/scripts/prepare-dist.mjs` **(existing)** — `entries` (`:11`): include the driver executable shebang normalization if using the same direct-entry convention as the sidecar. Keep runtime contract identity data in emitted TS so no unshipped fixture is required.

Implementation must serialize records through one writer and claim synchronously before awaiting cleanup. Do not import `background.ts` from the standalone entry merely to obtain the sentinel literal: that pulls in workers/SDKs and `.js` source imports. Follow `moduleUrl` (`ts/src/connectors/peer-sidecar.ts:11`) for the driver's complete runtime dependency graph, including the shared policy helper. Gate identity before `thread/start`. Driver stderr diagnostics must not masquerade as terminal stream records.

**Acceptance**

- [ ] **AC05:** every §4 server-request fixture type-checks; the fake server validates the actual reply and completes its request before continuing or terminating. Cover modern/legacy approvals, empty permission grant, elicitation nullable fields, user-input rejection, auth/attestation/tool/unknown errors. Test the 120s silence failure and notification-reset behavior, multiple requests, and no watchdog termination after an existing claim. Real-server compatibility is also required here using the opt-in command below; S5 repeats it on final installed versions. A fake acceptance assertion alone is not that evidence. If a method cannot be exercised, record the gap and resolve it before accepting AC05.
- [ ] **AC06:** §3 table passes through the unchanged poll reader: multiple completed assistant messages, ignored deltas, last cumulative usage snapshot, cached/cache-write/reasoning fields, absent usage, partial text plus failure, interruption, retryable error, malformed frames including counter reset, and records durably flushed before the sentinel. Test non-agent items with an exec equivalent and dropped unsupported items. No writes from late events after a claim.
- [ ] **AC12:** table-driven claims cover every listed ordering, each handshake rejection naming its step, spawn error, 60s no-start, EOF/exit, truncated EOF, and repeated signals during reap. Assert sentinel **count and value**, error records, cleanup ordering and eventual process exit, including completion→signal and signal→interruption. Use staged barriers for races; no sleep-based guesses.

**Targeted commands**

```sh
npm --prefix ts test -- tests/connectors/codex-appserver-contract.test.ts tests/connectors/codex-appserver-driver.test.ts tests/connectors/background.test.ts
node ts/scripts/peer3-probe.mjs server-requests --model gpt-6-luna/low --out /tmp/peer3-requests
STRATUM_LIVE_PEER3=1 STRATUM_PEER3_EVIDENCE=/tmp/peer3-requests npm --prefix ts test -- tests/connectors/codex-appserver.live.test.ts -t "server requests"
```

Then the per-slice gate. Driver is executable for fixtures but not selected by `startBackgroundRun` yet.

## SLICE 3 — Add the authenticated sidecar owner and reserved results

**Goal:** implement §5–§6 on the existing callback infrastructure before publishing the strategy. **Dependencies:** S1–S2; pre-S3 harness passes.

**Files and symbols**

- `ts/src/connectors/peer-registry.ts` **(existing)** — extend `PeerSidecarConfig` (`:173`), `sidecarEnv` (`:177`), `configFromEnv` (`:191`) with discriminated `codex-appserver` owner/run identity. Existing default process-owner and worker encodings retain their behavior.
- `ts/src/connectors/peer-sidecar.ts` **(existing)** — `spawnPeerSidecar` (`:66`) gets a distinct persistent app-server handle; preserve `workerHandle`. In `main`, add owner message handling/active-state tracking, auth state passed into `receive` (`:235`), reservation admission and result settlement. Adapt `pumpCallbacks` (`:174`), `drainCallbacks` (`:215`) and `cleanup` (`:395`) to share the eight active callback slots with the separate reserved-result list. Include reserved waves when calculating the five-second shutdown budget.
- `ts/src/connectors/codex-appserver-ipc.ts` **(existing)** — validators and persistent `AppServerPeerHandle` using S2's attachment boundary; runtime checks for malformed/stale IPC messages.
- `ts/src/connectors/codex-appserver-driver.ts` **(existing)** — `attachPeer` uses the persistent handle; send current active state when readiness arrives late and close admission synchronously with the terminal claim. Steer failure settles only the message, never the run. Sidecar crash/registration failure must leave the driver running.
- `ts/tests/connectors/peer-sidecar-appserver.test.ts` **(new)** — real socket/IPC lifecycle and authentication harness, including actual envelope preservation and provenance prefix.
- `ts/tests/connectors/peer-sidecar-reservations.test.ts` **(new)** — saturation test using held callback sockets and measured attempt counts/reservation occupancy, not merely queue implementation snapshots.
- `ts/tests/connectors/peer-sidecar.test.ts` **(existing)** — extend owner-kind refusal regression; preserve original advisory-auth assertions at `:216` and worker IPC cases at `:869`. Update emitted dependency list at `:372` if the shared IPC module is a runtime dependency.
- `ts/tests/connectors/peer-registry.test.ts` **(existing)** — owner configuration round-trip/validation cases.
- `ts/tests/connectors/background-claude-peer.test.ts` **(existing)** — emitted dependency list at `:119` gains any new runtime sidecar dependencies in this same slice.

Do not route admitted refusals through `sendControl`'s discardable queue (`ts/src/connectors/peer-sidecar.ts:161`). Keep the reservation until the callback attempt finishes, with one idempotent release path for success, timeout, socket failure and shutdown. Preserve sender mode and original message correlation independently from the unique internal `reqId`. Ignore duplicate pending `(senderFrom,msgId)` without consuming another reservation; late driver responses cannot create a second callback.

**Acceptance**

- [ ] **AC08:** an authenticated post-completion message during linger is refused without a new turn; test both stream-observed completion and owner-state arrival before the sentinel.
- [ ] **AC09:** absent/wrong/late first-frame auth is denied for this owner; valid first auth permits steering. Repeated auth cannot repair a bad first frame. Idle subscriptions and other owners remain advisory.
- [ ] **AC10:** complete §5 lifecycle matrix with simultaneous senders, duplicate IDs, delayed/lost results, before/after-send disconnect, timeout/no retry, eight held slots, and turn-completion race. Assert the driver remains live after message failures and completes normally when released; delivered requires a matching returned turn ID.
- [ ] **AC11:** fast driver acknowledgements plus held callbacks retain all eight reservations; 32 distinct idle subscriptions survive; same-sender results remain distinct. Include an **admitted stale-expectedTurnId rejection** and terminal cleanup. Every admitted result gets exactly one callback attempt, no idle notice is lost, total reserved state stays at eight, and shutdown stays within five seconds (allow only test scheduling tolerance).
- [ ] **AC15:** exec/process and Claude-worker owners still refuse `user` frames with the current status/mode/callback-auth behavior; existing refusal, worker finalization, callback saturation, and owned-file cleanup tests pass unchanged in meaning.

**Targeted commands**

```sh
npm --prefix ts test -- tests/connectors/peer-sidecar-appserver.test.ts tests/connectors/peer-sidecar-reservations.test.ts tests/connectors/peer-sidecar.test.ts tests/connectors/peer-registry.test.ts tests/connectors/background-claude-peer.test.ts tests/connectors/codex-appserver-driver.test.ts
```

Then the per-slice gate. The new owner is usable by harnesses, while production background selection remains exec.

## SLICE 4 — Wire background selection and durable process ownership

**Goal:** expose the complete strategy through §1 using §2's detached ownership. **Dependencies:** S1–S3; refresh current symbols and build before editing.

**Files and symbols**

- `ts/src/connectors/background.ts` **(existing)** — add `resolveCodexBackgroundStrategy`; change only the Codex launch branch in `startBackgroundRun` (`:136`). Validate selector/on-failure before spawning or creating a run directory. Use the existing `options.command` seam as exec even when the selector requests app-server; reject other invalid strategy values with a clear error. Persist driver PID/start identity through the existing metadata flow. Keep cancellation, polling and foreground unions unchanged.
- `ts/src/connectors/codex-appserver-launch.ts` **(new)** — `launchCodexAppServerDriver`, private launch config serialization (0600 within the 0700 run directory), source/dist entry resolution, bounded bootstrap/registration acknowledgement, and parent-channel disconnect after bootstrap. Avoid passing the prompt in argv. A config-file handoff keeps source resolution out of `background.ts` and bounds concurrent-file edits.
- `ts/src/connectors/codex-appserver-driver.ts` **(existing)** — `main` loads launch config and starts sidecar itself after bootstrap. Parent IPC is for startup only; disconnect/MCP death does not cancel a durable run. Ensure app-server is non-detached in the driver's group, sidecar detached in its own group, and driver does not spawn app-server until metadata has been persisted and startup released. This prevents a metadata-write failure from leaving an untracked app-server.
- `ts/tests/connectors/background-appserver.test.ts` **(new)** — selector matrix and registration success/disabled/failure; normal output contract (never opaque), sandbox audit/preamble/env parity, real process-group cancellation against fake app-server, and no-start rejection.
- `ts/tests/connectors/background-appserver-launch.test.ts` **(new)** — actual src strip-types and isolated built-dist launches, parent exit, metadata failure, source absence and registration failure. Copy a built package into a temporary tree so dist cannot accidentally resolve sibling source files.
- `ts/tests/connectors/background-codex-lifecycle.test.ts` **(existing)** — metadata-write failure case (`:43`) covers the new driver alongside exec; retain existing group teardown assertions.
- `ts/tests/connectors/codex.test.ts` **(existing)** — foreground selector isolation regression alongside existing `resolveCodexTransport` tests (`:86`).
- `ts/tests/connectors/background-claude-peer.test.ts` **(existing)** — emitted module list (`:119`) gains launch dependencies if imported eagerly by `background.ts`.

Preserve the environment scrubbing/headless-shell rules in `startBackgroundRun` (`ts/src/connectors/background.ts:186`), prompt framing, label naming, and peer registration budget. A timed-out or failed registration must never block driver completion, leak a late endpoint, or claim a registered peer name without evidence. Driver-side registration inherits the selected run environment. Parent teardown must not own the long-lived sidecar IPC.

**Acceptance**

- [ ] **AC01:** every §1 selector row passes, including explicit environment replacing ambient settings, options.command precedence, peer failure/disablement, defaults and unchanged foreground `STRATUM_CODEX_TRANSPORT` semantics.
- [ ] **AC04:** app-server plus on-failure rejects clearly before any process spawn (assert spawn spy count and no run-directory side effect); injected-command exec retains old behavior.
- [ ] **AC14:** src and source-free built dist launch the driver with correct arguments; driver survives MCP parent exit and completes; registration failure does not affect poll output. Verify independent driver/app-server/sidecar process groups and persisted driver identity. Fake-server cancellation and driver-death tests supply prerequisites for S5's live AC13.

**Targeted commands**

```sh
npm --prefix ts run build
npm --prefix ts test -- tests/connectors/background-appserver.test.ts tests/connectors/background-appserver-launch.test.ts tests/connectors/background-codex-lifecycle.test.ts tests/connectors/background.test.ts tests/connectors/codex.test.ts tests/connectors/background-claude-peer.test.ts tests/connectors/background-claude.test.ts tests/connectors/background-claude-interleavings.test.ts
```

Then typecheck (the build above satisfies the gate's build step).

## SLICE 5 — Live interoperability, sandbox and process-tree exit gate

**Goal:** establish installed-version evidence for the designed behavior and record the release decision. **Dependencies:** S1–S4 green; all preflight prerequisites pass. A blocked live case leaves this slice incomplete, not “passed by fixture.”

**Files and symbols**

- `ts/scripts/peer3-probe.mjs` **(existing)** — extend `server-requests` and add `preflight`, `sandbox`, `process-tree`, `golden`, and `verify-evidence` modes. All modes have deadlines, private artifact storage and cleanup of captured PIDs; no global process-name killing. Use the same pinned binary and launch implementation as production. `golden` must coordinate with a real Claude Code session using its actual `ListAgents`/`SendMessage` tools; raw socket traffic is insufficient for this gate.
- `ts/tests/connectors/codex-appserver.live.test.ts` **(existing)** — extend S2 with opt-in live sandbox/process checks and golden-evidence validation. `STRATUM_LIVE_PEER3=1` enables the suite; ordinary CI skips paid activity. Under explicit opt-in, missing CLI/login/Claude evidence is a failure. Run model turns as `gpt-6-luna/low`.
- `docs/features/STRAT-AGENT-PEER-3/report.md` **(new)** — evidence manifest, per-AC outcome, versions, commit/OS/Node identity, commands/exit codes, raw-artifact references, timings, limitations and explicit pass/block exit decision.
- `README.md` **(existing)** — background-strategy configuration, supported approval behavior, truthful delivery/uncertainty, completion subscription and cancellation semantics.
- `CHANGELOG.md` **(existing)** — feature entry with opt-in strategy and compatibility limits.
- `docs/features/STRAT-AGENT-PEER-3/feature.json` **(existing)** — status/update fields advance only after the evidence gate actually passes.

The golden runner starts a bounded waiting task; the real Claude session discovers its peer, subscribes once with `notify_when_idle`, and sends an unpredictable marker while the turn is active. Retain the actual sender callback, model-visible thread rollout and changed final output. The script must fail if the marker was already in the original prompt, if a new turn was created, or if only a transport acknowledgement was observed. Save a second post-completion request within linger as supporting evidence for S3's AC08.

For real server-request compatibility, exercise supported modern requests with temporary configuration/tools and record each accepted response or error and subsequent continuation/terminal state. Include controllable local MCP elicitation and tool input where needed. If a legacy/other method cannot be elicited on the installed CLI, explicitly mark that real-server evidence unavailable and resolve it before declaring the complete exit gate passed; generated type checks and a fake server do not prove actual server acceptance.

**Acceptance**

- [ ] **AC03:** real app-server read-only denies a tool write; workspace-write permits the selected writable root and denies an OS-writable path outside cwd/roots/temp allowances; network-off denies a fetch that the network-on control can perform; `/tmp` and `$TMPDIR` match exec under the probed configuration. Assert tool exit/results and filesystem effects, not model prose. Record ambient override differences rather than silently widening permissions.
- [ ] **AC07:** real Codex/Claude golden flow satisfies the design's entire chain: active-turn delivery, returned delivered status, rollout text and changed output, complete poll with correct concatenated text and non-zero input/output accounting, exactly one idle notice and echoed `from_mode`.
- [ ] **AC13:** live process-tree matrix covers cancel during initialize, active turn and a pending steer; an app-server SIGTERM-ignore test uses a controlled signal shim around the real binary and records that fault injection; MCP-parent death allows completion; driver SIGKILL causes sentinel-less poll failure and EOF-driven app-server exit. Capture `ps -axo pid,ppid,pgid,stat,command` before and after each bounded case and verify captured driver/app-server PIDs/start identities are gone. Native-signal cases and shim cases are labeled separately. Test completion winning cancellation as well as cancellation winning; one terminal outcome in each. Sidecar may linger; tool descendants with separate groups remain the explicit §2 limitation.
- [ ] **AC16:** repeat the full live exit gate on the installed Codex and Claude versions after the final implementation changes; `report.md` contains outcomes and inspectable evidence, including server-request compatibility reruns. No fixture-only, skipped, version-mismatched or blocked case counts as a live pass.

**Targeted commands**

```sh
node ts/scripts/peer3-probe.mjs preflight --out /tmp/peer3-live
node ts/scripts/peer3-probe.mjs server-requests --model gpt-6-luna/low --out /tmp/peer3-live
node ts/scripts/peer3-probe.mjs sandbox --model gpt-6-luna/low --out /tmp/peer3-live
node ts/scripts/peer3-probe.mjs process-tree --model gpt-6-luna/low --out /tmp/peer3-live
node ts/scripts/peer3-probe.mjs golden --model gpt-6-luna/low --out /tmp/peer3-live
STRATUM_LIVE_PEER3=1 STRATUM_PEER3_EVIDENCE=/tmp/peer3-live npm --prefix ts test -- tests/connectors/codex-appserver.live.test.ts
node ts/scripts/peer3-probe.mjs verify-evidence --out /tmp/peer3-live
```

Then the **final full suite** (`npm --prefix ts test`) with live opt-in unset. Retain a redacted evidence bundle at a durable location and link it from `report.md`; `/tmp` alone is not durable report evidence. Do not store peer tokens, credentials, or unrelated session transcripts.

## Design AC coverage

| Design AC (bullet order) | Single owning slice |
|---|---|
| AC01 — background selection/foreground isolation | S4 |
| AC02 — shared policy / byte-identical exec argv | S1 |
| AC03 — live sandbox probe | S5 |
| AC04 — on-failure rejected before spawn | S4 |
| AC05 — typed server replies, acceptance, stall watchdog | S2 |
| AC06 — stream translation and record ordering | S2 |
| AC07 — live Codex/Claude golden flow | S5 |
| AC08 — finished-run refusal during linger | S3 |
| AC09 — steer authentication, other owners unchanged | S3 |
| AC10 — message lifecycle, failures do not end run | S3 |
| AC11 — reservations under saturation and shutdown | S3 |
| AC12 — terminal claims / startup and transport failures | S2 |
| AC13 — live cancellation/process-tree matrix | S5 |
| AC14 — source/dist, parent detachment, registration failure | S4 |
| AC15 — existing exec/Claude refusal behavior | S3 |
| AC16 — repeated installed-version live report gate | S5 |

Unplaced ACs: **none**. S2's server-acceptance evidence is strengthened by S5's real-server rerun; S4's process fixtures prepare S5's live cancellation gate. Neither creates a second owner.

## Tests

| Changed code | Test file(s) | Action |
|---|---|---|
| Protocol pin/identity and policy encoder | `codex-appserver-contract.test.ts`, `codex-policy.test.ts`, `codex.test.ts` | Add contract/policy suites; preserve foreground regression |
| Driver terminal/stream/request logic | `codex-appserver-driver.test.ts`, `background.test.ts` | Add fake stdio and poll integration; retain baseline |
| Peer owner/auth/reservations | `peer-sidecar-appserver.test.ts`, `peer-sidecar-reservations.test.ts`, `peer-sidecar.test.ts`, `peer-registry.test.ts` | Add socket/IPC tests; extend config/refusal tests |
| Background launch and build graph | `background-appserver.test.ts`, `background-appserver-launch.test.ts`, `background-codex-lifecycle.test.ts`, `background-claude-peer.test.ts` | Add launch/lifecycle tests; update emitted dependency lists at introduction |
| End-to-end installed behavior | `codex-appserver.live.test.ts` | Add explicit opt-in gate with evidence validation |

All test filenames in this table are relative to `ts/tests/connectors/`. Exact targeted commands appear in each slice. Required final commands: `npm --prefix ts run typecheck`, `npm --prefix ts run build`, `npm --prefix ts test`; additionally the S5 live commands, with recorded evidence, are mandatory for feature completion.

## Documentation

- [ ] S5: `README.md` — document the new background-only selector and operational semantics; foreground API stays unchanged.
- [ ] S5: `CHANGELOG.md` — add the feature under the repository's current unreleased convention.
- [ ] S5: `docs/features/STRAT-AGENT-PEER-3/report.md` — record installed-version exit gate and every unresolved discrepancy/probe.
- [ ] S5: `docs/features/STRAT-AGENT-PEER-3/feature.json` — update status only when the corresponding work is done.

No SmartMemory service/SDK/docs-repo changes are implied: this feature is internal to Stratum's background connector. If a probe requires changing a decided design behavior, record and resolve that design delta before implementing the affected slice.
