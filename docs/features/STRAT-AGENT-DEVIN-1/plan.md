# STRAT-AGENT-DEVIN-1 — Implementation plan

**Status:** PLANNED · **Created:** 2026-09-26 · Design: `design.md` r6 (`c5d1142`), gate closed by the owner.

## Related Documents

- `docs/features/STRAT-AGENT-DEVIN-1/design.md` — decisions D1–D11, §Tests, §Slices (this plan refines
  S1 into S1a + S1b; S2, S3 unchanged)
- `docs/features/STRAT-AGENT-RUN-MODEL-VALIDATE/design.md`, `STRAT-AGENT-BG`, `STRAT-AGENT-PEER-1`

## Roles

Devin SWE-2 High implements (owner, 2026-09-26), in write mode under the stratum-owned seatbelt
(the same shape this feature builds). Claude briefs, runs the tests Devin cannot (the sandbox denies
`ps`, so every guard-lock path fails inside it — design §D3), adjudicates and commits. Codex reviews
the implementation when back. Devin never commits.

## Slice S1a — agent list, models, env, config (no process spawn)

Design: D1, D6, D7, D11. Everything here is table-driven and unit-testable without devin installed.

Files: `ts/src/connectors/base.ts` (existing), `ts/src/connectors/runner.ts` (existing),
`ts/src/connectors/foreground_registry.ts` (existing, type + parse guard only),
`ts/src/mcp/server.ts` (existing), `ts/src/judge/pricing.ts` (existing),
`ts/src/connectors/devin-model.ts` (new), `ts/src/config/types.ts` (existing),
`ts/src/config/index.ts` (existing), `ts/tests/connectors/devin-settings.test.ts` (new),
`ts/tests/connectors/agent-equality.test.ts` (new), `ts/tests/config/*` (existing, extend).

- [ ] `AgentType` += `"devin"`; `AGENT_TYPES = ["claude","codex","devin"] as const` exported from
      `base.ts`; every validator and error text (runner, background record parse, foreground
      registry, MCP server) derives from it (D1)
- [ ] every agent branch is an exhaustive `switch` with a `never` default — incl.
      `validateAgentSettings` (`runner.ts:167-190`) and the claude-only option forwarding
      (`runner.ts:126-129`); a devin dispatch with `thinking`/`allowedTools`/`disallowedTools` fails
      with codex's wording naming "devin" (D1)
- [ ] `DEVIN_MODEL_PRICING` in `judge/pricing.ts` (`swe-2-medium|high|max` = 0/0/0; separate from
      `MODEL_PRICING`, `dispatchableModels()` unchanged) (D6)
- [ ] `resolveDevinModel(model?, effort?)` in `devin-model.ts`: full id, family + effort, slash form;
      default `swe-2-high`; unknown id / unknown effort / full id + conflicting effort rejected naming
      the valid set; family→effort table derived from the pricing ids (D6)
- [ ] validation at the MCP boundary (`server.ts:191` beside codex), in `runAgent`, and in
      `startBackgroundRun` (D6)
- [ ] `DEVIN_SCRUB_VARS` (D7 list) exported for the connector (applied in S1b)
- [ ] `ConfigLayer` += `"enforced"`; `loadStratumConfig` gains an `agent` option — devin reads **no**
      `STRATUM_CODEX_*` env and has no env layer; `fullAccessAuthorization(env, agent)` →
      `STRATUM_DEVIN_ALLOW_FULL_ACCESS` for devin, codex call sites unchanged (D11)
- [ ] devin policy resolution: `approvalPolicy` from a config file ignored; explicit dispatch
      `approvalPolicy` rejected; explicit dispatch `networkAccess:false` rejected with the D3 message;
      resolved default `false` accepted (D3 network, D11)
- [ ] devin `sandboxAudit` shape: `networkAccess: true`, `approvalPolicy: "never"`, both with
      provenance `{layer:"enforced", source:"devin: …"}`; `filesystemMode`/`writableRoots` as resolved
- [ ] tests: the D6/D11 rows of the design's error-harness table; the equality check table over
      `AGENT_TYPES` (every codex parameter accepted for devin or rejected with a named devin error)
- [ ] `tsc --noEmit` clean; `tests/connectors tests/config tests/mcp` green (controller-run)

Out of S1a: anything that spawns devin, writes a profile, or touches run dirs.

## Slice S1b — foreground connector: per-run home, wrapper, profile

Design: D2, D3, D4 (foreground path), D10 (brief wording only).

