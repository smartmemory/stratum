# Design: Codex Write Mode (`STRAT-CODEX-WRITE`)

**Date:** 2026-07-09
**Status:** DESIGN
**Track:** T5 (MCP server / connectors)

## Related Documents

- `docs/plans/2026-03-05-stratum-mcp-cleanup-blueprint.md` — execution-kernel boundary this change lives inside
- Implementation plan: (to be written by `writing-plans` after this design is approved)

## Goal

The codex connector is currently **read-only by construction** — it hardcodes
`--sandbox read-only` in its argv. Today the only consumer that exercises it is
the adversarial code review (T3 of the judge), but the connector is reachable by
**any** caller of the public `stratum_agent_run` tool with `type="codex"` and a
caller-chosen `cwd`. Enable codex to **generate and edit code in the working
directory** by emitting `--sandbox workspace-write`, while keeping read-only the
default so the existing review path is untouched.

## Non-Goals (deferred follow-ups)

- **Dedicated `stratum_codegen` MCP tool** with write-first defaults. v1 adds a
  parameter to the existing tool; a purpose-built codegen tool is filed as a
  follow-up if ergonomics warrant it.
- **Writable Docker jail** (`:rw` bind mount) for OS-isolated writes. v1 writes
  to the real cwd only; the writable-jail follow-up is filed separately.
- **`danger-full-access`** as a reachable mode. The internal connector represents
  the sandbox as a mode string so this is *nameable* later, but v1 connector
  validation **rejects** it — it is not constructible until it has its own
  guardrails, tests, and approval model. The v1 public API exposes only
  read-only vs workspace-write.
- **Write with the durable/reparentable stream.** The durable spawn path
  (`codex.py:727-859`) intentionally survives connector teardown; a write-capable
  child could keep editing after cancel/restart. v1 **rejects** `write=True`
  combined with the durable stream; specifying safe cancellation is a follow-up.

## Current State (grounded)

- `stratum_agent_run` (`stratum-mcp/src/stratum_mcp/server.py:136-162`) is the
  single MCP tool that dispatches to codex via `type="codex"`. There is no
  separate codex tool.
- `CodexConnector` (`stratum-mcp/src/stratum_mcp/connectors/codex.py`) shells out
  to `codex exec` and hardcodes `--sandbox read-only` in **every** argv-build
  site:
  - `run()` — argv at `codex.py:372-385`
  - `stream_events()` — argv at `codex.py:547-560`
  - `_stream_events_durable()` — reparentable spawn, wraps the same argv
    (`codex.py:727-859`)
- The factory (`stratum-mcp/src/stratum_mcp/connectors/factory.py:85-93`)
  constructs `CodexConnector` and already threads `read_jail`.
- The read-only review consumer is the judge T3 pass
  (`stratum/src/stratum/judge/verifier.py:264-291`), which calls
  `stratum_agent_run(type="codex", read_jail=<staging_root>)` and never requests
  write.
- `read_jail` runs codex inside a Docker container with a `:ro` bind mount
  (`stratum/src/stratum/judge/sandbox.py`), a separate/stronger isolation layer.

## Design

### API surface — `write: bool`

Add `write: bool = False` to `stratum_agent_run`.

```python
stratum_agent_run(
    type="codex",
    write=True,        # default False
    prompt=...,
    cwd="/repo",
)
```

- **Codex-only, fail-loud.** `write=True` with a non-codex connector base is
  **rejected** with a clear error, not silently ignored — silently ignoring it
  lets a caller believe a write policy was applied when claude's write is
  actually governed by separate `allowed_tools` / `disallowed_tools`. The
  connector base is resolved with `connector_base(type)` first, so `type` suffix
  variants (e.g. `codex::fast`, `factory.py:24-39`) are handled correctly rather
  than string-matched.
- **`cwd` required for write.** When `write=True`, `cwd` must be supplied and is
  resolved to an absolute path before spawning — otherwise codex would write into
  the server process's cwd. (A stronger allowed-root policy is noted as a
  follow-up.)
- **Caller-agnostic primitive.** Usable ad-hoc (offload grunt implementation) and
  by the Compose build pipeline (implement phase). Compose is the intended first
  consumer but is not required for v1.

### Internal representation — sandbox mode string

At the connector boundary, `write` maps to a **sandbox mode string**, not a bool:

- `write=False → sandbox_mode="read-only"`
- `write=True  → sandbox_mode="workspace-write"`

`CodexConnector.__init__` gains `sandbox_mode: str = "read-only"`. Keeping the
connector on a string keeps `danger-full-access` *nameable* without another API
change, while the public tool API stays the simple bool. **v1 connector
validation accepts only `{"read-only", "workspace-write"}`** and rejects anything
else (including `danger-full-access`).

### The code change

1. Replace the hardcoded `"read-only"` literal with `self.sandbox_mode` at **all**
   argv-build sites in `codex.py` — `run()` (`372-385`), `stream_events()`
   (`547-560`), and the durable spawn path (`727-859`). (An audit for the literal
   is part of the plan so none is missed.)
2. **Explicit end-to-end propagation.** Today `stratum_agent_run` passes no
   sandbox value to `make_agent_connector`, and the factory has no parameter for
   it (`server.py:189-198`, `factory.py:42-54`) — a partial implementation could
   accept `write=True` and still spawn read-only. So: add `sandbox_mode` to the
   factory signature, pass it from the server (derived from `write`), and assert
   the mode through the **public tool path**, not only at the connector.
