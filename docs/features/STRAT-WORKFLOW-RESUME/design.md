# STRAT-WORKFLOW-RESUME — Design (content-addressed prefix-cache replay)

**Status:** Phase 1 design (2026-05-31) — not yet implemented. First Codex design-gate pending.
**Owner repo:** stratum
**Track:** STRAT-WORKFLOW (siblings `-NAMING`, `-IMPERATIVE`, `-PIPELINE*`, `-BUDGET*` shipped).
**Relationship to `T2-F5-RESUME`:** the forge-top ROADMAP row says this "depends on / extends `T2-F5-RESUME` (live-process reparenting, currently the unbuilt half)." **Verified stale on that clause:** `T2-F5-RESUME` is **merged** (`2101cc4`, 2026-05-31). The two are **orthogonal siblings**, not a strict dependency: `T2-F5` keeps a *live child process* alive across an MCP-server restart; this feature *reuses recorded step results* across re-runs so an unchanged prefix is never re-dispatched. They compose (a resumed flow can both reattach a live codex child **and** skip cached prefix steps) but neither needs the other to function. 7th confirmed stale-forge-top-row instance (see [[feedback_verify_roadmap_rows_vs_disk]]).
**Related:** [[feedback_ship_narrow_first]], [[feedback_verify_isolation_primitives]], [[project_strat_workflow_epic]], [[idea_plan_diffing]].

## Problem

When you **iterate an orchestration** — tune a later phase of a flow and re-run — Stratum re-executes the entire prefix from scratch. A research → design → review → implement flow whose first three steps are unchanged still re-dispatches all three agents on every run, paying full latency and token cost to reproduce results that are byte-identical to last time.

Verified in the source:

- A re-run is a **fresh `flow_id`** with empty `step_outputs` (`create_flow_state`, `executor.py:1465`). Nothing is shared across runs.
- `stratum_resume` (`server.py:373`) restores **within-run** position only — `current_idx` + persisted `step_outputs` from `~/.stratum/flows/<flow_id>.json` (`restore_flow`, `executor.py:1265`). It lets a *crashed* run continue; it does nothing for a *new* run of the same (or lightly-edited) workflow.
- There is **no result cache or memoization anywhere** in `stratum_mcp` (verified definitively: the only `cache` hits are the LLM pricing table `pricing.py:42` and per-split lane memoization in `parallel_exec.py:244/508`; neither caches agent results).

Dynamic-workflow runners elsewhere (e.g. the Claude Code Workflow harness) already cache agent results by `(prompt, args)` so "same script + same args → 100% cache hit." Stratum — positioned as the *governed, portable, cross-model* answer to dynamic workflows ([[project_strat_workflow_epic]]) — has no equivalent. This feature adds it, **governed**: cache hits are auditable, opt-in, and invalidation is content-addressed, not time-based.

## Verified architecture (read the source, don't infer)

