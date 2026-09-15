# Implementation review r2 (Codex gpt-6-astra, run 09a8a0733e41, 2026-09-15; full text — an earlier save was truncated by a controller-side false-positive sentinel match)

1. Review pending: I’m reading the committed code, spec, and tests only; no findings have been established yet.


1. **should-fix** — `ts/src/connectors/peer-registry.ts:99`: registration reads arbitrary registry entries without a deadline; a numeric `.json` FIFO with no writer can prevent an already-spawned background run from being returned. I’m checking the remaining lifecycle and ownership paths.


1. **should-fix** — `ts/src/connectors/background.ts:209`, `peer-registry.ts:99`: optional registration can indefinitely block returning an already-running child. **Scenario:** a numeric `<pid>.json` in `sessionsDir` is a FIFO without a writer; `shouldRegister()` awaits `readFile()` forever. The surrounding catch handles rejection, not hanging. Bound registry reads and isolate discovery behind a bounded startup deadline. The new `peer.json` read at `background.ts:348` similarly exposes poll to blocking nonregular files.

2. **should-fix** — `ts/src/connectors/peer-registry.ts:118`: the sweep infers ownership of every same-PID key and the current directory’s socket from one stale record. **Scenario:** a dead Stratum record points to socket directory A; a subsequent run uses directory B containing an unrelated `<deadpid>.sock`. The sweep unlinks B’s file without examining `messagingSocketPath` or its type, and leaves A’s stale socket behind. Validate the recorded endpoint and corresponding key instead of deleting all same-PID candidates. The test at `peer-registry.test.ts:81` omits the endpoint and expects deletion of a regular-file “socket,” cementing this gap.

3. **should-fix** — `ts/src/connectors/peer-sidecar.ts:283`: missing initial process identity can leave the sidecar alive forever after child death. **Scenario:** the initial `procStartTime()` lookup fails, then the wrapper dies without a sentinel. The sidecar passes `""` to `processIdentity()`, whose early return at `proc_identity.ts:94` prevents even checking for `ESRCH`. Its watcher and intervals persist indefinitely. Preserve “unknown” for unverifiable live processes while still recognizing positively absent PIDs. The existing missing-identity test checks only a living child.

4. **should-fix** — `ts/src/connectors/peer-sidecar.ts:102`: the serialized work queue has no coalescing or bound. **Scenario:** repeated identity probes take their five-second timeout while the two-second identity interval, half-second scan interval, and filesystem watcher keep appending promises. Work accumulates faster than it drains, increasing memory and delaying terminal detection. Coalesce pending scans and allow only one pending identity probe.

5. **should-fix** — `ts/src/connectors/peer-sidecar.ts:78`: inbound frame limits do not bound callback resources. **Scenario:** one connection streams many small valid `user` frames targeting a requester that holds connections open. Every frame immediately adds another callback promise, socket, and timer; neither `inFlight` nor connection count is capped. Repeated terminal subscriptions to one address also bypass the table-size limit through replacement. Bound concurrent callbacks and queued attempts; the existing oversized-input test exercises only individual input size.

6. **nit** — `ts/src/connectors/peer-registry.ts:148`: the launcher overwrites the configured first-line environment deadline. **Scenario:** launching a background run with `STRATUM_PEER_FIRST_LINE_MS=300` still produces a 30-second deadline because `background.ts:212` never forwards `firstLineDeadlineMs`, and `sidecarEnv()` replaces the inherited value. Forward the environment setting and test through `startBackgroundRun()`.

Read-only review; no tests, process probes, or socket operations were run.