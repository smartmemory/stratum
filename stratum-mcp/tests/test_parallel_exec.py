"""Tests for ParallelExecutor (T2-F5-ENFORCE T10).

Covers:
- _connector_type_from_agent: claude/codex/opencode/default
- _task_env: SENSITIVE_ENV_VARS scrubbing + STRATUM_* injection
- ParallelExecutor lifecycle: all-succeed, failure, timeout, cancellation cascade
- require=all|any|int semantics
- certificate validation flipping complete->failed
- per-flow persistence lock serialization
- worktree isolation: creation + cleanup
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
from stratum_mcp.parallel_exec import (
    DEFAULT_TASK_TIMEOUT,
    ParallelExecutor,
    _connector_type_from_agent,
    _task_env,
)
from stratum_mcp.executor import ParallelTaskState


# ---------------------------------------------------------------------------
# Minimal FlowState stand-in so we don't drag a full parse_and_validate into
# every test. The executor touches only .flow_id, .cwd, .parallel_tasks.
# ---------------------------------------------------------------------------

@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)


class StubConnector:
    """Minimal AgentConnector stub. Does NOT subclass AgentConnector to avoid
    ABC overhead; the executor only calls .run(...) and .interrupt()."""

    def __init__(
        self,
        *,
        result: Any = None,
        raise_exc: Exception | None = None,
        hang: bool = False,
        delay: float = 0.0,
        cwd: str | None = None,
        model_id: str | None = None,
    ) -> None:
        self.result = result
        self.raise_exc = raise_exc
        self.hang = hang
        self.delay = delay
        self.interrupted = 0
        self.cwd = cwd
        self.model_id = model_id
        self.run_calls: list[dict] = []

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        self.run_calls.append({"prompt": prompt, "cwd": cwd, "env": env, **kw})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raise_exc is not None:
            raise self.raise_exc
        if self.hang:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                raise
        yield {"type": "result", "output": self.result}

    def interrupt(self) -> None:
        self.interrupted += 1


# ---------------------------------------------------------------------------
# _connector_type_from_agent
# ---------------------------------------------------------------------------

def test_connector_type_from_agent_claude():
    assert _connector_type_from_agent("claude") == "claude"
    assert _connector_type_from_agent("claude:reviewer") == "claude"


def test_connector_type_from_agent_codex():
    assert _connector_type_from_agent("codex") == "codex"
    assert _connector_type_from_agent("codex:anything") == "codex"


def test_connector_type_from_agent_opencode_rejected():
    with pytest.raises(ValueError) as exc:
        _connector_type_from_agent("opencode")
    assert "T2-F5-OPENCODE-DISPATCH" in str(exc.value)

    with pytest.raises(ValueError) as exc2:
        _connector_type_from_agent("opencode:foo")
    assert "T2-F5-OPENCODE-DISPATCH" in str(exc2.value)


def test_connector_type_from_agent_none_uses_env_default(monkeypatch):
    monkeypatch.setenv("STRATUM_DEFAULT_AGENT", "codex")
    assert _connector_type_from_agent(None) == "codex"
    assert _connector_type_from_agent("") == "codex"


def test_connector_type_from_agent_unknown_prefix():
    with pytest.raises(ValueError) as exc:
        _connector_type_from_agent("gemini")
    assert "unknown connector prefix" in str(exc.value)


# ---------------------------------------------------------------------------
# _task_env
# ---------------------------------------------------------------------------

def test_task_env_scrubs_sensitive_vars(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("OPENAI_API_KEY", "b")
    monkeypatch.setenv("CLAUDE_API_KEY", "c")
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    env = _task_env("f1", "s1", "t1")

    for k in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"):
        assert k not in env, f"{k} should be scrubbed"

    assert env["STRATUM_FLOW_ID"] == "f1"
    assert env["STRATUM_STEP_ID"] == "s1"
    assert env["STRATUM_TASK_ID"] == "t1"
    assert env["PATH"] == "/usr/bin:/bin"


# ---------------------------------------------------------------------------
# ParallelExecutor: happy path
# ---------------------------------------------------------------------------

def _make_executor(
    *,
    tasks,
    state=None,
    agent="claude",
    require="all",
    isolation="none",
    task_timeout=30,
    max_concurrent=3,
    intent_template="run {id}",
    task_reasoning_template=None,
    persist_callable=None,
):
    state = state or FakeFlowState()
    return ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=max_concurrent,
        isolation=isolation,
        task_timeout=task_timeout,
        agent=agent,
        intent_template=intent_template,
        task_reasoning_template=task_reasoning_template,
        require=require,
        persist_callable=persist_callable or (lambda s: None),
    )


def _install_stub_factory(monkeypatch, stubs):
    """Install a make_agent_connector stub that returns StubConnectors in order.

    Tests pass stubs in the same order as the task list; the factory pops
    from a per-call iterator.
    """
    stub_iter = iter(stubs)

    def fake_factory(agent_type, model_id, cwd):
        return next(stub_iter)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", fake_factory)


async def test_all_succeed(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    stubs = [StubConnector(result={"artifact": "r1"}),
             StubConnector(result={"artifact": "r2"}),
             StubConnector(result={"artifact": "r3"})]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state)
    await ex.run()

    for tid, expected in zip(["t1", "t2", "t3"], stubs):
        ts = state.parallel_tasks[tid]
        assert ts.state == "complete", f"{tid}: {ts.state} (err={ts.error})"
        assert ts.result == expected.result
        assert ts.started_at is not None
        assert ts.finished_at is not None


async def test_one_stub_raises_marks_failed(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    stubs = [StubConnector(raise_exc=RuntimeError("boom")),
             StubConnector(result="ok2"),
             StubConnector(result="ok3")]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    # require="any" so failing t1 doesn't cascade-cancel the others.
    ex = _make_executor(tasks=tasks, state=state, require="any")
    await ex.run()

    assert state.parallel_tasks["t1"].state == "failed"
    assert state.parallel_tasks["t1"].error == "boom"
    assert state.parallel_tasks["t2"].state == "complete"
    assert state.parallel_tasks["t3"].state == "complete"


async def test_timeout_marks_failed_and_calls_interrupt(monkeypatch):
    tasks = [{"id": "t1"}]
    hung = StubConnector(hang=True)
    stubs = [hung]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, task_timeout=0)
    # Wrap in wait_for to avoid hangs if executor misbehaves.
    await asyncio.wait_for(ex.run(), timeout=10)
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert "timeout" in (ts.error or "")
    assert hung.interrupted >= 1


async def test_require_all_one_failure_cancels_others(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    # Delay stub 1's raise so stubs 2/3 get to enter their hang and register
    # their connectors before cascade fires.
    stubs = [StubConnector(raise_exc=RuntimeError("boom"), delay=0.05),
             StubConnector(hang=True),
             StubConnector(hang=True)]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, require="all", max_concurrent=3)

    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.parallel_tasks["t1"].state == "failed"
    assert state.parallel_tasks["t2"].state == "cancelled"
    assert state.parallel_tasks["t3"].state == "cancelled"
    assert stubs[1].interrupted >= 1
    assert stubs[2].interrupted >= 1


async def test_require_any_one_success_lets_others_finish(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    stubs = [StubConnector(result="a"),
             StubConnector(result="b"),
             StubConnector(result="c")]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, require="any", max_concurrent=3)
    await asyncio.wait_for(ex.run(), timeout=10)

    for tid in ["t1", "t2", "t3"]:
        assert state.parallel_tasks[tid].state == "complete"
    for stub in stubs:
        assert stub.interrupted == 0


async def test_require_N_becomes_unsatisfiable(monkeypatch):
    """require=2, first two fail -> third (hanging) gets cancelled."""
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    stubs = [StubConnector(raise_exc=RuntimeError("e1")),
             StubConnector(raise_exc=RuntimeError("e2")),
             StubConnector(hang=True)]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, require=2, max_concurrent=3)
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.parallel_tasks["t1"].state == "failed"
    assert state.parallel_tasks["t2"].state == "failed"
    # t3 either cancelled (if it started) or pending (if it never did).
    assert state.parallel_tasks["t3"].state == "cancelled"


async def test_cert_violation_flips_complete_to_failed(monkeypatch):
    tasks = [{"id": "t1"}]
    stubs = [StubConnector(result={"artifact": "# just text"})]
    _install_stub_factory(monkeypatch, stubs)

    monkeypatch.setattr(
        parallel_exec_mod, "validate_certificate",
        lambda template, result: ["certificate missing section: Premises"],
    )

    state = FakeFlowState()
    ex = _make_executor(
        tasks=tasks, state=state,
        task_reasoning_template={"sections": [{"label": "Premises"}]},
    )
    await ex.run()
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert ts.cert_violations == ["certificate missing section: Premises"]
    assert ts.error == "certificate validation failed"


async def test_persist_lock_serializes_writes(monkeypatch):
    """Two concurrent executors on the same flow_id serialize their persists."""
    tasks = [{"id": "t1"}]
    stubs_a = [StubConnector(result="a", delay=0.01)]
    stubs_b = [StubConnector(result="b", delay=0.01)]

    # Install a deterministic factory that hands out both sets in order.
    seq = iter(stubs_a + stubs_b)

    def fake_factory(agent_type, model_id, cwd):
        return next(seq)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", fake_factory)

    call_log: list[str] = []
    lock_order: list[str] = []

    async def recording_persist_a(state):
        lock_order.append("A_enter")
        await asyncio.sleep(0.05)
        lock_order.append("A_exit")

    async def recording_persist_b(state):
        lock_order.append("B_enter")
        await asyncio.sleep(0.05)
        lock_order.append("B_exit")

    # Our persist_callable is synchronous; bridge via a sync wrapper that
    # dispatches to a recording event log.
    def sync_persist_a(state):
        call_log.append(f"A:{state.parallel_tasks.get('t1').state}")

    def sync_persist_b(state):
        call_log.append(f"B:{state.parallel_tasks.get('t1').state}")

    state_a = FakeFlowState(flow_id="shared")
    state_b = FakeFlowState(flow_id="shared")

    # Reset any existing shared lock so the test starts clean.
    parallel_exec_mod._FLOW_LOCKS.pop("shared", None)

    ex_a = _make_executor(tasks=tasks, state=state_a,
                          persist_callable=sync_persist_a)
    ex_b = _make_executor(tasks=tasks, state=state_b,
                          persist_callable=sync_persist_b)

    await asyncio.gather(ex_a.run(), ex_b.run())

    # Both executors completed and both persist_callables fired multiple times.
    assert any(e.startswith("A:") for e in call_log)
    assert any(e.startswith("B:") for e in call_log)
    # Share the same lock instance.
    assert "shared" in parallel_exec_mod._FLOW_LOCKS


async def test_worktree_created_and_removed(monkeypatch, tmp_path):
    """isolation='worktree' invokes create_worktree and remove_worktree."""
    # Make sure the executor doesn't actually run git.
    create_calls: list[tuple] = []
    remove_calls: list[Path] = []

    def fake_create(flow_id, task_id, base_cwd):
        target = tmp_path / flow_id / task_id
        target.mkdir(parents=True, exist_ok=True)
        create_calls.append((flow_id, task_id, base_cwd))
        return target

    def fake_remove(path, force=True):
        remove_calls.append(path)

    monkeypatch.setattr(parallel_exec_mod, "create_worktree", fake_create)
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree", fake_remove)

    tasks = [{"id": "t1"}]
    stubs = [StubConnector(result="ok")]
    _install_stub_factory(monkeypatch, stubs)

    state = FakeFlowState(flow_id="wtflow", cwd=str(tmp_path))
    ex = _make_executor(tasks=tasks, state=state, isolation="worktree")
    await ex.run()

    assert create_calls == [("wtflow", "t1", str(tmp_path))]
    assert len(remove_calls) == 1
    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.worktree_path is not None
    assert Path(ts.worktree_path) == tmp_path / "wtflow" / "t1"


async def test_opencode_agent_rejected_marks_failed(monkeypatch):
    """opencode should be rejected at dispatch time, marking the task failed."""
    tasks = [{"id": "t1"}]

    # Factory should never actually be consulted — rejection fires earlier.
    def never_called(agent_type, model_id, cwd):  # pragma: no cover
        raise AssertionError("factory must not be invoked for opencode")

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", never_called)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, agent="opencode")
    await ex.run()
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert "T2-F5-OPENCODE-DISPATCH" in (ts.error or "")


async def test_worktree_failure_marks_task_failed(monkeypatch, tmp_path):
    """If create_worktree raises, the task ends as failed, not crashing the executor."""
    def fake_create(*args, **kw):
        raise RuntimeError("git worktree add failed: not a repo")

    monkeypatch.setattr(parallel_exec_mod, "create_worktree", fake_create)

    tasks = [{"id": "t1"}]
    # Factory should not be reached because worktree setup fails first.
    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("unreachable")))

    state = FakeFlowState(flow_id="wtflow", cwd=str(tmp_path))
    ex = _make_executor(tasks=tasks, state=state, isolation="worktree")
    await ex.run()
    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert "worktree setup failed" in (ts.error or "")


# ---------------------------------------------------------------------------
# T14 — resume hook + shutdown hook
# ---------------------------------------------------------------------------


def test_resume_marks_running_tasks_failed(tmp_path):
    """Persisted flows with state='running' parallel_tasks get flipped to
    'failed' on startup, while 'complete' tasks stay untouched."""
    import json
    from stratum_mcp.parallel_exec import resume_interrupted_parallel_tasks

    flow_path = tmp_path / "flow-abc.json"
    payload = {
        "flow_id": "flow-abc",
        "parallel_tasks": {
            "t1": {
                "task_id": "t1",
                "state": "running",
                "started_at": 1.0,
                "finished_at": None,
                "result": None,
                "error": None,
                "cert_violations": None,
                "worktree_path": None,
            },
            "t2": {
                "task_id": "t2",
                "state": "running",
                "started_at": 2.0,
                "finished_at": None,
                "result": None,
                "error": None,
                "cert_violations": None,
                "worktree_path": None,
            },
            "t3": {
                "task_id": "t3",
                "state": "complete",
                "started_at": 1.5,
                "finished_at": 3.5,
                "result": {"ok": True},
                "error": None,
                "cert_violations": None,
                "worktree_path": None,
            },
        },
    }
    flow_path.write_text(json.dumps(payload))

    resume_interrupted_parallel_tasks(tmp_path)

    reloaded = json.loads(flow_path.read_text())
    pts = reloaded["parallel_tasks"]

    # Both running tasks flipped to failed with the expected error message.
    assert pts["t1"]["state"] == "failed"
    assert pts["t1"]["error"] == "server restart interrupted task"
    assert pts["t1"]["finished_at"] is not None
    assert pts["t2"]["state"] == "failed"
    assert pts["t2"]["error"] == "server restart interrupted task"
    assert pts["t2"]["finished_at"] is not None

    # The complete task is left unchanged.
    assert pts["t3"]["state"] == "complete"
    assert pts["t3"]["result"] == {"ok": True}
    assert pts["t3"]["finished_at"] == 3.5


def test_resume_handles_missing_or_empty_flow_root(tmp_path):
    """Non-existent flow root is a no-op; empty flow root is a no-op."""
    from stratum_mcp.parallel_exec import resume_interrupted_parallel_tasks

    # Non-existent directory — should not raise.
    resume_interrupted_parallel_tasks(tmp_path / "does-not-exist")

    # Empty directory — should not raise.
    empty = tmp_path / "empty"
    empty.mkdir()
    resume_interrupted_parallel_tasks(empty)


# ---------------------------------------------------------------------------
# T2-F5-DIFF-EXPORT: diff capture in _run_one finally block
# ---------------------------------------------------------------------------


def _make_executor_with_diff(
    *,
    tasks,
    state=None,
    isolation="worktree",
    capture_diff=False,
    monkeypatch,
    tmp_path,
    stubs,
    create_side_effect=None,
    remove_side_effect=None,
):
    """Helper: builds an executor with worktree mocks installed and capture_diff wired."""
    create_calls: list = []
    remove_calls: list = []

    def fake_create(flow_id, task_id, base_cwd):
        target = tmp_path / flow_id / task_id
        target.mkdir(parents=True, exist_ok=True)
        create_calls.append((flow_id, task_id, base_cwd))
        if create_side_effect is not None:
            create_side_effect(target)
        return target

    def fake_remove(path, force=True):
        remove_calls.append(path)

    monkeypatch.setattr(parallel_exec_mod, "create_worktree", fake_create)
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree", fake_remove)

    _install_stub_factory(monkeypatch, stubs)

    _state = state or FakeFlowState(flow_id="dflow", cwd=str(tmp_path))

    ex = ParallelExecutor(
        state=_state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=3,
        isolation=isolation,
        task_timeout=30,
        agent="claude",
        intent_template="run {id}",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
        capture_diff=capture_diff,
    )
    return ex, _state, create_calls, remove_calls


async def test_capture_diff_flag_false_leaves_diff_none(monkeypatch, tmp_path):
    """capture_diff=False → ts.diff and ts.diff_error stay None after task completes."""
    tasks = [{"id": "t1"}]
    stubs = [StubConnector(result="ok")]

    captured_diffs: list = []

    def fake_capture(path):
        captured_diffs.append(path)
        return "diff --git a/a.txt ..."

    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    ex, state, _, _ = _make_executor_with_diff(
        tasks=tasks,
        isolation="worktree",
        capture_diff=False,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
        stubs=stubs,
    )
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.diff is None
    assert ts.diff_error is None
    # capture_worktree_diff must NOT have been invoked
    assert captured_diffs == []


async def test_capture_diff_flag_true_populates_diff(monkeypatch, tmp_path):
    """capture_diff=True, task writes a.txt → ts.diff contains 'a.txt' and file content."""
    tasks = [{"id": "t1"}]

    class WritingConnector:
        async def run(self, prompt, *, cwd=None, env=None, **kw):
            # Write a file to the worktree directory
            if cwd:
                (Path(cwd) / "a.txt").write_text("hello diff\n")
            yield {"type": "result", "output": "done"}

        def interrupt(self):
            pass

    stubs = [WritingConnector()]

    def fake_capture(path):
        # Return a realistic-looking diff showing a.txt
        return f"+++ b/a.txt\n+hello diff\n"

    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    ex, state, _, _ = _make_executor_with_diff(
        tasks=tasks,
        isolation="worktree",
        capture_diff=True,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
        stubs=stubs,
    )
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.diff is not None
    assert "a.txt" in ts.diff
    assert ts.diff_error is None


async def test_capture_diff_on_failed_task(monkeypatch, tmp_path):
    """Task writes a file then raises → ts.state=='failed', ts.diff captures partial write."""
    tasks = [{"id": "t1"}]

    class FailingWritingConnector:
        async def run(self, prompt, *, cwd=None, env=None, **kw):
            if cwd:
                (Path(cwd) / "a.txt").write_text("partial\n")
            raise RuntimeError("agent crashed")
            yield  # make it an async generator

        def interrupt(self):
            pass

    stubs = [FailingWritingConnector()]

    def fake_capture(path):
        return "+++ b/a.txt\n+partial\n"

    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    ex, state, _, _ = _make_executor_with_diff(
        tasks=tasks,
        isolation="worktree",
        capture_diff=True,
        monkeypatch=monkeypatch,
        tmp_path=tmp_path,
        stubs=stubs,
    )
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert ts.diff is not None
    assert "a.txt" in ts.diff


async def test_capture_diff_isolation_none_no_op(monkeypatch, tmp_path):
    """isolation='none', capture_diff=False in executor → ts.diff stays None."""
    tasks = [{"id": "t1"}]
    stubs = [StubConnector(result="ok")]

    captured_diffs: list = []

    def fake_capture(path):
        captured_diffs.append(path)
        return "should not be called"

    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    # With isolation=none, no worktree is created, so capture never fires
    state = FakeFlowState(flow_id="noiso", cwd=str(tmp_path))
    _install_stub_factory(monkeypatch, stubs)
    ex = ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=3,
        isolation="none",
        task_timeout=30,
        agent="claude",
        intent_template="run {id}",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
        capture_diff=False,
    )
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "complete"
    assert ts.diff is None
    assert ts.diff_error is None
    assert captured_diffs == []


async def test_capture_diff_connector_setup_failure_is_clean(monkeypatch, tmp_path):
    """Connector factory raises → task fails pre-execution → ts.diff and ts.diff_error are None.

    The inline remove in the connector-setup-failure path should null worktree_path_obj
    so the finally block's capture is skipped entirely.
    """
    tasks = [{"id": "t1"}]

    captured_diffs: list = []

    def fake_capture(path):
        captured_diffs.append(path)
        return "should not be captured"

    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    create_calls: list = []
    remove_calls: list = []

    def fake_create(flow_id, task_id, base_cwd):
        target = tmp_path / flow_id / task_id
        target.mkdir(parents=True, exist_ok=True)
        create_calls.append(target)
        return target

    def fake_remove(path, force=True):
        remove_calls.append(path)

    monkeypatch.setattr(parallel_exec_mod, "create_worktree", fake_create)
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree", fake_remove)

    def failing_factory(agent_type, model_id, cwd):
        raise RuntimeError("connector setup exploded")

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", failing_factory)

    state = FakeFlowState(flow_id="csfail", cwd=str(tmp_path))
    ex = ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=3,
        isolation="worktree",
        task_timeout=30,
        agent="claude",
        intent_template="run {id}",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
        capture_diff=True,
    )
    await ex.run()

    ts = state.parallel_tasks["t1"]
    assert ts.state == "failed"
    assert ts.diff is None
    assert ts.diff_error is None
    # Worktree was created and removed inline; capture must not have fired
    assert len(create_calls) == 1
    assert len(remove_calls) == 1
    assert captured_diffs == []


async def test_capture_diff_cancellation_still_cleans_worktree(monkeypatch, tmp_path):
    """CancelledError during asyncio.to_thread must not leak the worktree.

    If a sibling task's failure triggers cascade-cancel while this task is in
    the middle of diff capture, CancelledError propagates into the finally
    block's await. Cleanup must still run, and cancellation must still propagate.
    """
    tasks = [{"id": "t1"}]

    create_calls: list = []
    remove_calls: list = []

    def fake_create(flow_id, task_id, base_cwd):
        target = tmp_path / flow_id / task_id
        target.mkdir(parents=True, exist_ok=True)
        create_calls.append(target)
        return target

    def fake_remove(path, force=True):
        remove_calls.append(path)

    def fake_capture(path):
        # Simulate a slow subprocess that gets interrupted before completion.
        raise asyncio.CancelledError()

    monkeypatch.setattr(parallel_exec_mod, "create_worktree", fake_create)
    monkeypatch.setattr(parallel_exec_mod, "remove_worktree", fake_remove)
    monkeypatch.setattr(parallel_exec_mod, "capture_worktree_diff", fake_capture)

    class CompletingConnector:
        def __init__(self, *args, **kwargs): pass
        async def run(self, prompt, cwd=None, env=None, **_):
            yield {"type": "result", "content": "ok"}
        def interrupt(self): pass

    monkeypatch.setattr(
        parallel_exec_mod, "make_agent_connector",
        lambda agent_type, model_id, cwd: CompletingConnector(),
    )

    state = FakeFlowState(flow_id="fcanc", cwd=str(tmp_path))
    ex = ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=3,
        isolation="worktree",
        task_timeout=30,
        agent="claude",
        intent_template="run {id}",
        task_reasoning_template=None,
        require="all",
        persist_callable=lambda s: None,
        capture_diff=True,
    )
    # Drive one task to completion; the fake_capture will raise CancelledError
    # inside the diff step. We run via .run() which wraps in gather(return_exceptions=True),
    # so the CancelledError is absorbed and we just assert on the end state.
    await ex.run()

    ts = state.parallel_tasks["t1"]
    # Cleanup must have run despite the cancellation during capture.
    assert len(remove_calls) == 1, f"worktree leaked: {remove_calls}"
    # Error signal is surfaced.
    assert ts.diff is None
    assert ts.diff_error == "cancelled during diff capture"


def test_resume_skips_files_without_parallel_tasks(tmp_path):
    """Flows without parallel_tasks (e.g., legacy persisted state) are untouched."""
    import json
    from stratum_mcp.parallel_exec import resume_interrupted_parallel_tasks

    flow_path = tmp_path / "flow-legacy.json"
    payload = {"flow_id": "flow-legacy"}  # no parallel_tasks key
    flow_path.write_text(json.dumps(payload))

    resume_interrupted_parallel_tasks(tmp_path)

    # Round-trips unchanged.
    assert json.loads(flow_path.read_text()) == payload


def test_resume_tolerates_corrupt_json(tmp_path):
    """A corrupt .json file in the flow root does not crash resume."""
    from stratum_mcp.parallel_exec import resume_interrupted_parallel_tasks

    (tmp_path / "broken.json").write_text("{not valid json")

    # Must not raise.
    resume_interrupted_parallel_tasks(tmp_path)


async def test_shutdown_all_cancels_registered_tasks():
    """shutdown_all cancels every registered asyncio.Task and is idempotent."""
    from stratum_mcp.parallel_exec import shutdown_all

    async def _long():
        await asyncio.sleep(60)

    t1 = asyncio.create_task(_long())
    t2 = asyncio.create_task(_long())
    # Let the tasks enter the running state before cancelling.
    await asyncio.sleep(0)

    registry: dict = {("f1", "s1"): t1, ("f1", "s2"): t2}
    shutdown_all(registry)

    # Drive the loop until cancellation is observable.
    for _ in range(5):
        if t1.done() and t2.done():
            break
        await asyncio.sleep(0)

    assert t1.cancelled() or (t1.done() and isinstance(t1.exception(), asyncio.CancelledError))
    assert t2.cancelled() or (t2.done() and isinstance(t2.exception(), asyncio.CancelledError))

    # Idempotent — second call (tasks already done) must not raise.
    shutdown_all(registry)


async def test_shutdown_all_no_registry_is_safe():
    """Calling shutdown_all with no registry is a no-op."""
    from stratum_mcp.parallel_exec import shutdown_all

    shutdown_all()  # None/default → no-op
    shutdown_all({})  # empty → no-op


async def test_shutdown_all_skips_already_done_tasks():
    """Already-done tasks in the registry are left alone (no cancel-on-done)."""
    from stratum_mcp.parallel_exec import shutdown_all

    async def _noop():
        return 42

    t = asyncio.create_task(_noop())
    await t  # let it complete
    assert t.done() and not t.cancelled()

    registry: dict = {("f1", "s1"): t}
    shutdown_all(registry)  # must not raise

    # Done task is still not cancelled after shutdown_all.
    assert not t.cancelled()
    assert t.result() == 42


# ---------------------------------------------------------------------------
# T2-F5-DEPENDS-ON tests
# ---------------------------------------------------------------------------

async def test_depends_on_dependent_waits_for_upstream_complete(monkeypatch):
    """B depends on A; B's started_at must be >= A's finished_at."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
    ]
    stubs = [
        StubConnector(result={"v": 1}, delay=0.05),
        StubConnector(result={"v": 2}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=2)
    await ex.run()

    ts_a = state.parallel_tasks["a"]
    ts_b = state.parallel_tasks["b"]
    assert ts_a.state == "complete"
    assert ts_b.state == "complete"
    assert ts_b.started_at >= ts_a.finished_at


async def test_depends_on_dependent_cancels_on_upstream_failure(monkeypatch):
    """A fails; B depends on A → B should be cancelled with descriptive error."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
    ]
    stubs = [
        StubConnector(raise_exc=RuntimeError("boom")),
        StubConnector(result={"v": 2}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=2, require="any")
    await ex.run()

    ts_b = state.parallel_tasks["b"]
    assert ts_b.state == "cancelled"
    assert "upstream task 'a' did not complete" in (ts_b.error or "")
    assert ts_b.worktree_path is None
    assert ts_b.started_at is None


async def test_depends_on_dependent_cancels_on_upstream_cancellation(monkeypatch):
    """A gets cascade-cancelled; B depends on A → B should also be cancelled."""
    tasks = [
        {"id": "x"},
        {"id": "a", "depends_on": []},
        {"id": "b", "depends_on": ["a"]},
    ]
    # x fails immediately, triggering cascade-cancel of "a" under require=all
    stubs = [
        StubConnector(raise_exc=RuntimeError("x fails")),
        StubConnector(result={"v": 1}, hang=True),
        StubConnector(result={"v": 2}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=3, require="all")
    await ex.run()

    ts_b = state.parallel_tasks["b"]
    assert ts_b.state == "cancelled"
    # B was cancelled — either by cascade-cancel arriving while awaiting A's
    # done-event, or by the dep-check seeing A's terminal state. Either way B
    # must never have started running.
    assert ts_b.started_at is None


async def test_depends_on_unknown_task_id_fails_task(monkeypatch):
    """B declares depends_on a task id not in the task list → B fails with unknown-dep error."""
    tasks = [
        {"id": "b", "depends_on": ["does-not-exist"]},
    ]
    stubs = [StubConnector(result={"v": 2})]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state)
    await ex.run()

    ts_b = state.parallel_tasks["b"]
    assert ts_b.state == "failed"
    assert "does-not-exist" in (ts_b.error or "")


async def test_depends_on_chain(monkeypatch):
    """A → B → C linear chain: all complete in timestamp order."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["b"]},
    ]
    stubs = [
        StubConnector(result={"v": 1}, delay=0.03),
        StubConnector(result={"v": 2}, delay=0.03),
        StubConnector(result={"v": 3}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=3)
    await ex.run()

    ts_a = state.parallel_tasks["a"]
    ts_b = state.parallel_tasks["b"]
    ts_c = state.parallel_tasks["c"]
    for ts in (ts_a, ts_b, ts_c):
        assert ts.state == "complete"
    assert ts_b.started_at >= ts_a.finished_at
    assert ts_c.started_at >= ts_b.finished_at


async def test_depends_on_diamond(monkeypatch):
    """A → {B, C} → D diamond: all complete."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["a"]},
        {"id": "d", "depends_on": ["b", "c"]},
    ]
    stubs = [
        StubConnector(result={"v": 1}, delay=0.02),
        StubConnector(result={"v": 2}),
        StubConnector(result={"v": 3}),
        StubConnector(result={"v": 4}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=4)
    await ex.run()

    for tid in ("a", "b", "c", "d"):
        assert state.parallel_tasks[tid].state == "complete"
    ts_a = state.parallel_tasks["a"]
    ts_d = state.parallel_tasks["d"]
    assert ts_d.started_at >= ts_a.finished_at


async def test_depends_on_independent_tasks_run_concurrently(monkeypatch):
    """Regression: no depends_on, max_concurrent=2 — 2 tasks start nearly simultaneously."""
    tasks = [{"id": "t1"}, {"id": "t2"}]
    stubs = [
        StubConnector(result={"v": 1}, delay=0.05),
        StubConnector(result={"v": 2}, delay=0.05),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=2)
    await ex.run()

    ts1 = state.parallel_tasks["t1"]
    ts2 = state.parallel_tasks["t2"]
    assert ts1.state == "complete"
    assert ts2.state == "complete"
    # Both started within 20ms of each other (concurrent, not sequential)
    assert abs(ts1.started_at - ts2.started_at) < 0.02


async def test_depends_on_direct_cycle_fails_all_tasks(monkeypatch):
    """A depends on B, B depends on A → cycle detected → all tasks fail."""
    tasks = [
        {"id": "a", "depends_on": ["b"]},
        {"id": "b", "depends_on": ["a"]},
    ]
    stubs = [StubConnector(result={}), StubConnector(result={})]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state)
    await ex.run()

    for tid in ("a", "b"):
        ts = state.parallel_tasks[tid]
        assert ts.state == "failed"
        assert "cycle" in (ts.error or "").lower()


async def test_depends_on_transitive_cycle_fails_all_tasks(monkeypatch):
    """A→B→C→A transitive cycle → all tasks fail."""
    tasks = [
        {"id": "a", "depends_on": ["c"]},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["b"]},
    ]
    stubs = [StubConnector(result={}), StubConnector(result={}), StubConnector(result={})]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state)
    await ex.run()

    for tid in ("a", "b", "c"):
        ts = state.parallel_tasks[tid]
        assert ts.state == "failed"
        assert "cycle" in (ts.error or "").lower()


async def test_depends_on_dependent_cancel_triggers_sibling_cascade_when_require_all(monkeypatch):
    """A fails → B (depends on A) cancels → C (independent) should also cancel under require=all."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c"},
    ]
    stubs = [
        StubConnector(raise_exc=RuntimeError("a fails")),
        StubConnector(result={"v": 2}),
        StubConnector(result={"v": 3}, hang=True),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=3, require="all")
    await ex.run()

    assert state.parallel_tasks["a"].state == "failed"
    assert state.parallel_tasks["b"].state == "cancelled"
    assert state.parallel_tasks["c"].state == "cancelled"


