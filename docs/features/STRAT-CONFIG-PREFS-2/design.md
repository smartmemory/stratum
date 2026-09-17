# STRAT-CONFIG-PREFS-2 — Claude dispatches read the config too (plug-in + settings-source axes)

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-09-17
**Depends On:** `STRAT-CONFIG-PREFS-1` (shipped the layered resolver and the four sandbox axes this
extends; nothing here introduces a new config file or a new layer)

## Related Documents

- [`STRAT-CONFIG-PREFS-1`](../STRAT-CONFIG-PREFS-1/design.md) — the resolver, the four axes, the
  provenance contract. This is a follow-up to it, not a parallel system.
- `compose/docs/features/COMP-MODEL-ROUTE-1/evidence/root-cause-toolsearch-deferral-2026-09-16.md`
  — the ToolSearch investigation that surfaced this; fixed in `f250d9e`.

## Scope guard, read this first

**This is not a security feature and must not be sold as one.** It was investigated as one and the
security framing died under its own evidence: compose's `orchestrator` template grants `Bash`
(`server/agent-templates.js:27`), and anything reachable through a plug-in is reachable through a
shell. A tool list containing `Bash` is not a boundary, so closing a gap in it buys no containment.

The two things that survive scrutiny:

1. **Machine-dependent behaviour.** A Claude dispatch's effective permissions are read from
   `~/.claude/settings.json` on the host. Behaviour therefore varies by whose laptop runs the job.
   For a product with users who are not us, that alone is the defect.
2. **A narrow data-quality risk.** The user's settings carry a blanket pass for the memory server
   (`mcp__smartmemory__*`). Saving a lesson mid-task is a natural thing for an agent to do, unlike
   deploying, so an unattended step plausibly writes there with no record of which run did it.

If neither of those matters for a given deployment, **do nothing** is a defensible outcome.

## The finding (measured 2026-09-17)

Three facts, each verified against the rebuilt `dist`, not inferred.

**1. `allowedTools` does not bind MCP tools.** It maps to the SDK `tools` option, which governs
built-ins. Three arms, identical but for the tool list, `cwd` = compose:

| Arm | SDK `tools` | Reached permission layer | Outcome |
|---|---|---|---|
| preset (control) | preset | yes | real directory listing |
| `allowedTools: ["Read"]` | `["Read","ToolSearch"]` | **yes** | **real directory listing** |
| + `disallowedTools: [target]` | `["Read","ToolSearch"]` | no | undiscoverable, refused |

A step declaring `Read` as its only tool discovered and invoked an MCP tool and got real data.
`disallowedTools` **does** bind, hard — the denied tool was not even findable via ToolSearch. So the
one restriction compose actually relies on (review steps deny `Edit`/`Write`) is correctly enforced.

A first attempt at this probe was **invalid and discarded**: control and treatment failed
identically because both were stopped by the permission layer before the tool list mattered. The
table above was produced with a `canUseTool` callback so the two layers could be told apart.

**2. Permissions come from disk, not from the launcher.** Re-run with all 14 `CLAUDE*` env vars
stripped: identical result. There is no inheritance from the parent session. `SettingSource` is
`'user' | 'project' | 'local'` — filesystem locations, all loaded when `settingSources` is omitted,
which is what `ClaudeConnector` does. CLI, Claude Code MCP, Codex MCP and cron are all the same.

**3. The asymmetry.** Codex dispatches get a declared, defaulted, per-axis-audited policy.
`ClaudeConnector`'s options are model, cwd, two tool lists, and process-control knobs. No sandbox,
`permissionMode` hardcoded to `acceptEdits`, and no `sandbox_policy` audit event. Stratum owns Codex
policy deliberately and owns nothing for Claude.

Host exposure measured on this machine: 463 allow rules in `~/.claude/settings.json`, 54 of them
MCP, of which 5 are write-capable or wildcards (`mcp__smartmemory__*`,
`mcp__github__create_repository`, `mcp__scalemate__deploy`, `mcp__scalemate__deploy_ui`,
`mcp__scalemate-test__base44_update`). Not pre-approved means denied, so the blast radius is
bounded by that list rather than open.

## Design

**No new config file and no new layer.** `stratum.toml` / `~/.stratum/config.toml` and the
defaults→user→project→dispatch→env resolver already exist and already carry per-key provenance.
This adds keys to `SandboxPolicy` and one connector read.

Two new axes, chosen because they are the only ones Claude can actually honour:

- `mcpServers` — which plug-in servers a dispatch may reach. **Deny by default**, opt-in per step.
  Enforced through the SDK's `canUseTool` callback, which is the real seam: the probe confirms
  `tools` cannot express this and `canUseTool` can.
- `settingSources` — which of user/project/local to load. Default to project-local so behaviour is
  machine-independent. `user` becomes an explicit opt-in line for those who want today's
  convenience, recorded rather than silent.

Then: `ClaudeConnector` resolves the config (it currently ignores it entirely), and a Claude
dispatch emits the same `sandbox_policy` audit record the Codex path already emits.

### Enforcement is NOT symmetric, and the config must say so

`filesystemMode` and `networkAccess` stay **Codex-only**. Codex gets OS-level Seatbelt; the Claude
SDK offers no equivalent, and `canUseTool` is a gate the agent passes through, not a sandbox — a
shell command still reaches the whole machine. Marking these axes per-provider is required. Claiming
parity would be the worst outcome of this feature. Wrapping the Claude subprocess in an OS sandbox
is a separate piece of work, not in scope, and note `sandbox-exec` cannot nest
(`project_codex_seatbelt_nonnesting`).

### Precedence is a ceiling

Project config sets the maximum a dispatch may have. A step narrows, never widens. Prevents a
template escalating itself. This mirrors the existing fail-closed treatment of
`danger-full-access`, which a config may select but only `STRATUM_CODEX_ALLOW_FULL_ACCESS`
authorizes.

## Acceptance criteria

- [ ] `mcpServers` axis on `SandboxPolicy`, deny-by-default, resolved through the existing layers
- [ ] `settingSources` axis, defaulting to project-local
- [ ] `ClaudeConnector` resolves and applies both; enforcement via `canUseTool`
- [ ] Claude dispatches emit `sandbox_policy` with per-axis provenance
- [ ] `filesystemMode` / `networkAccess` documented and typed as Codex-only, not silently ignored
- [ ] Step declarations can narrow but never widen the project ceiling
- [ ] RED→GREEN test: a dispatch with a narrow list cannot reach an unlisted MCP server (today it can)
- [ ] RED→GREEN test: a dispatch is unaffected by `~/.claude/settings.json` under the new default

## Rollout

Phase 1 is observability only and is the honest place to start: record the effective policy for
Claude dispatches and change no behaviour. That makes the rest arguable with data instead of
argument, and it is where the cost/benefit should be re-checked before building phases 2 and 3.
Phase 2 adds the axes with `user` inheritance still on by default. Phase 3 flips the default once
phase 1 data shows what breaks.

## Open question

Should stratum detect that it is running inside a Codex sandbox (compose as a Codex MCP server) and
refuse to dispatch a sandboxed Codex with a clear error? Seatbelt cannot nest — verified 2026-05-18
— so that path fails at startup in a way that reads like a bug. The provenance chain already models
layers; the host would be one more. **Not verified for this specific chain**, only inferred from the
non-nesting result.
