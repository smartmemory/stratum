"""STRAT-WORKFLOW-PIPELINE-FANOUT — bounded data-driven map-reduce.

A split stage emits a list → ≤K parallel lanes (item{i}::stage{j}::lane{k}) → a join
stage reduces survivors. Tests cover: spec-level shape validation (fanout/join markers,
region rules, route-predicate ban in-region), the desugar's lane grid + multi-dep join
edge, the executor runtime (split-output contract, lane fill/skip, {prevs} join binding,
lane-require survivors, len>K / non-list / empty-list edges), and the server collapse +
fanned-out _done rejection.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
import stratum_mcp.server as server_mod
from stratum_mcp.parallel_exec import ParallelExecutor
from stratum_mcp.executor import expand_pipeline_tasks
from stratum_mcp.server import (
    _collapse_pipeline_items,
    stratum_parallel_done,
    stratum_plan,
    stratum_step_done,
)
from stratum_mcp.errors import IRSemanticError, IRValidationError
from stratum_mcp.spec import parse_and_validate


def _fanout_spec(stages_yaml: str) -> str:
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
        source: "$.steps.seed.output.docs"
        require: all
        depends_on: [seed]
{stages_yaml}
"""


def _step(spec, sid="pipe"):
    return {s.id: s for s in spec.flows["f"].steps}[sid]


# A canonical valid map-reduce: split → 1 per-lane → join.
_VALID_STAGES = (
    '        stages:\n'
    '          - {intent_template: "list sections of {item}", fanout: {max: 8, require: any}}\n'
    '          - {intent_template: "summarize {item}"}\n'
    '          - {intent_template: "synthesize {prevs}", join: true}\n'
)


# --- spec-level: fanout/join markers parse ----------------------------------

def test_valid_fanout_join_parses():
    spec = parse_and_validate(_fanout_spec(_VALID_STAGES))
    stages = _step(spec).stages
    assert stages[0]["fanout"] == {"max": 8, "require": "any"}
    assert stages[2]["join"] is True


def test_fanout_require_defaults_or_explicit_int():
    spec = parse_and_validate(_fanout_spec(
        '        stages:\n'
        '          - {intent_template: "split {item}", fanout: {max: 4, require: 2}}\n'
        '          - {intent_template: "map {item}"}\n'
        '          - {intent_template: "reduce {prevs}", join: true}\n'
    ))
    assert _step(spec).stages[0]["fanout"]["require"] == 2


# --- spec-level: region shape validation ------------------------------------

def test_fanout_without_join_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "split {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "map {item}"}\n'
        ))


def test_join_without_fanout_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "a {item}"}\n'
            '          - {intent_template: "reduce {prevs}", join: true}\n'
        ))


def test_two_fanout_stages_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "s2 {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_join_before_fanout_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "m {item}"}\n'
        ))


def test_zero_per_lane_stages_rejected():
    # fanout immediately followed by join → no per-lane stage between them
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_fanout_max_zero_rejected():
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 0, require: all}}\n'
            '          - {intent_template: "m {item}"}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_fanout_require_bad_value_rejected():
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: "most"}}\n'
            '          - {intent_template: "m {item}"}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


# --- spec-level: route predicates banned in the fanout region ---------------

def test_when_on_fanout_stage_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: all}, when: "True"}\n'
            '          - {intent_template: "m {item}"}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_exit_when_on_lane_stage_rejected():
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "s {item}", fanout: {max: 4, require: all}}\n'
            '          - {intent_template: "m {item}", exit_when: "result_raw[\'x\'] == 1"}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_exit_when_on_prefanout_stage_rejected():
    # a pre-fanout `exit_when` would early-exit the item and skip the whole region,
    # which the join would misread as unfilled lanes → banned in v1 (Codex impl-review).
    with pytest.raises(IRSemanticError):
        parse_and_validate(_fanout_spec(
            '        stages:\n'
            '          - {intent_template: "pre {item}", exit_when: "result_raw[\'stop\'] == True"}\n'
            '          - {intent_template: "s {prev}", fanout: {max: 4, require: any}}\n'
            '          - {intent_template: "m {item}"}\n'
            '          - {intent_template: "j {prevs}", join: true}\n'
        ))


