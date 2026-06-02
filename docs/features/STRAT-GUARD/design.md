# STRAT-GUARD — Standalone Guarded-Transition Primitive

**Status:** IMPLEMENTED (2026-06-02) — shipped in `stratum-mcp/src/stratum_mcp/guard/` + 5 MCP tools. This remains the Phase-1 intent document; see [`blueprint.md`](./blueprint.md) for the verified build plan (which corrected the trusted-evidence-vs-T1-jail framing below) and [`report.md`](./report.md) for what shipped. file:line references here describe the pre-implementation codebase.
**Owner:** stratum
**First consumer:** compose (`COMP-MCP-ENFORCE`)
**Created:** 2026-06-02

## Related Documents

- Consumer / driving design: `../../../../compose/docs/features/COMP-MCP-ENFORCE/design.md`
- Reused engine: STRAT-JUDGE (`docs/features/STRAT-JUDGE/`), STRAT-IMMUTABLE (in-flow integrity), STRAT-WORKFLOW-RESUME (content-addressed cache / append-only ledger pattern)

## Problem

Stratum already enforces strict guarantees — but **only for work expressed as a multi-step flow**. Every enforcement primitive in the MCP tool layer is hard-bound to a live `FlowState` keyed by `flow_id` + the *current* step:

- `stratum_judge` (`stratum-mcp/src/stratum_mcp/server.py:2109`) requires `step_id` to be the current step, that step to be IR-declared `judge:`, and the caller's `predicates`/`stakes`/`budget` to byte-match the IR (`server.py:2153-2195`).
- `stratum_gate_resolve` (`server.py:1785`) requires the current step's function to be `mode: gate` (`server.py:1816`, `executor.py:2176`).
- `verify_spec_integrity` (`executor.py:1303`) checks against a `FlowState.spec_checksum`.

A **client that manages its own resource lifecycle outside a flow** — e.g. compose's feature tracker, which transitions features through phases via REST/MCP calls, not a stratum flow — cannot reach any of this. So it hand-rolls a weaker, bypassable copy (see `COMP-MCP-ENFORCE`: self-approving gates, `force` overrides, no independent verifier).

The engine *underneath* the flow binding is already reusable and FlowState-light:

- `run_judge()` (`src/stratum/judge/kernel.py:56`) takes plain args — `predicates`, `artifacts`, `stakes`, `budget`, `workspace_root`, `stratum_agent_run` — and has **no FlowState dependency** (the only touch is a monotonic turn counter that degrades to `1`).
- `compute_spec_checksum()` / `_step_fingerprint()` (`executor.py:1103-1221`) are pure functions producing a SHA-256 over a canonical JSON fingerprint.
- The append-only per-turn audit ledger `~/.stratum/judge/<flow_id>/turns.jsonl` (`kernel.py:242`) is a plain JSONL writer.

**STRAT-GUARD exposes a standalone guarded-transition primitive over this engine** so any client gets strict, tamper-evident, independently-verified transitions without standing up a flow.

## What a "guarded transition" is

Move a tracked resource from state `A` → state `B`, permitted **only if**:

1. **Edge is legal** — `A → B` is an allowed edge in a transition graph the client registered.
2. **Preconditions verify** — the edge's declared predicates pass `run_judge` (T1 deterministic / T2 verified / T3 adversarial), evaluated against caller-supplied artifacts. The verifier is independent of the caller proposing the transition (separation of duties).
3. **Verdict is recorded** — every attempt (applied or refused) appends to a tamper-evident, append-only ledger.
4. **Idempotent** — an `idempotency_key` makes re-application a no-op replay, not a double transition.

The primitive is **resource-agnostic**: it knows nothing about "features" or "phases." The client supplies opaque `resource_id`, state labels, and predicates; the client owns the semantics.

## Surface (new MCP tools)

### `stratum_guard_register`
```
stratum_guard_register(
  resource_id: str,                 # opaque, client-namespaced (e.g. "compose:FEAT-1")
  graph: dict[str, list[str]],      # allowed edges: {from_state: [to_state, ...]}
  edge_predicates: dict[str, list[Predicate]],  # "A->B" -> precondition predicates
  terminal: list[str] = [],         # states with no outgoing edges
  stakes: dict[str, str] = {},      # per-edge stakes: cheap|default|paranoid
) -> { guard_id, checksum }
```
Registers (or re-registers — see Immutability) a guarded resource. The `(graph, edge_predicates, terminal, stakes)` tuple is **checksummed** at registration using the existing fingerprint machinery and stored. Neither the client nor any agent can later weaken a registered edge's predicates without the checksum changing and being rejected.

