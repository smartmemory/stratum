# T2-F5-DEFER-ADVANCE: Let consumers report merge status before flow advances

**Status:** DRAFT
**Date:** 2026-04-18
**Scope:** Stratum-side only. First half of the T2-F5-CONSUMER-MERGE-STATUS arc. Unblocks Compose's ability to report client-side merge conflicts back to the flow before auto-advance.

## Related Documents

- T2-F5-ENFORCE — server-side parallel dispatch (shipped)
- T2-F5-DIFF-EXPORT — `capture_diff` + `ts.diff` (shipped)
- T2-F5-COMPOSE-MIGRATE-WORKTREE — Compose client-side merge that currently throws on conflict (shipped)
- `stratum/stratum-mcp/src/stratum_mcp/server.py:931-1046` — `stratum_parallel_poll` auto-advance path
- `stratum/stratum-mcp/src/stratum_mcp/server.py:500-705` — `stratum_parallel_done` (legacy consumer-dispatch; shares `_evaluate_parallel_results`)
- `stratum/stratum-mcp/src/stratum_mcp/server.py:414-490` — `_evaluate_parallel_results` (merge_status controls outcome + can_advance)
- Follow-up: T2-F5-CONSUMER-MERGE-STATUS-COMPOSE (Compose routes through the new path + fixes `buildStatus='failed'` on conflict)

## Problem

When Compose runs a `parallel_dispatch` step via server-side dispatch (`stratum_parallel_start` + `stratum_parallel_poll`) and uses `capture_diff: true` to merge diffs client-side, the flow auto-advances on terminal poll with a hardcoded `merge_status="clean"` in `_evaluate_parallel_results` (server.py:1017). If Compose's client-side `git apply` then conflicts, the flow already thinks it succeeded — there's no back-channel to say "actually, the merge failed; retry / on_fail / halt."

Current Compose workaround: throw from `applyServerDispatchDiffs` to halt the CLI. The flow state stays "advanced" and the user has to manually resume after resolving. This is documented as a known trade-off.

This feature adds the back-channel.

## Design

### 1. New IR field: `defer_advance: bool`

Add to `parallel_dispatch` step schema (v0.3):

```yaml
- id: execute
  type: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  isolation: worktree
  capture_diff: true
  defer_advance: true       # ← new
  max_concurrent: 3
  agent: claude
  intent_template: |
    Implement task {task.id}: {task.description}
```

Semantics:
- Default `false`. Existing specs auto-advance as today.
- When `true`, `stratum_parallel_poll` reaches terminal but does **not** call `_advance_after_parallel`. Instead, poll returns a sentinel outcome envelope that tells the consumer "you hold the advance token — call `stratum_parallel_advance` when you're ready."
- Validator rejects non-bool at parse time (same pattern as `capture_diff`).

### 2. `stratum_parallel_poll` — emit sentinel when `defer_advance` is set

Replace the current all-terminal branch (server.py:989-1028):

```python
if all_terminal:
    task_results = [...]  # unchanged
    can_advance, evaluation = _evaluate_parallel_results(
        state, step, task_results, merge_status="clean",
    )
    require_satisfied = evaluation["require_satisfied"]

    if step_still_pending:
        if step.defer_advance:
            # Consumer takes over the advance. Provide the aggregate but DO NOT
            # call _advance_after_parallel; the flow stays at current_idx until
            # stratum_parallel_advance is called. Leave _RUNNING_EXECUTORS entry
            # in place so double-polling remains idempotent — it's popped on advance.
            outcome = {
                "status": "awaiting_consumer_advance",
                "aggregate": evaluation["aggregate"],
            }
        else:
            advance_result = await _advance_after_parallel(
                state, step_id, evaluation["aggregate"],
            )
            outcome = advance_result
            _RUNNING_EXECUTORS.pop((flow_id, step_id), None)
    else:
        outcome = {
            "status": "already_advanced",
            "aggregate": evaluation["aggregate"],
        }
```