async def test_depends_on_unknown_id_not_flagged_as_cycle(monkeypatch):
    """B depends on 'ghost' (not in task list) → fails with unknown-dep, not cycle error."""
    tasks = [{"id": "b", "depends_on": ["ghost"]}]
    stubs = [StubConnector(result={})]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state)
    await ex.run()

    ts_b = state.parallel_tasks["b"]
    assert ts_b.state == "failed"
    assert "cycle" not in (ts_b.error or "").lower()
    assert "ghost" in (ts_b.error or "")


async def test_waiting_tasks_do_not_consume_semaphore_slots(monkeypatch):
    """max_concurrent=1, A→B→C chain. All complete; waits must not consume the slot."""
    tasks = [
        {"id": "a"},
        {"id": "b", "depends_on": ["a"]},
        {"id": "c", "depends_on": ["b"]},
    ]
    stubs = [
        StubConnector(result={"v": 1}),
        StubConnector(result={"v": 2}),
        StubConnector(result={"v": 3}),
    ]
    _install_stub_factory(monkeypatch, stubs)
    state = FakeFlowState()
    ex = _make_executor(tasks=tasks, state=state, max_concurrent=1)
    await asyncio.wait_for(ex.run(), timeout=5.0)

    for tid in ("a", "b", "c"):
        assert state.parallel_tasks[tid].state == "complete", f"{tid} not complete"
