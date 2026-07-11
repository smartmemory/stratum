# STRAT-TS-FLOWCTL — Port flow-control leftovers to the TS engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 2

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 2)
- Python reference: `stratum-mcp/src/stratum_mcp/executor.py:1639-1780`
  (skip/commit/revert), `server.py:2549-2615` (check_timeouts),
  `server.py:2625-2678, 3838-3917` (tool wrappers)
- Consumers: compose `lib/stratum-mcp-client.js:306, 381, 394`
  (skipStep/commit/revert; NO wrapper for check_timeouts — it is a
  watchdog/polling tool)
- Pinning tests: `tests/integration/test_checkpoints.py`,
  `test_policy_skip.py`, `tests/contracts/test_gate_api.py`

## Problem

Four small tools round out the flow-control surface compose (and
agent-session use) expects: `stratum_skip_step`, `stratum_commit`,
`stratum_revert`, `stratum_check_timeouts`. All are flow-scoped (epic D1
applies — no cross-engine state concerns).

## Contract facts that drive the design (2026-07-11 recon)

1. **skip_step**: advances position only (`step_outputs[id]=null`,
   SkipRecord appended, `current_idx += 1`); GATE steps refuse with
   "use stratum_gate_resolve"; budget hard-stop checked first. Success
   envelope = next-step dispatch or completion envelope.
2. **commit / revert are STATE checkpoints, NOT git and NOT files.**
   commit deep-copies ~18 named mutable state fields under a label
   (overwrite-same-label allowed); revert restores exactly those fields
   and re-derives the current step (may itself skip). Error:
   `checkpoint_not_found` includes `available:[labels]`. The names are
   historically unfortunate — the port keeps names AND documents "no
   files are touched; caller owns file-level undo" in the tool
   descriptions verbatim.
3. **check_timeouts**: gate-function timeouts only (`fn_def.timeout`
   where mode=="gate"), wall-clock from `dispatched_at`; not-expired →
   `{status:"no_timeout", remaining_seconds}`; expired → routes through
   `resolve_gate(..., "kill", "timeout", "system")` — killed (flow
   deleted) or on_kill-routed next-step dispatch or error. Four distinct
   no_timeout reasons (complete / not-a-gate / no-timeout / not
   dispatched).
4. Checkpoint field list is version-coupled to FlowState: the TS
   PersistedRun equivalents of the ~18 fields must be snapshotted — the
   port snapshots the TS-native equivalent set and the design records
   the mapping table (Python field → TS field) so parity is checkable.

## Design

Port with an IR/state prerequisite (round-2 review finding, CONFIRMED):
TS gates have no `timeout` field (`ts/src/ir/schema.ts:26`),
`PersistedRun` has no `dispatched_at` (`ts/src/engine/state.ts:77`), and
the gate query deliberately reports `timeout: null`
(`ts/src/cli/query_gate.ts:178`) — `check_timeouts` parity is
unimplementable until those exist:

- **IR:** gate steps gain optional `timeout` (seconds), validated.
- **State:** `PersistedRun` gains a durable `dispatchedAt` map (wall
  clock, persisted — Python's monotonic-reset-on-restore inaccuracy is
  NOT replicated; recorded as a deliberate improvement, envelope
  unchanged).
- **Query:** `stratum query gates` stops hard-coding `timeout: null`
  and projects the real value (compose already tolerates both).
- **Migration coverage (round-3 finding):** `migrate/check.ts` currently
  records only a gate function's mode and silently drops its Python
  `timeout` — it gains an explicit gate-timeout mapping (reported as
  supported → `gate.timeout`) with a fixture spec proving it.

One further decision:

- **Checkpoint field mapping is explicit.** A `CHECKPOINT_FIELDS`
  manifest in `ts/src/engine/checkpoint.ts` lists every snapshotted key
  with its Python counterpart in a comment block; the contract test
  asserts the manifest covers every mutable PersistedRun field or
  names it excluded-with-reason (prevents silent drift when the TS
  engine grows state — the exact failure mode Python's ad-hoc copy list
  invites).
- check_timeouts reuses the TS engine's existing gate-resolution path
  (`stratum_gate_resolve` internals) for the kill routing — one kill
  semantics, not two.
- Envelope fidelity: completion envelopes
  (`{status, flow_id, output, trace, total_duration_ms}`) and error
  types replicated exactly.

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/src/ir/schema.ts` + `ir/validate.ts` (existing) | modify | gate `timeout` field |
| `ts/src/engine/state.ts` (existing) | modify | durable `dispatchedAt` |
| `ts/src/cli/query_gate.ts` (existing) | modify | project real timeout |
| `ts/src/migrate/check.ts` (existing) | modify | gate-timeout mapping + fixture |
| `ts/src/engine/checkpoint.ts` (new) | add | CHECKPOINT_FIELDS manifest + commit/revert |
| `ts/src/engine/engine.ts` (existing) | modify | skip_step, check_timeouts over existing gate-resolve |
| `ts/src/mcp/server.ts` + `ts/contracts/mcp-surface.json` (existing) | modify | 4 tools |
| `ts/tests/engine/flowctl.test.ts` (new) | add | ported pinning tests + manifest-coverage test |

## Acceptance criteria

- [ ] 4 tools contract-identical (params, envelopes, error types incl.
      `checkpoint_not_found.available`, four no_timeout reasons)
- [ ] Gate-skip refusal parity ("use stratum_gate_resolve")
- [ ] Checkpoint round-trip: commit → mutate → revert restores exactly
      the manifest fields; manifest-coverage test green
- [ ] Timeout firing routes through the SAME gate-resolve path as an
      explicit kill (single kill semantics), tested for killed /
      on_kill-routed / error
- [ ] Tool descriptions state "state-only, no files" for commit/revert

## Open questions

- None.
