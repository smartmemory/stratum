# STRAT-AGENT-DEVIN-1 — Devin as a third agent, peer of claude and codex

**Status:** PLANNED · **Created:** 2026-09-26 · **Complexity:** M · **Branch:** `strat-agent-devin-1`
(worktree `.claude/worktrees/agent-devin`, based on `95e56cf` — the unmerged STRAT-LEARN branch tip,
because both touch `engine.ts` and the contracts)

**Revision 2 (2026-09-26):** after the Devin SWE-2 design review r1 (NOT CLEAN, 4 H + 1 M, all
confirmed — §Review r1) and two seatbelt probes (facts 12–13), D3 is redesigned: stratum wraps devin
in its **own** OS sandbox instead of using devin's permission modes. D5 is removed; D8 gets its own
branch; D11 (config) is new.

**Revision 3 (2026-09-26):** after review r2 (NOT CLEAN, 2 H + 2 M + 6 L, all confirmed — §Review r2)
and two more probes (facts 14–15): each run gets a private devin home and the profile grants nothing
shared (H1, L8); supervisor files sit outside the only agent-writable area (H2); the exit status
travels in `exit.rc`, never stdout (M3); the audit records the enforced network boundary (M4).

**Revision 4 (2026-09-26):** after review r3 (NOT CLEAN, 1 H + 2 M + 4 L, all confirmed — §Review r3):
every granted path (`cwd` too, not only `writableRoots`) is checked against the run directories (H1);
the peer sidecar and `loadMeta` get a devin branch that never scans stdout (M2); one supervisor
wrapper on both paths deletes the credential copy the moment devin exits (M3); the profile denies
signals to processes outside the sandbox (L5); the audit's types are settled (L4); the stdout "cap" is
replaced by codex-background parity (L6); full-access wording no longer overclaims (L7).

**Revision 5 (2026-09-26):** after the r4 fixes-only review (5 of 7 closed; H1 partly open; 2 M + 3 L
new — §Review r4): the grant check protects all of `~/.stratum` in both directions with identical
canonicalization on both sides (N1); the signal golden targets an outside process (N2); foreground
stdout uses codex's real kill-on-overrun rule (N3); devin's stdout is `narrationPath` and bypasses
every shared sentinel call (N4); cancel and a pid+start-time sweep over both run roots close the
credential leak paths (N5).

**Revision 6 (2026-09-26) — design gate closed by the owner** ("fix Devin's own, then build"): r5's
fixes-only review left N1/H1 open only for directories **outside** `~/.stratum` that codex can equally
reach today — moved to the cross-agent follow-up `STRAT-AGENT-GRANT-GUARD-1` (§Out of scope). The two
devin-specific items are fixed: the wrapper owns the credential copy's life via a `trap` and the sweep
deletes only on positive proof (N5); `stream.jsonl` is supervisor-only and carries the wrapper's
sentinel, so `stratum watch`, the sidecar and `scanStream` work unchanged and unforgeable (N4). No
further design review round; implementation review is Codex's (§Owner decisions).

## Related Documents

- `docs/features/STRAT-AGENT-RUN-MODEL-VALIDATE/design.md` — boundary model validation this extends
- `docs/features/STRAT-AGENT-BG/design.md`, `STRAT-AGENT-BG-WRITE-1` — background runs + sandbox modes
- `docs/features/STRAT-AGENT-PEER-1/design.md` — peer naming / registry
- `docs/features/STRAT-AGENT-DEVIN-1/plan.md` — implementation plan (S1 split into S1a + S1b)

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
14. **What one devin run writes** (marker-file diff, unsandboxed `dangerous` run; other apps' writes
    excluded): `~/.cache/devin/cli/{managed_plugins,model_configs_v5,team_settings,user_status}.*.bin`,
    `~/.cache/devin/cli/mcp/descriptions.json`, `~/.cache/devin/telemetry_state.json`,
    `~/.local/share/devin/cli/{logs/*,plugins/lock.json,session_locks/*,sessions.db-wal}`,
    `$TMPDIR/devin-overflows-<uid>/*`. **Not** `~/.config/devin`, `~/.local/state/devin`, or
    `credentials.toml`. All of the written paths are read back by the owner's later devin sessions —
    any shared writable state is a persistence channel (review r2 H1).