### `stratum_guard_transition`
```
stratum_guard_transition(
  resource_id: str,
  from_state: str,
  to_state: str,
  artifacts: dict[str, str],        # name -> content, staged for predicate eval
  modified_files: list[str] = [],
  idempotency_key: str | None = None,
  resolved_by: str = "agent",       # human | agent | system
) -> {
  status: "applied" | "refused" | "replayed",
  verdict: JudgeResult,             # full per-predicate evidence
  ledger_ref: str,                  # append-only ledger pointer
  current_state: str,
}
```
Flow:
1. Load the registered guard; **verify its checksum** (STRAT-IMMUTABLE pattern) — refuse if tampered.
2. Reject if `from_state` ≠ the resource's current state (no skipping the ledger).
3. Reject if `from_state → to_state` is not a legal edge.
4. Run `run_judge` on that edge's predicates against `artifacts`/`modified_files` at the edge's `stakes`.
5. Append the verdict to the ledger **regardless of outcome**.
6. If `verdict.met` → advance current state to `to_state`, return `applied`. Else return `refused` with the failing predicate evidence.
7. `idempotency_key` already seen → return `replayed` with the prior verdict, no state change.

**No `force` parameter.** A declared edge either verifies or it does not. Authorized deviations go through `stratum_guard_override` (below), recorded as a first-class ledger entry — never a silent boolean.

## Trusted evidence model (CRITICAL — addresses the fabrication hole)

The judge engine proves predicates over the **staged turn tree** (`predicates.py:39`, `kernel.py:90`). If `artifacts` is caller-supplied, a rogue client can fabricate the staged tree and "prove" anything (`design.md` exists, tests passed, review CLEAN). The `artifacts` param therefore **must not be the sole basis for a `met` verdict on a consequential edge.** Predicates bind to *trusted* evidence sources the caller cannot forge:

| Evidence kind | Trusted source (server-side) | Used for |
|---|---|---|
| File existence / content | The **guard server reads the file itself** from a registered, caller-declared workspace root — never from caller-staged `artifacts`. | `design.md` exists, schema present |
| Command result | A **command attestation**: the guard (or a trusted runner) executes the gate command and binds the real exit code — or the caller supplies a signed runner receipt. Never a caller boolean. | `tests_pass`, lint clean |
| Prior verdict | A **verdict receipt**: a CLEAN review is referenced by its ledger `verdict_digest` and re-validated against the append log — not re-asserted as a fresh claim. | "review was CLEAN" |
| VCS / object digest | The guard resolves `commit_sha` against the **real git object store**; content addressed by digest. | `commit_sha` exists, artifact unchanged |

`artifacts`/`modified_files` remain available as **interpretive context** for T2/T3 (the verifier may read them), but a `met` on a `paranoid`/consequential edge requires at least one trusted-source predicate. This is the difference between "the caller says it's done" and "the substrate confirmed it." The deterministic (T1) vocabulary must be extended with server-read variants (`server_file_exists`, `git_commit_exists`, `command_exit_zero`, `verdict_receipt_clean`) — this is **net-new predicate surface**, not reuse (see Correctness contract).

## Correctness contract (NOT open questions)

These are part of v1 correctness, not deferrable:

- **Per-resource serialization.** Every `stratum_guard_transition` takes a per-`resource_id` advisory lock spanning *read current-state → evaluate → append ledger → update state*. Without it, two concurrent `A → B` both pass. (Compose already uses advisory locks for its counters; same mechanism.)
- **Idempotency-key conflict is an error, not a replay.** A reused `idempotency_key` with a *different* payload returns `idempotency_conflict` — never a silent replay of the prior verdict. Same key + same payload → `replayed`.
- **Registration is immutable.** A registered `(graph, edge_predicates, terminal, stakes)` cannot be re-registered to weaker terms. Legitimate graph evolution (compose adds a phase) goes through a separate `stratum_guard_migrate(resource_id, new_graph, override_token, rationale)` that requires the override token, writes a `graph_version` ledger entry, and never silently relaxes an in-flight resource's policy. This closes the "weaken by re-register" bypass.

### `stratum_guard_override`
```
stratum_guard_override(
  resource_id, from_state, to_state,
  override_token: str,              # out-of-band authorization (not agent-mintable)
  rationale: str,
  resolved_by: "human",
) -> { status, ledger_ref }
```
The single sanctioned bypass. Requires a token the agent cannot mint itself, demands a human resolver and a rationale, and writes a `deviation` ledger entry. This replaces compose's `force: true` (which any caller can pass).

