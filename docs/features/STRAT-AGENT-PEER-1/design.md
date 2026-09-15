# STRAT-AGENT-PEER-1 Design: Register Codex background runs as Claude Code peer sessions

**Status:** DESIGN
**Phase:** STRAT-AGENT: Agent Surface (slice of forge `STRAT-AGENT-VIS`)
**Created:** 2026-09-15
**Revised:** 2026-09-15 (r1 — Codex design review named four gaps: cancellation identity, sidecar startup failure, callback dir rule vs temp-dir tests; addressed in "Cancellation and failure isolation" and the callback rule. r2 — three should-fix: finish/subscribe race → terminal retention window; peer metadata via fatal `meta.json` path → sidecar-owned `peer.json` + deterministic name; racy golden flow → controlled-release fake child. r3 — one should-fix: notice guarantee restated as "exactly one attempt per accepted, non-replaced subscription" with explicit accept/replace/reject and shutdown-drain rules; editorial alignment of cleanup timing and the write-set invariant)
**Related:** [feature.json](./feature.json), [research-claude-code-peer-registry.md](./research-claude-code-peer-registry.md), forge `ROADMAP.md` row `STRAT-AGENT-PEER-1` (filed 2026-09-09), prior slices [STRAT-AGENT-BG](../STRAT-AGENT-BG/design.md) and [STRAT-AGENT-BG-WRITE-1](../STRAT-AGENT-BG-WRITE-1/design.md)

---

## Problem Statement

A `stratum_agent_run(agent="codex", background=true)` run is invisible to the parent Claude Code session. `ListAgents` shows only Claude subagents and peer Claude sessions, so the user cannot see that an astra review is running, and the parent has to wait with a `kill -0 <pid>` Bash loop capped at 10 minutes (or poll `stratum_agent_poll`). Claude Code already has a mechanism for exactly this, its peer-session registry plus a Unix-socket messaging protocol that includes a one-shot idle notification. Stratum should register each Codex background run as a peer so it appears in the list, shows `busy`/`idle`, and wakes the parent when it finishes.

Origin: SmartMemory CORE-ONTOLOGY-PARITY-1 session, the user asked why the astra reviewer was not in the agent list.

---

## Ground truth (verified 2026-09-15 against Claude Code 2.1.272)

Reverse-engineered by Codex from the installed bundle (full report with line references in [research-claude-code-peer-registry.md](./research-claude-code-peer-registry.md)) and then **confirmed live** from this session with a throwaway Node probe (`peer-probe.mjs`, scratchpad, deleted after):

