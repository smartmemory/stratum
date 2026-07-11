# Codex CLI / cloud / exec-server — research (haiku, web)

## codex exec flags
- `--json`/`--experimental-json`: NDJSON events per state change
- `--output-last-message, -o`: write final assistant message to file
- `--output-schema`: JSON Schema file; validates + retries final response
- `--sandbox`: `read-only` (default) | `workspace-write` | `danger-full-access`
- `--skip-git-repo-check`; `--ephemeral` (no session files persisted);
  `--dangerously-bypass-approvals-and-sandbox`; `--ignore-rules`
- LIMITATION: `codex exec resume` does NOT accept `--output-schema` (must pick session memory OR schema).

## resume / fork
- `codex resume [SESSION_ID]` (`--last`, `--all`) reloads transcript, preserves history; accepts follow-up prompt/images.
- `codex fork` clones task into a NEW session id, original untouched (parallel exploration).
- Both preserve reasoning/web-search/image/context cells.

## codex cloud  [KEY background substrate — REMOTE]
- Hosted remote execution: isolated OpenAI-managed containers, repo checked out at branch/commit.
- Parallel task dispatch; BACKGROUND execution (start, run 1–30min, check later); container cache 12h.
- Setup phase has network, agent phase offline by default.
- Trigger from GitHub PR / Linear / Slack.
- Scriptable CLI commands `codex cloud wait/status/logs/output` are PROPOSED (GitHub issue #24777) — confidence: proposed, NOT confirmed shipped.
- Native polling: NOT FOUND.

## codex exec-server  (experimental) [KEY background substrate — LOCAL/SERVER]
- Persistent process hosting codex core threads; JSON-RPC 2.0 over WebSocket (one msg/frame).
- `codex exec-server --cloud` registers with codex-cloud-environments, gets signed rendezvous WS URL.
- Auth: `Authorization: Bearer <token>` at WS handshake. Overload → JSON-RPC -32001.
- Use case: durable background runtime for SDKs/clients to spawn headless codex sessions + poll (analogous to claude bg infra, but JSON-RPC not `--bg`).
- Source is codex-rs/app-server README + PR #19575 — confidence: experimental.

## Native local background
- NO local `codex --bg`/`codex agents` equivalent. `codex exec` is synchronous/blocking. Caller must wrap in own subprocess mgmt.
- OpenAI Background Mode API (GPT-5.2+ `background:true`) = async poll for long tasks, but NOT a codex CLI feature.
- Note: codex polling a background shell burns tokens (full history per poll) — issue #13733.

## codex apply
- `codex apply` (`codex a`): applies latest codex CLOUD task diff to local repo. `*** Begin/End Patch` format; Add/Delete/Update File ops; non-zero exit on git apply failure.

## Sources
- https://learn.chatgpt.com/docs/developer-commands?surface=cli
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/cloud
- https://github.com/openai/codex/pull/14930
- https://github.com/openai/codex/pull/19575
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- https://openai.com/index/unlocking-the-codex-harness/
- https://github.com/openai/codex/issues/13733
- https://github.com/openai/codex/issues/24777
