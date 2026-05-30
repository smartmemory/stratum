# STRAT-WORKFLOW-BUDGET-DOLLARS — Design

**Status:** Phase 1 design (Compose build, 2026-05-30) — revised after Codex design-gate round 1 (3 findings addressed: retry-storm bypass on the consumer debit, scope narrowed to exclude the client-dispatched parallel path, unpriced-model surfacing under a `usd` cap; the proposed-signature finding was a false positive — `stratum_agent_run` already places `ctx` early followed by defaulted params). Round 2 refined the consumer-debit placement (after `process_step_result` validation, not before any branch) and routed the unpriced-model warning through the debit sites for both server- and consumer-dispatched paths. Round 3 added explicit `_cleanup_child()` on the exhaustion path so a terminal flow-ref step doesn't orphan its child, and tightened the AC wording. Not yet implemented.
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP)
**Related:** [[project_strat_workflow_epic]], parent [`STRAT-WORKFLOW-BUDGET`](../STRAT-WORKFLOW-BUDGET/design.md) (filed this follow-up explicitly), [[idea_budget_ceilings]]

## Problem

`STRAT-WORKFLOW-BUDGET` shipped run-wide budget enforcement on the MCP path for
three axes (`ms` wall-clock, `max_agent_dispatches`, `max_tokens`) but left
**`usd` recorded-not-enforced**. Two source facts forced that deferral and are
still true today:

1. **Connectors emit token counts, not dollars.** `claude.py:204-218` yields a
   `step_usage` event with `input_tokens`/`output_tokens`/`model` but **no
   `cost_usd`**; `codex.py:552-563` hardcodes `"cost_usd": 0`. So
   `accumulate_usage` (`run_budget.py:36`) always folds `0.0` into
   `acc["dollars"]`.
2. **`litellm.completion_cost` lives only in the library executor**
   (`src/stratum/executor.py`), and `stratum-mcp` has **no litellm dependency**.
   There is no token→price mechanism on the MCP path.

Net: `budget_exhausted` (`run_budget.py:88-109`) deliberately skips `usd` —
its docstring says *"`usd` is recorded-not-enforced and never trips."* A user
who writes `budget: { usd: 5.00 }` and nothing else gets **no ledger at all**:
`init_budget_state` (`executor.py:1292`) returns `None` when no *enforced* axis
is set, so a dollar cap is silently a no-op.

This feature closes that: compute dollars from token counts via a static pricing
table, then promote `usd` to an enforced axis.

## Verified architecture (read the source, don't infer)

- **`run_budget.py` is pure helpers** (no IO, no locks, no executor import).
  `accumulate_usage` already folds `cost_usd` into `acc["dollars"]`;
  `debit_budget` already takes `dollars=`; `budget_exhausted` already has the
  cap-check structure for the three enforced axes. The dollars plumbing exists
  end-to-end — only the *pricing source* and the *usd cap-check* are missing.
- **Usage events carry the model id.** Claude: `meta["model"] = active_model`
  (`claude.py:216`), default `claude-sonnet-4-6` (`CLAUDE_MODEL` env,
  `claude.py:23`). Codex: `meta["model"] = resolved_model_id` (`codex.py:562`),
  which **includes the `/effort` suffix** (`gpt-5.4/high`, `gpt-5.2-codex/medium`
  — `codex.py:224,229`). Both carry `input_tokens`/`output_tokens`.
- **Two server-side debit chokepoints exist and already debit dollars** (as 0):
  `stratum_agent_run` finally-block (`server.py:267-277`) and the parallel
  executor (`parallel_exec.py`). The dollar value they pass is whatever
  `accumulate_usage` produced — so fixing `accumulate_usage` fixes both for free.
- **`init_budget_state` gates ledger creation on an enforced axis**
  (`executor.py:1290-1303`): `enforced = (budget.ms, budget.max_agent_dispatches,
  budget.max_tokens)`; a `usd`-only budget returns `None` (no ledger). The `caps`
  dict it builds **already includes `usd`** (`executor.py:1298`) — so once `usd`
  is enforced, the only change needed is adding `budget.usd` to the `enforced`
  tuple so a usd-only budget yields a ledger.