def test_when_on_prefanout_stage_still_allowed():
    # a `when` on a stage BEFORE the fanout region is a normal single-chain stage → valid
    spec = parse_and_validate(_fanout_spec(
        '        stages:\n'
        '          - {intent_template: "pre {item}", when: "item[\'ok\'] == True"}\n'
        '          - {intent_template: "s {prev}", fanout: {max: 4, require: all}}\n'
        '          - {intent_template: "m {item}"}\n'
        '          - {intent_template: "j {prevs}", join: true}\n'
    ))
    assert _step(spec).stages[0]["when"] == "item['ok'] == True"


# --- desugar: lane grid + multi-dep join edge -------------------------------

_K3_STAGES = (
    '        stages:\n'
    '          - {intent_template: "split {item}", fanout: {max: 3, require: all}}\n'
    '          - {intent_template: "map {item}"}\n'
    '          - {intent_template: "join {prevs}", join: true}\n'
)


def _fanout_tasks(stages_yaml, items):
    spec = parse_and_validate(_fanout_spec(stages_yaml))
    return expand_pipeline_tasks(_step(spec), items)


def _by_id(tasks):
    return {t["id"]: t for t in tasks}


def test_desugar_materializes_k_lanes_per_perlane_stage():
    tasks = _fanout_tasks(_K3_STAGES, ["A", "B"])
    ids = _by_id(tasks)
    # per item: split (stage0) + 3 lanes (stage1) + join (stage2) = 5 ; 2 items = 10
    assert len(tasks) == 10
    for i in ("0", "1"):
        assert f"pipe::item{i}::stage0" in ids                    # split, per-item
        assert f"pipe::item{i}::stage2" in ids                    # join, per-item
        for k in range(3):
            assert f"pipe::item{i}::stage1::lane{k}" in ids       # per-lane × K


def test_desugar_first_lane_depends_on_split():
    ids = _by_id(_fanout_tasks(_K3_STAGES, ["A"]))
    for k in range(3):
        lane = ids[f"pipe::item0::stage1::lane{k}"]
        assert lane["depends_on"] == ["pipe::item0::stage0"]
        assert lane["_pipeline_role"] == "lane"
        assert lane["_fanout_lane"] == k
        assert lane["_fanout_split_id"] == "pipe::item0::stage0"


def test_desugar_join_depends_on_all_lanes():
    ids = _by_id(_fanout_tasks(_K3_STAGES, ["A"]))
    join = ids["pipe::item0::stage2"]
    assert join["_pipeline_role"] == "join"
    assert sorted(join["depends_on"]) == sorted(
        f"pipe::item0::stage1::lane{k}" for k in range(3)
    )


def test_desugar_split_role_and_dep():
    ids = _by_id(_fanout_tasks(_K3_STAGES, ["A"]))
    split = ids["pipe::item0::stage0"]
    assert split["_pipeline_role"] == "split"
    assert split["depends_on"] == []          # stage 0


def test_desugar_pre_and_post_fanout_are_per_item():
    stages = (
        '        stages:\n'
        '          - {intent_template: "pre {item}"}\n'
        '          - {intent_template: "split {prev}", fanout: {max: 2, require: all}}\n'
        '          - {intent_template: "map {item}"}\n'
        '          - {intent_template: "join {prevs}", join: true}\n'
        '          - {intent_template: "post {prev}"}\n'
    )
    ids = _by_id(_fanout_tasks(stages, ["A"]))
    # pre (stage0) + split (stage1) + 2 lanes (stage2) + join (stage3) + post (stage4)
    assert ids["pipe::item0::stage0"]["_pipeline_role"] == "plain"   # pre-fanout
    assert ids["pipe::item0::stage4"]["_pipeline_role"] == "plain"   # post-join
    assert ids["pipe::item0::stage4"]["depends_on"] == ["pipe::item0::stage3"]  # post chains off join
    assert "pipe::item0::stage2::lane0" in ids and "pipe::item0::stage2::lane1" in ids


def test_desugar_no_fanout_unchanged():
    # a plain pipeline (no fanout/join) desugars to the existing per-item chain
    plain = (
        '        stages:\n'
        '          - {intent_template: "s0 {item}"}\n'
        '          - {intent_template: "s1 {prev}"}\n'
    )
    tasks = _fanout_tasks(plain, ["A", "B"])
    assert {t["id"] for t in tasks} == {
        "pipe::item0::stage0", "pipe::item0::stage1",
        "pipe::item1::stage0", "pipe::item1::stage1",
    }
    # no lane ids, no fanout roles
    assert all("lane" not in t["id"] for t in tasks)


