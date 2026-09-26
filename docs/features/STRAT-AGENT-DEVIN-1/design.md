# STRAT-AGENT-DEVIN-1 — Devin as a third agent, peer of claude and codex

**Status:** PLANNED · **Created:** 2026-09-26 · **Complexity:** M · **Branch:** `strat-agent-devin-1`
(worktree `.claude/worktrees/agent-devin`, based on `95e56cf` — the unmerged STRAT-LEARN branch tip,
because both touch `engine.ts` and the contracts)

## Related Documents

- `docs/features/STRAT-AGENT-RUN-MODEL-VALIDATE/design.md` — boundary model validation this extends
- `docs/features/STRAT-AGENT-BG/design.md`, `STRAT-AGENT-BG-WRITE-1` — background runs + sandbox modes
- `docs/features/STRAT-AGENT-PEER-1/design.md` — peer naming / registry
- `plan.md` (to be written after the design gate)

## Why

The owner has a Devin CLI (`~/.local/bin/devin`, v3000.10.35) on the account with a **free** model
family, SWE-2 (`swe-2-medium|high|max`, 262K context). It was used by hand on 2026-09-26 to run the
four STRAT-LEARN reviews while Codex credits were out. Owner decision (2026-09-26): make Devin a
**full peer** — dispatchable by `stratum_agent_run` (foreground and background) and nameable as a
step/stage `agent:` in specs and as an evaluator `route`.

## Prior art checked (2026-09-26)

- `grep -rliE 'devin|opencode|gemini' ts/src` → nothing. No third-agent support exists.
- `ls docs/features | grep -iE 'connector|agent|devin'` → STRAT-AGENT-{BG,BG-MONITOR,BG-WRITE-1,INTERP,
  INTERP-TS,PEER-1..3,RUN-MODEL-VALIDATE}. None generalises the agent set; all assume two.
- Every hardcoded two-agent site (grep for `"claude" | "codex"`, `["claude", "codex"]`, `=== "codex"`):

| Site | What |
|---|---|
| `ts/src/connectors/base.ts:18` | `type AgentType = "claude" \| "codex"` |
| `ts/src/connectors/runner.ts:12,62` | `VALID_AGENTS` + error text; dispatch branch |
| `ts/src/connectors/background.ts:157,167,457,483,552,652-653,698` | validation, dispatch, reattach/record parse, cost estimate |
| `ts/src/connectors/foreground_registry.ts:87,199` | record type + parse guard |
| `ts/src/connectors/peer-registry.ts:26-32` | `peerName()` agent param + prefix |
| `ts/src/mcp/server.ts:188-195,234,350` | agent + model validation, registry casts |
| `ts/src/ir/schema.ts:41,65` | fan-out stage and step `agent` enums |
| `ts/src/engine/engine.ts:82` | evaluator `route` enum (documented in `ts/contracts/evaluator-result.json`, not loaded) |
| `ts/src/engine/engine.ts:175,207` | engine connector request types |
| `ts/src/engine/engine.ts:3858` | `defaultConnector` forwards `sandbox` for codex only |

`ts/contracts/mcp-surface.json` types `agent` as `"string"` everywhere — **no MCP surface bump needed**.

Compose also hardcodes the pair (`lib/build.js:4153,4160`, `lib/agent-string.js:24`,
`lib/routing-ledger.js:268,287`, `lib/stratum-mcp-client.js:85`). Out of scope here (see §Out of scope).

## Verified facts (probes, 2026-09-26, devin 3000.10.35)

Each probe is **one run** on `swe-2-medium`; treat as measured-once, not proven. Probe scripts:
session scratchpad `devin-perm-probe.sh`.

1. **Non-interactive:** `devin --model <id> --permission-mode <m> --respect-workspace-trust false
   [--export <file>] (-p <prompt> | --prompt-file <f> -p)`. `-p` must come after flags when a
   positional prompt is used, else clap reads it as `[PATH]`. Print mode fails in an untrusted
   directory unless `--respect-workspace-trust false`.
2. **Exit code is always 0** — including when a tool call was rejected and the run died.
3. **A rejected tool call ends the run.** stderr: `warning: rejected a tool call that requires
   confirmation. Running in non-interactive mode.` Sibling parallel calls are cancelled
   ("Tool call canceled because another tool call … was rejected"), no final answer is produced.