15. **Per-run devin home works.** `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
    `XDG_STATE_HOME` and `TMPDIR` pointed at per-run dirs, with only `credentials.toml` (0600) and the
    owner's `~/.config/devin/mcp_config.json` copied in, under a seatbelt granting writes to the
    workspace + that home **only**: auth worked, the edit tool edited, `mcp_list_servers` returned the
    owner's servers (AgentMail, memory, smartmemory, sequential-thinking, pycharm); every write landed
    in the per-run home (incl. the `uv` cache of the stdio MCP server it spawned); no file under the
    real `~/.cache/devin`, `~/.local/share/devin`, `~/.config/devin` changed.

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
env XDG_DATA_HOME=<A>/home/data XDG_CACHE_HOME=<A>/home/cache XDG_CONFIG_HOME=<A>/home/config
    XDG_STATE_HOME=<A>/home/state TMPDIR=<A>/tmp/
[sandbox-exec -f <runDir>/devin.sb]          # omitted only for danger-full-access (D3)
devin --model <id> --permission-mode dangerous --config <A>/home/config/devin/config.json
      --respect-workspace-trust false
      --export <A>/trajectory.json --prompt-file <runDir>/prompt.md -p
```

**Run-dir layout (review r2 H2).** `runDir` is 0700 (the background run dir, or a foreground run dir
under `~/.stratum/ts/devin_fg/`, removed after the result is read — inside the protected root `S`, D3). Supervisor-owned files — `meta.json`, `stream.jsonl`, `.err`,
`peer.json`, `exit.rc`, `devin.sb`, `prompt.md` — live directly in `runDir`, which the profile
**never** grants. The agent-writable area is `A = <runDir>/agent/` only: the per-run devin home
(`home/{data,cache,config,state}`), `tmp/`, and the export. So an agent cannot delete or corrupt
`meta.json`, forge the exit status, or truncate the audit stream.

**Per-run devin home (review r2 H1, facts 14–15).** Before spawn stratum creates `A/home` and copies
the owner's
`~/.config/devin/mcp_config.json` → `A/home/config/devin/` (equality: same MCP servers), and writes
the stratum-owned `config.json` there; the **wrapper** (below) copies
`~/.local/share/devin/credentials.toml` → `A/home/data/devin/` (0600) as its first act (r5 fixes-review
N5). Nothing else from the owner's devin state is copied or
granted. Consequences: no shared devin state is writable from inside a run (no persistence into the
owner's later sessions); each run starts with a cold devin cache (model/team settings re-fetched,
stdio MCP servers resolve their own deps into `A/home/cache`) — a latency cost, measured in S1; a
token refresh inside a run updates only the copy. Missing credentials ⇒ named failure
`devin is not logged in (run \`devin auth\`)`, before spawn.

**The credential copy lives only while the wrapper lives (review r3 M3, r4 N5, r5 N5).** Background
run dirs have no retention path at all (nothing in `ts/src` removes `agent_runs` dirs), so "removed
with the run dir" would leave one live `credentials.toml` per run forever. Instead the supervisor
wrapper (next paragraph), used on **both** paths, owns the copy's whole life: it installs
`trap 'rm -f <creds>' EXIT HUP INT TERM` **before** copying the file in, so every wrapper exit that
runs a handler removes it — normal devin exit, devin signal death, `sandbox-exec` failing to start,
and stratum's own cancel (a SIGTERM to the group, `background.ts:613`). The copy therefore exists only
while a wrapper that will delete it is alive, and the stratum server dying mid-run changes nothing.
The only handler-less exit is SIGKILL to the wrapper (stratum's meta-write failure path,
`killDetachedProcessGroup`, `background.ts:640`, or an external kill; the agent cannot signal it —
D3, r3 L5). For that, a sweep on every devin dispatch covers **both** devin run roots
(`~/.stratum/ts/agent_runs/*/agent/…` and `~/.stratum/ts/devin_fg/*/agent/…`, 0700) with one
invariant: **delete only on positive proof the wrapper is gone** — `exit.rc` present, or
`processIdentity(meta.pid, meta.procStartTime) === "dead"` (tri-state, `proc_identity.ts:92-107`: a
reused pid reads dead, never alive). Never on `"unknown"`. A run dir with **no** readable `meta.json`
(the meta-write failure path) is an orphan once its copy's mtime is older than 10 minutes — meta is
written milliseconds after spawn, and that path has already SIGKILLed the group — and its copy is
deleted. Both roots' `meta.json` carry the wrapper's pid and `procStartTime` (the foreground connector
writes one too; the `agent_fg` registry record is not consulted). The rest of `A` (trajectory, cache)
follows codex's run-dir retention, i.e. none today.

