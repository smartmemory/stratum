"""STRAT-WORKFLOW-PIPELINE-ROUTE — conditional stage routing (when/exit_when).

Unit tests for the predicate compiler (AST free-name validation over the jail),
plus spec-level validation of the new stage fields.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from types import SimpleNamespace

import stratum_mcp.parallel_exec as parallel_exec_mod
import stratum_mcp.server as server_mod
from stratum_mcp.parallel_exec import ParallelExecutor
from stratum_mcp.executor import compile_predicate, EnsureCompileError, expand_pipeline_tasks
from stratum_mcp.server import _collapse_pipeline_items, _evaluate_parallel_results
from stratum_mcp.errors import IRSemanticError, IRValidationError
from stratum_mcp.spec import parse_and_validate


def _route_spec(stages_yaml: str) -> str:
    return f"""
version: "0.3"
contracts:
  Out: {{v: {{type: string}}}}
functions:
  seed: {{mode: infer, intent: "x", input: {{}}, output: Out}}
flows:
  f:
    input: {{}}
    output: Out
    steps:
      - id: seed
        function: seed
        inputs: {{}}
      - id: pipe
        type: pipeline
        source: "$.steps.seed.output.files"
        require: all
        depends_on: [seed]
{stages_yaml}
"""


def _step(spec, sid="pipe"):
    return {s.id: s for s in spec.flows["f"].steps}[sid]


# --- execution harness (server-dispatched ParallelExecutor) -----------------

@dataclass
class _FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget: Any = None
    budget_state: Any = None


class _DictConnector:
    """Yields a dict result chosen by `behavior(prompt)`; records prompts seen."""
    def __init__(self, behavior, seen):
        self._behavior = behavior
        self._seen = seen

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        self._seen.append(prompt)
        spec = self._behavior(prompt) or {}
        if spec.get("raise"):
            raise RuntimeError(spec["raise"])
        yield {"type": "result", "output": spec.get("result", {"ok": True})}

    def interrupt(self):
        pass


def _route_tasks(stages_yaml: str, items):
    spec = parse_and_validate(_route_spec(stages_yaml))
    return expand_pipeline_tasks(_step(spec), items)


async def _run(monkeypatch, tasks, behavior, require="all"):
    seen: list[str] = []
    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector",
                        lambda *a, **k: _DictConnector(behavior, seen))
    state = _FakeFlowState()
    ex = ParallelExecutor(
        state=state, step_id="pipe", tasks=tasks, max_concurrent=8,
        isolation="none", task_timeout=30, agent=None, intent_template="",
        task_reasoning_template=None, require=require,
        persist_callable=lambda s: None, is_pipeline=True,
    )
    await asyncio.wait_for(ex.run(), timeout=10)
    return state, seen


def _st(state, item, stage):
    return state.parallel_tasks[f"pipe::item{item}::stage{stage}"].state


# --- when: skip a stage -----------------------------------------------------

async def test_when_false_skips_stage_downstream_proceeds(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}"}\n'
        '          - {intent_template: "s1:{prev}", when: "prev_raw[\'label\'] != \'spam\'"}\n',
        ["doc"],
    )

    def behavior(prompt):
        if prompt.startswith("s0:"):
            return {"result": {"label": "spam"}}
        return {"result": {"checked": True}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 0) == "complete"
    assert _st(state, 0, 1) == "skipped"          # when false → skipped
    assert not any(p.startswith("s1:") for p in seen)  # stage 1 never dispatched


async def test_when_true_runs_stage(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}"}\n'
        '          - {intent_template: "s1:{prev}", when: "prev_raw[\'label\'] != \'spam\'"}\n',
        ["doc"],
    )

    def behavior(prompt):
        if prompt.startswith("s0:"):
            return {"result": {"label": "ham"}}
        return {"result": {"checked": True}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 1) == "complete"
    assert any(p.startswith("s1:") for p in seen)


# --- exit_when: early-exit --------------------------------------------------

async def test_exit_when_skips_later_stages(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}", exit_when: "result_raw[\'sure\'] == True"}\n'
        '          - {intent_template: "s1:{prev}"}\n'
        '          - {intent_template: "s2:{prev}"}\n',
        ["doc"],
    )

    def behavior(prompt):
        if prompt.startswith("s0:"):
            return {"result": {"sure": True}}
        return {"result": {"x": 1}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 0) == "complete"
    assert _st(state, 0, 1) == "skipped"
    assert _st(state, 0, 2) == "skipped"
    assert not any(p.startswith("s1:") or p.startswith("s2:") for p in seen)


async def test_exit_when_false_continues(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}", exit_when: "result_raw[\'sure\'] == True"}\n'
        '          - {intent_template: "s1:{prev}"}\n',
        ["doc"],
    )

    def behavior(prompt):
        if prompt.startswith("s0:"):
            return {"result": {"sure": False}}
        return {"result": {"x": 1}}

    state, _ = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 1) == "complete"


async def test_exit_when_only_affects_its_own_item(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}", exit_when: "result_raw[\'stop\'] == True"}\n'
        '          - {intent_template: "s1:{prev}"}\n',
        ["A", "B"],
    )

    def behavior(prompt):
        # only item A (s0:A) signals stop
        if prompt == "s0:A":
            return {"result": {"stop": True}}
        if prompt.startswith("s0:"):
            return {"result": {"stop": False}}
        return {"result": {"x": 1}}

    state, _ = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 1) == "skipped"     # A exited
    assert _st(state, 1, 1) == "complete"    # B ran fully


# --- malformed predicate degradation ----------------------------------------

async def test_malformed_when_fails_open_runs_stage(monkeypatch):
    # prev_raw['missing'] raises KeyError at runtime → fail open → run the stage
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}"}\n'
        '          - {intent_template: "s1:{prev}", when: "prev_raw[\'missing\'] == 1"}\n',
        ["doc"],
    )

    def behavior(prompt):
        return {"result": {"present": 1}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 1) == "complete"            # ran despite the bad predicate
    assert any(p.startswith("s1:") for p in seen)


async def test_malformed_exit_when_fails_closed_continues(monkeypatch):
    tasks = _route_tasks(
        '        stages:\n'
        '          - {intent_template: "s0:{item}", exit_when: "result_raw[\'missing\'] == 1"}\n'
        '          - {intent_template: "s1:{prev}"}\n',
        ["doc"],
    )

    def behavior(prompt):
        return {"result": {"present": 1}}

    state, _ = await _run(monkeypatch, tasks, behavior)
    assert _st(state, 0, 1) == "complete"            # did NOT early-exit on the bad predicate


# --- server aggregation: skipped is settled-non-failure ---------------------

def _fake_step(require="all"):
    return SimpleNamespace(
        step_type="pipeline", id="pipe", source="$.x",
        stages=({"intent_template": "s0:{item}"}, {"intent_template": "s1:{prev}"}),
        require=require, task_reasoning_template=None, agent=None,
    )


def _desugar(step, items):
    return expand_pipeline_tasks(step, items)


def _patch_resolve(monkeypatch, step, items):
    desugared = expand_pipeline_tasks(step, items)
    monkeypatch.setattr(server_mod, "_resolve_dispatch_tasks",
                        lambda state, s: desugared)
    return desugared


def test_collapse_skipped_tail_is_complete():
    step = _fake_step()
    tasks = _desugar(step, ["A"])
    # stage0 complete, stage1 skipped (e.g. when:false or early-exit tail)
    results = [
        {"task_id": "pipe::item0::stage0", "result": {"x": 1}, "status": "complete"},
        {"task_id": "pipe::item0::stage1", "result": {"x": 1}, "status": "skipped"},
    ]
    items = _collapse_pipeline_items(results, {t["id"]: t for t in tasks})
    assert items[0]["status"] == "complete"     # skipped tail ≠ incomplete/failed


def test_evaluate_require_all_satisfied_with_skipped_tail(monkeypatch):
    step = _fake_step(require="all")
    tasks = _patch_resolve(monkeypatch, step, ["A", "B"])
    results = []
    for t in tasks:
        # every item: stage0 complete, stage1 skipped
        status = "skipped" if t["_pipeline_stage"] == 1 else "complete"
        results.append({"task_id": t["id"], "result": {"x": 1}, "status": status})
    can_advance, ev = _evaluate_parallel_results(_FakeFlowState(), step, results)
    assert ev["require_satisfied"] is True
    assert can_advance is True
    # skipped tasks must NOT be counted as failed
    assert len(ev["failed"]) == 0


def test_non_pipeline_skipped_still_counts_as_failed(monkeypatch):
    """Regression guard: routing is pipeline-only. A plain parallel_dispatch task
    reporting status='skipped' must NOT satisfy require:all (it didn't complete)."""
    step = SimpleNamespace(
        step_type="parallel_dispatch", id="par", require="all",
        task_reasoning_template=None, agent=None,
    )
    results = [
        {"task_id": "t0", "result": {}, "status": "complete"},
        {"task_id": "t1", "result": {}, "status": "skipped"},
    ]
    _, ev = _evaluate_parallel_results(_FakeFlowState(), step, results)
    assert ev["require_satisfied"] is False   # skipped ≠ complete on the plain path
    assert len(ev["failed"]) == 1


def test_evaluate_failed_still_fails_with_skips_present(monkeypatch):
    step = _fake_step(require="all")
    tasks = _patch_resolve(monkeypatch, step, ["A"])
    results = [
        {"task_id": "pipe::item0::stage0", "result": {}, "status": "failed"},
        {"task_id": "pipe::item0::stage1", "result": {}, "status": "skipped"},
    ]
    can_advance, ev = _evaluate_parallel_results(_FakeFlowState(), step, results)
    assert ev["require_satisfied"] is False     # a real failure still fails the item
    assert can_advance is False


# --- compile_predicate: binding + jail + AST name validation ----------------

def test_predicate_subscript_access_on_dict():
    p = compile_predicate("item['x'] > 0", {"item"})
    assert p(item={"x": 5}) is True
    assert p(item={"x": -1}) is False


def test_predicate_allows_jail_builtins():
    # _ENSURE_BUILTINS (len, etc.) must be allowed alongside data bindings
    p = compile_predicate("len(item['tags']) > 0", {"item"})
    assert p(item={"tags": ["a"]}) is True
    assert p(item={"tags": []}) is False


def test_predicate_multiple_bindings():
    p = compile_predicate("prev_raw['c'] >= item['threshold']", {"item", "prev", "prev_raw"})
    assert p(item={"threshold": 0.9}, prev="{}", prev_raw={"c": 0.95}) is True
    assert p(item={"threshold": 0.9}, prev="{}", prev_raw={"c": 0.5}) is False


def test_predicate_rejects_disallowed_name_at_compile():
    # prev_raw is not in the allowed set (e.g. a stage-0 `when`)
    with pytest.raises(EnsureCompileError):
        compile_predicate("prev_raw['x'] > 0", {"item"})


def test_predicate_rejects_unknown_name_at_compile():
    with pytest.raises(EnsureCompileError):
        compile_predicate("mystery_var > 0", {"item"})


def test_predicate_rejects_dunder():
    with pytest.raises(EnsureCompileError):
        compile_predicate("item.__class__", {"item"})


def test_predicate_rejects_syntax_error():
    with pytest.raises(EnsureCompileError):
        compile_predicate("item['x' >", {"item"})


def test_predicate_allows_comprehension_target():
    # a comprehension's loop var is locally bound — must not be flagged unknown
    p = compile_predicate("any(t == 'spam' for t in item['tags'])", {"item"})
    assert p(item={"tags": ["ham", "spam"]}) is True
    assert p(item={"tags": ["ham"]}) is False


def test_predicate_returns_bool():
    p = compile_predicate("item['x']", {"item"})
    assert p(item={"x": 1}) is True
    assert p(item={"x": 0}) is False


def test_predicate_exit_when_binds_result():
    p = compile_predicate("result_raw['confidence'] >= 0.95", {"item", "result", "result_raw"})
    assert p(item={}, result="{}", result_raw={"confidence": 0.96}) is True


# --- spec-level: when/exit_when on pipeline stages ---------------------------

def test_valid_when_exit_when_parses():
    spec = parse_and_validate(_route_spec(
        '        stages:\n'
        '          - {intent_template: "classify {item}", exit_when: "result_raw[\'sure\'] == True"}\n'
        '          - {intent_template: "check {prev}", when: "prev_raw[\'label\'] != \'spam\'"}\n'
    ))
    stages = _step(spec).stages
    assert stages[0]["exit_when"] == "result_raw['sure'] == True"
    assert stages[1]["when"] == "prev_raw['label'] != 'spam'"


def test_stage0_when_referencing_prev_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_route_spec(
            '        stages:\n'
            '          - {intent_template: "x {item}", when: "prev_raw[\'k\'] > 0"}\n'
        ))


def test_exit_when_referencing_prev_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_route_spec(
            '        stages:\n'
            '          - {intent_template: "x {item}"}\n'
            '          - {intent_template: "y {prev}", exit_when: "prev_raw[\'k\'] > 0"}\n'
        ))


def test_when_unknown_name_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_route_spec(
            '        stages:\n'
            '          - {intent_template: "x {item}"}\n'
            '          - {intent_template: "y {prev}", when: "mystery > 0"}\n'
        ))


def test_exit_when_on_stage0_referencing_result_ok():
    # stage 0 has no prev, but DOES have a result → exit_when may reference it
    spec = parse_and_validate(_route_spec(
        '        stages:\n'
        '          - {intent_template: "x {item}", exit_when: "result_raw[\'done\'] == True"}\n'
    ))
    assert _step(spec).stages[0]["exit_when"] == "result_raw['done'] == True"


def test_when_non_string_rejected_by_schema():
    with pytest.raises((IRValidationError, IRSemanticError)):
        parse_and_validate(_route_spec(
            '        stages:\n'
            '          - {intent_template: "x {item}"}\n'
            '          - {intent_template: "y {prev}", when: 123}\n'
        ))
