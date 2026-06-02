# STRAT-GUARD — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4–5). Verified against current source 2026-06-02. File:line refs below are confirmed live unless marked.
**Design:** [`./design.md`](./design.md)
**Owner:** stratum · **First consumer:** compose (`COMP-MCP-ENFORCE`, deferred to follow-up run)

## Related Documents
- Design (intent): `./design.md`
- Reused engine: `src/stratum/judge/kernel.py` (`run_judge`), `src/stratum/judge/result.py` (`JudgeResult`)
- Consumer design: `../../../../compose/docs/features/COMP-MCP-ENFORCE/design.md`

## Placement decision (resolved during blueprint)

Guard core lives in a **new subpackage `stratum-mcp/src/stratum_mcp/guard/`**, not `src/stratum/`. Rationale: the guard store reuses `canonical_json` (`stratum_mcp/result_cache.py:62`) and the `_atomic_write` idiom (`stratum_mcp/migrate.py:296`), and mirrors the `_FLOWS_DIR` persistence constant (`stratum_mcp/executor.py:1346`) — all in the `stratum_mcp` package. It imports `run_judge` from `stratum.judge.kernel` (confirmed forward dep: `server.py:2124`). Placing guard core in `src/stratum/` would invert the dependency (`stratum` → `stratum_mcp`), which does not exist today. The 5 MCP tools are thin wrappers in `server.py`.

## Corrections table (design assumption vs verified reality)

| # | Design assumption | Verified reality | Resolution |
|---|---|---|---|
| C1 | Trusted-evidence predicates are "net-new predicate surface" extending T1 (`predicates.py`). Design §"Trusted evidence model" lists adding `server_file_exists`/`git_commit_exists`/`command_exit_zero`/`verdict_receipt_clean` to the deterministic vocabulary. | T1 `evaluate_t1` runs `eval(code, {"__builtins__": {}}, ns)` over a **read-only staged snapshot** (`predicates.py:69-90`); builtins are path-jailed to `artifacts/`/`modified/` (`predicates.py:104-152`). A subprocess/real-fs/git builtin **breaks the jail's core guarantee** and contradicts the design's own "the guard server reads the file itself / executes the command itself" trusted-source model. | **Trusted-evidence predicates are evaluated server-side by a guard-owned evaluator (`guard/evidence.py`), NOT added to `predicates.py`.** The T1 jail stays pure. `run_judge` is still used for any *LLM-tier* (T2/T3) edge predicates. This is faithful to the design intent (server-side trusted reads ≠ caller-staged T1 eval). |
| C2 | "Compose already uses advisory locks; same mechanism" — implies a reusable lock primitive in stratum. | **No *cross-process* file-lock (`fcntl`/`flock`/`FileLock`) primitive exists in `stratum_mcp`.** There *is* an **in-process `asyncio.Lock`** per flow (`parallel_exec.py:74`, `:551`) — but that only serializes coroutines within one event loop, not separate OS processes. | Per-resource **cross-process** lock is **net-new infra** in `guard/store.py` (`fcntl.flock` on a `<resource>/.lock` sidecar, advisory). In-process concurrency additionally guarded by a per-resource `asyncio.Lock` registry (mirrors `parallel_exec`). The `flock` syscall + all `subprocess`/`run_judge` blocking work runs via `asyncio.to_thread` so the event loop is never blocked (see S4 concurrency discipline). |
| C3 | `git_commit_exists` / `command_exit_zero` reuse existing helpers. | **No git-object resolver and no generic command runner exist.** Existing git is working-tree plumbing via `subprocess.run(..., capture_output=True, timeout=N, check=False)` (`spec.py:840`, `worktree.py:41`). | Net-new in `guard/evidence.py`, mirroring the established subprocess idiom; `git rev-parse --verify --quiet <sha>^{commit}` for commit existence. |
| C4 | run_judge usable synchronously. | `run_judge` is **`async`** (`kernel.py:56`), FlowState-light (lazy `_next_turn_index` degrades to `1`). | Guard transition is `async`; MCP tools are `async def` already. For all-deterministic edges, `run_judge` is **not called at all** — trusted-evidence eval is sufficient and cheaper. |
| C5 | T3 adversary fires at `kernel.py:159`. | Guard `if stakes == "paranoid" and t2.verdict == "met":` is at **`kernel.py:158`** (`:159` is the `evaluate_t3` call). | Cosmetic; design ref updated mentally. No code impact. |
| C6 | (design implies) ledger keyed per resource is novel. | `JudgeResult` enforces invariant `clean == met` (`result.py:235`); turns.jsonl is keyed by `flow_id` only. | Guard ledger is its own file (`guards/<rid>/ledger.jsonl`), independent of judge turns.jsonl. When mapping a `JudgeResult` into a guard verdict, read `.met`. |

