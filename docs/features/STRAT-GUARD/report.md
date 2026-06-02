# STRAT-GUARD — Implementation Report

**Status:** SHIPPED 2026-06-02 · **Owner:** stratum · **First consumer:** compose (`COMP-MCP-ENFORCE`, follow-up run)
**Related:** [`design.md`](./design.md) (intent) · [`blueprint.md`](./blueprint.md) (verified plan)

## 1. Summary

A standalone, resource-agnostic, tamper-evident guarded-transition primitive over the FlowState-light `run_judge` verifier, exposed as 5 MCP tools. Any client that manages a resource lifecycle outside a stratum flow (e.g. compose's feature tracker) can register a transition graph with per-edge evidence predicates and get strict, independently-verified, append-only-audited transitions — without standing up a flow, and without hand-rolling a weaker, bypassable copy.

## 2. Delivered vs Planned

| Blueprint slice | Status |
|---|---|
| S1 store (registry, hash-chained ledger, cross-process flock, idempotency) | ✅ `guard/store.py` |
| S2 fingerprint (guard checksum) | ✅ `guard/fingerprint.py` |
| S3 server-side trusted-evidence evaluator | ✅ `guard/evidence.py` |
| S4 transition orchestration (register/transition/override/migrate/history) | ✅ `guard/transition.py` |
| S5 five MCP tools | ✅ `server.py` (`stratum_guard_*`) |

All planned. No scope cut. Slice 4's phase-scoped tool capabilities + REST auth remain a compose-side follow-up (COMP-MCP-ENFORCE Slice 4), as designed.

## 3. Architecture deviations from the design

1. **Trusted evidence is server-side, not a T1 predicate extension.** The design framed the four trusted builtins as new T1 deterministic-vocabulary entries. The blueprint gate established this is wrong: T1 evals over a read-only staged snapshot with no real fs/git/subprocess — server-read evidence is the *opposite* of staged-artifact eval. Shipped as a guard-owned `ast`-allowlist evaluator (`evidence.py`). Faithful to the design's *intent* ("the guard server reads the file itself"), not its mechanism sketch.
2. **Predicate routing by `type`, not by statement parsing.** `deterministic` → trusted-evidence (must parse as a known builtin, fail-closed); `verified`/`judged` → `run_judge`. Cleaner and closes a fail-open hole (a typo'd builtin is rejected at registration, not silently routed to the LLM path).
3. **Placement:** guard core lives in `stratum-mcp/src/stratum_mcp/guard/`, not `src/stratum/` — it reuses `canonical_json`/atomic-write from `stratum_mcp` and the dependency only runs `stratum_mcp → stratum`.

## 4. Key implementation decisions

- **Ledger is the source of truth for `current_state`** (registry.json is a cache) → durable fsync'd append is the atomic commit point; crashes self-heal.
- **Optimistic concurrency:** structural checks under lock → slow eval outside → commit re-validates state + idempotency under lock. Keeps the event loop unblocked and avoids holding a cross-process lock across an LLM call.
- **Cross-process `fcntl.flock` + in-process `asyncio.Lock`** — net-new (stratum had no cross-process lock); flock acquired via `asyncio.to_thread`.
- **Threat model stated explicitly and scoped:** defends against API-surface abuse (the rogue MCP caller); does NOT defend against a local-fs-root attacker (signing is the named later escalation). Hash-chain verified before every trust-bearing read; torn-tail recoverable, interior tampering fails closed.
- **No `force`:** `guard_override` is the single sanctioned bypass — out-of-band token + human + rationale, recorded as a `deviation`.

## 5. Test coverage

59 tests across `test_guard_store.py` (14), `test_guard_evidence.py` (15), `test_guard_transition.py` (25), `test_server_guard.py` (5). Golden flow + every error path + tamper/torn-tail/crash-recovery + concurrency (same-key-applies-once, concurrent first-registration) + override/migrate immutability + real-git evidence + LLM-tier via mocked `run_judge`. Full `stratum-mcp/tests/`: **1363 passed, 2 skipped** (no regressions).

## 6. Files changed

- New: `stratum-mcp/src/stratum_mcp/guard/{__init__,errors,fingerprint,store,evidence,transition}.py`
- New tests: `stratum-mcp/tests/test_guard_{store,evidence,transition}.py`, `test_server_guard.py`
- Modified: `stratum-mcp/src/stratum_mcp/server.py` (+5 tools), `README.md`, `CHANGELOG.md`, `docs/features/STRAT-GUARD/{design,blueprint}.md`

## 7. Known issues & tech debt

- **Override-token issuance** is env-var only (`STRATUM_GUARD_OVERRIDE_TOKEN`) — design open-Q #1; a cockpit-issued/cryptographic token is a follow-up.
- **`command_exit_zero`** runs the (checksummed) gate command server-side; opt-in via `STRATUM_GUARD_ALLOW_COMMANDS=1`. A signed-runner boundary (design open-Q #2) is deferred.
- **Ledger is hash-chained, not signed** — offline-fs-root tampering is out of v1 scope (documented).
- **TS port:** this is the Python build; the tool contract is the reimplementation spec (per `project_stratum_ts_port`). In TS, compose may consume the primitive as a library, removing the MCP hop.

## 8. Lessons learned

- The blueprint gate paid for itself: 9+4 findings turned an overclaimed "tamper-evident, reuses T1 predicates" sketch into a correctly-scoped, crash-consistent, concurrency-safe plan **before** any code. The single highest-value catch was that trusted evidence cannot live in the T1 jail.
- The implementation gate then caught 5 real races/fidelity gaps (phase-3 idempotency re-check, locked registration, stored-verdict replay) that the green test suite did not — multiple review iterations on the *implementation* (not just the plan) earn their keep.