**Key property:** the sentinel `outcome` is non-null, so poll loops breaking on `outcome != null` still terminate correctly. The consumer dispatches on `outcome.status`:
- `"awaiting_consumer_advance"` → consumer does merge, calls advance
- `"already_advanced"` → flow already done, no action
- anything else → the real next-step dispatch (same as before)

**Backward compatibility scope:** the sentinel is **only emitted when the step has `defer_advance: true`**. Existing Compose builds running against specs that don't set this field see no behavioral change — poll auto-advances exactly as today, outcome.status is whatever `_advance_after_parallel` returned. A Compose build that doesn't know about the sentinel will crash if it hits a spec with `defer_advance: true` (it'll try to treat `awaiting_consumer_advance` as a next-step dispatch and hit missing required fields). That's intentional: the spec opt-in is the coupling mechanism. T2-F5-CONSUMER-MERGE-STATUS-COMPOSE ships the consumer support before any production spec sets the flag.

### 3. New MCP tool: `stratum_parallel_advance`

```python
@mcp.tool(description=(
    "Advance a parallel_dispatch step whose spec declared defer_advance: true. "
    "Inputs: flow_id (str), step_id (str), merge_status ('clean' | 'conflict'). "
    "Call after observing 'awaiting_consumer_advance' in a parallel_poll response. "
    "Feeds merge_status into _evaluate_parallel_results and advances the flow. "
    "Idempotent: returns 'already_advanced' if the flow has moved past step_id."
))
async def stratum_parallel_advance(
    flow_id: str,
    step_id: str,
    merge_status: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {"error": "flow_not_found", "message": f"No active flow with id '{flow_id}'"}
        _flows[flow_id] = state

    # STRAT-IMMUTABLE: verify spec integrity before feeding consumer input into
    # _evaluate_parallel_results (which flows into process_step_result + advance).
    # Matches stratum_parallel_done (server.py:519-523) and stratum_step_done.
    flow_def = state.flow_def
    try:
        verify_spec_integrity(flow_def, state)
    except SpecIntegrityError as exc:
        return {"error": "spec_integrity_violation", "message": str(exc)}

    # Locate the step
    step = next((s for s in state.ordered_steps if s.id == step_id), None)
    if step is None:
        return {"error": "unknown_step", "message": f"Step '{step_id}' not found in flow"}
    if getattr(step, "step_type", None) != "parallel_dispatch":
        return {"error": "wrong_step_type", "message": f"Step '{step_id}' is not a parallel_dispatch step"}
    if not getattr(step, "defer_advance", False):
        return {
            "error": "advance_not_deferred",
            "message": (
                f"Step '{step_id}' does not have defer_advance: true. "
                f"Auto-advance fires from stratum_parallel_poll; this tool is a no-op."
            ),
        }
    if merge_status not in ("clean", "conflict"):
        return {
            "error": "invalid_merge_status",
            "message": f"merge_status must be 'clean' or 'conflict', got {merge_status!r}",
        }

    # Idempotency: already advanced?
    cur_step = None
    if state.current_idx < len(state.ordered_steps):
        cur_step = state.ordered_steps[state.current_idx]
    if cur_step is None or cur_step.id != step_id:
        # Flow has already moved past this step. Don't re-evaluate with the
        # current call's merge_status — whatever advanced the flow used some
        # other value, and re-running `_evaluate_parallel_results` would return
        # a misleading aggregate for a second call whose merge_status disagrees
        # with the first. Return a minimal envelope instead.
        return {"status": "already_advanced", "step_id": step_id}

    # Verify step actually reached terminal (all tasks terminal)
    try:
        expected_task_ids = {t["id"] for t in _resolve_dispatch_tasks(state, step)}
    except Exception:
        expected_task_ids = set()
    ts_map = {
        tid: ts for tid, ts in state.parallel_tasks.items()
        if tid in expected_task_ids
    }
    if not ts_map:
        return {"error": "step_not_dispatched", "message": f"Step '{step_id}' not dispatched yet; call stratum_parallel_start first"}
    if not all(ts.state in ("complete", "failed", "cancelled") for ts in ts_map.values()):
        return {
            "error": "tasks_not_terminal",
            "message": (
                f"Step '{step_id}' still has running tasks. "
                f"Poll until outcome.status == 'awaiting_consumer_advance' before calling advance."
            ),
        }

    # Do the advance with consumer-provided merge_status
    task_results = [
        {"task_id": tid, "result": ts.result, "status": "complete" if ts.state == "complete" else "failed"}
        for tid, ts in ts_map.items()
    ]
    _, evaluation = _evaluate_parallel_results(
        state, step, task_results, merge_status=merge_status,
    )
    advance_result = await _advance_after_parallel(
        state, step_id, evaluation["aggregate"],
    )
    _RUNNING_EXECUTORS.pop((flow_id, step_id), None)
    return advance_result
```

### 4. Error envelopes

New error keys this tool can return (in addition to the envelope shapes `_advance_after_parallel` already returns):

| Error key | Meaning |
|-----------|---------|
| `flow_not_found` | Unknown `flow_id` |
| `unknown_step` | `step_id` not in the flow |
| `wrong_step_type` | Step exists but isn't `parallel_dispatch` |
| `advance_not_deferred` | Step has `defer_advance: false` (or absent) — this tool is the wrong entry point |
| `invalid_merge_status` | `merge_status` not in `("clean", "conflict")` |
| `step_not_dispatched` | `stratum_parallel_start` never ran |
| `tasks_not_terminal` | Called too early; poll first |

All errors are `{error, message}` envelope shape, matching the pattern used by `stratum_parallel_start` / `stratum_parallel_poll`.

### 5. IR schema + `_build_step`

`spec.py` changes:
- Add `defer_advance: bool = False` to `IRStepDef` dataclass (after `capture_diff`).
- Add `"defer_advance": {"type": "boolean"}` to `_IR_SCHEMA_V03` next to `capture_diff`.
- In `_build_step`, add the same strict-bool validation pattern used for `capture_diff`:
  ```python
  if "defer_advance" in s and not isinstance(s["defer_advance"], bool):
      raise SpecError(f"step '{s['id']}': defer_advance must be a boolean, got {type(s['defer_advance']).__name__}")
  ```
  And pass `defer_advance=s.get("defer_advance", False)` into the `IRStepDef(...)` return.

**`_step_fingerprint` must include `defer_advance` AND `capture_diff`.** `executor.py:770-792` currently omits both; that's a pre-existing gap for `capture_diff`, but `defer_advance` is a gate-switching field (flipping it post-plan changes whether consumer merge_status is honored), so integrity-protecting it is load-bearing. Add both fields to the fingerprint tuple in the same change. This is a one-line addition plus a test that fingerprints differ when either flag differs.

### 6. Interaction with existing behaviors

- **`defer_advance: false` (default, existing specs):** zero change. Poll auto-advances exactly as today.
- **Concurrent pollers:** poll is read-only when `defer_advance: true` — no state mutation until advance. Safe to call from multiple places (e.g., UI watch + CLI driver) without races.
- **Server restart during defer state:** the task states are already persisted (from T2-F5-ENFORCE). On restart, `resume_interrupted_parallel_tasks` flips `running` tasks to `failed` — same as today. A Compose consumer that restarts mid-step polls and sees `awaiting_consumer_advance`. It can still call advance, but note that when resume flips tasks to `failed`, `require` will likely be unsatisfied and `_evaluate_parallel_results` will produce `can_advance=False` regardless of the consumer-supplied `merge_status`. In that case `_advance_after_parallel` routes through retry / on_fail / ensure_failed paths — merge_status is only consulted when require is satisfied. Consumers should still report accurate merge_status, but shouldn't expect it to override require-failure.

  **Consumer guidance:** the sentinel envelope alone doesn't distinguish "tasks succeeded, you merge now" from "tasks were resume-flipped to failed." The sentinel includes the full `aggregate` field (with per-task `status` and counts) so the consumer can inspect before deciding: if any tasks are `failed` with a synthetic `resume_interrupted` error, the consumer should skip its client-side merge (there's nothing to merge) and call advance with whatever `merge_status` is accurate for the empty-merge case (`"clean"` is correct — no merge was attempted).