stdin `/dev/null` (a CLI that reads stdin stalls otherwise — same landmine as codex exec). Prompt
goes through a 0600 file, never argv (prompts are private, and argv is visible in `ps`). The result
text and usage are read from the export (fact 6). Missing/unparseable export, or no agent step ⇒
failure `devin produced no trajectory: <stderr tail>` (never an empty success) — this also covers the
connection-error exit 1 (fact 2).

**Exit status channel (review r2 M3, r5 N4).** Both paths spawn a supervisor shell **outside** the
sandbox: `trap … ; cp <creds> <A>/…; sandbox-exec … devin … > <runDir>/stdout.log; rc=$?;
rm -f <A>/…/credentials.toml; echo $rc > <runDir>/exit.rc.tmp && mv <runDir>/exit.rc.tmp
<runDir>/exit.rc; echo '{"__t2f5_done__":'$rc'}' >> <runDir>/stream.jsonl`. The foreground connector
waits on the wrapper and reads `exit.rc`, so foreground and background share one status and cleanup
mechanism.

**Invariant: every file stratum parses for the T2F5 sentinel is written only by the supervisor.**
Devin's stdout goes to `stdout.log` (raw agent text, never parsed for the sentinel). `stream.jsonl`
in `runDir` holds **only** the wrapper's final sentinel line (and cancel's `writeSentinelIfAbsent`,
also supervisor) — the agent cannot write it (outside `A`, D3). So devin's `meta.json` carries
`streamPath = <runDir>/stream.jsonl` as `BackgroundRunMetaBase` requires (`background.ts:75`), and
every existing sentinel consumer works **unchanged and unforgeable**: `stratum watch`
(`cli/stratum.ts:139,176-181` — it shows no narration for devin until the done line; a named v1
limitation), the peer sidecar (`STRATUM_PEER_STREAM` stays required, `peer-registry.ts:212`, and is
this file, so r4's separate "exit.rc mode" is no longer needed), and `scanStream` at poll/cancel.
Poll's narration (`textTail`) is read from `narrationPath` = `stdout.log` (D8). Terminal status =
`exit.rc` present + export-derived result (D8); the sentinel line agrees with `exit.rc` by
construction.

**Narration stream (review r2 L6, L10; r3 L6).** stdout → `stream.jsonl`'s devin counterpart
(`stdout.log`, plain text). Bounds are codex parity, not more: the **foreground** connector applies
codex's overrun rule (`codex.ts:399-426`) — a single line, or an unterminated pending buffer, longer
than `resolveStdoutLimit()` kills the group and fails the run with the same overrun error; stderr keeps
its last `resolveStdoutLimit()` bytes, as codex's does (r4 fixes-review N3: r4 wrongly called this a
keep-the-tail buffer). The **background**
file is a plain `>` redirect with **no cap**, as codex's background `stream.jsonl` has none (a real
bound needs a supervisor reader on a pipe — a follow-up for both agents, not a devin feature). The
r3 design's "head dropped, tail retained" file cap is withdrawn: it cannot be done under a live fd.
Poll reports `textTail` = the last bytes of
that log and `eventsSeen` = the export's step count once it exists (0 before — the export is written
at run end, fact 6). Codex stream-error detection (`codexErrorMessage`, `scan.error`) is never
consulted for devin.

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
| `read-only` (default) | `sandbox-exec -f devin.sb` | `A` only (per-run devin home, tmp, export) |
| `workspace-write` | `sandbox-exec -f devin.sb` | `A` + `cwd` + each `writableRoots` entry |
| `danger-full-access` | none | everything; opt-in only via `STRATUM_DEVIN_ALLOW_FULL_ACCESS=1` (mirrors `assertCodexSandboxAllowed`; D11). Still uses the per-run home (D2), which only redirects devin's **own** XDG writes — with no sandbox the agent can still write the owner's real devin state. No isolation guarantee in this mode, as for codex's. |

