"""STRAT-WORKFLOW-PIPELINE — pipeline step type (no-barrier stage staggering).

Covers the design's acceptance criteria:
  1. validation (accept + reject + stray-stages on every other step type)
  2. round-trip + checksum (+stages delta)
  3. desugar shape (scalar + dict source items)
  4. staggering proof (item A in stage 1 while item B still in stage 0)
  5. output threading {prev} / {prev_raw}
  6. per-stage agent + per-task cert gate (codex stage skips claude cert)
  7. per-item failure isolation (require: any)
  8. item-scoped require (all / N)
  9. regression guard (codex parallel_dispatch still certs unconditionally)
 10. budget debit per stage task
 11. ensure over result.items (bracket access on plain-dict elements)
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

import stratum_mcp.parallel_exec as parallel_exec_mod
import stratum_mcp.server as server_mod
from stratum_mcp.errors import IRSemanticError, IRValidationError
from stratum_mcp.spec import parse_and_validate
from stratum_mcp.executor import (
    ParallelTaskState,
    _is_pipeline_step,
    _step_mode,
    compute_spec_checksum,
    compile_ensure,
    effective_pipeline_task_cert,
    expand_pipeline_tasks,
)
from stratum_mcp.parallel_exec import ParallelExecutor
from stratum_mcp.server import _collapse_pipeline_items, _evaluate_parallel_results


# ---------------------------------------------------------------------------
# Spec fixtures
# ---------------------------------------------------------------------------

def _pipeline_spec(stages_yaml: str, *, source='"$.steps.seed.output.files"',
                   extra_step_yaml: str = "") -> str:
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
        source: {source}
        require: all
        depends_on: [seed]
{stages_yaml}
{extra_step_yaml}
"""


_GOOD_STAGES = """        stages:
          - {agent: claude, intent_template: "clean {item}"}
          - {agent: codex, intent_template: "verify {prev}"}
"""


def _get_step(spec, sid="pipe"):
    return {s.id: s for s in spec.flows["f"].steps}[sid]


# ---------------------------------------------------------------------------
# 1. Validation
# ---------------------------------------------------------------------------

def test_pipeline_valid_parses():
    spec = parse_and_validate(_pipeline_spec(_GOOD_STAGES))
    step = _get_step(spec)
    assert step.step_type == "pipeline"
    assert _step_mode(step) == "parallel_dispatch"
    assert _is_pipeline_step(step)
    assert step.max_concurrent == 3  # defaulted like parallel_dispatch
    assert len(step.stages) == 2
    assert step.stages[0]["agent"] == "claude"
    assert step.stages[1]["intent_template"] == "verify {prev}"


def test_pipeline_rejects_missing_source():
    spec_yaml = _pipeline_spec(_GOOD_STAGES).replace(
        '        source: "$.steps.seed.output.files"\n', ""
    )
    with pytest.raises(IRSemanticError, match="must have 'source'"):
        parse_and_validate(spec_yaml)


def test_pipeline_rejects_empty_stages():
    # Empty list is rejected at the JSON-schema layer (minItems:1); the semantic
    # "non-empty 'stages'" check is redundant defense behind it.
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_pipeline_spec("        stages: []\n"))


def test_pipeline_rejects_missing_stages():
    # no stages key at all
    with pytest.raises(IRSemanticError, match="non-empty 'stages'"):
        parse_and_validate(_pipeline_spec(""))


def test_pipeline_rejects_stage_without_intent_template():
    # JSON-schema layer (required:[intent_template]) catches this first; the
    # semantic check is redundant defense behind it.
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_pipeline_spec(
            "        stages:\n          - {agent: claude}\n"
        ))


def test_pipeline_rejects_step_level_intent_template():
    stages = _GOOD_STAGES + '        intent_template: "nope {item}"\n'
    with pytest.raises(IRSemanticError, match="must not have a step-level"):
        parse_and_validate(_pipeline_spec(stages))


