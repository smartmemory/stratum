# S5 part B implementation

Implemented `golden start`, `golden collect`, `verify-evidence`, opt-in evidence tests, and synthetic negative fixtures. No production source changes, paid/live runs, real Claude session access, release-status changes, or commits.

## Source review and implementation decisions

The implementation follows Part A's built production imports, private evidence files, PID/start identities, bounded waits, authenticated callback sender, and independent raw-artifact assessors. The implementation blueprint was: extend the existing probe and live-test file; add a synthetic golden fixture and this document; leave production and concurrent-agent paths untouched.

| Spec assumption | Source finding | Implementation |
| --- | --- | --- |
| Disposable sessions directory | Golden requires discovery by the real controller | Resolve `resolveSessionsDir(process.env)` before creating disposable `CODEX_HOME`; use production's default socket directory too. This honors `STRATUM_PEER_SESSIONS_DIR` / `CLAUDE_CONFIG_DIR` overrides, otherwise `~/.claude/sessions`. |
| Copy Part A callback directory unchanged | The sidecar accepts callbacks only in its own or recognized Claude socket namespaces | Bind collection's PID-named callback in the peer socket's directory, with the temporary key in the real sessions directory. |
| Summary version fields suffice | Part A does not retain all three identities independently for every mode | New invocations write `identity.json` with bounded raw Codex/Claude version and git HEAD command results. Old bundles without those files fail closed; do not backfill identities. |
| Controller transcript exposes wire fields | Static inspection of installed Claude shows a JSON SendMessage result with `success` / `msg_id`, and a prose idle notice; it does not establish that `delivered` / `from_mode` are retained in that result | Retain only matching tool blocks and idle-notice blocks. A probe-only sidecar preload additionally observes incoming user/subscription frames, outgoing callbacks, and IPC, excluding authentication tokens. **The gate still requires controller tool-result `status: delivered` and matching `from_mode`; a success/msg_id acknowledgement does not pass.** |

The last row is a compatibility risk, not a live-verified result. The supplied fixture deliberately includes the required controller evidence; it is not presented as an actual installed-Claude transcript. If the real transcript contains only the renderer shape found statically, collection will fail `Golden delivered callback, not ack` (or `Golden from_mode echo`). Do not edit the transcript, have the controller manufacture a tool result, or downgrade that failure to a pass. A controller-side capture/format decision is needed if confirmed. Sidecar writes alone cannot prove the controller received its delivery status.

## Exact controller sequence

Run these commands unsandboxed from the repository root, using the real Claude Code **main conversation** with inbound peer messaging enabled. Do not launch another Claude session for this probe. Pick a fresh evidence root. Use the same installed binaries and git HEAD for every mode, after building this implementation.

```sh
npm --prefix ts run build
node ts/scripts/peer3-probe.mjs preflight --out /tmp/peer3-s5b
```

Stop if preflight fails. With authorization for the paid modes, gather the complete Part A matrix and compatibility rerun:

```sh
node ts/scripts/peer3-probe.mjs sandbox --model gpt-6-luna/low --out /tmp/peer3-s5b
node ts/scripts/peer3-probe.mjs process-tree --model gpt-6-luna/low --out /tmp/peer3-s5b
node ts/scripts/peer3-probe.mjs server-requests --model gpt-6-luna/low --out /tmp/peer3-s5b/server-requests
node ts/scripts/peer3-probe.mjs golden start --model gpt-6-luna/low --out /tmp/peer3-s5b
```

`start` waits for committed `peer.json` and `turn.started`, captures driver/server identities and `before.ps`, and prints `peerName`, the unpredictable marker, and run ID. Its prompt asks for one `sleep 150` command and a final answer containing any subsequently received marker; the marker is not in the prompt. The detached production run continues after the command exits. Registration failure or early completion fails start and cleans up captured processes.

Immediately, in that same real Claude controller:

