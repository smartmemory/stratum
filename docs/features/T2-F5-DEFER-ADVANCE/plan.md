# T2-F5-DEFER-ADVANCE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in deferred-advance semantics to Stratum's server-side parallel dispatch: when a `parallel_dispatch` step declares `defer_advance: true`, `stratum_parallel_poll` stops short of auto-advancing and returns a sentinel outcome. Consumers complete their client-side merge and call a new `stratum_parallel_advance(flow_id, step_id, merge_status)` tool to finalize.

**Architecture:** One new IR field (`defer_advance`), one new MCP tool (`stratum_parallel_advance`), one conditional branch in `stratum_parallel_poll`, and a fingerprint fix that covers both `defer_advance` and the previously-uncovered `capture_diff`. STRAT-IMMUTABLE verification wired into the new tool mirroring `stratum_parallel_done` / `stratum_step_done`.

**Tech Stack:** Python 3.11+, pytest (`asyncio_mode = "auto"`), FastMCP.

**Design doc:** `stratum/docs/features/T2-F5-DEFER-ADVANCE/design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `stratum-mcp/src/stratum_mcp/spec.py` | Modify | Add `defer_advance: bool = False` to `IRStepDef` + schema + `_build_step` validation |
| `stratum-mcp/src/stratum_mcp/executor.py` | Modify | Extend `_step_fingerprint` to cover `defer_advance` + `capture_diff` |
| `stratum-mcp/src/stratum_mcp/server.py` | Modify | Branch in `stratum_parallel_poll` for deferred steps; add new `stratum_parallel_advance` tool |
| `stratum-mcp/tests/integration/test_parallel_schema.py` | Modify | Schema accept/default/reject tests for `defer_advance` |
| `stratum-mcp/tests/integration/test_parallel_server_dispatch.py` | Modify | Behavior tests for defer-path + advance tool + fingerprint + sentinel uniqueness |
| `stratum-mcp/tests/test_executor.py` (or wherever `_step_fingerprint` lives) | Modify | Fingerprint coverage tests |

**Test runner:** `cd stratum/stratum-mcp && pytest`.
Single file: `pytest tests/integration/test_parallel_server_dispatch.py -v`.

---

## Task 1: Schema — `defer_advance` field + validation

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/spec.py`
- Modify: `stratum/stratum-mcp/tests/integration/test_parallel_schema.py`

- [ ] **Step 1: Write failing schema tests**

Append to `tests/integration/test_parallel_schema.py`:

```python
def test_parallel_dispatch_defer_advance_accepts_bool():
    from stratum_mcp.spec import parse_and_validate
    spec_true = """
version: "0.3"
contracts:
  T: {type: object}
functions:
  dummy: {intent: "x", input: {}, output: T}
flows:
  main:
    input: {}
    output: T
    steps:
      - id: decompose
        type: decompose
        source: "$.input"
      - id: execute
        type: parallel_dispatch
        source: "$.steps.decompose.output.tasks"
        isolation: worktree
        defer_advance: true
        agent: claude
        intent_template: "do x"
"""
    ir = parse_and_validate(spec_true)
    steps = {s.id: s for s in ir.flows["main"].steps}
    assert steps["execute"].defer_advance is True

    ir2 = parse_and_validate(spec_true.replace("defer_advance: true", "defer_advance: false"))
    steps2 = {s.id: s for s in ir2.flows["main"].steps}
    assert steps2["execute"].defer_advance is False


def test_parallel_dispatch_defer_advance_omitted_defaults_to_false():
    from stratum_mcp.spec import parse_and_validate
    spec = """
version: "0.3"
contracts:
  T: {type: object}
functions:
  dummy: {intent: "x", input: {}, output: T}
flows:
  main:
    input: {}
    output: T
    steps:
      - id: decompose
        type: decompose
        source: "$.input"
      - id: execute
        type: parallel_dispatch
        source: "$.steps.decompose.output.tasks"
        isolation: worktree
        agent: claude
        intent_template: "do x"
"""
    ir = parse_and_validate(spec)
    steps = {s.id: s for s in ir.flows["main"].steps}
    assert steps["execute"].defer_advance is False


def test_parallel_dispatch_defer_advance_rejects_non_bool():
    import pytest
    from stratum_mcp.spec import parse_and_validate
    from stratum_mcp.errors import IRValidationError
    spec = """
version: "0.3"
contracts:
  T: {type: object}
functions:
  dummy: {intent: "x", input: {}, output: T}
flows:
  main:
    input: {}
    output: T
    steps:
      - id: decompose
        type: decompose
        source: "$.input"
      - id: execute
        type: parallel_dispatch
        source: "$.steps.decompose.output.tasks"
        isolation: worktree
        defer_advance: "true"
        agent: claude
        intent_template: "do x"
"""
    with pytest.raises(IRValidationError, match="boolean"):
        parse_and_validate(spec)
```

