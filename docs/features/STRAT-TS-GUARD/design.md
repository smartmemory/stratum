# STRAT-TS-GUARD — Port the guard subsystem to the TS engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 2 (largest chunk)

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 2)
- Python reference implementation: `stratum-mcp/src/stratum_mcp/guard/`
  (transition.py, store.py, evidence.py, fingerprint.py, errors.py) +
  `server.py:5588-5739` (MCP tools), `server.py:4946-4999` (CLI seam)
- Consumer: compose `server/lifecycle-guard.js` +
  `server/stratum-client.js:200-398` (`runGuard` — currently PINNED to the
  Python binary)
- Downstream: STRAT-PY-SWEEP row 4 (guard unpin)

## Problem

Guard is the one subsystem compose depends on that was never in the TS
port scope. Until it exists in TS, compose must spawn Python forever and
Phase 5 cannot delete the tree.

## Contract facts that drive the design (from 2026-07-11 recon)

1. **The seam is the CLI, not MCP.** Compose spawns
   `stratum-mcp guard <register|transition|override|history>` with ONE
   snake_case JSON kwargs object on stdin and parses JSON stdout. Exit 0 =
   success (including `refused` — a refusal is a normal result, NOT an
   error); exit 1 = canonical error envelope
   `{status:"error", error_type:<slug>, message}`. `migrate` is unused by
   compose but part of the contract.
2. **Guard state is long-lived** — a feature's guard spans its whole
   lifecycle (months), unlike flows. Epic D1 (drain-and-cutover) does NOT
   apply: the TS port must read and append EXISTING Python-written state.
3. **Byte-identical canonicalization is therefore mandatory, not nice.**
   `checksum = sha256(canonical({graph, edge_predicates, terminal:sorted,
   stakes}))` (`initial`/`workspace_root` excluded; list order
   significant) and `entry_digest = sha256(canonical(core) + prev_digest)`
   — a TS canonicalizer that differs by one byte makes every existing
   guard load as `guard_tampered` and breaks every ledger chain verify.
4. **Ledger is the source of truth** for `current_state` (registry.json's
   copy is a cache, overwritten on load); only `applied` and `deviation`
   outcomes advance state; a torn TRAILING line is dropped (crash
   recovery), an interior break is `ledger_corrupt`.
5. **Concurrency model:** dual lock (in-process mutex keyed by raw
   resource_id + cross-process lock on `.lock`), predicate eval OUTSIDE
   the lock, optimistic re-check of `current_state==from_state` +
   idempotency at commit.
6. **Evidence builtins** (4, allowlisted, AST-parsed, fail-closed):
   `server_file_exists`, `git_commit_exists`, `command_exit_zero`
   (opt-in `STRATUM_GUARD_ALLOW_COMMANDS=1`, timeout
   `STRATUM_GUARD_CMD_TIMEOUT_S` default 120), `verdict_receipt_clean`.
   Predicate types: `deterministic` → server-side eval;
   `verified`/`judged` → judge at edge stakes; `combined_met =
   evidence.met AND judge.met`; LLM predicates with no verifier available
   → refused with "no verifier available".
