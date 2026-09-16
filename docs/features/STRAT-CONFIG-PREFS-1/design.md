# STRAT-CONFIG-PREFS-1 — Config switches and user preferences (sandbox policy first)

**Status:** PLANNED
**Priority:** HIGH
**Created:** 2026-09-16
**Depends On:** `STRAT-CODEX-DISPATCH-1` (landed the first sandbox switch as a bare env var; this
generalises it)

## Related Documents

- [`STRAT-CODEX-DISPATCH-1`](../STRAT-CODEX-DISPATCH-1/report.md) — added
  `STRATUM_CODEX_ALLOW_FULL_ACCESS`, the 31st env var and the immediate motivation for this feature.
- `git show python-legacy:src/stratum/project_config.py` — the RETIRED per-project config layer.

## The finding

**The TS engine reads no configuration file at all.** Grepping `ts/src/` for TOML/JSON config reads
returns zero hits. Behaviour is instead controlled by **31 ad-hoc `process.env` reads**:

```
STRATUM_AGENT_FG_ROOT, STRATUM_CANCEL_GRACE_MS, STRATUM_CANCEL_LOCK_WAIT_MS,
STRATUM_CANCEL_TIMEOUT_MS, STRATUM_CODEX_ALLOW_FULL_ACCESS, STRATUM_CODEX_STREAM_LIMIT_BYTES,
STRATUM_CODEX_TRANSPORT, STRATUM_CONSUMERS, STRATUM_GUARD_ALLOW_COMMANDS,
STRATUM_GUARD_CMD_TIMEOUT_S, STRATUM_GUARD_OVERRIDE_TOKEN, STRATUM_GUARD_UPGRADE_DESCRIPTORS,
STRATUM_GUARDS_DIR, STRATUM_JUDGE_BACKEND, STRATUM_JUDGE_FIXTURE, STRATUM_LEARN_APPLY_ENABLED,
STRATUM_LEARN_EGRESS, STRATUM_PEER_*, STRATUM_RUN_LOCK_TIMEOUT_MS, STRATUM_STATE_ROOT, …
```

This is a regression, not an original sin. The Python engine had a real one —
`src/stratum/project_config.py`, docstring *"stratum.toml project config — policy overrides,
capability mapping, connector routing"*, with typed dataclasses and frozen mappings. It died in the
2026-07 TS cutover and **was replaced with nothing**.

The evidence that nobody noticed: `compose/stratum.toml` still sits in the Compose repo, with a
header comment pointing at `stratum/src/stratum/project_config.py` and a `[learn.inline_patch]`
section marked *"Enabled 2026-06-11 per user request"*. **Nothing reads it.** A grep for
`stratum.toml` across Compose returns zero readers. A user preference was set, recorded in a file,
and has been silently inert ever since.

## Why this matters now

`STRAT-CODEX-DISPATCH-1` just added sandbox control as a single boolean env var. Sandbox policy is
not a boolean — it is at least four orthogonal axes:

| Axis | Values | Today |
|---|---|---|
| filesystem mode | `read-only` / `workspace-write` / `danger-full-access` | per-dispatch param |
| network access | on / off | **not exposed** — `sandbox_workspace_write.network_access=true` is a valid Codex key (verified against `--strict-config` 2026-09-16) |
| writable roots | list of paths | **not exposed** — Codex supports `writable_roots` |
| approval policy | `never` / `on-request` / `--approve-for-me` | **not exposed** |

Collapsing those into one env var forces an all-or-nothing choice. The concrete cost: a job needing
only localhost access to FalkorDB currently has to be granted **full machine access**, because
"network on, writes still confined" is not expressible. That is a security regression dressed as a
convenience.

## Scope

Build the layer, with sandbox policy as its first and proving citizen. Do not migrate all 31 env
vars in this feature.

**Precedence chain, lowest to highest:**

1. Built-in defaults (safe: `read-only`, no network)
2. **User preferences** — `~/.stratum/config.toml`, the machine-wide "how I like my agents to run"
3. **Project config** — `<project>/stratum.toml`, committed, shared by the team
4. Per-dispatch parameters — `stratum_agent_run(sandboxMode, networkAccess, …)`
5. Env vars — highest, retained as the CI/escape-hatch override

## Acceptance criteria

- [ ] A config module in `ts/src/` that loads and merges the five layers, with the precedence above
      and a typed result. Port the shape of the retired `project_config.py`, do not reinvent it.
- [ ] Sandbox policy expressed as the four orthogonal axes in the table, not a single mode.
- [ ] `networkAccess` threaded to Codex as `-c sandbox_workspace_write.network_access=true`, usable
      **with `workspace-write`** so a job can reach localhost without full access.
- [ ] `writableRoots` threaded as `-c sandbox_workspace_write.writable_roots=[…]`.
- [ ] **Every effective value is traceable to the layer that set it.** A resolved config must be able
      to report, per key, which layer won. Without this, a silently-ignored preference looks exactly
      like a preference that was honoured — the failure this feature exists to fix.
- [ ] **A config key that is read by nothing fails loudly at load** (unknown-key rejection, mirroring
      Codex's own `--strict-config`). `compose/stratum.toml` sat inert for three months; the point of
      this feature is that it cannot happen again.
- [ ] `STRATUM_CODEX_ALLOW_FULL_ACCESS` keeps working, now as the env layer of the chain.
      `danger-full-access` stays opt-in and fail-closed.
- [ ] Escalating privilege must be recorded in the run's audit trail with the layer that granted it.
- [ ] Tests: precedence resolution per layer, provenance reporting, unknown-key rejection, argv
      assertions for each axis, and the fail-closed path.
- [ ] Resolve the `compose/stratum.toml` fossil in the same change: either the new loader reads it,
      or it is deleted. It does not stay as decoration.

## Explicitly NOT in scope

- Migrating the other 30 env vars. They become candidates once the layer is proven; a big-bang
  migration would bury the sandbox work.
- The gate-based interactive permission escalation (agent hits a denial → human approves mid-run).
  That is a separate feature and should be scoped only after we measure how often a *correctly
  narrowed* sandbox actually gets denied. `network_access` may delete most of that demand.

## Open question

Is `~/.stratum/config.toml` the right home for user preferences, given `STRATUM_STATE_ROOT` already
relocates state? Preferences and state have different lifetimes — state is disposable, preferences
are not. Decide before implementing.
