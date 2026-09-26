# STRAT-AGENT-DEVIN-1 — Devin as a third agent, peer of claude and codex

**Status:** PLANNED · **Created:** 2026-09-26 · **Complexity:** M · **Branch:** `strat-agent-devin-1`
(worktree `.claude/worktrees/agent-devin`, based on `95e56cf` — the unmerged STRAT-LEARN branch tip,
because both touch `engine.ts` and the contracts)

**Revision 2 (2026-09-26):** after the Devin SWE-2 design review r1 (NOT CLEAN, 4 H + 1 M, all
confirmed — §Review r1) and two seatbelt probes (facts 12–13), D3 is redesigned: stratum wraps devin
in its **own** OS sandbox instead of using devin's permission modes. D5 is removed; D8 gets its own
branch; D11 (config) is new.

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
- Every hardcoded two-agent site (grep for `"claude" | "codex"`, `["claude", "codex"]`, `=== "codex"`),
  plus the sites review r1 found that branch on "codex vs everything else":

| Site | What |
|---|---|
| `ts/src/connectors/base.ts:18` | `type AgentType = "claude" \| "codex"` |
| `ts/src/connectors/runner.ts:12,62` | `VALID_AGENTS` + error text; dispatch branch |
| `ts/src/connectors/runner.ts:87` | `loadStratumConfig` only when `agent === "codex"` (→ D11) |
| `ts/src/connectors/runner.ts:126-129` | `thinking`/tool filters forwarded for claude only |
| `ts/src/connectors/runner.ts:167-190` | `validateAgentSettings`: `codex` vs **`else` = claude** (→ D1) |
| `ts/src/connectors/background.ts:138-142` | `resolveCodexBackgroundStrategy` (`STRATUM_CODEX_BG_STRATEGY`) |
| `ts/src/connectors/background.ts:157,167,457,483,552,652-653,698` | validation, dispatch, reattach/record parse, cost estimate |
| `ts/src/connectors/background.ts:207-209` | bg scrub keeps `OPENAI_API_KEY`, no `SMARTMEMORY_*` (codex path) |
| `ts/src/connectors/background.ts:220,273` | `peerName(model, runId, {label})` — no `agent`, defaults to codex prefix |
| `ts/src/connectors/background.ts:606-607` | cancel: `exitCode === 0 && !scan.error` ⇒ `already_complete` (→ D8) |
| `ts/src/connectors/foreground_registry.ts:87,199` | record type + parse guard |
| `ts/src/connectors/peer-registry.ts:26-32` | `peerName()` agent param + prefix |
| `ts/src/mcp/server.ts:188-195,234,350` | agent + model validation, registry casts |
| `ts/src/ir/schema.ts:41,65` | fan-out stage and step `agent` enums |
| `ts/src/engine/engine.ts:82` | evaluator `route` enum (documented in `ts/contracts/evaluator-result.json`, not loaded) |
| `ts/src/engine/engine.ts:175,207` | engine connector request types |
| `ts/src/engine/engine.ts:3858` | `defaultConnector` forwards `sandbox` for codex only |
| `ts/src/config/index.ts:25-28,117` | `STRATUM_CODEX_*` env layer, `STRATUM_CODEX_ALLOW_FULL_ACCESS` (→ D11) |

`ts/contracts/mcp-surface.json` types `agent` as `"string"` everywhere — **no MCP surface bump needed**.

Compose also hardcodes the pair (`lib/build.js:4153,4160`, `lib/agent-string.js:24`,
`lib/routing-ledger.js:268,287`, `lib/stratum-mcp-client.js:85`). Out of scope here (see §Out of scope).

## Verified facts (probes, 2026-09-26, devin 3000.10.35)

Each probe is **one run** on `swe-2-medium`; treat as measured-once, not proven. Probe scripts live in
the session scratchpad (`devin-perm-probe.sh`, `devin-allow-probe.sh`, `devin-mcp-probe.sh`,
`devin-sbx-edit-probe.sh`, `devin-seatbelt-probe.sh`, `devin-seatbelt-ro-probe.sh`).

1. **Non-interactive:** `devin --model <id> --permission-mode <m> --respect-workspace-trust false
   [--export <file>] (-p <prompt> | --prompt-file <f> -p)`. `-p` must come after flags when a
   positional prompt is used, else clap reads it as `[PATH]`. Print mode fails in an untrusted
   directory unless `--respect-workspace-trust false`.