| Fact | Evidence |
|---|---|
| Registry is `<configDir>/sessions/<pid>.json`; `configDir` honours `CLAUDE_CONFIG_DIR`, default `~/.claude`. The **filename pid** is authoritative, the `pid` field inside is ignored. | research §1, §6; `JU(){return _o(be(),"sessions")}` |
| Listing requires a **reachable Unix socket** at `messagingSocketPath` (250 ms connect probe, `EBUSY` counts). A record without a live socket is never listed. A `.key` file is **not** required to be listed. | research §1; probe listed with no key file |
| Liveness: `kill(pid,0)` where only `ESRCH` means dead; if `pidDomain` matches (`"darwin"` on mac) and `procStart` is present, it is compared with `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` (exact string equality, UTC). | research §1, §2; live record shows 07:11 UTC vs 15:11 local |
| `kind` enum is `interactive\|bg\|daemon\|daemon-worker`; anything else is dropped (rendered blank). `status` enum is `busy\|shell\|idle\|waiting`. Records with `spare:true` or any `parkedJobId` are excluded. | research §1, §5; probe rendered `· bg · busy` |
| Row renders `name [ref] · kind · status · started <age>`; `[ref]` = first 6 hex of `sha256("session:" + socketPath)`. Stale `updatedAt` never hides a record. | research §1, §5 |
| Key file: `<pid>.<sha256(path.resolve(socketPath))>.key`, mode 0600, `{"peerToken":<32 hex>,"procStart":<same string>,"pidDomain":"darwin"}`. The **sender** reads the destination's key and prefixes `{"type":"auth","token":...}` as the first JSON line. On macOS auth is optional; with no key file the sender sends no auth line and the message still lands. | research §2; probe received frames with no auth line |
| Wire: newline-delimited JSON over the socket, sender half-closes, no acknowledgement frame. Inbound `user` frame and `notify_when_idle` control frame shapes captured verbatim below. | research §4; probe inbox |
| Idle notice: receiver opens a **new** connection to the requester's `from` socket, authenticates with the **requester's** peer token (read from the requester's key file), sends `{"type":"control","action":"peer_idle_notice","orig_msg_id":<subscription msg_id>,"state":"idle"\|"exited"\|"unavailable","finished_at":<ms>,"from":"uds:<own sock>"}`. The requester only accepts a notice whose `orig_msg_id` matches an outstanding subscription. Changing `status` in the record does **not** notify anyone. | research §4 |
| Idle subscriptions carry `expectPeerPid` = the registry filename pid and are refused (`wrong-endpoint`) if the process answering the socket has a different pid (`Bun.ant.getPeerPid`). Ordinary SendMessage does not check the pid in this build. | research §3 |

Captured frames (probe inbox, tokens redacted, sender was this session):

```json
{"msgV":1,"msg_id":"4f41…","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:/tmp/cc-socks/20595.sock\" from-name=\"forge-90\" from-mode=\"bypass\">\nPEER-1 probe: capture this frame.\n</cross-session-message>"},"priority":"next","from":"uds:/tmp/cc-socks/20595.sock"}
{"type":"control","action":"notify_when_idle","from":"uds:/tmp/cc-socks/20595.sock","from_mode":"bypass","msgV":1,"msg_id":"91e2…"}
```

### Corrections to the roadmap row

| Roadmap row said | Reality | Consequence |
|---|---|---|
| `kind: "codex"` | Parser drops unknown kinds | Use `kind: "bg"` |
| Phase 1 is "list only", socket is Phase 2 | Listing itself probes the socket | A listening socket is mandatory from day one, so the record owner must be a process that can bind a socket |
| Record carries `version: 2.1.261` | Installed is 2.1.272; records from 2.1.238 to 2.1.272 coexist and all list | Reader is permissive; gate on protocol, not on a version string (see Risk) |
| Reuse the codex pid | The socket answerer's pid must equal the filename pid for idle subscriptions; codex cannot serve a socket, and the MCP server is one pid for N runs and may restart | A **per-run sidecar process** owns pid, record, key and socket |
| `procStart` via stratum's `procStartTime()` | Claude Code compares against `TZ=UTC ps -o lstart=` text; stratum's helper returns `tvsec.tvusec` on darwin | Produce `procStart` with the same `ps` invocation; keep `procStartTime()` for stratum's own identity checks only |
| "emit `notify_idle` on completion" | `notify_idle` is a capability name; the wire action is `peer_idle_notice`, sent only to sessions that subscribed with `notify_when_idle`, addressed to their socket with their token | Sidecar must store subscriptions and dial back |

---

## Scope

**In (v1):**
- Every codex background run (`startBackgroundRun`, codex path in `ts/src/connectors/background.ts`) spawns one detached **peer sidecar** that registers the run in the Claude Code peer registry, keeps `status` in step with the durable stream, answers `notify_when_idle` with `peer_idle_notice` when the run ends, and removes its files on exit.
- `stratum_agent_run` background response gains `peerName` so the caller knows which `ListAgents` row is theirs and can `SendMessage(to=peerName, notify_when_idle=true)` instead of polling.
- Inbound `user` frames are **refused** (the run's prompt is fixed at spawn; codex exec has no mid-run input channel). The sidecar replies with a `peer_message_status` control frame `status:"expired", status_detail:"refused"` the way Claude Code itself represents refusal, and logs the drop.

**Out (follow-ups, filed at ship):**
- Claude background runs (`claude-bg-worker.ts`, worker threads inside the MCP server): different process model, needs its own owner decision. `STRAT-AGENT-PEER-2`.
- Foreground `stratum_agent_run` calls: the parent is blocked on them anyway.
- Delivering peer messages into a running codex turn.
- Registering under Claude Code's fleet view (24 h freshness, interactive-only filter, separate feature gate).

---

## Design

### Owner: one detached sidecar per run

```
stratum-mcp (parent Claude Code's MCP child)
  └─ startBackgroundRun(codex)
       ├─ spawn sh -c T2F5_SHELL_WRAPPER codex …        (existing, detached, pid A)
       └─ spawn node dist/connectors/peer-sidecar.js   (new, detached, pid B)
              args/env: runId, streamPath, childPid A, childProcStartTime, cwd, name, sessionsDir, sockDir
              1. bind  <sockDir>/B.sock
              2. write <sessionsDir>/B.<sha256(sock)>.key   (0600)
              3. write <sessionsDir>/B.json                 (0644, atomic tmp+rename)
              4. tail streamPath: any new line → updatedAt, status busy
                 sentinel line → status idle, fire idle notices, linger, cleanup, exit 0
                 child A dead (processIdentity) with no sentinel → notices state "exited", linger, cleanup, exit
              5. serve socket: parse JSON lines; user → refuse; notify_when_idle → store {msg_id, from}
```

Why a sidecar and not the alternatives:

| Option | Why not |
|---|---|
| Codex wrapper pid + no socket | Never listed (socket probe). |
| MCP server serves sockets for all runs | One pid can own one `<pid>.json`; N concurrent runs collapse to one row; server restart kills the row while the durable run keeps going, contradicting the restart-proof design of BG runs. |
| Register from inside the `sh -c` wrapper | `sh` cannot serve a socket or speak the protocol. |
| Sidecar (chosen) | Own pid satisfies filename pid = socket answerer pid; detached, so it outlives an MCP restart exactly like the run it shadows; one row per run; dies with the run. |

The sidecar is a **shadow**, never an authority: it only reads `stream.jsonl` and never writes it, never touches `meta.json`, and its absence or crash changes nothing about the run, poll or cancel. If it crashes, Claude Code's own liveness check (`ESRCH`) drops the row; the stale `.json`/`.key`/`.sock` files are cleaned on the next `startBackgroundRun` by a sweep that removes only files whose filename pid is dead **and** whose record carries our marker `entrypoint: "stratum-peer"` (never anyone else's files).

### Record shape (v1)

```json
{
  "pid": <B>, "sessionId": "<uuid>", "cwd": "<run cwd>", "startedAt": <ms>,
  "procStart": "<LC_ALL=C TZ=UTC ps -o lstart= -p B, trimmed>", "pidDomain": "darwin",
  "version": "<stratum pkg version>", "peerProtocol": 1, "peerFeatures": ["notify_idle"],
  "kind": "bg", "entrypoint": "stratum-peer",
  "messagingSocketPath": "<sockDir>/B.sock",
  "name": "codex-<modelShort>-<runId6>", "nameSource": "derived",
  "status": "busy", "updatedAt": <ms>, "statusUpdatedAt": <ms>
}
```

- `name`: `codex-astra-4c165b` style, from `modelIdentity(model).model` with the `gpt-`/`-codex` noise stripped, plus the first 6 chars of the runId. Lowercase, `[a-z0-9-]`, no colons or slashes (address-like names can fail candidate construction). **Blueprint correction:** a background run can never carry `flow` (the server requires `cancellationId` with `flow` and rejects `cancellationId` for background runs), so there is no step label in v1; a caller-supplied label is a possible follow-up.
- `pidDomain`: `"darwin"` on macOS. On Linux Claude Code computes `darwin:<machine-id>:<pidns>`; the sidecar reproduces that formula (`/etc/machine-id` + `readlink /proc/self/ns/pid`). On any other platform, or if the formula cannot be evaluated, omit `pidDomain` (the reader then skips process checks and still lists).
- `status` transitions: `busy` at start; stays `busy` while lines arrive; **`idle` is written only at the sentinel**, immediately before the notices and cleanup. A codex run with no output for minutes is still `busy`, which is true.

### Socket protocol (v1 subset)

- The first-line deadline defaults to 30 seconds. `PeerSidecarConfig.firstLineDeadlineMs` is passed to the sidecar as `STRATUM_PEER_FIRST_LINE_MS`; tests use 300 ms with temporary registry and socket directories.
- Accept connections, split on `\n`, parse JSON, ignore the optional first `{"type":"auth"}` line (log a mismatch, do not reject; macOS auth is optional and the sender may hold a stale token), end the socket after EOF.
- `type:"control", action:"notify_when_idle"` → **acceptance rule**: a frame is *accepted* when it parses, carries a string `msg_id` and a `from` that passes the callback rule below, and the table has fewer than 32 entries; it is then stored as `{msg_id, from, from_mode?}` (the request's `from_mode` is echoed verbatim on the notice; without it the notice is not admitted to the subscriber's model, see "Unproven assumptions"). A later accepted frame with the same `from` **replaces** the earlier one (Claude Code's own re-subscription semantics); the replaced subscription is dropped and gets no notice. A frame arriving when the table is full is *rejected*: logged, not stored, no notice. If the run has already finished (terminal, inside the linger), an accepted frame is answered immediately.
- **Notice guarantee (precise):** every accepted, non-replaced subscription receives **exactly one notification attempt** (one dial-back with a 5 s timeout, no retry). Delivery is best effort, as in Claude Code itself. Attempts are made at the terminal transition and, for late subscriptions, immediately on acceptance. **Shutdown drain:** at the linger deadline and on SIGTERM/SIGINT the sidecar stops accepting connections, fires the attempt for every stored-but-unnotified subscription (`state:"exited"` on signal, `"idle"` otherwise), waits for in-flight dial-backs up to 5 s, then removes its files and exits.
- `type:"user"` → send `peer_message_status` with `orig_msg_id`, `status:"expired"`, `status_detail:"refused"` to `from`; log.
- Anything else → ignore, log at debug.
- On run end: for each subscription, connect to `from` (`uds:` prefix stripped), read that peer's key by `sha256(path.resolve(sockPath))` suffix in `sessionsDir`, write `{"type":"auth","token":<their token>}\n` (omit the line if no key found), then the `peer_idle_notice` frame, half-close, 5 s timeout, best effort.
- Callback targets (`from`) must be `uds:<abs path>` whose basename is `<digits>.sock` and whose directory is either the sidecar's **own `sockDir`** (same-directory rule, always accepted, which is also what the golden flow relies on when `sockDir` is a temp dir) or one of Claude Code's recognised default dirs (`/tmp/cc-socks`, `/private/tmp/cc-socks`, `/run/user/<uid>/cc-socks`, `cc-socks-<n>` variants). Anything else is dropped and logged. The key lookup for the callback token searches the sidecar's own `sessionsDir` only.

### Wiring

- `startBackgroundRun` (codex path) spawns the sidecar **after** `meta.json` is written and the child has spawned, passing `childPid` + `procStartTime` so the sidecar can detect a run that died without a sentinel. It waits only for the sidecar's `spawn` event; spawn failure is logged and swallowed and the run proceeds unregistered.
- **The parent never rewrites `meta.json` after spawn** (that path, `background.ts:187`, kills the run on failure and must stay reserved for the run's own metadata). Instead the peer name is **deterministic** (`codex-<modelShort>-<runId6>[-<stepId>]`, computable before spawn) and the sidecar itself writes `<runDir>/peer.json` = `{ pid, name, sock, registeredAt }` atomically **after** socket bind, key and record all succeeded. `CodexRunMeta` is unchanged.
- `bg_started` response gains `peerName` (present whenever registration was attempted, i.e. not disabled by the kill switch or drift guard) and `peer: "pending"`. `stratum_agent_poll` reads `peer.json` if present and reports `peer: { name, registered: true, pid, sock }`, otherwise `peer: { name, registered: false }` while the sidecar is still starting or failed. Callers treat `peerName` as tentative until `registered: true`, and fall back to `stratum_agent_poll` when `SendMessage(notify_when_idle)` to that name errors (row gone or never appeared). `mcp-surface.json` gains exactly these optional fields (strict contracts, see memory `strict-contract-seams`).
- **Terminal retention window.** On sentinel or child death the sidecar flips `status:"idle"`, fires notices to existing subscribers, and then **keeps the row and socket alive for `STRATUM_PEER_LINGER_MS` (default 15 000 ms)**, answering any `notify_when_idle` that arrives in that window immediately with `state:"idle"` (or `"exited"`). Cleanup happens at the end of the window. This closes the race where a run finishes between the caller's `ListAgents` and its `SendMessage`; the guarantee is "every accepted, non-replaced subscription gets exactly one notification attempt", never "every caller gets a notice". Rows therefore show `idle` for ~15 s after completion, which is also the visible confirmation the user asked for.
- `cancelBackgroundRun` is **not changed**. It SIGTERMs the wrapper's process group (`process.kill(-pid)`) and no sentinel is written when `sh` dies with its child. The sidecar is spawned `detached: true` so it sits in its **own** process group and survives that kill; it then observes "child dead, no sentinel" through `processIdentity(childPid, childProcStartTime)` and runs the `exited` path. Cancel therefore needs no knowledge of the sidecar and no second pid-identity check; the only identity the sidecar ever signals is its own.

### Cancellation and failure isolation (review r1)

| Event | Run outcome | Sidecar behaviour |
|---|---|---|
| Sentinel appears (rc 0 or non-zero) | unchanged | `status:"idle"`, notices `state:"idle"` with `detail:"rc=<n>"` when rc≠0, linger, cleanup, exit 0 |
| Cancel (group SIGTERM), child gone, no sentinel | poll reports `child_died_without_sentinel` as today | `processIdentity` → `dead`; `status:"idle"`, notices `state:"exited"`, `detail:"cancelled_or_died"`, linger, cleanup, exit 0 |
| `processIdentity` → `unknown` (EPERM, unreadable start time) | unchanged | keep watching; never treat "unknown" as dead (same rule as `proc_identity.ts` R4-3) |
| Sidecar receives SIGTERM/SIGINT | unchanged | shutdown drain (notices `state:"exited"`, ≤5 s for in-flight dial-backs), cleanup, exit; no linger |
| Sidecar crashes | unchanged | Claude Code drops the row on `ESRCH`; next `startBackgroundRun` sweep removes `<deadpid>.json`/`.key`/`.sock` **only** when the record has `entrypoint:"stratum-peer"` |
| Sidecar cannot bind the socket / write the key / write the record | unchanged, run proceeds unregistered | remove whatever partial file it created, write the reason to `<streamPath>.peer.err`, exit 2; `startBackgroundRun` never waits on the sidecar beyond the `spawn` event |
| Sidecar spawn itself fails (`spawn` error) | unchanged | logged, swallowed; `peer` field absent from meta and response |
| Run already finished before the sidecar registers (fast run) | unchanged | first stream scan already shows the sentinel → register with `status:"idle"`, hold the retention window, answer any subscription immediately, then cleanup |
| Run finishes between caller's `ListAgents` and `SendMessage` | unchanged | row still present for the retention window; subscription answered immediately. After the window the `SendMessage` errors and the caller falls back to `stratum_agent_poll` |
| MCP server restarts mid-run | unchanged (durable) | unaffected, detached; poll still finds the run via `meta.json` |

Invariant: the sidecar **reads** `stream.jsonl` and **writes only** `<sidecarPid>.json`, `<sidecarPid>.<hash>.key`, `<sidecarPid>.sock`, `<runDir>/peer.json`, and `<streamPath>.peer.err`. It never writes `stream.jsonl`, `meta.json`, or any registry file named for another pid. Cleanup after a normal terminal transition (sentinel or child death) happens at the **end of the linger window**; the two exceptions are signal shutdown (drain, then cleanup, no linger) and startup failure (partial files removed immediately). The poll and cancel contracts (`BackgroundPollResult`, cancel statuses) are byte-for-byte unchanged; the only additive change is the optional `peer` object.

### Kill switches and drift guard

- `STRATUM_PEER_REGISTER=0` disables registration entirely.
- Registration is skipped, with one info log line per run, when: the sessions dir does not exist (no Claude Code on this machine); or the sessions dir contains any live record with `peerProtocol > 1` (protocol moved on, our frames might be wrong); or the socket dir cannot be created with mode 0700. No version-string allowlist: the reader proved permissive across 2.1.238 to 2.1.272 and a string gate would only go stale.
- `sessionsDir` and `sockDir` are overridable (`STRATUM_PEER_SESSIONS_DIR`, `STRATUM_PEER_SOCK_DIR`, and as `StartBackgroundRunOptions` fields) so tests never touch the real registry.

### Safety of writing into Claude Code's registry

- Registry reads use `lstat` to skip non-regular files and symlinks, cap records at 262144 bytes (keys at 4096), and parent registration has a 2000 ms best-effort deadline.

- Only files named with the sidecar's **own pid** are ever created, and only records carrying `entrypoint:"stratum-peer"` with a dead filename pid are ever removed by the sweep. Never `rm` a socket we did not bind.
- Record 0644, key 0600, both written to a temp name in the same dir and renamed.
- Refuse to start if `<pid>.json` already exists and is not ours (pid reuse against a stale foreign record), log and skip registration.

---

## Testing

Per `~/.claude/rules/testing.md`: golden flow first, real processes, no mocks of the seam.

1. **Golden flow** (`ts/tests/connectors/peer-sidecar.test.ts`), no timing races: the fake child is a **controlled release**, `["sh","-c","printf '<agent_message line>\n'; until [ -e \"$RELEASE\" ]; do sleep 0.05; done"]` with `RELEASE` a path in the temp dir. `startBackgroundRun({agent:"codex", command, registryRoot, sessionsDir: tmp, sockDir: tmp, lingerMs: 500})` → wait for `<runDir>/peer.json` → `<sidecarPid>.json` has `kind:"bg"`, `status:"busy"`, a matching `.key` exists, the socket connects → a fake requester socket in `sockDir` (with its own key) sends `notify_when_idle` → the test touches `RELEASE` → the requester receives exactly one `peer_idle_notice` with the same `orig_msg_id`, `state:"idle"`, preceded by an auth line carrying the requester's token → the record reads `status:"idle"` during the linger → after the linger, record, key and socket are gone → `pollBackgroundRun` reports `complete` (sidecar changed nothing about the run).
2. **Error harness** (table-driven): child dies without sentinel (test kills the group the way cancel does) → `state:"exited"`; run already finished before subscription → immediate notice; subscription after the linger → connection refused, `pollBackgroundRun` still `complete`; `user` frame → `peer_message_status refused`; malformed line → ignored, connection still ends; unknown callback dir → notice not sent, logged; `STRATUM_PEER_REGISTER=0` → no files, no `peerName`, run unaffected; sessions dir missing → same; foreign `<pid>.json` present → skip; socket bind fails (pre-create a regular file at the socket path) → no record, `.peer.err` written, run unaffected, poll reports `peer.registered:false`; sidecar cannot write `peer.json` (read-only run dir after spawn) → registry files still cleaned up on exit, run unaffected.
3. **Contract test**: the record produced is accepted by a copy of the 2.1.272 reader rules (kind/status enums, canonical filename, size cap, `procStart` matches `TZ=UTC ps -o lstart=` for the sidecar pid, key filename equals `sha256(path.resolve(sock))`).
4. **Live verification (Phase 7 exit, manual, this session)**: launch a real codex bg run, call `ListAgents` and see the row, `SendMessage(notify_when_idle)` and receive the `[Cross-session idle notice]`, then confirm the row is gone. Equivalent of the probe already run during design.

Run the codex-lifecycle and background test files after the change; full suite once at the end.

---

## Risks and open questions

- **Protocol coupling to an undocumented Claude Code internal.** Mitigated by the shadow design (nothing about the run depends on it), the protocol gate, the kill switch, and the research report pinned to 2.1.272 so the next drift is diagnosable. Accepting this coupling is the point of the feature.
- **Idle-notice pid check on other builds.** In 2.1.272 subscriptions verify the socket answerer's pid equals the filename pid; the sidecar satisfies it by construction. If a future build also checks `procStart` via the currently stubbed synchronous helper, our `procStart` string is already the exact `ps` text, so it should still match.
- **Row clutter.** Every codex bg run adds a row for its lifetime only; rows disappear at completion, unlike the long-lived interactive sessions.
- **Linux `pidDomain`.** Formula reproduced from the bundle, not yet observed live; if it mismatches, the reader simply skips process checks, so the failure mode is "listed, less strictly verified", not "hidden".

## Unproven assumptions (gate checkpoint)

Verified live before implementation (probe runs 85307, 50870, 76985 on 2026-09-15): listing requires a socket; the `user` and `notify_when_idle` frames land (with an auth line once our key file exists); the subscription's pid check passes for a process that owns its own record; our `peer_idle_notice` dial-back connects and is written with the requester's token.

**Admission of the notice into the subscriber's model context: verified, with one required detail.** Probe 50870 sent a correlated `peer_idle_notice` **without** `from_mode` and nothing reached this session's model. Probe 76985 sent the same notice with **`from_mode` mirrored from the `notify_when_idle` request** (`"bypass"` here) and the `[Cross-session idle notice] "codex-probe3" … is idle now` arrived in this session's context. Claude Code classifies the notice's permission class from `from_mode` (receiver: `eAn(orig_msg_id, state, finished_at, detail, from_mode, verifiedPeer)`); a notice with no mode is treated as a different class and is at best shown to the user, not the model. **Rule for the sidecar: store the request's `from_mode` with each subscription and echo it on the notice.** The fallback for callers whose subscription fails remains `stratum_agent_poll`.
