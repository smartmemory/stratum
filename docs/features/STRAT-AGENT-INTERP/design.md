# STRAT-AGENT-INTERP — Interpolatable per-step `agent`

**Status:** SHIPPED 2026-06-19 — design + impl Codex reviews CLEAN; 18 new tests; full suite green (3 pre-existing codex-model failures unrelated)
**Owner:** Stratum
**Roadmap:** compose/ROADMAP.md row 302 (PLANNED)
**Consumer:** COMP-CODEX-IMPL (compose) — a router step picks the implementation executor at runtime.

## Problem

A Stratum step's executor is fixed in the spec text: `Step.agent` is a literal
string (`"claude"` / `"codex"`) emitted **verbatim** by the executor at every
dispatch surface. A step's `inputs` are already resolved through the JSONPath
resolver (`$.input.*`, `$.steps.*.output.*`), but the `agent` field is not. So a
flow cannot decide its executor from recorded flow state — e.g. a `route` step
that emits `{agent: "codex"}` cannot drive a later `implement` step.

This is the data-plane enabler for COMP-CODEX-IMPL (Codex-implements / Claude-reviews):
it lets a single flow select per-step executors at runtime without a control-plane
orchestrator hook.

## Grounding (verified against disk, stratum-mcp @ 63fc11d)

- `Step.agent: str | None` — `spec.py:102`. JSON-schema type is bare `{"type": "string"}`
  (`spec.py:387,570,622`) — **no enum**, so a `$`-ref already passes spec parsing.
- The resolver: `resolve_ref(ref, flow_inputs, step_outputs)` — `executor.py:481`.
  Literals (no `$` prefix) return as-is; `$.input.*` / `$.steps.<id>.output[.f]` resolve;
  unknown prefix raises `RefResolutionError`.
- `inputs` resolution: `resolve_inputs` — `executor.py:575`, called at dispatch
  (`executor.py:1778`).
- `step.agent` emitted **verbatim** in `get_current_step_info` (`executor.py:1708`):
  function-gate `1770`, function-execute `1825`, inline `1851`, judge `1872`,
  decompose `1888`, parallel_dispatch `1924`; and in the result-cache `StepRecord` `1806`.
- Valid agent types: `_VALID_AGENT_TYPES = {"claude", "codex"}` — `connectors/factory.py:16`.
  `make_agent_connector` (`factory.py:19`) raises `ValueError` on unknown type.
- **Cache-key hazard:** `result_cache_key` (`executor.py:1284`) folds
  `_step_fingerprint(step)` (`executor.py:1144`), which carries the **literal**
  `step.agent` (`:1157`). Two runs of an interpolated step with identical inputs but
  different resolved agents (claude vs codex) would produce the **same** key and
  collide — a codex-produced result could be served for a claude dispatch. The
  resolved agent must enter the cache key.

## Approach

`step.agent` is read by **many** consumers, not one — dispatch envelopes, cert
injection/validation, the completion `StepRecord`, the result-cache key (read **and**
write), the server-side `ParallelExecutor` construction, and error envelopes. So the
design is not "substitute at one chokepoint" but "introduce one **helper** every
consumer routes through."

Resolution is a pure function of values that all survive persistence/resume —
`step.agent` (spec), `state.inputs` (flow inputs), `state.step_outputs` (prior step
outputs). So we **recompute** the resolved agent at each consumer rather than storing
new mutable state on `FlowState`; replay after a crash/restore yields the identical
value (step outputs are restored before any consumer runs). No new persisted field, no
serialize/restore surface.

### 1. `resolve_agent` helper (new, next to `resolve_inputs`)

```python
def resolve_agent(agent, flow_inputs, step_outputs) -> str | None:
    if agent is None:
        return None
    if not agent.startswith("$"):
        return agent                      # literal — unchanged, no new validation
    resolved = resolve_ref(agent, flow_inputs, step_outputs)   # may raise RefResolutionError
    # Validate the CONNECTOR PREFIX, not the whole string: profile agents like
    # "claude:reviewer" / "codex:fixer" are first-class (parallel_exec strips the
    # ":profile" suffix at _connector_type_from_agent, parallel_exec.py:111).
    base = resolved.split(":", 1)[0] if isinstance(resolved, str) else resolved
    if not isinstance(resolved, str) or base not in VALID_AGENT_TYPES:
        raise MCPExecutionError(
            f"Interpolated agent {agent!r} resolved to {resolved!r}; "
            f"expected a known connector prefix {sorted(VALID_AGENT_TYPES)} "
            f"(optionally with a ':profile' suffix)")
    return resolved
```