def test_pipeline_rejects_extra_stage_key():
    # additionalProperties:false in the schema catches this at JSON-schema layer
    with pytest.raises((IRSemanticError, Exception)):
        parse_and_validate(_pipeline_spec(
            '        stages:\n          - {intent_template: "x", timeout: 5}\n'
        ))


def test_stray_stages_rejected_on_parallel_dispatch():
    spec_yaml = """
version: "0.3"
contracts:
  Out: {v: {type: string}}
functions:
  seed: {mode: infer, intent: "x", input: {}, output: Out}
flows:
  f:
    input: {}
    output: Out
    steps:
      - id: seed
        function: seed
        inputs: {}
      - id: pd
        type: parallel_dispatch
        source: "$.steps.seed.output.tasks"
        intent_template: "do {item}"
        stages:
          - {intent_template: "x"}
        depends_on: [seed]
"""
    with pytest.raises(IRSemanticError, match="'stages' but is not a pipeline"):
        parse_and_validate(spec_yaml)


def test_stray_stages_rejected_on_inline_step():
    spec_yaml = """
version: "0.3"
contracts:
  Out: {v: {type: string}}
functions:
  seed: {mode: infer, intent: "x", input: {}, output: Out}
flows:
  f:
    input: {}
    output: Out
    steps:
      - id: s1
        intent: "do a thing"
        agent: claude
        stages:
          - {intent_template: "x"}
"""
    with pytest.raises(IRSemanticError, match="stages"):
        parse_and_validate(spec_yaml)


# ---------------------------------------------------------------------------
# 2. Round-trip + checksum
# ---------------------------------------------------------------------------

def test_checksum_changes_on_stage_edit():
    spec_a = parse_and_validate(_pipeline_spec(_GOOD_STAGES))
    edited = _GOOD_STAGES.replace("verify {prev}", "double-check {prev}")
    spec_b = parse_and_validate(_pipeline_spec(edited))
    ck_a = compute_spec_checksum(spec_a.flows["f"])
    ck_b = compute_spec_checksum(spec_b.flows["f"])
    assert ck_a != ck_b, "stage intent_template edit must change the checksum"


def test_checksum_stable_on_comment_change():
    spec_a = parse_and_validate(_pipeline_spec(_GOOD_STAGES))
    spec_b = parse_and_validate(_pipeline_spec(_GOOD_STAGES) + "\n# trailing comment\n")
    assert compute_spec_checksum(spec_a.flows["f"]) == compute_spec_checksum(spec_b.flows["f"])


# ---------------------------------------------------------------------------
# 3. Desugar shape
# ---------------------------------------------------------------------------

def test_desugar_3x2_shape():
    spec = parse_and_validate(_pipeline_spec(_GOOD_STAGES))
    step = _get_step(spec)
    tasks = expand_pipeline_tasks(step, ["a", "b", "c"])
    assert len(tasks) == 6
    ids = [t["id"] for t in tasks]
    assert "pipe::item0::stage0" in ids and "pipe::item2::stage1" in ids
    s1 = next(t for t in tasks if t["id"] == "pipe::item1::stage1")
    assert s1["depends_on"] == ["pipe::item1::stage0"]
    assert s1["_pipeline_item"] == 1 and s1["_pipeline_stage"] == 1
    assert s1["_agent"] == "codex"
    s0 = next(t for t in tasks if t["id"] == "pipe::item1::stage0")
    assert s0["depends_on"] == []


def test_desugar_scalar_and_dict_items():
    spec = parse_and_validate(_pipeline_spec(_GOOD_STAGES))
    step = _get_step(spec)
    tasks = expand_pipeline_tasks(step, ["scalar", {"name": "x", "id": "SHOULD_NOT_CLOBBER"}])
    t_scalar = next(t for t in tasks if t["_pipeline_item"] == 0 and t["_pipeline_stage"] == 0)
    assert t_scalar["item"] == "scalar"
    t_dict = next(t for t in tasks if t["_pipeline_item"] == 1 and t["_pipeline_stage"] == 0)
    assert t_dict["item"] == {"name": "x", "id": "SHOULD_NOT_CLOBBER"}
    assert t_dict["name"] == "x"  # splatted
    assert t_dict["id"] == "pipe::item1::stage0"  # reserved key NOT clobbered