# --- executor runtime harness (server-dispatched ParallelExecutor) ----------

@dataclass
class _FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget: Any = None
    budget_state: Any = None


class _DictConnector:
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


def _lane_state(state, i, j, k):
    return state.parallel_tasks[f"pipe::item{i}::stage{j}::lane{k}"].state


def _task_state(state, i, j):
    return state.parallel_tasks[f"pipe::item{i}::stage{j}"].state


# Canonical runtime stages: split (stage0) → map (stage1) → join (stage2).
def _stages(k, require):
    return (
        '        stages:\n'
        f'          - {{intent_template: "split:{{item}}", fanout: {{max: {k}, require: {require}}}}}\n'
        '          - {intent_template: "map:{item}"}\n'
        '          - {intent_template: "join:{prevs}", join: true}\n'
    )


# --- runtime: lane fill / skip ----------------------------------------------

async def test_lanes_dispatch_per_element_excess_skip(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": ["secA", "secB"]}     # 2 elements, K=3
        return {"result": {"ok": prompt}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 0) == "complete"        # split
    assert _lane_state(state, 0, 1, 0) == "complete"     # filled
    assert _lane_state(state, 0, 1, 1) == "complete"     # filled
    assert _lane_state(state, 0, 1, 2) == "skipped"      # unfilled (k >= len)
    assert _task_state(state, 0, 2) == "complete"        # join ran
    # filled lanes saw their element as {item}
    assert "map:secA" in seen and "map:secB" in seen


async def test_join_receives_surviving_lane_outputs(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": ["a", "b"]}
        if prompt == "map:a":
            return {"result": "SUMMARY_A"}
        if prompt == "map:b":
            return {"result": "SUMMARY_B"}
        return {"result": {"ok": True}}

    state, seen = await _run(monkeypatch, tasks, behavior)
    join_prompt = next(p for p in seen if p.startswith("join:"))
    assert "SUMMARY_A" in join_prompt and "SUMMARY_B" in join_prompt


# --- runtime: lane failure + lane-require -----------------------------------

async def test_lane_failure_require_any_join_runs_over_survivors(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "any"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": ["a", "b"]}
        if prompt == "map:a":
            return {"raise": "boom"}          # lane 0 fails
        if prompt == "map:b":
            return {"result": "OK_B"}
        return {"result": {"ok": True}}

    state, seen = await _run(monkeypatch, tasks, behavior, require="all")
    assert _lane_state(state, 0, 1, 0) == "failed"
    assert _lane_state(state, 0, 1, 1) == "complete"
    assert _task_state(state, 0, 2) == "complete"        # join still ran (require any)
    join_prompt = next(p for p in seen if p.startswith("join:"))
    assert "OK_B" in join_prompt and "boom" not in join_prompt


async def test_lane_failure_require_all_cancels_join_item_fails(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": ["a", "b"]}
        if prompt == "map:a":
            return {"raise": "boom"}
        return {"result": "OK"}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 2) == "cancelled"       # join cancelled (require all)
    assert not any(p.startswith("join:") for p in seen)  # join never dispatched


# --- runtime: split-output contract edges -----------------------------------

async def test_len_exceeds_max_fails_split(monkeypatch):
    tasks = _fanout_tasks(_stages(2, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": ["a", "b", "c"]}   # 3 > K=2
        return {"result": "x"}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 0) == "failed"          # split failed on over-cap
    assert "exceeds" in (state.parallel_tasks["pipe::item0::stage0"].error or "")
    assert not any(p.startswith("map:") for p in seen)   # lanes auto-cancelled


async def test_non_list_split_fails(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": {"not": "a list"}}
        return {"result": "x"}

    state, _ = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 0) == "failed"


async def test_json_string_list_is_parsed(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": '["a", "b"]'}      # JSON-array string
        return {"result": "x"}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 0) == "complete"
    assert _lane_state(state, 0, 1, 0) == "complete"
    assert "map:a" in seen


# --- runtime: empty list ----------------------------------------------------

async def test_empty_list_require_all_join_runs_empty(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "all"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": []}
        return {"result": "x"}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert all(_lane_state(state, 0, 1, k) == "skipped" for k in range(3))
    assert _task_state(state, 0, 2) == "complete"        # require:all over 0 → satisfied
    assert any(p.startswith("join:") for p in seen)


async def test_empty_list_require_any_item_fails(monkeypatch):
    tasks = _fanout_tasks(_stages(3, "any"), ["doc"])

    def behavior(prompt):
        if prompt.startswith("split:"):
            return {"result": []}
        return {"result": "x"}

    state, seen = await _run(monkeypatch, tasks, behavior)
    assert _task_state(state, 0, 2) == "cancelled"       # require:any over 0 → fail
    assert not any(p.startswith("join:") for p in seen)


# --- server: _collapse_pipeline_items reduction (lanes omitted) -------------

def _collapse(stages_yaml, items, results):
    spec = parse_and_validate(_fanout_spec(stages_yaml))
    tasks = expand_pipeline_tasks(_step(spec), items)
    return _collapse_pipeline_items(results, {t["id"]: t for t in tasks})


def test_collapse_fanout_item_complete_lanes_omitted():
    # split complete, 2 lanes complete + 1 skipped, join complete → item complete
    results = [
        {"task_id": "pipe::item0::stage0", "result": ["a", "b"], "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane0", "result": "SA", "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane1", "result": "SB", "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane2", "result": None, "status": "skipped"},
        {"task_id": "pipe::item0::stage2", "result": "REDUCED", "status": "complete"},
    ]
    items = _collapse(_K3_STAGES, ["doc"], results)
    assert items[0]["status"] == "complete"
    assert items[0]["result"] == "REDUCED"                 # join output
    # stages[] = per-item stages only (split, join) — lane stage1 omitted
    assert items[0]["stages"] == [["a", "b"], "REDUCED"]


def test_collapse_join_cancelled_item_failed():
    results = [
        {"task_id": "pipe::item0::stage0", "result": ["a", "b"], "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane0", "result": None, "status": "failed"},
        {"task_id": "pipe::item0::stage1::lane1", "result": "SB", "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane2", "result": None, "status": "skipped"},
        {"task_id": "pipe::item0::stage2", "result": None, "status": "cancelled"},
    ]
    items = _collapse(_K3_STAGES, ["doc"], results)
    assert items[0]["status"] == "failed"                  # join cancelled → item failed


def test_collapse_lane_failure_require_any_item_complete():
    # a failed lane with the join still complete (require:any) → item complete
    results = [
        {"task_id": "pipe::item0::stage0", "result": ["a", "b"], "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane0", "result": None, "status": "failed"},
        {"task_id": "pipe::item0::stage1::lane1", "result": "SB", "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane2", "result": None, "status": "skipped"},
        {"task_id": "pipe::item0::stage2", "result": "R", "status": "complete"},
    ]
    items = _collapse(_stages(3, "any"), ["doc"], results)
    assert items[0]["status"] == "complete"                # lane failure ≠ item failure


def test_collapse_missing_lane_is_incomplete():
    # a lane with no reported result → not settled → incomplete (require-bypass guard)
    results = [
        {"task_id": "pipe::item0::stage0", "result": ["a", "b"], "status": "complete"},
        {"task_id": "pipe::item0::stage1::lane0", "result": "SA", "status": "complete"},
        # lane1 omitted entirely
        {"task_id": "pipe::item0::stage1::lane2", "result": None, "status": "skipped"},
        {"task_id": "pipe::item0::stage2", "result": "R", "status": "complete"},
    ]
    items = _collapse(_K3_STAGES, ["doc"], results)
    assert items[0]["status"] == "incomplete"


# --- server: stratum_parallel_done rejects a fanned-out pipeline ------------

async def test_parallel_done_rejects_fanout_pipeline():
    spec = _fanout_spec(_K3_STAGES)
    planned = await stratum_plan(spec=spec, flow="f", inputs={}, ctx=None)
    flow_id = planned["flow_id"]
    # complete the seed step so the pipeline becomes current
    await stratum_step_done(flow_id, "seed", {"docs": ["d1", "d2"]}, ctx=None)
    resp = await stratum_parallel_done(
        flow_id=flow_id, step_id="pipe",
        task_results=[{"task_id": "pipe::item0::stage0", "result": [], "status": "complete"}],
        merge_status="clean", ctx=None,
    )
    assert resp["status"] == "error"
    assert "fanout" in (resp.get("message", "").lower() + resp.get("error_type", "").lower())
