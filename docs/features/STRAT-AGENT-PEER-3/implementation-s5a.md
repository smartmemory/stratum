# S5 part A implementation

Implemented only the preflight, sandbox and process-tree probes and their opt-in evidence checks. No production connector changes, golden flow, verify-evidence mode, release report, README/CHANGELOG changes, feature-status advancement, or commit. The controller's existing progress.md edits were preserved.

## Modes and evidence

Pass `--out ROOT` to each new mode. It creates `ROOT/<mode>/` exclusively (refuses to overwrite that mode), with private directories/files and `summary.json`. Each summary case has `case`, `outcome` (`passed`, `failed`, `unreached`), relative `evidence` paths, probe `exitCode` (0/1; null for unattempted cases), and `timings`. Individual JSON files retain the underlying command exit codes, tool results or terminal polls. Any failed/unreached case makes the mode exit nonzero. The test gate independently reassesses individual evidence; skipped/unreached cases never become passes.

- **preflight:** six cases: exact generated Codex pin, authenticated login classification, Node, OS, git HEAD, Claude version. Commands have 10-second deadlines; login output is reduced to a boolean to avoid retaining account/key information. Uses a disposable CODEX_HOME containing a private auth copy. It does not prove a real Claude peer session; that belongs to part B.
- **sandbox:** fresh existing exec baseline in `sandbox/exec-baseline/`, then seven production `startBackgroundRun` cases: read-only, workspace-write, network-on/off, and built-in/ordinary/override temp configurations. Uses `STRATUM_CODEX_BG_STRATEGY=app-server`; records policy from the actual driver launch file. Completed command exit codes and nonce-tagged tool results must agree with host file effects. The outside target is a private, OS-write-tested directory under the user's home, outside cwd/selected roots/temp allowances. Fetch control uses https://example.com with a 15-second fetch deadline. Missing tool execution/model refusal fails rather than proving denial.
- **process-tree:** eight cases: initialize cancellation, active cancellation, pending-steer cancellation, SIGTERM-ignore, parent death, driver SIGKILL, completion wins, cancellation wins. Active cancellation, parent death and driver SIGKILL exec the real binary directly after capturing its PID. Other cases explicitly label a Python protocol/signal shim wrapping the real binary. The shim holds genuine initialize/steer/completion responses or holds EOF and ignores SIGTERM; it never fabricates protocol success. Pending steer goes through the production authenticated sidecar; its callback destination is deliberately absent because this case tests cancellation with an outstanding driver request, not delivery acknowledgment. Parent death kills a separate launcher after an active turn and verifies the detached driver survives to completion.

Process cases retain `<case>.before.ps`, `<case>.after.ps` and `<case>.json` with captured PID/start identities, groups, barrier events, cancellation acknowledgment, stream records and final poll. `ps -axo pid,ppid,pgid,stat,command` retains owned command lines; unrelated command text is redacted to avoid exposing credentials. Gone checks happen before emergency cleanup; cleanup cannot convert a leak into a pass. Captured identities gate individual PID kills. Sidecar linger and tool descendants in separate groups remain the documented limitation. Model-run waits are bounded at 180 seconds; startup/barrier/reap waits have shorter deadlines. SIGINT/SIGTERM abort subsequent cases and enter cleanup. Disposable auth/config/session files are removed, not retained as evidence.

## Controller commands

Run from the repository root, **unsandboxed**, using a new evidence root:

```sh
npm --prefix ts run build
node ts/scripts/peer3-probe.mjs preflight --out /tmp/peer3-s5a
node ts/scripts/peer3-probe.mjs sandbox --model gpt-6-luna/low --out /tmp/peer3-s5a
node ts/scripts/peer3-probe.mjs process-tree --model gpt-6-luna/low --out /tmp/peer3-s5a
cd ts
STRATUM_LIVE_PEER3=1 STRATUM_PEER3_EVIDENCE=/tmp/peer3-s5a ./node_modules/.bin/vitest run tests/connectors/codex-appserver.live.test.ts -t 'S5a real production evidence'
```