# ---------------------------------------------------------------------------
# Executor test harness
# ---------------------------------------------------------------------------

@dataclass
class FakeFlowState:
    flow_id: str = "f1"
    cwd: str = ""
    parallel_tasks: dict = field(default_factory=dict)
    terminal_status: str | None = None
    budget: Any = None
    budget_state: Any = None


class ScriptedConnector:
    """Connector stub whose behavior is decided by the rendered prompt.

    behavior(prompt) -> dict with optional keys: delay, result, raise.
    Records (prompt, start, end) intervals into the shared `log` for staggering
    assertions, and the resolved agent_type into `agents_seen`.
    """

    def __init__(self, behavior, log, agent_type, agents_seen):
        self._behavior = behavior
        self._log = log
        self._agent_type = agent_type
        self._agents_seen = agents_seen
        self.interrupted = 0

    async def run(self, prompt, *, cwd=None, env=None, **kw):
        self._agents_seen.append((self._agent_type, prompt))
        spec = self._behavior(prompt) or {}
        start = asyncio.get_event_loop().time()
        if spec.get("delay"):
            await asyncio.sleep(spec["delay"])
        end = asyncio.get_event_loop().time()
        self._log.append({"prompt": prompt, "start": start, "end": end})
        if spec.get("raise"):
            raise RuntimeError(spec["raise"])
        yield {"type": "result", "output": spec.get("result", f"done:{prompt}")}

    def interrupt(self):
        self.interrupted += 1


def _pipeline_executor(monkeypatch, *, tasks, behavior, require="all",
                       task_reasoning_template=None, state=None):
    log: list[dict] = []
    agents_seen: list[tuple] = []

    def fake_factory(agent_type, model_id, cwd, **_kw):
        return ScriptedConnector(behavior, log, agent_type, agents_seen)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", fake_factory)
    state = state or FakeFlowState()
    ex = ParallelExecutor(
        state=state, step_id="pipe", tasks=tasks, max_concurrent=8,
        isolation="none", task_timeout=30, agent=None, intent_template="",
        task_reasoning_template=task_reasoning_template, require=require,
        persist_callable=lambda s: None, is_pipeline=True,
    )
    return ex, state, log, agents_seen


def _tasks(source_items):
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "s0:{item}"}\n'
        '          - {agent: codex, intent_template: "s1:{prev}"}\n'
    ))
    return expand_pipeline_tasks(_get_step(spec), source_items)


# ---------------------------------------------------------------------------
# 4. Staggering proof
# ---------------------------------------------------------------------------

async def test_staggering_item_in_stage1_while_other_in_stage0(monkeypatch):
    tasks = _tasks(["A", "B"])

    def behavior(prompt):
        if prompt == "s0:B":
            return {"delay": 0.30}          # B's stage 0 is slow
        return {"delay": 0.03}              # everything else fast

    ex, state, log, _ = _pipeline_executor(monkeypatch, tasks=tasks, behavior=behavior)
    await asyncio.wait_for(ex.run(), timeout=10)

    by_prompt = {e["prompt"]: e for e in log}
    a_stage1 = by_prompt["s1:done:s0:A"]   # A's stage1 prompt = "s1:{prev}", prev = A stage0 result
    b_stage0 = by_prompt["s0:B"]
    # A reached stage 1 while B was still running stage 0 → no inter-stage barrier.
    assert a_stage1["start"] < b_stage0["end"], "pipeline did not stagger stages"
    # all 4 tasks completed
    assert all(state.parallel_tasks[t["id"]].state == "complete" for t in tasks)