- **`_RUNNING_EXECUTORS` cleanup:** the entry persists until advance runs successfully, rather than being cleaned up on terminal poll. `stratum_parallel_advance` pops the entry **only on the success path** — early error returns (`invalid_merge_status`, `tasks_not_terminal`, etc.) leave the registry entry in place so consumers can fix their input and retry. For fatal errors (`spec_integrity_violation`, `wrong_step_type`), the entry leaks until shutdown; acceptable since these are flow-fatal conditions.
  Shutdown cleanup (`shutdown_all`) still cancels any still-running handles; by the time all tasks are terminal the executor task has finished its `gather`, so the handle is done-but-uncollected. Benign.
- **Legacy `stratum_parallel_done`:** unchanged. Still the entry for pure consumer-dispatch (where Stratum doesn't run the agents).

### 7. Testing

**Schema tests** (`tests/integration/test_parallel_schema.py`):
- `test_parallel_dispatch_defer_advance_accepts_bool` — `defer_advance: true` and `false` both parse
- `test_parallel_dispatch_defer_advance_omitted_defaults_to_false`
- `test_parallel_dispatch_defer_advance_rejects_non_bool` — string `"true"` raises

**Behavior tests** (`tests/test_parallel_server_dispatch.py`):
- `test_poll_with_defer_advance_returns_awaiting_consumer_advance` — spec has `defer_advance: true`; poll to terminal; assert `outcome.status == "awaiting_consumer_advance"`, current_idx still at this step
- `test_poll_without_defer_advance_auto_advances_as_before` — regression test for default behavior
- `test_advance_with_clean_merge_status_advances_flow` — call advance after poll, assert flow moves to next step
- `test_advance_with_conflict_merge_status_blocks_advance` — call advance with `"conflict"`; assert flow outcome is `ensure_failed` or equivalent (driven by `_evaluate_parallel_results`'s `can_advance=False` when `merge_ok=False`)
- `test_advance_before_poll_terminal_returns_error` — call advance while tasks still running → `tasks_not_terminal`
- `test_advance_on_non_deferred_step_returns_error` — step without `defer_advance` → `advance_not_deferred`
- `test_advance_invalid_merge_status_returns_error`
- `test_advance_idempotent_after_first_call` — call advance twice; second returns `{status: "already_advanced", step_id}` with no `aggregate` key; verify that a second call with a *different* `merge_status` returns the same minimal envelope (does NOT re-run `_evaluate_parallel_results`)
- `test_advance_on_unknown_flow_step_returns_error`
- `test_poll_after_advance_returns_already_advanced` — consumer's existing already_advanced detection still works
- `test_advance_fails_on_tampered_spec` — modify a persisted flow's `step_fingerprint` (or flip `defer_advance` in the in-memory spec dict); assert `stratum_parallel_advance` returns `spec_integrity_violation`
- `test_step_fingerprint_includes_defer_advance_and_capture_diff` — two specs identical except for these fields produce different fingerprints
- `test_awaiting_consumer_advance_status_is_unique_to_defer_path` — no other outcome envelope produces `status == "awaiting_consumer_advance"` (guards against future collisions)

## Out of Scope

- Compose-side consumer of this new path. Separate feature: **T2-F5-CONSUMER-MERGE-STATUS-COMPOSE** will update `executeParallelDispatchServer` to route worktree+capture_diff through defer-advance, replace the throw-on-conflict with a proper `merge_status: "conflict"` advance call, and fix Compose's `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE's W1.
- **IR version bump.** `defer_advance` is an additive optional field on `parallel_dispatch`; no v0.3→v0.4 jump. Matches the pattern used for `capture_diff` and `task_timeout`.
- **Timeout on defer state.** If a consumer calls `_start` but never calls `_advance`, the flow hangs in defer state. Add a timeout in a future feature if needed; not worth the complexity for v1.
