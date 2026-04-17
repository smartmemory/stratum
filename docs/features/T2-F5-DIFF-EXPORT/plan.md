# T2-F5-DIFF-EXPORT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture per-task git diffs in stratum-mcp's server-side parallel dispatch before worktree cleanup, surfacing them through the existing `stratum_parallel_poll` response. Opt-in via a new `capture_diff: bool` IR field; zero cost when disabled.

**Architecture:** Add two fields to `ParallelTaskState` (`diff`, `diff_error`), one field to `IRStepDef` (`capture_diff`), one helper to `worktree.py` (`capture_worktree_diff`), and a capture hook in `_run_one`'s finally block that runs `git add -A && git diff --cached HEAD` under `asyncio.to_thread` before `remove_worktree`. Null the early-return `worktree_path_obj` so the connector-setup-failure path doesn't emit noisy `diff_error`.

**Tech Stack:** Python 3.11+, pytest (`asyncio_mode = "auto"`), `subprocess.run` with 30s timeouts, `asyncio.to_thread`.

**Design doc:** `stratum/docs/features/T2-F5-DIFF-EXPORT/design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `stratum-mcp/src/stratum_mcp/worktree.py` | Modify | Add `capture_worktree_diff(path)` public helper |
| `stratum-mcp/src/stratum_mcp/executor.py` | Modify | Add `diff` + `diff_error` fields to `ParallelTaskState` |
| `stratum-mcp/src/stratum_mcp/spec.py` | Modify | Add `capture_diff: bool = False` to `IRStepDef` + parse in `_build_step` |
| `stratum-mcp/src/stratum_mcp/parallel_exec.py` | Modify | Accept `capture_diff` in constructor; null worktree_path_obj after inline remove; capture diff in finally |
| `stratum-mcp/src/stratum_mcp/server.py` | Modify | Pass `cur_step.capture_diff` to `ParallelExecutor` in `stratum_parallel_start` |
| `stratum-mcp/tests/test_worktree.py` | Modify | Add unit tests for `capture_worktree_diff` |
| `stratum-mcp/tests/integration/test_parallel_executor.py` | Modify | Add integration tests for diff-capture flag |
| `stratum-mcp/tests/integration/test_parallel_schema.py` | Modify | Add schema validation tests for `capture_diff` |

**Test runner:** `cd stratum/stratum-mcp && pytest` (pyproject has `testpaths = ["tests"]`, `asyncio_mode = "auto"`).
Single test file: `pytest tests/test_worktree.py -v`.

---

## Task 1: `capture_worktree_diff` helper — write failing tests

**Files:**
- Modify: `stratum/stratum-mcp/tests/test_worktree.py`

- [ ] **Step 1: Check existing test file pattern**

```bash
head -50 /Users/ruze/reg/my/forge/stratum/stratum-mcp/tests/test_worktree.py
```

Note the imports and how existing tests initialize a real git repo. Follow that pattern exactly.

- [ ] **Step 2: Append new tests**

Add to `tests/test_worktree.py`:

```python
import subprocess
from pathlib import Path

from stratum_mcp.worktree import capture_worktree_diff, create_worktree, remove_worktree


def _init_repo_with_file(tmp_path: Path, filename: str = "a.txt", content: str = "hello\n") -> Path:
    """Create a real git repo with one committed file. Returns the repo path."""
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / filename).write_text(content)
    subprocess.run(["git", "add", filename], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return repo


def test_capture_diff_empty_when_no_changes(tmp_path):
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-1", str(repo))
    try:
        diff = capture_worktree_diff(wt)
        assert diff == ""
    finally:
        remove_worktree(wt)


def test_capture_diff_includes_modified_file(tmp_path):
    repo = _init_repo_with_file(tmp_path, "a.txt", "one\n")
    wt = create_worktree("flow-1", "task-2", str(repo))
    try:
        (wt / "a.txt").write_text("one\ntwo\n")
        diff = capture_worktree_diff(wt)
        assert "+two" in diff
        assert "diff --git" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_includes_untracked_file(tmp_path):
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-3", str(repo))
    try:
        (wt / "new.txt").write_text("fresh\n")
        diff = capture_worktree_diff(wt)
        assert "new.txt" in diff
        assert "+fresh" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_handles_binary_file(tmp_path):
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-4", str(repo))
    try:
        (wt / "blob.bin").write_bytes(b"\x00\x01\x02\xffhello\x00world")
        diff = capture_worktree_diff(wt)
        # git renders binary additions as a marker; the marker itself is text.
        assert "blob.bin" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_respects_gitignore(tmp_path):
    repo = _init_repo_with_file(tmp_path)
    (repo / ".gitignore").write_text("ignored.txt\n")
    subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "ignore"], cwd=repo, check=True)
    wt = create_worktree("flow-1", "task-5", str(repo))
    try:
        (wt / "ignored.txt").write_text("secret\n")
        (wt / "kept.txt").write_text("public\n")
        diff = capture_worktree_diff(wt)
        assert "ignored.txt" not in diff
        assert "kept.txt" in diff
    finally:
        remove_worktree(wt)