Stop before paid modes if preflight fails. The full test file also validates existing server-request evidence. That existing mode retains its legacy directory contract: invoke it separately with `--out ROOT/server-requests`; the gate accepts that subdirectory or the legacy root report. Part A does not rerun it automatically.

**Expected unresolved policy boundary:** the production app-server encoder explicitly sends false for both temp exclusions, whereas the exec override baseline excludes both roots. The override case records the discrepancy and fails if observed. It does not change production permissions or silently accept the mismatch. Controller/design adjudication is required if the installed binary confirms that difference. Ordinary config can likewise differ from built-in defaults. Baseline failure prevents claiming app-server parity.

## Local verification

No real Codex/Claude model turns or paid modes were run.

- `node --check ts/scripts/peer3-probe.mjs`: passed.
- `npm --prefix ts run typecheck`: passed.
- `npm --prefix ts run build`: passed.
- Targeted Vitest file: 15 passed, 4 live tests skipped without opt-in.
- Fake executables: preflight success and exact-version-mismatch rejection passed; no credentials or live CLI used.
- Generated Python shim parsed successfully. An initial py_compile check was blocked by Apple's external bytecode-cache directory; an AST-only syntax check passed.
- Explicit opt-in against a missing evidence directory: exited 1 with all three S5a evidence tests failing as required.

Live sandbox enforcement, real signal/EOF behavior, actual pending steer, and installed-version interoperability remain controller verification work. AC03/AC13/AC16 are not declared passed by these local checks. The final full suite and release decision remain in part B.

## Temp-exclusion fix

Implemented the decided 2026-09-25 §4 delta: app-server sends the sandbox mode at `thread/start.sandbox` and, only for workspace-write, the dotted writable-roots/network config keys. Both transports derive these overrides from one config object; frozen S1 AC02 tests confirm exec argv remains byte-identical. No `turn/start.sandboxPolicy` or temp-exclusion override is sent, allowing ambient exclusions to be inherited.

The driver checks thread/turn parameters against the generated bindings. Background launch retains the original Stratum policy for driver encoding and probe inspection. The strict fake validates all three thread modes and rejects turn sandbox overrides and extra config keys; policy tests compare app-server config with parsed exec overrides. The live transcript assertion now checks thread sandbox placement. The sandbox probe already reads the unchanged launch policy, so its code and temp-override expectation were left unchanged: any exec/app-server discrepancy still fails.

Verification: `npm --prefix ts run build` and `npm --prefix ts run typecheck` passed. The requested seven-file Vitest run finished with **513 passed, 4 live tests skipped, 1 sandbox-blocked failure**: `background-appserver.test.ts` — `AC01/AC14 successful registration proves label and independent sidecar group` (`listen EPERM` on its Unix socket). All driver, contract, policy, exec, launch, and non-live evidence tests passed. Log: `/tmp/peer3-temp-fix-tests.log`.

No paid calls or commits. This supersedes the earlier unresolved implementation description, but live sandbox parity remains unproven until all seven sandbox cases, including temp-override, pass on the real server.

## Pending-steer diagnosis

Root cause was the probe's callback address, not the production steer path. It sent `from: uds:<root>/absent-callback.sock`; `peer-registry.ts:isAllowedCallback` requires a numeric PID basename matching `^\d+\.sock$`. The sidecar rejects this before authentication/admission and before sending IPC, logging `peer frame rejected: invalid callback or msg_id`. A new real-socket regression reproduces the exact old frame and asserts that stderr diagnostic and zero steer IPC requests. The missing listener was also unsuitable for observing results, but reachability was not the admission failure. Auth shape, first-frame placement, newline framing and half-close match the existing S3 tests.

