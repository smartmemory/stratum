# Codex sol/high feedback on CONSOLIDATED.md (locally verified, 2026-07-11)

## Corrections (codex verified against this machine: codex 0.144.0 Homebrew cask, claude 2.1.207)
- `claude -p --bare`: REAL
- `claude -p --json-schema`: REAL
- `claude daemon status`: REAL (reports "not running")
- `claude --bg` auto-worktree isolation: WRONG as written. `--bg` and `--worktree` are
  SEPARATE flags; auto-isolation unverified. (haiku hallucinated the coupling)
- `codex exec --ephemeral`: REAL
- `codex exec resume` can't take `--output-schema`: WRONG — accepts both. (haiku wrong)
- npm `@openai/codex-sdk` 0.144.1: WRONG — current is 0.144.0; 0.144.1 is the npm CLI.
  Neither SDK installed globally here.
- pip `openai-codex` 0.1.0b3: correct release, NOT installed here. Does NOT embed the CLI
  in its 65KB wheel — it pins/transitively installs `openai-codex-cli-bin==0.137.0a4`.
- "Both SDKs are CLI JSONL wrappers": WRONG. TS SDK wraps `codex exec`/JSONL; **Python
  SDK controls a pinned local `codex app-server` over JSON-RPC** (different transport).
- Local codex here = Homebrew cask 0.144.0, not pip/npm.
- `codex cloud`: real+experimental. `exec/status/list/diff/apply` exist TODAY;
  `wait/logs/output` do NOT (haiku's "proposed" list partly wrong).

## codex exec-server: REAL but MISIDENTIFIED
- It's an experimental JSON-RPC subprocess/filesystem executor (codex spawned printf,
  streamed output, got exit). It does NOT host codex threads or run the agent loop.
- Processes are CONNECTION-SCOPED (killed on client disconnect) → NOT a durability substrate.
- The thread-hosting runtime is `codex app-server` (the map confused the two).

## Missed local codex background path
- `codex app-server` (daemon, experimental, 0.144.0): thread/turn start, status, history,
  streaming, interruption over JSON-RPC. So Codex DOES have a local background/daemon path
  — just not an ergonomic `codex --bg`/`codex agents` CLI. My "only exec-server/cloud" was wrong.

## Corrected asymmetry
- Claude: ergonomic native local bg (`claude --bg` + `claude agents`).
- Codex: local bg exists but is raw JSON-RPC (`codex app-server`), not a submit-and-poll CLI.
- Both: cloud bg (Claude Routines / codex cloud). Both SDKs in-process (parent must live);
  durability is at the session/server layer.

## THE DECISION (our goal: don't block the harness on a codex WRITE build)
**Use (a) stratum WRITE-DURABLE.** Reasons:
- Lowest latency (operates on the current local dirty workspace directly).
- Best write-safety for the requirement: launch gated until (pid,start-time,pgid) persisted;
  identity-checked cancel; writable jobs killed on controller loss.
- Best retrieval: durable JSONL + sentinel + run_id + poll/watch.
- Maintenance: custom lifecycle, but the machinery already exists in the working tree.
- Network: only codex's normal model connection.
- DO NOT use exec-server: connection-bound process manager around `codex exec`, no agent
  durability, more maintenance.
- Use cloud ONLY when remote isolation + later diff/apply beats direct local writes; costs
  startup latency + auth/network, and can't consume a dirty unpushed workspace.

## Note
- Codex saw the WRITE-DURABLE slice 3/4 changes sitting UNCOMMITTED in the tree
  (codex.py:825, design.md) — the output of the background build I killed. Preserved.