2. **Exit code is 0 when a tool call was rejected and the run died.** A devin-service connection
   error (`"cognition.ai/errorKind": "unavailable"`, mid-run) exited **1** with no export.
3. **A rejected tool call ends the run.** stderr: `warning: rejected a tool call that requires
   confirmation. Running in non-interactive mode.` Sibling parallel calls are cancelled
   ("Tool call canceled because another tool call … was rejected"), no final answer is produced.
4. Devin's own permission matrix (single action per run):

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
12. **Devin's `--sandbox` covers the exec tool only** (`devin sandbox --help`: "Process sandboxing for
    the exec tool"). Under `--sandbox` the **edit tool is rejected whatever the config grants**:
    `allow: []`, `["Write(<ws>)"]`, `["Write(<ws>/**)"]`, `["Edit"]` — all four rejected, while
    `tool_definitions` still offers `edit`, `write`, `exec`, `request_scope`. A sandboxed devin that
    reaches for its edit tool once is dead (fact 3). (Review r1 H4.)
13. **Stratum-owned seatbelt works.** `sandbox-exec -f <profile> devin --permission-mode dangerous
    --config <stratum config> …` with a profile of `(allow default) (deny file-write*)` plus
    `(allow file-write* <ws> ~/.local/share/devin ~/.local/state/devin ~/.cache ~/.config/devin
    $TMPDIR /private/var/folders /dev/null /dev/tty /dev/ttys* /dev/fd/*)`:
    - **workspace-write:** edit tool changed `target.txt`; `touch <outside>` → `Operation not
      permitted`; the run continued and answered; zero rejections; auth + model traffic fine.
    - **read-only** (same profile without `<ws>`): `git -C <ws> log --oneline | head -1 && wc -l …`
      **succeeded** (rejected under `auto`, fact 5); edit tool → permission denied; `sed -i` →
      `Operation not permitted`; the run continued to its final line; file and `git status` unchanged.
    `/usr/bin/sandbox-exec` present; `bwrap` absent on this host.

## Equality principle (owner, 2026-09-26: "we want equality")

Devin gets exactly the capabilities and exactly the guarantees claude and codex get — nothing
removed, nothing added. Every decision below is checked against this:

- **Same guarantee per sandbox mode.** `read-only` / `workspace-write` mean what they mean for codex:
  an OS-enforced write boundary around **all** tools, not a model-side approval gate (D3).
- **Same ambient access.** Stratum does not disable MCP for claude or codex (the only related control
  is the `SMARTMEMORY_SCRUB_VARS` env scrub, `base.ts:16`, applied in `claude.ts:43`, `codex.ts:68`),
  so it does not disable MCP for devin. The owner's MCP servers stay reachable, exactly as for codex.
  If agent MCP access is ever restricted, that is one rule for all three agents, not a devin rule.
- **Same parameters.** Whatever `stratum_agent_run` / specs accept for codex (`model`, `effort`,
  `sandboxMode`, `networkAccess`, `writableRoots`) devin accepts with the same meaning; claude-only
  parameters (`thinking`, tool filters) are rejected for devin exactly as they are for codex. Where
  a meaning cannot be enforced for devin the gap is named, not hidden (D3 network).
- **Same config.** Project/user `stratum.toml [sandbox]` defaults govern devin as they govern codex (D11).

## Decisions

### D1 — One agent list, not N copies; no "else = claude"

Add `"devin"` to `AgentType` and export `AGENT_TYPES = ["claude","codex","devin"] as const` from
`connectors/base.ts`. `runner.ts`, `background.ts`, `foreground_registry.ts`, `mcp/server.ts` validate
against it and generate their error text from it. (The comment at `runner.ts:10` keeps runner and
background mutually independent; both already import `base.js` (`runner.ts:1`, `background.ts:10-11`),
so that intent survives. `foreground_registry.ts` gains a type-only import of `base.js`.) The IR
enums (`ir/schema.ts:41,65`) and the evaluator `route` enum use `z.enum(AGENT_TYPES)`.