The probe now binds a PID-named callback socket, creates its disposable callback-auth key, sends the existing auth/user frames, and records authenticated callback frames (tokens redacted) plus any replies on the sending connection. Refusal or any settlement before the held-response barrier throws with the actual reply and marks the case failed rather than unreached. Probe-only Node preloading observes both directions of sidecar IPC without modifying production code; case JSON retains the IPC messages, and separate `.err`/`.peer.err` artifacts preserve driver/server and sidecar stderr. The case assessment requires steer IPC, the client's `turn/steer`, the held-response barrier and cancellation's `dropped/unknown` callback.

Added `--case cancel-pending-steer` (process-tree only, validated before launch). Selected summaries name their scope and do not satisfy the full eight-case evidence gate. Moved CLI invocation below module initialization so early case validation can safely access the case list.

Task 0 was completed first: the pure `sandboxExpectations` helper derives temp-case TMPDIR and slashTmp expectations from the corresponding exec observations. The probe records tempComparison before assessment, still rejects every exec/app-server difference, and preserves all other case expectations. Unit coverage exercises allowed/denied observations for all three temp configurations, missing baseline rejection and mismatches. No live sandbox run was used.

Live rerun (2026-09-25):
```sh
node ts/scripts/peer3-probe.mjs process-tree --case cancel-pending-steer --model gpt-6-luna/low --out /tmp/peer3-pending-diagnosis-154245
```

**Passed**, exit 0, 3,846 ms. Evidence: `/tmp/peer3-pending-diagnosis-154245/process-tree/{summary,cancel-pending-steer}.json`, with before/after process snapshots and both stderr artifacts. Run ID `b723fa6b1f73`. IPC records active turn `01a0d784-414f-7da1-a17d-470783f0f95d`, followed by sidecar request `2a6927f9-6a2c-47a2-b398-97750f445ceb` carrying that expectedTurnId. The protocol relay records client `turn/steer` at 1790322164.064383 and `held-steer-response` at 1790322164.065321. Cancellation returned `cancelled`; matching steer-result IPC and authenticated callback both report `dropped/unknown`. Terminal poll is `error / child_died_without_sentinel`, no done sentinel exists, and driver 81406, shim 81408 and real app-server 81412 were all observed dead before emergency cleanup.

Retained diagnostic: the Python relay emitted an interpreter-shutdown buffered-stdin/daemon-thread error after SIGTERM. This is in the controlled shim's shutdown, after the steer barrier and cancellation; it does not establish a native app-server fault. Native cancellation was not rerun in this single-case task.

Verification: build and typecheck passed. The exact requested five-file Vitest command, without STRATUM_TEST_ALLOW_SOCKET_EPERM, passed **129 tests**, with **4 opt-in live tests skipped**. New socket tests cover the old callback rejection, corrected sender admission/correlation/authenticated result, and denied-auth failure. No production source changes or commits were made for this diagnosis.

**Live-run count: 1** model-bearing attempt, passed. An earlier CLI invocation failed locally during module initialization before creating an output directory or launching Codex; it incurred no model run. No other process-tree cases or sandbox cases were run.

## Review r1 fixes

Fixed both evidence-gate defects in `impl-review-s5a-r1.md`. Only the probe, live evidence tests, two synthetic JSON fixtures, and this section were changed for r1. Production source and the concurrent agent's excluded paths were not edited. No paid runs or commits were made.

The sandbox gate now calls `assessExecBaseline` on all three raw CLI artifacts. It requires exit 0, no termination reason/signal/error, parseable stdout, a completed turn without failed/error records, and exactly one successful `PEER3_TOOL_RESULTS` probe command. Raw tool results must contain boolean observations and agree with host observations, retained tool/result metadata, comparison metadata, and the parity prerequisite. The report must have no error and the exact three configurations. The app-server temp observations and recorded comparison are checked against the reconstructed raw values. The probe uses the same assessment before comparing new sandbox runs.

