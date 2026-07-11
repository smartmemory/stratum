# Agent invocation surfaces — consolidated map (web research, haiku ×5, 2026-07-11)

Confidence tags: [V]=I verified locally this session; [S]=multiple sources agree;
[1]=single source; [P]=proposed/PR/issue, not confirmed shipped; [?]=uncertain.

## The corrected headline

My earlier claims were wrong in two ways:
1. **Codex HAS an embeddable SDK** (`@openai/codex-sdk`, `openai-codex`). [S]
2. Neither SDK gives true *detached durability*: **both** the Claude and Codex
   SDKs are subprocess wrappers over their own CLI (JSONL over stdin/stdout); the
   parent process must stay alive. Durability lives at a *session/server* layer,
   not in the SDK. [S]

The real asymmetry is narrower than "codex has no runtime":

| Capability | Claude | Codex |
|---|---|---|
| Embeddable SDK (subprocess wrapper over CLI) | claude-agent-sdk [S] | @openai/codex-sdk / openai-codex [S] |
| Sessions: resume / fork | ✅ resume, fork_session [S] | ✅ resume, fork (thread/*) [S] |
| Sandbox / write presets | permission_mode (acceptEdits/bypass/plan/dontAsk/auto) [S] | read_only / workspace_write / full_access [S] |
| Streaming + structured output | stream-json, --json-schema [S/1] | runStreamed, outputSchema [S] |
| **Native LOCAL background runtime** | ✅ `claude --bg` + `claude agents` [V] | ❌ none — must wrap, or use exec-server [S] |
| Local durable server | (the CLI IS the runtime) | `codex exec-server` JSON-RPC/WS [P, experimental] |
| **Hosted CLOUD background** | ✅ Routines (`/schedule`, API, GitHub) [S] | ✅ `codex cloud` (containers) [S] |
| Underlying async API | (Anthropic) | Responses API `background:true` (GPT-5.2+) [S] |

So: **for LOCAL native background, Claude has it and Codex doesn't.** For CLOUD
background, both do. Both SDKs are in-process (parent must live).

## Substrate inventory (both agents)

### A. Embeddable Agent SDK — in-process, parent must stay alive
- **Claude**: `claude-agent-sdk` (pip 0.2.110), `@anthropic-ai/claude-agent-sdk`.
  `query()` async iterator; `ClaudeSDKClient` multi-turn; options: allowed_tools,
  permission_mode {default,acceptEdits,bypassPermissions,plan,dontAsk,auto},
  resume, fork_session, hooks, mcp_servers. Spawns BUNDLED claude CLI subprocess.
  Session files `~/.claude/projects/<cwd>/<session-id>.jsonl`. CAVEAT: CLAUDECODE=1
  inherited when run inside a CC session → rejection. [S]
- **Codex**: `@openai/codex-sdk` (npm 0.144.1 [1]), `openai-codex` (pip 0.1.0b3 beta [1]).
  `Codex`/`AsyncCodex`; `startThread`/`resumeThread`; `Thread.run` / `runStreamed`;
  sandbox {read_only,workspace_write,full_access}; `outputSchema`. AsyncCodex =
  in-process async (subprocess JSONL), NOT detached. Threads persisted server-side
  (app-server), resume by threadId. [S]

### B. Native CLI, synchronous (one-shot, blocks)
- `claude -p` / `--print`: --output-format text|json|stream-json;
  --include-partial-messages; --json-schema→structured_output [1]; `--bare` skip
  discovery [1]. Background bash it spawns is killed ~5s after result; subagents
  wait (10min ceiling, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS). [S]
- `codex exec`: --json, --output-schema, -o/--output-last-message, --sandbox,
  --skip-git-repo-check, --ephemeral [1]. `resume` doesn't accept --output-schema [1].

### C. Native CLI, LOCAL background/durable
- **Claude** [V for --bg/agents/stop/logs/attach existence]: `claude --bg "task"`
  → detached session, returns id immediately, stays IDLE after completion (persistent,
  attachable, NOT one-shot), local-only (lost on shutdown). `claude agents` (TUI +
  --json: pid/sessionId/status/cwd), `attach`/`logs`/`stop`/`rm` [1], `daemon status` [1].
  Worktree isolation under .claude/worktrees before edits [1, unverified].
- **Codex**: NO local `codex --bg`. `codex exec` is blocking. `codex exec-server`
  [P]: persistent JSON-RPC 2.0 / WebSocket server hosting codex threads; `--cloud`
  registers rendezvous tunnel; Bearer auth. This is codex's would-be durable local
  substrate but is experimental (codex-rs/app-server, PR #19575).

### D. Hosted CLOUD background
- **Claude Routines**: saved CC config on Anthropic cloud; triggers scheduled/API
  (`/v1/claude_code/routines/{id}/fire`)/GitHub; persists across shutdown; needs
  claude.ai Pro/Max/Team/Ent + CC-on-web (NOT console key). `/schedule` creates
  scheduled ones. [S]
- **Codex cloud**: isolated containers, repo@branch, parallel, background (1–30min),
  12h cache, trigger from GitHub/Linear/Slack. Scriptable `codex cloud wait/status/
  logs/output` PROPOSED (#24777) [P]. `codex apply` pulls a cloud task's diff local. [S]

### E. MCP facade (stratum) — wraps A/B/C
- `stratum_agent_run(type, background, write)`. Today: codex durable bg (read-only) ✅;
  codex write+bg ❌ (WRITE-DURABLE fixes); claude bg ❌ (STRAT-AGENT-BG-CLAUDE). [V]
- NEW OPTION from research: codex CLI can itself be exposed as an MCP server
  (`codex()` + `codex-reply()` tools) and orchestrated by the OpenAI Agents SDK. [S]

### F. Orchestrator tooling (only inside Claude Code)
- Task/Agent subagents (incl fork), Workflow, `codex:codex-rescue`. Background
  subagents can silently die on session pause (laptop sleep) — no recovery. [S]

## OpenAI Agents SDK vs Codex (disambiguation)
- Agents SDK (`openai-agents`) = framework to BUILD your own agent (generic).
  Responses API `background:true` = the async substrate under cloud.
- Codex SDK/CLI = INVOKE the prebuilt coding agent.
- They compose: Agents-SDK orchestrator → Codex-as-MCP-server for the coding work. [S]

## Open questions for the codex feedback pass
1. Is `codex exec-server` real/usable today, or still experimental scaffolding?
2. Does `openai-codex` (pip) actually pin+bundle the codex CLI, and what version?
3. `--bare`, `--json-schema`, `claude daemon status`, --bg worktree isolation:
   haiku single-source — real or hallucinated?
4. For OUR need (don't block the harness on a codex WRITE build): is the right
   substrate (a) stratum WRITE-DURABLE (local detached wrap), (b) codex exec-server,
   or (c) codex cloud? Trade-offs?