All other design file:line refs (run_judge `kernel.py:56`, evaluate_t1 `:39`, `_build_t1_namespace :139`, JudgeResult `:204`, append_turn_log `logging.py:36`, compute_spec_checksum `executor.py:1196-1221`, stratum_judge `server.py:2109`, gate_resolve `server.py:1785`) **verified accurate**.

## Trust boundary & threat model (explicit — what STRAT-GUARD does and does NOT defend against)

The integrity claims below are scoped. Stating the boundary precisely is part of correctness — an unscoped "tamper-evident" claim is an overclaim (raised at gate).

**In scope (the threat STRAT-GUARD exists to close).** A client driving the **MCP/tool API surface** — the rogue/buggy agent or MCP caller that bypasses the skill and calls the tools directly (the exact COMP-MCP-ENFORCE motivation: self-approving gates, `force`, unverified completion). Against this caller STRAT-GUARD enforces: edge legality, independent predicate verification, no `force`, append-only attributed ledger, idempotency. This caller **cannot mint** an `applied` verdict without the edge's predicates verifying against trusted (server-read) evidence.

**Out of scope for v1 (documented, not silently assumed).** An attacker with **arbitrary local-filesystem write access** to `~/.stratum/guards/` or to the source tree. Such an attacker can edit `registry.json` (and recompute the checksum), rewrite the whole `ledger.jsonl` suffix (and recompute the hash chain), or edit the guard code itself — **no unsigned scheme defends against this**, and it is the same actor who could edit compose's tracker or stratum's source directly. Closing it requires cryptographic signing with an out-of-process key (design §"Ledger integrity" names signing as a later option) — **explicitly deferred**. The hash chain therefore detects *accidental corruption and in-process partial tampering*, and — critically — is **verified before every trust-bearing read** (idempotency lookup, `verdict_receipt_clean`); a broken chain fails closed (`ledger_corrupt`). It does not claim to stop a determined local-root attacker. Checksum lives in `registry.json` for the same reason and carries the same scoped guarantee.

**Command execution surface (`command_exit_zero`).** Per design open-Q #2, v1 executes the gate command server-side in the registered `workspace_root` with a timeout. Mitigations made concrete here: (1) the command list comes only from the **registered, checksummed** `edge_predicates` — it is fixed at registration and a per-transition caller cannot inject a command; (2) `workspace_root` must be an existing absolute directory, validated at registration; (3) hard timeout cap (`STRATUM_GUARD_CMD_TIMEOUT_S`, default 120s); (4) **command execution is opt-in**: if any registered edge predicate uses `command_exit_zero`, registration requires `STRATUM_GUARD_ALLOW_COMMANDS=1` in the server env, else `command_execution_disabled`. **Registration authorization itself** (who may call `register`/`migrate`) is the MCP transport boundary (localhost stdio) for v1; a token/auth layer for the REST surface is COMP-MCP-ENFORCE **Slice 4**, cross-referenced, not solved here.

## Architecture (verified surface)

```
stratum-mcp/src/stratum_mcp/guard/
  __init__.py        # exports register/transition/override/migrate/history + GuardError hierarchy
  store.py           # _GUARDS_DIR, GuardRegistry, persistence, flock, hash-chained ledger, idempotency
  fingerprint.py     # guard_checksum(graph, edge_predicates, terminal, stakes)
  evidence.py        # server-side trusted-evidence predicate evaluator (NOT T1 jail)
  transition.py      # orchestration: register/transition/override/migrate/history
server.py            # +5 @mcp.tool async wrappers (new banner section before def main())
```

Reuse (consumed as-is): `canonical_json` (`result_cache.py:62`), `_atomic_write` technique (`migrate.py:296`, fsync + `os.replace`), `run_judge`/`Predicate`/`JudgeResult` (`stratum.judge`), `{status,error_type,message}` error-dict convention (`server.py:1796`), FastMCP type-hint schema derivation (no Pydantic).

## Boundary Map

> Kinds restricted to {interface, type, function, class, const}. Each entry names a concrete code symbol. Topology: every `from S##` references an earlier slice.

