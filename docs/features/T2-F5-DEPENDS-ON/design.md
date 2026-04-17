# T2-F5-DEPENDS-ON: Respect task `depends_on` in server-side parallel dispatch

**Status:** DRAFT
**Date:** 2026-04-18
**Scope:** Stratum-side only. Correctness fix in `ParallelExecutor`.

## Related Documents

- T2-F5-ENFORCE (shipped) — `ParallelExecutor`, `asyncio.gather` fan-out
- `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py:146-168` — `run()` entry point
- `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py:264-387` — `_run_one` task lifecycle
- `stratum/stratum-mcp/src/stratum_mcp/executor.py:~1235` — `_no_file_conflicts` (already reads `depends_on` for validation, not scheduling)

## Problem

`ParallelExecutor.run()` fans out all tasks via `asyncio.gather` bounded by `Semaphore(max_concurrent)`. **Task `depends_on` edges are ignored at dispatch time.** A task whose `depends_on` declares `["a"]` starts immediately, in parallel with `a`, even when it depends on `a`'s output.

For v1 server-dispatch this was deliberate (T2-F5-ENFORCE documented it explicitly). But the current behavior means any decompose-emitted task graph with real dependencies runs incorrectly — dependents either fail because an expected file doesn't exist, or succeed with a stale base. Marked as a known deferral on the roadmap.

## Design

### 1. Wait-before-run: `asyncio.Event` per task

In `ParallelExecutor.__init__`, seed a per-task done-event and a terminal-state record:

```python
self._task_done: dict[str, asyncio.Event] = {
    t["id"]: asyncio.Event() for t in self.tasks
}
self._task_terminal_state: dict[str, str] = {}  # tid → 'complete' | 'failed' | 'cancelled'
```

In `_run_one`, the dependency-wait goes **inside the existing main `try` block**, before the semaphore acquire. This ensures early exits route through the existing `finally` → cascade-check path. No branch sets terminal state + persists + returns on its own:

```python
async def _run_one(self, sem: asyncio.Semaphore, task: dict[str, Any]) -> None:
    tid = task["id"]
    ts = self.state.parallel_tasks[tid]
    worktree_path_obj = None
    connector = None

    try:
        # T2-F5-DEPENDS-ON: wait for upstream tasks to reach terminal before starting.
        # Executed OUTSIDE the semaphore — waiting tasks don't consume concurrency.
        # Inside the outer `try` so early returns unwind through `finally`, which
        # handles cascade-cancel / persist / event-set correctly.
        deps = task.get("depends_on") or []
        for dep_id in deps:
            done_evt = self._task_done.get(dep_id)
            if done_evt is None:
                ts.state = "failed"
                ts.error = f"depends_on references unknown task_id '{dep_id}'"
                ts.finished_at = time.time()
                return  # → unwinds through finally; _cancel_siblings() fires as usual
            await done_evt.wait()
            if self._task_terminal_state.get(dep_id) != "complete":
                ts.state = "cancelled"
                ts.error = (
                    f"upstream task '{dep_id}' did not complete "
                    f"(state={self._task_terminal_state.get(dep_id)!r})"
                )
                ts.finished_at = time.time()
                return  # → unwinds through finally; _cancel_siblings() fires as usual

        # ...existing semaphore acquire, worktree setup, connector run, etc...

    except asyncio.CancelledError:
        # ...existing handling...
        raise
    finally:
        # Existing defensive state normalization
        if ts.state in ("pending", "running"):
            ts.state = "failed"
            ts.error = ts.error or "unexpected exit without terminal state"
        if ts.finished_at is None:
            ts.finished_at = time.time()

        # T2-F5-DEPENDS-ON: record terminal state + fire done-event FIRST, before any
        # later cleanup that may raise CancelledError (diff capture via asyncio.to_thread,
        # persist under the per-flow lock). Downstream waiters MUST unblock regardless of
        # how we exit; setting the event here guarantees that even a cancel during
        # cleanup still releases the graph.
        self._task_terminal_state[tid] = ts.state
        self._task_done[tid].set()

        # ...existing finally body (worktree cleanup, diff capture, persist, cascade)...
```

