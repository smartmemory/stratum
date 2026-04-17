# T2-F5-DIFF-EXPORT: Capture per-task diffs before worktree cleanup

**Status:** APPROVED
**Date:** 2026-04-17
**Scope:** Stratum-side only. Unblocks T2-F5-COMPOSE-MIGRATE for `isolation: "worktree"` paths.

## Related Documents

- Predecessor: T2-F5-ENFORCE (shipped server-side parallel dispatch)
- Consumer: T2-F5-COMPOSE-MIGRATE (v1 covers `isolation: "none"`; `isolation: "worktree"` blocked on this feature)
- `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py:264-387` — `_run_one` task lifecycle
- `stratum/stratum-mcp/src/stratum_mcp/executor.py:687-702` — `ParallelTaskState` dataclass
- `stratum/stratum-mcp/src/stratum_mcp/worktree.py:27-50` — existing `create_worktree` / `remove_worktree`
- Spec validator: `stratum/stratum-mcp/src/stratum_mcp/spec.py` (extend `parallel_dispatch` schema)

## Problem

Stratum v1 server-dispatch creates a git worktree per task under `~/.stratum/worktrees/<flow_id>/<task_id>/`, runs the task there, and removes the worktree in `_run_one`'s `finally` block before persisting the final task state. Any filesystem changes the task wrote are gone by the time `stratum_parallel_poll` returns.

This is fine for result-returning tasks (parallel_review, lenses) whose final `result` message is structured JSON. It's **not fine** for code-writing tasks where the filesystem change *is* the output. Consumers cannot merge those changes back into their own repo because there's nothing to read. T2-F5-COMPOSE-MIGRATE v1 is therefore scoped to `isolation: "none"` only.

## Design

### 1. New IR field: `capture_diff`

Extend the `parallel_dispatch` step schema with an optional boolean:

```yaml
- id: execute
  function: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  isolation: worktree
  capture_diff: true          # ← new
  max_concurrent: 3
  require: all
  agent: claude
  intent_template: |
    Implement task {task.id}: {task.description}
```