**Every agent branch becomes an exhaustive switch** — no `if codex … else` that silently treats a
third agent as claude (review r1 H1: `validateAgentSettings`'s `else` would validate devin `effort`
against claude's list and then drop it; runner.ts:126-129 would drop `thinking`/tool filters). A
`never`-typed default makes the next agent a compile error. For devin, `validateAgentSettings`
rejects `thinking`/`allowedTools`/`disallowedTools` with the same wording codex uses, validates
`effort` via D6, and names "devin" in every error.
**Why:** `base.ts` says of the scrub list, "the failure mode of this control is a third connector
that forgets it" — the same holds for every agent switch, and this is that third connector.

### D2 — Transport: `devin -p` subprocess inside the stratum sandbox, result from the ATIF export

New `connectors/devin.ts` with `DevinConnector` mirroring `CodexConnector`'s option shape (cwd,
model, signal, ownProcessGroup, onSpawn, env, sandboxMode, writableRoots, spawn seam, onEvent). Argv:

```
[sandbox-exec -f <runDir>/devin.sb]          # omitted only for danger-full-access (D3)
devin --model <id> --permission-mode dangerous --config <runDir>/devin-config.json
      --respect-workspace-trust false
      --export <runDir>/trajectory.json --prompt-file <runDir>/prompt.md -p
```

`runDir` is a 0700 per-run directory (the background run dir, or a foreground temp dir removed after
the result is read). stdin `/dev/null` (a CLI that reads stdin stalls otherwise — same landmine as
codex exec). Prompt goes through a 0600 file, never argv (prompts are private, and argv is visible in
`ps`). The result text and usage are read from the export (fact 6); stdout/stderr are kept only as the
narration stream. Missing/unparseable export, or no agent step ⇒ failure
`devin produced no trajectory: <stderr tail>` (never an empty success) — this also covers the
connection-error exit 1 (fact 2).

ACP (`devin acp`) would give streaming events and is the better long-term transport; deferred
(§Out of scope) because print mode is enough to be a correct peer and ACP is a protocol client.

### D3 — Sandbox: stratum-owned OS sandbox around the whole devin process (revised r2)

Devin's own modes cannot give codex-equal guarantees: `auto` is a model-side approval gate that kills
the run on the first rejected call and is weakened by ambient allow-lists (facts 3, 5, 10); `--sandbox`
covers exec only and rejects the edit tool (fact 12); `smart` escaped the workspace (fact 4). So
stratum **always runs devin with `--permission-mode dangerous` and supplies the boundary itself**,
the way codex's own seatbelt bounds codex's tools (fact 13).

| stratum `sandboxMode` | wrapper | writable |
|---|---|---|
| `read-only` (default) | `sandbox-exec -f devin.sb` | devin state only (below) |
| `workspace-write` | `sandbox-exec -f devin.sb` | devin state + `cwd` + each `writableRoots` entry |
| `danger-full-access` | none | everything; opt-in only via `STRATUM_DEVIN_ALLOW_FULL_ACCESS=1` (mirrors `assertCodexSandboxAllowed`; D11) |

**Profile** (generated per run, 0600): `(version 1) (allow default) (deny file-write*)
(allow file-write* …)` with `subpath` entries for the writable set and devin's state:
`~/.local/share/devin`, `~/.local/state/devin`, `~/.config/devin`, `~/.cache`, the resolved
`$TMPDIR`, `/private/var/folders`, the run dir, and `literal`/`regex` entries for `/dev/null`,
`/dev/tty`, `/dev/ttys*`, `/dev/fd/*` (fact 13). Paths are realpath-resolved before emission
(macOS `/tmp`→`/private/tmp` firmlinks) and quoted with seatbelt string escaping; a path containing a
character the escaper cannot represent is rejected, never emitted raw. **S1 tightens the state set**
by probing which of those subpaths devin actually writes, and the golden asserts a write outside it
fails.

- **Writes fail as EPERM, the run continues** (fact 13), so read-only no longer needs a command
  discipline and no longer dies on `git -C` or pipes. Former D5 (read-only preamble) is **removed**.
- **`writableRoots`** maps to extra `subpath` entries — enforced by the OS, verified in the golden.
- **Ambient devin allow-lists are moot**: under `dangerous` everything is approved and the OS decides.
  `--config` still points at a stratum-owned file (`{"version":1,"permissions":{"allow":[]},
  "shell":{"setup_complete":true}}`) so the owner's personal devin config cannot change behaviour and
  the first-run banner never reaches stdout. `--config` leaves MCP config alone (fact 10).