3. No approval flag is added. `codex exec` is non-interactive by default and will
   not block on an approval prompt; with `workspace-write` codex writes freely
   inside the cwd, and anything requiring escalation beyond the sandbox (network,
   paths outside the tree) is auto-denied rather than surfaced. **This is an
   assumption about the codex CLI, not something the repo proves.** The
   real-backend write test (below) is a **blocking gate**: write mode is not
   considered shipped until that test confirms `codex exec --sandbox
   workspace-write` actually writes and does not hang, and the verified codex CLI
   version is recorded in the implementation report.
4. **Sandbox mode is recorded in run metadata.** The selected `sandbox_mode` /
   `write` is included in the connector's start/init event metadata
   (`codex.py:120-128`, `365-370`) so streamed traces show after the fact whether
   a codex run was read-only or write-capable.

### Guardrails

1. **Env kill-switch `STRATUM_CODEX_ALLOW_WRITE`** — write is enabled by default
   (an **absent** var means enabled). Set to `0` / `false` / `no` to hard-disable.
   When disabled and `write=True` is requested, **raise a clear error** (`codex
   write disabled by STRATUM_CODEX_ALLOW_WRITE`) rather than silently downgrading
   to read-only — a silent downgrade makes a codegen call look successful while
   writing nothing, which is a nastier failure.
2. **`write` + `read_jail` rejected at the connector boundary.** `CodexConnector.
   __init__` raises `ValueError` when `read_jail` is set with any non-read-only
   `sandbox_mode`, with factory- and server-layer validation as defense in depth.
   Rejecting only at `stratum_agent_run` would let internal factory/direct
   connector callers still combine `workspace-write` with `read_jail`, where the
   Docker driver strips `--sandbox` and mounts `:ro` — silently eating writes. The
   writable-jail (`:rw` mount) is a deferred follow-up; the rejection message
   points at it.

### Backward-compatibility (the safety property)

Default is read-only, and the review path (`verifier.py` T3 / `stratum_judge`)
never passes `write`, so it stays read-only and untouched. The review path has
**two lanes** that must both stay covered:

- **Jailed codex** (`read_jail` available): the Docker driver *strips*
  `--sandbox <mode>` and injects `--dangerously-bypass-approvals-and-sandbox`
  (`sandbox.py:351-368, 432-456`). Its safety property is the Docker `:ro` bind +
  `--read-only`, **not** a codex `read-only` flag — so a "review argv still emits
  `--sandbox read-only`" assertion is *wrong* here.
- **Claude cold-read fallback** (no jail driver): T3 falls back to an in-process
  `type="claude"` cold read (`verifier.py:264-291`, `sandbox.py:476-487`).

Both lanes are asserted separately (see Testing).

## Error Handling

| Condition | Behavior |
|---|---|
| `write=True`, non-codex base | raise clear error (fail-loud, not ignored) |
| `write=True`, `cwd` missing | raise clear error (write target undefined) |
| `write=True`, `STRATUM_CODEX_ALLOW_WRITE=0` | raise clear error, no codex spawn |
| `write=True`, durable stream | raise clear error (deferred to follow-up) |
| `sandbox_mode != "read-only"`, `read_jail` set | raise `ValueError` at connector (writable jail deferred) |
| `sandbox_mode` not in `{read-only, workspace-write}` | reject at connector before spawning codex |
| codex escalates beyond workspace | auto-denied by codex (not a stratum error) |

## Testing

Per the golden-flow / real-backend testing standard:

- **Golden argv assertions (unit, non-jailed):** `write=True` → argv contains
  `--sandbox workspace-write`; default → `--sandbox read-only`. Cover both
  `run()` and `stream_events()`.
- **End-to-end through the public tool:** assert the mode reaches the connector
  when driven via `stratum_agent_run(type="codex", write=...)`, so a broken
  server→factory→connector hop is caught (not just the connector in isolation).
- **Kill-switch:** `write=True` + `STRATUM_CODEX_ALLOW_WRITE=0` → clear error,
  no spawn.
- **Guard rejections:** `write=True` + non-codex base → error; `write=True`
  without `cwd` → error; `write=True` + durable stream → error;
  `sandbox_mode="workspace-write"` + `read_jail` → `ValueError` at the connector;
  `danger-full-access` → rejected at the connector.
- **Backward-compat, jailed lane:** assert the **final Docker argv** for the
  review path has the `:ro` bind, `--read-only`, and **no** host-writable bind —
  the real safety property — not a codex `--sandbox read-only` flag.
- **Backward-compat, fallback lane:** assert the no-jail T3 path still routes to
  the `type="claude"` cold read.
- **Real-backend golden flow (availability-gated, BLOCKING GATE):** run codex
  write against a temp dir and assert a file is actually created/edited, and that
  the process does not hang. Gated on codex CLI availability like existing codex
  tests (skipped when the CLI/network is absent), but write mode is not shipped
  until this passes against a recorded codex CLI version.

## Filed Follow-ups (not built in v1)

- `STRAT-CODEGEN-TOOL` — dedicated `stratum_codegen` MCP tool with write-first
  defaults.
- `STRAT-CODEX-WRITE-JAIL` — writable Docker jail (`:rw` mount) for OS-isolated
  codex writes; lifts the v1 `write` + `read_jail` restriction.
- `STRAT-CODEX-WRITE-DURABLE` — safe write semantics for the durable/reparentable
  stream (cancellation / interrupt on teardown); lifts the v1 `write` + durable
  restriction.
- `STRAT-CODEX-WRITE-ROOTS` — allowed-workspace-root policy for write mode, beyond
  just requiring an explicit resolved `cwd`.