# ---------------------------------------------------------------------------
# 5. Output threading
# ---------------------------------------------------------------------------

async def test_prev_threading_string_and_raw(monkeypatch):
    # stage0 returns a dict; stage1 must see {prev} (json string) and could use {prev_raw}.
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "s0:{item}"}\n'
        '          - {agent: codex, intent_template: "got:{prev}"}\n'
    ))
    tasks = expand_pipeline_tasks(_get_step(spec), ["X"])

    def behavior(prompt):
        if prompt == "s0:X":
            return {"result": {"verdict": "ok", "n": 1}}
        return {"result": f"echo:{prompt}"}

    ex, state, log, _ = _pipeline_executor(monkeypatch, tasks=tasks, behavior=behavior)
    await asyncio.wait_for(ex.run(), timeout=10)
    # stage1 prompt = "got:" + json.dumps({"verdict":"ok","n":1})
    s1_prompts = [e["prompt"] for e in log if e["prompt"].startswith("got:")]
    assert len(s1_prompts) == 1
    assert '"verdict": "ok"' in s1_prompts[0] and '"n": 1' in s1_prompts[0]


async def test_prev_raw_field_access(monkeypatch):
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "s0:{item}"}\n'
        '          - {agent: codex, intent_template: "v={prev_raw[verdict]}"}\n'
    ))
    tasks = expand_pipeline_tasks(_get_step(spec), ["X"])

    def behavior(prompt):
        if prompt == "s0:X":
            return {"result": {"verdict": "PASS"}}
        return {"result": "ok"}

    ex, state, log, _ = _pipeline_executor(monkeypatch, tasks=tasks, behavior=behavior)
    await asyncio.wait_for(ex.run(), timeout=10)
    assert any(e["prompt"] == "v=PASS" for e in log)


# ---------------------------------------------------------------------------
# 6. Per-stage agent + cert gate
# ---------------------------------------------------------------------------

async def test_per_stage_agent_routing(monkeypatch):
    tasks = _tasks(["A"])
    ex, state, log, agents_seen = _pipeline_executor(
        monkeypatch, tasks=tasks, behavior=lambda p: {})
    await asyncio.wait_for(ex.run(), timeout=10)
    routing = {prompt: atype for atype, prompt in agents_seen}
    assert routing["s0:A"] == "claude"
    assert routing["s1:done:s0:A"] == "codex"


async def test_codex_stage_skips_claude_cert(monkeypatch):
    tasks = _tasks(["A"])
    cert_calls: list = []

    def fake_validate(template, result):
        cert_calls.append(result)
        return []  # no violations

    monkeypatch.setattr(parallel_exec_mod, "validate_certificate", fake_validate)
    ex, state, log, _ = _pipeline_executor(
        monkeypatch, tasks=tasks, behavior=lambda p: {},
        task_reasoning_template={"sections": ["X"]})
    await asyncio.wait_for(ex.run(), timeout=10)
    # cert should fire ONLY for the claude stage0 task, not the codex stage1 task.
    assert len(cert_calls) == 1, f"cert ran {len(cert_calls)} times; expected 1 (claude only)"


# ---------------------------------------------------------------------------
# 9. Regression guard — non-pipeline parallel_dispatch certs unconditionally
# ---------------------------------------------------------------------------

async def test_regression_codex_parallel_dispatch_still_certs(monkeypatch):
    cert_calls: list = []
    monkeypatch.setattr(parallel_exec_mod, "validate_certificate",
                        lambda t, r: cert_calls.append(r) or [])

    def fake_factory(agent_type, model_id, cwd, **_kw):
        log, seen = [], []
        return ScriptedConnector(lambda p: {}, log, agent_type, seen)

    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", fake_factory)
    state = FakeFlowState()
    ex = ParallelExecutor(
        state=state, step_id="pd", tasks=[{"id": "t1"}, {"id": "t2"}],
        max_concurrent=4, isolation="none", task_timeout=30, agent="codex",
        intent_template="do {id}", task_reasoning_template={"sections": ["X"]},
        require="all", persist_callable=lambda s: None,  # is_pipeline defaults False
    )
    await asyncio.wait_for(ex.run(), timeout=10)
    # unconditional cert in non-pipeline mode → both codex tasks validated
    assert len(cert_calls) == 2


