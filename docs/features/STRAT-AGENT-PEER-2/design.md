# STRAT-AGENT-PEER-2 Design: Register Claude background runs as Claude Code peers

**Status:** DESIGN (2026-09-19) · design only, no implementation in this document
**Phase:** STRAT-AGENT: Agent Surface
**Parent:** STRAT-AGENT-PEER-1
**Related:** [feature.json](./feature.json), [blueprint.md](./blueprint.md), PEER-1 [design](../STRAT-AGENT-PEER-1/design.md), [blueprint](../STRAT-AGENT-PEER-1/blueprint.md), [implementation report](../STRAT-AGENT-PEER-1/report.md), [protocol research](../STRAT-AGENT-PEER-1/research-claude-code-peer-registry.md), [Claude background precedent](../STRAT-AGENT-BG-WRITE-1/blueprint.md).

---

## Problem Statement

`stratum_agent_run(agent="claude", background=true)` creates a worker thread but no Claude Code peer row. Concurrent runs cannot be individually discovered or subscribed to through `ListAgents`. Polling works, but the parent has no peer completion notification. PEER-1 provides this experience for Codex through a separate process that owns a real PID, socket, key, and registry record.

Claude workers share the MCP server's PID. A thread ID is not an OS PID and cannot own a registry filename. Registering several sockets under that one PID would repeatedly overwrite the same record. The missing piece is both a registry owner per visible run and a reliable lifecycle signal for an individual thread.

Decision: **reuse the sidecar executable, with one detached sidecar per Claude background run and a private IPC lifecycle channel from its MCP owner.** Also introduce optional `peerLabel` on background agent calls. The extra processes are an explicit cost of preserving individually addressable runs under the current peer protocol.

## Ground truth and evidence limits

Source references below were checked against `main` at `8231e6d` on 2026-09-19. The four PEER-1 documents and the complete shipped sidecar, worker, loader hooks, background manager, and process-identity helper were read before choosing this design. The supplied 2026-09-15 note was checked against the current writer and its helpers.

This pass did **not** register peers, invoke Claude's lister, run agents, run a build, or re-probe the current Claude executable. Writer behavior is verified locally; reader behavior remains evidence from PEER-1's research against Claude Code 2.1.272 and its recorded live verification. The implementation exit gate must repeat live interoperability checks on the installed version.

| Claim | Current evidence and consequence |
|---|---|
| Owner PID, socket, record and key must agree | `peer-sidecar.ts:50-54,355-398` binds and publishes using **its own** `process.pid`, not the Codex PID. Research §1/§3 establishes filename authority and subscription endpoint-PID checks. Retain that construction. |
| Registry root and key naming | `peer-registry.ts:20-25,46-50` honors explicit Stratum overrides, then `CLAUDE_CONFIG_DIR`, then `~/.claude`; key hash uses `path.resolve`, not realpath. |
| Identity and modes | `peer-registry.ts:28-43` produces UTC `ps lstart` and platform domain; `peer-sidecar.ts:78,289-304,381-398` publishes a random 32-hex token, key 0600, record 0644, discovery file 0600. `proc_identity.ts:50-64` is a different format for Stratum's process checks. |
| Listing needs a reachable socket; key is optional for listing | Reader-only behavior from research §1; current sidecar binds before publication and accepts empty probe connections (`peer-sidecar.ts:234-259,355-394`). The writer alone cannot re-prove the reader's 250 ms probe or allowed enums. |
| Record uses `kind:"bg"`, protocol 1, `notify_idle` | `peer-sidecar.ts:389-393`. Neither `kind:"claude"` nor a fabricated PID is suitable. |
| Wire is JSON lines with optional first auth, half-close and no ACK | `peer-sidecar.ts:107-131,234-259`. First-line auth mismatch is advisory. Unlike the native reader described in research, the sidecar does not parse an unterminated final fragment. Send newline-terminated frames. |
| Idle notices must echo request mode | `peer-sidecar.ts:66-75,163-168` retains and echoes `from_mode`; token lookup uses the callback destination. PEER-1's live report establishes model admission, not just successful socket writes. |
| Ref and stale timestamp behavior | Reader-only research §1/§5: socket-hash refs are the normal case, but stable-session addressing can hash `sessionId`, and collisions can extend refs. Stale `updatedAt` does not hide a row in that inspected build. Do not calculate or promise a fixed ref in Stratum. |
| Claude already writes compatible terminal records | `claude-bg-worker.ts:102-116` writes rc 0/1 sentinels; parent error/exit/cancel paths use the same stream (`background.ts:334-359,481-535`). No new result format is necessary. |

