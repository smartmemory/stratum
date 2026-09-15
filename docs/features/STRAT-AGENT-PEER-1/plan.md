# STRAT-AGENT-PEER-1 Implementation Plan

**Related:** [design.md](./design.md), [blueprint.md](./blueprint.md) (verified 2026-09-15), [feature.json](./feature.json)
**Executor:** Codex (`gpt-6-astra/medium`, `sandboxMode: workspace-write`, cwd `stratum/ts`). Controller (Claude) verifies locally, runs the live ListAgents check, commits.
**Test discipline:** TDD per task. Targeted runs: `npx vitest run tests/connectors/peer-registry.test.ts tests/connectors/peer-sidecar.test.ts tests/connectors/background.test.ts tests/connectors/background-codex-lifecycle.test.ts`. One full `npm test` at the end. Never pipe test output to `tail`.

Contract references: request/response shapes live in `ts/contracts/mcp-surface.json` (strict, `"key?"` = optional). Registry/key/frame shapes are in design.md "Ground truth" and "Socket protocol"; do not restate them here.

---

## Task 1 — Pure helpers: `ts/src/connectors/peer-registry.ts` (new) + `ts/tests/connectors/peer-registry.test.ts` (new)

No process spawning here; only fs reads, one `ps` exec, and pure functions.

- [ ] `peerName(model: string, runId: string): string` → `codex-<short>-<runId6>`; `short` = `modelIdentity(model).model` with `^gpt-[\d.]+-` and `codex-`/`-codex` stripped, then `[^a-z0-9]` removed; falls back to `codex` when empty. Tests: `gpt-6-astra/medium`→`codex-astra-4c165b`, `gpt-5.3-codex-spark`→`codex-spark-…`, `gpt-5.6-terra/high`→`codex-terra-…`.
- [ ] `resolveSessionsDir(env)`: `env.STRATUM_PEER_SESSIONS_DIR` ?? `join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions")`.
- [ ] `resolveSockDir(env)`: `env.STRATUM_PEER_SOCK_DIR` ?? `/tmp/cc-socks`.
- [ ] `claudeProcStart(pid): Promise<string | undefined>` → `execFile("ps", ["-o","lstart=","-p",String(pid)], { env: { ...process.env, LC_ALL:"C", TZ:"UTC" }, timeout: 1000 })`, trimmed. Test: for `process.pid`, matches `/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/`.
- [ ] `pidDomain(): Promise<string | undefined>` → `"darwin"` on darwin; on linux `darwin:<machine-id>:<readlink /proc/self/ns/pid>` (empty parts allowed, mirroring Claude Code); otherwise `undefined`.
- [ ] `keyFileName(pid, sockPath)` → `` `${pid}.${sha256(path.resolve(sockPath))}.key` ``. Test with a fixed path and precomputed hash.
- [ ] `isAllowedCallback(from: string, ownSockDir: string): string | undefined` → returns the absolute socket path when `from` is `uds:<abs>`, basename matches `/^\d+\.sock$/`, and dirname is `ownSockDir` or matches Claude Code's default-dir regexes (`^/tmp/cc-socks(?:-\d+)?$`, `^/private/tmp/cc-socks(?:-\d+)?$`, `^/run/user/\d+/cc-socks$`). Table-driven test incl. rejections (`uds:/etc/x.sock`, `tcp:…`, path traversal).
- [ ] `readPeerToken(sessionsDir, sockPath): Promise<string | undefined>` → find `*.${sha256(resolve(sockPath))}.key` in `sessionsDir`, read ≤4096 bytes, return `peerToken` if `/^[0-9a-f]{32}$/`.
- [ ] `shouldRegister(sessionsDir, env): Promise<{ ok: true } | { ok: false; reason: string }>` → false when `env.STRATUM_PEER_REGISTER === "0"`, when `sessionsDir` does not exist, or when any `*.json` record in it has numeric `peerProtocol > 1` and a live pid (`kill(pid,0)` not `ESRCH`).
- [ ] `sweepDeadStratumPeers(sessionsDir, sockDir): Promise<number>` → for each `<pid>.json` whose JSON has `entrypoint === "stratum-peer"` and whose pid is dead (`ESRCH`), unlink `<pid>.json`, `<pid>.*.key`, `<sockDir>/<pid>.sock`; never touch other records. Test: fixture dir with one dead stratum-peer record, one dead foreign record, one live record → only the first is removed.
- [ ] Export `PeerRecordFile = { pid: number; name: string; sock: string; registeredAt: string }` and `PeerSidecarConfig` (the env contract from blueprint "Boundary Map" prose) plus `sidecarEnv(config): NodeJS.ProcessEnv` / `configFromEnv(env): PeerSidecarConfig`.