4. Permission matrix (single action per run):

   | mode | file-edit tool | shell write in cwd | shell write outside cwd |
   |---|---|---|---|
   | `auto` (default) | rejected | rejected | rejected |
   | `accept-edits` | allowed | rejected | rejected |
   | `smart` | allowed | allowed | **allowed** (rejected in an earlier combined probe — nondeterministic) |
   | `--sandbox` (forces "autonomous", ignores `--permission-mode`) | **rejected** | allowed | denied by OS, silently (no rejection line) |

5. **`auto` read-only is fragile for reads too:** `git -C <path> show --stat <sha>` was rejected;
   `git log … && git show … | head` was rejected. Plain `git show <sha>` from cwd passes.
   With the review brief alone, 1 of 4 reviews died on its first command; the retry died on `git -C`.
   A second review ran 35 steps (1.77M cumulative prompt tokens) and then died on its final step,
   `cd <ts> && python3 -c "…json.load(…)…"` — the whole review was lost with no verdict.
6. **`--export <file>`** writes an ATIF-v1.7 JSON trajectory (despite any `.md` name) **at the end of
   the run** (not incrementally in `-p` mode — no file existed for 3 in-flight runs). Top level:
   `schema_version, session_id, agent{name,version,model_name,tool_definitions}, steps[],
   final_metrics{total_prompt_tokens,total_completion_tokens,total_cached_tokens,total_steps}`.
   Steps carry `source ∈ {system,user,agent}`, `message`, and for agent steps `tool_calls`,
   `observation.results[{source_call_id,content}]`, `metrics{prompt_tokens,completion_tokens,
   cached_tokens}`. **Final answer = `message` of the last `source:"agent"` step.**
   Plain stdout concatenates every agent message without separators — unusable as the result text.
7. **Devin injects the owner's Claude config as always-on rules**: step 5 of the system prompt is
   `<rules type="always-on"><rule name="CLAUDE" path="~/.claude/CLAUDE.md">…` plus
   `<available_skills>`. A Devin run therefore reads "Claude does not write code" and similar.
8. `devin models list` lists ids with prices; SWE-2 shows `Free`. Other families (Opus 5.5,
   Sonnet 5, GLM, Kimi, Gemini…) are billed by Devin at listed per-MTok prices.
9. `devin acp` exists (Agent Client Protocol over stdio; `--agent-type review` = read-only +
   shell tools). Not used in v1.

## Decisions

### D1 — One agent list, not N copies

Add `"devin"` to `AgentType` and export `AGENT_TYPES = ["claude","codex","devin"] as const` from
`connectors/base.ts`. `runner.ts`, `background.ts`, `foreground_registry.ts`, `mcp/server.ts` validate
against it and generate their error text from it. (The comment at `runner.ts:10` keeps runner and
background mutually independent; both already import `base.js` (`runner.ts:1`, `background.ts:10-11`),
so that intent survives. `foreground_registry.ts` gains a type-only import of `base.js`.) The IR
enums (`ir/schema.ts:41,65`) and the evaluator `route` enum use `z.enum(AGENT_TYPES)`.
**Why:** `base.ts` says of the scrub list, "the failure mode of this control is a third connector
that forgets it" — the same holds for the agent list, and this is that third connector.

### D2 — Transport: `devin -p` subprocess, result from the ATIF export

New `connectors/devin.ts` with `DevinConnector` mirroring `CodexConnector`'s option shape (cwd,
model, signal, ownProcessGroup, onSpawn, env, sandboxMode, spawn seam, onEvent). Argv:

```
devin --model <id> <mode flags (D3)> --respect-workspace-trust false
      --export <runDir|tmp>/trajectory.json --prompt-file <runDir|tmp>/prompt.md -p
```

stdin `/dev/null` (a CLI that reads stdin stalls otherwise — same landmine as codex exec). Prompt
goes through a 0600 file, never argv (prompts are private, and argv is visible in `ps`). The result
text, usage and rejections are read from the export (fact 6); stdout/stderr are kept only as the
narration stream and for the rejection line. Missing/unparseable export, or no agent step ⇒
failure `devin produced no trajectory` (never an empty success).

ACP (`devin acp`) would give streaming events and is the better long-term transport; deferred
(§Out of scope) because print mode is enough to be a correct peer and ACP is a protocol client.

### D3 — Sandbox mapping (reuse `CodexSandboxMode`; default `read-only`)