### Corrections to the ticket narrative and precedent

| Assumption | Finding | Resolution |
|---|---|---|
| Codex registers its run PID; worker threads therefore cannot use the same owner model | Codex has wrapper PID A **and** sidecar PID B. Only B owns the record and socket. The process assumption is in the sidecar's *run-death monitor*, not its registry writer. | Keep the writer and per-run owner. Replace child-PID monitoring only for Claude workers. |
| Codex used `flow` for peer labels | `peerName(model, runId)` takes no flow or label (`peer-registry.ts:15-18`). Server still requires `cancellationId` with `flow` and rejects it for background calls (`server.ts:183-195`). | Add a separate background-only `peerLabel`; do not relax cancellation or flow rules. |
| PEER-1's report summary describes the final start response | Its early tables/live transcript include `peer:"pending"`, but its final fix note and shipped contract remove it. | Return optional `peerName` only; preserve current `completionInstructions` generated by `server.ts:397-401`. |
| `peer.registered:true` means the peer is currently reachable | Sidecar leaves `peer.json` after cleanup; poll reads that historical file (`peer-sidecar.ts:395-398`, `background.ts:395-410`). | Preserve historical semantics. A vanished row still requires polling. |
| A Claude worker's completion is detected by checking the MCP PID | The parent may remain alive after one worker ends; finalization can fail to append a sentinel and still delete the worker entry (`background.ts:37-48`). | Use stream completion plus per-worker finalization/exit signals. |
| Source worker launch also works from packaged dist | Current spawn always names `.ts` plus `.mjs` hooks (`background.ts:321-330`); build emits `.js`, and preparation does not copy the worker source/hooks. | Include a narrow source/dist entry selection correction and a later built-artifact check; this is a static mismatch, not a reproduced runtime failure in this pass. |

## Scope

**In:** independently listed Claude background runs, per-run idle subscriptions, caller labels for both Claude and Codex background calls, additive Claude peer discovery on start/poll, lifecycle handling for completion/cancellation/worker failure/MCP loss, and source/dist worker entry selection needed to ship this path.

**Out:** foreground registration, delivery of new prompts into running workers, multiplexed run-selection protocols, moving Claude execution into separate processes, automatic subscriptions, fleet view, resurrecting workers after an MCP restart, and changes to run-result or cancellation outcomes. `feature.json` remains PLANNED until human design review.

## Design

### Owner: one sidecar per worker

```text
stratum-mcp (PID A)
  ├─ Claude worker W1 ── writes run 1 stream
  ├─ Claude worker W2 ── writes run 2 stream
  ├─ IPC lifetime for W1 ── detached peer sidecar B ── B.json / B.sock / B.<hash>.key
  └─ IPC lifetime for W2 ── detached peer sidecar C ── C.json / C.sock / C.<hash>.key
                             each reads only its associated run stream
```

| Option | Benefit | Cost / decision |
|---|---|---|
| One row served by the MCP PID | No extra process; lifetime matches the workers' host | `busy` can only mean “at least one run.” One worker finishing cannot make the row idle while another runs. `notify_when_idle` has no run selector; same-requester replacement also loses independent subscriptions. Labels/cwd/model become ambiguous. Reject for this per-run feature. |
| One dedicated sidecar multiplexing N workers | Isolates registry code with only one extra process | Still one PID and one row; the same completion and naming ambiguity remains. Custom messages listing run IDs would require new caller behavior that Claude's native subscription protocol does not provide. Reject. |
| N rows or N sockets served by PID A | Avoids sidecar processes | One canonical `<pid>.json` cannot represent N rows. Fake PIDs or thread IDs violate liveness/endpoint checks. Reject. |
| Move each Claude run into a child process | Natural OS lifecycle, one executor process per run | Replaces worker execution, cancellation and packaging contracts. A larger background-runtime redesign, outside this ticket. |
| **One existing sidecar process per worker** | Real owner PID per row, independent name/cwd/status/subscription, shared proven protocol implementation | Adds N Node processes and N IPC channels for N runs, plus terminal linger. Accept this overhead to preserve PEER-1's user experience. No performance claim without measurements. |

The sidecar represents a logical run; it does not claim the executor itself is an OS peer process. Detachment permits the peer to report loss of its MCP owner and drain callbacks briefly. **It does not make Claude execution survive a server restart.** No central broker, synthetic registry identities, or new public protocol is introduced.