Process assessment enforces the native/shim label per case and a recorded action boundary: `{kind, time, records}` captures the stream prefix immediately before cancel or SIGKILL. That prefix must match the final retained records, contain `turn.started` for active cases, and contain no completion before cancellation (except the explicit completion-wins case, which requires completion). Future probe invocations capture this boundary; historical artifacts are never backfilled. Pending-steer assessment follows sent `msg_id` through sidecar steer IPC, the preceding active-turn-state IPC (including thread/run identity), matching `expectedTurnId`, matching driver steer-result `reqId`, dropped/unknown result, and the authenticated dropped/unknown callback for the sent message. IPC ordering and request/client/held-response/action/result times must agree.

Fixtures in `ts/tests/fixtures/peer3-s5a/` are synthetic, not altered live evidence. Every negative test starts from a passing fixture and mutates an observation. Coverage includes raw exit/reason/signal/parse/terminal/tool failures, inconsistent report metadata, each steer correlation link and authentication, action ordering, absent active records, and wrong labels. The former test accepting empty cancellation records now explicitly rejects them.

Verification (2026-09-25):

- `npm --prefix ts run build`: passed; `/tmp/peer3-r1-build.log`.
- `npm --prefix ts run typecheck`: passed; `/tmp/peer3-r1-typecheck.log`.
- Requested two-file Vitest run: **362 passed, 4 skipped**, including 55 new fixture test cases; `/tmp/peer3-r1-tests.log`.
- Exact S5a gate on `/tmp/peer3-s5a-full-154454`: **2 passed, 1 failed**, exit 1; `/tmp/peer3-r1-real.log`. Preflight and sandbox pass. Process-tree fails with `Missing recorded action boundary`.
- Reviewer baseline mutant: **1 passed, 2 failed**, exit 1; `/tmp/peer3-r1-baseline-mutant.log`. Sandbox fails on the raw baseline exit; process-tree also lacks action boundaries.
- Reviewer process mutant: **2 passed, 1 failed**, exit 1; `/tmp/peer3-r1-process-mutant.log`. Its process gate fails closed; the fixtures independently isolate the reviewer's missing-record, callback-authentication, missing-result and label defects.

**Remaining evidence limitation:** The real root lacks `action.kind`, `action.time`, and `action.records` in all seven action-driven artifacts: cancel-initialize, cancel-active, cancel-pending-steer, parent-death, driver-sigkill, completion-wins, and cancellation-wins. Native artifacts retain untimed `turn.started` records and the asserted `activeBeforeAction` boolean, but no independently retained pre-action boundary. Consequently the requested all-green real gate cannot honestly be reported. No field was fabricated, no check was weakened, and no paid replacement evidence was generated. The pending-steer active turn ID itself is present in retained `active-turn-state` IPC; the normalized stream's `turn.started` record does not contain an ID.

Mutation proof: `/tmp/peer3-r1-mutations.py` copied the probe, test and fixtures to `/tmp/peer3-r1-mutations-hnbh4ee2`. Its unchanged control passed. It then deleted each of the **32 new guard statements individually** in that scratch copy; **32/32 produced failing tests (exit 1)**. Repository code was never deleted for this experiment. Individual results are in `results.json`, with one `<check>.log` per mutation and `control.log`; the console summary is `/tmp/peer3-r1-mutations.log`. Tests assert rejection and the relevant diagnostic; some removed guards still reject via downstream consistency guards but fail the diagnostic assertion. This is guard-deletion coverage, not a claim that every mutation admits bad evidence.

The individually deleted guards were:

- Baseline: `baseline-error`, `baseline-modes`, `baseline-exit`, `baseline-reason`, `baseline-signal`, `baseline-completion`, `baseline-failed-record`, `baseline-tool-status`, `baseline-tool-metadata`, `baseline-result-metadata`, `baseline-boolean`, `baseline-observed`, `baseline-comparison`, `baseline-parity`.
- Process: `process-label`, `process-action`, `process-prefix`, `process-active`, `process-no-completion`, `process-completion`.
- Pending steer: `steer-sent`, `steer-request`, `steer-msg`, `steer-active`, `steer-thread`, `steer-run`, `steer-result`, `steer-outcome`, `steer-ipc-order`, `steer-order`, `steer-auth`, `steer-callback`.