| stratum `sandboxMode` | devin flags | enforcement |
|---|---|---|
| `read-only` (default) | `--permission-mode auto` | devin's tool gate; every write rejected (fact 4) |
| `workspace-write` | `--sandbox` | macOS seatbelt / Linux bwrap; outside-cwd writes denied by OS |
| `danger-full-access` | `--permission-mode dangerous` | none; opt-in only via `STRATUM_DEVIN_ALLOW_FULL_ACCESS=1` (mirrors `assertCodexSandboxAllowed`) |

`smart` and `accept-edits` are **never** emitted: `smart` wrote outside the workspace (fact 4) and
`accept-edits` cannot run a shell, so it cannot run tests. `networkAccess`, `writableRoots` and a
non-default `approvalPolicy` are **rejected** for devin with a named error (fail closed) until they
have a verified mapping — silently ignoring them would be a false guarantee (the D8 precedent for
claude read-only, `runner.ts:69`).

`workspace-write` under `--sandbox` rejects devin's own file-edit tool (fact 4). The run still edits
files through the shell. **Open question Q1** decides whether that is acceptable.

Seatbelt does not nest (memory `project_codex_seatbelt_nonnesting`): a `workspace-write` devin
launched from inside a codex sandbox will fail at spawn. The connector surfaces devin's stderr
verbatim in the failure; no special handling in v1.

### D4 — A rejected tool call is a failure, never a success

Exit 0 is not trusted (fact 2). The run is `failed` with reason
`devin rejected a tool call under <mode>: <command head>` when either the stderr line
`rejected a tool call that requires confirmation` appears, or any ATIF observation result reads
`Tool execution was rejected by the user`. The command head comes from the matching `tool_calls`
entry. This turns fact 3's silent death into a structured failure the engine can retry with
`previousFailure` feedback (engine retries already append the failure reason to the prompt).

### D5 — Read-only tool-discipline preamble

For `read-only`, prepend (like `withSandboxPreamble`) a `[devin read-only constraints]` block:
one plain command per call; no `&&`, `;`, `|`, `$(…)`, backticks or redirects; never `git -C`
(cwd is the repo); prefer file-read/search tools. Measured need: fact 5. Idempotent (skip if the
prompt already starts with the block). Not added for `workspace-write`/`danger-full-access`.

### D6 — Models, effort, pricing

- `DEVIN_MODEL_PRICING` in `judge/pricing.ts`: id → `{input, output, cacheRead}` $/MTok, seeded from
  `devin models list` on 2026-09-26: `swe-2-medium|high|max` = 0/0/0, plus the Opus 5.5 and
  Sonnet 5 rows as listed. Kept separate from `MODEL_PRICING` so codex's allowlist
  (`dispatchableModels()`) is unchanged.
- `resolveDevinModel(model?, effort?)`: default `swe-2-high`; reject unknown ids naming the valid
  set (STRAT-AGENT-RUN-MODEL-VALIDATE semantics). Devin encodes effort in the id, so `effort` is
  **rejected** for devin with "put the effort in the model id (e.g. swe-2-max)".
- Validation runs at the MCP boundary (`server.ts:191`, beside the codex branch), in `runAgent`, and
  in `startBackgroundRun` — same three layers codex has.
- `usage.tokens = total_prompt_tokens + total_completion_tokens`; `split` input/output/cached from
  `final_metrics`; `usd` = table price × tokens, `usdSource: "estimated"` (a free model reports
  `usd: 0`, estimated — it is a price-table fact, not a provider receipt).
- Telemetry `model` = the resolved id; `effort` omitted.

### D7 — Environment

`DEVIN_SCRUB_VARS = ["ANTHROPIC_API_KEY","CLAUDE_API_KEY","CLAUDECODE","OPENAI_API_KEY",
...SMARTMEMORY_SCRUB_VARS]`. Devin authenticates from its own credentials file
(`devin auth status` → `~/.local/share/devin/credentials.toml`), so no provider key is needed. Apply
`applyHeadlessShellEnv` as codex does. `DEVIN_MODEL` / `DEVIN_PERMISSION_MODE` / `DEVIN_SANDBOX` are
also scrubbed so the ambient env cannot override D3's flags.

### D8 — Background runs, registries, peers

`startBackgroundRun` gains a devin branch that reuses the codex **exec** detached-process path
(own process group, `stream.jsonl` = stdout, `.err`, `.in` = prompt file) with the argv from D2 and
the export written into the run dir. Poll/reattach reads the export once the process has exited;
cost estimate at `background.ts:698` extends to devin. `foreground_registry` and the background
record parser accept `"devin"` (with a `childPid` like codex). `peerName()` gains the devin prefix
(`devin-<short>-<runId6>`, short = model id minus `swe-2-` → e.g. `devin-high-3f9a2c`).