| Symbol | Kind | Slice | Produces / Consumes |
|---|---|---|---|
| `_GUARDS_DIR` | const | S1 | produces: `Path.home()/".stratum"/"guards"`, monkeypatchable module global (mirrors `_FLOWS_DIR`) |
| `GuardRegistry` | class | S1 | produces: dataclass `{resource_id, graph, edge_predicates, terminal, stakes, initial, current_state, checksum, graph_version, workspace_root}` |
| `LedgerEntry` | type | S1 | produces: `{ts_ms, from_state, to_state, outcome, payload_digest, resolved_by, idempotency_key, kind, prev_digest, entry_digest}` — `entry_digest` IS the receipt token (returned as `ledger_ref`) |
| `guard_checksum` | function | S2 | produces: `str` sha256; consumes: `canonical_json` (existing) |
| `load_registry` / `persist_registry` | function | S1 | produces: registry IO (atomic write); consumes: `_GUARDS_DIR`, `GuardRegistry` |
| `append_ledger` | function | S1 | produces: hash-chained append; consumes: `_GUARDS_DIR`, `LedgerEntry`, `resource_lock` |
| `resource_lock` | function | S1 | produces: `fcntl.flock` contextmanager on `<rid>/.lock` |
| `evaluate_evidence` | function | S3 | produces: `EvidenceResult{met, per_predicate}`; consumes: `GuardRegistry.workspace_root` |
| `server_file_exists`/`git_commit_exists`/`command_exit_zero`/`verdict_receipt_clean` | function | S3 | produces: trusted bool; consumes: real fs/git/subprocess + ledger (`verdict_receipt_clean` reads `append_ledger` from S1) |
| `register_guard` | function | S4 | consumes: `GuardRegistry` from S1, `guard_checksum` from S2 |
| `guard_transition` | function | S4 | consumes: `load_registry`/`append_ledger`/`resource_lock` from S1, `guard_checksum` from S2, `evaluate_evidence` from S3, `run_judge` (existing) |
| `guard_override` / `guard_migrate` / `guard_history` | function | S4 | consumes: S1 store + S2 checksum |
| `stratum_guard_register` … `stratum_guard_history` | function | S5 | consumes: all of `guard/` from S4 |

## Slices (ordered, TDD per slice)

### S1 — `guard/store.py` (foundation)
- `_GUARDS_DIR = Path.home() / ".stratum" / "guards"` (module global; tests `monkeypatch.setattr`).
- **Collision-proof dirname (C9 fix).** `_resource_dir(resource_id) = _GUARDS_DIR / sha256(resource_id.encode()).hexdigest()[:32]`. The raw `resource_id` is stored in `registry.json`; every load **verifies the stored raw id == the requested id** (`resource_id_mismatch` error) so a hash collision cannot silently share state. No slugify (slugs collide).
- `GuardRegistry` dataclass (includes **`initial`** — the genesis state, stored, finding-F4) + `to_dict`/`from_dict`. `registry.json` written via fsync-atomic write (copy `migrate._atomic_write` body — 12 lines — to keep guard self-contained).
- `resource_lock(resource_id)` — async contextmanager combining (a) a process-wide per-resource `asyncio.Lock` from a module `_locks: dict[str, asyncio.Lock]` (in-process), and (b) a cross-process `fcntl.flock(fd, LOCK_EX)` on `<dir>/.lock` acquired via `await asyncio.to_thread(...)` so the event loop never blocks (C2/finding-5). Both released in `finally`.
- `append_ledger(resource_id, entry)`: **hash-chained, durably written** — `entry.prev_digest = last entry's entry_digest` (or `""` genesis); `entry.entry_digest = sha256((canonical_json(entry_without_digest) + prev_digest).encode())`. Open `"a"`, `write(canonical_json(entry)+"\n")`, then `flush()` + `os.fsync(fd)` so the line is durable before returning (finding-F1). **Caller must already hold `resource_lock`.** Returns `entry_digest` — this is the **`ledger_ref` / receipt token** callers persist (finding-F2).
- **Torn-tail recovery (finding-F1).** `read_ledger` parses line-by-line; if the **final** line fails to JSON-parse or breaks the chain (an interrupted append), it is **dropped** as an incomplete write and the resource recovers to the last durable entry. A chain break at a **non-final** line is genuine tampering → `ledger_corrupt` (fail closed). This distinguishes a crash mid-append (recoverable) from interior rewrite (refuse).
- **Ledger is the source of truth for `current_state` (finding-3).** `load_registry` reads `registry.json` for the *policy* (graph/predicates/checksum/`initial`) but derives `current_state` from the **last `applied`/`deviation` ledger entry's `to_state`** (genesis = `registry.initial`). `registry.json.current_state` is a non-authoritative cache, refreshed best-effort post-append. The durable, fsync'd ledger append is the **atomic commit point**.
- `read_ledger(resource_id) -> list[LedgerEntry]`; `verify_chain(entries) -> bool` (recompute every digest, after torn-tail trim). **Invoked on load before any trust-bearing read**; interior break → `ledger_corrupt`.
- Idempotency: ledger entry carries `idempotency_key` + `payload_digest = sha256(canonical_json({from_state,to_state,artifacts,modified_files,resolved_by}))`. `find_by_idempotency_key(resource_id, key) -> LedgerEntry | None`. Conflict semantics in S4 (finding-7).
- **State-name charset (finding-F3 support):** `register_guard` validates every graph state name + `terminal`/`initial` against `^[A-Za-z0-9_.-]+$` (`invalid_state_name`). This keeps state names safe for the `run_judge` `step_id` and for any derived identifiers.
- **`resource_id` validation:** reject empty, `..`, NUL, and anything that would escape `_GUARDS_DIR` (defence-in-depth; the hash dirname already neutralizes traversal).
- Tests: register→persist→load round-trip; ledger append + chain verify; tamper detection (edit a line → `verify_chain` False → `ledger_corrupt`); crash-recovery (append entry, leave stale registry cache, reload → state from ledger head); in-process lock serializes two coroutines; idempotency lookup; resource_id hash-dirname + raw-id mismatch rejection; traversal rejection.