### Run lifetime: stream plus private IPC

Extend `PeerSidecarConfig` with two explicit owner variants. The existing process variant keeps `childPid` and optional `childProcStartTime`, defaults when no new owner discriminator is supplied, and retains Codex's process monitor. The Claude-worker variant carries `ownerKind:"claude-worker"` and `runId`, requires the launcher-created Node IPC channel, and has no child PID. Never pass `worker.threadId` or the MCP PID as a substitute Codex child.

Worker-mode launch adds an IPC stdio slot to the existing detached `spawn`. The parent retains a small handle; it does not retain authority to kill or change the worker through that handle. Parent and child attach IPC error/disconnect listeners, unref the parent's channel and child handle, and explicitly disconnect on terminal cleanup. Peer IPC must not keep an otherwise exiting MCP server alive.

There is one private terminal message: `{type:"run-finalized", runId}`. It means **the associated worker has exited and the existing finalization claim has settled**, including the best-effort failure case. It carries no output, requested rc, registry paths, or permission state. It is not a Claude peer wire frame. A separate `{type:"owner-ready", runId}` handshake from the sidecar confirms that its IPC listeners are installed; it does not promise registry publication.

The parent installs a per-entry lifecycle latch synchronously alongside the existing worker listeners, before any metadata-write await. It records two facts: worker exit observed, and finalization settled. Only when both are true does it request `handle.finalize()`. The exit listener records exit even when `entry.cancelling` suppresses its terminal write; the finalization `.finally()` records settlement after the existing map deletion. Cancellation retains its current terminate/rescan/claim ordering. An error event alone is not evidence that the worker has exited.

Sidecar registration begins only after the initial `meta.json` write succeeds. If the worker finishes while registration is pending, the latch remembers completion and finalizes the handle immediately when attached. If registration is skipped, fails, or exceeds the two-second parent budget, abandon the latch; a handle arriving late is disconnected immediately. A late gate/sweep result must not initiate a new spawn after abandonment. No peer await enters the fatal metadata path or delays terminal-map deletion.

`finalize()` remembers the request until owner-ready, then sends the terminal IPC message once and disconnects after the send callback; bound the send to one second and absorb all send/closed-channel errors. Bound the wait for owner-ready to two seconds from spawn; expiry abandons the peer channel without affecting the worker. This handshake prevents a fast worker from sending and disconnecting before the sidecar installs its message listeners. `abandon()` disconnects without claiming the worker finished. Once disconnected, a handle is inert. Sidecar death merely makes future handle calls no-ops. Clear readiness/send timers and listeners on every terminal handle path.

The sidecar installs IPC listeners before its first asynchronous startup step, sends owner-ready, and latches messages/disconnects until initial stream scan and publication can be serialized. If the owner abandoned the channel before the handshake, startup stops without publishing a row. It reuses the bounded work queue; owner checks must not race record writes or terminal cleanup. Rules, in priority order:

1. A complete numeric sentinel wins: transition to `idle`, with `detail:"rc=<n>"` for nonzero rc, exactly as Codex does today.
2. On a matching `run-finalized`, rescan first. If still no sentinel, transition to `exited`, detail `worker_ended_without_sentinel`. The worker is known ended; do not invent success or write a sentinel.
3. On IPC disconnect without a finalized signal, rescan first. If no sentinel, transition to `unavailable`, detail `worker_owner_channel_lost`. Disconnection alone cannot distinguish MCP death from loss of observation while the worker still runs. Never leave a permanent busy row or claim success.
4. Read/publication/protocol-transport failure uses the existing unavailable cleanup behavior; normal stream silence is never completion.

Accepted terminal state is immutable. Duplicate messages, exit/error ordering, disconnect following finalized, and late sentinel watcher events cannot create a second notice or reverse a committed outcome. On early startup signals, the same precedence applies before the initial row is published. Missing IPC in worker mode is a startup error, never a fallback to MCP-PID monitoring.

### Record, socket and retention

Reuse the shipped record fields, `kind:"bg"`, `entrypoint:"stratum-peer"`, `peerProtocol:1`, `peerFeatures:["notify_idle"]`, UTC identity, file modes, listener, callback validation, and correlated cleanup. `pid` and filename are the sidecar PID; `sessionId` is its new UUID; `cwd` is the run's cwd; `startedAt` remains sidecar-registration time. The new name is described below; `nameSource` stays `derived` because Stratum constructs the final name.