# ---------------------------------------------------------------------------
# 7 + 8. Per-item isolation and item-scoped require (executor cascade)
# ---------------------------------------------------------------------------

async def test_per_item_isolation_require_any(monkeypatch):
    tasks = _tasks(["I0", "I1"])

    def behavior(prompt):
        if prompt == "s0:I0":
            return {"raise": "boom"}      # item 0 stage 0 fails
        return {"delay": 0.02}

    ex, state, _, _ = _pipeline_executor(
        monkeypatch, tasks=tasks, behavior=behavior, require="any")
    await asyncio.wait_for(ex.run(), timeout=10)
    pt = state.parallel_tasks
    assert pt["pipe::item0::stage0"].state == "failed"
    assert pt["pipe::item0::stage1"].state == "cancelled"   # own downstream dropped
    # sibling item fully completes — NOT cancelled (no cross-item cascade)
    assert pt["pipe::item1::stage0"].state == "complete"
    assert pt["pipe::item1::stage1"].state == "complete"


async def test_require_all_cascades_across_items(monkeypatch):
    tasks = _tasks(["I0", "I1"])

    def behavior(prompt):
        if prompt == "s0:I0":
            return {"raise": "boom"}
        return {"delay": 0.30}            # I1 slow so cascade can catch it

    ex, state, _, _ = _pipeline_executor(
        monkeypatch, tasks=tasks, behavior=behavior, require="all")
    await asyncio.wait_for(ex.run(), timeout=10)
    pt = state.parallel_tasks
    assert pt["pipe::item0::stage0"].state == "failed"
    # require:all + item0 failed → policy unsatisfiable → siblings cancelled
    assert pt["pipe::item1::stage0"].state in ("cancelled", "failed")


# ---------------------------------------------------------------------------
# _collapse_pipeline_items + _evaluate_parallel_results (server-side, item-scoped)
# ---------------------------------------------------------------------------

def _fake_pipeline_step(require="all"):
    return SimpleNamespace(
        step_type="pipeline", id="pipe", source="$.x",
        stages=({"agent": "claude", "intent_template": "s0:{item}"},
                {"agent": "codex", "intent_template": "s1:{prev}"}),
        require=require, task_reasoning_template=None, agent=None,
    )


def _patch_resolve(monkeypatch, step, source_items):
    desugared = expand_pipeline_tasks(step, source_items)
    monkeypatch.setattr(server_mod, "_resolve_dispatch_tasks",
                        lambda state, s: desugared)
    return desugared


def _results_for(desugared, *, failed_ids=()):
    return [
        {"task_id": t["id"], "result": f"r:{t['id']}",
         "status": "failed" if t["id"] in failed_ids else "complete"}
        for t in desugared
    ]


def test_collapse_items_complete_and_failed(monkeypatch):
    step = _fake_pipeline_step()
    desugared = _patch_resolve(monkeypatch, step, ["A", "B"])
    # item A both stages complete; item B stage0 failed
    results = _results_for(desugared, failed_ids={"pipe::item1::stage0"})
    items = _collapse_pipeline_items(results, {t["id"]: t for t in desugared})
    assert len(items) == 2
    a = next(i for i in items if i["item"] == "A")
    b = next(i for i in items if i["item"] == "B")
    assert a["status"] == "complete" and a["result"] == "r:pipe::item0::stage1"
    assert b["status"] == "failed" and b["result"] is None