7. **Error slugs** (14 today; Decision 3 adds `guard_engine_owned` as a
   15th, emitted by BOTH engines during overlap — by Python for
   handed-over resources, by TS for not-yet-handed-over ones; it
   outlives Python as TS's not-owned refusal) and the envelope are
   contract — compose branches on `status` and maps spawn/timeout codes
   itself.
8. **Override/migrate** are token-gated (`STRATUM_GUARD_OVERRIDE_TOKEN`),
   `resolved_by` must be `"human"` for override, rationale required,
   override bypasses predicates but NEVER the graph; migrate re-validates
   the full policy and refuses to strand an in-flight `current_state`.

## Design

### Decision 1 — same state root, byte-compatible canonical JSON

TS guard reads/writes `~/.stratum/guards/<sha256(resource_id)[:32]>/`
exactly as Python does. A dedicated `canonicalJson()` in
`ts/src/guard/canonical.ts` reproduces Python's `canonical_json`
(sort_keys, compact separators) with two explicitly handled divergence
hazards:

- **Non-ASCII:** Python `json.dumps` defaults to `ensure_ascii=True`
  (\uXXXX escapes); JS `JSON.stringify` emits raw UTF-8. The TS
  canonicalizer must escape non-ASCII to match.
- **Numbers:** guard payloads contain only ints (ts_ms, graph_version)
  and strings — the canonicalizer REJECTS non-integer numbers loudly
  rather than risking float-repr divergence.

Gate: **cross-engine golden fixtures** — a Python-written guard dir
(committed as test fixture) must load, chain-verify, transition, and
re-verify under TS; and a TS-written dir must pass the Python suite's
`verify_chain` (test runs while Python still exists in-repo).

### Decision 2 — the seam is a TS CLI subcommand with the same wire format

`stratum guard <action>` (new subcommand beside `query`/`gate` in
`ts/src/cli/`): JSON kwargs on stdin, JSON result on stdout, exit 0 for
applied/refused/replayed/deviation/history, exit 1 + canonical envelope
for errors. Compose's `runGuard` then becomes engine-dispatched exactly
like query/gate (STRAT-PY-SWEEP row 4 deletes the pin) — compose code
change is one dispatch-table edit, no shape branches.

MCP tools (`stratum_guard_*` ×5) are registered on the TS server too —
same names, same shapes — so agent-side flows keep working after the
.mcp.json cutover.

### Decision 3 — locking: enforced per-resource ownership handoff, not policy

Node has no portable `flock` without native deps (TS engine is
source-only by design). TS uses: in-process mutex map (as Python) +
cross-process **O_EXCL lockfile** on a NEW sidecar (`.lock.ts`),
preserving eval-outside-lock + optimistic commit re-check.

Stale takeover is token-verified and serialized, never blind
unlink-and-retry (round-3 review finding: two processes observing the
same stale lock can race — one creates a fresh lock, the other unlinks
that LIVE replacement, and concurrent appends corrupt the chain).
Protocol: the lock body is `{token: <uuid>, pid, procStartTime, since}`.
Staleness is DEATH, not age (round-4 finding: a paused holder can be
"aged out", replaced, then resume and append under its unlinked lock —
fencing violation): a claimant may take over ONLY after verifying the
recorded pid is dead or recycled, via pid + process-start-time identity
(same primitive T2-F5-RESUME already uses; guard state is same-host by
construction, so this is sound). A live-but-slow holder is never taken
over — claimants wait or fail with a timeout error. Takeover sequence:
(1) O_EXCL-create `.lock.ts.takeover` (takeover mutex — losers back
off), (2) re-read `.lock.ts`, verify SAME token as observed AND
pid-dead, (3) unlink + O_EXCL-create own lock, (4) remove the takeover
mutex (itself pid-identity-bounded). Defense-in-depth fence: every
holder re-reads `.lock.ts` and verifies its OWN token immediately
before the ledger append; mismatch → abort without writing. Race tests:
two claimants over a dead holder, AND a paused-then-resumed holder
whose append must abort on the token fence.

Cross-engine mutual exclusion cannot be policy-only (review finding
2026-07-11, CONFIRMED): guard dirs are global per `resource_id`, Python
flocks `.lock` which TS cannot see, and two engines that both pass the
optimistic state read can each build an entry against the same
`prev_digest` — the second O_APPEND write lands as an INTERIOR chain
break (`ledger_corrupt`), i.e. real corruption, not a graceful refusal.

Therefore ownership is ENFORCED per resource, one-way, and the marker is
created UNDER PYTHON'S LOCK so there is no handoff-instant race (round-2
review finding: a TS-created marker under `.lock.ts` could land while a
Python transition holds `.lock` mid-commit — both would append):

- **Handoff is an explicit Python-side operation:**
  `stratum-mcp guard handoff` (new CLI action + `stratum_guard_migrate`-
  style token gating) writes `engine.json` (`{"owner":"ts","since":...}`)
  while HOLDING Python's `flock` — serialized against every in-flight
  Python mutation. STRAT-PY-SWEEP row 4 runs it per existing resource at
  cutover.
- **Python** (still in-repo during overlap): every mutation checks the
  marker under its lock and refuses with the new `guard_engine_owned`
  slug (reads/history stay allowed).
- **TS refuses to mutate a guard dir that lacks `owner:"ts"`** — fails
  loud with `guard_engine_owned` telling the operator to run the
  handoff. For a FRESH resource (no dir), TS creates dir + marker
  atomically at registration; a simultaneous fresh Python register of
  the same brand-new resource is the one residual race, impossible under
  compose's single-engine flag and bounded to first-registration (no
  existing chain to corrupt).