- **Network (named equality gap).** Devin's model traffic originates in the sandboxed devin process
  itself, so the profile cannot deny network to devin's tools without cutting devin off from its own
  model. Devin therefore has network in every mode — the same as claude today, unlike codex's
  `networkAccess: false` default. `networkAccess: true` is accepted; an **explicit** dispatch-level
  `networkAccess: false` for devin is rejected with a named error (`devin cannot run without network;
  networkAccess:false is not enforceable for devin`). The resolved *default* `false` from D11 is not
  an explicit request and does not fail the dispatch. Stated in the equality section of the report.
- **MCP (equality).** Not disabled. MCP servers devin spawns inherit the profile (their local writes
  are bounded too); HTTP MCP servers (AgentMail) are reachable in every mode, as for codex.
- **Platforms.** macOS only in v1 (`/usr/bin/sandbox-exec`). On Linux (no verified bwrap mapping —
  bwrap absent on the build host) `read-only`/`workspace-write` fail closed with a named error;
  `danger-full-access` (opt-in) works. A Linux profile is a follow-up.
- **Nesting.** Seatbelt does not nest (memory `project_codex_seatbelt_nonnesting`): a devin launched
  from inside a codex sandbox fails at `sandbox-exec`. The connector surfaces the stderr verbatim.
- `smart`, `accept-edits`, `auto` and devin's `--sandbox` are **never** emitted.

### D4 — A rejected tool call is a failure, never a success (defence in depth)

Under D3 devin runs `dangerous`, so no rejection is expected. If one still appears (a future CLI that
gates something under `dangerous`), exit 0 is not trusted (fact 2): the run is `failed` with reason
`devin rejected a tool call: <command head>` when the stderr line
`rejected a tool call that requires confirmation` appears or an ATIF observation result reads
`Tool execution was rejected by the user` (matched on the observation of the call, not on arbitrary
file content that happens to contain the word). The engine retries with that reason as
`previousFailure` feedback.