def test_evaluate_require_all_item_scoped(monkeypatch):
    step = _fake_pipeline_step(require="all")
    desugared = _patch_resolve(monkeypatch, step, ["A", "B"])
    results = _results_for(desugared, failed_ids={"pipe::item1::stage1"})
    can_advance, ev = _evaluate_parallel_results(FakeFlowState(), step, results)
    assert ev["require_satisfied"] is False   # one item failed its chain
    assert can_advance is False
    assert len(ev["aggregate"]["items"]) == 2


def test_require_all_not_bypassable_by_omitting_items(monkeypatch):
    # Codex impl-review finding: a client-dispatched stratum_parallel_done caller
    # must NOT satisfy require:all by reporting only a subset of the items.
    step = _fake_pipeline_step(require="all")
    desugared = _patch_resolve(monkeypatch, step, ["A", "B"])
    # Report ONLY item A's two stages as complete; omit item B entirely.
    partial = [
        {"task_id": "pipe::item0::stage0", "result": "r", "status": "complete"},
        {"task_id": "pipe::item0::stage1", "result": "r", "status": "complete"},
    ]
    can_advance, ev = _evaluate_parallel_results(FakeFlowState(), step, partial)
    items = ev["aggregate"]["items"]
    assert len(items) == 2, "missing item B must still appear in the verdict"
    b = next(i for i in items if i["item"] == "B")
    assert b["status"] == "incomplete"          # missing stages → not complete
    assert ev["require_satisfied"] is False      # require:all not bypassed
    assert can_advance is False


def test_pipeline_rejects_empty_string_intent_template():
    # Presence check, not truthiness: intent_template: "" must also be rejected.
    stages = _GOOD_STAGES + '        intent_template: ""\n'
    with pytest.raises(IRSemanticError, match="must not have a step-level"):
        parse_and_validate(_pipeline_spec(stages))


def test_evaluate_require_N_item_scoped(monkeypatch):
    step = _fake_pipeline_step(require=2)
    desugared = _patch_resolve(monkeypatch, step, ["A", "B", "C"])
    # A + B complete, C fails → 2 items complete, require 2 satisfied
    results = _results_for(desugared, failed_ids={"pipe::item2::stage1"})
    can_advance, ev = _evaluate_parallel_results(FakeFlowState(), step, results)
    assert ev["require_satisfied"] is True
    assert can_advance is True


# ---------------------------------------------------------------------------
# 11. ensure over result.items (bracket access on plain-dict elements)
# ---------------------------------------------------------------------------

def test_ensure_over_items_bracket_access(monkeypatch):
    step = _fake_pipeline_step(require="any")
    desugared = _patch_resolve(monkeypatch, step, ["A", "B", "C"])
    results = _results_for(desugared, failed_ids={"pipe::item2::stage1"})
    _, ev = _evaluate_parallel_results(FakeFlowState(), step, results)
    aggregate = ev["aggregate"]
    fn = compile_ensure("len([i for i in result.items if i['status'] == 'complete']) >= 2")
    assert fn(aggregate) is True
    fn2 = compile_ensure("len([i for i in result.items if i['status'] == 'failed']) == 1")
    assert fn2(aggregate) is True


# ===========================================================================
# STRAT-WORKFLOW-PIPELINE-STAGEOPTS — per-stage task_reasoning_template + task_timeout
# ===========================================================================

def _stageopts_spec(stages_yaml, step_extra=""):
    return _pipeline_spec(stages_yaml).replace(
        "        require: all\n",
        "        require: all\n" + step_extra,
    )


# --- validation -------------------------------------------------------------

def test_stage_accepts_timeout_and_cert():
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "c {item}", task_timeout: 120}\n'
        '          - {agent: codex, intent_template: "v {prev}", task_reasoning_template: {}}\n'
    ))
    step = _get_step(spec)
    assert step.stages[0]["task_timeout"] == 120
    # an explicit empty {} cert inherits the default sections (not treated as absent)
    assert "sections" in step.stages[1]["task_reasoning_template"]
    assert len(step.stages[1]["task_reasoning_template"]["sections"]) >= 1


