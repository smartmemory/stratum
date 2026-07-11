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
7. **Error slugs** (14) and the envelope are contract — compose branches
   on `status` and maps spawn/timeout codes itself.
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

### Decision 3 — locking: correct within TS, safe across engines by policy

Node has no portable `flock` without native deps (TS engine is
source-only by design). TS uses: in-process mutex map (as Python) +
cross-process **O_EXCL lockfile with stale-PID takeover** on a NEW
sidecar (`.lock.ts`), preserving eval-outside-lock + optimistic commit
re-check.

Cross-ENGINE mutual exclusion (Python flock vs TS lockfile don't see
each other) is handled by POLICY, stated as a hard invariant: **one
engine per workspace per time** — compose dispatches guard calls to
exactly one engine (the flag), and the overlap window never runs both
against the same resource concurrently. The optimistic
`current_state==from_state` re-check at commit bounds the damage of a
violation to a stale-state refusal, never a corrupted chain (appends are
O_APPEND single-write).

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

## Acceptance criteria

- [ ] All 5 operations on TS: params, return shapes, and all 14 error
      slugs contract-identical to Python (table-driven tests ported from
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

## Open questions

- None blocking. The `.lock.ts` sidecar vs reusing `.lock` with O_EXCL
  semantics is settled at implementation by what the golden-fixture tests
  tolerate; the invariant (one engine per workspace) holds either way.