## Task 2 — Sidecar process: `ts/src/connectors/peer-sidecar.ts` (new)

Depends on Task 1. Entry file with shebang `#!/usr/bin/env -S node --experimental-strip-types`; exports `spawnPeerSidecar(config): Promise<void>` (launcher used by `background.ts`) and runs `main()` only when executed directly (`import.meta.url === pathToFileURL(process.argv[1]).href`).

- [ ] `spawnPeerSidecar`: resolve entry as `new URL("./peer-sidecar.ts", import.meta.url)` if it exists else `./peer-sidecar.js`; `spawn(process.execPath, [...(entry ends with .ts ? ["--experimental-strip-types"] : []), entryPath], { detached: true, stdio: ["ignore","ignore", fd of "<streamPath>.peer.err"], env: sidecarEnv(config) })`, await `spawn` event, `unref()`. Any error → resolve (never reject); caller logs.
- [ ] `main()` order: (1) `mkdir sockDir 0700` if missing; (2) `net.createServer().listen(sockPath)` — on `EADDRINUSE` with a stale socket file for **our own pid only**, unlink and retry once; (3) `claudeProcStart(process.pid)`, `pidDomain()`; (4) write key (0600, tmp+rename); (5) write record (0644, tmp+rename) with `status` = `busy`, or `idle` if the first stream scan already finds the sentinel; (6) `atomicWriteJson(<runDir>/peer.json, PeerRecordFile)`. Failure at any step → remove what was created, write reason to stderr (the `.peer.err` file), `exit 2`.
- [ ] Refuse to start (exit 2, log) if `<sessionsDir>/<pid>.json` already exists and its `entrypoint !== "stratum-peer"`.
- [ ] Stream tailer: `fs.watch(streamPath)` + 500 ms interval fallback; read from a byte offset; complete-line JSON parsing with the same rules as `completeJsonLines` (skip malformed, drop >5 MB pending line, ignore trailing partial). Each complete line → `updatedAt = now` (rewrite record, atomic). Sentinel (`__t2f5_done__`) → terminal(idle, rc).
- [ ] Child watch: every 2 s `processIdentity(childPid, childProcStart)`; `"dead"` with no sentinel → terminal(exited); `"unknown"` → keep going.
- [ ] Socket server: per connection collect data, split on `\n`, parse each JSON line; first line `{"type":"auth"}` is consumed and ignored (log token mismatch at debug); `control/notify_when_idle` → acceptance rule from design (validate `from` via `isAllowedCallback`, replace on same `from`, cap 32, reject when full); `user` → dial back `peer_message_status {orig_msg_id, status:"expired", status_detail:"refused"}`; other → ignore. Cap buffered input at 1 MiB, 30 s first-line deadline, `socket.end()` after EOF.
- [ ] Dial-back `sendControl(toSockPath, frame)`: connect, 5 s timeout, write `{"type":"auth","token":<readPeerToken(...)>}\n` only when a token was found, then the frame + `\n`, `end()`, resolve on close/error (best effort, one attempt).
- [ ] `terminal(state, detail?)`: set `status:"idle"`, `updatedAt`/`statusUpdatedAt`; for each stored subscription fire exactly one `peer_idle_notice { orig_msg_id, state: "idle"|"exited", finished_at, detail?, from: "uds:<own sock>" }` and mark it notified; late subscriptions during the linger are answered immediately with the same state; after `lingerMs` (default 15000) → `cleanup()`.
- [ ] `SIGTERM`/`SIGINT` → stop accepting, fire `state:"exited"` for unnotified subscriptions, wait ≤5 s for in-flight dial-backs, `cleanup()`, exit 0.
- [ ] `cleanup()`: unlink record, key, socket file, `server.close()`. Never unlink files not created by this process.