- **`usd` is already a valid IR key.** `IRBudgetDef.usd` (`spec.py:29`) and the
  `BudgetDef` JSON schema (`spec.py:228,335,515`, `{"type": "number", "minimum":
  0}`) already exist. **No schema/IR change needed for the cap.**
- **Consumer-dispatched normal steps don't debit today.** `stratum_step_done`
  (`server.py:407`) takes no usage and only calls `_flow_budget_hard_stop`
  (`server.py:541`) — it halts on an already-spent budget but cannot *charge* the
  step it just completed. Only server-dispatched agents (`stratum_agent_run`,
  parallel tasks) debit. The parent design deferred consumer-reported usage to
  this follow-up (parent design "Resolved gate questions" #3).

## Scope

Four parts, all v1. No IR/schema change. No new dependency (static table, **not**
litellm — stratum-mcp must stay litellm-free).

### 1. Token→USD pricing table

New module `stratum-mcp/src/stratum_mcp/pricing.py` (keeps `run_budget.py` pure
and import-free of pricing constants; `run_budget.py` imports from `pricing`):

```python
# USD per 1M tokens, by BASE model id (effort suffix stripped). Approximate,
# hand-maintained — see STRATUM_MODEL_PRICING_JSON to override without a release.
MODEL_PRICING: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6":     {"input": 3.0,  "output": 15.0},
    "claude-opus-4-8":       {"input": 15.0, "output": 75.0},
    "claude-opus-4-7":       {"input": 15.0, "output": 75.0},
    "claude-opus-4-6":       {"input": 15.0, "output": 75.0},
    "claude-haiku-4-5":      {"input": 1.0,  "output": 5.0},
    "gpt-5.4":               {"input": 1.25, "output": 10.0},
    "gpt-5.2-codex":         {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex-max":     {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex":         {"input": 1.25, "output": 10.0},
    "gpt-5.1-codex-mini":    {"input": 0.25, "output": 2.0},
}

def _base_model(model: str) -> str:
    """Strip a codex /effort suffix: 'gpt-5.4/high' -> 'gpt-5.4'."""
    return (model or "").split("/", 1)[0]

def cost_from_tokens(model: str, input_tokens: int, output_tokens: int) -> float:
    """USD for a usage event. Prices input/output SEPARATELY (different rates).
    Unknown model -> 0.0 (degrade silently; never block a flow on a missing price)."""
    rates = _pricing_table().get(_base_model(model))
    if rates is None:
        return 0.0
    return (input_tokens / 1_000_000.0) * rates["input"] + \
           (output_tokens / 1_000_000.0) * rates["output"]
```

- **Effort suffix:** normalize via `split("/", 1)[0]` so all codex effort
  variants price as their base model.
- **Unknown model → `0.0`** (degrade, never raise — a missing price must not
  crash a flow; it just under-counts, same failure mode as today). **Caveat
  (finding 4):** a stale/custom model silently contributes `$0`, so a `usd` cap
  can be under-enforced for that model. Mitigation: a shared helper

  ```python
  def is_priced(model: str) -> bool:
      return _base_model(model) in _pricing_table()

  def _maybe_warn_unpriced(model: str, has_usd_cap: bool) -> None:
      """One-time logging.warning per unpriced base model when a usd cap is set."""
      if not has_usd_cap or not model or is_priced(model):
          return
      base = _base_model(model)
      if base not in _warned_models:
          _warned_models.add(base)
          logging.getLogger(__name__).warning(
              "STRAT-WORKFLOW-BUDGET-DOLLARS: no price for model %r; "
              "usd cap under-counts its cost as $0", base)
  ```

  is called at **every** point that prices from tokens under a `usd` cap. Two
  routes reach it, and the warning fires at the **debit** site (where the cap is
  in scope), not inside per-event accumulation:
    - **Server-dispatched** (`stratum_agent_run` finally `server.py:267`,
      parallel `_run_one` finally): `accumulate_usage` runs per event in
      `run_budget.py` and has no cap context, so it stays pure and simply tags
      any unpriced model id into the accumulator (`acc.setdefault(
      "unpriced_models", set())`). At the debit site, where `budget_state` (and
      thus the `usd` cap) is known, iterate `acc["unpriced_models"]` and call
      `_maybe_warn_unpriced(m, has_usd)`.
    - **Consumer** (`stratum_step_done`, §4): the model and cap are both in
      scope at the debit, so call `_maybe_warn_unpriced(model, has_usd)` directly
      before `cost_from_tokens`.

  `cost_from_tokens` and `accumulate_usage` stay logging-free (freely testable);
  `_maybe_warn_unpriced` lives in `pricing.py` and is the only logging point.
  Cost stays `0.0` — we surface the gap rather than block a flow on a missing
  price. The AC narrows the enforcement claim accordingly: `usd` is enforced
  **for priced models**; unpriced models under-count (and warn once).
- **Env override `STRATUM_MODEL_PRICING_JSON`:** a JSON object merged over (not
  replacing) `MODEL_PRICING` at load, so a single stale price can be patched
  without a release, and new models added. Parsed once and cached
  (`_pricing_table()` with a module-level memo); malformed JSON → log + ignore
  (fall back to the built-in table; never crash). Each entry must have numeric
  `input`/`output` or it's skipped.
- **Prices are approximate and maintained** — documented in a module docstring
  and in this design. The table is a best-effort ceiling-estimator, not billing.

### 2. Compute dollars from tokens in `accumulate_usage`

`run_budget.py:36`, the single line that folds dollars. Precedence:

```python
cost = float(meta.get("cost_usd") or 0.0)          # trust a connector that reports it
if cost <= 0.0:                                     # else derive from tokens
    cost = cost_from_tokens(
        meta.get("model") or "",
        int(meta.get("input_tokens") or 0),
        int(meta.get("output_tokens") or 0),
    )
acc["dollars"] = acc.get("dollars", 0.0) + cost
```

- **Precedence: `cost_usd` if `> 0`, else compute.** Future-proofs against a
  connector that starts reporting real dollars (claude SDK, opencode pass-through)
  — we never double-count or override a real value with an estimate.
- Priced from the **same `meta` dict** the token accounting already reads, so
  input/output are priced separately *before* they're summed into `acc["tokens"]`
  by the existing line above. No change to the token line.
- This single edit fixes **both** server debit chokepoints
  (`stratum_agent_run`, parallel executor) because both route usage through
  `accumulate_usage`.

### 3. Enforce `usd`

Two edits:

**a. `budget_exhausted` (`run_budget.py:88`)** — add the cap-check, mirroring the
existing three:

```python
usd = caps.get("usd")
if usd is not None and consumed["dollars"] >= usd:
    return True
```

Update the docstring (lines 89-93): `usd` is now an enforced axis alongside
`ms`/`max_agent_dispatches`/`max_tokens`.

**b. `init_budget_state` (`executor.py:1292`)** — add `usd` to the enforced
tuple so a `usd`-only budget produces a ledger:

```python
enforced = (budget.ms, budget.max_agent_dispatches, budget.max_tokens, budget.usd)
```

Update its docstring (lines 1284-1288): drop "a `usd`-only budget has nothing to
enforce"; `usd` now enforced. The `caps` dict already carries `usd`
(`executor.py:1298`) — no other change there.

### 4. Consumer-reported usage on `stratum_step_done` (sequential only)

**Scope note (finding 3):** this covers the *sequential* consumer path only. The
*client-dispatched parallel* path reports through `stratum_parallel_done`, whose
contract is `task_results[{task_id, result, status}]` with no usage field
(`server.py:764`) — extending it to carry per-task usage is a separate surface
and is **out of scope here** (see Out of Scope). Server-dispatched parallel tasks
(`ParallelExecutor`) already debit and now price dollars via §2, so they are
covered; only *client-dispatched* parallel work stays outside dollar enforcement
in v1.


So consumer-dispatched **sequential** steps (the common path — Claude Code runs
the agent and reports back) can debit, not just server-dispatched agents. Add an
optional `usage` param. **Signature (finding 2 — `ctx` is type-detected by
FastMCP, not position-bound; `stratum_agent_run` at `server.py:143-158` already
places `ctx` early followed by defaulted optionals, so this is the canonical
shape):**

```python
async def stratum_step_done(
    flow_id: str, step_id: str, result: dict[str, Any], ctx: Context,
    usage: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
```

Accepted shapes (both optional, additive — omitting `usage` = today's behavior):
- **Preferred:** `{"input_tokens": int, "output_tokens": int, "model": str}` —
  priced via `cost_from_tokens`, tokens summed.
- **Pre-priced fallback:** `{"tokens": int, "dollars": float}` — used directly
  (for a consumer that already has a cost).

**Debit unconditionally across outcomes, but only after the submission is
validated (findings 1 + 1-followup).** Charging only on the `"ok"` branch would
let repeated `ensure_failed` / `schema_failed` / `guardrail_blocked` retries
(`server.py:480,511`) report usage that's never charged — evading both `usd` and
`max_tokens`, exactly the free-failed-work hole the server-dispatched debit
avoids by living in `finally` (`server.py:262`). But charging *before* the
server proves the submission is for the current executable step would let a
stale / duplicate / wrong-step call consume budget for work the flow never
accepted. So the debit lands **immediately after `process_step_result` returns a
status** (`server.py:~464`, after the `try/except MCPExecutionError`) — past the
gate-step rejection (`server.py:431`) and past `process_step_result`'s own
current-step / flow-terminal validation (`executor.py:~1618`), but **before** the
status-branch returns. A wrong-step/stale call raises in `process_step_result`
and returns an error before reaching the debit (no charge); a gate-step is
rejected earlier (no charge — a consumer never reports usage for a gate step);
`ok` and every retry status all charge (real consumed work):

```python
try:
    status, violations = process_step_result(state, step_id, result)
except MCPExecutionError as exc:
    return {"status": "error", **exception_to_mcp_error(exc)}   # no charge — invalid submission

# STRAT-WORKFLOW-BUDGET-DOLLARS: charge consumer-reported usage for THIS attempt,
# regardless of ensure outcome, then hard-stop if it crossed the cap.
if usage and getattr(state, "budget_state", None):
    has_usd = state.budget_state["caps"].get("usd") is not None
    if usage.get("dollars") is not None or usage.get("tokens") is not None:
        debit_budget(state, tokens=int(usage.get("tokens") or 0),
                     dollars=float(usage.get("dollars") or 0.0))
    else:
        in_tok = int(usage.get("input_tokens") or 0)
        out_tok = int(usage.get("output_tokens") or 0)
        model = usage.get("model") or ""
        _maybe_warn_unpriced(model, has_usd)        # shared helper (see §1)
        debit_budget(state, tokens=in_tok + out_tok,
                     dollars=cost_from_tokens(model, in_tok, out_tok))
    if budget_exhausted(state):
        if _is_flow_step:
            _cleanup_child()        # don't orphan the child flow on a terminal step
        return _flow_budget_hard_stop(state)   # marks terminal, persists, returns payload
```

**Cleanup ordering (round-3 finding).** The hard-stop returns *before* the
per-status branches, which is where `_cleanup_child()` and retry-state clearing
live (`server.py:470,480,511`). To avoid orphaning a child flow on a flow-ref
step, the exhaustion path explicitly calls `_cleanup_child()` first (the same
teardown the branches would). The per-status retry-state clearing
(`iteration_outcome.pop`, attempts persistence) is **moot on a now-terminal
flow** — it only matters for a *subsequent* retry, which a budget-exhausted flow
will never get. So child cleanup is the only branch work that must be preserved.

- **No `dispatches` debit** for a consumer step (dispatches counts
  *server-dispatched* agents; a normal step isn't one — keeps the
  `max_agent_dispatches` axis semantically intact).
- Charged **after** validation but across all outcomes, so a retry/ensure-failed
  attempt is charged for the work it consumed and a budget cross halts
  immediately (no retry loop runs past the cap). On exhaustion the attempt's
  consumption is recorded even though routing is overridden by the terminal
  payload — the flow is terminal anyway. Mirrors the `finally`-block rationale on
  the server-dispatched path: failed/retrying work is not free.
- Reuses the existing `_flow_budget_hard_stop(state)` — no new terminal-state
  sites; the `"ok"`-path hard-stop at `server.py:541` stays as the catch-all for
  server-dispatched debits that crossed the cap during the step.
- **Tool description** updated to document the optional `usage` param.
- Unbudgeted flows / omitted `usage`: zero behavior change (guard on
  `state.budget_state`).

## Acceptance criteria

- [ ] `pricing.py` with `MODEL_PRICING`, `cost_from_tokens(model, in, out)`, base-model normalization (strip `/effort`), unknown-model → `0.0`.
- [ ] `STRATUM_MODEL_PRICING_JSON` env override merges over the built-in table; malformed JSON degrades to built-in (no crash); cached after first parse.
- [ ] Pricing seeded for claude-sonnet-4-6, claude-opus-4-{6,7,8}, claude-haiku-4-5, gpt-5.4, gpt-5.2-codex, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.1-codex-mini.
- [ ] `accumulate_usage` computes dollars from tokens when `cost_usd ≤ 0`; trusts `cost_usd` when `> 0`; prices input/output separately.
- [ ] `budget_exhausted` trips on `usd` when `consumed["dollars"] >= caps["usd"]`; docstring updated.
- [ ] `init_budget_state` yields a ledger for a `usd`-only budget; docstring updated.
- [ ] `stratum_step_done` accepts optional `usage` ({input_tokens,output_tokens,model} or {tokens,dollars}), `usage` after `ctx`; debits **after `process_step_result` validation, across all accepted outcomes, before branch return** (a stale/wrong-step call raises and is not charged; retries are charged); on exhaustion runs `_cleanup_child()` then the hard-stop; no `dispatches` charge; tool description documents it.
- [ ] A retry storm (repeated `ensure_failed`/`schema_failed` reporting `usage`) is charged each attempt and halts on cap — no free-failed-work bypass.
- [ ] A `usd`-only budgeted flow exhausts via server-dispatched agent token cost (end-to-end through `stratum_agent_run`).
- [ ] A `usd`-only budgeted flow exhausts via consumer-reported `usage` on `stratum_step_done`.
- [ ] Unknown / unpriced model under a `usd` cap never exhausts on dollars and never raises; emits a one-time per-model warning when a `usd` cap is set.
- [ ] No behavior change for flows without a `budget:` block, or when `usage` is omitted.
- [ ] Parent design's `usd`-recorded-only wording reconciled (parent doc left as historical; this doc is the authority for enforcement).
- [ ] Full combined suite green; budget suite green.
- [ ] Codex design gate: REVIEW CLEAN.

## Out of scope

- **No litellm dependency** on the MCP path (the whole point of the static table).
- **No real-time price feed** — prices are hand-maintained constants + env override.
- **Judge-internal dispatches** still aren't counted against the run-wide budget
  (no `correlation_id`); unchanged from parent, governed by the judge's own
  `BudgetCaps`.
- **Client-dispatched parallel usage** (`stratum_parallel_done`) — no usage field
  added in v1; client-dispatched parallel work stays outside dollar/token
  enforcement (server-dispatched parallel tasks are covered via §2). Filed as a
  follow-up if it proves load-bearing.
- **IR/schema changes** — `usd` already exists as a budget key.