1. Call its actual `ListAgents` tool. Confirm the exact printed peer name and golden label are present. Do not replace this with a socket client.
2. Call its actual `SendMessage` exactly once, with the printed name as `to`, `message: "Include this marker verbatim in your final answer: <printed marker>"`, and `notify_when_idle: true`. Do not include the marker in another prompt or create another Codex turn. Do not resubscribe.
3. Allow the real delivery result and one `[Cross-session idle notice]` for this peer to reach the controller conversation and be persisted. Promptly collect using the absolute path of **that controller conversation's existing JSONL transcript**. This probe does not discover/read other Claude conversations.

```sh
node ts/scripts/peer3-probe.mjs golden collect --out /tmp/peer3-s5b --transcript /absolute/path/to/controller-conversation.jsonl
node ts/scripts/peer3-probe.mjs verify-evidence --out /tmp/peer3-s5b
cd ts
STRATUM_LIVE_PEER3=1 STRATUM_PEER3_EVIDENCE=/tmp/peer3-s5b ./node_modules/.bin/vitest run tests/connectors/codex-appserver.live.test.ts
```

Collection must begin promptly after completion: the probe explicitly configures a **120-second sidecar linger** to allow the controller handoff. It sends the supporting post-completion request before slower artifact gathering, reusing Part A's authenticated sender. It requires the authenticated, correlated `expired` / `refused` callback inside that window; a connection failure or acceptance fails. Completion wait is at most 180 seconds, callback/reaping waits 10 seconds, and controller idle persistence wait 15 seconds. A collection attempt writes a summary and cannot be overwritten; use a new golden run/root after failure.

## Evidence layout and assessment

All newly created evidence directories/files use 0700/0600. The controller transcript is never copied. Only SendMessage tool-use blocks addressed to this peer, their correlated tool-result blocks, and this peer's idle-notice blocks are extracted. Other prose, tool results, ListAgents results, and unrelated messages are excluded.

```text
ROOT/
  preflight/identity.json          # raw codex/claude/git command results
  sandbox/identity.json            # in addition to all Part A raw cases/baseline
  process-tree/identity.json       # full eight-case matrix still required
  server-requests/identity.json    # legacy ROOT/report.json placement also accepted
  golden/
    identity.json
    state.json                    # run/peer/label/marker, stream and private paths,
                                  # captured PIDs/start identities, start time/linger
    prompt.txt                    # actual production input including sandbox preamble
    before.ps / after.ps          # redacted unrelated commands, actual owned PIDs
    poll.json / records.json      # terminal production poll and normalized stream
    rollout.json                  # unique matching thread under private CODEX_HOME/sessions
    ipc.json / wire.json           # actual observed IPC and token-free peer frames
    controller.json               # filtered controller content blocks only
    second.json                   # sent frame, auth classification, refusal callback
    identitiesAfter.json          # captured PID/start-identity observations before cleanup
    summary.json                  # informational verdict/reason/timing; never a gate input
```

Golden reconstructs concatenated text from completed agent-message records and compares it exactly with the poll. It checks positive input/output tokens and their poll totals, positive estimated USD, one completed bounded tool command, exactly one start/completion/success sentinel, one rollout task, thread identity, original prompt presence, and a separate model-visible user marker message. The latest active-turn IPC state must precede the correlated steer and delivered result. Wire message ID, controller tool ID/result, subscription/idle IDs, sender, modes, lifecycle times, and post-run refusal must agree. Both captured driver and app-server identities must be dead and absent in `after.ps`, having appeared in `before.ps`. Sidecar linger is allowed. Cleanup cannot convert a leak into a pass.

The disposable home/registry live under the private directory named in state. Collection removes the copied auth file even when assessment fails; the registry and diagnostic traces remain for inspection while the sidecar lingers. If start is abandoned before collection, promptly collect or cancel the exact recorded run and remove its disposable directory after its processes exit. No global process-name killing is used. The bounded sleep prompt is not a guarantee that an uncollected model run cannot stall.