## Task 3 — Wiring: `ts/src/connectors/background.ts`, `ts/src/connectors/runner.ts`, `ts/contracts/mcp-surface.json`, `ts/scripts/prepare-dist.mjs`

Depends on Tasks 1-2. TDD: extend `ts/tests/connectors/background.test.ts` fixtures only where needed; new assertions live in `peer-sidecar.test.ts` (Task 4).

- [ ] `StartBackgroundRunOptions` (background.ts L84-98) gains `sessionsDir?: string; sockDir?: string; lingerMs?: number`.
- [ ] Codex path, between `child.unref()` and the `return` (L195-196): `const name = peerName(model, runId)`; `const sessionsDir = options.sessionsDir ?? resolveSessionsDir(env)`; `const gate = await shouldRegister(sessionsDir, env)`; if `gate.ok`: `await sweepDeadStratumPeers(sessionsDir, sockDir).catch(() => 0)`; `await spawnPeerSidecar({...})`; return `{ status:"bg_started", runId, pid, streamPath, peerName: name, peer: "pending" }`; else log `gate.reason` once and return the unchanged shape.
- [ ] `startBackgroundRun` return type (L112-114) and `runAgent` return type (runner.ts L44) gain `peerName?: string; peer?: "pending"`.
- [ ] `runner.ts` background spread (L79-90) forwards `sessionsDir`, `sockDir`, `lingerMs` when present on `AgentRunOptions` (add the three optional fields to `AgentRunOptions`; they are **not** added to the MCP request contract).
- [ ] `pollBackgroundRun` (L316): after `loadMeta`, read `<runDir>/peer.json` (ignore ENOENT/malformed); build `peer = file ? { name, registered: true, pid, sock } : (meta.agent === "codex" && peerNameFor(meta) ? { name, registered: false } : undefined)` where `name = peerName(meta.model, runId)`; spread `...(peer ? { peer } : {})` into every `running`/`complete`/`error` result (L328, L340, L347, L350, L358, L368, L375, L378). `not_found` unchanged. `BackgroundPollResult` (L102-106) gains `peer?: { name: string; registered: boolean; pid?: number; sock?: string }` on those three variants.
- [ ] `mcp-surface.json`: `stratum_agent_run.responses.bg_started` += `"peerName?": "string", "peer?": "string"`; `stratum_agent_poll.responses.running|complete|error` += `"peer?": { "name": "string", "registered": "boolean", "pid?": "number", "sock?": "string" }`. `assertToolResponse` must accept both the old and new shapes (contract test in Task 4).
- [ ] `prepare-dist.mjs` `entries` (L10-13) += `new URL("../dist/connectors/peer-sidecar.js", import.meta.url)`. `npm run build` must pass.
- [ ] Note in code comments: `cancelBackgroundRun` intentionally untouched (design "Cancellation and failure isolation").

## Task 4 — Tests: `ts/tests/connectors/peer-sidecar.test.ts` (new), contract test

Depends on Task 3. Real processes, real sockets, temp dirs. `sockDir` **under `/tmp`** (`mkdtemp("/tmp/sp-")`), `sessionsDir` under `tmpdir()`.

Hygiene rules (non-negotiable):
- **No mocking** of `ps`, sockets, `spawn`, or the filesystem. If the executing sandbox cannot bind a socket or run `ps`, mark that test with a named `it.skip`/`describe.skipIf(...)` reason (`sandbox denies unix sockets`) and say so in the report; never weaken an assertion to pass.
- `afterEach` must SIGTERM every sidecar it started (pids from `peer.json`, or scan `sessionsDir` for `entrypoint:"stratum-peer"` records) and `rm -rf` the `/tmp/sp-*` and `sessionsDir` temp dirs, so a failed run leaves no orphan processes or stale sockets.
- The controlled-release child needs `env: { ...process.env, RELEASE }` passed to `startBackgroundRun`: `options.env` **replaces** the ambient env wholesale (background.ts L146-158), it does not merge.
- `pollBackgroundRun` reports `peer.registered:false` indefinitely for runs where registration was skipped by the kill switch or gate (poll cannot tell "skipped" from "starting"). Accepted for v1; do not add a marker file for it.