Cancellation: SIGTERM the group, SIGKILL after the grace period, as codex. `devin -p` runs its agent
in a `devin acp` child; `ps -eo pid,ppid,pgid` on 2026-09-26 showed that child in its parent's
process group (e.g. `devin` 24587 → `devin acp` 24589, both pgid 24583), so a group kill reaches it.
Still **verified by a test, not assumed** (§Tests), since the child could daemonize in a later CLI.

### D9 — Engine and IR

- `ir/schema.ts` step and fan-out stage `agent` accept `devin` (via D1).
- `engine.ts:3858`: forward `sandbox` for any agent that supports a sandbox mode (codex, devin), not
  codex only — a worktree-isolated devin stage must be able to write its worktree.
- Evaluator `route` accepts `devin`: the enforcing schema is `evaluatorResultSchema` in `engine.ts:82`.
  `ts/contracts/evaluator-result.json` is documentation only (its `_note`: "this file is
  documentation, not a loaded schema") — update its `route` text to list `devin`; no version bump.
- `dispatch: consumer` fan-outs hand items to Compose, which rejects `devin` today
  (`compose/lib/build.js:4153`) — fail-closed, correct until the Compose follow-up lands. The
  stratum side does not special-case it.

### D10 — Claude rules leak into Devin runs (fact 7)

v1 documents it and does not fight it. For implementer dispatches the brief states explicitly that
the agent is the implementer. **Open question Q2** covers whether to pass a `--config` that
disables always-on rules.

## Out of scope (follow-ups)

- `COMP-AGENT-DEVIN-1` — Compose accepts `devin` (the five sites above), model tiers, routing ladder.
- ACP transport (streaming `onEvent` narration, structured permissions).
- Devin Cloud sessions.
- Judge tiers routed to devin (`judge/judged.ts`).
- `networkAccess`/`writableRoots` mapping (needs a verified Devin `Write(...)` scope mechanism).

## Tests (per testing.md hierarchy)

- **Golden (live, `*.live.test.ts`, real devin, free `swe-2-medium`):**
  1. read-only review: foreground `stratum_agent_run agent=devin` over the real MCP server returns
     the final agent message, usage tokens > 0, `usd: 0 estimated`, repo unchanged.
  2. workspace-write: a flow whose step `agent: devin` edits a file in a worktree and the step
     succeeds; a write outside the worktree is denied.
  3. background: start → poll → completed result with the same fields; peer name has the devin prefix.
  4. cancel: a background devin run cancelled mid-flight leaves **no** surviving `devin`/`devin acp`
     process in its group.
- **Error harness (table-driven, no network — spawn seam feeding recorded ATIF fixtures):**
  rejection line ⇒ failed (D4); rejection only in ATIF ⇒ failed; missing export ⇒ failed; unknown
  model ⇒ boundary error naming valid ids; `effort` passed ⇒ error; `danger-full-access` without
  opt-in ⇒ error; `networkAccess`/`writableRoots` ⇒ error; unknown agent error lists all three.
- **Contract:** evaluator `route: "devin"` accepted by `evaluatorResultSchema`; IR accepts `agent: devin` and still rejects an
  unknown agent.
- Fixtures: real ATIF exports captured from the 2026-09-26 probes (scrub paths), not hand-written.

## Slices

1. **S1 core** — D1 agent list, D6 models/pricing/validation, D7 env, `DevinConnector` foreground (D2,
   D3, D4, D5), runner + MCP wiring. Error harness + golden 1.
2. **S2 background** — D8. Goldens 3, 4.
3. **S3 engine/IR** — D9 incl. evaluator route. Contract tests + golden 2.

## Open questions (owner)

- **Q1** — `workspace-write` via `--sandbox` blocks devin's file-edit tool, so edits go through the
  shell. Accept that (recommended; the OS sandbox is the only mode with a real boundary), or use
  `accept-edits` (edit tool works, but no shell at all, so no tests can run)?
- **Q2** — Devin loads `~/.claude/CLAUDE.md` and the global rules into every run. Leave it (v1
  recommendation) or find/pass a config that disables always-on rules for stratum dispatches?
- **Q3** — Default model `swe-2-high` (free). OK, or `swe-2-max`?