Semantics:
- Default `false`. Existing `parallel_review` specs pay zero — no git subprocess, no diff text in state.
- Silently ignored when `isolation: "none"` (there's no worktree to diff).
- Passed to `ParallelExecutor` via constructor, matching the existing pattern for `max_concurrent` / `task_timeout`.
- Validator must reject non-bool values at spec-parse time (YAML typos like `"true"` as string shouldn't become truthy).

### 2. New `ParallelTaskState` fields: `diff` + `diff_error`

```python
@dataclass
class ParallelTaskState:
    task_id: str
    state: str = "pending"
    started_at: float | None = None
    finished_at: float | None = None
    result: Any = None
    error: str | None = None
    cert_violations: list | None = None
    worktree_path: str | None = None
    diff: str | None = None        # ← new
    diff_error: str | None = None  # ← new
```

- `diff`: unified diff text. Three states:
  - `None` — capture not requested, or the worktree was gone by the time finally ran (e.g., connector-setup failure path).
  - `""` — capture requested and succeeded; task produced no filesystem changes.
  - non-empty string — capture requested and succeeded; diff content.
- `diff_error`: short error string if a diff capture attempt raised (kept separate from `ts.error`, which carries task-execution error semantics — a successful task whose diff capture fails must not look "failed" to consumers). `None` when capture was not attempted or succeeded.
- Both auto-serialize through the existing `dataclasses.asdict()` path in `persist_flow()` at `executor.py:890`. No schema migration needed.
- Poll response surfaces them via the existing `tasks_out` serialization at `server.py:1038`.

### 3. Capture point — finally block only

Diff capture lives **only** in the `finally` block of `_run_one` (`parallel_exec.py:362-380`). Sketch:

```python
finally:
    # ... existing defensive state normalization ...
    if worktree_path_obj is not None:
        if self.capture_diff:
            try:
                ts.diff = await asyncio.to_thread(capture_worktree_diff, worktree_path_obj)
            except Exception as exc:
                ts.diff = None
                ts.diff_error = f"{type(exc).__name__}: {exc}"
        try:
            remove_worktree(worktree_path_obj)
        except Exception:
            pass
    await self._persist()
```

Notes:
- `asyncio.to_thread` prevents the blocking `subprocess.run` (up to 60s total — two 30s timeouts) from stalling the event loop for sibling tasks in the same executor. `create_worktree` / `remove_worktree` remain synchronous (existing behavior); threading the diff call is the incremental improvement.
- **Interaction with the existing inline remove at `parallel_exec.py:302-306`** (connector-setup failure path): that path does an inline `remove_worktree` and then returns. The `finally` still runs on return. To avoid noisy `diff_error` on tasks that never executed, the inline-remove path must **null `worktree_path_obj` immediately after the inline remove**:
  ```python
  if worktree_path_obj is not None:
      try:
          remove_worktree(worktree_path_obj)
      except Exception:
          pass
      worktree_path_obj = None   # ← add: prevents finally from touching a deleted path
  ```
  With that, the finally's guard (`if worktree_path_obj is not None`) skips both diff capture and the redundant second remove. Consumers of a connector-setup-failed task will see `diff is None, diff_error is None` — clean signal that the task never ran. (The inline remove stays; this is a one-line nulling, not a refactor.)
- Diff is captured regardless of terminal state (complete / failed / cancelled) as long as the worktree still existed when finally ran. Empty diffs (task failed before touching files) are recorded as empty string, not `None`.

### 4. `capture_worktree_diff` helper (public)

New public function in `worktree.py`, alongside `create_worktree` / `remove_worktree`:

```python
def capture_worktree_diff(path: Path) -> str:
    """Return a unified diff of the worktree vs HEAD, including untracked files.

    Runs ``git add -A`` (to stage all working-tree changes, including untracked)
    then ``git diff --cached HEAD``. Both calls use ``-c core.hooksPath=/dev/null``
    to prevent any pre-commit hook in the parent repo from firing in the
    ephemeral worktree.

    ``git add -A`` respects ``.gitignore`` — files matching parent-repo ignore
    rules are excluded from the diff. This is usually desired (no node_modules,
    no build artifacts, no .env) but consumers should be aware.

    Returns empty string if there are no changes. Raises on subprocess failure.
    Caller is responsible for swallowing exceptions.
    """
    common = ["-c", "core.hooksPath=/dev/null"]
    subprocess.run(
        ["git", *common, "add", "-A"],
        cwd=path, capture_output=True, check=True, timeout=30,
    )
    result = subprocess.run(
        ["git", *common, "diff", "--cached", "HEAD"],
        cwd=path, capture_output=True, check=True, timeout=30,
    )
    return result.stdout.decode("utf-8", errors="replace")
```

30-second timeouts match the existing worktree create/remove timeouts. `errors="replace"` lets the decode survive binary files (which `git diff` renders as a "Binary files differ" marker, but the marker itself is text).

**Concurrent-capture safety:** git's index is per-worktree, so N parallel `git add -A` calls in N sibling worktrees that share one `.git` dir are safe. No lock coordination needed.

### 5. `.gitignore` semantics (documented, not overridden)

Files the task writes that match `.gitignore` rules won't appear in the diff. This is intentional:
- Avoids accidentally capturing `node_modules/`, build artifacts, `.env` files.
- Prevents secrets in ignored files from leaking into flow state JSON.
- Matches the behavior consumers implementing diff-based merges expect.

Consumers that genuinely need every file (rare — almost always a design smell) can set their `.gitignore` accordingly. We do **not** support a `--force` variant in v1.

### 6. Size considerations

Diffs live in `~/.stratum/flows/{flow_id}.json` alongside all other flow state. Every `_persist()` call in the same flow re-serializes the full state, so a large diff has **O(n · diff_size)** I/O cost across the remaining `n` task completions in the flow.

Typical parallel dispatches have 3–10 tasks. If all 10 tasks produce 200KB diffs and each task's diff is present in state for every subsequent persist, cumulative I/O is bounded by `Σ k·200KB` for `k=1..10` ≈ 11MB total across the dispatch. Acceptable in v1.

**Not capped.** Matches the existing `stratum_parallel_done` consumer-dispatch contract, which accepts arbitrary result sizes. If flow-state bloat becomes real, add a `max_diff_bytes` field in a future feature.

### 7. Consumer contract

`stratum_parallel_poll` returns the `tasks` dict with the new fields:

```json
{
  "tasks": {
    "task-a": {
      "task_id": "task-a",
      "state": "complete",
      "result": {...},
      "worktree_path": "/Users/.../.stratum/worktrees/flow-xyz/task-a",
      "diff": "diff --git a/lib/foo.js b/lib/foo.js\nindex ...\n@@ -1 +1,2 @@\n line\n+new\n",
      "diff_error": null
    }
  }
}
```

Consumers opt in via spec (`capture_diff: true`) and read `tasks[task_id].diff` off the poll envelope. Applying and merge-conflict detection remain consumer-side (matches the existing consumer-dispatch contract in Compose).

The `worktree_path` field remains populated even though the worktree itself is gone by the time poll returns — it's a historical path for debugging; consumers must not try to read from it.

### 8. Testing

**Unit tests in `tests/test_worktree.py`:**
- `test_capture_diff_empty_when_no_changes` — fresh worktree, no edits → `""`
- `test_capture_diff_includes_modified_file` — edit tracked file → diff contains the hunk
- `test_capture_diff_includes_untracked_file` — new file → diff contains the addition (verifies `git add -A`)
- `test_capture_diff_handles_binary_file` — small binary file → does not raise; diff contains "Binary files differ" marker
- `test_capture_diff_respects_gitignore` — write a file matching `.gitignore` → does NOT appear in diff

**Integration tests (real-worktree path) in `tests/integration/test_parallel_executor.py`:**
- `test_capture_diff_flag_false_leaves_diff_none` — `capture_diff=False`, task writes a file → `ts.diff is None`, `ts.diff_error is None`
- `test_capture_diff_flag_true_populates_diff` — `capture_diff=True`, task writes a file → `ts.diff` contains the hunk
- `test_capture_diff_on_failed_task` — task fails after writing a file, `capture_diff=True` → diff still captured
- `test_capture_diff_isolation_none_no_op` — `isolation: none` + `capture_diff: true` → silently ignored, no subprocess calls, `ts.diff is None`
- `test_capture_diff_failure_populates_diff_error_not_task_error` — force subprocess failure (e.g., remove the `.git` dir before finally runs) → `ts.state == "complete"`, `ts.diff is None`, `ts.diff_error` is set

**Schema tests in `tests/test_parallel_schema.py`:**
- `test_capture_diff_accepts_bool` — `capture_diff: true` and `capture_diff: false` both parse
- `test_capture_diff_rejects_non_bool` — `capture_diff: "true"` (string) raises a validation error
- `test_capture_diff_omitted_defaults_to_false` — spec without `capture_diff` parses and the resulting step has `capture_diff == False`

**Additional integration test for the inline-remove interaction:**
- `test_capture_diff_connector_setup_failure_is_clean` — force connector construction to raise, `capture_diff=True` → task ends in `state="failed"`, `ts.diff is None`, `ts.diff_error is None` (no subprocess was attempted against the deleted worktree)

## Out of Scope

- Diff size caps (`max_diff_bytes`) — deferred.
- Binary-file content reconstruction — consumers should treat "Binary files differ" as a hint and fall back to another channel.
- Conflict detection server-side — consumers merge into their own repos.
- Rollback on partial-apply failure — consumer's problem.
- Streaming diffs — full diff arrives with the final poll envelope.
- The Compose consumer change — a separate future feature (say T2-F5-COMPOSE-MIGRATE-WORKTREE) extends routing so `isolation: "worktree"` paths use server-dispatch + consume `ts.diff`.
- Cleanup of the redundant inline `remove_worktree` at `parallel_exec.py:302-306` — noted here, separate follow-up.