### `stratum_guard_history`
```
stratum_guard_history(resource_id) -> { current_state, ledger: [LedgerEntry, ...] }
```
Returns the append-only transition/verdict ledger — the tamper-evident audit trail.

## Persistence

Mirrors flow persistence under a dedicated namespace (no synthetic-flow lifecycle — the goal/judge synthetic-flow path adds teardown complexity we don't want here):

```
~/.stratum/guards/<resource_id>/registry.json   # checksummed graph + predicates + current_state
~/.stratum/guards/<resource_id>/ledger.jsonl     # append-only; one row per transition attempt + override
```

`LedgerEntry`: `{ ts, from_state, to_state, outcome, verdict_digest, resolved_by, idempotency_key, kind: "transition"|"deviation" }`.

## What it reuses (no rewrite)

| Need | Reuse | Location |
|---|---|---|
| Independent verifier (T1/T2/T3) | `run_judge()` — FlowState-light | `src/stratum/judge/kernel.py:56` |
| Deterministic predicate jail | T1 staged-tree eval (`artifacts/`,`modified/` prefixes) | `src/stratum/judge/predicates.py:39` |
| Checksum *technique* | SHA-256 over canonical sorted-key JSON (the method behind `compute_spec_checksum`) | `executor.py:1196-1221` |
| Append-only audit log | JSONL writer | `src/stratum/judge/logging.py:36` (callsite `kernel.py:242`) |
| Result schema/contract | `JudgeResult` + `compose/contracts/judge-result.json` | `src/stratum/judge/result.py:204` |

New code (NOT pure reuse — corrected from an earlier overclaim): the guard registry/store, edge-legality check, the **server-side trusted-evidence predicate layer** (`server_file_exists`/`git_commit_exists`/`command_exit_zero`/`verdict_receipt_clean`), a **guard-specific canonical fingerprint** function (`compute_spec_checksum` fingerprints `IRFlowDef`/`IRStepDef`, *not* an arbitrary `{graph, edge_predicates}` object — same SHA-256/canonical-JSON technique, new function), the per-resource lock, and four+one MCP tool registrations. The `run_judge` verifier and the result schema are consumed as-is; the checksum and ledger are reused at the *technique* level, not the function level.

### Ledger integrity (corrected claim)
The existing `turns.jsonl` is **append-only audit logging** — it does not hash-chain or sign, so it detects in-process omission but not offline file edits. v1 decision: ship append-only + a **hash-chained `prev_digest` per ledger entry** (each entry includes the SHA-256 of the prior entry) so offline tampering is detectable without a signing key. "Tamper-evident" means hash-chained, not cryptographically signed — signing is a later option.

## Key decisions

- **Standalone, not flow-bound.** Wraps `run_judge` directly with its own store. `stratum_judge`/`gate_resolve` remain the in-flow path; STRAT-GUARD is the path for clients managing resource lifecycles outside a flow.
- **No `force`.** Override is a separate, authorized, recorded operation.
- **Separation of duties is structural.** The verifier (T2/T3) runs independently of the caller; for `paranoid` edges the T3 cold-read Codex adversary fires (`kernel.py:159`). The proposer cannot also be the approver.
- **Resource-agnostic.** Compose supplies the phase graph + per-edge predicates; stratum enforces them. Stratum never learns what a "blueprint" is.
- **Clean contract for the TS port.** Per `project_stratum_ts_port`, this lands in Python now (accepted build-twice tax) but the tool contract above is the reimplementation spec — keep the Python impl thin so the TS port is mechanical. In TS, compose (also TS) may consume the primitive as a library rather than over MCP, removing the network hop.

## Open questions (for gate)

1. **Override token issuance** — where does the non-agent-mintable token come from? (Env-injected per session? Compose cockpit human action? Out of scope for v1 if we ship override as "human resolver + rationale, logged" without a cryptographic token first.)
2. **Trusted-runner boundary** — for `command_exit_zero`, does the guard server execute the gate command itself (simplest, but the server now runs arbitrary client commands), or accept a signed receipt from a trusted runner (needs a signing story)? v1 leans: guard executes, in the caller-declared workspace root, with a timeout — revisit if the run-arbitrary-command surface is unacceptable.

*(Resolved into the Correctness contract: concurrency → per-resource lock; re-registration → immutable + `stratum_guard_migrate`.)*

## Non-goals

- Not replacing in-flow `stratum_judge`/`gate_resolve`.
- Not a general workflow engine — single-resource state transitions only, no multi-step orchestration.
- Not owning client domain vocabulary (phases, statuses, schemas).