`verify-evidence` does not read `summary.json` to establish any outcome. It walks the fixed case lists and raw baseline/case files, verifies process snapshots, re-assesses fixed server-request triggers against duplex traffic, and calls the same golden assessor. It requires successful, identical Codex/Claude versions and HEAD across all modes, consistent with preflight. It prints preflight and AC03, AC05 rerun, AC07, AC13, AC16 rows with `passed`, `failed`, or `unreached`, plus every server method's raw evidence indices or unreached trigger. Missing evidence and unreached methods never pass; any such required row yields exit 1. AC16 cannot pass unless all other rows pass.

Older process artifacts missing Part A r1 action boundaries remain failures. Neither historical versions/HEAD nor action boundaries are reconstructed or invented. This implementation does not create the final live release report or claim AC16 achieved.

## Local verification and mutation proof

No paid modes, real model turns, live sockets, or controller sessions were used. Static inspection of the installed Claude executable did not execute it.

- `node --check ts/scripts/peer3-probe.mjs`: passed.
- Generated golden preload checked separately with `node --check`: passed.
- `npm --prefix ts run build`: passed (`/tmp/peer3-s5b-build.log`).
- `npm --prefix ts run typecheck`: passed (`/tmp/peer3-s5b-typecheck.log`).
- Requested Vitest file: see final results below (`/tmp/peer3-s5b-tests.log`). Six live tests remain opt-in and skipped locally.

Synthetic tests start with passing raw artifacts, break one link, and require its diagnostic. They cover marker in prompt, incorrect concatenation, extra turns, absent/user-role-invalid rollout marker, absent active steer/result, wrong controller target/message ID, acknowledgement-only result, duplicate/missing idle notice, subscription mismatch, missing/mismatched mode, accepted/unauthenticated/late second request, and process leaks. The filesystem-walker fixture checks the full mode matrix and explicitly uses false summaries to prove summaries do not supply verdicts.

The scratch-copy experiment removes each `S5B:` guard statement individually, runs the same test file, and requires a nonzero result. It never edits repository guards. The unchanged control must first pass. These are guard-deletion tests, not a claim that every deletion admits bad evidence: a downstream diagnostic may also cause the negative test to fail. Results and the final guard count are recorded below.

Live launch/discovery, real Claude transcript compatibility, real rollout shape, paid accounting, sidecar observation timing, and all installed-version AC outcomes remain unverified.

Final local results: **111 tests passed, 6 live tests skipped**. All **30/30** individually deleted guards caused test failures after the unchanged scratch control passed. Final scratch bundle: `/tmp/peer3-s5b-mutations-b6_5kqpw/{results.json,control.log,<guard>.log}`; driver script `/tmp/peer3-s5b-mutations.py`; console log `/tmp/peer3-s5b-mutations.log`. The guards cover identity command/match; state, prompt, poll, text, bounded tool, turns, usage, thread, rollout, rollout turn, steer, active result, controller, delivered receipt, idle, idle correlation, ordering, modes, refusal, process identities; and walker preflight, temp parity, process snapshots, trigger, launch, terminal, identity and complete-gate checks.

## Golden gate: real transcript shape

This correction supersedes the controller-shape assumption and compatibility warning above. The supplied run identifies Claude Code 2.1.282 and Codex CLI 0.155.1. Its SendMessage result is a successful send acknowledgement with a msg_id; delivery and idle arrive as separate user-role notices. Permission mode is established by the wire, not the controller result.

The gate now requires the marker-bearing SendMessage result msg_id to match both the incoming user frame and outgoing delivered callback. It additionally requires exactly one matching-recipient delivery user notice containing “approved and released”, after the tool result in transcript order and timestamp. Held/refused/expired notices for that recipient and conflicting wire statuses for that message fail. An acknowledgement alone still fails. Exactly one peer-named idle user notice must occur at or after the wire completion time, with the peer socket and subscription ID correlated. The steer's wrapper from-mode must equal notify_when_idle.from_mode and peer_idle_notice.from_mode.