### S2 — `guard/fingerprint.py`
- `guard_checksum(graph, edge_predicates, terminal, stakes) -> str`: `hashlib.sha256(canonical_json({...}).encode()).hexdigest()`. NEW function (not `compute_spec_checksum`, which fingerprints `IRFlowDef`). Same technique. Deterministic across key ordering (canonical_json sorts keys).
- Tests: stable across dict-key reordering; changes when any predicate/edge/stake changes; matches design's "weaken by re-register → checksum changes" property.

### S3 — `guard/evidence.py` (server-side trusted evaluator — C1)
- `EvidenceResult` dataclass `{met: bool, per_predicate: list[{id, statement, met, evidence}]}`.
- `evaluate_evidence(predicates, workspace_root, ledger_entries) -> EvidenceResult`. Each predicate is `{id, type, statement}`. A small **dispatch on a trusted-builtin name** parsed from `statement` — NOT `eval`. Implement a minimal safe parser: predicates are declared as `builtin('arg', ...)` calls; parse the call, dispatch to the Python impl. (No `eval`; explicit allowlist of 4 builtins.)
  - `server_file_exists(rel_path)` → `(workspace_root / rel_path).is_file()`, with traversal guard (resolved path must stay under `workspace_root`).
  - `git_commit_exists(sha)` → `subprocess.run(["git","rev-parse","--verify","--quiet", f"{sha}^{{commit}}"], cwd=workspace_root, capture_output=True, timeout=5, check=False).returncode == 0`.
  - `command_exit_zero(cmd_list)` → `subprocess.run(cmd_list, cwd=workspace_root, capture_output=True, timeout=cap, check=False).returncode == 0`, run via `asyncio.to_thread`. `cap = int(os.environ.get("STRATUM_GUARD_CMD_TIMEOUT_S", "120"))`. **Opt-in (finding-4):** if a guard registers any `command_exit_zero` predicate, `register_guard` requires `STRATUM_GUARD_ALLOW_COMMANDS=1` else errors `command_execution_disabled`. The command list is fixed in the *registered, checksummed* edge_predicates — a per-transition caller cannot inject it.
  - `verdict_receipt_clean(verdict_digest)` → search **this resource's** `ledger_entries` for an entry with `entry_digest == verdict_digest` AND `outcome == "applied"` (or `kind == "review_clean"`). Same-resource only (no cross-resource receipts in v1). Re-validated against the (chain-verified) append log, never a fresh claim. Returns `False` if not found or chain unverified.
