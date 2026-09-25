# STRAT-AGENT-PEER-3 — Implementation report and live exit gate

Related: [design.md](./design.md) · [plan.md](./plan.md) · [progress.md](./progress.md) (full trail) · implementation notes [S4](./implementation-s4.md), [S5a](./implementation-s5a.md), [S5b](./implementation-s5b.md) · reviews `impl-review-*.md` (S5b r1: 2 high + 3 medium gate-honesty findings, all fixed, and 14/14 reviewer forgeries rejected)

## Exit decision

**PASS (2026-09-25), with amended AC05.** Every AC is met by live evidence on the installed versions below. Except for 8 server-request methods, none is met by fixtures alone. Those 8 cannot be elicited on Codex 0.155.1 in any supported configuration. Per the owner-accepted AC05 amendment they are recorded as **unreached, with the trigger tried**, and are not counted as passed (see AC05).

`node ts/scripts/peer3-probe.mjs verify-evidence --out docs/features/STRAT-AGENT-PEER-3/evidence/2026-09-25-live` exits 0:

| AC | Status |
|---|---|
| preflight | passed |
| AC03 live sandbox | passed (7/7) |
| AC13 live process tree | passed (8/8) |
| AC05 server-request rerun | passed-amended (3 proven, 8 unreached with triggers) |
| AC07 golden flow | passed |
| AC16 repeated installed-version gate | passed |

`STRATUM_LIVE_PEER3=1 STRATUM_PEER3_EVIDENCE=<that dir> vitest run tests/connectors/codex-appserver.live.test.ts`: 178/178, no skips (after the S5b review r1 gate hardening). Final full suite (live opt-in unset): 2525 passed, 9 skipped, 0 failed.

## Identity

| | |
|---|---|
| Codex CLI | `codex-cli 0.155.1` (= pinned protocol version) |
| Claude Code | `2.1.282` (peer protocol as documented for 2.1.272, unchanged in practice) |
| Stratum HEAD at evidence time | `ff8e983` (S5a; S5b only changes probe/test code) |
| Node | v22.22.3 (the probe ran under 22; repo CLI bins document ≥24) |
| OS | darwin 25.6.0 arm64 |
| Model for live turns | `gpt-6-luna/low`, disposable `CODEX_HOME` per case |

## Evidence

Durable, redacted bundle: [`evidence/2026-09-25-live/`](./evidence/2026-09-25-live/) (98 files, 1.8 MB). It holds no peer tokens, auth files or unrelated transcript content: controller transcript extraction keeps only the SendMessage use/result, the matching delivery notice and the matching idle notice, and unrelated `ps` command lines are redacted. `golden-run1-gateshape/` retains the first golden run, which failed only on the gate's transcript-shape assumption (below), as history.

## Per-AC outcome

**AC01, AC04, AC14 (S4)** — fixture and real-process tests, committed `c389a93`. AC14's MCP-parent death, driver SIGKILL and group cancellation are also proven live in AC13.

**AC02 (S1)** — exec argv byte-identical. The S5 policy change keeps it: exec `-c` values and app-server `thread/start.config` come from one object.

**AC03 live sandbox (S5a)** — 7/7 through production `startBackgroundRun` on app-server. Read-only denies a tool write (EPERM). Workspace-write allows the selected root and denies an OS-writable path under `$HOME` outside cwd/roots/temp. Network-on fetch returns HTTP 200 and network-off gets ENOTFOUND. `$TMPDIR` and `/tmp` match a fresh exec baseline under built-in, ordinary and override configs. Outcomes are asserted from tool exit results and filesystem effects, never model prose.
- **Defect found and fixed here.** `turn/start.sandboxPolicy` requires `excludeTmpdirEnvVar`/`excludeSlashTmp`, and the S1 encoder forced both `false`. Under a profile that excludes both, exec got EPERM on `$TMPDIR` and `/tmp` while app-server wrote both: **app-server was wider than exec.** Resolution (design §4 delta): sandbox goes through `thread/start.sandbox` + `config` with exec's own dotted keys, and no turn `sandboxPolicy` is sent, so ambient exclusions are inherited as exec inherits them. The extra-root write under temp exclusions, together with network on/off, shows the dotted keys are honored rather than ignored.