### D5 — *(removed in r2: read-only preamble made unnecessary by D3)*

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
"DEVIN_MODEL","DEVIN_PERMISSION_MODE","DEVIN_SANDBOX", ...SMARTMEMORY_SCRUB_VARS]`, applied on the
foreground **and** background paths (the codex background scrub at `background.ts:207-209` is
narrower and is not reused — review r1 H2). Devin authenticates from its own credentials file
(`devin auth status` → `~/.local/share/devin/credentials.toml`), so no provider key is needed. Apply
`applyHeadlessShellEnv` as codex does.

### D8 — Background runs, registries, peers (revised r2)

The codex background block is **not** reused (review r1 H2: it bundles
`resolveCodexBackgroundStrategy`, `assertCodexSandboxAllowed`, `resolveCodexModel`, `codexCommand`,
the codex GUI preamble, the codex scrub and agent-less `peerName` calls). `startBackgroundRun` gets an
explicit `devin` case (D1 switch) that shares only agent-neutral primitives — `newRunDir`, the
detached own-process-group spawn, `.err`/`.in` files, the exit sentinel, registry entry — and uses
D2's argv, D3's profile, D6's model, D7's scrub, and `STRATUM_DEVIN_ALLOW_FULL_ACCESS`.
`STRATUM_CODEX_BG_STRATEGY` never applies to devin.

- **Result/poll/reattach** read the export in the run dir once the process has exited; stdout is the
  narration stream. The cost estimate at `background.ts:698` extends to devin via D6.
- **Terminal status** is derived from the export, not the exit code: exit 0 + a valid export with a
  final agent message = `completed`; anything else (no export, D4 rejection, non-zero exit) = error.
  **Cancel** uses the same derivation — a devin run that died with exit 0 and no valid export returns
  `already_error`, not `already_complete` (review r1 M5, `background.ts:606-607`).
- `foreground_registry` and the background record parser accept `"devin"` (with a `childPid` like
  codex). **Every** `peerName()` call passes `agent` explicitly (the two agent-less calls at
  `background.ts:220,273` are fixed for codex too, since `pollBackgroundRun` at `:463` already passes
  `meta.agent` and start-vs-poll names must agree). Devin prefix: `devin-<short>-<runId6>`, short = the
  model id minus `swe-2-` (e.g. `devin-high-3f9a2c`).

Cancellation: SIGTERM the group, SIGKILL after the grace period, as codex. `devin -p` runs its agent
in a `devin acp` child; `ps -eo pid,ppid,pgid` on 2026-09-26 showed that child in its parent's
process group (e.g. `devin` 24587 → `devin acp` 24589, both pgid 24583), so a group kill reaches it.
With the `sandbox-exec` wrapper, `sandbox-exec` execs devin in place (same pid) — verified in S2, not
assumed. Still **verified by a test** (§Tests), since the child could daemonize in a later CLI.

### D9 — Engine and IR

- `ir/schema.ts` step and fan-out stage `agent` accept `devin` (via D1).
- `engine.ts:3858`: forward `sandbox` for any agent that supports a sandbox mode (codex, devin), not
  codex only — a worktree-isolated devin stage must be able to write its worktree. Claude and codex
  behaviour is unchanged (claude still receives no `sandboxMode`; codex unchanged).
- Evaluator `route` accepts `devin`: the enforcing schema is `evaluatorResultSchema` in `engine.ts:82`.
  `ts/contracts/evaluator-result.json` is documentation only (its `_note`: "this file is
  documentation, not a loaded schema") — update its `route` text to list `devin`; no version bump.
- `dispatch: consumer` fan-outs hand items to Compose, which rejects `devin` today
  (`compose/lib/build.js:4153`) — fail-closed, correct until the Compose follow-up lands. The
  stratum side does not special-case it.

### D10 — Claude rules leak into Devin runs (fact 7)

v1 documents it and does not fight it. For implementer dispatches the brief states explicitly that
the agent is the implementer. Owner (Q2): no rules-disabling `--config` in v1; revisit only if a run
is confused.

### D11 — Config resolution (new in r2, review r1 H3)

Devin resolves its sandbox policy through `loadStratumConfig` like codex (equality: a project's
`stratum.toml [sandbox]` defaults govern every sandbox-capable agent), with an `agent` option so the
**env layer is agent-named**: codex reads `STRATUM_CODEX_*` (unchanged), devin reads none of them —
`STRATUM_CODEX_SANDBOX_MODE=danger-full-access` in the server env must never escalate devin. Devin's
full-access authorisation is `STRATUM_DEVIN_ALLOW_FULL_ACCESS`. Of the resolved values: `filesystemMode`
and `writableRoots` apply (D3); `networkAccess` follows D3's network rule (only an explicit dispatch
`false` fails); `approvalPolicy` is a codex approval concept — a config-file value is ignored for
devin (it cannot fail every devin dispatch in a repo that is fine for codex), while an explicit
dispatch-level `approvalPolicy` for devin is rejected, as for claude. Provenance (`sandboxAudit`) is
recorded for devin exactly as for codex. `runner.ts:87`'s `agent === "codex"` becomes the D1 switch.

## Out of scope (follow-ups)

- `COMP-AGENT-DEVIN-1` — Compose accepts `devin` (the five sites above), model tiers, routing ladder.
- ACP transport (streaming `onEvent` narration, structured permissions).
- Linux sandbox profile (bwrap) for devin.
- Devin Cloud sessions.
- Judge tiers routed to devin (`judge/judged.ts`).
- Restricting agent MCP access — if ever wanted, one rule for all three agents (Equality principle).

## Tests (per testing.md hierarchy)

- **Golden (live, `*.live.test.ts`, real devin, free `swe-2-medium`, macOS):**
  1. read-only review: foreground `stratum_agent_run agent=devin` over the real MCP server returns
     the final agent message, usage tokens > 0, `usd: 0 estimated`. The prompt also asks for a
     chained read (`git -C <cwd> log | head -1 && wc -l <file>`) — it must succeed — and for
     `sed -i` plus an edit-tool edit on a tracked file — both must fail and **`git status` is clean**,
     **with an ambient devin config that allows `Exec(sed)`** (fact 10 regression).
  2. workspace-write: a flow whose step `agent: devin` edits a file in its worktree **with the edit
     tool** and succeeds; a write outside the worktree fails (file absent); with
     `writableRoots: [<extra dir>]` a write there succeeds; a write into `~` outside the state set fails.
  3. background: start → poll → completed result with the same fields; start and poll report the
     same `devin-…` peer name.
  4. cancel: a background devin run cancelled mid-flight leaves **no** surviving `sandbox-exec`/
     `devin`/`devin acp` process in its group.
- **Error harness (table-driven, no network — spawn seam feeding recorded ATIF fixtures):**
  rejection line ⇒ failed (D4); rejection only in ATIF ⇒ failed; the word "rejected" inside a
  file-view observation ⇒ **not** a rejection; missing export ⇒ failed; exit 1 + no export ⇒ failed
  with stderr tail; cancel of an exited-0-no-export run ⇒ `already_error`; unknown model ⇒ boundary
  error naming valid ids; `swe-2`+`high`, `swe-2/high` and `swe-2-high` resolve to the same id; full
  id + conflicting effort ⇒ error; `thinking`/tool filters for devin ⇒ error naming devin;
  `danger-full-access` without `STRATUM_DEVIN_ALLOW_FULL_ACCESS` ⇒ error, and
  `STRATUM_CODEX_ALLOW_FULL_ACCESS=1` alone does **not** authorise devin; `STRATUM_CODEX_SANDBOX_MODE`
  does not change devin's mode; a project `stratum.toml` with `approvalPolicy` set does not fail a
  devin dispatch; explicit `networkAccess:false` ⇒ named error; Linux ⇒ named error for
  read-only/workspace-write; the argv always carries `--permission-mode dangerous` and `--config`
  pointing at the stratum-owned file, and (except full access) is prefixed by `sandbox-exec -f`;
  the generated profile contains `cwd` only for workspace-write, each `writableRoots` entry, and
  rejects an unescapable path; unknown agent error lists all three.
- **Equality check (table-driven over `AGENT_TYPES`):** every parameter `stratum_agent_run` accepts
  for codex is accepted for devin or rejected with a named devin error — a new codex parameter that
  devin silently ignores fails this test. Every agent switch is exhaustive (compile-time `never`).
- **Contract:** evaluator `route: "devin"` accepted by `evaluatorResultSchema`; IR accepts
  `agent: devin` and still rejects an unknown agent.
- Fixtures: real ATIF exports captured from the 2026-09-26 probes (scrub paths), not hand-written.

## Slices

1. **S1 core** — probe first (tighten D3's devin state set: which subpaths devin actually writes);
   then D1 agent list + exhaustive switches, D6 models/pricing/validation, D7 env, D11 config,
   D3 profile generator + `--config`, `DevinConnector` foreground (D2, D3, D4), runner + MCP wiring.
   Error harness + equality check + golden 1.
2. **S2 background** — D8 (own branch, export-derived status, cancel, peer names incl. the codex
   agent-less `peerName` fix). Goldens 3, 4.
3. **S3 engine/IR** — D9 incl. evaluator route. Contract tests + golden 2.

## Owner decisions (2026-09-26)

- **Q1 → OS sandbox.** Owner chose the OS-enforced boundary over devin's `accept-edits` (no shell ⇒
  no tests). r2 keeps that choice and changes the mechanism: the OS sandbox is now stratum's
  seatbelt around the whole process (D3), which also lets devin's edit tool work — the "edits via
  shell" restriction is gone.
- **Q2 → leave it, state the role.** No rules-disabling config in v1; implementer briefs say
  "you are the implementer" explicitly.
- **Q3 → `swe-2-high`** is the default model.
- **Equality** ("we want equality"): see §Equality principle.
- **Design gate:** Devin SWE-2 reviews the design; Codex reviews the implementation later
  (after the STRAT-LEARN Step 2 reviews). Devin implements (owner, 2026-09-26).

## Review r1 (Devin SWE-2 High, 2026-09-26) — NOT CLEAN; run died mid-finding 5 on a devin-service
connection error (exit 1). All five findings confirmed against source by Claude:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| H1 | H | `validateAgentSettings` `else` = claude; devin `effort` validated as claude then dropped; claude-only options silently dropped | D1 exhaustive switches |
| H2 | H | codex bg block not separable (strategy, full-access env, model, argv, preamble, narrow scrub, agent-less `peerName` at `background.ts:220,273`) | D8 own branch; D7 scrub on both paths |
| H3 | H | design silent on `loadStratumConfig` for devin; codex env/config could escalate or fail every devin run | D11 |
| H4 | H | workspace-write "edits via shell" unverified; edit tool dead under `--sandbox` | confirmed by fact 12; D3 redesigned (fact 13) |
| M5 | M | cancel reports a dead devin run `already_complete` (`background.ts:606-607`) | D8 export-derived status |
