# STRAT-AGENT-PEER-1 Blueprint

**Related:** [design.md](./design.md) (gate passed 2026-09-15, r4 REVIEW CLEAN), [research-claude-code-peer-registry.md](./research-claude-code-peer-registry.md), [feature.json](./feature.json)
**Repo:** `stratum/ts` (`@smartmemory/stratum` 0.5.2, ESM, Node ≥22.15, vitest)

All line references verified against the working tree at commit `6f12e6b`+design commit on 2026-09-15 (see Verification Table).

---

## Overlap scan

No other `docs/features/*/blueprint.md` in stratum references `background.ts`, `mcp-surface.json` `stratum_agent_run`, or a new connector entry; `STRAT-AGENT-BG-WRITE-1` is COMPLETE. No in-flight overlap.

---

## File Plan

| # | File | Kind | Change |
|---|---|---|---|
| 1 | `ts/src/connectors/peer-registry.ts` | new | Pure helpers, no I/O side effects beyond what is named: `peerName()`, `resolveSessionsDir()`, `resolveSockDir()`, `claudeProcStart(pid)` (`LC_ALL=C TZ=UTC ps -o lstart= -p`), `pidDomain()`, `keyFileName(pid, sockPath)`, `isAllowedCallback(from, ownSockDir)`, `readPeerToken(sessionsDir, sockPath)`, `shouldRegister(sessionsDir, env)` (kill switch + protocol gate), `sweepDeadStratumPeers(sessionsDir, sockDir)` |
| 2 | `ts/src/connectors/peer-sidecar.ts` | new | The detached process entry (`#!/usr/bin/env -S node --experimental-strip-types` like `cli/stratum.ts`). Reads config from env (`STRATUM_PEER_*`), binds socket, writes key + record, writes `<runDir>/peer.json`, tails the stream, serves the protocol subset, linger, drain, cleanup |
| 3 | `ts/src/connectors/background.ts` | existing | Codex path: after `child.unref()` (L195) spawn the sidecar (best effort); `StartBackgroundRunOptions` (L84) gains `sessionsDir?`, `sockDir?`, `lingerMs?`; `startBackgroundRun` return (L112-114) and `bg_started` gain `peerName?`, `peer?: "pending"`; `pollBackgroundRun` (L316) reads `<runDir>/peer.json` and adds `peer` to `running`/`complete`/`error` results; `BackgroundPollResult` (L102-106) gains `peer?` |
| 4 | `ts/src/connectors/runner.ts` | existing | Return type at L44 widened to carry `peerName?`/`peer?`; forward `sessionsDir`/`sockDir`/`lingerMs` from `AgentRunOptions` if present (test seam only, not on the MCP wire; spread block L79-90) |
| 5 | `ts/contracts/mcp-surface.json` | existing | `stratum_agent_run.responses.bg_started` (L1118-1122) gains `"peerName?": "string"`, `"peer?": "string"`; `stratum_agent_poll.responses.{running,complete,error}` gain `"peer?": {"name": "string", "registered": "boolean", "pid?": "number", "sock?": "string"}` |
| 6 | `ts/scripts/prepare-dist.mjs` | existing | Add `../dist/connectors/peer-sidecar.js` to the shebang-rewrite `entries` list (L10-13) so the built sidecar is executable |
| 7 | `ts/tests/connectors/peer-registry.test.ts` | new | Unit tests for the pure helpers (name, key filename hash, callback rule, procStart format, sweep only touches `entrypoint:"stratum-peer"` records) |
| 8 | `ts/tests/connectors/peer-sidecar.test.ts` | new | Golden flow + error harness per design §Testing, using `startBackgroundRun` with `command`, `registryRoot`, `sessionsDir`, `sockDir`, `lingerMs` |
| 9 | `ts/tests/mcp-surface-peer.test.ts` (or extend existing surface test) | new | Contract test: `assertToolResponse("stratum_agent_run", bgStartedWithPeer)` and poll variants pass; 2.1.272 reader rules applied to a real record produced by the sidecar |
| 10 | `README.md` | existing | Paragraph under `### stratum_agent_run / stratum_agent_poll / stratum_cancel_agent_run` (L499) describing the peer row, `peerName`, `notify_when_idle`, kill switch |
| 11 | `CHANGELOG.md` | existing | `[Unreleased]` entry |

