"""STRAT-WORKFLOW-BUDGET — S5: parallel fan-out debit + hard cutoff cascade.

When a task's consumption tips the flow over its run budget, the executor marks
the flow terminal (budget_exhausted) and cascade-cancels in-flight siblings,
reusing the same _cancel_siblings path as require-unsatisfiable.
"""
import asyncio
from dataclasses import dataclass, field

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
from stratum_mcp.parallel_exec import ParallelExecutor
from stratum_mcp.run_budget import BUDGET_EXHAUSTED

pytestmark = pytest.mark.asyncio


@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget_state: dict | None = None


class UsageStub:
    """Stub connector: emits a usage event then a result. Optional hang."""

    def __init__(self, *, tokens=0, result="ok", hang=False, delay=0.0):
        self.tokens = tokens
        self.result = result
        self.hang = hang
        self.delay = delay
        self.interrupted = 0

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.hang:
            await asyncio.sleep(3600)
        if self.tokens:
            yield {"type": "usage", "input_tokens": self.tokens, "output_tokens": 0,
                   "cost_usd": 0.0}
        yield {"type": "result", "output": self.result}

    def interrupt(self):
        self.interrupted += 1


def _install_stubs(monkeypatch, stubs):
    it = iter(stubs)

    def factory(agent_type, model_id, cwd):
        return next(it)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", factory)


def _executor(tasks, state, *, require="all", max_concurrent=3):
    return ParallelExecutor(
        state=state,
        step_id="s1",
        tasks=tasks,
        max_concurrent=max_concurrent,
        isolation="none",
        task_timeout=30,
        agent="claude",
        intent_template="run {id}",
        task_reasoning_template=None,
        require=require,
        persist_callable=lambda s: None,
    )


def _budgeted(caps):
    return FakeFlowState(budget_state={
        "caps": caps,
        "consumed": {"wall_s": 0.0, "dispatches": 0, "tokens": 0, "dollars": 0.0},
    })


async def test_token_budget_trips_and_cancels_siblings(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]
    stubs = [UsageStub(tokens=1000, result="r1"),
             UsageStub(hang=True), UsageStub(hang=True)]
    _install_stubs(monkeypatch, stubs)
    state = _budgeted({"max_tokens": 500})
    # require="any": a completed t1 satisfies require, isolating the budget cascade.
    ex = _executor(tasks, state, require="any")
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.terminal_status == BUDGET_EXHAUSTED
    assert state.parallel_tasks["t1"].state == "complete"
    assert state.parallel_tasks["t1"].tokens == 1000
    assert state.parallel_tasks["t2"].state == "cancelled"
    assert state.parallel_tasks["t3"].state == "cancelled"
    assert state.budget_state["consumed"]["tokens"] >= 1000
    assert state.budget_state["consumed"]["dispatches"] >= 1


async def test_terminal_status_set_before_persist(monkeypatch):
    """The persisted snapshot must carry budget_exhausted (durable across restart).

    We capture the state passed to persist at the moment of the budget-tipping
    task's persist and assert terminal_status is already set.
    """
    seen = {}

    def persist(s):
        # record terminal_status observed at each persist call
        seen["last"] = s.terminal_status

    tasks = [{"id": "t1"}]
    stubs = [UsageStub(tokens=1000, result="r1")]
    _install_stubs(monkeypatch, stubs)
    state = _budgeted({"max_tokens": 500})
    ex = ParallelExecutor(
        state=state, step_id="s1", tasks=tasks, max_concurrent=1,
        isolation="none", task_timeout=30, agent="claude",
        intent_template="run {id}", task_reasoning_template=None, require="any",
        persist_callable=persist,
    )
    await asyncio.wait_for(ex.run(), timeout=10)
    assert state.terminal_status == BUDGET_EXHAUSTED
    assert seen["last"] == BUDGET_EXHAUSTED  # set BEFORE the persist, not after


async def test_dispatch_count_budget_trips(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}]
    stubs = [UsageStub(result="r1"), UsageStub(hang=True)]
    _install_stubs(monkeypatch, stubs)
    state = _budgeted({"max_agent_dispatches": 1})
    ex = _executor(tasks, state, require="any", max_concurrent=2)
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.terminal_status == BUDGET_EXHAUSTED
    assert state.parallel_tasks["t2"].state == "cancelled"


class UsageThenRaiseStub:
    """Emits a usage event, then raises — partial usage must still be charged."""
    def __init__(self, tokens):
        self.tokens = tokens
        self.interrupted = 0

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        yield {"type": "usage", "input_tokens": self.tokens, "output_tokens": 0}
        raise RuntimeError("boom")

    def interrupt(self):
        self.interrupted += 1


async def test_partial_usage_charged_on_failed_task(monkeypatch):
    """A task that emits usage then fails still debits its tokens (not free)."""
    tasks = [{"id": "t1"}]
    _install_stubs(monkeypatch, [UsageThenRaiseStub(tokens=400)])
    state = _budgeted({"max_tokens": 100000})
    ex = _executor(tasks, state, require="any", max_concurrent=1)
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.parallel_tasks["t1"].state == "failed"
    assert state.budget_state["consumed"]["tokens"] == 400  # partial usage charged
    assert state.budget_state["consumed"]["dispatches"] == 1


async def test_within_budget_no_cutoff(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}]
    stubs = [UsageStub(tokens=100, result="r1"), UsageStub(tokens=100, result="r2")]
    _install_stubs(monkeypatch, stubs)
    state = _budgeted({"max_tokens": 100000})
    ex = _executor(tasks, state, require="all", max_concurrent=2)
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.terminal_status is None
    assert state.parallel_tasks["t1"].state == "complete"
    assert state.parallel_tasks["t2"].state == "complete"
    assert state.budget_state["consumed"]["dispatches"] == 2
    assert state.budget_state["consumed"]["tokens"] == 200


async def test_unbudgeted_flow_unaffected(monkeypatch):
    tasks = [{"id": "t1"}, {"id": "t2"}]
    stubs = [UsageStub(tokens=999999, result="r1"), UsageStub(tokens=999999, result="r2")]
    _install_stubs(monkeypatch, stubs)
    state = FakeFlowState()  # budget_state is None
    ex = _executor(tasks, state, require="all", max_concurrent=2)
    await asyncio.wait_for(ex.run(), timeout=10)

    assert state.terminal_status is None
    assert state.parallel_tasks["t1"].state == "complete"
    assert state.parallel_tasks["t2"].state == "complete"