- [ ] Golden flow exactly as design §Testing item 1: controlled-release child (`until [ -e "$RELEASE" ]`), `lingerMs: 500`, wait for `peer.json`, assert record (`kind:"bg"`, `status:"busy"`, `entrypoint:"stratum-peer"`, `procStart` equals `TZ=UTC ps -o lstart=` for the sidecar pid, `messagingSocketPath` connectable), assert key file name/mode/contents, fake requester (own socket + own key in the same dirs) sends `notify_when_idle`, touch `RELEASE`, requester receives one `peer_idle_notice` with matching `orig_msg_id`, `state:"idle"`, preceded by an auth line with the requester's token; record shows `status:"idle"` during linger; after linger all three files are gone; `pollBackgroundRun` → `complete` with `peer.registered:true` before cleanup.
- [ ] Error harness (table-driven, one `it.each`): rows from design §Testing item 2 (child killed as a group with no sentinel → `exited`; late subscription inside linger → immediate notice; subscription after linger → `ECONNREFUSED`/`ENOENT`, poll still `complete`; `user` frame → `peer_message_status` `expired`/`refused` dial-back; malformed line → ignored; disallowed callback dir → no dial-back; `STRATUM_PEER_REGISTER=0` → no files, no `peerName`; missing sessions dir → same; foreign `<pid>.json` → sidecar exits 2, `.peer.err` written; socket path pre-occupied by a regular file → exit 2, no record, poll `peer.registered:false`; read-only run dir after spawn → registry files still cleaned).
- [ ] Contract test: `assertToolResponse("stratum_agent_run", { status:"bg_started", runId, streamPath, peerName, peer:"pending" })` and the three poll variants with `peer` pass; a response with an undeclared key still throws.
- [ ] Regression: existing `background.test.ts`, `background-codex-lifecycle.test.ts`, `background-claude*.test.ts` unchanged and green.

## Task 5 — Docs (same commit as code)

- [ ] `CHANGELOG.md` `[Unreleased]`: one entry, "Codex background runs register as Claude Code peer sessions" with `peerName`, `notify_when_idle`, kill switch `STRATUM_PEER_REGISTER=0`, linger default, and the 2.1.272 coupling note.
- [ ] `README.md` under L499 section: a paragraph on the peer row, how to subscribe instead of polling, and the env knobs.

## Parallelism

Task 1 and the Task 4 contract test can proceed in parallel; Task 2 depends on 1; Task 3 depends on 2; Task 4 golden flow depends on 3. Single Codex dispatch runs them sequentially; the controller reviews after Task 3 and again after Task 4.

## Controller verification (not delegated)

1. `cd ts && npx vitest run tests/connectors/peer-registry.test.ts tests/connectors/peer-sidecar.test.ts tests/connectors/background.test.ts tests/connectors/background-codex-lifecycle.test.ts`
2. `npm run typecheck && npm run build`
3. **Live verification (hard Phase 7 exit criterion, no MCP restart needed):** after `npm run build`, run a `node -e` from `ts/` that imports `dist/connectors/background.js` and calls `startBackgroundRun({ agent:"codex", prompt:"x", cwd, command:["sh","-c","sleep 40"] })` with **default** dirs (real `~/.claude/sessions`, real `/tmp/cc-socks`). From this Claude session: `ListAgents` shows `codex-<short>-<runId6> · bg · busy`; `SendMessage(to=<that name>, notify_when_idle=true)` succeeds; when the child exits a `[Cross-session idle notice]` arrives here; after the linger the row is gone and no `<pid>.json`/`.key`/`.sock` remain. Record the outcome verbatim in `report.md`.
4. Full `npm test` once.