---

## Grounding: what the code does today

### Codex background spawn (`ts/src/connectors/background.ts`)

- L48-53: `T2F5_DONE_SENTINEL = "__t2f5_done__"`; `T2F5_SHELL_WRAPPER` runs `"$@"` with stdout→`$T2F5_OUT`, then appends `{"__t2f5_done__":rc}`. **No sentinel is written if `sh` itself is killed** (cancel path).
- L70-74: `CodexRunMeta { agent:"codex"; childPid; procStartTime? }` extends `BackgroundRunMetaBase` (L60-68: `runId, model, cwd, sandboxMode, promptChars, createdAt, streamPath, stderrPath`).
- L84-98: `StartBackgroundRunOptions` incl. `command?: string[]` seam and `registryRoot?`.
- L102-106: `BackgroundPollResult` union (`not_found | running | complete | error`).
- L112-114: `startBackgroundRun` returns `{ status:"bg_started"; runId; pid?; streamPath }`.
- L131-135: `newRunDir` → `runDir`, `streamPath = join(runDir,"stream.jsonl")`.
- L154: `const createdAt = new Date().toISOString();`
- L161-166: `spawn("sh", ["-c", T2F5_SHELL_WRAPPER, "sh", ...command], { cwd, env, detached: true, stdio: "ignore" })`.
- L171-173: `pid = child.pid`; `startTime = await procStartTime(pid)` (stratum format, **not** `ps lstart`).
- L174-185: `meta` built and written with `atomicWriteJson(join(runDir,"meta.json"))` at L188 (inside the `try` at L187-193); failure → `killDetachedProcessGroup` + throw (the fatal path the design keeps the sidecar out of).
- L195-196: `child.unref(); return { status:"bg_started", runId, pid, streamPath };` ← **sidecar spawn goes between these two lines.**
- L316: `pollBackgroundRun(runId, options)`; L317-319 `loadMeta` gives `streamPath`; result objects built at L328, L340, L347, L350, L358, L368, L375, L378 ← each gains `...peer`.
- L383-450: `cancelBackgroundRun`; codex branch L440-449 (`// Codex path — unchanged:` at L440, `kill(-pid,"SIGTERM")` at L448) after two `processIdentityMatches` checks. **Unchanged.**
- L463-468: `atomicWriteJson(path, value)` (tmp `${path}.${process.pid}.tmp` + rename, mode 0600). Reused by the sidecar for `peer.json`; the registry record needs mode 0644 so the sidecar writes it with its own tmp+rename and `chmod`.
- L482-498: `loadMeta(runId, root)` validates `RUN_ID` (`/^[0-9a-f]{12}$/`, L54) and `meta.json`.
- L568-600: `completeJsonLines(path)` async generator, ignores trailing partial line, `MAX_LINE_BYTES` 5 MB (L58). The sidecar tails by re-scanning from a byte offset with the same complete-line discipline (copy the loop; do not import the private generator).

### Process identity (`ts/src/connectors/proc_identity.ts`)

- L50-63 `procStartTime(pid)` → darwin `tvsec.tvusec` via libproc python, linux `/proc/<pid>/stat` field 22.
- L92-107 `processIdentity(pid, startTime)` → `"alive" | "dead" | "unknown"`; only `ESRCH` or a **readable mismatching** start time is `dead`. The sidecar uses this for `childPid` + `childProcStartTime` and never acts on `unknown`.

### Model naming

- `ts/src/connectors/base.ts` L82 `modelIdentity(modelId) → { model, effort? }`.
- `ts/src/connectors/codex.ts` L122 `defaultCodexModel()` (`gpt-5.6-terra/high`), L557 `codexModelWithEffort(model, effort)`.
- `peerName(model, runId, stepId?)`: `modelIdentity(model).model` → strip `^gpt-[\d.]+-` and `-codex`/`codex-` → `[a-z0-9]+` (e.g. `gpt-6-astra` → `astra`, `gpt-5.3-codex-spark` → `spark`, `gpt-5.6-terra` → `terra`) → `codex-<short>-<runId.slice(0,6)>` (no step suffix in v1, see corrections).

### MCP surface