Extraction keeps only this peer's SendMessage use/results and matching delivery/idle text blocks, with role and timestamp provenance; unrelated conversation content is excluded. Queue-operation entries are excluded, even when they contain a message-shaped duplicate. Collection waits for both notices to persist. Old extracted blocks without provenance are not silently upgraded.

The synthetic fixture now uses the observed shapes, including no top-level from_mode on the original user frame or delivered callback. Negative cases cover ack-only, other recipient, held/refused/expired notices, ID mismatches at each link, missing/duplicate idle users, queue-only idle, invalid roles/order/times, wrong idle sender, and wrapper/subscription/idle mode mismatches. Both the loadGolden/assessGolden path used by the opt-in live test and verify-evidence rederive failures from raw controller/wire/IPC files despite a forged passing summary.

Verification:
- Build and typecheck passed; logs: /tmp/peer3-real-shape-build.log and /tmp/peer3-real-shape-typecheck.log.
- Targeted Vitest: 126 passed, 6 live tests skipped (132 total); /tmp/peer3-real-shape-tests.log.
- Unchanged scratch control passed; deleting each of all 34 S5B guards individually caused a test failure, including delivery, notice, ordering, conflicting-status, idle, completion, correlation and mode guards. Results and per-guard logs: /tmp/peer3-s5b-mutations-54zm0hje/; console log: /tmp/peer3-real-shape-mutations.log. As before, this proves test sensitivity to each guard deletion, not that each deletion necessarily admits invalid evidence.
- Read-only reassessment of /tmp/peer3-s5b-162753/golden fails with “Golden controller delivery notice”: its old controller.json lacks the delivery block. The full walker reports preflight/AC03/AC13 passed, AC05 rerun unreached, AC07 failed with that diagnostic, and AC16 failed (“Required live gate incomplete”). Existing evidence and summary files were not changed or backfilled.

No paid/live run, production src edit, or commit was performed.

## AC05 amended scoring

Aligned the S5b verifier and opt-in live gate with the owner-accepted 2026-09-25 amendment. AC05 now reports `passed-amended` when at least one method is proven and every remaining expected method is unreached with recorded triggers. Fully proven coverage still reports `passed`. The raw duplex assessor continues to reject any elicited request with an incorrect/missing reply, rejection, or failed/hung run, including requests encountered outside their designated trigger run. Per-method records are unchanged: unreached methods remain `unreached`, and the CLI prints the complete method list and triggers. AC16 accepts `passed` plus `passed-amended` exclusively for AC05; plain `unreached` still fails.

This supersedes the earlier statement that any unreached method prevents AC16 passing. Synthetic negatives cover bad replies, rejected replies, stalls, missing triggers, zero proven methods, and plain-unreached AC05 at the AC16 gate.

Verification (no new paid runs, production source edits, or commits):
- Build and typecheck passed: `/tmp/peer3-amended-build.log`, `/tmp/peer3-amended-typecheck.log`.
- Requested Vitest file passed: **133 passed, 6 opt-in live tests skipped**; `/tmp/peer3-amended-tests.log`.
- Scratch control passed. Individually deleting each of the three new scoring guards and the amended AC16 guard caused test failure; the existing trigger and terminal guards were also deleted individually and detected (**6/6**). Results and logs: `/tmp/peer3-amended-mutations-22o6zmiv/`; runner: `/tmp/peer3-amended-mutations.py`. These prove sensitivity to guard deletion, including diagnostic assertions, rather than claiming each deletion necessarily admits invalid evidence.
- `node ts/scripts/peer3-probe.mjs verify-evidence --out /tmp/peer3-s5b-162753` exited **0**. AC05: **passed-amended**, “3 proven, 8 unreached (recorded with triggers)”; preflight, AC03, AC13, AC07 and AC16: **passed**. The eight unreached method records and attempted triggers remain printed in `/tmp/peer3-amended-verify.log`. Existing evidence was only read, not modified.

## Review r1 fixes

Addressed all five findings without production source changes, paid runs, commits, or edits beneath `evidence/`.