**AC05 server requests (S2, rerun S5)** — real-server acceptance proven for every method the probe can elicit: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request` (declined, and the run continues to `completed`). **Not reachable on 0.155.1 in supported configurations**, each with its trigger recorded in `server-requests/run-*.json`: `execCommandApproval` and `applyPatchApproval` (legacy, not sent by the modern server even when prompted), `item/permissions/requestApproval`, `item/tool/requestUserInput`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `item/tool/call`, unknown methods. For these, the evidence is the generated-type checks, the strict fake server and the 120s stall watchdog. `verify-evidence` prints the unreached list on every run, and scores `failed` if any elicited method is not proven.

**AC06, AC12 (S2)** — stream translation, terminal claims, startup/transport failures; committed `f84b08a`.

**AC07 golden flow (S5b)** — real Codex plus this real Claude Code session (`forge-f5`), run `7b0777c9206b`, peer `codex-luna-7b0777c9206b-golden-1aed7707c0aa`:
1. `ListAgents` listed the peer (`bg · busy`). One `SendMessage(to=peer, message="Include this marker verbatim…<marker>", notify_when_idle=true)` returned `msg_id f6dd8e63-…`.
2. Wire: the user frame with that msg_id → `peer_message_status delivered` (same id). `notify_when_idle` (from_mode `bypass`) → exactly one `peer_idle_notice`, from_mode `bypass`.
3. The controller transcript holds `[Cross-session delivery notice] … approved and released … (recipient: <peer socket>)` and exactly one idle notice.
4. The marker is absent from the prompt. It reached the model within the single turn by `turn/steer` (one turn.started / turn.completed) and is present in the thread rollout as model-visible input. The final answer contains it.
5. Poll `complete`, input 110,859 / output 261 / cacheRead 100,864 tokens, estimated $0.0021, 167 s.
6. Post-completion request within linger → `expired / refused`, no new turn (S3 AC08 supporting evidence).
7. Driver and app-server PIDs/start identities are gone afterwards. The sidecar lingers by design.

**Gate correction during S5b:** installed Claude Code records `SendMessage`'s result as a send acknowledgement (`success`, `msg_id`). It reports delivery as a separate delivery-notice message and never shows from_mode in the transcript. The gate originally demanded `status: delivered` inside the tool result, so golden run 1 failed with every substantive link present. The gate now requires the correlation *tool_result msg_id = wire user msg_id = wire delivered orig_msg_id*, plus the delivery notice naming this peer's socket, exactly one idle-notice message (queue-operation duplicates excluded), and from_mode compared on the wire. A send acknowledgement alone still fails.

**AC08–AC11, AC15 (S3)** — sidecar owner, first-frame auth, per-message lifecycle, reservations; committed `c389a93`. The live pending-steer case (AC13) exercises the full steer path with an authenticated callback.

**AC13 live process tree (S5a)** — 8/8. Cancel during initialize, cancel with an active turn, cancel with a pending steer (steer IPC with expectedTurnId → client `turn/steer` → held response → cancel → `dropped/unknown` callback). App-server SIGTERM-ignore via a labeled controlled shim around the real binary. MCP-parent death with the driver completing. Driver SIGKILL gives a sentinel-less poll error and EOF-driven app-server exit. Completion-wins and cancellation-wins each produce exactly one terminal outcome. `ps -axo pid,ppid,pgid,stat,command` is captured before and after every case, and captured PIDs/start identities are confirmed gone before any emergency cleanup. Cancelled runs poll as `error / child_died_without_sentinel`, the existing exec semantics.
- The pending-steer case was first unreached because of a probe bug: its callback `absent-callback.sock` failed `isAllowedCallback` (`<pid>.sock`). That is now locked by a real-socket regression test.

**AC16** — the full gate was repeated on the installed versions after the final implementation change (`ff8e983`, the temp-exclusion fix). Identity, versions and HEAD agree across all modes.

## Limitations (recorded, not failed)

- Tool descendants that start their own process group are outside driver/app-server cleanup (design §2). Exec has the same limitation.
- The sidecar lingers for its configured window after completion, to refuse late messages and serve the idle notice.
- The 8 unreached server-request methods above have no real-server acceptance evidence on 0.155.1.
- The app-server strategy is pinned to Codex 0.155.1. Another version fails the run at the handshake, so use the default `exec` strategy there.
- Active-turn stdin-EOF behavior is proven only via driver SIGKILL (EOF-driven exit). No separate graceful-EOF case exists.

## Cost

All live work ran on `gpt-6-luna/low`. The golden turn cost about $0.002. The whole gate (19 model-bearing cases: 7 sandbox, 8 process tree, 3 server-request, 1 golden, plus 3 exec baselines) is on the order of cents.
