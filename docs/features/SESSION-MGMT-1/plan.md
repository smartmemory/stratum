**OWNER PICK (2026-10-19 17:2x, via s1-chat): shape 1 = C, the Stratum front door over today's scripts** (`stratum session` commands + MCP
tools, owner numbers in one settings file, Compose and Stratum agents launch through it). Starts after s2-coord's MAX-SUNSET cutover edits
land. Shape 2 (Compose Sessions screen) is a later layer on top, not now. No calendar date.

**Reason** (shape.md, Recommendation): keeps ~19K tested lines, matches the 2026-10-12 "Shrink it" pick, closes the hole where Compose and
Stratum start `claude` outside the account pick and launch gates.

# SESSION-MGMT-1 — plan: a Stratum front door over the session scripts

Author: forge-e0 detached Opus, 2026-10-19; fix round 1 the same evening (`## Fix round 1`). Docs only. Every unit below is one author run.
Line numbers were re-read in fix round 1 at smart-memory-ops `543da2dd` (HEAD; holds MAX-SUNSET-2 `6c4fff37`, MAX-SUNSET-3 merge `78aee3d8`,
MAX-SUNSET-4 merge `98b03936`, all checked with `git merge-base --is-ancestor`), forge/stratum `dbc64e2`, forge/compose `bc996708`.
MAX-SUNSET-5 and -7 have not landed; they will move lines in the files they touch, so briefs re-read by symbol name.
Paths under `claude/` are relative to `smart-memory-ops/` (live through the `~/.claude/{scripts,hooks}` symlinks).

## Related Documents

- Shape proposal (owner picked C): `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/SESSION-MGMT-1/shape.md`
- Plan brief: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/SESSION-MGMT-1/plan-brief.md`; fix-round brief: `.../plan-fix-r1-brief.md`
- Plan review round 1 (NOT CLEAN 9 HIGH 11 MEDIUM): `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/SESSION-MGMT-1/plan-review-r1.md`
- Cutover file map (newer than the first plan): `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/SESSION-MGMT-1/order-input.md`
- Max sunset inventory and units: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/units/MAX-SUNSET-1/report.md`,
  `.../MAX-SUNSET-1/filed.md` (row 29: Compose and Stratum spawns), `.../MAX-SUNSET-{2,3,4,5,7}/brief.md`, `.../MAX-SUNSET-{2,3,4}/report.md`
- Prior shape pick this continues ("Shrink it", scripts are the spine): `/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-SERVICE-1/design.md`
- Contract (every data shape in this plan points here): `/Users/ruze/reg/my/forge/stratum/docs/features/SESSION-MGMT-1/session-contract.json`
- Feature record: `/Users/ruze/reg/my/forge/stratum/docs/features/SESSION-MGMT-1/feature.json`
- Script JSON shapes the front door consumes: `/Users/ruze/reg/my/SmartMemory/smart-memory-ops/claude/scripts/json-contract.json`

## Design decisions (made here, inside the picked shape; each can be overridden with one line)

- **D1. One settings file = the existing accounts file.** The owner's numbers go into a new top-level `session_policy` block of
  `claude/scripts/usage-watch.accounts.json`. Retire dates, per-seat ceilings, `reserved` and `owner_session_policy` already live in that file
  (`usage_watch.py:96-111`, `:302-360`), and `load_accounts` reads only the keys it knows, so a new block changes nothing for the existing
  readers. A second file would split the owner's numbers in two.
- **D2. Built-in defaults equal today's constants**, and env variables that exist today keep overriding (they are the kill switches and the test
  seams). Installing the policy file with today's values is a no-op, proven by a parity row in every adapter unit.
- **D3. Two admission levels, one rule for which.** A launch that **returns before the agent finishes** (detached jobs, background workers,
  spawned-and-tracked agents) takes the full launch gate (spacing, rate, load, fleet). A launch whose **caller awaits the result in-process**
  takes account choice + `judge()` only. The gate spaces launches 45 s apart (`launch_gate.py:83`); putting an awaited one-turn summary behind
  it would stall Compose's UI. Every launch path, its level and its single owner: `## Admission owners`.
- **D4. MCP hop is check / dry-run only.** A live hop types into iTerm and closes tabs, and a session that hops itself keeps its own tab busy
  (`session_hop.py:9-10`). Live hop stays a CLI verb with an explicit `--live`; the MCP input enum has no `live` value and the MCP module
  cannot reach the backend's live method (contract `operations.hop`).
- **D5. Compose reaches the door through the `stratum` CLI**, found with the resolver Compose already has (`compose/lib/stratum-engine.js:208-245`
  `resolveStratumBin('cli', ...)`), not through a new package export.
- **D6. A Claude launch through the door needs an explicit model.** The gate already denies a launch with none. Two Compose spawns pass no
  `--model` today (`agent-spawn.js:58-61`, `vision-utils.js:130`), so U13 gives them a Sonnet-class default (the summarizer already passes one,
  `summarizer.js:74-78`).
- **D7. Configured vs not configured (owner Q2, ANSWERED 2026-10-19 17:59).** One deterministic test decides, `configured(env)`, contract
  `backend.configured_test`: true when `STRATUM_SESSION_SCRIPTS_DIR` is a non-empty string, or the Stratum **user** config file
  (`STRATUM_CONFIG_FILE`, else `~/.stratum/config.toml`, `stratum/ts/src/config/index.ts:106`) holds a `[session]` table. Not configured:
  `admit` passes through and launches keep today's behaviour (published packages unchanged for outside users). Configured: **every** failure
  refuses and nothing launches: a missing `stratum` executable (Compose), a missing dir or script or python, an unset `CLAUDE_CONFIG_DIR` under
  `inherit` (`account-unset`), a gate error, a timeout. Nothing in configured mode falls back to `~/.claude`. A `[session]` table in a project
  `stratum.toml` (`index.ts:107`) is a config error, so a repository can never point the door at its own scripts. On this Mac the Finding 19
  activation step (after U14, fix round 2) writes `[session]` into the user config, so from then on a missing script blocks launches.
- **D8. Admitted env = launched env.** Admission is asked about the exact env the child will get, and its answer is applied to that env:
  the caller builds its candidate child env E (what it hands to `spawn` / the SDK today, before its scrub), the backend runs `session_admit.py`
  **with env E**, a configured-mode success always returns the engine home as an absolute path (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, `inherit`
  included, never an empty patch), the caller launches with `childEnv = {...E, ...data.env}` then its existing scrub, and
  `assertAdmittedEnv` checks the home right before spawn (`admission-env-mismatch` otherwise). Contract `operations.admit.child_env`,
  `library.child_env_check`, `library.compose_helper`.