**Profile** (generated per run, 0600, in `runDir`): `(version 1) (allow default) (deny file-write*)
(allow file-write* (subpath A) [(subpath cwd)] [(subpath root)…] (literal "/dev/null")
(literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/")) (deny signal)
(allow signal (target same-sandbox))` — facts 13 and 15; the signal rule is r4, below. **No**
`~/.cache`, `~/.config/devin`, `~/.local/share/devin`, `$TMPDIR` or `/private/var/folders` grant
(r2 H1, L8): devin's state is redirected into `A` by D2's env, and `TMPDIR` points at `A/tmp`.
Paths are realpath-resolved before emission (macOS `/tmp`→`/private/tmp` firmlinks) and quoted with
seatbelt string escaping; a path containing a character the escaper cannot represent is rejected,
never emitted raw.

**Every grant is checked against stratum's state root (review r3 H1, r4 fixes-review N1).** The check
applies to **each** path the profile would grant beyond `A` — `cwd` under `workspace-write` as well as
every `writableRoots` entry. Protected root `S` = `~/.stratum` (it holds `ts/agent_runs`,
`background.ts:135`, the foreground registry `ts/agent_fg`, `foreground_registry.ts:13`, and devin's
foreground run dirs, D2). A grant `p` is rejected with `devin cannot grant <p>: it overlaps stratum's
state directory` when `p` **overlaps `S` in either direction** — `p` equals `S`, is an ancestor of `S`,
or is anywhere inside `S` — unless `p` is inside this run's own `A`. Inside-`S` grants are refused
because every run dir and registry record there is a supervisor input: a writable sibling
`stream.jsonl` forges codex completion (`background.ts:680-683`), a writable `meta.json` redirects
cancel, and a forged `agent_fg` record turns stratum's unsandboxed cancel sweep
(`foreground_registry.ts:323-355`) into a kill-anything deputy. **Both sides are canonicalized the
same way** before comparison: realpath (firmlinks, symlinks, `..`), then case-folded (APFS is
case-insensitive by default; folding over-rejects only on a case-sensitive volume, which is the safe
direction). So `workspace-write` with `cwd` = `$HOME`, `~/.stratum`, anything under it, or `/` fails
before spawn. (Codex has the same exposure today — `workspace-write` with `cwd=$HOME` lets codex
rewrite its own `meta.json`; the same check for codex is a named follow-up, not silently skipped.)

**Signals (review r3 L5).** `(allow default)` would let the agent `kill -STOP`/`-KILL` the
supervisor wrapper (stalling or orphaning the run) or the stratum server. The profile adds
`(deny signal) (allow signal (target same-sandbox))` so devin and its children can signal each other
but nothing outside the sandbox. **Probed 2026-09-26** (macOS 26.6, `sandbox-exec` with exactly
`(allow default) (deny signal) (allow signal (target same-sandbox))`): `kill` of a child inside the
sandbox → rc 0; `kill -STOP` of a process outside → `Operation not permitted`, target state unchanged
(`SN`).

Symlinks: seatbelt checks the resolved target, so a workspace
symlink pointing outside the granted set is still denied — asserted in golden 2.

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
- **`ps` is denied inside the sandbox (observed 2026-09-26, two write-mode Devin runs).** `/bin/ps`
  fails `Operation not permitted`, so stratum's guard lock (`guard/lock.ts`, `darwinStartTime`)
  cannot verify process identity and every lock-taking stratum path fails inside a devin run —
  112 of 480 tests in the learn/config/mcp/cli kit. Same as codex's sandbox (memory
  `reference_stratum_agent_run_sandbox`), so equal, not a devin gap; implementer briefs must say the
  controller runs lock-dependent tests.
- **Cold-cache model list (observed 2026-09-26).** A per-run home fetches devin's model list at
  startup; during a devin-service degradation that fetch returned empty and the run failed
  `Unknown model: 'swe-2-high'` / `Available:` (nothing). The connector treats an empty
  `Available:` list as a transient service failure (named, retryable), not a model-validation error.
- **Platforms.** macOS only in v1 (`/usr/bin/sandbox-exec`). On Linux (no verified bwrap mapping —
  bwrap absent on the build host) `read-only`/`workspace-write` fail closed with a named error;
  `danger-full-access` (opt-in) works. A Linux profile is a follow-up.
- **GUI preamble (r2 L7).** `withSandboxPreamble`'s content is agent-neutral (seatbelt aborts GUI
  apps at WindowServer registration). It moves to `base.ts` as a shared helper and is applied to
  devin's `read-only`/`workspace-write` prompts exactly as to codex's; not to full access.
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
detached own-process-group spawn, `.err` file, registry entry — and uses D2's argv, run-dir layout,
`exit.rc` status channel and narration log (not the codex T2F5 stdout sentinel), D3's profile, D6's
model, D7's scrub, and `STRATUM_DEVIN_ALLOW_FULL_ACCESS`.
`STRATUM_CODEX_BG_STRATEGY` never applies to devin.

