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
10. **The owner's Devin config weakens `auto`.** `~/.config/devin/config.json` carries
    `permissions.allow: [Exec(sed), Exec(awk), Exec(find), Exec(xargs grep), …]`. Under `auto`,
    `sed -i '' 's/hello/EDITED/' target.txt` was **approved and edited the file**. With
    `--config <file with permissions.allow: []>` the same command was rejected. `--config` replaces
    `config.json` only: MCP servers were still listed with it. `XDG_CONFIG_HOME=<clean dir>` also
    drops the allow-list and keeps auth working, but still lists MCP servers (more of them — devin
    also imports servers from another source, unidentified).
11. **MCP:** the ambient servers (AgentMail, smartmemory, pycharm, memory, sequential-thinking, …)
    are visible in every mode. `mcp_call_tool` is **rejected under `auto`** and **approved under
    `--sandbox`** (a sequential-thinking call returned). Per-scope disable exists
    (`devin mcp disable -s local|project|user`, `.devin/mcp_config.local.json`).

## Equality principle (owner, 2026-09-26: "we want equality")

Devin gets exactly the capabilities and exactly the guarantees claude and codex get — nothing
removed, nothing added. Every decision below is checked against this:

- **Same guarantee per sandbox mode.** `read-only` must mean read-only for devin as it does for
  codex, so ambient config that silently weakens it (fact 10) is neutralised (D3).
- **Same ambient access.** Stratum does not disable MCP for claude or codex (the only related control
  is the `SMARTMEMORY_SCRUB_VARS` env scrub, `base.ts:16`, applied in `claude.ts:43`, `codex.ts:68`),
  so it does not disable MCP for devin. The owner's MCP servers stay reachable, exactly as for codex.
  If agent MCP access is ever restricted, that is one rule for all three agents, not a devin rule.
- **Same parameters.** Whatever `stratum_agent_run` / specs accept for codex (`model`, `effort`,
  `sandboxMode`, `networkAccess`, `writableRoots`) devin accepts with the same meaning. Where the
  devin mechanism is not yet verified the parameter fails closed with a named error, and closing that
  gap is part of this feature, not a follow-up (D3, D6).

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
devin --model <id> <mode flags (D3)> --config <stratum devin config (D3)>
      --respect-workspace-trust false
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
`accept-edits` cannot run a shell, so it cannot run tests.

**Stratum-owned devin config.** Every dispatch passes `--config <file>` pointing at a config stratum
writes (0600, in the run dir or a stratum-owned path): `{"version":1,"permissions":{"allow":[]},
"shell":{"setup_complete":true}}`, plus the D3 `Write(...)`/network entries below when requested. This
removes the owner's personal allow-list (fact 10) so `read-only` means read-only, and it does **not**
touch MCP (`--config` leaves `mcp_config.json` alone — fact 10), preserving equality of ambient
access. `setup_complete` suppresses the first-run banner seen on stdout with a bare config.
Not `XDG_CONFIG_HOME`: it would also drop the owner's devin MCP config, which codex runs keep.

**`networkAccess`, `writableRoots` (equality — in scope).** Codex supports both; devin must too.
`--sandbox` help: "commands can write only within the workspace and granted `Write(...)` scopes" —
so `writableRoots` maps to `Write(<root>)` entries in the stratum-owned config, and `networkAccess`
to whatever network rule the devin sandbox honours. **S1 starts with a probe** establishing (a) the
exact `Write(...)` grammar and that an extra root becomes writable, (b) whether `--sandbox` blocks
network by default and how to open it. Until a mapping is verified by that probe, the parameter
fails closed with a named error — never silently ignored (the D8 precedent, `runner.ts:69`).
`approvalPolicy` is a codex concept; a non-default value is rejected for devin, as for claude.

**MCP (equality).** Not disabled (see Equality principle). Consequence, stated plainly: under
`workspace-write` and `danger-full-access` a devin run can call the owner's MCP servers (fact 11),
the same exposure codex runs have today; under `read-only` MCP calls are rejected by devin's gate.

`workspace-write` under `--sandbox` rejects devin's own file-edit tool (fact 4). The run still edits
files through the shell. Owner accepted this (Q1).

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
- `resolveDevinModel(model?, effort?)` accepts the same shapes codex does (equality): a full id
  (`swe-2-high`), or a family plus `effort` (`model: "swe-2", effort: "high"` → `swe-2-high`), or the
  stratum slash form (`swe-2/high`). Default `swe-2-high` (owner Q3). Unknown ids, unknown
  effort for a family, or a full id plus a conflicting `effort` are rejected naming the valid set
  (STRAT-AGENT-RUN-MODEL-VALIDATE semantics). The family→effort table is derived from the pricing
  table ids, not hand-listed twice.