- Literal path is identity → byte-identical for existing specs.
- A `$`-ref must resolve to a string whose connector prefix is known, else a clear
  `MCPExecutionError`. (A router that forgot to emit an agent, or emitted a bad one,
  fails loudly at the consuming step rather than silently dispatching the wrong
  executor.) `claude:reviewer` and bare `codex` both pass; `"opus"` / `None` / a dict
  do not.
- `resolve_ref`'s own "not yet executed — check depends_on ordering" error surfaces
  unchanged if the referenced router step hasn't run (prevented statically by §5).

### 2. `effective_agent(state, step)` — the one accessor

```python
def effective_agent(state, step) -> str | None:
    return resolve_agent(step.agent, state.inputs, state.step_outputs)
```

Every site that currently reads `step.agent` for a runtime decision is rewritten to
call `effective_agent(state, step)` (or, inside `get_current_step_info`, a once-computed
local `resolved_agent`). Cheap, pure, resume-identical.

### 3. Single source of truth for valid agents

Expose `VALID_AGENT_TYPES` publicly from `connectors/factory.py` (alias the existing
private frozenset) and import it into `executor.py`. No second copy of the agent set.

### 4. Consumers to reroute (verified call sites, @ 63fc11d)

| Consumer | Site | Why it needs the resolved value |
|---|---|---|
| Dispatch envelopes (gate/function/inline/judge/decompose/parallel) | `executor.py` 1770, 1825, 1851, 1872, 1888, 1924 | the caller dispatches the agent it's told |
| Cache-hit `StepRecord` | `executor.py` 1806 | audit shows concrete executor |
| Cert **injection** at dispatch | `executor.py` 1841, 1886 | `(agent or 'claude').startswith('claude')` is False for a `$`-ref → cert wrongly skipped for a claude-resolved step |
| Cert **validation** at completion | `executor.py` 2094 | same literal-`startswith` bug, completion side |
| Completion `StepRecord` | `executor.py` 2045 | audit/resume record must be the concrete executor |
| Result-cache key (read / write) | `executor.py` 1794, 2167 → `result_cache_key` | **collision hazard** (below) |
| Server `ParallelExecutor` construction | `server.py` 1559 (`agent=cur_step.agent`) | server-dispatch parallel/pipeline runs the literal otherwise → interpolation silently ignored on the real parallel path |
| Server parallel/pipeline cert template | `server.py` 882 (`meta.get("_agent") or step.agent`), 885 | pipeline stage with no stage-`agent` + step-level `$`-ref must still gate cert on the resolved value |
| Server status/error envelopes emitting `agent` | `server.py` 598, 1145, 1175, 1350, 1377 | report the concrete executor, not the `$`-ref (observability) — route **every** envelope `agent` field through `effective_agent` |

`parallel_exec.py:931` (`task.get("_agent") or self.agent`) needs no change: it receives
the already-resolved `self.agent` from the server construction site, and
`_connector_type_from_agent` strips any `:profile` suffix.

### 5. Cache-key correctness

`_step_fingerprint` stays literal (it is the spec-tamper fingerprint — the spec text
`"$.steps.route.output.agent"` is exactly what whole-flow tamper detection must
protect). The **resolved** agent is folded into the content key instead — but
**conditionally**, only when the step's agent is interpolated:

```python
# result_cache_key(state, step, resolved, resolved_agent=None)
parts = [VERSION, flow_name, step.id, step_fp, fn_fp, payload]
if step.agent and step.agent.startswith("$"):   # interpolated only
    parts.append(resolved_agent or "")
raw = SEP.join(parts)
```

Appending a component **unconditionally** would change the digest of *every* step,
including literal-agent ones, needlessly invalidating all existing on-disk caches.
Gating the append on `step.agent.startswith("$")` keeps literal-agent keys
**byte-identical to today** (the literal already lives in `_step_fingerprint`), while
giving interpolated steps distinct keys for claude- vs codex-resolved dispatches so a
cross-executor result is never served. Both call sites (read `1794`, write `2167`)
pass `effective_agent(state, step)`. Golden-tested both ways.