Retain busy until terminal evidence, then write registry `status:"idle"` for terminal `idle` or `exited`; `exited` is a notice state, not a registry status. Owner-channel loss also enters bounded terminal retention with registry idle and notice state unavailable: idle here means the **peer endpoint** has no observable running work, not that the run succeeded. On registry I/O failure, cleanup may happen immediately without a visible final status.

Normal terminal outcomes, including owner-channel loss, retain the row/socket for `STRATUM_PEER_LINGER_MS` (default 15,000 ms), so late subscriptions get the latched outcome. Existing signal/startup-failure cleanup exceptions and at-most-five-second callback drain remain. Subscribe using the returned name, then poll for the actual result. In particular, a cancellation sentinel rc 130 produces an idle notice with `rc=130`; it does **not** mean successful completion.

The socket behavior remains PEER-1's shipped subset: advisory first-line auth; newline frames; empty probes; refusal of `user` text via `peer_message_status` (`expired` / `refused`); separate `notify_when_idle` subscriptions; at most 32 entries, replace by `from` only below capacity; echo `from_mode`; callback token belongs to the destination. Preserve the eight-active/32-queued callback bounds and shutdown drain. Under ordinary operation, accepted non-replaced subscriptions receive one notification attempt; process crashes and transport failures cannot promise delivery. No new IPC operation is exposed on the peer socket.

### Caller-supplied peer label

Add **`peerLabel?: string`** to `stratum_agent_run`, `AgentRunOptions`, and `StartBackgroundRunOptions`. It is permitted only with `background:true`, for either agent. Foreground use is rejected before starting work; `flow` remains forbidden on background calls. Direct connector callers receive equivalent validation.

The input is a short display hint, not a complete peer address or flow identifier. Validate before any worker/process spawn or run-directory creation:

- Require a string containing 1–64 characters after trimming; reject ASCII control characters in the original input.
- Normalize the trimmed string to lowercase, replace runs outside `[a-z0-9]` with `-`, and trim leading/trailing `-`. Reject a supplied label that becomes empty. Thus `Schema Review` becomes `schema-review`; a punctuation-only or non-ASCII-only label needs an explicit ASCII hint.
- Store only this normalized optional `peerLabel` in the initial run metadata. Do not rewrite metadata later for registration. Derive the same name from metadata before spawn, during delayed registration and on every poll.

Keep the existing two-argument `peerName(model, runId)` output byte-for-byte for unlabeled Codex runs. Extend it with an optional `{agent, label}` argument, default agent Codex. Naming rules:

| Run | Name |
|---|---|
| Existing/unlabeled Codex | `codex-<existingModelShort>-<runId6>` (unchanged) |
| Labeled Codex | `codex-<existingModelShort>-<runId12>-<label>` |
| Unlabeled Claude | `claude-<modelShort>-<runId12>` |
| Labeled Claude | `claude-<modelShort>-<runId12>-<label>` |

For Claude, use `modelIdentity(model).model`, lowercase, strip leading `claude-`, replace non-alphanumeric runs with `-`, trim, cap at 40 characters and trim again; fallback `model`. For labeled Codex, cap its existing short-model component to 40; its unlabeled legacy output remains untouched. New names fit below the researched 200-character reader limit, avoid address syntax, and retain the full run ID when labels could repeat. No prompt text, inferred task title, or cwd basename is used as a label. The returned `peerName`, rather than the input hint, is the subscription address.

Example: model `claude-sonnet-5`, run ID `abcdef123456`, label `Schema Review` → `claude-sonnet-5-abcdef123456-schema-review` in response, sidecar config, registry `name`, and `peer.json`. Two runs with the same label keep distinct names. Names are unique within the run root by run ID; cross-root random-ID collisions remain theoretical, and existing legacy Codex six-character collisions still require Claude's disambiguating ref. Do not change old names or registry format to solve that separate limitation.

### Start, poll and failure isolation

Claude start adds optional `peerName` when an attempt is launched within the registration budget, while still omitting top-level `pid`: a worker has no independent executor PID. Sidecar PID is available only as `poll.peer.pid`. Existing MCP `completionInstructions` already selects subscription guidance when `peerName` is present; retain it for both agents. No `peer:"pending"` field is added.

Generalize poll's existing bounded, no-follow `peer.json` read to both agents. Derive fallback name from agent/model/run ID and a valid optional metadata label. Old Claude metadata with no label remains readable. Absent or malformed peer metadata yields `{name, registered:false}`; valid discovery metadata yields historical `{name, registered:true, pid, sock}`, even after cleanup or an MCP restart. A malformed optional stored label is ignored rather than making an otherwise valid old run unreadable. Successful sidecar discovery is not a new precondition for any poll result.