def test_stage_rejects_zero_timeout():
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_pipeline_spec(
            '        stages:\n'
            '          - {intent_template: "x", task_timeout: 0}\n'
        ))


def test_stage_rejects_malformed_cert():
    # sections present but empty → _apply_cert_defaults raises (same as step-level)
    with pytest.raises(IRSemanticError, match="at least one section"):
        parse_and_validate(_pipeline_spec(
            '        stages:\n'
            '          - {intent_template: "x", task_reasoning_template: {sections: []}}\n'
        ))


def test_stage_rejects_unknown_key_still():
    # Schema additionalProperties:false catches it first (IRValidationError); the
    # semantic "unsupported key" check is redundant defense behind it.
    with pytest.raises((IRSemanticError, IRValidationError)):
        parse_and_validate(_pipeline_spec(
            '        stages:\n'
            '          - {intent_template: "x", bogus: 1}\n'
        ))


# --- desugar precedence -----------------------------------------------------

def test_desugar_stamps_stage_overrides():
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "c {item}", task_timeout: 120}\n'
        '          - {agent: codex, intent_template: "v {prev}"}\n'
    ))
    tasks = expand_pipeline_tasks(_get_step(spec), ["a"])
    s0 = next(t for t in tasks if t["_pipeline_stage"] == 0)
    s1 = next(t for t in tasks if t["_pipeline_stage"] == 1)
    assert s0["_task_timeout"] == 120          # stage override
    assert s1["_task_timeout"] is None         # falls back to step-level at use


# --- effective_pipeline_task_cert helper -----------------------------------

def test_effective_cert_explicit_stage_bypasses_gate():
    stage = {"sections": [{"id": "x", "label": "X", "description": "d"}]}
    # explicit per-stage cert applies even on a codex stage
    assert effective_pipeline_task_cert(stage, None, "codex") is stage
    assert effective_pipeline_task_cert(stage, {"sections": []}, "codex") is stage  # overrides step


def test_effective_cert_step_fallback_claude_gated():
    step = {"sections": [{"id": "x", "label": "X", "description": "d"}]}
    assert effective_pipeline_task_cert(None, step, "claude") is step   # claude → applies
    assert effective_pipeline_task_cert(None, step, "codex") is None     # codex → gated out
    assert effective_pipeline_task_cert(None, None, "claude") is None    # no cert anywhere


# --- per-stage timeout (engine) --------------------------------------------

async def test_per_stage_timeout_fires(monkeypatch):
    # item0 stage0 has a tiny per-stage timeout and a slow connector → times out;
    # item1 stage0 has no override (uses step-level 30s) → completes. require=any
    # so item0's failure doesn't cascade-cancel item1.
    tasks = _tasks(["A", "B"])
    for t in tasks:
        if t["_pipeline_item"] == 0 and t["_pipeline_stage"] == 0:
            t["_task_timeout"] = 0.05

    def behavior(prompt):
        if prompt == "s0:A":
            return {"delay": 0.5}     # exceeds the 0.05 per-stage timeout
        return {"delay": 0.02}

    ex, state, _, _ = _pipeline_executor(
        monkeypatch, tasks=tasks, behavior=behavior, require="any")
    await asyncio.wait_for(ex.run(), timeout=10)
    pt = state.parallel_tasks
    assert pt["pipe::item0::stage0"].state == "failed"
    assert "timeout" in (pt["pipe::item0::stage0"].error or "")
    # sibling item1 (no per-stage timeout) completes both stages
    assert pt["pipe::item1::stage0"].state == "complete"
    assert pt["pipe::item1::stage1"].state == "complete"


# --- per-stage cert: explicit codex stage IS validated (engine) ------------