- **D9. MAX-SUNSET's unset-dir rule, restated for the door.** MAX-SUNSET-2 denies an unset `CLAUDE_CONFIG_DIR` once Max is retired (gate,
  `work_model_gate.py:116-117` is where unset becomes `~/.claude`); MAX-SUNSET-4 resolves a retired home to a picked seat inside `detach_job`
  (`detach_job.py:339-384`). The door is stricter in configured mode and does not depend on Max's state: `inherit` with an unset dir refuses
  `account-unset` whether Max is live, reserved or retired. (Max state today: reserved at 17:59 by ops `766f3b69`, reserve removed at 18:13 by
  ops `50596555` after the owner's `/login`; both commits are ancestors of `543da2dd`.) Using Max through the door is an explicit
  `account: "max"` (or `auto`), which the judge and `seat_limits` then allow or refuse.

## Buckets

| Bucket | What it is | Repo | Units |
|---|---|---|---|
| **S** spine | The front door in Stratum: one backend interface over the scripts (`ts/src/session/`), the `stratum session` CLI verbs, the MCP tools | forge/stratum | U1, U2, U3 |
| **P** policy | The `session_policy` block of the accounts file and its one reader `session_policy.py` | ops | U4 |
| **A** adapters | Today's scripts, changed only to read P and to be callable by S (a `--json` output, a test transport, or a thin new entry point that composes existing functions) | ops | U5, U6, U7, U8, U9, U10 |
| **C** call sites | Stratum's own runs and Compose's spawns go through the door | forge/stratum, forge/compose | U11, U12, U13, U14 |
| **O** one-off | Install on this Mac, one live golden check, docs and the rule pointer | forge + ops | U15 |

Every unit is in exactly one bucket. Convergence check: every step of the brief, shape.md and the round-1 review classified; see `## Unclassified`.

## Contract

`session-contract.json` (this folder, version 2) holds every shape; units point at its keys, prose here does not repeat them.

- Front door: `backend` (`configured_test`, `exec`, `stdin`, `child_env_rule`, `modes`), `envelope` (ok / refused with `record` / partial),
  `cli_exit_codes`, `refusal_codes` (each mapped to its script exit with file:line), `operations` (`pick`, `admit`, `launch`, `status`, `fleet`,
  `hop` with `script_argv_by_mode`, `jobs_list`, `jobs_register`, `policy`, plus `relaunch_print` for U7), `test_fixture`, `mcp_tools`, `library`.
- Policy: `policy_schema` (`seat_map`, `admission.*`, `launch_gate.*`), precedence, malformed handling, the one reader, `not_in_v1`.
- Script side: the new `--json` outputs (U5, U7, U8, U10) are added as keys of `claude/scripts/json-contract.json` by the unit that adds them;
  `operations.*.script_output` names the shape the front door expects, and U2's contract test runs the real script and checks both.

## Admission owners

One row per launch path that starts an engine. Rule D3: **full gate when the launch returns before the agent finishes; none when the caller
awaits it.** Each of the three jobs (account selection, `judge`, full gate) has exactly one owner per row. "admit" = `session_admit.py`
through the backend (U9 script, U2 backend); in mode `none` every row below behaves as today.

| # | Launch path (entry, file:line) | Account selection | `judge` | Full gate | Probe that proves it (gate blocked = fixture `LAUNCH_GATE_LOAD_MAX=0`, `max_wait_s 1`) | Unit |
|---|---|---|---|---|---|---|
| 1 | Front door `launch`, engine claude (U2 `launch` op) | admit (step 1, `marker_file` = the brief) | admit | admit (`launch_gate full`); `detach_job.admit_launch` skips through its existing `LAUNCH_GATE_ADMITTED=<label>` check (`detach_job.py:2822-2825`), which the door sets only after its own admit and strips from every inherited env; `detach_job.resolve_retired_home` returns None for the admitted live home (`:368`), so no second selection | gate blocked → `launch-gate-timeout`, `detach_job` never runs, no engine process, fixture registry and index empty; success → meta has no `account_pick` and the launches log has exactly one row | U2 |
| 2 | Front door `launch`, engine codex | admit (Codex pool, `CODEX_HOME`) | skip (judge is Claude-only; `checks` shows `skip`) | admit; `detach_job.admit_launch` never gates codex (`:2820`) | same as row 1 with `--engine codex`: blocked → no process; success → one launches-log row | U2 |
| 3 | Front door `admit` alone (CLI / MCP; the caller spawns) | admit | admit (claude) | as the caller asks; documented per caller in this table | `admit --launch-gate none` writes no launches-log row; `full` writes one | U2 |
| 4 | Stratum foreground Claude: `runner.ts:187-189`, before `new ClaudeConnector` | admit (`launch_gate none`) | admit | none (awaited) | refusal → run result carries the code, the SDK seam (`claude.ts:49`) is never called | U11 |
| 5 | Stratum background Claude: `startClaudeBackgroundRun` `background.ts:452`, after `validateClaudeSessionIdentity` (`:469`), before `newRunDir` (`:471`) | admit (`launch_gate full`) | admit | admit; the worker's connector (`claude-bg-worker.ts:82`) receives `connectorOptions.env = childEnv` (`background.ts:496`) and does NOT admit again | gate blocked → no run dir, no `Worker` (`:503`), `claudeWorkerRegistry` empty, launches log unchanged | U11 |
| 6 | Stratum background Codex, both strategies: `startBackgroundRun` codex branch `background.ts:170`, after `resolveCodexModel` (`:214`), before `newRunDir` (`:216`); covers app-server (`:246`) and exec (`:255`) | admit (Codex pool) | skip | admit | gate blocked, once per strategy (`STRATUM_CODEX_BG_STRATEGY=exec` and `app-server`) → no run dir, no child | U12 |
| 7 | Compose `POST /api/agent/spawn`: `agent-spawn.js:58` (returns the agent id before it finishes) | `admitClaude` | admit | admit (`launchGate 'full'`, `maxWaitS 60`) | blocked → HTTP 503 `{code:'launch-gate-timeout'}`, stub `claude` never ran | U13 |
| 8 | Compose journal agent: `vision-utils.js:130` (fire and forget, `proc.on('close')`) | `admitClaude` | admit | admit (`full`, `maxWaitS 120`) | blocked → one log line with the code, stub never ran | U13 |
| 9 | Compose summarizer: `summarizer.js:74` (awaited, `--max-turns 1`) | `admitClaude` | admit | none | refusal → summarizer resolves its existing failure value, stub never ran | U13 |
| 10 | Compose workspace chat: `agent-workspace.js:203` (awaited SDK stream) | `admitClaude` | admit | none | refusal → existing error path, `query` seam never called | U14 |
| 11 | Compose build dispatch: `local-claude-connector.js:272` (awaited `runLocalClaudeAgent`) | `admitClaude` | admit | none | same as row 10 | U14 |
| — | Not launch paths, or out of scope: `deps.js:376`, `:389` (plugin install), Stratum foreground Codex/Devin and background Devin | — | — | — | `## Unclassified` 1-2 | — |

**Closure guard (fix the class, not the rows):** U11 adds a test that greps `stratum/ts/src` for `new ClaudeConnector(` and
`startBackgroundRun(` outside tests and fails unless the hits are exactly `runner.ts:189`, `claude-bg-worker.ts:82` and `runner.ts:143`; U13 adds
the same for Compose (`spawn('claude'` and SDK `query(` sites must be exactly rows 7-11 plus the two `deps.js` plugin lines). A new launch site
fails CI until it gets a row here.

## Units

| ID | Bucket | Repo | One line | Depends on (this plan) | Waits for (MAX-SUNSET) | Lane | Security | Model |
|---|---|---|---|---|---|---|---|---|
| SESSION-MGMT-1-U1 | S | stratum | Backend core, `configured()`, config `[session]`, envelope, `pick`, `jobs list`, `register` | none | none: **start now** (owner Q1) | forge c2 | yes (argv exec boundary, fail-closed modes) | Opus |
| SESSION-MGMT-1-U2 | S | stratum | Backend ops `admit`, `launch`, `status`, `fleet`, `hop` (3 argv modes), `policy` + CLI verbs + contract tests | U1, U4, U5, U8, U9, U10 | -5, -7 (transitive) | forge c2 | yes (launch sequencing, env threading) | Opus |
| SESSION-MGMT-1-U3 | S | stratum | MCP tools `stratum_session_*` | U2 | -5, -7 (transitive) | forge c2 | yes (any MCP client can launch) | Sonnet |
| SESSION-MGMT-1-U4 | P | ops | `session_policy` block + `session_policy.py` reader + `--json` | none | **-5, -7** | BOUNDED | yes (admission numbers, seat map) | Sonnet |
| SESSION-MGMT-1-U5 | A | ops | `launch_gate` defaults from policy; `--status --json`, `--fleet --json` | U4 | -5, -7 (via U4) | BOUNDED | no | Sonnet |
| SESSION-MGMT-1-U6 | A | ops | Quota limit and default seat ceiling from policy | U4 | **-7** (and -5 via U4) | BOUNDED | yes (quota gate) | Sonnet |
| SESSION-MGMT-1-U7 | A | ops | `SEAT_MAP` from policy; account-aware launch function; `seat_relaunch --json` | U4 | **-5, -7** | BOUNDED | yes (account selection) | Sonnet |
| SESSION-MGMT-1-U8 | A | ops | `session_hop --json` for hop, `--dry-run`, `--check`; fixture iTerm transport | none | **-7** | BOUNDED | no (output + test seam) | Sonnet |
| SESSION-MGMT-1-U9 | A | ops | New `session_admit.py`: account (inherit/auto/id per vendor) + `judge()` + launch gate, JSON | none | **-7** (imports `detach_job` and `usage_watch` functions -7 edits) | BOUNDED | yes (account selection + admission) | Opus |
| SESSION-MGMT-1-U10 | A | ops | `detach_job run --json` (one JSON document on stdout) | none | **-7** | BOUNDED | no (output only) | Sonnet |
| SESSION-MGMT-1-U11 | C | stratum | Stratum Claude runs: foreground admits (none), background admits (full); child env from admit | U2, U3 | -5, -7 (transitive) | forge c2 | yes (account selection) | Opus |
| SESSION-MGMT-1-U12 | C | stratum | Stratum background Codex (both strategies): admit full + `jobs.py` registration | U2, U11 | -5, -7 (transitive) | forge c2 | yes (account selection + gate) | Sonnet |
| SESSION-MGMT-1-U13 | C | compose | `session-door.js` (`sessionConfigured`, `admitClaude`, `assertAdmittedEnv`) + the three `spawn('claude')` sites | U2 | -5, -7 (transitive); absorbs any forge item MAX-SUNSET-4 filed for row 29 | forge c2 | yes (account selection, fail-closed) | Sonnet |
| SESSION-MGMT-1-U14 | C | compose | The two Agent-SDK `query()` sites launch with the admitted child env | U13 | -5, -7 (transitive) | forge c2 | yes (account selection) | Sonnet |
| SESSION-MGMT-1-U15 | O | forge + ops + Mac | Install, one live golden check, docs, rule pointer (owner yes) | U3, U6, U7, U12, U14 | -6 (rule file); -5, -7 (transitive) | BOUNDED | no | Sonnet |

Lanes: ops units are BOUNDED (tooling outside the product repos, `no-claude-coding.md` rule 6); forge units are lane (c2) forge, land on gate
with the daily post-land batch review (rule 9). **Security-tagged units keep ONE pre-land Codex review** (rule 9 exception: they decide which
account a launch runs on, or the admission numbers). Opus units carry `hard:` in their brief (the reason is in each unit below).

Every author brief carries: the unit's acceptance list and probe set below (rule 7, author self-checks and pastes the result), "fix the whole
class" (rule 2), tests run with `--basetemp` under `forge/scratch/<date>-<unit>/` or `SmartMemory/scratch/<date>-<unit>/` and deleted after,
pytest `-n 4` at most / vitest `--maxWorkers=4`, a worktree (`.worktrees/<repo>-session-mgmt-u<n>`), commit as smartmem-dev, no push, no port
(no unit here binds a port), and never reading real usage-watch state, `~/.keys`, settings contents or env values.
**Every test that runs a script uses the one isolated fixture in contract `test_fixture`**: `HOME` pointed at a fixture home (catches every
`Path.home()` default), every script-specific override listed there (including `LAUNCH_GATE_STATE_DIR`, whose default is not under `HOME`,
`launch_gate.py:51`, and `SEAT_*`, `SESSION_HOP_*`, `DETACH_JOB_*`), the leak gate (real `~/.claude/{logs,session-state,usage}`, the ops
`status/launch-gate` dir and `~/.stratum` unchanged before/after, else fail), and process-group teardown of fixture engines on the failure path.
Test files: one table, one row per case, no stacked `parametrize`, at most ~300 cases per file, paste `--collect-only | tail -1` before/after.

### SESSION-MGMT-1-U1 — backend core, configured test, config, envelope, pick and jobs (S)

hard: new trust boundary (argv exec of host scripts, the configured/not-configured switch, fail-closed modes, Stratum's strict config parser).

Files: `stratum/ts/src/session/backend.ts` (new: `SessionBackend` interface, envelope incl. `record`, refusal mapping), `stratum/ts/src/session/scripts-backend.ts`
(new: argv-array spawn runner (no shell, own process group; F5 wording, 2026-10-19), stdin rule, timeouts, process-group kill, single-JSON parse + shape check for successes AND refusals), `stratum/ts/src/session/configured.ts`
(new: `configured(env)` per contract `backend.configured_test`), `stratum/ts/src/session/index.ts` (new: `createSessionBackend`),
`stratum/ts/src/config/index.ts` (existing: accept `[session]` with `scripts_dir`, `python` in the user file only; reject it in a project
`stratum.toml`; `rejectUnknown` at `:186`), `stratum/ts/src/cli/session.ts` (new: `pick`, `jobs`, `register` verbs), `stratum/ts/src/cli/stratum.ts`
(existing: dispatch `session` at `:24-37`, usage line `:38`), `stratum/ts/tests/session/backend.test.ts` (new),
`stratum/ts/tests/session/configured-fixtures.json` (new: the shared fixture table U13 also runs), `stratum/CHANGELOG.md` (existing).

- [ ] `configured(env)` exactly per contract `backend.configured_test`; every row of `configured-fixtures.json` passes
- [ ] Configured but broken (no usable `scripts_dir`, missing script, missing python, config parse error, a user config file that exists but cannot be read) → `backend-unavailable` for every op, `admit` included; never `backend: 'none'`
- [ ] `[session]` in a project `stratum.toml` → config error naming the file; an unknown key inside `[session]` → config error naming the key
- [ ] Every op runs `spawn` with an argv array (`shell: false`, `detached: true` for its own process group), never a shell; stdin `ignore` for every op except `admit` (contract `backend.stdin`); `CLAUDECODE` and `LAUNCH_GATE_ADMITTED` removed from the script env (`backend.child_env_rule`); timeout per op, child process group killed on timeout
- [ ] A refusal whose stdout is one valid JSON document of the op's shape is returned with it as `record`; JSON of the wrong shape is `backend-error`; no JSON → `record: null`
- [ ] Refusal codes exactly as `refusal_codes`; a script exit not in the op's map is `backend-error`, never `ok`
- [ ] `pick` maps exit 0/1/3 per contract; a refusal carries the seat table in `record`
- [ ] `jobs` passes `--diagnostics` and returns `bad_count` unchanged; `register` returns the stored add event (contract `jobs_register.script_output`), checks `op == 'add'` and that `session`/`id` equal the input, maps exit 1 to `registry-refused`
- [ ] `stratum session pick|jobs|register --json` print the envelope and exit with `cli_exit_codes`

Tests (real scripts, no mocks, contract `test_fixture`): the suite points `STRATUM_SESSION_SCRIPTS_DIR` at the ops worktree's `claude/scripts`.
Golden flow: register a job → `jobs` shows it → `pick` returns a seat. Error table rows: unconfigured, configured + dir missing, configured +
script missing, configured + python missing, project-file `[session]`, exit 1, exit 3, exit 9 (unmapped), non-JSON stdout, two JSON documents on
stdout, refusal with wrong-shape JSON, timeout (fixture script that sleeps), argv with spaces and a leading `-` in `--name`, register without and
with `--priority`.

Probes (author must pass): (1) env unset, no config file → `stratum session pick --kind author --json` exits 4 `backend-unconfigured`;
(2) `STRATUM_CONFIG_FILE` naming a file with `[session]` and no `scripts_dir` → exit 4 `backend-unavailable` (not unconfigured);
(3) fixture where every seat is at its ceiling → exit 1 `no-eligible-account`, `record.seats` has 4 rows;
(4) `--name '$(touch <root>/x)'` → no file created, the name appears verbatim in `choice.command`; (5) a script printing `not json` → exit 4
`backend-error`; (6) `ps` after a timeout probe shows no orphan child; (7) `register` with no `--priority` → `data` has no `priority_source`;
with `--priority P1` → `data.priority_source == 'explicit'`.

### SESSION-MGMT-1-U2 — remaining ops + CLI verbs + contract tests (S)

hard: the launch sequence owns the full gate for every engine (strip/set `LAUNCH_GATE_ADMITTED`), threads the admitted env into `detach_job`,
and builds the three hop argv modes; a mistake there launches on the wrong account or reaches a live hop.

Files: `stratum/ts/src/session/scripts-backend.ts` (existing after U1), `stratum/ts/src/cli/session.ts` (existing after U1),
`stratum/ts/tests/session/ops.test.ts` (new), `stratum/ts/tests/session/contract.test.ts` (new: loads
`docs/features/SESSION-MGMT-1/session-contract.json`), `stratum/CHANGELOG.md`.

Per-operation checkpoints inside the one run (`no-redundant-rework.md`): the author commits after each of `admit`, `launch`, `status`/`fleet`,
`hop`, `policy`, each with its rows green, so a failure in one op never redoes the others.

- [ ] `admit(input, {childEnv})`: runs the script with env = `childEnv` per `backend.child_env_rule`; `marker_text` on stdin (≤ 262144 bytes, then the stream ends), never in argv; returns `childEnv = {...childEnv, ...data.env}`; mode `none` returns the pass-through answer with `childEnv` unchanged
- [ ] In mode `scripts` an admitted result whose `data.env` lacks the engine home or carries any other key is `backend-error` (contract `admit.script_output.env`)
- [ ] `launch` follows contract `operations.launch.steps` exactly: admit with `launch_gate full`, `marker_file` = the brief, for **both** engines; `detach_job` env = admitted `childEnv` + `LAUNCH_GATE_ADMITTED=<label>` + `LAUNCH_GATE_MAX_WAIT=<max_wait_s>`; an inherited `LAUNCH_GATE_ADMITTED` is stripped before step 1
- [ ] `hop` builds argv only from `script_argv_by_mode` (`check`, `dry-run`, `live`); the backend exposes `hopCheck`, `hopDryRun`, `hopLive` as separate methods; the CLI requires exactly one of `--check` / `--dry-run` / `--live`
- [ ] `hop` check exit 1 → `ok` with `data.hop_recommended: true`; exit 2 → `backend-error` with `record`; NOT-READY / PARTIAL → cli exit 5 with `record.left_open`
- [ ] `status` merges `usage_watch status --json --no-spend` and `launch_gate --status --json` into `{accounts, recommendation, gate}`
- [ ] Contract test: for each op, run the real script against the fixture and check output keys against `script_output` (and refusal `record` shapes); a missing or extra required key fails
- [ ] CLI verbs `admit`, `launch`, `status`, `fleet`, `hop`, `policy` with `--json`; `stratum session --help` lists all nine

Tests: golden flow on the fixture: `policy` → `status` → `admit --account auto --launch-gate full` → `launch` with `DETACH_JOB_ENGINE_OVERRIDE`
pointing at a fixture engine script that writes the report (the existing seam, `detach_job.py:104`, popped from the child at `:1833-1834`) →
`jobs` shows the job → `hop --check` on the fixture transport (U8). Error table: one row per refusal code reachable from these ops; an argv table
asserting the exact subprocess argv per hop mode (recorded through a fixture `python` shim that writes its argv and execs the real python).

Probes: (1) `admit --engine claude --label x --account seat2` with no `--model` → exit 1 `gate-denied`, reason names "explicit model";
(2) `admit --model opus` with marker text lacking `hard:` → `gate-denied`; with `hard: probe of the opus rule` on stdin → admitted, and `ps`
during the call shows no marker text in any argv; (3) `admit --account inherit` with `CLAUDE_CONFIG_DIR` unset → exit 1 `account-unset`;
(4) `launch --account seat3 --engine claude` → meta `account: seat3`, no `account_pick`, launches log has exactly one new row;
(5) Admission owners row 1 and row 2 probes (gate blocked → `launch-gate-timeout` exit 3, no engine process, empty fixture registry) for
claude and codex; (6) `launch` whose brief is missing → exit 1 `marker-unreadable`, nothing launched; brief with `hard:` + `--model opus` →
admitted; brief without → `gate-denied`; (7) argv table: check = `['--check=NAME','--json']`, dry-run contains `--dry-run`, neither contains
the other's flag, live is reachable only via `hopLive`; (8) `hop --check` on a fixture with a stale reading → exit 4 `backend-error`,
`record.result == 'UNKNOWN'`; (9) inherited `LAUNCH_GATE_ADMITTED=x` in the caller env + `launch --label x` → the gate still runs (one row).

### SESSION-MGMT-1-U3 — MCP tools (S)

Files: `stratum/ts/src/mcp/server.ts` (existing: `ToolName` union `:62-68`, dispatch `switch`), `stratum/ts/contracts/mcp-surface.json`
(existing: add the eight tools, bump `surface`), `stratum/ts/tests/session/mcp.test.ts` (new), `stratum/CHANGELOG.md`, `stratum/README.md`.

- [ ] The eight tools in `mcp_tools.tools`, each returning the envelope as a normal result; a refusal is never an MCP error
- [ ] `stratum_session_hop` input `mode` is the enum `['check','dry-run']`; the handler calls only `hopCheck` / `hopDryRun`; a test asserts the MCP module has no reference to `hopLive` (import-graph / grep check)
- [ ] `stratum_session_admit` uses the MCP server's own env as the child env and takes `marker_text` as a field sent on stdin
- [ ] Surface contract test (existing harness in `mcp/contracts.ts`) passes with the new tools
- [ ] Tool descriptions say plainly which tools start work (`launch`, `register`) and which only read

Tests: drive the MCP server in-process (the existing server test pattern), fixture as U2; one row per tool plus the live-hop rejection rows.

Probes: (1) `stratum_session_status` on the fixture returns `ok:true` and the fixture accounts; (2) `stratum_session_hop {mode:"live"}` →
surface validator rejects it, and the fixture `python` shim records no `session_hop.py` call; (3) `stratum_session_hop {mode:"check"}` → the
shim's argv is exactly the contract's check argv; (4) `stratum_session_admit` in mode `none` → admitted pass-through; (5) unknown field →
rejected.

### SESSION-MGMT-1-U4 — the policy block and its one reader (P)

Files: `claude/scripts/usage-watch.accounts.json` (existing: add `session_policy` with today's values), `claude/scripts/session_policy.py`
(new: `load_policy()`, `accounts_path()`, `--json` CLI), `claude/scripts/usage_watch.py` (existing: `accounts_path` at `:96-97` delegates to
`session_policy.accounts_path`, nothing else), `claude/scripts/json-contract.json` (existing: `session_policy` key),
`claude/scripts/tests/test_session_policy.py` (new).

- [ ] Block and values exactly `policy_schema` defaults; `version: 1`; a `_doc` line naming this plan
- [ ] `load_policy()` is the only code that reads `session_policy`; precedence env > file > default; malformed field = one WARNING + default; unknown key = one WARNING
- [ ] `seat_map` keeps every string-valued entry, retired or unknown accounts included (contract `seat_map.validation`); only a non-string value is dropped, with a WARNING
- [ ] `session_policy.py --json` prints `{path, values, sources, warnings}`, basename only, never env values
- [ ] `usage_watch.accounts_path` and `session_policy.accounts_path` resolve the same path for: no env, `USAGE_WATCH_ACCOUNTS` set, explicit arg
- [ ] `test_max_sunset.py`, `test_max_sunset_4.py` and `test_seat_reserve.py` failure counts unchanged (3 known failing rows in the last, OPS-GATE-TESTS-STALE-1), re-counted on the post-MAX-SUNSET-7 base

Tests: table over fields × {absent, valid, wrong type, out of range, env override}, one row per case (about 40 rows, not a product).

Probes: (1) block deleted → `--json` values equal the defaults, all sources `default`; (2) `launch_gate.spacing_s: "45"` (string) → one
WARNING, value 45, source `default`; (3) `LAUNCH_GATE_SPACING=10` → value 10, source `env:LAUNCH_GATE_SPACING`; (4) `seat_map` naming `max`
with the fixture clock past `retire_after` → entry KEPT, no warning from the reader (seat_relaunch refuses it, U7); (5) `usage_watch.py status
--json` on the fixture is byte-identical before and after the block is added.

### SESSION-MGMT-1-U5 — launch gate reads the policy; JSON status (A)

Files: `claude/scripts/launch_gate.py` (existing: `Config` `:80-97` takes defaults from `load_policy()`, env still wins; `main` `:614-632`
accepts `['--status','--json']` and `['--fleet','--json']`), `claude/scripts/json-contract.json` (keys `launch_gate status`, `launch_gate fleet`),
`claude/scripts/tests/test_launch_gate_policy.py` (new).

- [ ] With today's values in the file, every existing `test_launch_gate.py` and `test_launch_gate_fifo.py` row passes unchanged
- [ ] A value in the file changes the decision; the same variable in env overrides the file
- [ ] `--status --json` carries the facts of the text `status_report` in the contract shape; read-only (no lock, no record), same as the text form
- [ ] An unreadable policy file never blocks a launch differently from today: WARNING + defaults
- [ ] Docstring env list (`:50-55`) says the file is the default source

Tests: rows for each of the five numbers (file only, env over file, malformed), plus `--status --json` and `--fleet --json` shape rows.

Probes: (1) file `fleet_max: 2`, fixture registry with 2 alive claude jobs → `--status --json` `engines.claude.would_pass` false, reason fleet;
(2) same with `LAUNCH_GATE_FLEET_MAX=5` → would pass; (3) `--fleet --json` → `{count: 2, max: 2, jobs: [...]}`; (4) `--status --json --x` → exit 2.

### SESSION-MGMT-1-U6 — quota limit and seat ceiling from the policy (A)

Files: `claude/hooks/work_model_gate.py` (existing: the uses of `QUOTA_LIMIT_PCT` `:72` read `load_policy()`; the constant stays as the
built-in default), `claude/scripts/usage_watch.py` (existing: the default ceiling in `seat_limits` reads `load_policy()`; `DEFAULT_SEAT_CEILING_PCT`
`:64` stays as the built-in default; re-read by symbol after MAX-SUNSET-7 adds its retired marker to the same function),
`claude/scripts/tests/test_admission_policy.py` (new).

- [ ] No behaviour change with today's values (parity rows for `pick` and `judge` on both sides of each threshold)
- [ ] `admission.quota_limit_pct: 90` in the file → the gate denies at 90% (the owner's rollback line in `work-model.md` becomes a data edit)
- [ ] `admission.default_seat_ceiling_pct: 80` → `pick` skips a seat at 80%; a row's own `ceiling_pct` and owner sessions still lower it
- [ ] MAX-SUNSET-7's retired marker is still read by `seat_limits` unchanged (a parity row with a marker present)
- [ ] The hook reads the file once per process; a read failure is WARNING + default and never a traceback in the hook
- [ ] Hook latency: the shim's timing log (`claude_shim.py` `_timed`) shows no new stage over 50 ms on the fixture

Tests: table of thresholds × {default, file value, malformed}; reuses `test_max_sunset.py` fixtures.

Probes: (1) quota reading 95%, file 100 → allowed; file 90 → denied with the quota reason; (2) seat at 85%, default ceiling from file 80 →
`pick` state `closed`; (3) malformed `quota_limit_pct: 0` → WARNING, 100 used.

### SESSION-MGMT-1-U7 — seat map from the policy; account-aware launch function; JSON relaunch print (A)

Files: `claude/scripts/seat_relaunch.py` (existing: `SEAT_MAP` `:29-31` and `SESSIONS` `:32-33` come from `load_policy()["seat_map"]`; `command`
`:85-90` takes its launcher from `usage_watch.launch_function` instead of `ccd + seat[-1]`; `main` `:93-121` adds `--json`),
`claude/scripts/usage_watch.py` (existing: `launch_function(account)` factored out of `launch_command` `:1851-1860`, which then uses it; no other
change), `claude/scripts/tests/test_seats.py` (existing: add rows; old `sm-*` names keep working), `json-contract.json` (`seat_relaunch`).

- [ ] Map from the file equals today's map (parity row over all 11 names)
- [ ] `launch_function` returns `ccdN` only for a Claude row whose `config_dir` resolves to `~/.claude-seatN` (N 1-4), `ccd` for `~/.claude`, None otherwise; `launch_command` output is byte-identical to today for every fixture row
- [ ] Every map name yields one row in `--all` and in `--all --json`; a rejected name is a refusal row (contract `relaunch_print.script_output.refused`: `unknown-account`, `no-launch-function`, `retired`, `no-resume`, `no-seat`), never omitted; others still print
- [ ] Never prints a `CLAUDE_CONFIG_DIR` prefix (owner 2026-10-15, `usage_watch.py:1851-1853`)

Probes: (1) `--all --json` on the fixture → 11 rows; (2) file maps `s1-chat` to `seat2` → its command starts `ccd2 `; (3) mapped to `max` past
retire → row `refused.code == 'retired'`, exit 1, the other rows present; (4) a fixture Claude row `seat9` with `config_dir ~/.claude-team9`
and `s4-infra: seat9` → row `refused.code == 'no-launch-function'` (today it would print `ccd9`, a function that does not exist);
(5) `s4-infra: nosuch` → `unknown-account` row.

### SESSION-MGMT-1-U8 — session_hop JSON output and a fixture transport (A)

Files: `claude/scripts/session_hop.py` (existing: `main` `:1441`; one JSON object per run when `--json`, same exit codes; `default_env`
`:568-573` builds a fixture iTerm from `SESSION_HOP_ITERM_FIXTURE` when set, contract `test_fixture`), `claude/scripts/tests/test_session_hop.py`
(existing: add rows; the fixture transport reuses the test file's `FakeITerm` shape, `:89`), `json-contract.json` (`session_hop`).

- [ ] `--json` changes the output form only: same exits (`:13-18`), same WARNING lines on stderr, same ledger writes, same check-mode hop log (`:1453`)
- [ ] Every exit path prints exactly one JSON object (contract `operations.hop.script_output`), including `refuse()` paths, `ap.error` is untouched (exit 2, usage text on stderr, no JSON), and the `UNKNOWN` check lines with `reason`
- [ ] `hop_recommended` set per contract in check mode; `left_open` lists tab ids for NOT-READY and PARTIAL, `[]` otherwise
- [ ] `SESSION_HOP_ITERM_FIXTURE`: tabs read from the JSON file; every write method (type, exit, close, open) raises; when unset, `HopITerm()` exactly as today

Probes: (1) `--dry-run --json -- NAME` on the fixture transport → `result: "DRY-RUN"`, exit 0, the fixture file unchanged; (2) `--to=seat9
--json -- NAME` → `REFUSED`, exit 2; (3) `--check=NAME --json` with no readings → `UNKNOWN`, exit 2, `reason` non-empty; (4) stdout parses as
one JSON document on every row; (5) the fixture transport with a live hop argv → the first write raises, exit 5 or 2, no real iTerm call
(the test asserts `HopITerm` is never constructed).

### SESSION-MGMT-1-U9 — `session_admit.py`: one admission question for every launch (A)

hard: composes three admission paths (account resolve, `judge()`, launch gate) without a second copy of any rule; security-tagged.

Files: `claude/scripts/session_admit.py` (new), `claude/scripts/tests/test_session_admit.py` (new), `json-contract.json` (`session_admit`).

- [ ] Account `inherit`: claude with `CLAUDE_CONFIG_DIR` unset or empty in its own env → `account-unset` (D7, D9); otherwise `detach_job.resolve_account` (`:313-336`) on its own env; `unknown` → `account-unknown`. Codex reads `CODEX_HOME` (default `~/.codex`, `detach_job.py:144`) the same way
- [ ] Account `auto`: claude = `usage_watch.pick(kind='author')`; codex = `pick(kind='review', author_vendor='claude')` (`usage_watch.py:1946`); the chosen row's vendor must equal `--engine`, else `no-eligible-account`; pick exit 3 → `ahead-of-pace`
- [ ] Account id: must be a row of the engine's vendor, else `account-unknown`
- [ ] Retired or reserved accounts refuse through `seat_limits` (the one source; MAX-SUNSET-7's marker included); no date literal anywhere
- [ ] Claude: one `work_model_gate.Launch(route="session-admit", models=[model], text=<marker>, need_model=True, config_dir=<chosen home>, label=label)` and `judge()`; any reason → `gate-denied` with the text verbatim. Codex: `judge` check `skip`
- [ ] Marker: `--marker-file` read with `work_model_gate._read_file` after an `isfile` + `R_OK` check (`marker-unreadable` otherwise); else stdin, at most 262144 bytes
- [ ] `--launch-gate full` runs `launch_gate.py <label> --engine E` with `LAUNCH_GATE_MAX_WAIT=<max_wait_s>` ALWAYS set; its stdout goes to this script's stderr (stdout stays one JSON document); exit 1 → `launch-gate-refused`, 3 → `launch-gate-timeout`; `none` skips it
- [ ] Output and exits exactly `operations.admit.script_output` / `script_exit`; admitted `env` has exactly one key, the engine home, absolute and resolved, `inherit` included

Tests: one table: account mode × outcome rows (claude inherit set / unset / empty / unregistered / retired; codex inherit default / set;
auto claude ok / none eligible / ahead of pace / overflow kind never used; auto codex ok / no codex row; auto with a pick result of the other
vendor (fixture) → `no-eligible-account`; id ok / wrong vendor), model rows (none, sonnet, opus with and without `hard:`, haiku), marker rows
(stdin, file, missing file, directory, empty file), gate rows (none, full pass, refused, timeout with `LAUNCH_GATE_LOAD_MAX=0`).

Probes: (1) `--engine claude --model sonnet --account seat2` → admitted, `env == {CLAUDE_CONFIG_DIR: <abs>/.claude-seat2}`;
(2) `--account inherit` with `CLAUDE_CONFIG_DIR=<fixture>/.claude-seat3` → admitted, `env.CLAUDE_CONFIG_DIR` is that path (never `{}`);
(3) `--account inherit` with the variable unset → exit 1 `account-unset`; (4) `--engine codex --account auto` with both vendors in the fixture →
the choice is the codex row; (5) `--model opus`, stdin without `hard:` → `gate-denied`; (6) `--launch-gate full --max-wait-s 1` with load cap 0
→ exit 3 `launch-gate-timeout`, nothing in the launches log, stdout one JSON document; (7) stdout never contains the marker text.

### SESSION-MGMT-1-U10 — detach_job JSON launch output (A)

Files: `claude/scripts/detach_job.py` (existing: `run --json` replaces the text print `:2893-2895` with one JSON object; `admit_launch`
`:2813-2829` takes `json_mode` and sends the gate subprocess's stdout to stderr when set (today it inherits stdout, `:2827`); the refusal
path `:2910-2919` prints `{refused: true, reason}` on stdout when `--json`), `claude/scripts/tests/test_detach_json.py` (new),
`json-contract.json` (`detach_job run`).

- [ ] `run --json` prints exactly one JSON document `{pid, pgid, log, meta, label, session, account}`; `account` from `resolve_account`
- [ ] With `--json`, the nested launch gate's text goes to stderr; stdout carries only the JSON document
- [ ] A refusal with `--json` prints `{refused: true, reason}` on stdout and keeps the exit code; without `--json` every output is byte-identical to today
- [ ] No other behaviour change (gate decisions, report reservation, MCP flags, the engine-override gate skip at `:2820`)

Tests: (a) in-process `admit_launch(..., json_mode=True)` with the REAL `launch_gate.py` and fixture gate state, captured file descriptors:
fd 1 empty, gate text on fd 2 (the full `run` cannot reach the gate under the engine override, which skips it at `:2820`, existing and kept);
(b) subprocess `run --json` under the override: stdout is exactly one JSON document.

Probes: (1) `run --json` with `DETACH_JOB_ENGINE_OVERRIDE` fixture engine → one JSON document with an integer pid, exit 0; (2) a report path
inside the index dir → refused JSON, exit 1; (3) without `--json` the output is byte-identical to before; (4) test (a) above.

### SESSION-MGMT-1-U11 — Stratum's Claude runs go through the door (C)

hard: account selection inside Stratum's runner and worker-thread lifecycle (`background.ts` claude path, cancellation and peer registration
must not change), and the admitted env must be the env the SDK child gets.

Files: `stratum/ts/src/connectors/runner.ts` (existing: foreground admit at `:187-189` before `new ClaudeConnector`),
`stratum/ts/src/connectors/background.ts` (existing: `startClaudeBackgroundRun` `:452` admits with `launch_gate full` after `:469`, before
`newRunDir` `:471`, and passes `connectorOptions.env = childEnv` at `:496`), `stratum/ts/src/mcp/server.ts` + `stratum/ts/contracts/mcp-surface.json`
(existing: optional `account` param on `stratum_agent_run`, default `inherit`), `stratum/ts/tests/session/claude-admit.test.ts` (new),
`stratum/ts/tests/session/launch-sites.test.ts` (new: the closure guard in `## Admission owners`), `stratum/CHANGELOG.md`.

- [ ] Foreground (row 4): `admit(engine claude, run model, account, launch_gate none, marker = prompt head)` with `childEnv = options.env ?? process.env` (the env `claude.ts:101` would use); the connector is built with `env: childEnv` from the result
- [ ] Background (row 5): one admit with `launch_gate full` before any run dir or worker; the worker's connector gets `env: childEnv` and does not admit
- [ ] `assertAdmittedEnv` runs on the env the connector passes to the SDK, after its scrub (`claude.ts:101-102`); mismatch → `admission-env-mismatch`, no SDK call
- [ ] Refused: the run fails before any SDK call or worker with the refusal code and reason in the run result
- [ ] Mode `none`: behaviour identical to today (existing connector tests pass unchanged)
- [ ] Closure guard test passes (exact constructor list)

Tests: fixture backend dir + the SDK test seam (`ClaudeConnectorOptions.query`, `claude.ts:49`) so no real Claude starts; rows: inherit ok,
inherit unset (`account-unset`), inherit retired, auto, explicit id, gate-denied, backend-unavailable, mode none, background gate blocked,
**ambient process env names seat1 while `options.env` names seat3** (admitted and launched home are both seat3), **ambient seat1 while
`options.env` has no `CLAUDE_CONFIG_DIR`** (`account-unset`, never the default home).

Probes: (1) `stratum_agent_run agent=claude model=sonnet account=seat3` → the seam sees `CLAUDE_CONFIG_DIR` ending `.claude-seat3`;
(2) `model=opus` with no `hard:` in the prompt → `gate-denied`, seam never called; (3) mode `none` → the seam's env equals today's;
(4) background, gate blocked → no run dir, no worker, launches log unchanged; (5) the two ambient-vs-child rows above.

### SESSION-MGMT-1-U12 — Stratum's background Codex runs are admitted and registered (C)

Files: `stratum/ts/src/connectors/background.ts` (existing: the codex branch of `startBackgroundRun` `:170-298`; admit after
`resolveCodexModel` `:214` and before `newRunDir` `:216`, so it covers BOTH strategies, app-server driver `:246` and exec spawn `:255`; the
spawn env `:231-240` is built from the admitted `childEnv`), `stratum/ts/src/mcp/server.ts` + `mcp-surface.json` (existing: optional
`jobs_session` param on `stratum_agent_run`), `stratum/ts/tests/session/codex-register.test.ts` (new), `stratum/CHANGELOG.md`.

- [ ] Before any run dir or child: `admit(engine codex, launch_gate full, account default inherit)` for both strategies (row 6)
- [ ] After spawn: `register --session <S> --kind stratum --id <runId> --pid <pid> --log <streamPath> --vendor codex --model <model> --account <admitted id>`, where S = the `jobs_session` param, else env `STRATUM_JOBS_SESSION`, else the literal `stratum` (a registry `launch_gate --fleet` and status pages read like any other session's); S passes `jobs.py check_session` (`jobs.py:204-208`) or the param is a usage error before launch
- [ ] A failed registration (registry refusal or backend error) warns and keeps the run (the run already exists), and the warning is in the run meta
- [ ] Mode `none`: unchanged (no admit, no registration)

Probes: (1) fixture backend, a codex bg run with a fake command and `jobs_session: "fx-sess"` → `jobs list --session fx-sess --json` shows
exactly one row with `session fx-sess`, `id <runId>`, the pid, `vendor codex`; without the param and env → session `stratum`;
(2) gate blocked, once with `STRATUM_CODEX_BG_STRATEGY=exec` and once with `app-server` → `launch-gate-timeout`, no run dir, nothing spawned;
(3) registry dir unwritable → run continues, meta carries the warning.

### SESSION-MGMT-1-U13 — Compose's `spawn('claude')` sites go through the door (C)

Files: `compose/server/session-door.js` (new: `sessionConfigured(env)`, `admitClaude(...)`, `assertAdmittedEnv`, `SessionRefusal`; contract
`library.compose_helper`, `backend.configured_test.compose_impl`), `compose/server/agent-spawn.js` (existing `:50-63`), `compose/server/vision-utils.js`
(existing `:128-134`), `compose/server/summarizer.js` (existing `:71-80`), `compose/test/session-door.test.js` (new: also runs Stratum's
`configured-fixtures.json` from the sibling checkout path), `compose/test/launch-sites.test.js` (new: closure guard), `compose/CHANGELOG.md`.

- [ ] Each site builds its candidate env exactly as today (`cleanEnv`), calls `admitClaude({..., childEnv: cleanEnv, launchGate})` with the level in `## Admission owners` rows 7-9, and spawns with the returned `childEnv` only; `CLAUDECODE` stays deleted; `assertAdmittedEnv` right before `spawn`
- [ ] `admitClaude` runs `stratum session admit --json` with `env = childEnv` (D8), marker text on stdin
- [ ] **CLI found → Compose never runs its own detector; Stratum's `admit` decides** (mode none = candidate env unchanged). `sessionConfigured` runs only when `resolveStratumBin('cli')` throws, and is the conservative superset in C `backend.configured_test.compose_impl` (the user config path not proven absent, i.e. `statSync` succeeds or fails with anything but ENOENT/ENOTDIR, reads configured; U1 fix round 1)
- [ ] On every row of the shared fixture table (header spellings `[session]`, `[ session ]`, `["session"]`, `['session']`, dotted, inline included): Stratum configured ⇒ `sessionConfigured` true; rows where only Compose says configured are listed in the table, never the reverse
- [ ] **Configured (by the superset) and the stratum CLI not found → `SessionRefusal backend-unavailable`, no spawn.** Not configured → today's behaviour, one INFO line at server start, not per call
- [ ] `agent-spawn.js` and `vision-utils.js` pass an explicit Sonnet-class `--model` (D6)
- [ ] Refusal: agent-spawn answers HTTP 409 `{error, code}` (exit-1 codes) or 503 (exit-3 and exit-4 codes); journal agent logs one line with the code; summarizer resolves its existing failure value; none spawn
- [ ] Tests set `NODE_ENV=test` so no real `claude` starts

Probes: (1) fixture `STRATUM_SESSION_SCRIPTS_DIR` + stub `claude` on PATH that records its env → `POST /api/agent/spawn` → stub saw
`CLAUDE_CONFIG_DIR` of the admitted seat and `--model`; (2) every seat closed → 409 `no-eligible-account`, stub never ran;
(3) **configured (env set) + no stratum bin → 503 `backend-unavailable`, stub never ran**; (4) not configured + no stratum bin → stub ran with
today's env; (5) **configured + parent env with no `CLAUDE_CONFIG_DIR`, account inherit → refusal `account-unset`, stub never ran**, for the
spawn path and for the summarizer; (6) gate blocked → agent-spawn 503 `launch-gate-timeout`, stub never ran; (7) **(R2-H1) env unset, user
config file with `[ session ]` + `scripts_dir`, then again with `["session"]` + `scripts_dir`, no stratum bin → 503 `backend-unavailable`,
stub never ran**, for agent-spawn and the summarizer; the same two files with a stub CLI present → the stub's admit was called and Compose's
own detector was not (spy).

### SESSION-MGMT-1-U14 — Compose's Agent-SDK `query()` sites (C)

Files: `compose/server/agent-workspace.js` (existing: `_buildOptions` `:189-195` env, `_startQuery` `:202-204`), `compose/lib/local-claude-connector.js`
(existing: env build `:195-196`, `query` call `:272`), `compose/test/session-door-sdk.test.js` (new), `compose/CHANGELOG.md`.

- [ ] Both sites build the candidate env as today (`{...process.env, COMPOSE_TARGET}`; `opts.env ?? process.env`), call `admitClaude` (rows 10-11, `launchGate 'none'`) once per query start with it as `childEnv`, and put the returned `childEnv` into the SDK `env` option
- [ ] `local-claude-connector` keeps its `SENSITIVE_ENV_VARS` scrub (`:29`, which does not list `CLAUDE_CONFIG_DIR`) after the merge; `assertAdmittedEnv` runs on the scrubbed env
- [ ] Refusal surfaces as the connector's existing error path with the refusal code; mode `none` unchanged

Probes: (1) the injected `query` seam receives `env.CLAUDE_CONFIG_DIR` of the admitted seat; (2) **ambient `process.env` names seat1 while
`opts.env` names seat3** → admitted and launched home both seat3; (3) **`opts.env` without `CLAUDE_CONFIG_DIR`, configured** → `account-unset`,
seam never called; (5) mode `none` → env identical to today; (6) **(R2-H1) env unset, user config with `[ session ]`, then `["session"]`,
plus `scripts_dir`, no stratum bin → `backend-unavailable`, seam never called**, for both SDK sites.

### Finding 19 activation (coordinator step after U14 lands, fix round 2 R2-H2; not a unit, not behind U15)

Landed code is not protection: the Compose processes on this Mac stay unconfigured until the Mac has a `[session]` table and the running
Compose has loaded U13/U14. So this Mac's activation for the Compose sites moves out of U15 to right after U14 lands (U15's other deps,
U3/U6/U7/U12 and MAX-SUNSET-6, do not gate it). forge-e0 does it, in this order, and writes `units/SESSION-MGMT-1/f19-live-check.md`:

- [ ] Install the Mac's user config `[session] scripts_dir = "/Users/ruze/.claude/scripts"` (`~/.stratum/config.toml`); from here the Mac is "configured" (D7)
- [ ] Read-only check: `env -u CLAUDE_CONFIG_DIR stratum session admit --json` (account `inherit`, launch gate `none`; admit starts nothing) refuses `account-unset` (exit 1); `stratum session policy --json` reports configured
- [ ] **Compose processes run the new code:** every Compose server process on this Mac (`ps -A -o pid,lstart,command | grep '[c]ompose'`, the PyCharm codex-acp one included) started after U14's land time. Restarting them is the owner's action (never start or kill servers without the owner): forge-e0 sends the owner the restart ask via s1-chat with the pid list
- [ ] Live, one call: one Compose summarizer call on this Mac logs an admitted seat; `usage_watch status` shows no new session on `~/.claude`

**LIVE** (the word the checkpoint in `## Order vs MAX-SUNSET` uses) = all four boxes ticked with timestamps in `f19-live-check.md`. Commits
landing is not LIVE.

### SESSION-MGMT-1-U15 — install, one live check, docs (O)

Files: `stratum/README.md` (`stratum session` section), `stratum/docs/features/SESSION-MGMT-1/feature.json` (status), the Mac's
`~/.stratum/config.toml` (already installed by the Finding 19 activation step; U15 only checks it is present), a one-line pointer in `claude/rules/session-management.md` to `stratum session` (after MAX-SUNSET-6 and with the owner's
yes), `units/SESSION-MGMT-1/live-check.md`.

- [ ] Restart the stratum MCP processes after install (a running MCP keeps old modules)
- [ ] Live, read-only: `stratum session status --json` shows the account rows; `stratum session policy --json` shows all sources `file`
- [ ] Live, one launch: one Compose summarizer call on this Mac records the admitted seat in its log line, and `usage_watch status` shows no session on `~/.claude` started by it
- [ ] Live, fail-closed: with `STRATUM_SESSION_SCRIPTS_DIR` pointed at an empty fixture dir for one `stratum session admit --json` call → exit 4 `backend-unavailable` (no launch)
- [ ] Docs list every verb and tool and point at `session-contract.json`

Probes: the four live lines above, pasted with timestamps; `ps -o pid,ppid,command | grep stratum-mcp` shows new start times.

## Dependency graph

Computed, not eyeballed: `forge/scratch/2026-10-19-session-mgmt-plan/units.json` (the "Depends on" column above, 15 units, 21 edges),
validated by `estimate.py plan` (it rejects cycles and unknown deps). Fix round 1 added no internal edge: every fix sits inside an existing
unit. The scratch file is disposable: it is the "Depends on" column above, regenerable from the Units table. 10 of the 21 edges are cross-repo.

```
ops:    U4 ──> U5 ──┐            U6, U7 ───────────────────────────┐
        U8 ─────────┤                                              │
        U9 ─────────┼──> U2 ──> U3 ──> U11 ──> U12 ──┐             │
        U10 ────────┤     │                          ├──> U15 <────┘
stratum:U1 ─────────┘     └──> U13 ──> U14 ──────────┘
```

| Unit | Direct dependents | All downstream |
|---|---|---|
| U4 (policy) | 4 (U2, U5, U6, U7) | 10 |
| U2 (front door ops) | 4 (U3, U11, U12, U13) | 6 |
| U1, U5, U8, U9, U10 | 1 each (U2) | 7 each |
| U3 | 2 | 3 |
| the rest | 0-1 | 0-2 |

**Hubs:** U4 (most downstream) and U2 (the fan-in point: every script-side adapter feeds it, every call site waits on it).

**Execution rounds** (longest-path levels, with the cutover waits applied):
- **Round 0, now** (owner Q1): U1.
- After MAX-SUNSET-5 **and** -7 land and s2-coord reports the hold list released (`order-input.md:14`):
  round 1: U4, U8, U9, U10 · round 2: U5, U6, U7 · round 3: U2 · round 4: U3, U13 · round 5: U11, U14 · round 6: U12 ·
  round 7: U15 (also after MAX-SUNSET-6).
- U8, U9, U10 need only -7; if -7 lands well before -5, they may run then (round 1a), and U4's branch follows when -5 lands. Width 4 at most
  after round 0; chain 7 (U4 → U5 → U2 → U3 → U11 → U12 → U15).

**Bottleneck:** not agent hours. The serial points are (a) the cutover wait (-5 and -7) before round 1, (b) U2, which needs five script-side
units landed and installed in the ops checkout before its contract tests run against real scripts. Controller-serial work per unit is
landing and installing (ops units are installed by the coordinator into the live `~/.claude/scripts`). The fewest-cuts partition is the repo
split (ops | stratum | compose).

## Order vs MAX-SUNSET

**Rule (the class, fix round 1):** a unit waits for every MAX-SUNSET unit that edits a file the unit edits **or imports a function from**,
directly, or through any unit it depends on. The release signal is s2-coord's report that the hold list is free (`order-input.md:14`), not a
date. Source of the per-file map: `order-input.md:7-12` (s2-coord, 17:4x), cross-checked with the MAX-SUNSET-5 and -7 briefs.

State of the cutover units (checked at ops `543da2dd`, re-checked at `1decaced`: no `claude/` change between them; s2-coord update
`order-input.md:17-22`, 18:4x): -2 LANDED (`6c4fff37`); -3 LANDED (`523cf56b`, merge `78aee3d8`); -4 LANDED (`28934b33`, merge `98b03936`,
ledger `337786d4`); -5 **authoring** (`order-input.md:20`: new `max_sunset_moves.py` + seat1 ceiling row in the accounts file); -7 next
(`order-input.md:20`); -6 rule text, owner yes.

| Held file (`claude/`) | MAX-SUNSET units that edit it | Still open |
|---|---|---|
| `scripts/usage_watch.py` | -2, -3, -7 | **-7** |
| `scripts/usage-watch.accounts.json` | -2, -5 (seat1 `ceiling_pct`), -7 (backstop date) | **-5, -7** |
| `hooks/work_model_gate.py` | -2 | none |
| `scripts/iterm_sessions.py` | -3 | none |
| `scripts/session_hop.py` | -3, -7 (LOGGED_OUT) | **-7** |
| `scripts/seat_relaunch.py` | -5 (only if `SEAT_MAP` is wrong) | **-5** |
| `scripts/detach_job.py` | -4, -7 (launch auth refusal) | **-7** |
| `scripts/dispatch.py` | -7 | -7 (no unit of this plan edits it; checked: no unit's Files list names it) |
| rule files (`usage-watch.md`, `work-model.md`, `session-management.md`, ...) | -6 | **-6** |

| Unit | Held files it edits or imports from | Direct wait | Transitive wait (via) |
|---|---|---|---|
| U1 | none (stratum only) | none: **start now** (owner Q1) | none |
| U2 | none directly (runs scripts through U4/U8/U9/U10) | none | -5, -7 (U4); -7 (U8, U9, U10) |
| U3 | none | none | -5, -7 (U2) |
| U4 | `usage-watch.accounts.json`, `usage_watch.py` | **-5, -7** | — |
| U5 | none (`launch_gate.py`; imports `session_policy`, new) | none | -5, -7 (U4) |
| U6 | `usage_watch.py`, `work_model_gate.py` | **-7** | -5 (U4) |
| U7 | `seat_relaunch.py`, `usage_watch.py` (`launch_function`) | **-5, -7** | (U4: same) |
| U8 | `session_hop.py` | **-7** | — |
| U9 | imports `detach_job.resolve_account`, `usage_watch.pick` / `seat_limits`, `work_model_gate.judge` / `_read_file` | **-7** | — |
| U10 | `detach_job.py` | **-7** | — |
| U11, U12 | none | none | -5, -7 (U2) |
| U13, U14 | none; absorb MAX-SUNSET-4 Finding 19 (`order-input.md:22`, deadline below) | none | -5, -7 (U2) |
| U15 | `session-management.md` | **-6** | -5, -7 (U3, U6, U7, U12, U14) |

Only U1 starts before the cutover (owner Q1). -5 was "prepared, runs when Max actually fails" (`order-input.md:10`) and is now authoring
(`order-input.md:20`), so the open-ended wait the first draft feared is gone; if -5 stalls, s2-coord can still release the accounts file once -7
lands (a coordinator call, push order, not an owner question).

**External deadline (s2-coord, `order-input.md:22`): MAX-SUNSET-4 Finding 19.** Compose's `claude` spawns (`agent-spawn.js:58` and the other
rows 7-11 of `## Admission owners`) must resolve an account or refuse when `CLAUDE_CONFIG_DIR` is unset, live before **2026-10-30**. U13/U14
are that fix, but they sit at rounds 4-5, behind -5, -7 and U2. **Checkpoint 2026-10-27 (forge-e0 decides, trigger rewritten in fix round 2, R2-H2):** the
test is **"Finding 19 protection is LIVE on this Mac"**, as defined under `### Finding 19 activation` (Mac configured, every running Compose
process started after the protecting code landed, one live summarizer call on an admitted seat, evidence in `f19-live-check.md`), **not**
whether U13/U14 have landed. If it is not LIVE on 2026-10-27, forge-e0 dispatches the interim Compose patch s2-coord named (refuse a spawn when
`CLAUDE_CONFIG_DIR` is unset, every row 7-11 site), a one-file BOUNDED unit outside this plan's graph, even if U13/U14 have landed but the
activation is stuck; U13 later replaces it with `admitClaude`. The interim patch is LIVE under the same process test (Compose restarted after
it landed: the owner's action, asked via s1-chat with the pid list on 2026-10-27). This is a dated external constraint, not a plan date.

## Unclassified

Steps found while mapping that fit no bucket of shape C; reported, not dropped.

1. **`compose/lib/deps.js:376`, `:389`** run `claude plugin install` / `claude plugin marketplace add`. Not an agent launch (no model, no quota
   use). Recommendation: leave alone. Listed in U13's closure guard so a reviewer does not count it as missed.
2. **Stratum foreground Codex and Devin runs, and background Devin** (`background.ts:191`, `startDevinBackgroundRun` `:341`) are not admitted.
   Shape C's call-site bucket names Claude spawns and detached runs. Recommendation: no unit in v1; Codex foreground runs die with the session,
   and Devin has its own quota. Revisit if the launch gate ever caps them.
3. **`compose/server/agent-server.js:5`** imports the SDK `query` and hands it to `createAgentApp` (`:9`); the spawn happens in
   `agent-workspace.js`, covered by U14.
4. **Dispatch caps 20/8/8** stay in `claude/scripts/dispatch-kinds.json` `caps` (owner Q3, ANSWERED). No unit.
5. **A library consumer constructing `ClaudeConnector` directly** (outside `runner.ts` / `claude-bg-worker.ts`) is not admitted; the in-repo list
   is fixed by U11's closure guard. Published-package consumers are outside this Mac's quota pools.

## Sizing

All lines below: `python3 ~/.claude/scripts/estimate.py ...` run 2026-10-19 18:4x (fix round 1), quoted as printed. **Basis for every line in a
block is the `as_of` printed on that block's own lines**; derived numbers say which line they come from.

`estimate.py stats`:
- `forge: landed/day 2.6 (last 7d, 18 landed) dispatch->landed p50 0.9h p80 2.7h, dispatch->author_done p50 0.4h, review rounds p50 n/a, n=18 as_of 2026-10-19T16:15`
- `main: landed/day 22.6 (last 7d, 158 landed) dispatch->landed p50 0.8h p80 2.1h, dispatch->author_done p50 0.2h, review rounds p50 2, n=158 as_of 2026-10-19T18:12`

`estimate.py plan units.json --like forge --name SESSION-MGMT-1` (basis forge n=18 as_of 2026-10-19T16:15, all three lines):
- `chain 7 units, 7 rounds at width 4 (measured max in flight, last 7d)`
- `agent-hours 6.2h (15 units x 0.4h dispatch->author_done p50)`
- `ESTIMATE SESSION-MGMT-1 P50 6h P80 19h chain 7 units 15 width 4 basis forge n=18 as_of 2026-10-19T16:15`

`estimate.py plan units.json --like main --name SESSION-MGMT-1` (the ops lane, where U4-U10 land; basis main n=158 as_of 2026-10-19T18:12, all three lines):
- `chain 7 units, 7 rounds at width 47 (measured max in flight, last 7d)`
- `agent-hours 3.1h (15 units x 0.2h dispatch->author_done p50)`
- `ESTIMATE SESSION-MGMT-1 P50 6h P80 15h chain 7 units 15 width 47 basis main n=158 as_of 2026-10-19T18:12`

Read: **critical-path authoring** is the 7-unit chain U4 → U5 → U2 → U3 → U11 → U12 → U15, **about 2.8h, derived** from the forge
`dispatch->author_done p50 0.4h` (as_of 2026-10-19T16:15) × 7. **Overhead** is everything else in the P50/P80: landing, installs, the security
units' one pre-land review (11 of 15 are tagged now, U12 added in fix round 1, so more review wait than forge's basis assumes, where
`review rounds p50 n/a`). U2 grew in fix round 1 (launch sequencing, three hop modes) and is now Opus with per-op checkpoints; its authoring
time is not separately measured. **Not counted by either estimate:** the wait for MAX-SUNSET-5 and -7 before round 1 (open-ended for -5, see
`## Order vs MAX-SUNSET`) and -6 before U15. No calendar dates.

## Risks

- **Finding 19 deadline (2026-10-30)** (`## Order vs MAX-SUNSET`): U13/U14 are four rounds behind the cutover. Fallback: the interim Compose
  refuse-when-unset patch, decided by forge-e0 on 2026-10-27.
- **-5 or -7 stalls** (`## Order vs MAX-SUNSET`): every unit after U1 waits on them. -5 is authoring now; s2-coord can release the accounts
  file once -7 lands.
- **Configured mode refuses unset `CLAUDE_CONFIG_DIR` (D7, D9).** Any caller on this Mac whose env has no `CLAUDE_CONFIG_DIR` (for example a
  session started with bare `ccd` on Max, whose MCP children inherit that env) gets `account-unset` from Stratum and Compose until it passes
  `account: "auto"` or an id. Intended by the owner's Q2 ruling; U15's docs say it in the first paragraph.
- **Max's home must be launched UNSET, not as `~/.claude` (added 2026-10-19 19:1x, s2-coord evidence; unverified by forge-e0 beyond one run).**
  A detached `claude -p` with `CLAUDE_CONFIG_DIR=/Users/ruze/.claude` died "Not logged in · Please run /login" at 19:08 (U1 launch 2, log
  `units/SESSION-MGMT-1/SESSION-MGMT-1-U1-author.log` at that time), while s2-coord's Max author launched with `env -u CLAUDE_CONFIG_DIR`
  finished READY. D8's "admit always returns an absolute engine home" would set exactly the failing value for Max. Until Max retires
  (2026-10-30), U9 (`session_admit.py`) and U2 (`launch`) must treat the default-home account (accounts row `default: true`) as "home =
  unset": the patch removes `CLAUDE_CONFIG_DIR`, and `assertAdmittedEnv` checks it is absent. Probe: U9 admits `account max` and the
  returned env carries the unset marker, not `~/.claude`. If Max has retired by the time U9 is authored, U9 refuses `max` instead and this
  row closes. MAX-SUNSET-7 adds logged-out detection to `pick`, which stops it choosing a Max that cannot run.
- **Security-tagged share is high (11 of 15).** Each keeps one pre-land review. The coordinator can batch U4/U6/U7 (one ops diff), U11/U12
  (one Stratum diff) and U13/U14 (one Compose diff) if the reviewer agrees.
- **Compose and Stratum are published packages.** Behaviour changes only when `configured(env)` is true (D7), so external users see no change.
  Releasing new versions to npm is owner-only; until a release, only this Mac (dev symlink `compose/node_modules/@smartmemory/stratum` →
  `stratum/ts`) runs the new code. A stale running MCP keeps old modules: U15 restarts it.
- **Two `configured` implementations** (Stratum TOML, Compose line match) can drift. Control: one shared fixture table run by both suites, and
  every deviation errs toward configured (fail closed).
- **Hook latency.** U6 adds a file read to the PreToolUse gate. Mitigation: read once per process, measured in U6's acceptance.
- **STRAT-SERVICE-1 dropped an "MCP thin client" (design.md:161, :515).** U3 adds MCP tools over the scripts. Different thing (STRAT-SERVICE-1
  dropped a client for a daemon that was never built), and the owner picked C with MCP tools named.
- **D6 changes Compose defaults:** two spawns that inherited the account's default model now pass a Sonnet-class default; an Opus default would
  be refused without `hard:`.
- **`session_admit` drift from `detach_job`.** U9 calls `detach_job.resolve_account` itself, never a copy; `## Admission owners` row 1's probe
  asserts `detach_job` makes no second selection.
- **Line numbers move.** MAX-SUNSET-5 and -7 will shift lines in `usage_watch.py`, `session_hop.py`, `detach_job.py`, `seat_relaunch.py`; briefs
  re-read by symbol name.

## Questions

1. **May the first Stratum piece start before the Max cutover lands?** **ANSWERED 2026-10-19 17:59 (owner via s1-chat): yes, start U1 now.**
   It touches no cutover file.
2. **For people who use Stratum or Compose without our scripts, should launches still work as today?** **ANSWERED 2026-10-19 17:59 (owner via
   s1-chat): pass through when the session scripts are NOT configured; refuse once they ARE configured; on this Mac a missing script still
   blocks.** Applied as D7 (one deterministic `configured` test; every configured failure refuses, an unset `CLAUDE_CONFIG_DIR` included) and D9.
3. **Should the dispatcher's caps (20 jobs total, 8 Opus, 8 Codex) also move into the one settings file?** **ANSWERED 2026-10-19 17:59 (owner
   via s1-chat): no, caps stay in `dispatch-kinds.json`.**

No open owner questions. One dated checkpoint: forge-e0 on 2026-10-27 decides the interim Compose patch for Finding 19 if U13/U14 have not
landed (`## Order vs MAX-SUNSET`).

## Fix round 1

Review: `units/SESSION-MGMT-1/plan-review-r1.md` (NOT CLEAN, 9 HIGH, 11 MEDIUM, 5 LOW). Every finding was fixed as its class (rule 2). "P"
sections are of this file; "C" keys are of `session-contract.json` (now version 2).

| # | Finding (severity, one line) | What changed (section / key) | Probe added |
|---|---|---|---|
| 1 | HIGH: U4 edits `usage_watch.py` + accounts file, no -7 wait | P `## Order vs MAX-SUNSET` (new class rule, per-file table, per-unit table), Units table, Execution rounds: U4 waits -5, -7 | (order, no runtime probe) every held file mapped to its open MAX-SUNSET units |
| 2 | HIGH: U6 edits `usage_watch.py`, no -7 wait | same; U6 waits -7 directly and -5 via U4; U6 acceptance: -7 marker parity row | U6 marker parity row |
| 3 | HIGH: U8 edits `session_hop.py`, no -7 wait | same; U8 waits -7 | — |
| 4 | HIGH: U10 edits `detach_job.py`, no -7 wait | same; U10 waits -7 | — |
| 5 | HIGH: fail-open launch (mode none admits, Compose launches when the CLI is missing even if configured; unset dir → `~/.claude`) | P D7, D9, U1 (`configured.ts`, project-file rejection), U13 (configured + no bin refuses), U15 (live fail-closed line); C `backend.configured_test`, `backend.modes`, `refusal_codes.account-unset`, `library.compose_helper` | U1 probes 1-2; U13 probes 3, 5; U14 probe 3-4; U2 probe 3; U9 probe 3; U15 live line 4 |
| 6 | HIGH: admitted env can differ from launched env; empty patch for inherit | P D8, `## Admission owners`, U2/U11/U13/U14 acceptance; C `backend.child_env_rule`, `admit.input.child_env`, `admit.script_output.env` (never empty, inherit included), `library.child_env_check`, `library.compose_helper`, `refusal_codes.admission-env-mismatch` | U9 probe 2; U11 ambient-vs-child rows + probe 5; U14 probes 2-3 |
| 7 | HIGH: background Claude skips the full gate | P D3 rule, `## Admission owners` row 5, U11 acceptance (one full admit before run dir/worker; worker does not re-admit) | U11 probe 4 |
| 8 | HIGH: front-door launch of Codex never takes the full gate | P `## Admission owners` rows 1-2, U2 launch acceptance; C `operations.launch.steps` (admit `full` for both engines, `LAUNCH_GATE_ADMITTED` set by the door, stripped from inherited env) | U2 probes 5, 9 |
| 9 | HIGH: hop check argv selects the live branch | P D4, U2/U3 acceptance (three backend methods, MCP enum); C `operations.hop.script_argv_by_mode`, `argv_derivation` (session_hop.py:1443-1452) | U2 probe 7 + argv table; U3 probes 2-3; U8 probe 5 |
| 10 | MED: `jobs.py add` prints JSON, contract said none | C `jobs_register.script_output` = the stored event (jobs.py:296-312, :1162-1164); U1 acceptance validates it | U1 probe 7 |
| 11 | MED: launch stdout not one JSON document | U10: gate stdout → stderr under `--json`; C `launch.stdout_rule`; U9 does the same for its own gate call | U10 test (a)/(b), probe 4; U9 probe 6 |
| 12 | MED: auto selection not vendor-constrained | C `admit.input.account` (claude `author`, codex `review`+`author_vendor claude`, vendor check); U9 acceptance | U9 probe 4 + auto rows (both vendors, overflow, other-vendor result, no row) |
| 13 | MED: stdin closed vs marker on stdin | C `backend.stdin` (admit is the bounded exception); U1, U2 acceptance | U2 probe 2 (`ps` shows no marker in argv) |
| 14 | MED: refusal payload outside the envelope; check exit 1 `data.hop` missing | C `envelope.refused.record`, `envelope.partial`, `hop.script_output.hop_recommended`/`reason`; U1, U2, U8 acceptance | U1 probe 3; U2 probe 8; U8 probe 3 |
| 15 | MED: arbitrary seat id → wrong `ccdN`; retired entries silently skipped | U7 (`launch_function`, refusal rows); U4 (reader keeps entries); C `relaunch_print`, `seat_map.validation` | U7 probes 3-5; U4 probe 4 |
| 16 | MED: real-script fixtures incomplete (hop reads real tabs, SEAT_*, detach defaults) | C `test_fixture` (HOME, every override, `LAUNCH_GATE_STATE_DIR`, `SESSION_HOP_ITERM_FIXTURE`, leak gate, teardown); P Units preamble; U8 fixture transport | U8 probes 1, 5; leak gate in every script suite |
| 17 | MED: U12 registration has no `--session` | U12 (`jobs_session` param > `STRATUM_JOBS_SESSION` > `stratum`, `check_session`) | U12 probe 1 (exact session, id, pid, vendor) |
| 18 | MED: launch never passes the brief to admit | C `admit.input.marker_file`, `launch.steps` 1; U9 marker acceptance (gate's `_read_file`, FILE_CAP) | U2 probe 6 (valid / missing / no-marker brief); U9 marker rows |
| 19 | MED: invented `LAUNCH_GATE_MAX_WAIT` default 600 | C `admit.input.max_wait_s` (always exported; unset = forever, launch_gate.py:53, :96-97), `launch.timeout_s`, `launch.steps` 2 | U9 probe 6; U2 probe 5 |
| 20 | MED: U12 cited the Devin wrapper as the Codex spawn | U12 Files: admit at `background.ts:214-216`, both strategies `:246`, `:255` | U12 probe 2 (both strategies) |
| 21 | LOW: launch print reference | C `_source.launch` and U10: `detach_job.py:2893-2895` at `543da2dd` (moved since the review's snapshot; MAX-SUNSET-4 landed) | — |
| 22 | LOW: `_choice` reference incomplete | C `_source.pick`: `usage_watch.py:2046-2048` | — |
| 23 | LOW: `main` start reference | Re-read at `543da2dd`: `main` is at `session_hop.py:1441` now (MAX-SUNSET-3 moved it); C `_source.hop` cites `:1441-1449`; briefs re-read by symbol | — |
| 24 | LOW: check described as side-effect free | C `hop.side_effects` (check writes its diagnostic log, kept); U8 acceptance | — |
| 25 | LOW: sizing lines lack their own `as_of` | P `## Sizing`: re-run, one basis per block, 2.8h marked as derived | — |

Also folded in (from the review's "Checked OK" item 6): U2 per-operation checkpoints. New owner and state facts recorded: Q1-Q3 ANSWERED;
Max reserved by `766f3b69` then un-reserved by `50596555` (D9); -3 and -4 landed.

## Fix round 2 (coordinator, no re-review, rule 5)

Review: `units/SESSION-MGMT-1/plan-review-r2.md` (NOT CLEAN, 2 HIGH; r1 rows 1-4 and 6-9 FIXED, row 5 PARTIAL only through these two). Plans
get at most 2 review rounds (`no-claude-coding.md` rule 5), so forge-e0 fixed both as their class and logged it; there is no round 3.

| # | Finding (severity, one line) | What changed (section / key) | Probe added |
|---|---|---|---|
| R2-H1 | HIGH: Compose's literal-header regex misses `[ session ]` / `["session"]` that Stratum's TOML parse sees, so a missing CLI passes through to `~/.claude` | Class = "Compose's detector disagrees with Stratum's". C `configured_test.compose_impl`: with the CLI found Compose never decides (Stratum's `admit` does); with the CLI missing the detector is a superset (any `session` substring or `\u`/`\U` escape, or unreadable). C `configured_test.fixtures`: rule is stratum ⇒ compose, rows for every header spelling, dotted, inline, comment and string-value cases, run with and without the CLI. C `library.compose_helper`. P U13 acceptance (2 new boxes) | U13 probe 7, U14 probe 6, fixture rows |
| R2-H2 | HIGH: the 10-27 checkpoint keys on U13/U14 *landing*, while this Mac's activation waits for U15 | Class = "landed is not live". New P `### Finding 19 activation` right after U14 (Mac config, Compose processes restarted after land via the owner, one live call); defines LIVE. Checkpoint in `## Order vs MAX-SUNSET` now keys on LIVE and fires even if U13/U14 landed; the interim patch has the same LIVE test. U15 and D7 no longer install the config | `f19-live-check.md` (4 timestamped lines) |

No interface another unit depends on changed: `admitClaude`'s signature is the same; only its decision order and the Compose-only fallback
detector changed, both inside U13.

## ELI5 TLDR

- **Surprise: the first plan had real holes in the locks.** A reviewer found ways a launch could slip past the checks: background Stratum jobs
  and Codex launches skipped the "slow down, the machine is busy" gate, the check could approve one account while the job started on another,
  a "just look" hop command could have done a real hop, and if Stratum was missing Compose would launch anyway.
- All of those are now closed on paper, each with a test that would catch it: one owner per check per launch path, the exact environment
  that was approved is the one that starts, and "look only" hops can't reach the real one.
- Your answer on outside users is applied exactly: no scripts set up = nothing changes for them; scripts set up (this Mac) = anything missing
  or unclear blocks the launch, including a session with no account folder set. Max is never used by accident, only when asked for.
- Four pieces were scheduled too early against the Max cutover; now everything except the first Stratum piece waits for the last two cutover
  steps.
- One date matters: Compose must stop launching on the wrong account by Oct 30. The real fix comes late in this plan, so on Oct 27 we
  check, and if it is not in yet a small stopgap goes in first.
- Round 2 found two last gaps, both fixed: Compose could misread some ways of writing the settings file, and "the code is merged" was
  being treated as "the protection is on". Now Oct 27 checks that it is actually on (which needs you to restart Compose once).
- **Decision for you: none.**

VERDICT: PLANNED 15 units
