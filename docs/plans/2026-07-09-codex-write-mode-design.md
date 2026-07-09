# Design: Codex Write Mode (`STRAT-CODEX-WRITE`)

**Date:** 2026-07-09
**Status:** DESIGN
**Track:** T5 (MCP server / connectors)

## Related Documents

- `docs/plans/2026-03-05-stratum-mcp-cleanup-blueprint.md` — execution-kernel boundary this change lives inside
- Implementation plan: (to be written by `writing-plans` after this design is approved)

## Goal

The codex connector is currently **read-only by construction** — it hardcodes
`--sandbox read-only` in its argv and is used only for adversarial code review
(T3 of the judge). Enable codex to **generate and edit code in the working
directory** by emitting `--sandbox workspace-write`, while keeping read-only the
default so the existing review path is untouched.

## Non-Goals (deferred follow-ups)

- **Dedicated `stratum_codegen` MCP tool** with write-first defaults. v1 adds a
  parameter to the existing tool; a purpose-built codegen tool is filed as a
  follow-up if ergonomics warrant it.
- **Writable Docker jail** (`:rw` bind mount) for OS-isolated writes. v1 writes
  to the real cwd only; the writable-jail follow-up is filed separately.
- **`danger-full-access`** as a public option. The internal connector represents
  the sandbox as a mode string so this is reachable later, but the v1 public API
  exposes only read-only vs workspace-write.

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

- **Codex-only.** With `type="claude"`, `write` is ignored — claude's write
  ability is already governed by `allowed_tools` / `disallowed_tools`. The tool
  description states this explicitly.
- **Caller-agnostic primitive.** Usable ad-hoc (offload grunt implementation) and
  by the Compose build pipeline (implement phase). Compose is the intended first
  consumer but is not required for v1.

### Internal representation — sandbox mode string

At the connector boundary, `write` maps to a **sandbox mode string**, not a bool:

- `write=False → sandbox_mode="read-only"`
- `write=True  → sandbox_mode="workspace-write"`

`CodexConnector.__init__` gains `sandbox_mode: str = "read-only"`. Keeping the
connector on a string future-proofs `danger-full-access` without another API
change, while the public tool API stays the simple bool. The connector validates
the mode against `{"read-only", "workspace-write", "danger-full-access"}`.

### The code change

1. Replace the hardcoded `"read-only"` literal with `self.sandbox_mode` at **all**
   argv-build sites in `codex.py` — `run()`, `stream_events()`, and the durable
   spawn path. (An audit for the literal is part of the plan so none is missed.)
2. `factory.py` threads `sandbox_mode` (derived from `write`) into the connector.
3. No approval flag is added. `codex exec` is non-interactive by default and will
   not block on an approval prompt; with `workspace-write` codex writes freely
   inside the cwd, and anything requiring escalation beyond the sandbox (network,
   paths outside the tree) is auto-denied rather than surfaced. **Implementation
   must verify** `codex exec --sandbox workspace-write` actually writes and does
   not hang.

### Guardrails

1. **Env kill-switch `STRATUM_CODEX_ALLOW_WRITE`** — write is enabled by default.
   Set to `0` / `false` / `no` to hard-disable. When disabled and `write=True` is
   requested, **raise a clear error** (`codex write disabled by
   STRATUM_CODEX_ALLOW_WRITE`) rather than silently downgrading to read-only — a
   silent downgrade makes a codegen call look successful while writing nothing,
   which is a nastier failure.
2. **`write=True` + `read_jail` → `ValueError` in v1.** The Docker jail mounts
   `:ro`, so a writable request there would silently eat writes. The writable-jail
   (`:rw` mount) is a deferred follow-up, so v1 rejects the combo explicitly with
   a message pointing at the follow-up.

### Backward-compatibility (the safety property)

Default is read-only, and the review path (`verifier.py` T3 / `stratum_judge`)
never passes `write`, so it stays read-only and untouched. This is asserted by a
test on the review argv.

## Error Handling

| Condition | Behavior |
|---|---|
| `write=True`, `type="claude"` | `write` ignored (documented); no error |
| `write=True`, `STRATUM_CODEX_ALLOW_WRITE=0` | raise clear error, no codex spawn |
| `write=True`, `read_jail` set | raise `ValueError` (writable jail deferred) |
| unknown `sandbox_mode` at connector | reject before spawning codex |
| codex escalates beyond workspace | auto-denied by codex (not a stratum error) |

## Testing

Per the golden-flow / real-backend testing standard:

- **Golden argv assertions (unit):** `write=True` → argv contains
  `--sandbox workspace-write`; default → `--sandbox read-only`. Cover both
  `run()` and `stream_events()`.
- **Kill-switch:** `write=True` + `STRATUM_CODEX_ALLOW_WRITE=0` → clear error,
  no spawn.
- **Jail rejection:** `write=True` + `read_jail` → `ValueError`.
- **Backward-compat:** the review path still emits `--sandbox read-only`.
- **Real-backend golden flow (availability-gated):** run codex write against a
  temp dir and assert a file is actually created/edited. Gated on codex CLI
  availability like existing codex tests, skipped when the CLI/network is absent.

## Filed Follow-ups (not built in v1)

- `STRAT-CODEGEN-TOOL` — dedicated `stratum_codegen` MCP tool with write-first
  defaults.
- `STRAT-CODEX-WRITE-JAIL` — writable Docker jail (`:rw` mount) for OS-isolated
  codex writes; lifts the v1 `write` + `read_jail` restriction.