| Event | Run behavior | Peer behavior |
|---|---|---|
| rc 0, rc 1, or cancellation rc 130 sentinel | Existing complete/error result | Idle notice; nonzero rc detail; linger and cleanup |
| Worker ends; terminal append fails | Existing error boundary, map deletion still occurs | Finalization + exit latch causes rescan, exited notice, cleanup after linger |
| Run finishes before sidecar bind | Existing terminal result | First scan/latch publishes terminal row; late subscription answered during linger |
| MCP exits/restarts mid-run | Worker execution is lost; poll after restart uses durable stream or reports missing sentinel | IPC closes; scan then unavailable if outcome is unknown, linger, cleanup; no reattachment to new MCP process |
| Sidecar spawn/bind/metadata failure, timeout or sidecar crash | Worker continues; poll/cancel unchanged | Best effort skip/cleanup; peer error log; caller polls |
| Initial run metadata write fails | Existing worker termination and rejected start | No registration starts |
| One of N workers ends or is cancelled | Other workers remain running | Only its own sidecar transitions; other rows/subscriptions remain busy |

### Kill switches, write boundaries and cleanup

Reuse `STRATUM_PEER_REGISTER=0`, missing/unreadable sessions-directory skip, live `peerProtocol > 1` guard, two-second parent registration budget, socket-directory overrides, first-line deadline, linger setting and existing marked-dead-peer sweep. Tests opt into registration only with isolated short `/tmp` directories. Resolve Claude registration settings from `options.env ?? process.env`; never mutate ambient env for individual launches.

Sidecar writes remain limited to its own registry record/key/socket, their atomic-write temporary files, `<runDir>/peer.json`, and `<streamPath>.peer.err`. It reads the associated stream; it never writes results or `meta.json`, never signals the worker/MCP PID, and never interprets a label as a path. Parent writes the normalized label with normal initial run metadata, and sends lifecycle facts through private IPC. The worker writes exactly its existing output/error artifacts.

Normal cleanup removes owned registry/key/socket files after retention, preserving historical `peer.json`. Partial startup cleanup, file identity checks and dead-marker sweep remain shared with PEER-1. Retain its documented same-user pathname-unlink race limitation; do not duplicate or weaken those safeguards in a new Claude-specific writer.

## Testing

The [blueprint](./blueprint.md) specifies future verification phases. The golden flow uses two real controlled-release worker threads in one host, two real sidecars and a real requester socket. Subscribe to both with different request IDs, release one, and prove one notice/idle row while the other remains busy. Release/cancel the second, retrieve both run results, then verify cleanup. No real API call is needed for this harness.

Regression coverage must exercise pre-registration completion, finalization/exit interleavings, missing sentinel, owner death, peer-only failure, labels and old metadata, input forwarding, source and emitted JS launches, and unchanged Codex behavior. The live exit check must observe admission of the notice to the Claude model with echoed `from_mode`, not merely a successful transport write. No tests or live probes are performed in this design pass.

## Risks and open questions

- **Resource overhead:** each active or lingering run adds a Node process. Measure representative concurrency before release. If overhead is unacceptable, revisit the product requirement for individually visible peers; a silent switch to multiplexing changes completion semantics.
- **Undocumented reader protocol:** code review verifies our producer, not compatibility with every Claude version. Live verification and existing kill switch remain necessary. The research calls the command `/list-agents` (alias `/peers`), not `/agents`, in 2.1.272; use the installed build's actual peer command.
- **IPC lifecycle correctness:** early exits, registration timeouts and callback shutdown are the new seam. The bounded state latch and real owner-process-death tests are implementation gates, not details to defer.
- **Existing result semantics:** any numeric sentinel ends peer work, including rc 130 and provider errors. Poll remains the result authority. This ticket does not redefine SDK result interpretation.
- **Platform evidence:** macOS interop was recorded in PEER-1; Linux domain/native endpoint behavior still needs platform verification. This design does not add Windows support.

## Unproven assumptions (gate checkpoint)

No owner or label decision remains open. What remains unproven is implementation behavior: private IPC disconnect observation on host death, source/dist parity, resource cost, and live model admission on the current Claude build. These are explicit Phase 6/7 checks in the blueprint. This document approves no implementation or status transition; the only deliverables in this pass are this design and its blueprint.