- `workspace_root` validated at registration: must be an existing absolute directory (`Path(workspace_root).is_dir()` and `is_absolute()`), else `invalid_workspace_root`. `server_file_exists` resolves `(workspace_root / rel).resolve()` and requires it stays under `workspace_root.resolve()` (traversal guard).
- All builtins are dispatched by an **explicit allowlist** (no `eval`): parse each `statement` as a single call `name(args...)` via `ast.parse(mode="eval")`, reject anything but a `Call` to one of the 4 names with literal args.
- Catch `(FileNotFoundError, subprocess.TimeoutExpired, OSError, ValueError)` → predicate `met=False` with evidence reason (never raise across boundary). Unknown/malformed builtin → `EvidenceParseError` (surfaced as a registration-time error, since predicates are fixed at registration).
- Tests (real fs + real git in `tmp_path` repo): file exists/missing/traversal-blocked; commit exists/absent (init tmp git repo, make a commit); command exit 0 / nonzero / timeout / disabled-without-env; verdict receipt found/absent/digest-mismatch; malformed statement → parse error.

### S4 — `guard/transition.py` (orchestration)
- `register_guard(resource_id, graph, edge_predicates, initial, terminal, stakes, workspace_root) -> {guard_id, checksum}`: validate state-name charset; **`initial` is a required param, stored in `GuardRegistry`** and used as genesis `current_state` (finding-F4); `graph_version=1`, persist. Immutable: re-register with a *different* checksum → error `guard_already_registered` (must use `migrate`); re-register identical → idempotent no-op.
- `guard_transition(resource_id, from_state, to_state, artifacts, modified_files, idempotency_key, resolved_by) -> {status, verdict, ledger_ref, current_state}`. **Concurrency discipline (finding-5): expensive verification runs OUTSIDE the lock; commit is optimistic under the lock.**
  1. **Under `resource_lock`** (fast, no LLM): `load_registry` (derives `current_state` from chain-verified ledger; `ledger_corrupt` fails closed); recompute `guard_checksum` vs stored → else `guard_tampered`; idempotency check (below); `from_state != current_state` → `refused` (`stale_from_state`); `to_state not in graph[from_state]` → `refused` (`illegal_edge`). **Release lock.**
  2. **Outside the lock:** evaluate predicates. Split edge predicates into trusted-evidence (S3) and LLM-tier (`type in {verified, judged}`). `evaluate_evidence(...)`; if any LLM-tier present, `await run_judge(...)` with the edge's `stakes`. `met = evidence.met AND (judge.met if llm else True)`.
  3. **Re-acquire `resource_lock` to commit:** re-check `current_state == from_state` (state may have advanced while judging) → else `refused` (`stale_from_state`, no double-apply). Append ledger entry (`applied`/`refused`) — **the durable commit point, written regardless of outcome**. `append_ledger` returns `entry_digest`, surfaced as **`ledger_ref`** — the receipt token a caller persists and later presents to `verdict_receipt_clean(verdict_digest=ledger_ref)` (finding-F2). If met → update registry cache `current_state`. Return `{status, verdict, ledger_ref, current_state}`.