- **Step input is a deterministic function of prior state.** `resolve_inputs` / `resolve_ref` (`executor.py:479–551`) build a step's input dict purely from `flow_inputs` + `step_outputs[deps]` via `$.input.*` / `$.steps.<id>.output[.field]` refs. This dict is the **only** thing (besides the step's own def) that determines what the agent is asked to do → it is the cache-key source.
- **A clean single interception point exists.** `get_current_step_info` (`executor.py:1518`) is where the next `compute` step is turned into an `execute_step` dispatch dict, *after* `skip_if` (check at `:1538`) and policy resolution, *before* the dict is returned. A cache **hit** short-circuits here: synthesize the result, advance `current_idx`, tail-recurse — exactly how `skip_if` already skips a step (check `:1538` → tail-recurse `:1542`).
- **Result storage already round-trips.** `process_step_result` writes `state.step_outputs[step_id] = result` (`executor.py:1921`) after schema + `ensure` validation; `persist_flow` (`:1227`) serializes the whole `FlowState` to JSON. A cache **write** happens right after a real result is validated.
- **Content-addressing primitive already exists.** `compute_spec_checksum(flow_def, spec)` (`executor.py:1084`) is a deterministic SHA-256 over the *parsed* flow + referenced function defs (intent, ensure, mode) — whitespace/comment-insensitive. Folding it into the cache key means **any** change to a step's function (intent/ensure/mode) or the flow's structure invalidates that step and everything downstream, for free.
- **Steps are not all pure.** A `compute` step's *declared* effect is its `output` dict (validated against `output_schema`), but the **agent that produces it may also write files / commit**. Replaying a cached result skips the agent entirely → skips those writes. So content-addressed replay is sound **only** for steps whose declared output fully captures their effect. This is the load-bearing constraint the whole design is built around (see §1, §6). [[feedback_verify_isolation_primitives]]
- **Side-effecting / nondeterministic step kinds are out of v1.** `gate` (human decision), `parallel_dispatch` / `pipeline` (server-dispatched, fan-out — already T2-F5's domain), per-step iteration loops (`max_iterations`/`exit_criterion`/`score_expr`, `executor.py:~1860`), `judge` steps, and accumulator steps (`iteration_accumulator`, `executor.py:995`) all either mutate, loop, or carry cross-call state. None are cacheable in v1.

## Design

### 1. Scope (ship-narrow)

v1 caches **opt-in, side-effect-free `compute` steps only**.

- **Opt-in, per step or per function.** A step (or the function it references) declares `cache: true`. Default is `false` — **nothing is cached unless the author says so.** Rationale: the author is the only party who knows whether a step's declared output captures its full effect. We do **not** infer purity. [[feedback_ship_narrow_first]]
- **Eligible:** `mode: compute` steps with `cache: true`. The validator (`spec.py`) **rejects `cache: true` at parse time** (fail-closed, like the `skip_if`-on-gate rejection) when the step is any of:
  - a `gate` (function `mode == "gate"`), `parallel_dispatch`, or `pipeline` step;
  - a `judge` step;
  - an iteration-loop step — `step.max_iterations` set **or** `step.exit_criterion` set **or** `step.score_expr` set (`_step_fingerprint`, `executor.py:1116–1121`);
  - an accumulator step — `step.accumulate is True` (`executor.py:1122–1123`);
  - a **routing** step — `step.next` is set (`spec.py:103`; see §4 — the hit path advances `current_idx += 1` and does not honour `next:` jumps in v1, so routing steps are excluded rather than partially-handled). Replicating `next:`/`_clear_from` routing on the hit path is a named follow-up.
- **Best-effort, never wrong.** A cache miss (or a disabled cache) always falls back to a normal dispatch. A cache hit is only ever taken when the key matches exactly. There is no partial/fuzzy match.

### 2. Cache key (content-addressed)

```
key = sha256(
  CACHE_VERSION ‖ flow_name ‖ step_id ‖
  spec_checksum ‖                       # invalidates on any flow/fn-def change
  canonical_json(resolved_input)        # invalidates on any upstream output change
)
```

- `spec_checksum` is `compute_spec_checksum(flow_def, spec)` — already computed and stored on `FlowState` (`spec_checksum`, `executor.py:1006`). Covers the step's function intent/ensure/mode + flow structure.
  - **Required fix (folds into this feature):** `compute_spec_checksum`'s fingerprints currently **omit guardrails** — `_fn_fingerprint` (`executor.py:1138–1150`) covers `{name, mode, intent, ensure}` but not `fn_def.guardrails` (`spec.py:59`), and `_step_fingerprint` (`:1093–1136`) omits `step.step_guardrails` (`spec.py:127`). Guardrails are applied in `process_step_result` *before* `ensure` (`executor.py:1794–1863`), so a tightened guardrail that would now block a result must invalidate the cache. Add `fn_def.guardrails` to `_fn_fingerprint` and `step.step_guardrails` to `_step_fingerprint` (one line each). This closes the gap for **every** consumer of the checksum (tamper detection too), not just the cache. With this in place, "any flow/fn-def change invalidates" is true.
- `resolved_input` is the exact dict `resolve_inputs` produces for the step (the same value already shown to the agent). `canonical_json` = `json.dumps(sort_keys=True, separators=(",",":"))` with a deterministic fallback for any non-JSON value (→ miss, never raise).
- **Prefix property falls out for free:** if step _N-1_'s output changes, step _N_'s `resolved_input` changes, so _N_ misses — and so does everything downstream of _N_. An unchanged prefix hits; the first changed step and its suffix miss. This is precisely "an unchanged prefix returns instantly."
- `CACHE_VERSION` is a module constant bumped whenever the cache record format or key composition changes (forces a clean miss across an upgrade).

### 3. Cache store (shared across runs)

- **Location:** `~/.stratum/cache/results/<key>.json` (sibling of `~/.stratum/flows/`). Content-addressed, so it is shared across `flow_id`s and across sessions — that is what makes a *new* run of the same workflow hit.
- **Record shape:**
  ```json
  {
    "key": "<sha256>",
    "flow_name": "...", "step_id": "...",
    "spec_checksum": "...",
    "output": { ... },                 // the validated step result
    "created_at": "<iso8601>",         // for TTL/GC only, never part of the key
    "cache_version": <int>,
    "source_flow_id": "<flow_id>"      // provenance: which run produced it
  }
  ```
- **Read:** load, verify `cache_version` and `key` match (defend against a hand-edited/corrupt file → treat as miss), return `output`.
- **Write:** atomic (`write` to `*.tmp` + `os.replace`), after `process_step_result` validates schema + `ensure`. Only **successful** results are cached (a step that failed `ensure` is never written).
- **Eviction:** size/age cap (e.g. keep ≤ N MB or ≤ D days, GC oldest by `created_at` on write). v1 can ship a simple count/age sweep; not on the hot path.

### 4. Hit path (the short-circuit)

In `get_current_step_info`, for an eligible `cache: true` step, after `resolve_inputs`:

```python
if cache_enabled(step) and not _cache_disabled_env():
    k = result_cache_key(state, step, resolved)
    cached = result_cache_get(k)            # None on miss / corrupt / version-skew
    if cached is not None:
        # re-validate against the CURRENT schema + ensure before trusting it
        ok = _revalidate(step, cached, state)
        if ok:
            record_cache_hit(state, step, k)     # StepRecord with cache_hit=True, key=k
            state.step_outputs[step.id] = cached
            state.current_idx += 1
            return get_current_step_info(state)  # dispatch the next step
        # else: stale/invalid → fall through to a normal dispatch (miss)
```

- **`ensure` is still enforced on the cached value.** Because `ensure` lives in the function def and is covered by `spec_checksum`, a changed `ensure` already changes the key (→ miss). The re-validation is belt-and-suspenders against a record written under an old `CACHE_VERSION` that slipped the version check.
- The cached output participates in downstream `$.steps.<id>.output` resolution **identically** to a freshly produced one — no downstream code can tell the difference (that's the point), except via the audit trail.

### 5. Miss path (populate)

On a normal dispatch (cache disabled, miss, or stale), the step runs as today. In `process_step_result`, after the result passes guardrails + schema + `ensure` and `state.step_outputs[step_id] = result` (`executor.py:1921`), **if the step is `cache: true`**, write to the cache. `process_step_result` does not currently receive the resolved input, so the key is computed by **re-running `resolve_inputs(step.inputs, state.inputs, state.step_outputs)`** at write time. This is safe and yields a value byte-identical to the one `get_current_step_info` computed: every dependency's output is frozen in `state.step_outputs` before the current step runs, and `state.inputs` is immutable for the flow's life — so there is no second source of truth to drift. (Threading the already-resolved dict through from `get_current_step_info` is the alternative; recompute is chosen for a smaller call-signature blast radius.) Failures and rejected results are never cached.

### 6. Governance & auditability (this is Stratum, not a generic cache)

- **Cache hits are first-class in the trace.** A hit records a `StepRecord` with `cache_hit: true` and the `key` (and `source_flow_id`), so `stratum_audit` shows exactly which steps were replayed vs. freshly executed. A cached result is **never** silently passed off as a fresh run. This mirrors how `skip_if` writes a `SkipRecord`.
- **Kill switch:** `STRATUM_DISABLE_RESULT_CACHE=1` env var forces every step to miss (ops escape hatch; also used by tests to assert the no-cache baseline is byte-identical to today).
- **Budget interaction:** a cache hit dispatches no agent → debits **nothing** (no tokens, no dispatch). This is correct and is the entire value proposition; the audit's `cache_hit` flag makes the "why is the budget lower" obvious.
- **The side-effect caveat is documented, not hidden.** `cache: true` is the author asserting "this step's `output` is its whole effect." The SPEC/README entry states plainly: do **not** mark a step `cache: true` if its agent writes files, commits, or otherwise mutates state you rely on downstream — the cache replays the *result*, not the *writes*. [[feedback_verify_isolation_primitives]]

### 7. IR / schema change

One new optional field, `cache: bool = false`, on the step def (and, for ergonomics, allowed on the function def, with step-level winning). Added to:
- the IR parse/validate (`spec.py`) with the eligibility rejection (§1),
- the `spec_checksum` canonical serialization (so toggling `cache` is itself a checksum change — conservative; avoids a stale hit when an author flips caching on/off),
- the `.stratum.yaml` schema docs.

Separately (and independently useful), `compute_spec_checksum` is corrected to fingerprint **guardrails** (`fn_def.guardrails` in `_fn_fingerprint`, `step.step_guardrails` in `_step_fingerprint`) — see §2. No change to `output_schema`, gates, parallel, pipeline, iteration, or judge.

## Acceptance criteria

- [ ] **Opt-in default-off:** with no `cache:` field anywhere, behavior is **byte-identical to today** (a `STRATUM_DISABLE_RESULT_CACHE=1` run and a no-`cache:`-fields run produce identical traces/dispatches). Regression-guarded.
- [ ] **Eligibility validation:** `cache: true` is **rejected at parse time** with a clear message on a gate / `parallel_dispatch` / `pipeline` / `judge` step, on an iteration-loop step (`max_iterations` ∨ `exit_criterion` ∨ `score_expr`), on an accumulator step (`accumulate is True`), and on a routing step (`next` set).
- [ ] **Key composition:** `result_cache_key` folds `CACHE_VERSION`, `flow_name`, `step_id`, `spec_checksum`, and `canonical_json(resolved_input)`; a non-JSON-serializable resolved input degrades to a miss (never raises).
- [ ] **Prefix hit / suffix miss:** in a 4-step flow with all steps `cache: true`, run once (populate); re-run unchanged → all 4 hit (zero agent dispatches). Edit step 3's function intent → re-run → steps 1–2 hit, steps 3–4 miss and re-dispatch.
- [ ] **Upstream-change cascade:** change a value in flow `inputs` that step 1 consumes → step 1 (and all downstream) miss.
- [ ] **`spec_checksum` invalidation:** changing a cached step's `ensure`, `intent`, **or guardrail pattern** (`fn_def.guardrails` / `step.step_guardrails`, now fingerprinted) → that step misses (key changed). Regression test that a guardrail-only edit changes the checksum.
- [ ] **`ensure` still enforced on hits:** a cached value that would fail the current `ensure` is not trusted (covered by key change; re-validation belt-and-suspenders verified).
- [ ] **Only successes cached:** a step that fails `ensure` (then retries) writes **nothing** to the cache; the eventual passing result is the only thing cached.
- [ ] **Atomic store:** concurrent writers of the same key don't corrupt the record (tmp + `os.replace`); a corrupt/old-version record on disk → miss, not crash.
- [ ] **Audit visibility:** `stratum_audit` / the trace shows `cache_hit: true` + key for replayed steps; freshly-run steps unchanged.
- [ ] **Budget:** a cache hit debits zero tokens/dispatches; verified against `budget_state`.
- [ ] **Kill switch:** `STRATUM_DISABLE_RESULT_CACHE=1` forces all misses.
- [ ] **Eviction:** age/size sweep removes old records without affecting live keys.
- [ ] Full combined suite green; CHANGELOG + report; stratum ROADMAP row added (owning repo) and forge-top row updated (stale `T2-F5` clause corrected). Codex design gate + impl review → REVIEW CLEAN.

## Out of scope (named follow-ups)

- **Caching side-effecting steps** (file writes/commits) — would need durable side-effect capture/replay (snapshot the worktree delta and re-apply). Large; its own ticket if ever wanted.
- **Caching `parallel_dispatch` / `pipeline` results** — fan-out + per-task state + T2-F5 live-process concerns; a follow-up once single-step caching is proven (`STRAT-WORKFLOW-RESUME-PARALLEL`).
- **`next:` / routing-step caching** — v1 excludes steps with `step.next` set rather than replicate the `_clear_from` + jump logic (`process_step_result`, `executor.py:1927–1932`) on the hit path. Replicating it is a clean follow-up (`STRAT-WORKFLOW-RESUME-ROUTING`).
- **Caching iteration / judge loops** — nondeterministic by design (hill-climbing, scoring); not a cache target.
- **Cross-host / shared team cache** — v1 is a local `~/.stratum/cache/`. A shared/remote cache (content-addressed store keyed identically) is a clean extension but out of scope.
- **`stratum_agent_run` result caching** — the standalone agent-run path (`_AGENT_RUN_TASKS`, in-memory) has no durable record; same boundary T2-F5 drew. Follow-up.
