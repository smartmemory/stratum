# STRAT-TS-FLOWCTL (checkpoint slice) — build brief

**Epic:** STRAT-PY-RETIRE Phase 2 · **Design of record:** `./design.md`
**Status:** DESIGNED — awaiting build
**Scope:** `stratum_commit` + `stratum_revert` ONLY. `skip_step` and `check_timeouts` are
PARKED per the 2026-07-12 disposition (adapter-only / no consumer), which removes the entire
IR-`timeout` + `dispatchedAt` + `query_gate` + `migrate/check` prerequisite from design.md.
This slice touches neither the IR nor the gate/query surface.

## Problem

`stratum_commit` / `stratum_revert` are STATE checkpoints (NOT git, NOT files). Compose's
speckit recovery skill (`stratum-speckit/SKILL.md:280`) directs agents to call them, and the
owner decided (2026-07-12) to keep that skill on TS. Python: `executor.py:1639-1780`
(`commit_checkpoint` deep-copies ~13 mutable FlowState fields under a label, overwrite-same-
label allowed; `revert_checkpoint` restores them, returns False when the label is missing).
The Python field list is Python's state model — the TS port snapshots the **TS-native mutable
subset of `PersistedRun`**, not a literal field copy.

## Design decisions (LOCKED — extend design.md, do not contradict it)

### D1 — Checkpoints live durably on the run
Add `PersistedRun.checkpoints?: Record<string, CheckpointSnapshot>` (optional → runs created
before this stay loadable). Snapshots travel with the run and survive restart (parity with
Python storing them in FlowState). No separate store.

### D2 — Explicit `CHECKPOINT_FIELDS` manifest (design.md "one further decision")
`ts/src/engine/checkpoint.ts` declares a manifest naming every snapshotted `PersistedRun` key.
The snapshotted set is the **mutable** subset:
`status, output, failure, flowSpent, rounds, steps, events, cancelRequested, parallel`.
Excluded-with-reason (immutable identity/config, set at creation, never mutated by advancement):
`id, spec, input, flowName, workspaceRoot, bgDriven, checkpoints` (a checkpoint never snapshots
the checkpoint map itself — no nesting). A contract test asserts the manifest covers **every**
`PersistedRun` field as either snapshotted or excluded-with-reason, so future engine state
additions can't silently escape checkpointing (the exact drift Python's ad-hoc copy-list invited).

### D3 — Semantics
- `commit(runId, label)`: structured-clone the manifest fields into `run.checkpoints[label]`
  (overwrite same label allowed); persist. Deep copy — later mutation must not alias the snapshot.
- `revert(runId, label)`: if `label` absent → error `checkpoint_not_found` with
  `available: [sorted labels]` (parity). Else restore each manifest field from the snapshot
  (deep copy back), persist, and **re-derive the current position** via the engine's existing
  silent re-advance (`reAdvance`) so the returned envelope reflects the restored, re-derived state.
- Both refuse a run that is not loadable / not in a revertible state with the SAME error types
  the Python wrappers emit (codex: mirror `server.py:2625-2678` envelope + error shapes exactly).
- **bg-ownership guard:** like `stepDone`, `commit`/`revert` must REFUSE an actively bg-driven
  run (running/paused_gate/cancelled) — a checkpoint mutation racing the detached driver is the
  same sole-mutator violation `stepDone` already guards. Reuse that guard.

### D4 — MCP surface additive
Add `stratum_commit` + `stratum_revert` to `ts/src/mcp/server.ts` and
`ts/contracts/mcp-surface.json` (bump v3→v4). Request/response envelopes + error variants
contract-identical to the Python tools. Tool descriptions state verbatim: **"state-only; no
files are touched; the caller owns file-level undo."**

## Acceptance criteria

- [ ] `PersistedRun.checkpoints?` added (optional, back-compat); `CheckpointSnapshot` type.
- [ ] `ts/src/engine/checkpoint.ts` (new): `CHECKPOINT_FIELDS` manifest + `commit`/`revert`
      logic (pure over a run + label), deep-copy on both directions.
- [ ] `engine.ts`: `commit(runId, label)` / `revert(runId, label)` under the run lock, reusing
      the bg-ownership guard; `revert` re-derives via `reAdvance`; persist on both.
- [ ] `checkpoint_not_found` error carries `available: [sorted labels]`.
- [ ] Manifest-coverage contract test: every `PersistedRun` field is snapshotted OR
      excluded-with-reason; fails if a new field is neither.
- [ ] Checkpoint round-trip test: commit → mutate steps/output/flowSpent/rounds → revert
      restores exactly the manifest fields; a non-snapshotted field (e.g. spec) is untouched;
      deep-copy proven (mutating the run after commit does not change the snapshot, and vice versa).
- [ ] Overwrite-same-label test; `checkpoint_not_found.available` test.
- [ ] bg-ownership refusal test (commit/revert on a bg-driven run rejects like stepDone).
- [ ] 2 MCP tools wired; `mcp-surface.json` v4; frozen-parity gate (`tests/mcp/p5.test.ts`)
      exercises both new tools' declared statuses; descriptions carry the "state-only, no files" line.

## OUT OF SCOPE (do not build)
skip_step, check_timeouts, IR gate `timeout`, `PersistedRun.dispatchedAt`, `query_gate` timeout
projection, `migrate/check` gate-timeout mapping. All parked/deferred.

## Gates
```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"; cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit --erasableSyntaxOnly   # NO enum/namespace/param-props/decorators
./node_modules/.bin/vitest run tests/engine tests/mcp
```
Baseline ~512 pass / 1 skip.

## Reading list
1. `stratum-mcp/src/stratum_mcp/executor.py:1639-1780` — Python commit/revert (semantics mirror).
2. `stratum-mcp/src/stratum_mcp/server.py:2625-2678` — Python tool envelopes + error shapes.
3. `ts/src/engine/state.ts:148-168` — `PersistedRun` (the fields the manifest classifies).
4. `ts/src/engine/engine.ts` — `withRunLock`, `reAdvance`, the `stepDone` bg-ownership guard
   (reuse it), `gateResolve` (pattern for a locked mutating method), `flowBgPoll`.
5. `ts/src/mcp/server.ts` + `ts/contracts/mcp-surface.json` (v3) — tool wiring + frozen-parity gate.

## Build model
Opus authors brief + adjudicates; codex WRITES (write mode, gpt-5.6-sol/high,
cwd=/Users/ruze/reg/my/forge/stratum) against this file path; codex REVIEWS the diff read-only;
Opus adjudicates every finding vs code, verifies gates locally, commits directly to main
(codex sandbox cannot commit). No Co-Authored-By.