- **Result/poll/reattach** read the export in the run dir once the process has exited; stdout is the
  narration stream. The cost estimate at `background.ts:698` extends to devin via D6.
- **`loadMeta` and the peer sidecar get a devin branch (review r3 M2).** `loadMeta` hardcodes
  `stream.jsonl` (`background.ts:657`) and the detached peer sidecar's `scan()` flips the peer record
  to idle on any `{"__t2f5_done__":N}` line in the stream it is handed (`peer-sidecar.ts:343-351`).
  For codex that line is unforgeable (agent text is wrapped in codex's JSON envelope); devin's
  `stdout.log` is raw agent text. So for `agent: "devin"`: `loadMeta` additionally derives
  `<runDir>/stdout.log` (still from the validated run dir, never from the record) and returns it as
  **`narrationPath`** (r4 N4); `streamPath` stays `<runDir>/stream.jsonl`, which for devin is
  **supervisor-only** (D2 invariant, r6): no agent-written byte ever reaches a file any sentinel
  consumer parses. Hence (r6, superseding r4's "exit.rc mode" and "instead of every shared sentinel
  call"): the sidecar, `stratum watch`, `scanStream` at poll (`background.ts:480`, `:494`, `:524`)
  and cancel (`:606`), and `writeSentinelIfAbsent` (`:720-725`) all run unchanged for devin. The
  devin branch only (a) reads `textTail` from `narrationPath` and (b) derives the verdict from
  `exit.rc` + the export (next bullet), which the sentinel agrees with by construction.
- **Terminal status** is derived from `exit.rc` (D2 — never from stdout) plus the export: `exit.rc`
  = 0 + a valid export with a final agent message = `completed`; anything else (no export, D4
  rejection, non-zero rc) = error. No `exit.rc` + live process identity = running.
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
`STRATUM_CODEX_SANDBOX_MODE=danger-full-access` in the server env must never escalate devin. **Devin
has no sandbox env layer in v1** — no `STRATUM_DEVIN_SANDBOX_MODE`/`_NETWORK_ACCESS`/`_WRITABLE_ROOTS`
(r2 L5): devin resolves defaults → user → project `stratum.toml [sandbox]` → dispatch only.
`fullAccessAuthorization(env)` (`config/index.ts:116-121`) gains an `agent` parameter:
`STRATUM_CODEX_ALLOW_FULL_ACCESS` for codex (call sites `background.ts:831` and codex.ts
`directSandboxAudit` keep codex semantics), `STRATUM_DEVIN_ALLOW_FULL_ACCESS` for devin.
Of the resolved values: `filesystemMode` and `writableRoots` apply (D3); `networkAccess` follows D3's
network rule (only an explicit dispatch `false` fails); `approvalPolicy` is a codex approval concept —
a config-file value is ignored for devin (it cannot fail every devin dispatch in a repo that is fine
for codex), while an explicit dispatch-level `approvalPolicy` for devin is rejected, as for claude.

**Audit records the enforced boundary, not the requested one (r2 M4).** `sandboxAudit` for devin
records `filesystemMode` and `writableRoots` as resolved (they are enforced), **`networkAccess: true`**
(what the run actually has), and **`approvalPolicy: "never"`** — also the truth: under
`--permission-mode dangerous` devin never asks. Both carry provenance
`{ layer: "enforced", source: "devin: <reason>" }`; `ConfigLayer` (`config/types.ts:14`) grows an
`"enforced"` member (review r3 L4 — the r3 text "omits approvalPolicy" would have violated the
required `SandboxPolicy.approvalPolicy` and `provenance: Record<SandboxPolicyKey, …>` keys). No MCP
contract change: `sandboxAudit` is an opaque `"object"` in `contracts/mcp-surface.json`; the only
other `layer` reader, `cli/learn.ts:162`, prints it generically. A devin audit must never assert
isolation the run did not have.
`runner.ts:87`'s `agent === "codex"` becomes the D1 switch.

## Out of scope (follow-ups)

- `COMP-AGENT-DEVIN-1` — Compose accepts `devin` (the five sites above), model tiers, routing ladder.
- ACP transport (streaming `onEvent` narration, structured permissions).
- Linux sandbox profile (bwrap) for devin.
- Devin Cloud sessions.
- Judge tiers routed to devin (`judge/judged.ts`).
- Restricting agent MCP access — if ever wanted, one rule for all three agents (Equality principle).
- **`STRAT-AGENT-GRANT-GUARD-1`** (owner, 2026-09-26: "fix Devin's own, then build") — which
  directories *any* sandboxed agent may be granted write to. r5 review found supervisor-authoritative
  files **outside** `~/.stratum`: the peer sessions dir `~/.claude/sessions` and socket dir
  `/tmp/cc-socks` (`peer-registry.ts:35-41`; a forged `<pid>.json` suppresses peer registration or
  hijacks a sidecar socket), and every root relocatable by env (`STRATUM_AGENT_FG_ROOT`,
  `STRATUM_STATE_ROOT`, `STRATUM_CONFIG_FILE`, `STRATUM_PEER_SESSIONS_DIR`/`_SOCK_DIR`). **Codex has
  the same exposure today** (`workspace-write` with `cwd=/tmp` or `$HOME`), so this is one guard for
  both agents, computed from the *resolved* roots, not a devin-only rule — the equality principle.
  v1 devin protects the literal `~/.stratum` (D3) and inherits codex's exposure for the rest.

## Tests (per testing.md hierarchy)

- **Golden (live, `*.live.test.ts`, real devin, free `swe-2-medium`, macOS):**
  1. read-only review: foreground `stratum_agent_run agent=devin` over the real MCP server returns
     the final agent message, usage tokens > 0, `usd: 0 estimated`. The prompt also asks for a
     chained read (`git -C <cwd> log | head -1 && wc -l <file>`) — it must succeed — and for
     `sed -i` plus an edit-tool edit on a tracked file — both must fail and **`git status` is clean**
     (the OS boundary; r2 L9 — the former ambient-allow-list clause measured nothing under
     `dangerous` and is dropped). It also asks for writes to the real `~/.config/devin/config.json`
     and `~/.cache/devin/` — both must fail (files' mtimes unchanged) — and to the run dir's
     `meta.json` — must fail.
  2. workspace-write: a flow whose step `agent: devin` edits a file in its worktree **with the edit
     tool** and succeeds; a write outside the worktree fails (file absent); with
     `writableRoots: [<extra dir>]` a write there succeeds; a write through a workspace symlink that
     points outside fails; `mcp_list_servers` returns the owner's servers (equality).
  3. background: start → poll → completed result with the same fields; start and poll report the
     same `devin-…` peer name; a run whose agent prints `{"__t2f5_done__":0}` mid-run still polls as
     `running` until it really exits (r2 M3), **and** its peer record stays non-idle with no
     `peer_idle_notice` until `exit.rc` appears (r3 M2); after exit the run dir holds no
     `credentials.toml` (r3 M3); the test starts an **outside** process (`sleep 300`, not in the sandbox),
puts its pid in the prompt, asks the agent to `kill -STOP` it — the kill fails, the process's state
is not `T`, and the run completes (r3 L5; r4 fixes-review N2: `$PPID` is a same-sandbox process,
which the rule deliberately lets the agent signal).
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
  rejects an unescapable path; the profile never grants `runDir`, `~/.cache`, `~/.config/devin`,
  `~/.local/share/devin`, `$TMPDIR` or `/private/var/folders`; a `writableRoots` entry **or a
  workspace-write `cwd`** overlapping `~/.stratum` ⇒ named error before spawn (table rows:
  `cwd=$HOME`, `cwd=~/.stratum`, `cwd=/`, `writableRoots=[<runDir>/..]`, `[<runDir>]`,
  `[~/.stratum/ts/agent_runs/<sibling>]`, `[~/.stratum/ts/agent_fg]`, a symlink to `~/.stratum`, and a
  case variant `~/.STRATUM`; `writableRoots=[<A>/x]` is accepted — r3 H1, r4 N1); the profile
  contains the signal rule; a `{"__t2f5_done__":0}` line printed by the agent into `stdout.log`
  changes neither poll, cancel, `stratum watch`, nor the peer record, and devin's `stream.jsonl`
  holds exactly one line — the wrapper's sentinel, equal to `exit.rc` (r4 N4, r6); foreground stdout
  overrun ⇒ group killed + overrun error (r4 N3); the spawn env sets all four `XDG_*_HOME` and
  `TMPDIR` under `A`; while devin runs, the per-run home holds exactly `credentials.toml` (0600),
  `mcp_config.json` and the stratum `config.json`; the wrapper (real shell, stub devin) leaves no
  `credentials.toml` after exit 0, non-zero, stub signal death, `sandbox-exec` start failure, and a
  SIGTERM to the group (stratum's cancel) (r5 N5); the sweep deletes a copy when `exit.rc` exists,
  when identity is `"dead"` (incl. a live pid with a different `procStartTime`), and in a meta-less
  dir older than 10 minutes, under both `agent_runs` and `devin_fg` — and **keeps** it when identity
  is `"unknown"` or the meta-less dir is younger (r5 N5); `loadMeta` for a devin run returns
  `narrationPath = stdout.log` and `streamPath = stream.jsonl`;
  missing credentials ⇒ named "not logged in" error before spawn; a devin `sandboxAudit` records
  `networkAccess: true` and `approvalPolicy: "never"`, both with layer `enforced`, even when
  `stratum.toml` sets `networkAccess=false`;
  unknown agent error lists all three.
- **Equality check (table-driven over `AGENT_TYPES`):** every parameter `stratum_agent_run` accepts
  for codex is accepted for devin or rejected with a named devin error — a new codex parameter that
  devin silently ignores fails this test. Every agent switch is exhaustive (compile-time `never`).
- **Contract:** evaluator `route: "devin"` accepted by `evaluatorResultSchema`; IR accepts
  `agent: devin` and still rejects an unknown agent.
- Fixtures: real ATIF exports captured from the 2026-09-26 probes (scrub paths), not hand-written.

## Slices

1. **S1 core** — D1 agent list + exhaustive switches, D6 models/pricing/validation, D7 env, D11
   config + enforced-value audit, D2 per-run home + run-dir layout, D3 profile generator + shared
   GUI preamble, `DevinConnector` foreground (D2, D3, D4), runner + MCP wiring. Error harness +
   equality check + golden 1. (The state-set probe planned here is done — facts 14–15.)
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

## Review r2 (Devin SWE-2 High, 2026-09-26) — NOT CLEAN. r1 closure: H1–H4, M5 closed in intent. New
findings, all confirmed by Claude (H1 by the fact-14 write census):

| # | Sev | Finding | Resolution |
|---|---|---|---|
| H1 | H | writable "state set" includes owner config, credentials, `~/.cache` (puppeteer binary) — a read-only run persists into later runs | D2 per-run devin home (facts 14–15); D3 profile grants `A` only |
| H2 | H | run dir writable ⇒ agent can delete `meta.json` and become unpollable/uncancellable | D2 run-dir layout: supervisor files outside `A` |
| M3 | M | devin stdout is raw text ⇒ a printed T2F5 sentinel forges terminal status | D2 `exit.rc` channel; stdout never parsed for it; golden 3 |
| M4 | M | `sandboxAudit` would record `networkAccess:false` for a run with network | D11 audit records enforced values |
| L5 | L | devin env layer unnamed; `fullAccessAuthorization` hardcodes codex var | D11: no devin sandbox env layer; `agent` parameter |
| L6 | L | poll `textTail`/`eventsSeen` undefined for plain-text stdout; codex error detection | D2 narration stream |
| L7 | L | GUI preamble is agent-neutral, dropped for devin | D3: shared helper, applied to devin |
| L8 | L | `/private/var/folders`, `~/.cache` grants far too wide | gone with H1 fix |
| L9 | L | golden 1 ambient-allow clause inert under `dangerous` | dropped; OS-boundary + state-write asserts instead |
| L10 | L | no stdout bound | D2 narration cap (withdrawn in r4, r3 L6) |

## Review r3 (Devin SWE-2 High, read-only seatbelt, 2026-09-26) — NOT CLEAN. r2 closure: H1 closed
for `read-only`; H2 only partly (finding H1 below); M3 closed for poll but not for the peer channel
(M2). All findings confirmed by Claude against source (`background.ts:135,657`, `peer-sidecar.ts:349`,
`codex.ts:272,352`, `config/types.ts:10-25`):

| # | Sev | Finding | Resolution (r4) |
|---|---|---|---|
| H1 | H | only `writableRoots` is checked against `runDir`; a `workspace-write` `cwd` of `$HOME`/`~/.stratum`/`/` re-grants `meta.json`/`exit.rc` (r2 H2 again) | D3: every grant checked against `runDir` and the runs root |
| M2 | M | peer sidecar trusts a `__t2f5_done__` line in whatever stream it scans; `loadMeta` hardcodes `stream.jsonl` ⇒ forged `peer_idle_notice` | D8: devin branch in `loadMeta`; sidecar exit.rc mode |
| M3 | M | "removed with the run dir" is vacuous — no run-dir retention exists; one live credential copy per run forever | D2: wrapper deletes the copy on devin exit; dispatch-time sweep |
| L4 | L | enforced-value audit unbuildable: no `enforced` layer; omitting `approvalPolicy` breaks required keys | D11: `ConfigLayer` += `enforced`; `approvalPolicy: "never"` |
| L5 | L | `(allow default)` lets the agent signal the wrapper (stall/orphan the run) | D3: `(deny signal) (allow signal (target same-sandbox))`, probed in S1 |
| L6 | L | file cap impossible under a live `>` fd | D2: codex parity (foreground bound, background uncapped) |
| L7 | L | full-access "runs never share state" overclaims | D3 table wording |

**Gate decision (Claude, r4):** r3 was planned as the final full round (review-loop budget ~3). r4's
changes are local to the seven findings; r4 goes to a **fixes-only** review (does each resolution close
its finding without opening a new hole), not a fourth full review.

## Review r4 — fixes-only (Devin SWE-2 High, read-only seatbelt, 2026-09-26) — NOT CLEAN

Closed: M2, M3, L4, L5, L6, L7. H1 partly open (N1). All new findings confirmed by Claude against
source (`foreground_registry.ts:13`, `background.ts:480,606,720-725`, `codex.ts:399-426`):

| # | Sev | Finding | Resolution (r5) |
|---|---|---|---|
| N1 | M | grant rule missed descendants of the runs root and the `agent_fg` registry root; runDir side not canonicalized ⇒ sibling-stream forgery, cancel redirection, forged `agent_fg` record makes stratum's cancel kill an arbitrary process | D3: protect all of `~/.stratum`, both directions, identical realpath + case-fold on both sides |
| N2 | M | golden `kill -STOP $PPID` targets a same-sandbox process, which the rule allows ⇒ run hangs | golden targets an outside `sleep` |
| N3 | L | codex foreground is kill-on-overrun, not keep-tail | D2 narration: codex's overrun rule |
| N4 | L | `stdout.log` returned as `streamPath`; shared `scanStream`/`writeSentinelIfAbsent` run before any agent branch | D8: `narrationPath`; devin branch replaces those calls |
| N5 | L | cancel kills the wrapper before `rm`; pid reuse defeats "dead wrapper"; sweep missed foreground dirs | D2: cancel deletes the copy; pid+`procStartTime`; sweep both roots (`devin_fg` new) |

## Review r5 — fixes-only (Devin SWE-2 High, read-only seatbelt, 2026-09-26) — NOT CLEAN; gate closed by owner

Closed: N2, N3. Open: N1/H1, N4, N5; two new Lows. All confirmed by Claude against source
(`cli/stratum.ts:137-181`, `peer-registry.ts:35-41`, `foreground_registry.ts:61`, `server.ts:99`,
`background.ts:75,640`). Review budget (~3 rounds) exhausted; owner chose "fix Devin's own, then build".

| # | Sev | Finding | Resolution (r6) |
|---|---|---|---|
| N1/H1 | M | supervisor files **outside** `~/.stratum` (peer sessions/sock dirs) and env-relocated roots remain grantable | cross-agent — codex equally exposed; `STRAT-AGENT-GRANT-GUARD-1` (§Out of scope) |
| N4 | M | `stratum watch` parses `meta.streamPath` for the sentinel; devin meta must carry a `streamPath` | D2 invariant: `stream.jsonl` supervisor-only, wrapper writes the sentinel; all consumers unchanged |
| N5 | L | sweep undefined for absent identity / meta-less dirs; cancel's wait unbounded | wrapper `trap` owns the copy; sweep deletes only on `exit.rc`/`"dead"`/meta-less > 10 min |
| new | L | devin record shape vs `watchAgent` unspecified | same as N4 |
| new | L | failed dispatch between copy and meta-write leaks or races | wrapper copies after `trap`; meta-less orphan rule |