**Key invariants:**
- Every exit path through `_run_one` runs the `finally`, including early-return from dep-check, timeout, exception, and cascade-cancel.
- `_task_done[tid]` is set exactly once, immediately after terminal state is committed to `_task_terminal_state`, before any await that could raise.
- `_require_unsatisfiable()` + `_cancel_siblings()` at the tail of the existing finally correctly fires for dep-check failures too (they're just normal terminal transitions from Python's perspective).

### 2. Cycle detection at start

Before dispatching, validate that the dependency graph has no cycles. A cycle would deadlock the wait-chain indefinitely. Add a DFS-based check in `ParallelExecutor.run()` before `asyncio.gather`. Cycle-exit path does NOT create task handles (there's nothing to cancel — tasks never got created) and directly sets terminal state + fires all done-events:

```python
async def run(self) -> None:
    # T2-F5-DEPENDS-ON: cycle check
    cycle = _detect_dependency_cycle(self.tasks)
    if cycle is not None:
        # Mark all tasks failed with the cycle description. Don't attempt to run.
        msg = f"dependency cycle detected: {' → '.join(cycle)}"
        for t in self.tasks:
            tid = t["id"]
            ts = self.state.parallel_tasks[tid]
            ts.state = "failed"
            ts.error = msg
            ts.finished_at = time.time()
            self._task_terminal_state[tid] = "failed"
            self._task_done[tid].set()
        await self._persist()
        return

    sem = asyncio.Semaphore(self.max_concurrent)
    task_handles = [asyncio.create_task(self._run_one(sem, t)) for t in self.tasks]
    await asyncio.gather(*task_handles, return_exceptions=True)
```

Helper:

```python
def _detect_dependency_cycle(tasks: list[dict[str, Any]]) -> Optional[list[str]]:
    """Return the first cycle found as an ordered list of task_ids, or None.

    Uses DFS with WHITE/GRAY/BLACK coloring. Unknown dep references are ignored
    here (they're caught at wait-time with a clearer per-task error).
    """
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {t["id"]: WHITE for t in tasks}
    edges = {t["id"]: (t.get("depends_on") or []) for t in tasks}

    def dfs(node: str, path: list[str]) -> Optional[list[str]]:
        color[node] = GRAY
        path.append(node)
        for dep in edges.get(node, []):
            if dep not in color:  # unknown — skip, not our job
                continue
            if color[dep] == GRAY:
                # Found a cycle: path from dep's first appearance to current node
                i = path.index(dep)
                return path[i:] + [dep]
            if color[dep] == WHITE:
                cycle = dfs(dep, path)
                if cycle:
                    return cycle
        path.pop()
        color[node] = BLACK
        return None

    for t in tasks:
        if color[t["id"]] == WHITE:
            cycle = dfs(t["id"], [])
            if cycle:
                return cycle
    return None
```

### 3. Interaction with existing behaviors

**Semaphore:** dependency waits happen **outside** the semaphore. A task waiting for an upstream does not hold a concurrency slot. Only when all deps are satisfied does it enter `async with sem` for the actual run. This keeps `max_concurrent` as the concurrency *ceiling for running tasks*, not a bottleneck on the dep graph depth.

**Cascade cancel (`_require_unsatisfiable`):** still fires on terminal state, unchanged. If a task's upstream fails and it cancels itself (§1), that counts toward require-unsatisfied just like any other failure — the existing cascade logic doesn't need modification.

**`isolation` modes:** no change. Each task still runs in its own worktree (when `isolation: worktree`). Dependency ordering is about *when* a task starts, not about propagating state between worktrees. If a downstream task needs the upstream's files, that's covered by T2-F5-DIFF-EXPORT (Stratum captures the diff) + consumer applying it — not this feature's scope.

**`require: any` + upstream failure:** if task B depends on A and A fails, B cancels itself. Under `require: any`, if some *other* independent task C completes, `require_satisfied` is still true. B's self-cancellation is correct regardless.

**Cycle detection false positives:** unknown task IDs in `depends_on` (typos, stale decompose output) are NOT treated as cycles — they're caught at wait-time with a clearer error. Cycles only count among known task IDs.

### 4. Persistence

`ParallelTaskState.state` already serializes `cancelled` as a terminal value (from T2-F5-ENFORCE's cascade-cancel). No schema changes. The new paths set `state = "cancelled"` with a descriptive `ts.error`; poll response surfaces both.

### 5. Testing

**Unit tests** (`tests/test_parallel_exec.py`):

- `test_depends_on_dependent_waits_for_upstream_complete` — A completes first, B depends on A; assert B's `started_at > A.finished_at`
- `test_depends_on_dependent_cancels_on_upstream_failure` — A fails, B depends on A; assert B ends in `state="cancelled"` with `error` mentioning A; `worktree_path is None` and `started_at is None` (task never entered run phase; only the dep-wait + finally ran)
- `test_depends_on_dependent_cancel_triggers_sibling_cascade_when_require_all` — A fails, B depends on A, C is independent and running; under `require:all` assert the cascade-cancel fires on C too (via the finally's `_require_unsatisfiable()` after B's self-cancellation)
- `test_depends_on_event_set_on_cancellation_during_cleanup` — force a `CancelledError` during the persist step of task A; assert A's downstream B still unblocks and runs (verifies event-set happens before persist)
- `test_depends_on_dependent_cancels_on_upstream_cancellation` — A cancelled (say by upstream's upstream fail), B depends on A; same as above
- `test_depends_on_unknown_task_id_fails_task` — B declares `depends_on: ["does-not-exist"]`; B ends in `failed` with `error` mentioning unknown dep
- `test_depends_on_chain` — A → B → C (linear); all complete in order; assert start-time ordering
- `test_depends_on_diamond` — A → {B, C} → D; both B and C must wait for A, D waits for both
- `test_depends_on_independent_tasks_run_concurrently` — regression: tasks with no depends_on still fan out respecting max_concurrent only

**Cycle detection**:
- `test_depends_on_direct_cycle_fails_all_tasks` — A↔B; assert all tasks in the dispatch end `failed` with error message mentioning the cycle
- `test_depends_on_transitive_cycle_fails_all_tasks` — A→B→C→A

**Semaphore + waits**:
- `test_waiting_tasks_do_not_consume_semaphore_slots` — max_concurrent=1, 3 tasks in a linear chain (A→B→C); only one active at a time; no deadlock

All tests use the existing stubbed-connector pattern from `test_parallel_exec.py`.

### 6. Interaction with T2-F5-DEFER-ADVANCE / T2-F5-COMPOSE-MIGRATE-WORKTREE

Neither needs changes. The defer-advance sentinel still fires when all tasks reach terminal — it doesn't care whether that happened sequentially via depends_on or concurrently. The Compose consumer still reads `ts.diff` per task from the poll response and applies them in its existing topological order (based on the same `depends_on`). Compose-side merge ordering was already correct; this fix only addresses dispatch-time correctness on the Stratum side.

## Out of Scope

- **Cross-worktree state propagation.** A task that depends on an upstream's filesystem output still doesn't see it — upstream ran in a separate worktree, cleanup removed that worktree before downstream started, and downstream's worktree was created from HEAD. If tasks truly need upstream's files, the consumer (Compose) must orchestrate via decompose-level artifact passing or merge upstream diffs into the downstream worktree before dispatch. That's a separate larger feature.
- **Soft dependencies / "after" ordering hints.** All declared dependencies are hard: failure cascades down the chain.
- **Partial-success semantics.** If upstream completes with `cert_violations`, downstream still sees it as `complete` (since `state == "complete"`). Cert failures flip `state` to `failed` earlier, so this is a non-issue in practice — flagging for documentation completeness.
- **Per-task retry on dependency failure.** If A fails and B cancels, restarting B would require re-running A first. Out of scope — a consumer that wants retry semantics should use step-level `retries`.
- **Parallelism reporting.** The poll response doesn't distinguish "running vs waiting for upstream." A blocked task shows `state: pending` same as before. Enough for v1; observability is a potential follow-up.