```

- [ ] **Step 3: Run — expect failures (ImportError on `capture_worktree_diff`)**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/test_worktree.py -v 2>&1 | tail -20
```

Expected: 5 new tests collect + fail at import time. All existing tests still pass.

---

## Task 2: Implement `capture_worktree_diff`

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/worktree.py`

- [ ] **Step 1: Read current file to see existing exports**

```bash
cat /Users/ruze/reg/my/forge/stratum/stratum-mcp/src/stratum_mcp/worktree.py
```

- [ ] **Step 2: Add the function**

Append to `worktree.py` (after `remove_worktree`):

```python
def capture_worktree_diff(path: Path) -> str:
    """Return a unified diff of a worktree vs HEAD, including untracked files.

    Runs ``git add -A`` (to stage all working-tree changes) then
    ``git diff --cached HEAD``. Both calls use ``-c core.hooksPath=/dev/null``
    to prevent parent-repo pre-commit hooks from firing in the ephemeral worktree.

    ``git add -A`` respects ``.gitignore`` — files matching parent-repo ignore
    rules are excluded. Usually desired (no node_modules, no .env leaks) but
    consumers should be aware.

    Returns empty string if there are no changes. Raises ``CalledProcessError``
    or ``TimeoutExpired`` on subprocess failure; caller is responsible for
    swallowing exceptions if needed.
    """
    common = ["-c", "core.hooksPath=/dev/null"]
    subprocess.run(
        ["git", *common, "add", "-A"],
        cwd=path,
        capture_output=True,
        check=True,
        timeout=30,
    )
    result = subprocess.run(
        ["git", *common, "diff", "--cached", "HEAD"],
        cwd=path,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return result.stdout.decode("utf-8", errors="replace")
```

- [ ] **Step 3: Run tests — expect all pass**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/test_worktree.py -v 2>&1 | tail -20
```

Expected: all tests pass (original + 5 new).

- [ ] **Step 4: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/worktree.py stratum-mcp/tests/test_worktree.py
git commit -m "feat(t2-f5-diff-export): capture_worktree_diff helper"
```

---

## Task 3: Add `diff` + `diff_error` to `ParallelTaskState`

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/executor.py`

- [ ] **Step 1: Locate the dataclass**

```bash
grep -n "class ParallelTaskState" /Users/ruze/reg/my/forge/stratum/stratum-mcp/src/stratum_mcp/executor.py
```

Around line 687. Read the current definition to confirm.

- [ ] **Step 2: Add the two fields**

Edit `executor.py`. Locate `class ParallelTaskState`. After `worktree_path: str | None = None`, add:

```python
    # T2-F5-DIFF-EXPORT: unified diff of the task's worktree vs HEAD at terminal time.
    # None = capture not requested or worktree already gone; "" = captured, no changes;
    # non-empty = captured with changes.
    diff: str | None = None
    # T2-F5-DIFF-EXPORT: error string if diff capture raised (kept separate from `error`
    # which carries task-execution error semantics).
    diff_error: str | None = None
```

Fields auto-serialize through `dataclasses.asdict()` in `persist_flow` — no other change needed in executor.py.

- [ ] **Step 3: Run the existing executor tests**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/ -v 2>&1 | tail -10
```

Expected: all existing tests still pass. No new tests exercise these fields yet.

- [ ] **Step 4: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/executor.py
git commit -m "feat(t2-f5-diff-export): add diff + diff_error fields to ParallelTaskState"
```

---

## Task 4: Schema — add `capture_diff` to `IRStepDef` + tests

**Files:**
- Modify: `stratum/stratum-mcp/tests/integration/test_parallel_schema.py`
- Modify: `stratum/stratum-mcp/src/stratum_mcp/spec.py`

- [ ] **Step 1: Add failing schema tests**

Append to `tests/integration/test_parallel_schema.py`:

```python
def test_parallel_dispatch_capture_diff_accepts_bool(tmp_path):
    """capture_diff: true and capture_diff: false both parse."""
    from stratum_mcp.spec import parse_spec_yaml
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
        capture_diff: true
        agent: claude
        intent_template: "do x"
"""
    ir = parse_spec_yaml(spec)
    steps = {s.id: s for s in ir.flows["main"].steps}
    assert steps["execute"].capture_diff is True

    spec2 = spec.replace("capture_diff: true", "capture_diff: false")
    ir2 = parse_spec_yaml(spec2)
    steps2 = {s.id: s for s in ir2.flows["main"].steps}
    assert steps2["execute"].capture_diff is False


def test_parallel_dispatch_capture_diff_omitted_defaults_to_false():
    """Specs without capture_diff parse and the step has capture_diff=False."""
    from stratum_mcp.spec import parse_spec_yaml
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
    ir = parse_spec_yaml(spec)
    steps = {s.id: s for s in ir.flows["main"].steps}
    assert steps["execute"].capture_diff is False


def test_parallel_dispatch_capture_diff_rejects_non_bool():
    """capture_diff must be a bool — strings like 'true' are rejected at parse time."""
    from stratum_mcp.spec import parse_spec_yaml, SpecError
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
        capture_diff: "true"
        agent: claude
        intent_template: "do x"
"""
    import pytest
    with pytest.raises(SpecError, match="capture_diff"):
        parse_spec_yaml(spec)
```

(If `parse_spec_yaml` isn't the right entry point, match the imports used by the existing tests in the file — look at the top of `test_parallel_schema.py`.)

- [ ] **Step 2: Run — expect failures**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/integration/test_parallel_schema.py -v 2>&1 | tail -15
```

Expected: new tests fail because `capture_diff` field doesn't exist yet.

- [ ] **Step 3: Add field to `IRStepDef`**

Edit `src/stratum_mcp/spec.py`. Locate the `IRStepDef` dataclass (around line 58). After `task_timeout: int | None = None` (the T2-F5-ENFORCE field), add:

```python
    # T2-F5-DIFF-EXPORT: opt-in per-task diff capture for parallel_dispatch steps
    # with isolation=worktree. Silently ignored for isolation=none.
    capture_diff: bool = False
```

- [ ] **Step 4: Parse in `_build_step`**

Edit `src/stratum_mcp/spec.py`. Locate `_build_step` (around line 1053). The function constructs an `IRStepDef` from a dict. Add parsing logic:

Near the top of `_build_step`, after the existing `_apply_cert_defaults` calls, add type validation:

```python
    # T2-F5-DIFF-EXPORT: validate capture_diff is a bool if present
    if "capture_diff" in s and not isinstance(s["capture_diff"], bool):
        raise SpecError(
            f"step '{s['id']}': capture_diff must be a boolean, got "
            f"{type(s['capture_diff']).__name__} ({s['capture_diff']!r})"
        )
```

(Use whatever `SpecError` class the file already raises — check the imports.)

Inside the `IRStepDef(...)` return expression, add:

```python
        capture_diff=s.get("capture_diff", False),
```

Place it near the other parallel_dispatch fields (`source`, `max_concurrent`, etc.).

- [ ] **Step 5: Run tests — expect all pass**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/integration/test_parallel_schema.py -v 2>&1 | tail -15
```

Expected: 3 new tests pass. Full suite too:

```bash
pytest tests/ 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/spec.py stratum-mcp/tests/integration/test_parallel_schema.py
git commit -m "feat(t2-f5-diff-export): add capture_diff field to parallel_dispatch IR"
```

---

## Task 5: Wire `capture_diff` through `ParallelExecutor` constructor

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py`
- Modify: `stratum/stratum-mcp/src/stratum_mcp/server.py`

- [ ] **Step 1: Add constructor parameter**

Edit `parallel_exec.py`. Locate `class ParallelExecutor:` `__init__` (around line 100-130). Add a new keyword arg:

```python
    def __init__(
        self,
        *,
        state,
        step_id,
        tasks,
        max_concurrent,
        isolation,
        task_timeout,
        agent,
        intent_template,
        task_reasoning_template,
        require,
        model_id=None,
        persist_callable=None,
        capture_diff: bool = False,    # ← new
    ) -> None:
        ...
        self.capture_diff = capture_diff   # ← store it
```

(The exact existing signature may vary — match its style. The important parts are: add `capture_diff: bool = False` to the signature and `self.capture_diff = capture_diff` to the body.)

- [ ] **Step 2: Pass it from `stratum_parallel_start`**

Edit `server.py`. Locate the `ParallelExecutor(` instantiation in `stratum_parallel_start` (around line 901). Add:

```python
    executor = ParallelExecutor(
        state=state,
        step_id=step_id,
        tasks=tasks,
        max_concurrent=cur_step.max_concurrent or 3,
        isolation=isolation,
        task_timeout=task_timeout,
        agent=cur_step.agent,
        intent_template=cur_step.intent_template or "",
        task_reasoning_template=cur_step.task_reasoning_template,
        require=cur_step.require or "all",
        capture_diff=cur_step.capture_diff and isolation == "worktree",  # ← new
    )
```

The `and isolation == "worktree"` clause enforces that `capture_diff: true` is silently ignored when `isolation: none` (per the design doc).

- [ ] **Step 3: Run existing tests**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/ 2>&1 | tail -5
```

Expected: no regressions. No new tests yet.

- [ ] **Step 4: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/parallel_exec.py stratum-mcp/src/stratum_mcp/server.py
git commit -m "feat(t2-f5-diff-export): thread capture_diff through ParallelExecutor constructor"
```

---

## Task 6: Capture diff in `_run_one` finally block — write failing tests

**Files:**
- Modify: `stratum/stratum-mcp/tests/integration/test_parallel_executor.py`

- [ ] **Step 1: Check existing test patterns**

```bash
grep -n "capture_diff\|def test_\|ParallelExecutor\|monkeypatch" /Users/ruze/reg/my/forge/stratum/stratum-mcp/tests/integration/test_parallel_executor.py | head -25
```

Note which fixtures/helpers set up real git repos + executor instances. Reuse them.

- [ ] **Step 2: Add failing tests**

Append to `tests/integration/test_parallel_executor.py`:

```python
# ─────────────────────────────────────────────────────────────────────────────
# T2-F5-DIFF-EXPORT — diff capture behavior
# ─────────────────────────────────────────────────────────────────────────────

async def test_capture_diff_flag_false_leaves_diff_none(make_repo_and_run):
    """capture_diff=False — task runs, worktree cleans, ts.diff stays None."""
    # make_repo_and_run is a helper that sets up a real git repo, runs a
    # parallel dispatch with a stub connector that writes a file, and returns
    # the final FlowState. If no such helper exists, adapt from an existing test.
    state = await make_repo_and_run(
        capture_diff=False,
        task_writes_file=("a.txt", "new content"),
    )
    ts = next(iter(state.parallel_tasks.values()))
    assert ts.state == "complete"
    assert ts.diff is None
    assert ts.diff_error is None


async def test_capture_diff_flag_true_populates_diff(make_repo_and_run):
    """capture_diff=True — task writes a file, ts.diff contains the hunk."""
    state = await make_repo_and_run(
        capture_diff=True,
        task_writes_file=("a.txt", "modified\n"),
    )
    ts = next(iter(state.parallel_tasks.values()))
    assert ts.state == "complete"
    assert ts.diff is not None
    assert "a.txt" in ts.diff
    assert "modified" in ts.diff
    assert ts.diff_error is None


async def test_capture_diff_on_failed_task(make_repo_and_run):
    """Failed task that wrote a file before failure — diff still captured."""
    state = await make_repo_and_run(
        capture_diff=True,
        task_writes_file=("a.txt", "partial\n"),
        task_raises_after_write=True,
    )
    ts = next(iter(state.parallel_tasks.values()))
    assert ts.state == "failed"
    assert ts.diff is not None
    assert "partial" in ts.diff


async def test_capture_diff_isolation_none_no_op(make_repo_and_run):
    """isolation=none + capture_diff=true silently ignored (no subprocess calls)."""
    state = await make_repo_and_run(
        capture_diff=True,
        isolation="none",
    )
    ts = next(iter(state.parallel_tasks.values()))
    assert ts.state == "complete"
    assert ts.diff is None


async def test_capture_diff_connector_setup_failure_is_clean(make_repo_and_run):
    """Connector construction raises → task 'failed' but diff is None, diff_error is None."""
    state = await make_repo_and_run(
        capture_diff=True,
        connector_raises_on_construct=True,
    )
    ts = next(iter(state.parallel_tasks.values()))
    assert ts.state == "failed"
    assert ts.diff is None
    assert ts.diff_error is None  # no subprocess attempted against deleted worktree
```

**Fixture note:** If `make_repo_and_run` doesn't exist, you'll need to write it (or inline the setup into each test using the patterns from the nearby `test_isolation_worktree_invokes_create_remove` test at `tests/test_parallel_exec.py:369`). The fixture should:
- Set up a real git repo with an initial commit
- Build a `FlowState` pointing at it
- Construct a stub `AgentConnector` whose `run()` performs the requested filesystem side effect and then yields a `"result"` event
- Monkey-patch `make_agent_connector` (or the factory) to return that stub
- Construct and await `ParallelExecutor.run()` with the right args
- Return the final state for assertions

Adapt from the existing tests if unsure about shape.

- [ ] **Step 3: Run — expect failures**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/integration/test_parallel_executor.py -v -k "capture_diff" 2>&1 | tail -20
```

Expected: 5 failures (no capture-diff logic in `_run_one` yet; `ts.diff` stays None even when `capture_diff=True`).

---

## Task 7: Implement capture in `_run_one` finally + null inline-remove path

**Files:**
- Modify: `stratum/stratum-mcp/src/stratum_mcp/parallel_exec.py`

- [ ] **Step 1: Add import**

Near the top of `parallel_exec.py`:

```python
from .worktree import create_worktree, remove_worktree, capture_worktree_diff
```

Update the existing import to include `capture_worktree_diff`.

- [ ] **Step 2: Null `worktree_path_obj` after inline remove**

Locate the connector-setup failure branch (around `parallel_exec.py:302-306`):

```python
                except Exception as exc:
                    ts.state = "failed"
                    ts.error = str(exc)
                    ts.finished_at = time.time()
                    if worktree_path_obj is not None:
                        try:
                            remove_worktree(worktree_path_obj)
                        except Exception:
                            pass
                    await self._persist()
                    return
```

Change it to null `worktree_path_obj` after removal, so the finally block sees `None` and skips both diff capture and the redundant second remove:

```python
                except Exception as exc:
                    ts.state = "failed"
                    ts.error = str(exc)
                    ts.finished_at = time.time()
                    if worktree_path_obj is not None:
                        try:
                            remove_worktree(worktree_path_obj)
                        except Exception:
                            pass
                        worktree_path_obj = None   # ← prevent finally from touching deleted path
                    await self._persist()
                    return
```

- [ ] **Step 3: Add diff capture in the finally block**

Locate the existing finally block (around `parallel_exec.py:362-380`). Insert the diff capture immediately before the current `remove_worktree` call:

```python
        finally:
            if ts.state in ("pending", "running"):
                ts.state = "failed"
                ts.error = ts.error or "unexpected exit without terminal state"
            if ts.finished_at is None:
                ts.finished_at = time.time()
            if worktree_path_obj is not None:
                # T2-F5-DIFF-EXPORT: capture diff before cleanup
                if self.capture_diff:
                    try:
                        ts.diff = await asyncio.to_thread(
                            capture_worktree_diff, worktree_path_obj,
                        )
                    except Exception as exc:
                        ts.diff = None
                        ts.diff_error = f"{type(exc).__name__}: {exc}"
                try:
                    remove_worktree(worktree_path_obj)
                except Exception:
                    pass
            try:
                await self._persist()
            except asyncio.CancelledError:
                raise
            # Cascade cancel ...
            if self._require_unsatisfiable():
                self._cancel_siblings()
```

(Preserve the rest of the finally body verbatim — only the diff-capture block is new.)

- [ ] **Step 4: Run the capture-diff tests**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/integration/test_parallel_executor.py -v -k "capture_diff" 2>&1 | tail -15
```

Expected: all 5 pass.

- [ ] **Step 5: Run full suite**

```bash
pytest tests/ 2>&1 | tail -5
```

Expected: no regressions.

- [ ] **Step 6: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/src/stratum_mcp/parallel_exec.py stratum-mcp/tests/integration/test_parallel_executor.py
git commit -m "feat(t2-f5-diff-export): capture per-task diffs in _run_one finally block"
```

---

## Task 8: Docs — CHANGELOG, ROADMAP

**Files:**
- Modify: `stratum/stratum-mcp/CHANGELOG.md` (if exists) or `stratum/CHANGELOG.md`
- Modify: `stratum/docs/features/` parent roadmap if there's one
- Modify: outer forge ROADMAP.md at `/Users/ruze/reg/my/forge/ROADMAP.md`

- [ ] **Step 1: Locate the changelog**

```bash
ls /Users/ruze/reg/my/forge/stratum/stratum-mcp/CHANGELOG.md /Users/ruze/reg/my/forge/stratum/CHANGELOG.md 2>&1
```

Use whichever exists. Match the existing style (inspect recent entries).

- [ ] **Step 2: Add entry**

```
- T2-F5-DIFF-EXPORT: opt-in per-task diff capture for server-dispatched
  parallel_dispatch steps. New `capture_diff: bool` IR field (default false,
  honored only when `isolation: "worktree"`). Diffs populate
  `ParallelTaskState.diff` via `git add -A && git diff --cached HEAD` run
  under `asyncio.to_thread` before worktree cleanup. Error isolation via new
  `diff_error` field. Unblocks T2-F5-COMPOSE-MIGRATE for code-writing paths.
```

- [ ] **Step 3: Update the outer forge ROADMAP**

Add a new line below `T2-F5-COMPOSE-MIGRATE` in `/Users/ruze/reg/my/forge/ROADMAP.md`:

```
| ~~T2-F5-DIFF-EXPORT~~ | **COMPLETE** — Opt-in per-task diff capture (`capture_diff: bool`) before worktree cleanup in server-dispatched parallel_dispatch. Adds `diff` + `diff_error` fields to `ParallelTaskState`. Uses `git add -A && git diff --cached HEAD` via `asyncio.to_thread`. Unblocks T2-F5-COMPOSE-MIGRATE for `isolation: "worktree"` paths — the Compose consumer extension ships as a separate follow-up feature. | S | COMPLETE |
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ruze/reg/my/forge/stratum
git add stratum-mcp/CHANGELOG.md   # or stratum/CHANGELOG.md — whichever you edited
git commit -m "docs(t2-f5-diff-export): changelog entry"
```

The outer forge ROADMAP.md is not in any git repo; no commit needed.

---

## Task 9: Integration review + smoke check

- [ ] **Step 1: Full test suite**

```bash
cd /Users/ruze/reg/my/forge/stratum/stratum-mcp
pytest tests/ 2>&1 | tail -8
```

Expected: pass count = baseline + 13 new (5 worktree unit + 3 schema + 5 integration).

- [ ] **Step 2: Commit graph review**

```bash
cd /Users/ruze/reg/my/forge/stratum
git log --oneline b67cff5..HEAD
```

Expected: 7 commits (helper + state fields + schema + plumbing + capture + docs), plus the design commit already shipped.

- [ ] **Step 3: Dispatch final Claude-based integration review**

Use `superpowers:code-reviewer` with context "review T2-F5-DIFF-EXPORT cumulative diff in /Users/ruze/reg/my/forge/stratum." Fix any blockers, ship WARNs as follow-ups.

---

## Self-Review Checklist

- [x] Design §1 `capture_diff` IR field → Task 4
- [x] Design §2 `diff` + `diff_error` on `ParallelTaskState` → Task 3
- [x] Design §3 capture in finally + null worktree_path_obj after inline remove → Task 7
- [x] Design §4 `capture_worktree_diff` public helper → Tasks 1+2
- [x] Design §5 gitignore semantics covered by unit test → Task 1
- [x] Design §6 size deferred (no cap) → no task, documented only
- [x] Design §7 poll envelope — auto-serializes, no explicit code change needed
- [x] Design §8 all test classes → Tasks 1, 4, 6
- [x] Plumbing through `stratum_parallel_start` → Task 5