- `ts/contracts/mcp-surface.json` L1078 `stratum_agent_run.request`; L1118-1122 `bg_started: { runId, pid?, streamPath }`.
- `stratum_agent_poll.responses` follow at L1124+ (`not_found`, `running` L~1131, `complete`, `error`).
- `ts/src/mcp/contracts.ts` L80/L122/L125: optional keys are `"key?"`; nested object shapes are supported (see `"split?"` at surface L62, L373). Extra keys are rejected (strict), so both contract and code must change together.
- `ts/src/mcp/server.ts` L391 `response = "status" in executed ? { ...executed } : {...}` for `stratum_agent_run`; L394 `case "stratum_agent_poll": response = await agentPoll(runId)`. **No server.ts change needed**: `startBackgroundRun`/`pollBackgroundRun` return the new fields and they are spread through. `flow` **cannot** accompany a background run: L182-186 requires `cancellationId` with `flow`, and L194 rejects `cancellationId` when `background === true`. So there is no step label source for background runs in v1; the name is `codex-<short>-<runId6>` only (design's optional `-<stepId>` suffix is dropped, see corrections).

### Runtime entry resolution

- `ts/src/cli/stratum.ts` shebang `#!/usr/bin/env -S node --experimental-strip-types`; `prepare-dist.mjs` L8-22 rewrites it to `#!/usr/bin/env node` for the two `entries`. The sidecar entry follows the same pattern and is spawned as `process.execPath [--experimental-strip-types when running from src] <entry>`; resolve the entry as `new URL("./peer-sidecar.ts", import.meta.url)` and fall back to `.js` when the `.ts` does not exist (dist). In vitest the `.ts` exists and Node 22 strips types natively.
- `ts/scripts/prepare-dist.mjs` L37-44 copies contracts; no change beyond the `entries` list.

### Test conventions

- `ts/tests/connectors/background.test.ts` L1-60: `mkdtemp` roots with `afterEach` cleanup, `fakeCodex(records, {rc, stderr, sleep})` builds a `["sh","-c",…]` command, `waitFor(runId, registryRoot, status)` polls `pollBackgroundRun`.
- `ts/tests/connectors/background-codex-lifecycle.test.ts` L44-56: `startBackgroundRun({ agent:"codex", prompt, cwd: registryRoot, registryRoot, command: ["sh","-c","sleep 30"] })`.
- Test socket paths must stay short (macOS `sun_path` 104 bytes): use `mkdtemp(join("/tmp", "sp-"))` for `sockDir`, not `os.tmpdir()` (which is `/var/folders/...` and long).

---

## Corrections table (spec assumption vs reality)

| Design/roadmap assumption | Reality in code | Resolution |
|---|---|---|
| Sidecar can reuse `completeJsonLines` for tailing | It is module-private (L568, not exported) and re-reads the whole file each call | Sidecar keeps its own byte offset and a small complete-line parser; do not export the private generator |
| `atomicWriteJson` can write the registry record | It hardcodes mode 0600 (L466); Claude Code writes records 0644 | Sidecar writes record via its own tmp+rename with mode 0644; `peer.json` may use 0600 |
| `stepId` is available for the peer name | `flow` requires `cancellationId` (server L182-186) and `cancellationId` is rejected for background runs (L194); a background run never carries `flow` | v1 name is `codex-<short>-<runId6>`; no `peerLabel`, no request-contract change. A caller-supplied label is a follow-up if wanted |
| Stratum's `procStartTime()` gives the registry `procStart` | Returns `tvsec.tvusec` on darwin (proc_identity L50-63) | New `claudeProcStart(pid)` runs `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>`; used only for the registry record and key |
| Sockets can live under `os.tmpdir()` in tests | macOS tmpdir paths are ~50+ chars; `sun_path` limit 104 | Tests create `sockDir` under `/tmp` |
| `server.ts` needs a response-shape change | Responses are spread through unchanged (L391, L394) | Only `mcp-surface.json` + `background.ts` change |

---

## Boundary Map

Two work units: **S1 sidecar + helpers** (files 1, 2, 7, 8) and **S2 wiring + contract** (files 3, 4, 5, 6, 9, 10, 11).

| Symbol | Kind | File | Produced by | Consumed by |
|---|---|---|---|---|
| `PeerSidecarConfig` | interface | `ts/src/connectors/peer-registry.ts` | S1 | S1 (`peer-sidecar.ts` parses env into it), S2 (`background.ts` serialises it into env) |
| `peerName` | function | `ts/src/connectors/peer-registry.ts` | S1 | S2 (`background.ts` computes the deterministic name before spawn) |
| `shouldRegister` | function | `ts/src/connectors/peer-registry.ts` | S1 | S2 (`background.ts` decides whether to spawn and whether to emit `peerName`) |
| `sweepDeadStratumPeers` | function | `ts/src/connectors/peer-registry.ts` | S1 | S2 (`background.ts` calls it once per `startBackgroundRun`) |
| `PeerRecordFile` | type | `ts/src/connectors/peer-registry.ts` | S1 | S2 (`pollBackgroundRun` parses `<runDir>/peer.json` into it) |
| `spawnPeerSidecar` | function | `ts/src/connectors/peer-sidecar.ts` (exported launcher, separate from the `main()` guarded by `import.meta.url === process.argv[1]` check) | S1 | S2 (`background.ts` L195) |
| `StartBackgroundRunOptions` | interface | `ts/src/connectors/background.ts` | S2 (adds `sessionsDir?`, `sockDir?`, `lingerMs?`) | S1 tests (file 8) |

Endpoints and payloads (prose, not map entries): the registry record JSON, the key JSON, the `peer.json` shape `{ pid, name, sock, registeredAt }`, the env contract `STRATUM_PEER_RUN_DIR, STRATUM_PEER_STREAM, STRATUM_PEER_CHILD_PID, STRATUM_PEER_CHILD_START, STRATUM_PEER_NAME, STRATUM_PEER_CWD, STRATUM_PEER_SESSIONS_DIR, STRATUM_PEER_SOCK_DIR, STRATUM_PEER_LINGER_MS`, and the wire frames documented in design.md.

---

## Verification Table (Phase 5)

Verified 2026-09-15 by printing each range from the working tree (commit `817eb43`). Three references were stale on first pass and corrected in place (meta write is L188 not L187; codex cancel branch is L440-449 not L453-460; the `stepId` label has no source for background runs). Zero stale entries remain.

| Ref | Claim | Result |
|---|---|---|
| background.ts L48-53 | sentinel + wrapper constants | ok |
| background.ts L54, L58 | `RUN_ID`, `MAX_LINE_BYTES` | ok |
| background.ts L70-74 | `CodexRunMeta` | ok |
| background.ts L84-98 | `StartBackgroundRunOptions` with `command?` | ok |
| background.ts L102-106 | `BackgroundPollResult` | ok |
| background.ts L112-114 | `startBackgroundRun` signature | ok |
| background.ts L161-166 | `spawn("sh", …detached:true)` | ok |
| background.ts L187-193, L188 | `try` + `atomicWriteJson(meta.json)` fatal path | ok (corrected from L187) |
| background.ts L195-196 | `child.unref(); return bg_started` | ok |
| background.ts L316 | `pollBackgroundRun` | ok |
| background.ts L440-449 | codex cancel: identity checks + `kill(-pid)` at L448 | ok (corrected from L453-460) |
| background.ts L463-468 | `atomicWriteJson` mode 0600 | ok |
| background.ts L568 | `completeJsonLines` private | ok |
| proc_identity.ts L50, L92 | `procStartTime`, `processIdentity` | ok |
| base.ts L82 | `modelIdentity` | ok |
| codex.ts L122, L557 | `defaultCodexModel`, `codexModelWithEffort` | ok |
| mcp-surface.json L1078, L1118-1122 | `stratum_agent_run`, `bg_started` | ok |
| contracts.ts L80, L122, L125 | `"key?"` optional grammar, undeclared keys rejected | ok |
| server.ts L182-186, L194, L200-206, L391, L394 | flow needs cancellationId; cancellationId rejected for background; flow parse; run/poll passthrough | ok (stepId claim corrected) |
| runner.ts L41-44, L79-90 | `runAgent` signature and background spread | ok |
| prepare-dist.mjs L8-22 | shebang rewrite entries | ok |
| background.test.ts L1-60 | fixtures | ok |
| background-codex-lifecycle.test.ts L44-56 | `command` seam | ok |
| README.md L499 | agent-run section heading | ok |
| Boundary Map | `validateBoundaryMap` → `{ ok: true, violations: [], warnings: [] }` | ok |