- **`run_judge` namespace & side effects (findings 6, F3):** `staging.py:50,141` rejects `/`, `\`, NUL in `flow_id`/`step_id`. So both identifiers are **hashed to a safe charset**: `flow_id=f"guard-{sha256(resource_id.encode()).hexdigest()[:16]}"`, `step_id=f"e-{sha256(f'{from_state}->{to_state}@{idempotency_key or ''}'.encode()).hexdigest()[:16]}"`. (State names are already charset-validated at registration, but hashing the full step_id is robust regardless of idempotency-key contents.) This stages a turn tree + appends `turns.jsonl` under `~/.stratum/judge/<flow_id>/` — documented as part of the guard audit contract, namespaced per resource so guard runs never collide with real flows.
- **Uniform verdict shape (finding-6):** the API always returns `verdict: JudgeResult`-dict. For deterministic-only edges (no `run_judge` call), synthesize via `_evidence_to_judge_result(evidence)` — a `JudgeResult` with `clean==met`, one `PredicateResult` per evidence predicate (`verdict="met"/"not_met"`, `confidence=10`, `evidence=[...]`), serialized with `.to_dict()`. Honors the `clean==met` invariant (`result.py:235`).
- **Idempotency (finding-7):** `payload_digest = sha256(canonical_json({from_state,to_state,artifacts,modified_files,resolved_by}))`. Key seen + **same** `payload_digest` → `replayed` (return prior entry's verdict, no state change). Key seen + **different** `payload_digest` → `idempotency_conflict` error (never a silent replay).
- **Paranoid edge requires a trusted predicate:** enforced at `register_guard` (not transition) — if an edge's `stakes=="paranoid"` and it declares zero trusted-evidence (S3) predicates → `paranoid_edge_needs_trusted_evidence`. ("consequential" in the design prose maps to the checkable `paranoid` class.)
- `guard_override(resource_id, from_state, to_state, override_token, rationale, resolved_by) -> {status, ledger_ref}`: validate token against `GUARD_OVERRIDE_TOKEN` env (v1 per design open-Q #1: env-injected, not agent-mintable; absent env → `override_unavailable`). Append `kind="deviation"`. Update state. Requires `resolved_by=="human"`.
- `guard_migrate(resource_id, new_graph, new_edge_predicates, new_terminal, new_stakes, override_token, rationale) -> {checksum, graph_version}`: token-gated; bump `graph_version`; append `graph_version` ledger entry; never silently relaxes in-flight policy.
- `guard_history(resource_id) -> {current_state, ledger: [...]}`.
- Tests: full applied path (deterministic edge); refused on failing predicate (ledger still appended); illegal edge; stale from_state; tamper rejection; idempotent replay; idempotency_conflict; override with/without token; migrate bumps version + immutability; paranoid-edge-without-trusted-predicate rejected at register.

### S5 — MCP tools (`server.py`, new banner section before `def main()`)
Five `async def` `@mcp.tool(description=...)` wrappers, `ctx: Context` trailing positional, returning structured dicts, converting `GuardError` subclasses to `{status:"error", error_type: exc.__class__.__name__, message: str(exc)}`:
- `stratum_guard_register(resource_id, graph: dict[str,list[str]], edge_predicates: dict[str,list[dict]], initial: str, ctx, terminal: list[str]=[], stakes: dict[str,str]={}, workspace_root: Optional[str]=None)`
- `stratum_guard_transition(resource_id, from_state, to_state, artifacts: dict[str,str], ctx, modified_files: Optional[list[str]]=None, idempotency_key: Optional[str]=None, resolved_by: str="agent")`
- `stratum_guard_override(resource_id, from_state, to_state, override_token, rationale, ctx, resolved_by: str="human")`
- `stratum_guard_migrate(resource_id, new_graph: dict[str,list[str]], new_edge_predicates: dict[str,list[dict]], override_token, rationale, ctx, new_terminal: list[str]=[], new_stakes: dict[str,str]={})`
- `stratum_guard_history(resource_id, ctx)`
- Tests (`tests/test_server_guard.py`): direct `await stratum_guard_*` calls with `_Ctx` fake + `monkeypatch.setattr(guard.store, "_GUARDS_DIR", tmp_path)`; register→transition(applied)→history E2E; transition refused returns dict not exception; register with bad graph → error dict.

## Persistence layout
```
~/.stratum/guards/<slug(resource_id)>/registry.json   # checksummed graph + predicates + current_state + graph_version + raw resource_id
~/.stratum/guards/<slug(resource_id)>/ledger.jsonl     # hash-chained, append-only
~/.stratum/guards/<slug(resource_id)>/.lock            # flock sidecar
```

## Non-goals (this run)
- COMP-MCP-ENFORCE wiring (separate follow-up /compose run; this run ships the substrate only).
- Cryptographic signing of ledger (v1 = hash-chained, per design §"Ledger integrity").
- Override-token issuance UX beyond env var (design open-Q #1).

## Verification table (Phase 5)

| Ref in blueprint | Checked | Result |
|---|---|---|
| `run_judge` signature `kernel.py:56` async | yes | accurate (async, plain args) |
| `evaluate_t1` `{"__builtins__":{}}` jail `predicates.py:69-90` | yes | accurate → grounds C1 |
| no *cross-process* flock/FileLock in stratum_mcp | yes (grep) | accurate → grounds C2 |
| in-process `asyncio.Lock` exists `parallel_exec.py:74,551` | yes (Codex gate) | accurate → C2 reworded; reused for in-process serialization |
| no git-object/command-runner helper | yes (grep) | accurate → grounds C3 |
| `canonical_json` `result_cache.py:62` | yes | accurate, importable |
| `migrate._atomic_write` `migrate.py:296` | yes | accurate (fsync+os.replace) |
| `_FLOWS_DIR` module-global pattern `executor.py:1346` | yes | accurate, monkeypatched in tests |
| FastMCP derives schema from type hints (no Pydantic) | yes | accurate |
| error-dict convention `{status,error_type,message}` | yes | accurate |
| `JudgeResult.clean==met` invariant `result.py:235` | yes | accurate → C6 |

No stale references remain. No Boundary Map topology violations (S2 depends on existing `canonical_json`; S3 on S1 ledger; S4 on S1+S2+S3+existing run_judge; S5 on S4). Gate: **PASS** pending Codex review.