- The marker is never removed (retirement is one-way).
- Test: a forced handoff race — Python transition in flight while
  handoff runs — must serialize (handoff waits on flock) and the
  post-handoff Python retry refuses.

### Decision 4 — evidence parser is a grammar, not eval

Port the AST allowlist as a small hand-rolled parser (regex-free,
tokenizer + expected-shape check) accepting exactly the four builtins
with one literal arg (string, or array-of-strings for
`command_exit_zero`). Anything else → `evidence_parse_error` at
registration (fail-closed parity).

### Decision 5 — judge routing reuses the existing TS judge backend

`verified`/`judged` predicates call the TS engine's existing
`judgeBackend()` (openai | codex selection already shipped in
STRAT-TS-PORT acceptance) at the edge's stakes tier. No new judge
plumbing — this is the same seam `ensure` predicates already use.

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/src/guard/canonical.ts` (new) | add | byte-compatible canonical JSON (Decision 1) |
| `ts/src/guard/store.ts` (new) | add | registry/ledger/lock — port of store.py |
| `ts/src/guard/evidence.ts` (new) | add | builtin grammar + evaluators (Decision 4) |
| `ts/src/guard/transition.ts` (new) | add | register/transition/override/migrate/history orchestration |
| `ts/src/guard/errors.ts` (new) | add | 14 slugs + envelope |
| `ts/src/cli/guard.ts` (new) | add | `stratum guard <action>` stdin/stdout seam (Decision 2) |
| `ts/src/mcp/server.ts` (existing) | modify | register 5 `stratum_guard_*` tools |
| `ts/tests/guard/*.test.ts` (new) | add | ported contract tests + cross-engine golden fixtures |
| `ts/tests/fixtures/guard-py-golden/` (new) | add | Python-written guard dir fixture |
| `stratum-mcp/src/stratum_mcp/guard/store.py` + `server.py` (existing) | modify | `guard handoff` CLI action (marker under flock) + ownership check → `guard_engine_owned` (Decision 3) |
| `stratum-mcp/tests/test_guard_store.py` (existing) | modify | ownership-refusal + forced handoff-race tests |

## Acceptance criteria

- [ ] All 5 operations on TS: params, return shapes, and all 15 error
      slugs (14 legacy + `guard_engine_owned`) contract-identical to
      Python (table-driven tests ported from
      `test_guard_transition.py` / `test_server_guard.py` /
      `test_guard_cli.py`)
- [ ] Cross-engine golden fixtures pass BOTH directions (Python-written
      dir under TS; TS-written dir under Python's `verify_chain`)
- [ ] Checksum of an existing compose-registered guard loads WITHOUT
      `guard_tampered` under TS (live probe against a real
      `~/.stratum/guards/` entry, recorded here)
- [ ] Refusal semantics: exit 0, `status:"refused"`, state unchanged
- [ ] Idempotency: replay returns original verdict + ledger_ref; conflict
      on same key + different payload
- [ ] Env parity: `STRATUM_GUARD_OVERRIDE_TOKEN`,
      `STRATUM_GUARD_ALLOW_COMMANDS`, `STRATUM_GUARD_CMD_TIMEOUT_S`
- [ ] compose lifecycle-guard suite green against TS guard via the CLI
      seam (run with the pin locally overridden; the actual unpin ships in
      STRAT-PY-SWEEP row 4)
- [ ] `migrate` ported and tested even though compose doesn't call it
- [ ] Ownership handoff: `guard handoff` writes `engine.json` under
      Python's flock; Python refuses mutations on owned resources with
      `guard_engine_owned`; TS refuses un-handed-over dirs (tested both
      sides); a forced mixed-write attempt fails LOUD, never appends
- [ ] Takeover race tests: (a) two claimants over a dead holder
      serialize through the takeover mutex, never unlink a live
      replacement; (b) paused-then-resumed holder is NOT taken over
      while alive, and its append aborts on the own-token fence if it
      ever was

## Open questions

- None blocking. The `.lock.ts` sidecar naming is settled at
  implementation; cross-engine safety comes from the ownership marker
  (Decision 3), not the lock file.