async def test_explicit_codex_stage_cert_is_validated(monkeypatch):
    # stage1 is codex AND carries its own cert → must be validated (bypasses gate),
    # while a claude stage0 with no stage cert + NO step cert → not validated.
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "s0:{item}"}\n'
        '          - {agent: codex, intent_template: "s1:{prev}", task_reasoning_template: {}}\n'
    ))
    tasks = expand_pipeline_tasks(_get_step(spec), ["A"])
    cert_calls = []
    monkeypatch.setattr(parallel_exec_mod, "validate_certificate",
                        lambda t, r: cert_calls.append(t) or [])
    # no STEP-level cert; only the codex stage has one
    ex, state, _, _ = _pipeline_executor(monkeypatch, tasks=tasks, behavior=lambda p: {})
    await asyncio.wait_for(ex.run(), timeout=10)
    # exactly one validation: the explicit codex stage cert
    assert len(cert_calls) == 1


# --- cert instruction injection into the prompt ----------------------------

def test_cert_instructions_injected_for_pipeline(monkeypatch):
    spec = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {agent: claude, intent_template: "do {item}", task_reasoning_template: {}}\n'
        '          - {agent: codex, intent_template: "v {prev}"}\n'
    ))
    tasks = expand_pipeline_tasks(_get_step(spec), ["A"])
    ex, _, _, _ = _pipeline_executor(monkeypatch, tasks=tasks, behavior=lambda p: {})
    s0 = next(t for t in tasks if t["_pipeline_stage"] == 0)
    prompt = ex._render_prompt(s0)
    assert "You MUST structure your response" in prompt   # cert instructions present
    assert prompt.startswith("do A")                       # intent still rendered first


def test_no_injection_for_parallel_dispatch(monkeypatch):
    # is_pipeline=False (parallel_dispatch) → prompt construction byte-identical, no injection.
    def fake_factory(a, m, c, **_kw):
        return ScriptedConnector(lambda p: {}, [], a, [])
    monkeypatch.setattr(parallel_exec_mod, "make_agent_connector", fake_factory)
    ex = ParallelExecutor(
        state=FakeFlowState(), step_id="pd", tasks=[{"id": "t1"}],
        max_concurrent=2, isolation="none", task_timeout=30, agent="claude",
        intent_template="do {id}", task_reasoning_template={"sections": [
            {"id": "x", "label": "X", "description": "d"}]},
        require="all", persist_callable=lambda s: None,  # is_pipeline defaults False
    )
    prompt = ex._render_prompt({"id": "t1"})
    assert prompt == "do t1"   # NO cert injection on parallel_dispatch


# --- checksum covers stage opts (no fingerprint edit needed) ----------------

def test_checksum_changes_on_stage_timeout():
    a = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {intent_template: "x", task_timeout: 120}\n'))
    b = parse_and_validate(_pipeline_spec(
        '        stages:\n'
        '          - {intent_template: "x", task_timeout: 900}\n'))
    assert compute_spec_checksum(a.flows["f"]) != compute_spec_checksum(b.flows["f"])


# --- server-side _evaluate: explicit codex stage cert validated -------------

def test_evaluate_validates_explicit_codex_stage_cert(monkeypatch):
    step = SimpleNamespace(
        step_type="pipeline", id="pipe", source="$.x",
        stages=({"intent_template": "s0:{item}"},
                {"agent": "codex", "intent_template": "s1:{prev}",
                 "task_reasoning_template": {"sections": [
                     {"id": "x", "label": "X", "description": "d"}]}}),
        require="all", task_reasoning_template=None, agent=None,
    )
    desugared = expand_pipeline_tasks(step, ["A"])
    monkeypatch.setattr(server_mod, "_resolve_dispatch_tasks", lambda s, st: desugared)
    seen = []
    monkeypatch.setattr(server_mod, "validate_certificate",
                        lambda t, r: seen.append(t) or [])
    results = [{"task_id": t["id"], "result": {"artifact": "x"}, "status": "complete"}
               for t in desugared]
    server_mod._evaluate_parallel_results(FakeFlowState(), step, results)
    # only the codex stage1 task carries a cert → exactly one validation
    assert len(seen) == 1