- Validation runs at the MCP boundary (`server.ts:191`, beside the codex branch), in `runAgent`, and
  in `startBackgroundRun` — same three layers codex has.
- `usage.tokens = total_prompt_tokens + total_completion_tokens`; `split` input/output/cached from
  `final_metrics`; `usd` = table price × tokens, `usdSource: "estimated"` (a free model reports
  `usd: 0`, estimated — it is a price-table fact, not a provider receipt).
- Telemetry `model` = the resolved id; `effort` = the resolved effort suffix (as codex reports it).

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
the agent is the implementer. Owner (Q2): no rules-disabling `--config` in v1; revisit only if a run is confused. (Was: whether to pass a `--config` that
disables always-on rules.)

## Out of scope (follow-ups)

- `COMP-AGENT-DEVIN-1` — Compose accepts `devin` (the five sites above), model tiers, routing ladder.
- ACP transport (streaming `onEvent` narration, structured permissions).
- Devin Cloud sessions.
- Judge tiers routed to devin (`judge/judged.ts`).
- Restricting agent MCP access — if ever wanted, one rule for all three agents (Equality principle).

## Tests (per testing.md hierarchy)

- **Golden (live, `*.live.test.ts`, real devin, free `swe-2-medium`):**
  1. read-only review: foreground `stratum_agent_run agent=devin` over the real MCP server returns
     the final agent message, usage tokens > 0, `usd: 0 estimated`, repo unchanged — **with an
     ambient devin config that allows `Exec(sed)`**, and a prompt instructing `sed -i` on a tracked
     file: the run must fail with a D4 rejection and the file must be unchanged (fact 10 regression).
  2. workspace-write: a flow whose step `agent: devin` edits a file in a worktree and the step
     succeeds; a write outside the worktree is denied; with `writableRoots: [<extra dir>]` a write
     there succeeds (once the S1 probe has verified the mapping).
  3. background: start → poll → completed result with the same fields; peer name has the devin prefix.
  4. cancel: a background devin run cancelled mid-flight leaves **no** surviving `devin`/`devin acp`
     process in its group.
- **Error harness (table-driven, no network — spawn seam feeding recorded ATIF fixtures):**
  rejection line ⇒ failed (D4); rejection only in ATIF ⇒ failed; missing export ⇒ failed; unknown
  model ⇒ boundary error naming valid ids; `swe-2`+`high`, `swe-2/high` and `swe-2-high` resolve to the
  same id; full id + conflicting effort ⇒ error; `danger-full-access` without opt-in ⇒ error; an
  unverified `networkAccess`/`writableRoots` mapping ⇒ named error; the argv always carries
  `--config` pointing at a stratum-owned file with an empty allow-list; unknown agent error lists all
  three.
- **Equality check (table-driven over `AGENT_TYPES`):** every parameter `stratum_agent_run` accepts
  for codex is accepted for devin or rejected with a named "not yet verified for devin" error — a
  new codex parameter that devin silently ignores fails this test.
- **Contract:** evaluator `route: "devin"` accepted by `evaluatorResultSchema`; IR accepts `agent: devin` and still rejects an
  unknown agent.
- Fixtures: real ATIF exports captured from the 2026-09-26 probes (scrub paths), not hand-written.

## Slices

1. **S1 core** — probe first (D3 `Write(...)` grammar, sandbox network default); then D1 agent list,
   D6 models/pricing/validation, D7 env, stratum-owned `--config`, `DevinConnector` foreground (D2,
   D3, D4, D5), runner + MCP wiring. Error harness + equality check + golden 1.
2. **S2 background** — D8. Goldens 3, 4.
3. **S3 engine/IR** — D9 incl. evaluator route. Contract tests + golden 2.

## Owner decisions (2026-09-26)

- **Q1 → OS sandbox.** `workspace-write` = `--sandbox`; edits go through the shell. `accept-edits`
  rejected (no shell ⇒ no tests).
- **Q2 → leave it, state the role.** No rules-disabling config in v1; implementer briefs say
  "you are the implementer" explicitly.
- **Q3 → `swe-2-high`** is the default model.
- **Design gate:** Devin SWE-2 reviews the design now; Codex reviews the implementation later
  (after the STRAT-LEARN Step 2 reviews). Devin implements (owner, 2026-09-26).
