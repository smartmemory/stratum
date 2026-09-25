# STRAT-AGENT-PEER-3 Design: Deliver peer messages into running Codex runs

**Status:** DESIGN r3 (2026-09-25) · owner decisions recorded · design only, no implementation in this document
**Review:** r1 NOT CLEAN (7, all upheld, [r1](./design-review-r1.md)) → r2 NOT CLEAN (4, all upheld, [r2](./design-review-r2.md)) → r3 NOT CLEAN (1 med, upheld, [r3](./design-review-r3.md)), which confirmed r2-1..r2-3 resolved and r2-4 partial. The r3 finding was fixed in place with the reviewer's suggested fix. No round 4 was run (3-round budget). See § Review disposition.
**Phase:** STRAT-AGENT: Agent Surface
**Parent:** STRAT-AGENT-PEER-1
**Related:** [feature.json](./feature.json), PEER-1 [design](../STRAT-AGENT-PEER-1/design.md) (§ inbound `user` frames refused, line 60), [protocol research](../STRAT-AGENT-PEER-1/research-claude-code-peer-registry.md), PEER-2 [design](../STRAT-AGENT-PEER-2/design.md) (lists "delivery of new prompts into running workers" as out of scope, line 51; its IPC owner mode is reused here).

All paths below are relative to `stratum/`. Line refs are against `main` at `305f0d3`.

---

## Problem

A Codex background run registered by PEER-1 appears in every Claude session's `ListAgents`, but `SendMessage` to it always fails:

> Cross-session message refused (recipient: uds:/tmp/cc-socks/78273.sock). That session is not accepting cross-session messages …

That refusal is by construction. `ts/src/connectors/peer-sidecar.ts:240-244` answers every `type:"user"` frame with `peer_message_status status:"expired" status_detail:"refused"`. The sidecar has nothing to deliver to. Stratum runs background Codex as `codex exec --json … -` (`ts/src/connectors/codex.ts:162-193`), wrapped in `sh` (`ts/src/connectors/background.ts:54-57,181-190`) and spawned detached (`background.ts:201-206`). A `codex exec` process has no inbound channel once it starts. The Stratum `sdk` transport does not help either: `@openai/codex-sdk` also runs `['exec', '--experimental-json']` (`ts/node_modules/@openai/codex-sdk/dist/index.js:171-172`).

Claude Code's generic wording ("the feature is off there, or a setting or policy there refuses them") is misleading here. Nothing is off. The run cannot accept input.

## Evidence (2026-09-25, codex-cli 0.155.1)

