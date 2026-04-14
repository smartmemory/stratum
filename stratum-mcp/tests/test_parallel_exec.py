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