Files: `ts/src/connectors/devin.ts` (new, `DevinConnector`), `ts/src/connectors/devin-sandbox.ts`
(new: profile generator + grant check), `ts/src/connectors/devin-wrapper.ts` (new: wrapper script
text + credential sweep), `ts/src/connectors/codex-policy.ts` (existing: GUI preamble moves to
`base.ts` as a shared helper), `ts/src/connectors/runner.ts` (existing, wiring),
`ts/tests/connectors/devin.test.ts` (new, spawn seam + recorded ATIF fixtures),
`ts/tests/connectors/devin-sandbox.test.ts` (new), `ts/tests/connectors/devin-wrapper.test.ts` (new,
real shell + stub devin), `ts/tests/connectors/devin.live.test.ts` (new, golden 1),
`ts/tests/fixtures/devin/*.json` (new, scrubbed real exports).

- [ ] run-dir layout: `runDir` 0700 under `~/.stratum/ts/devin_fg/<id>` (foreground); supervisor
      files in `runDir`, agent-writable area `A = runDir/agent` only (D2)
- [ ] per-run home: `A/home/{data,cache,config,state}`, `A/tmp`; `mcp_config.json` + stratum
      `config.json` written by stratum; missing credentials ⇒ `devin is not logged in (run \`devin
      auth\`)` before spawn (D2)
- [ ] wrapper (outside the sandbox): `trap` installed before copying `credentials.toml` into `A`;
      runs `sandbox-exec -f devin.sb devin … > stdout.log`; on any handled exit removes the copy,
      writes `exit.rc` atomically, appends the sentinel to supervisor-only `stream.jsonl` (D2)
- [ ] dispatch-time credential sweep over `agent_runs` and `devin_fg`: delete only on `exit.rc`,
      identity `"dead"`, or meta-less dir with copy mtime > 10 min; keep on `"unknown"` (D2)
- [ ] profile generator: `(allow default) (deny file-write*) (allow file-write* A [cwd] [roots…]
      /dev/null /dev/tty /dev/ttys* /dev/fd/*) (deny signal) (allow signal (target same-sandbox))`;
      realpath + seatbelt escaping; unescapable path rejected (D3)
- [ ] grant check: `cwd` (workspace-write) and every `writableRoots` entry rejected if it overlaps
      `~/.stratum` in either direction (unless inside `A`), both sides realpath'd and case-folded (D3)
- [ ] argv always `--permission-mode dangerous --config <A>/…/config.json --respect-workspace-trust
      false --export <A>/trajectory.json --prompt-file <runDir>/prompt.md -p`, stdin `/dev/null`,
      env = D7 scrub + four `XDG_*_HOME` + `TMPDIR` under `A`; `danger-full-access` only with
      `STRATUM_DEVIN_ALLOW_FULL_ACCESS=1` and no `sandbox-exec` (D2, D3)
- [ ] result from the ATIF export's last agent step; usage from `final_metrics`; `usd: 0`
      estimated for SWE-2; missing export / no agent step ⇒ `devin produced no trajectory: <stderr
      tail>` (D2, D6)
- [ ] D4 rejection detection (stderr line or ATIF rejected-observation, not arbitrary file content)
- [ ] empty `Available:` model list ⇒ named transient error, not model validation (D3 fact)
- [ ] foreground stdout: codex's overrun rule (kill group + overrun error); stderr keeps last bytes
- [ ] Linux: read-only/workspace-write ⇒ named error; macOS only in v1 (D3)
- [ ] GUI preamble shared helper applied to devin read-only/workspace-write prompts (D3)
- [ ] tests: remaining error-harness rows of the design for D2/D3/D4; wrapper tests with a real shell
      and a stub `devin` (exit 0, non-zero, signal death, `sandbox-exec` start failure, SIGTERM);
      golden 1 (live, `swe-2-medium`, controller-run)
- [ ] `tsc --noEmit` clean; connector tests green (controller-run)

## Slice S2 — background (design §Slices 2)

D8: own branch in `startBackgroundRun`, `loadMeta` `narrationPath`, export-derived status, cancel,
peer names (incl. codex agent-less `peerName` fix), registry parse. Goldens 3, 4. Planned in detail
after S1b lands.

## Slice S3 — engine/IR (design §Slices 3)

D9: IR `agent: devin`, `engine.ts:3858` sandbox forwarding, evaluator `route`. Contract tests, golden 2.

## Acceptance for the feature

- [ ] all four goldens pass on macOS against real devin (controller-run)
- [ ] equality table passes; no agent switch without a `never` default
- [ ] CHANGELOG + README agent list updated in the same commits as the code
- [ ] Codex implementation review CLEAN (or Low-only, adjudicated)
