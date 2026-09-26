# STRAT-AGENT-DEVIN-1 — Implementation plan

**Status:** IN_PROGRESS (S1 COMPLETE, S2 next) · **Created:** 2026-09-26 · Design: `design.md` r6 (`c5d1142`), gate closed by the owner.

## Related Documents

- `docs/features/STRAT-AGENT-DEVIN-1/design.md` — decisions D1–D11, §Tests, §Slices (this plan refines
  S1 into S1a + S1b; S2, S3 unchanged)
- `docs/features/STRAT-AGENT-RUN-MODEL-VALIDATE/design.md`, `STRAT-AGENT-BG`, `STRAT-AGENT-PEER-1`

## Roles

**From S2 on (owner, 2026-09-26: "now that codex is back we should go back to using it"):** Codex
`gpt-6-astra/medium` implements and reviews. Devin is only the *subject* of this feature, never the
builder — nothing is dispatched to Devin. Claude briefs (one slice, named files), runs the tests that
spawn devin under `sandbox-exec` (nested seatbelt cannot run inside Codex's sandbox), adjudicates and
commits. Codex runs unsandboxed with `TMPDIR` pinned outside every git repo so tests needing `ps` work.

*History:* S1a/S1b were implemented by Devin SWE-2 High (owner, 2026-09-26) in write mode under the
stratum-owned seatbelt while Codex was unavailable; Codex astra/medium reviewed S1 (three rounds,
final round CLEAN at `39bec17`).

## Slice S1a — agent list, models, env, config (no process spawn)

**COMPLETE** — `c24b332` (S1b's review fixes `6ad2dc4` touched S1a surfaces too).

Design: D1, D6, D7, D11. Everything here is table-driven and unit-testable without devin installed.

Files: `ts/src/connectors/base.ts` (existing), `ts/src/connectors/runner.ts` (existing),
`ts/src/connectors/foreground_registry.ts` (existing, type + parse guard only),
`ts/src/mcp/server.ts` (existing), `ts/src/judge/pricing.ts` (existing),
`ts/src/connectors/devin-model.ts` (new), `ts/src/config/types.ts` (existing),
`ts/src/config/index.ts` (existing), `ts/tests/connectors/devin-settings.test.ts` (new),
`ts/tests/connectors/agent-equality.test.ts` (new), `ts/tests/config/*` (existing, extend).

- [x] `AgentType` += `"devin"`; `AGENT_TYPES = ["claude","codex","devin"] as const` exported from
      `base.ts`; every validator and error text (runner, background record parse, foreground
      registry, MCP server) derives from it (D1)
- [x] every agent branch is an exhaustive `switch` with a `never` default — incl.
      `validateAgentSettings` (`runner.ts:167-190`) and the claude-only option forwarding
      (`runner.ts:126-129`); a devin dispatch with `thinking`/`allowedTools`/`disallowedTools` fails
      with codex's wording naming "devin" (D1)
- [x] `DEVIN_MODEL_PRICING` in `judge/pricing.ts` (`swe-2-medium|high|max` = 0/0/0; separate from
      `MODEL_PRICING`, `dispatchableModels()` unchanged) (D6)
- [x] `resolveDevinModel(model?, effort?)` in `devin-model.ts`: full id, family + effort, slash form;
      default `swe-2-high`; unknown id / unknown effort / full id + conflicting effort rejected naming
      the valid set; family→effort table derived from the pricing ids (D6)
- [x] validation at the MCP boundary (`server.ts:191` beside codex), in `runAgent`, and in
      `startBackgroundRun` (D6)
- [x] `DEVIN_SCRUB_VARS` (D7 list) exported for the connector (applied in S1b)
- [x] `ConfigLayer` += `"enforced"`; `loadStratumConfig` gains an `agent` option — devin reads **no**
      `STRATUM_CODEX_*` env and has no env layer; `fullAccessAuthorization(env, agent)` →
      `STRATUM_DEVIN_ALLOW_FULL_ACCESS` for devin, codex call sites unchanged (D11)
- [x] devin policy resolution: `approvalPolicy` from a config file ignored; explicit dispatch
      `approvalPolicy` rejected; explicit dispatch `networkAccess:false` rejected with the D3 message;
      resolved default `false` accepted (D3 network, D11)
- [x] devin `sandboxAudit` shape: `networkAccess: true`, `approvalPolicy: "never"`, both with
      provenance `{layer:"enforced", source:"devin: …"}`; `filesystemMode`/`writableRoots` as resolved
- [x] tests: the D6/D11 rows of the design's error-harness table; the equality check table over
      `AGENT_TYPES` (every codex parameter accepted for devin or rejected with a named devin error)
- [x] `tsc --noEmit` clean; `tests/connectors tests/config tests/mcp` green (controller-run)

Out of S1a: anything that spawns devin, writes a profile, or touches run dirs.

## Slice S1b — foreground connector: per-run home, wrapper, profile

**COMPLETE** — `ad2ac8d` S1b · `1f906bd` full golden 1 · `6ad2dc4` review fixes (3M+2L) · `39bec17`
success-path group reap. Codex impl review round 3 CLEAN.

Design: D2, D3, D4 (foreground path), D10 (brief wording only).

Files: `ts/src/connectors/devin.ts` (new, `DevinConnector`), `ts/src/connectors/devin-sandbox.ts`
(new: profile generator + grant check), `ts/src/connectors/devin-wrapper.ts` (new: wrapper script
text + credential sweep), `ts/src/connectors/codex-policy.ts` (existing: GUI preamble moves to
`base.ts` as a shared helper), `ts/src/connectors/runner.ts` (existing, wiring),
`ts/tests/connectors/devin.test.ts` (new, spawn seam + recorded ATIF fixtures),
`ts/tests/connectors/devin-sandbox.test.ts` (new), `ts/tests/connectors/devin-wrapper.test.ts` (new,
real shell + stub devin), `ts/tests/connectors/devin.live.test.ts` (new, golden 1),
`ts/tests/fixtures/devin/*.json` (new, scrubbed real exports).

- [x] run-dir layout: `runDir` 0700 under `~/.stratum/ts/devin_fg/<id>` (foreground); supervisor
      files in `runDir`, agent-writable area `A = runDir/agent` only (D2)
- [x] per-run home: `A/home/{data,cache,config,state}`, `A/tmp`; `mcp_config.json` + stratum
      `config.json` written by stratum; missing credentials ⇒ `devin is not logged in (run \`devin
      auth\`)` before spawn (D2)
- [x] wrapper (outside the sandbox): `trap` installed before copying `credentials.toml` into `A`;
      runs `sandbox-exec -f devin.sb devin … > stdout.log`; on any handled exit removes the copy,
      writes `exit.rc` atomically, appends the sentinel to supervisor-only `stream.jsonl` (D2)
- [x] dispatch-time credential sweep over `agent_runs` and `devin_fg`: delete only on `exit.rc`,
      identity `"dead"`, or meta-less dir with copy mtime > 10 min; keep on `"unknown"` (D2)
- [x] profile generator: `(allow default) (deny file-write*) (allow file-write* A [cwd] [roots…]
      /dev/null /dev/tty /dev/ttys* /dev/fd/*) (deny signal) (allow signal (target same-sandbox))`;
      realpath + seatbelt escaping; unescapable path rejected (D3)
- [x] grant check: `cwd` (workspace-write) and every `writableRoots` entry rejected if it overlaps
      `~/.stratum` in either direction (unless inside `A`), both sides realpath'd and case-folded (D3)
- [x] argv always `--permission-mode dangerous --config <A>/…/config.json --respect-workspace-trust
      false --export <A>/trajectory.json --prompt-file <runDir>/prompt.md -p`, stdin `/dev/null`,
      env = D7 scrub + four `XDG_*_HOME` + `TMPDIR` under `A`; `danger-full-access` only with
      `STRATUM_DEVIN_ALLOW_FULL_ACCESS=1` and no `sandbox-exec` (D2, D3)
- [x] result from the ATIF export's last agent step; usage from `final_metrics`; `usd: 0`
      estimated for SWE-2; missing export / no agent step ⇒ `devin produced no trajectory: <stderr
      tail>` (D2, D6)
- [x] D4 rejection detection (stderr line or ATIF rejected-observation, not arbitrary file content)
- [x] empty `Available:` model list ⇒ named transient error, not model validation (D3 fact)
- [x] foreground stdout: codex's overrun rule (kill group + overrun error); stderr keeps last bytes
- [x] Linux: read-only/workspace-write ⇒ named error; macOS only in v1 (D3)
- [x] GUI preamble shared helper applied to devin read-only/workspace-write prompts (D3)
- [x] tests: remaining error-harness rows of the design for D2/D3/D4; wrapper tests with a real shell
      and a stub `devin` (exit 0, non-zero, signal death, `sandbox-exec` start failure, SIGTERM);
      golden 1 (live, `swe-2-medium`, controller-run)
- [x] `tsc --noEmit` clean; connector tests green (controller-run)

## Slice S2 — background (design §Slices 2)

Design: D8, D2 (background half: run-dir layout, `exit.rc`, narration log), D3/D6/D7/D11 as already
built in S1. Goldens 3 and 4.

**Prior art checked (2026-09-26, HEAD `39bec17`).** `startDevinBackgroundRun` exists as an S1a
validation-only stub that throws (`background.ts:330-342`). `loadMeta` already accepts `agent:"devin"`
with a numeric `childPid` (`background.ts:694`) but derives only `stream.jsonl` and `stream.jsonl.err`.
`DevinRunMeta` is declared (`background.ts:97-103`). `peerName` already has the devin prefix
(`peer-registry.ts:38-42`) but `agent` is optional and defaults to codex, and the codex path calls it
without `agent` at `background.ts:240,293`. The foreground connector (`devin.ts:124-386`) already owns
every pre-spawn step S2 needs (sweep, credentials check, `prepareDevinRunHome`, grant check, prompt,
profile and wrapper files, argv, env) and the whole terminal verdict (`readTrajectory`,
`rejectionReason`, `coldCacheModelError`, `buildResult`). S2 **extracts and shares** those, it does
not copy them.

**Gaps the design did not name (found in the prior-art pass):**
- The devin layout writes stderr to `<runDir>/.err` (`devin-wrapper.ts:69`), but `loadMeta` derives
  `stream.jsonl.err`, so a devin poll would read an empty stderr tail. The devin branch of `loadMeta`
  takes every path from `devinRunLayout(runDir)`.
- Poll surfaces `sandboxAudit` for codex only (`background.ts:497`). Devin's enforced-value audit
  (D11) must reach the poll result too.
- The peer sidecar refreshes `updatedAt` on each stream line (`peer-sidecar.ts:352-355`). Devin's
  `stream.jsonl` gets its only line at exit, so a running devin peer's `updatedAt` stays at
  registration time. Named v1 limitation (same class as `stratum watch` showing no devin narration);
  no change to the sidecar.

Files: `ts/src/connectors/devin.ts` (existing: extract shared prep + verdict),
`ts/src/connectors/background.ts` (existing: devin branch in start/poll/cancel/`loadMeta`, codex
`peerName` fix), `ts/src/connectors/peer-registry.ts` (existing: `agent` required),
`ts/src/connectors/devin-wrapper.ts` (existing, only if the shared prep needs a helper there),
`ts/tests/connectors/devin-background.test.ts` (new), `ts/tests/connectors/background.test.ts`
(existing: codex start/poll peer-name agreement), `ts/tests/connectors/peer-registry.test.ts`
(existing, only for call-site updates), `ts/tests/connectors/devin.live.test.ts` (existing: goldens 3
and 4), `CHANGELOG.md` (existing), `README.md` (existing).

**Shared code (one definition, two callers):**
- [ ] `prepareDevinRun(...)` extracted from `DevinConnector.run`/`runInLayout` into `devin.ts`: sweep
      over both devin roots **plus the dispatch's `registryRoot` when it differs**; missing
      credentials ⇒ `devin is not logged in (run \`devin auth\`)` before any run-dir side effect;
      `newRunDir(root)`; `prepareDevinRunHome`; grant check (workspace-write ⇒ `cwd` + `writableRoots`,
      read-only ⇒ none); `prompt.md` (GUI preamble applied), empty `stream.jsonl`, `devin.sb` (sandboxed
      modes only), `wrapper.sh`; returns `{ runId, layout, argv, env, framedPromptChars }`. The
      foreground connector calls it with `devin_fg`, the background with `registryRoot ?? agentRunsRoot()`
- [ ] `devinTerminalVerdict({ rc, exportPath, stderrTail, model })` extracted from `buildResult`: D4
      rejection ⇒ error; cold-cache model error ⇒ error; no final agent step ⇒
      `devin produced no trajectory: <stderr tail>`; rc ≠ 0 ⇒ `devin exited with code <rc>: …`; else
      `{ text, metrics, usd }` (SWE-2 `usd: 0`, `usdSource: "estimated"`). Foreground `buildResult`,
      background poll and background cancel all call it — no second copy of the rules
- [ ] foreground behaviour unchanged: `tests/connectors/devin*.test.ts` pass without edits to their
      assertions (a test may change only where it reaches into a moved private helper)

**Start (`startDevinBackgroundRun`, replaces the S1a stub):**
- [ ] keeps the S1a validation order (network, approvalPolicy, full-access authorisation, model) and
      the Linux refusal (`assertDevinPlatform`); `options.command` (the codex argv seam) ⇒ named error
      `command is not supported for devin`, so the equality table sees a named rejection, not a silent
      ignore; `thinking`/tool filters already rejected upstream (S1a)
- [ ] env = dispatch env minus `DEVIN_SCRUB_VARS` (D7), headless-shell default only on the ambient
      fallback, plus `devinHomeEnv` + `devinWrapperEnv`; **no** `T2F5_*` vars and **no**
      `STRATUM_CODEX_BG_STRATEGY` read (D8)
- [ ] spawn `wrapper.sh <argv>` detached (own process group), stdin ignored, stdout → an fd on
      `stdout.log` (0600), stderr → an fd on `.err` (0600), plain `>`-style file fds with no cap
      (D2 codex parity); both fds closed in the parent after spawn
- [ ] identity: `procStartTime(pid)` missing ⇒ **fail closed** exactly as the foreground (S1
      decision): SIGTERM the group so the wrapper's trap deletes the credentials copy, wait for exit,
      throw `devin wrapper identity could not be captured: …`; never write an identity-less `meta.json`
- [ ] `meta.json` = `DevinRunMeta` (`agent:"devin"`, `childPid` = wrapper pid, `procStartTime`,
      resolved `model`, `sandboxMode`, `promptChars`, `createdAt` stamped before spawn, `peerLabel`,
      `sandboxAudit` = devin's enforced-value audit (D11: `networkAccess:true`,
      `approvalPolicy:"never"`, layer `enforced`), `streamPath` = `<runDir>/stream.jsonl`,
      `stderrPath` = `<runDir>/.err`); meta-write failure ⇒ `killDetachedProcessGroup` then rethrow
      (codex parity; the sweep's meta-less orphan rule covers the copy)
- [ ] peer registration: the codex exec path's best-effort block (2 s race, `shouldRegister`,
      `sweepDeadStratumPeers`, `spawnPeerSidecar`) with `streamPath` = the supervisor-only
      `stream.jsonl` and name `peerName(model, runId, { agent: "devin", label })`. Factor the block
      into one helper used by codex-exec and devin rather than duplicating it
- [ ] returns `{ status:"bg_started", runId, pid, streamPath: <runDir>/stream.jsonl, peerName? }`

**`loadMeta`, poll, cancel:**
- [ ] `loadMeta` devin branch: every path from `devinRunLayout(runDir)` (validated run dir, never the
      record) — `streamPath` = `stream.jsonl`, `stderrPath` = `.err`, new optional `narrationPath` =
      `stdout.log`, plus `exitRcPath` and `exportPath`; codex/claude results unchanged
- [ ] poll devin branch (after the shared peer lookup; the shared `scanStream(stream.jsonl)` may still
      run, it only ever sees the wrapper's line):
      no `exit.rc` + `processIdentityMatches(childPid, procStartTime)` ⇒ `running`, `textTail` =
      bounded tail of `stdout.log`, `eventsSeen: 0`, `streamPath` = `stream.jsonl`, `sandboxAudit`;
      no `exit.rc` + identity gone ⇒ re-read `exit.rc` once (TOCTOU, same shape as codex `#24`), still
      absent ⇒ `error`, reason `child_died_without_sentinel`, `stderrTail` from `.err`;
      `exit.rc` present ⇒ `devinTerminalVerdict` ⇒ `complete` (`text`, `usage`, `split`,
      `usdSource:"estimated"`, `exitCode:0`, `telemetry` with `durationMs` = `exit.rc` mtime −
      `createdAt` and `devinModelIdentity`) or `error` (`exitCode` = rc, `reason`, narration
      `textTail`, `stderrTail`). Codex's `codexErrorMessage`/`scan.error` never consulted for devin (D2)
- [ ] poll surfaces `sandboxAudit` for devin as for codex
- [ ] cancel devin branch: `exit.rc` present ⇒ `devinTerminalVerdict` ⇒ `already_complete` /
      `already_error` (**exit 0 + no export ⇒ `already_error`**, review r1 M5); else the codex
      identity sequence (identity match, `processGroupId(pid) === pid`, re-verify identity, then
      `process.kill(-pid, "SIGTERM")`) ⇒ `cancelled`, any failed check ⇒ `already_error`. SIGTERM only,
      codex parity; golden 4 is the proof it is enough. No `writeSentinelIfAbsent` for devin — the
      wrapper's trap path writes `exit.rc` and the sentinel itself
- [ ] no poll or cancel path ever signals a group whose leader identity no longer matches (pid reuse)

**Peer names (D8):**
- [ ] `peerName`'s `agent` option becomes **required** (type-level), so a missing agent is a compile
      error; the codex calls at `background.ts:240,293` pass `agent:"codex"`; every other call site
      updated; codex names are byte-identical to today's (the default was codex)
- [ ] test: for codex and for devin, the name returned by start equals the name poll reports

**Tests (`devin-background.test.ts`, real shell + stub `devin`/`sandbox-exec` first on `PATH`, temp
`HOME` and `registryRoot` — the `devin-wrapper.test.ts` pattern; never the real `~/.stratum`, never the
real devin, never the real `~/.local/share/devin`):**
- [ ] start ⇒ poll `running` with `textTail` from `stdout.log` ⇒ stub writes an ATIF export and exits 0
      ⇒ poll `complete` with text, tokens and `usd: 0` estimated
- [ ] stub prints `{"__t2f5_done__":0}` to stdout then keeps running ⇒ poll stays `running`, cancel does
      not report `already_*`, the peer record stays non-idle, and after exit `stream.jsonl` holds
      exactly one line whose value equals `exit.rc` (r2 M3, r3 M2, r4 N4)
- [ ] exit 0 + no export ⇒ poll `error` "devin produced no trajectory", cancel `already_error` (M5)
- [ ] exit 0 + export whose last step is a rejected observation ⇒ poll `error` (D4)
- [ ] non-zero exit + valid export ⇒ poll `error` with that `exitCode`
- [ ] wrapper SIGKILLed externally (no `exit.rc`) ⇒ poll `error` `child_died_without_sentinel`
- [ ] cancel mid-run ⇒ `cancelled`; afterwards no process in the group, no `credentials.toml` in the
      run dir, `exit.rc` present, poll `error`
- [ ] after every terminal outcome above, `agent/home/data/devin/credentials.toml` is absent
- [ ] identity-capture failure (seam) ⇒ start throws, no `meta.json`, no credentials copy, group gone
- [ ] meta-write failure (seam) ⇒ start throws, group killed
- [ ] `loadMeta` devin paths: `narrationPath = stdout.log`, `streamPath = stream.jsonl`,
      `stderrPath = .err`; a `meta.json` whose `streamPath` points elsewhere does not redirect reads
- [ ] spawn env has the four `XDG_*_HOME` + `TMPDIR` under `A`, no `T2F5_*`, no scrubbed var; argv
      starts `sandbox-exec -f <runDir>/devin.sb` except under authorised full access
- [ ] `command` seam for devin ⇒ named error; equality table (`agent-equality.test.ts`) still passes

**Goldens (live, controller-run, real devin, `swe-2-medium`, macOS, over the real MCP server —
`stratum_agent_run background:true`, `stratum_agent_poll`, `stratum_cancel_agent_run`):**
- [ ] **golden 3:** start ⇒ poll to `complete` with the same fields as golden 1 (final message, tokens
      > 0, `usd: 0` estimated); start and poll report the same `devin-medium-<runId6>` peer name; the
      prompt makes the agent print `{"__t2f5_done__":0}` early and then keep working — poll stays
      `running` and the peer record stays non-idle with no `peer_idle_notice` until `exit.rc` appears;
      after exit no `credentials.toml` in the run dir; an **outside** `sleep 300` (spawned by the
      test, not in the sandbox) whose pid is in the prompt survives the agent's `kill -STOP <pid>` —
      the kill fails, the process state is not `T`, the run completes; within 5 s of `exit.rc` no
      process remains in the wrapper's process group (if devin descendants linger here, **stop and
      bring it to the owner** — do not add signalling to poll)
- [ ] **golden 4:** a background devin run cancelled mid-flight ⇒ `cancelled`; within the grace
      period no `sandbox-exec`/`devin`/`devin acp` process survives in its group (`ps -g`); no
      `credentials.toml`; poll afterwards reports `error`
- [ ] both goldens back up and verify the real `~/.config/devin/config.json` unchanged; the test's
      `sleep` is killed in `finally`; every run dir the goldens create under `agent_runs` is removed
      in `finally` (testing.md cleanup)

**Docs + gate:**
- [ ] CHANGELOG (same commit): devin background runs; codex `peerName` now passes its agent explicitly
- [ ] README agent section: background devin supported; v1 limitations — `stratum watch` shows no
      devin narration until the run ends, and a running devin peer's `updatedAt` is its registration
      time
- [ ] `tsc --noEmit` clean; `tests/connectors tests/mcp` green (controller-run; rerun the known load
      flakes alone before calling red); goldens 1, 3, 4 live green
- [ ] Codex astra/medium implementation review of S2, then fixes-only rounds (budget ~3; M+ after
      round 3 ⇒ stop and ask the owner)

Out of S2: IR/engine (`agent: devin` in flows, `engine.ts` sandbox forwarding, evaluator route) — S3.
Sidecar changes. A cap on the background `stdout.log` (a follow-up for both agents, D2).

## Slice S3 — engine/IR (design §Slices 3)

D9: IR `agent: devin`, `engine.ts:3858` sandbox forwarding, evaluator `route`. Contract tests, golden 2.

## Acceptance for the feature

- [ ] all four goldens pass on macOS against real devin (controller-run)
- [ ] equality table passes; no agent switch without a `never` default
- [ ] CHANGELOG + README agent list updated in the same commits as the code
- [ ] Codex implementation review CLEAN (or Low-only, adjudicated)