(If `parse_and_validate` or `IRValidationError` import paths differ in your local code — match the convention used by the existing `capture_diff` tests in the same file.)

Run: `cd /Users/ruze/reg/my/forge/stratum/stratum-mcp && pytest tests/integration/test_parallel_schema.py -v -k defer_advance 2>&1 | tail -10`
Expected: 3 failures (`defer_advance` attribute doesn't exist yet).

- [ ] **Step 2: Add to `IRStepDef`**

In `src/stratum_mcp/spec.py`, find `class IRStepDef` (line ~58). After the `capture_diff: bool = False` line, add:

```python
    # T2-F5-DEFER-ADVANCE: opt-in deferred flow advance for parallel_dispatch.
    # When true, stratum_parallel_poll returns a sentinel outcome on terminal
    # ({status: "awaiting_consumer_advance"}) instead of auto-advancing;
    # consumer must call stratum_parallel_advance(flow_id, step_id, merge_status).
    defer_advance: bool = False
```

- [ ] **Step 3: Add to JSON schema**

Find `_IR_SCHEMA_V03` (around line 504). Add next to `capture_diff`:

```python
        "capture_diff": {"type": "boolean"},
        "defer_advance": {"type": "boolean"},
```

- [ ] **Step 4: Parse + validate in `_build_step`**

Find `_build_step` (line ~1066). Near where `capture_diff` is validated, add matching logic:

```python
    if "defer_advance" in s and not isinstance(s["defer_advance"], bool):
        raise SpecError(
            f"step '{s['id']}': defer_advance must be a boolean, got "
            f"{type(s['defer_advance']).__name__} ({s['defer_advance']!r})"
        )
```

In the `IRStepDef(...)` return, add (next to `capture_diff=...`):

```python
        defer_advance=s.get("defer_advance", False),
```

- [ ] **Step 5: Run schema tests + full suite**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/integration/test_parallel_schema.py -v -k defer_advance 2>&1 | tail -10
pytest tests/ 2>&1 | tail -3
```

Expected: 3 defer_advance tests pass; full suite +3, no regressions.

- [ ] **Step 6: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/spec.py stratum-mcp/tests/integration/test_parallel_schema.py
git commit -m "feat(t2-f5-defer-advance): add defer_advance IR field with strict bool validation"
```

---

## Task 2: Extend `_step_fingerprint` to cover defer_advance + capture_diff

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/executor.py`
- Modify: the fingerprint test file (likely `tests/test_executor.py` or similar)

- [ ] **Step 1: Locate `_step_fingerprint`**

```bash
grep -n "_step_fingerprint\|def.*fingerprint" /Users/ruze/reg/my/forge/stratum/stratum-mcp/src/stratum_mcp/executor.py | head -5
```

Around line 770-792. Read it to see which fields are currently hashed.

- [ ] **Step 2: Find fingerprint tests**

```bash
grep -rn "_step_fingerprint\|fingerprint" /Users/ruze/reg/my/forge/stratum/stratum-mcp/tests/ | head -10
```

Identify where fingerprint coverage is tested. Usually in `test_executor.py` or a dedicated `test_immutable.py` / `test_fingerprint.py`.

- [ ] **Step 3: Write failing tests**

Append (matching the file's existing style):

```python
def test_step_fingerprint_includes_capture_diff():
    """Fingerprint must differ when capture_diff flag differs — covers a pre-existing gap."""
    from stratum_mcp.executor import _step_fingerprint
    step_a = _mk_parallel_step(capture_diff=False)  # helper — adapt to whatever constructor exists
    step_b = _mk_parallel_step(capture_diff=True)
    assert _step_fingerprint(step_a) != _step_fingerprint(step_b)


def test_step_fingerprint_includes_defer_advance():
    """Fingerprint must differ when defer_advance flag differs."""
    from stratum_mcp.executor import _step_fingerprint
    step_a = _mk_parallel_step(defer_advance=False)
    step_b = _mk_parallel_step(defer_advance=True)
    assert _step_fingerprint(step_a) != _step_fingerprint(step_b)
```

If `_mk_parallel_step` doesn't exist, inline a minimal `IRStepDef(...)` construction for each test. Match the fixture pattern used by existing fingerprint tests.

Run: expect failures.

- [ ] **Step 4: Add fields to `_step_fingerprint`**

Edit `src/stratum_mcp/executor.py`. In `_step_fingerprint`, add the two fields to whatever tuple / dict it hashes:

```python
def _step_fingerprint(step):
    # ... existing fields ...
    return hashlib.sha256(json.dumps({
        # existing entries...
        "capture_diff": getattr(step, "capture_diff", False),
        "defer_advance": getattr(step, "defer_advance", False),
    }, sort_keys=True).encode()).hexdigest()
```

Adjust to match the actual function's shape. Use `getattr` with a default in case legacy callers pass simpler objects.

- [ ] **Step 5: Verify — tests pass, full suite clean**

```bash
pytest tests/ -v -k fingerprint 2>&1 | tail -10
pytest tests/ 2>&1 | tail -3
```

If any existing integrity tests fail because their baseline fingerprint changed, those tests need their expected fingerprints regenerated. Note in the commit that this is an accepted break because the fix is security-relevant and no persisted production flows rely on the previous fingerprint value.

- [ ] **Step 6: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/executor.py <path-to-fingerprint-tests>
git commit -m "fix(immutable): cover capture_diff + defer_advance in _step_fingerprint

Security-relevant: both fields gate consumer input into process_step_result
(capture_diff exposes diff contents; defer_advance flips whether consumer
merge_status is honored). A spec tamper flipping either between plan and
advance must invalidate the integrity check."
```

---

## Task 3: `stratum_parallel_poll` — emit sentinel when `defer_advance: true`

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/server.py`
- Modify: `stratum/stratum-mcp/tests/integration/test_parallel_server_dispatch.py`

- [ ] **Step 1: Write failing test**

Append to `tests/integration/test_parallel_server_dispatch.py`:

```python
async def test_poll_with_defer_advance_returns_awaiting_consumer_advance(tmp_path, monkeypatch):
    """Step with defer_advance: true — poll on terminal returns sentinel, no auto-advance."""
    # Adapt to whatever fixture pattern existing tests use — e.g. a helper that
    # sets up a flow, dispatches tasks, drives them to complete via stubbed
    # connectors, then polls.
    # Key assertions:
    #   - outcome is not None
    #   - outcome['status'] == 'awaiting_consumer_advance'
    #   - outcome['aggregate'] contains the task-evaluation aggregate
    #   - state.current_idx still points at this step (flow did NOT advance)
    #   - (flow_id, step_id) is still in _RUNNING_EXECUTORS
    ...


async def test_poll_without_defer_advance_auto_advances_as_before(tmp_path, monkeypatch):
    """Regression: steps without defer_advance auto-advance as today."""
    # Same fixture pattern but spec omits defer_advance.
    # Assert outcome['status'] is the next-step dispatch (not 'awaiting_consumer_advance')
    # and state.current_idx has moved forward.
    ...


async def test_awaiting_consumer_advance_status_is_unique_to_defer_path(tmp_path, monkeypatch):
    """Sentinel status must not be emitted by any other outcome path."""
    # Run multiple poll scenarios without defer_advance (happy path, failure path,
    # ensure-failed path, etc.) and assert none emit status == 'awaiting_consumer_advance'.
    ...
```

Fill in the fixture bodies using patterns already in the file. Run: expect failures.

- [ ] **Step 2: Update `stratum_parallel_poll`**

Edit `src/stratum_mcp/server.py`. In `stratum_parallel_poll` (around line 1003), replace the terminal-branch block:

```python
if all_terminal:
    task_results = [
        {
            "task_id": tid,
            "result": ts.result,
            "status": "complete" if ts.state == "complete" else "failed",
        }
        for tid, ts in ts_map.items()
    ]
    can_advance, evaluation = _evaluate_parallel_results(
        state, step, task_results, merge_status="clean",
    )
    require_satisfied = evaluation["require_satisfied"]

    if step_still_pending:
        if getattr(step, "defer_advance", False):
            # T2-F5-DEFER-ADVANCE: hold advance; consumer calls stratum_parallel_advance
            # with its own merge_status. Leave _RUNNING_EXECUTORS in place;
            # stratum_parallel_advance pops it on successful advance.
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

Preserve the rest of the poll handler unchanged.

- [ ] **Step 3: Verify tests**

```bash
pytest tests/integration/test_parallel_server_dispatch.py -v 2>&1 | tail -15
```

Expected: 3 new tests pass. Full suite:

```bash
pytest tests/ 2>&1 | tail -3
```

Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/server.py stratum-mcp/tests/integration/test_parallel_server_dispatch.py
git commit -m "feat(t2-f5-defer-advance): emit sentinel outcome when defer_advance set"
```

---

## Task 4: New MCP tool `stratum_parallel_advance`

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/server.py`
- Modify: `stratum/stratum-mcp/tests/integration/test_parallel_server_dispatch.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/integration/test_parallel_server_dispatch.py`:

```python
async def test_advance_with_clean_merge_status_advances_flow(tmp_path, monkeypatch):
    """Happy path — defer + poll sentinel → advance with 'clean' → flow moves to next step."""
    # Setup: flow with defer_advance:true, drive tasks to complete, poll to sentinel.
    # Call stratum_parallel_advance(flow_id, step_id, 'clean').
    # Assert: response is next-step dispatch (not awaiting_consumer_advance),
    # state.current_idx has moved, (flow_id, step_id) NOT in _RUNNING_EXECUTORS.
    ...


async def test_advance_with_conflict_blocks_advance(tmp_path, monkeypatch):
    """merge_status='conflict' feeds into _evaluate_parallel_results → can_advance=False."""
    # Setup same as above. Call advance with 'conflict'.
    # Assert: _advance_after_parallel routes via ensure_failed / retry path,
    # NOT a clean next-step dispatch.
    ...


async def test_advance_before_poll_terminal_returns_tasks_not_terminal():
    """Calling advance while tasks still running → error envelope."""
    # Setup: flow with defer_advance:true, tasks still pending/running.
    # Call advance without waiting.
    # Assert response['error'] == 'tasks_not_terminal'.
    ...


async def test_advance_on_non_deferred_step_returns_advance_not_deferred():
    # Spec WITHOUT defer_advance. Dispatch, poll to terminal (which auto-advances).
    # Then call advance — should return {'error': 'advance_not_deferred', ...}
    ...


async def test_advance_invalid_merge_status_returns_error():
    # Call advance with merge_status='broken'. Expect invalid_merge_status.
    ...


async def test_advance_idempotent_after_first_call():
    """Second call returns minimal already_advanced envelope; does NOT re-evaluate."""
    # Call advance twice, second with a DIFFERENT merge_status.
    # Assert response == {'status': 'already_advanced', 'step_id': step_id}
    # (no 'aggregate' key — proves we didn't re-run _evaluate_parallel_results).
    ...


async def test_advance_on_unknown_flow_returns_flow_not_found():
    ...


async def test_advance_on_unknown_step_returns_unknown_step():
    ...


async def test_advance_fails_on_tampered_spec(tmp_path, monkeypatch):
    """STRAT-IMMUTABLE: if the persisted spec fingerprint mismatches, advance rejects."""
    # After dispatching but before advance, tamper the in-memory spec (e.g., flip
    # defer_advance from True to False in state.flow_def).
    # Call advance. Expect {'error': 'spec_integrity_violation', ...}.
    ...
```

Fill in fixtures based on existing patterns. Run: expect failures.

- [ ] **Step 2: Implement the tool**

In `src/stratum_mcp/server.py`, after the `stratum_parallel_poll` definition, add:

```python
@mcp.tool(description=(
    "Advance a parallel_dispatch step whose spec declared defer_advance: true. "
    "Inputs: flow_id (str), step_id (str), merge_status ('clean' | 'conflict'). "
    "Call after observing 'awaiting_consumer_advance' from stratum_parallel_poll. "
    "Feeds merge_status into _evaluate_parallel_results and advances the flow. "
    "Idempotent: returns {status: 'already_advanced', step_id} if the flow has "
    "already moved past step_id."
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

    # STRAT-IMMUTABLE gate — mirrors stratum_parallel_done / stratum_step_done
    try:
        verify_spec_integrity(state.flow_def, state)
    except SpecIntegrityError as exc:
        return {"error": "spec_integrity_violation", "message": str(exc)}

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

    # Idempotency check — if the flow has moved past this step, return minimal envelope
    cur_step = None
    if state.current_idx < len(state.ordered_steps):
        cur_step = state.ordered_steps[state.current_idx]
    if cur_step is None or cur_step.id != step_id:
        return {"status": "already_advanced", "step_id": step_id}

    # Verify all tasks are terminal
    try:
        expected_task_ids = {t["id"] for t in _resolve_dispatch_tasks(state, step)}
    except Exception:
        expected_task_ids = set()
    ts_map = {
        tid: ts for tid, ts in state.parallel_tasks.items()
        if tid in expected_task_ids
    }
    if not ts_map:
        return {
            "error": "step_not_dispatched",
            "message": f"Step '{step_id}' not dispatched yet; call stratum_parallel_start first",
        }
    if not all(ts.state in ("complete", "failed", "cancelled") for ts in ts_map.values()):
        return {
            "error": "tasks_not_terminal",
            "message": (
                f"Step '{step_id}' still has running tasks. "
                f"Poll until outcome.status == 'awaiting_consumer_advance' before calling advance."
            ),
        }

    # Advance
    task_results = [
        {
            "task_id": tid,
            "result": ts.result,
            "status": "complete" if ts.state == "complete" else "failed",
        }
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

Match the file's import order and formatting. Confirm `verify_spec_integrity` and `SpecIntegrityError` are already imported (they should be — used by `stratum_parallel_done` / `stratum_step_done`).

- [ ] **Step 3: Run tests**

```bash
pytest tests/integration/test_parallel_server_dispatch.py -v -k advance 2>&1 | tail -20
```

Expected: all 9 tests pass.

Full suite:

```bash
pytest tests/ 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/server.py stratum-mcp/tests/integration/test_parallel_server_dispatch.py
git commit -m "feat(t2-f5-defer-advance): stratum_parallel_advance tool for consumer-driven advance"
```

---

## Task 5: Docs + integration review

**Files:**
- Modify: `stratum/CHANGELOG.md`
- Modify: outer Forge `/Users/ruze/reg/my/forge/ROADMAP.md`

- [ ] **Step 1: Changelog entry**

Under `## [Unreleased]` in `stratum/CHANGELOG.md`, prepend (matching existing entry style):

```
### stratum-mcp — T2-F5-DEFER-ADVANCE

- **`defer_advance: bool` IR field on `parallel_dispatch` steps** — opt-in, default false. When true, `stratum_parallel_poll` returns a sentinel `{status: "awaiting_consumer_advance", aggregate: {...}}` on terminal instead of auto-advancing. Validator rejects non-bool at parse time.
- **`stratum_parallel_advance(flow_id, step_id, merge_status)` MCP tool** — consumer-driven advance that feeds `merge_status` ('clean' | 'conflict') into `_evaluate_parallel_results` before calling `_advance_after_parallel`. STRAT-IMMUTABLE verified. Idempotent — returns `{status: "already_advanced", step_id}` if the flow moved past. Enumerated errors: `flow_not_found`, `unknown_step`, `wrong_step_type`, `advance_not_deferred`, `invalid_merge_status`, `step_not_dispatched`, `tasks_not_terminal`, `spec_integrity_violation`.
- **`_step_fingerprint` fixed** — now covers `capture_diff` (pre-existing gap) and `defer_advance`. Both are security-relevant (gate consumer input into `process_step_result`), so the fingerprint must invalidate on tamper. Accepted break: specs that were using `capture_diff` will have a different fingerprint; regenerate persisted state if needed.
- **Unblocks T2-F5-CONSUMER-MERGE-STATUS-COMPOSE** — Compose consumer extension to route `isolation: "worktree"` + `capture_diff: true` through defer-advance, reporting merge_status back properly and fixing the `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1.
- N new tests (3 schema + N behavior + 2 fingerprint), M total passing.
```

(Fill in N/M from the test-counter output.)

- [ ] **Step 2: Outer Forge ROADMAP**

Edit `/Users/ruze/reg/my/forge/ROADMAP.md`. Above the existing `T2-F5-CONSUMER-MERGE-STATUS` planned entry, insert a new completed row:

```
| ~~T2-F5-DEFER-ADVANCE~~ | **COMPLETE** — Stratum-side opt-in deferred flow advance. New `defer_advance: bool` IR field + `stratum_parallel_advance(flow_id, step_id, merge_status)` MCP tool. Poll emits `{status: "awaiting_consumer_advance"}` sentinel on terminal; consumer finishes its client-side merge and calls advance with its real merge_status, feeding it into `_evaluate_parallel_results` → `_advance_after_parallel`. STRAT-IMMUTABLE gate wired in; `_step_fingerprint` extended to cover `capture_diff` + `defer_advance`. Unblocks the Compose consumer extension (T2-F5-CONSUMER-MERGE-STATUS-COMPOSE). | M | COMPLETE |
| T2-F5-CONSUMER-MERGE-STATUS-COMPOSE | **Compose consumer for defer-advance.** Route `isolation: "worktree"` + `capture_diff: true` through the new Stratum defer path. Replace throw-on-conflict with `stratum_parallel_advance(..., merge_status: "conflict")`. Fix `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1 — set `buildStatus='failed'` on client-side conflict before the stream-writer closes. | M | PLANNED |
```

(And mark the existing `T2-F5-CONSUMER-MERGE-STATUS` line as superseded, or delete/rename it to match.)

- [ ] **Step 3: Commit changelog**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add CHANGELOG.md
git commit -m "docs(t2-f5-defer-advance): changelog entry"
```

Outer Forge ROADMAP is not in any git repo — no commit.

- [ ] **Step 4: Final Claude-based integration review**

Dispatch `superpowers:code-reviewer` with the cumulative diff from the first feature commit. Focus prompts on:
- Does the new tool cleanly preserve STRAT-IMMUTABLE semantics? (B1 from round 1.)
- Does the fingerprint extension correctly propagate through existing flows without breaking legacy restore paths?
- Does the sentinel outcome interact cleanly with the existing `already_advanced` idempotency — any double-pop of `_RUNNING_EXECUTORS`?
- Any race between `stratum_parallel_poll` returning the sentinel and a concurrent `stratum_parallel_advance` call?

Address any blockers; ship WARNs as follow-ups.

---

## Self-Review Checklist

- [x] Design §1 `defer_advance` IR field → Task 1
- [x] Design §2 poll sentinel branch → Task 3
- [x] Design §3 new `stratum_parallel_advance` tool → Task 4
- [x] Design §4 error envelopes enumerated → Task 4 test matrix
- [x] Design §5 schema + `_build_step` → Task 1
- [x] Design §5 `_step_fingerprint` covers both flags → Task 2
- [x] Design §6 `_RUNNING_EXECUTORS` cleanup policy → Task 4 implementation (pop only on success)
- [x] Design §6 restart + defer interaction → documented, test coverage via existing resume tests
- [x] Design §7 all test scenarios → Tasks 1, 3, 4