1. Marker causality: the rollout's original `user.text` task must equal `prompt.txt` exactly. Its next task message must equal the actual IPC steer text, carry the expected active turn ID, occur after the original task and before that turn's completion, and have a timestamp at or after the steer request. Any marker in an earlier model-visible response item (including developer, environment, plugin, or task context) fails. Exactly one rollout turn is still required.
2. Notice attribution: require exactly one controller SendMessage to this peer (including socket aliases), one incoming user frame through the admitted idle notice, and one delivered status in that window. This makes the renderer's recipient-only notice unambiguous. The separate post-completion refusal probe is outside that window and is validated independently.
3. Post-completion refusal: require exactly one matching raw sent frame, an authenticated callback with exactly one expired/refused result, the same refusal in wire evidence, and matching message ID, peer socket, and mode. Reject sender replies/errors, extra or contradictory callback/wire outcomes, and later steer IPC or active turns. The one-turn rollout check also rejects new turns. Delivered callbacks must not carry a refusal detail.
4. Method visibility: report mode assesses elicited methods independently, retains failed reasons and all unreached trigger records, and does not abort reporting on the first run validation failure. Strict assessment remains available to existing callers. The CLI regression uses a bad reply with three elicited methods and asserts AC05 failure, one failed method, two proven methods, eight unreached methods with triggers, and exact equality between the printed and returned method reports. Missing artifacts also retain all expected method records.
5. Individual conditions: added isolated field mutations for refusal IDs, sockets, detail and mode in each artifact and both artifacts together; delivered IDs, sockets, sender and detail; and idle IDs, sockets, sender, state and mode. These exercise otherwise-valid evidence, including mutually consistent but incorrectly correlated callback/wire copies.

Final verification:

- Build and typecheck: exit 0 (`/tmp/peer3-r1-build.log`, `/tmp/peer3-r1-typecheck.log`).
- Requested ordinary Vitest file: **172 passed, 6 skipped** (`/tmp/peer3-r1-tests.log`). Evidence-enabled run: **178 passed** (`/tmp/peer3-r1-live-tests.log`).
- Unchanged durable bundle `evidence/2026-09-25-live`: verifier exit **0**; AC07/AC16 passed; AC05 passed-amended with **3 proven, 8 unreached** (`/tmp/peer3-r1-verify.log`). No evidence requirement was weakened or artifact backfilled.
- Reviewer's `/tmp/peer3-s5b-review-mutate.mjs`: unchanged control passes; **14/14 negative mutants rejected**. Individually rejected: `marker-in-actual-original-prompt`, `marker-only-in-startup-context`, `other-message-delivery`, `post-completion-conflicting-denied`, `post-completion-wire-accepted`, `zero-token`, `rollout-second-turn`, `rollout-assistant-marker`, `wrong-mode`, `auth-denied`, `wrong-peer-delivery`, `queue-only-idle`, `wrong-head`, and `bad-server-reply`. Results: `/tmp/peer3-s5b-review-mutations/results.json`; log: `/tmp/peer3-r1-mutations.log`.
- Also extended the same-peer mutant with the second controller tool use/result as described by the reviewer: rejected (`/tmp/peer3-r1-other-message-extended.json`). The reviewer's bad-server copy exits 1 and still prints all 11 methods, including the 8 unreached records (`/tmp/peer3-r1-bad-server-cli.log`).
- Scratch-copy individual-condition deletions: unchanged control passes; **16/16 detected, 0 survivors**. Conditions: refusal message ID/socket/detail/mode; delivered message ID/socket/detail/sender/receipt ID; delivery-notice recipient; idle message ID/socket/sender/mode/wrapper mode/state. These replace one boolean condition at a time, not whole guards. Runner: `/tmp/peer3-r1-conditions.py`; results and individual logs: `/tmp/peer3-s5b-r1-condition-deletions/`; console: `/tmp/peer3-r1-conditions.log`.
- `git diff --check` passed. Initial concurrent build/tests briefly raced the build's removal of `dist`; final build and verification ran sequentially. An initial fixture tuple typing error was corrected before the successful final typecheck.