### 6. Static validation (spec.py)

- **Ordering is enforced at runtime, not parse time — deliberately.** The topological
  sort uses "explicit depends_on edges only (no `$` ref scanning)" (`spec.py:1355`);
  `inputs` `$`-refs are likewise never statically checked against `depends_on` — an
  out-of-order ref surfaces as `resolve_ref`'s precise "not yet executed — check
  depends_on ordering" error. Adding a static ordering/shape check **only** for `agent`
  would be an asymmetric special case against that established convention, so we don't:
  an interpolated agent referencing an unrun step raises the same runtime
  `RefResolutionError` (now wrapped by `resolve_agent`) every other `$`-ref does. (The
  design originally proposed a static check here; dropped during implementation to stay
  consistent with how the resolver already treats `inputs`.)
- **`has_cert` (`spec.py:1928`):** today `has_cert = bool(reasoning_template) and
  (step.agent or "claude").startswith("claude")`. A `$`-ref makes `startswith('claude')`
  False, so a step whose only validation is a `reasoning_template` would be wrongly
  flagged as having no validation (spurious `on_fail`-without-validation error). Fix:
  treat a `$`-ref agent **conservatively as cert-capable** —
  `agent_is_ref = bool(step.agent) and step.agent.startswith("$")`,
  `has_cert = bool(reasoning_template) and (agent_is_ref or (step.agent or "claude").startswith("claude"))`.
  Runtime still skips cert for a codex-**resolved** step (§4, executor 1841/2094 now use
  `effective_agent`); the static check only avoids a false rejection.

## Scope / non-goals

- **In:** `Step.agent` (main per-step field) for all caller-driven dispatch modes
  (function/inline/judge/decompose) and the parallel_dispatch envelope's step-level
  `agent`. Cache-key correctness. Static ref validation.
- **Out (v1):** pipeline **per-stage** `_agent` interpolation (the `stages[].agent`
  override resolved in `parallel_exec.py:931`) — stages are a separate desugaring; the
  step-level agent already covers the COMP-CODEX-IMPL flow. Note this in the report as
  a follow-up if COMP-CODEX-IMPL needs per-stage selection.
- **Out:** new agent types (opencode stays reserved, `factory.py:41`).

## Backward compatibility & determinism

- Literal agents: identity transform, zero envelope change. Verified by a golden test
  asserting byte-identical dispatch payloads for a literal-agent flow.
- Determinism: the resolved value comes only from recorded flow state (prior step
  outputs / flow inputs), so audit/resume/result-cache replay identically — no
  control-plane hook, no external non-deterministic actor. Satisfies the roadmap's
  "stays in the data plane" constraint.

## Test plan (TDD)

1. `resolve_agent`: None→None; literal→identity; `claude:reviewer`→identity (profile
   preserved); `$.steps.route.output.agent`→resolved; resolved `"opus"`/non-str→
   `MCPExecutionError`; ref to unrun step→`RefResolutionError`.
2. Dispatch: a 2-step flow `route`→`implement` with `agent: "$.steps.route.output.agent"`;
   assert the `implement` **execute_step** envelope carries the resolved concrete agent.
3. Golden byte-identity: a literal-agent flow's envelopes + completion StepRecord
   unchanged from current behavior.
4. Cache key: same step+inputs, agent resolving to claude vs codex → distinct keys
   (no cross-executor cache collision); literal-agent combined key unchanged from today.
5. Completion `StepRecord.agent` records the resolved concrete executor for an
   interpolated step (audit/resume correctness).
6. Server parallel-dispatch: a `parallel_dispatch` step with `agent: "$.steps.route.output.agent"`
   resolving to `codex` builds a codex `ParallelExecutor` (assert `_connector_type_from_agent`
   sees the resolved value, not the literal `$`-string).
7. Cert: a `reasoning_template` step with `agent: "$...."` resolving to `claude` still
   injects + validates the certificate; resolving to `codex` skips it.
8. spec.py static validation: `$`-ref agent to a non-dependency / malformed ref rejected;
   `reasoning_template` + `$`-ref agent does **not** trigger a spurious
   on_fail-without-validation error.
9. Full `pytest stratum-mcp/tests/` green.