| Claim | Evidence |
|---|---|
| Codex has a mid-turn input primitive | `codex app-server generate-ts` → `v2/TurnSteerParams.ts`: `{threadId, clientUserMessageId?, input: UserInput[], expectedTurnId}`, returns `{turnId}`. Official docs ([learn.chatgpt.com/docs/app-server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)): "turn/steer appends more user input to the active in-flight turn", "The request fails if there is no active turn on the thread", no turn-level overrides, no new `turn/started`. Independently re-confirmed by review r1. |
| `codex queue` does **not** reach a running `codex exec` | **Probe, this date.** Throwaway `codex exec --json -m gpt-6-luna` told to run `sleep 75`. While it slept: `codex queue --thread 01a0d63f-37ee-7881-b638-82b03e694c6a --message "PROBE: also reply with the word PINEAPPLE."` → `rc=0`, "Queued message 01a0d63f-591a-… for thread …". The exec finished with only `DONE-ORIGINAL` and exited. `PINEAPPLE` is absent from the thread rollout and from every rollout under `~/.codex/sessions/2026/09/25/`. |
| …and it fails **silently** | Afterwards `~/.codex/queue_1.sqlite` `queued_items` held 0 rows. The message was dequeued and executed nowhere. No local shared app-server daemon was running before or after. **Unverified** which process dequeued it (the ChatGPT desktop app's app-server was running). |
| Claude Code accepts a positive delivery status | `docs/features/STRAT-AGENT-PEER-1/research-claude-code-peer-registry.md:484`: recognized statuses are `held`, `denied`, `expired`, `delivered`, `refused`, `dropped`. Correlated notifications, not a required ACK. |

`codex queue` delivers only at turn boundaries by design, and a one-turn `exec` run ends at its first boundary. Queue is not a viable path.

## Goal

`SendMessage(to=<codex run peer>, message=…)` reaches the running Codex agent as additional user input **during** its active turn, and the sender gets a truthful status back.

**In scope**
- A background-only execution strategy, `app-server`, for Codex background runs.
- Mapping authenticated inbound peer `user` frames to `turn/steer` on the active turn.
- Truthful per-message `peer_message_status` replies.
- Stream and poll parity with today's exec background runs.

**Out of scope**
- The foreground `CodexTransport` union (`codex.ts:21`) and `CodexConnector`. Foreground is untouched (r1 #6).
- Starting a **new** turn on a finished run from a peer message.
- Peer-initiated `turn/interrupt`.
- Claude background workers (PEER-2 owner mode).
- `codex queue` and the shared app-server daemon.
- A `cancelled` variant in the poll API (r1 #1). Cancellation keeps today's outcomes, below.

## Approach

### 1. Selection: background-only, explicit (r1 #6)

`startBackgroundRun` (`background.ts:181`) today builds the exec argv directly and never consults `STRATUM_CODEX_TRANSPORT`. That stays true. PEER-3 adds a **separate** selector read only in `startBackgroundRun`:

| Condition | Strategy |
|---|---|
| `options.command` injected (test seam) | exec, unchanged |
| `STRATUM_CODEX_BG_STRATEGY` unset or `exec` | exec, unchanged (default) |
| `STRATUM_CODEX_BG_STRATEGY=app-server` and approval policy is `on-failure` | **reject at start** (see §4) |
| `STRATUM_CODEX_BG_STRATEGY=app-server`, peer registration disabled or failed | app-server still runs; no steering surface; poll unaffected |
| `STRATUM_CODEX_BG_STRATEGY=app-server` | app-server driver |

`options.env` takes precedence over `process.env`, matching `CodexConnector`. `STRATUM_CODEX_TRANSPORT` keeps its current meaning (foreground only).

A shared **policy encoder** (proposed, `ts/src/connectors/codex-policy.ts`) produces both the exec argv flags and the app-server payload from one `SandboxPolicy`, so the two cannot drift.

### 2. Process ownership (r1 #1)

```
driver (group leader, detached, pid recorded as meta.childPid)
 └─ codex app-server (non-detached child, same group)
      └─ tool descendants (may create own groups — see below)
sidecar (own group, as today — survives cancel to notify subscribers)
```

- The **driver** (proposed `ts/src/connectors/codex-appserver-driver.ts`) replaces the `sh` wrapper as the detached group leader. `meta.childPid`/`procStartTime` record the driver, so `cancelBackgroundRun`'s identity and group checks (`background.ts:577-586`) work unchanged.
- The driver spawns the sidecar with an IPC channel (the PEER-2 pattern, `peer-sidecar.ts:24-64`, spawn at `72-76`), under a new owner kind `codex-appserver`. The sidecar keeps its own group, so group-kill cancellation does not take it down.
#### Terminal claim (r2 #1, #3)

The driver holds **one terminal claim**, set at most once. Every terminal path goes through it: turn notifications, signals, handshake failures and transport loss. The first path to set the claim decides the run's outcome. Later events can only speed up cleanup; they cannot change the outcome.

| Claim | Set by | Durable record | Sentinel |
|---|---|---|---|
| `completed` | `turn/completed` `status:"completed"` | output + `turn.completed` usage (§3) | `0` |
| `failed` | `turn/completed` `status:"failed"`; any **startup failure** (below); **transport loss** (below) | `{"type":"error","error":{"message"}}` | `1` |
| `interrupted` | `turn/completed` `status:"interrupted"` **with no prior claim** | `{"type":"error","error":{"message":"interrupted"}}` | `130` |
| `cancelled` | SIGTERM/SIGINT to the driver | none | **none** |

**At most one sentinel per run.** Exactly one is written for `completed`/`failed`/`interrupted`. None is written for `cancelled` or driver death, which reproduces today's exec outcome exactly: the `sh` wrapper dies with its group and writes nothing, so cancel returns `cancelled` and the poll returns `status:"error", reason:"child_died_without_sentinel"` (asserted at `ts/tests/connectors/background.test.ts:176-178`). The poll contract is unchanged.

**Startup failures** each claim `failed`, with a message naming the step:
- app-server spawn error
- JSON-RPC error on `initialize`, `thread/start` or `turn/start`
- no `turn/started` within 60s of spawn

**Transport loss** claims `failed` when there is no prior claim:
- app-server stdout EOF or process exit before `turn/completed`
- a truncated final frame followed by EOF (this is EOF, not the malformed-frame count)
- 3 consecutive malformed frames

After a claim has been set, EOF or exit is **expected** and changes nothing.

**Cleanup is identical for every claim.** Flush the records → close app-server stdin → wait up to 3s → SIGTERM → wait 2s → SIGKILL → reap → write the sentinel (if the claim has one) → exit. Order:
- **Completion, then SIGTERM during cleanup:** the claim stays `completed`. The signal only skips the remaining waits. Sentinel `0` is still written after the reap.
- **SIGTERM, then an `interrupted` notification:** the claim stays `cancelled`. No record and no sentinel.
- **SIGTERM during the handshake:** `cancelled`. Same cleanup, no sentinel.

**Cancel API vs. poll state.** `cancelBackgroundRun` scans once, then signals and returns `cancelled` immediately (`background.ts:578-586`). It reports `already_complete` only when the sentinel is already visible to that first scan. If a completion sentinel lands between the scan and the signal, the API still says `cancelled`, but the claim is already `completed`, so the eventual poll is `complete`. That same acknowledgement-vs-outcome gap exists for exec runs today. It is documented, not changed.

- **Driver death (SIGKILL, crash):** no sentinel → poll `child_died_without_sentinel` (`background.ts:472`), unchanged. The app-server loses its stdin pipe. That it then exits must be verified live (see ACs).
- **Tool descendants in their own groups** are not reached by the group kill. This limitation already applies to exec runs today and is **not** made worse. The no-orphan acceptance criterion is scoped to driver + app-server, with a live process-tree check.

### 3. Stream parity: the driver writes the exec vocabulary (r1 #2)

The simplest route to parity is to leave the stream reader alone. The driver translates app-server notifications into **the same record shapes `codex exec --json` writes**, so `scanStream` (`background.ts:657-666`) and the sidecar's stream watcher need no change.

| app-server input | Driver writes | Notes |
|---|---|---|
| `thread/started` / `thread/start` response | `{"type":"thread.started","thread_id"}` | once |
| `turn/started` | `{"type":"turn.started"}` | once; steers do not emit a new one (per docs) |
| `item/completed`, `item.type:"agentMessage"` | `{"type":"item.completed","item":{"type":"agent_message","text"}}` | only completed items; deltas ignored, so text is not double-counted |
| `item/completed`, other item types | the exec-equivalent `item.completed` record where one exists; otherwise dropped | progress only, never affects result |
| `thread/tokenUsage/updated` | **not written**; driver keeps the latest `tokenUsage.total` snapshot for the turn | `total` is cumulative; summing snapshots would overcount |
| `turn/completed`, `turn.status:"completed"` | `{"type":"turn.completed","usage":{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}` from the last `total` snapshot | key names match what `exec` wrote in the 2026-09-25 probe. No usage snapshot → no `usage` key; the driver never invents cost |
| `turn/completed`, `status:"failed"` | `{"type":"error","error":{"message": turn.error.message}}` | `codexErrorMessage` reads `type:"error"` (`codex.ts:571-575`), so partial text plus failure → poll `error`, never false success |
| `turn/completed`, `status:"interrupted"` | `{"type":"error","error":{"message":"interrupted"}}` | only if no claim is set yet |
| `error` notification (retryable) | not written | only a terminal turn status ends the run |
| malformed frame from app-server | logged to `T2F5_ERR` | 3 consecutive → transport loss (§2) |

**Sentinels come only from the §2 terminal claim.** The rows above say which records get written. They write no sentinel themselves, and if a claim is already set they write nothing at all.

Ordering rule: every output and accounting record is written and flushed **before** the sentinel.

Side note, pre-existing and out of scope: `scanStream` reads `cache_read_input_tokens` (`background.ts:664`), but `exec` writes `cached_input_tokens`, per the probe output. Cached-token accounting is therefore already zero on the exec path. The driver matches exec's key names (parity), and the mismatch is noted here for a separate fix.

### 4. Initialization, policy encoding and server requests (r1 #3, #4)

**Handshake:** `initialize` request → response → `initialized` notification → `thread/start` → `turn/start`. A JSON-RPC error at any step, or no `turn/started` within 60s of spawn, claims `failed` (§2).

**Policy placement** (from generated `v2/ThreadStartParams.ts:12-16`, `v2/TurnStartParams.ts:24-45`, `v2/SandboxPolicy.ts:7`):

| Stratum policy field | exec today (`codex.ts:173-192`) | app-server |
|---|---|---|
| model | `-m` | `thread/start.model` |
| cwd | `-C` | `thread/start.cwd` |
| effort | `-c model_reasoning_effort` | `turn/start.effort` |
| sandbox mode + writable roots + network | `--sandbox` + `sandbox_workspace_write.*` | `turn/start.sandboxPolicy`: `readOnly{networkAccess:false}` / `workspaceWrite{writableRoots, networkAccess, excludeTmpdirEnvVar:false, excludeSlashTmp:false}` / `dangerFullAccess` |
| approval policy | `-c approval_policy` | `thread/start.approvalPolicy` (`never` / `on-request` / `untrusted`) |

- `networkAccess` stays a workspace-write setting. `read-only` always sends `networkAccess:false`, matching exec semantics.
- `excludeTmpdirEnvVar`/`excludeSlashTmp` are set to reproduce exec's default temp-dir writability. **Unverified default**, so the live sandbox probe AC must confirm it.
- The `danger-full-access` authorization check (`assertCodexSandboxAllowed`) runs before the driver starts, as it does for exec.
- `on-failure` has **no app-server equivalent** (`v2/AskForApproval.ts` lists `untrusted | on-request | granular | never`). Selection rejects it with a clear error. It does not fall back silently.
- Explicit fields override ambient `~/.codex/config.toml`, the same as `-c` overrides do for exec.

**Server-initiated requests** (from generated `ServerRequest.ts`). The run is unattended, so there is nobody to ask:

Each response is typed against the generated binding named in the last column (r2 #2):

| Request | Result sent | Type (generated bindings) |
|---|---|---|
| `item/commandExecution/requestApproval` | `{decision:"decline"}` | `v2/CommandExecutionRequestApprovalResponse.ts`, `v2/CommandExecutionApprovalDecision.ts` |
| `item/fileChange/requestApproval` | `{decision:"decline"}` | `v2/FileChangeRequestApprovalResponse.ts` |
| `execCommandApproval` (legacy) | `{decision:{denied:{rejection:"unattended Stratum run: approvals are declined"}}}` | `ExecCommandApprovalResponse.ts`, `ReviewDecision.ts` (`decline` is **not** a member) |
| `applyPatchApproval` (legacy) | same `denied` decision | `ApplyPatchApprovalResponse.ts`, `ReviewDecision.ts` |
| `item/permissions/requestApproval` | `{permissions:{}, scope:"turn"}`: an **empty grant** | `v2/PermissionsRequestApprovalResponse.ts`, `v2/PermissionGrantScope.ts` (`turn` or `session`) |
| `mcpServer/elicitation/request` | `{action:"decline", content:null}` plus any other required nullable fields as `null` | `v2/McpServerElicitationRequestResponse.ts`, `v2/McpServerElicitationAction.ts` |
| `item/tool/requestUserInput` | JSON-RPC error `-32601` "unsupported by unattended driver". The type (`{answers:{…}}`) has no decline variant, and an empty or fabricated answer would be invented user input | `v2/ToolRequestUserInputResponse.ts` |
| `account/chatgptAuthTokens/refresh`, `attestation/generate`, `item/tool/call`, anything unknown | JSON-RPC error `-32601`, logged | n/a |

- Permissions are never expanded automatically. With `approvalPolicy:"never"` (the default) the approval requests should not occur at all. The table covers `on-request`/`untrusted`.
- **Stall watchdog.** After the driver answers any server request, if the app-server then sends no notification for 120s, the driver claims `failed` with the message "unattended request stalled: <method>". An answer the server does not like therefore ends in a bounded failure, never a hang.
- The response shapes are pinned by the §Risks contract fixture. When the generated types drift, driver startup fails instead of sending a stale shape.

### 5. Per-message lifecycle, separate from run lifecycle (r1 #5)

A message failure **never** ends the run. Only run failures (§2, §3) write a terminal sentinel.

Sidecar ↔ driver IPC:
- request `{type:"steer", reqId, senderFrom, msgId, text}`, where `reqId` is sidecar-generated and unique
- response `{type:"steer-result", reqId, outcome, detail}`

| Case | Sidecar replies to sender |
|---|---|
| `turn/steer` returned `{turnId}` | `delivered` |
| no active turn / run finished / `expectedTurnId` mismatch | `expired`, `status_detail:"refused"` |
| unauthenticated frame (§6) | `denied` |
| driver IPC gone before the request was sent | `dropped`, `status_detail:"not_sent"` |
| request sent, no response within 10s, or IPC died after send | `dropped`, `status_detail:"unknown"`. Delivery is **uncertain** and is never retried |
| duplicate `(senderFrom, msgId)` while pending | ignored (the first request answers) |
| all 8 result slots held (§ Result reservations) | `expired`, `status_detail:"busy"` (best effort) |

- `delivered` is sent only after the server returns a `turnId`, never when the request is merely sent. This is the lesson of the `codex queue` silent drop.
**Result reservations (r2 #4).** Today's callback queue (`peer-sidecar.ts:161-176`) holds 32 entries and runs 8 at once. It reserves room for idle notices by evicting non-notices, and it merges notices per destination (`:162-163`). Steer results cannot go through that queue, because merging would lose distinct message results and eviction would drop them. So:
- **Each admitted steer holds one of 8 slots from admission until its result callback attempt finishes**, not just until the driver answers. At most 8 steers are accepted-but-unreported at any time, so memory is bounded by construction. A 9th request is refused as `busy` (best effort, below).
- Results sit in a **separate result list keyed by `reqId`**. They are never merged per destination, so two messages from the same sender get two results. The idle-notice queue and its 32 reservations are untouched.
- Result callbacks share the existing 8-way in-flight pump, but they are picked **before** best-effort traffic and never evict or get evicted by notices. Each attempt gets the existing per-callback deadline.
- **Routing is by admission state, not by status label (r3 #1).** Once a request holds a slot, **every** result for its `reqId` uses the reserved result list. That includes `delivered`, a server-side `expired/refused` (stale `expectedTurnId`, turn finished while the steer was in flight), and `dropped/unknown`. The slot is released only after that one callback attempt.
- **Best-effort traffic** means only replies to requests rejected **before admission**: `denied` (authentication), `busy` (no free slot), `refused` when the driver already reports no active turn before a slot is taken, and `dropped/not_sent` when IPC is gone before admission. These go through the existing queue exactly as today's refusals do, and may be discarded at capacity or shutdown.
- **Shutdown order:** (1) every request still pending with the driver is settled as `dropped/unknown`; (2) all reserved results are drained within the existing 5s shutdown window, before best-effort traffic; (3) best-effort traffic is drained as today. Every accepted result gets one callback attempt within bounded time and memory.
- After the sidecar's post-run linger ends, no endpoint remains. Senders get Claude Code's own connection failure, and the refusal guarantee covers the linger window only.
- The steer text is the `<cross-session-message …>` envelope as received, with one prefixed line stating that it is a message from a peer Claude session, not the original task author.

### 6. Authentication for steer frames (owner decision 3, r1 #7)

Today the first-line `auth` token is advisory: a mismatch is logged and the frames are still processed (`peer-sidecar.ts:339-340`). For owner kind `codex-appserver` only:
- The per-connection auth state (none / valid / mismatch) is passed into `receive`.
- A `user` frame is steered only if the connection's **first** frame was `auth` with the correct token. Otherwise it gets `denied`.
- `notify_when_idle` and every other owner kind keep today's advisory behaviour.

The 0600 token file limits token possession to the same OS user. It does **not** prove which same-user peer is sending, and this design does not claim it does.

## Owner decisions

**DECIDED (owner, 2026-09-25): all four recommendations accepted.**

1. **Separate driver**, not merged into the sidecar. Review r1 agreed: merging saves one process but lets a peer-endpoint crash kill the run.
2. **A message to a finished run is refused.** Resume-on-message is a follow-up feature.
3. **The auth token is enforced for steer frames only** (§6).
4. **The `on-failure` approval policy on app-server runs is rejected at start**, not mapped to `on-request`. Mapping would change behaviour silently.

## Acceptance criteria

- [ ] `STRATUM_CODEX_BG_STRATEGY` selection table (§1) holds, including `options.env` precedence, the `options.command` seam, and foreground unaffected (`STRATUM_CODEX_TRANSPORT` behaviour unchanged by test).
- [ ] The shared policy encoder produces exec flags byte-identical to today's `codexExecArgs` for every sandbox mode (regression), plus the §4 app-server payloads.
- [ ] **Live sandbox probe** on app-server: read-only blocks a write; workspace-write allows a write in a writable root and blocks one outside it; network off blocks a fetch; temp-dir writability matches exec.
- [ ] `on-failure` + app-server → start rejected with a clear error, and no process spawned.
- [ ] Server-request fixtures: each §4 response **type-checks against the generated binding** for its method, the server accepts it (the request completes), and the run continues or ends. Stall watchdog: a request answered and then 120s of silence → `failed` "unattended request stalled".
- [ ] Stream mapping (§3), table-driven: multiple assistant messages; multiple usage snapshots (last `total` wins, not the sum); cached tokens; no usage snapshot (no usage key); partial text then `failed` (poll `error`); `interrupted`; malformed frames; all records written before the sentinel.
- [ ] **Golden flow**, live, real Codex (luna/low) and a real Claude Code session: start app-server background run → `SendMessage` during the active turn → sender receives `delivered` → steer text is in the thread rollout and changes the output → poll `complete` with the right text and **non-zero** accounting → `notify_when_idle` fires once, `from_mode` echoed.
- [ ] `SendMessage` after completion (within linger) → `expired`/`refused`, no new turn.
- [ ] Unauthenticated / wrong-token / late-auth `user` frame → `denied`. Other owner kinds unchanged.
- [ ] Message-lifecycle harness (§5): two senders at once, duplicate `msgId`, delayed response, response lost after acceptance (`dropped`/`unknown`, no retry), IPC gone before send (`dropped`/`not_sent`), all 8 slots held (`busy`), steer racing turn completion. **None** of these end the run.
- [ ] Result-reservation saturation fixture (§5): fast steer acknowledgements with held (slow) callback sockets, 32 live idle subscriptions, several messages from one sender, an **admitted steer rejected by the server for a stale `expectedTurnId`**, then terminal cleanup. Every accepted result gets exactly one callback attempt, distinct per `reqId`; no idle notice is lost; memory stays bounded by the 8 slots.
- [ ] Terminal claim (§2), table-driven: completion then SIGTERM during cleanup (→ `complete`, sentinel 0); SIGTERM then `interrupted` (→ `cancelled`, no sentinel); SIGTERM during reap; JSON-RPC error on each of `initialize`/`thread/start`/`turn/start` (→ `failed`, step named); spawn error; no `turn/started` in 60s; app-server EOF/exit before `turn/completed`; truncated final frame then EOF. At most one sentinel in every case.
- [ ] Cancellation (§2): during init, during an active turn, during a steer; app-server ignoring SIGTERM (SIGKILL follows); MCP parent exit; driver death (`child_died_without_sentinel`). Each gives exactly one terminal outcome and **no surviving driver or app-server**, checked on the live process tree.
- [ ] Source/dist parity: the driver launches from both `src` (strip-types) and `dist`, detaches from the MCP parent, and runs to completion when peer registration fails.
- [ ] exec strategy and Claude-worker owner kinds still refuse `user` frames exactly as today (existing refusal harness).
- [ ] Live exit gate repeated on the installed codex-cli and Claude Code versions, recorded in `report.md`.

## Risks

- **Experimental protocol.** Pin the `generate-ts` output as a contract fixture, and fail loudly on drift at driver startup (the `initialize` response carries the server version), the same way PEER-1 version-allowlists Claude Code.
- **Silent-drop precedent.** `delivered` only on a returned `turnId` (§5).
- **Translation drift.** If exec's `--json` vocabulary changes, the driver's output drifts from it. The golden flow parses a real run, not a fixture.
- **Cost.** One more Node process per app-server background run.

## Review disposition

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | high | Cancellation/shutdown ownership undefined | Upheld (`background.ts:577-586` verified: one SIGTERM, immediate `cancelled`). §2 defines the process tree, the single sentinel writer, bounded shutdown and the race rule. The poll API is unchanged: a cancelled run keeps today's `error`/`child_died_without_sentinel`. |
| 2 | high | Stream parity underspecified | Upheld (`background.ts:657-666` verified). §3: the driver writes the exec vocabulary; last-snapshot usage; failed/interrupted → `error` record + non-zero sentinel. |
| 3 | high | Server requests can hang the run | Upheld (`config/types.ts:4`, generated `ServerRequest.ts` verified). §4 response table; `on-failure` rejected; `initialized` added to the handshake. |
| 4 | med | Policy encoding wrong | Upheld. §4 placement table: effort and sandbox policy go on `turn/start`; a shared encoder; live sandbox probe AC. |
| 5 | med | Message vs run failure conflated | Upheld. §5: separate lifecycles, bounded pending, uncertain = `dropped/unknown` never retried, callbacks retained. |
| 6 | med | Selector crosses the foreground boundary | Upheld (`background.ts:181` verified). §1: a background-only selector; the foreground union is untouched. |
| 7 | low | Three wrong citations | Upheld (`peer-sidecar.ts:339-340`, `ts/node_modules/…/index.js:171-172` verified). Fixed; `background.ts:201-206` added. |
| r2-1 | high | Terminal rules contradictory (one sentinel vs none on cancel; race vs deferred sentinel; cancel vs `interrupted`) | Upheld. §2 terminal claim: one claim, set once, identical cleanup, "at most one sentinel", explicit event orders, cancel acknowledgement distinguished from eventual poll. §3 rows no longer write sentinels. |
| r2-2 | high | Unattended responses not valid for their types | Upheld (verified against generated `ReviewDecision.ts`, `v2/PermissionsRequestApprovalResponse.ts`, `v2/ToolRequestUserInputResponse.ts`, `v2/McpServerElicitationAction.ts`). §4 table now gives a typed result per method; user input → JSON-RPC error rather than invented answers; 120s stall watchdog. |
| r2-3 | high | No terminal path for startup rejection / app-server EOF | Upheld. §2 startup failures and transport loss claim `failed`; EOF is terminal regardless of malformed-frame count; 60s `turn/started` timeout. |
| r2-4 | med | Callback retention had no capacity contract | Upheld (`peer-sidecar.ts:161-176` verified: merged per destination, 32 queue slots reserved for notices). §5 result reservations: slot held through callback attempt, separate `reqId`-keyed list, ordered shutdown; saturation fixture AC. |
| r3-1 | med | Admitted steer refused by server routed to discardable queue | Upheld (`TurnSteerParams.ts` precondition, `peer-sidecar.ts:164-169,215-218`). §5 now routes by admission state: every result of an admitted `reqId` uses its reservation; best-effort is pre-admission only. Saturation AC extended with the stale-`expectedTurnId` case. |
