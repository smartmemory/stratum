"""COMP-PAR-MERGE-QUEUE — per-task pre-merge gate + structured bounce records.

Covers the Stratum side of the feature:
  - S2: pre_merge_verify resolution (literal list / $.input ref / bare string)
  - S3: worktree gate execution + node_modules symlink + gate_bounce records
  - S4: gate bounces surfaced server-side + widened parallel_advance channel

The Compose side (build.js conflict bounce, retry-prompt injection, gsd wiring)
is tested in compose/test/.
"""
from __future__ import annotations

import os
import subprocess
from types import SimpleNamespace

import pytest

from stratum_mcp.server import _resolve_pre_merge_verify


# ---------------------------------------------------------------------------
# S2 — pre_merge_verify resolution
# ---------------------------------------------------------------------------

def _fake_state(inputs=None, step_outputs=None):
    return SimpleNamespace(inputs=inputs or {}, step_outputs=step_outputs or {})


def _step(pmv):
    return SimpleNamespace(pre_merge_verify=pmv)


def test_resolve_literal_list():
    out = _resolve_pre_merge_verify(_fake_state(), _step(["pnpm lint", "pnpm build"]))
    assert out == ["pnpm lint", "pnpm build"]


def test_resolve_jsonpath_input_ref():
    """$.input.pre_merge_gate resolves to the flow-input list (test 3)."""
    st = _fake_state(inputs={"pre_merge_gate": ["pnpm lint", "pnpm build"]})
    out = _resolve_pre_merge_verify(st, _step("$.input.pre_merge_gate"))
    assert out == ["pnpm lint", "pnpm build"]


def test_resolve_none_is_empty_list():
    """Absent gate => [] (byte-identical no-gate behavior, test 4 precondition)."""
    assert _resolve_pre_merge_verify(_fake_state(), _step(None)) == []


def test_resolve_bare_string_is_single_command():
    assert _resolve_pre_merge_verify(_fake_state(), _step("pnpm build")) == ["pnpm build"]


def test_resolve_filters_non_strings_and_blanks():
    st = _fake_state(inputs={"pre_merge_gate": ["pnpm lint", "", "  ", 5, None]})
    out = _resolve_pre_merge_verify(st, _step("$.input.pre_merge_gate"))
    assert out == ["pnpm lint"]


# ---------------------------------------------------------------------------
# S3 — worktree gate runner (run_pre_merge_gate)
# ---------------------------------------------------------------------------

from stratum_mcp.worktree import run_pre_merge_gate, _symlink_node_modules  # noqa: E402


def test_gate_all_pass_returns_none(tmp_path):
    """Every command exiting zero => None (proceed to diff capture, test 1)."""
    assert run_pre_merge_gate(tmp_path, ["git --version"], timeout=30) is None


def test_gate_empty_commands_returns_none(tmp_path):
    assert run_pre_merge_gate(tmp_path, [], timeout=30) is None


def test_gate_first_failure_returns_bounce(tmp_path):
    """First non-zero command => structured gate_failed bounce (test 2)."""
    bounce = run_pre_merge_gate(
        tmp_path,
        ["git --version", "sh -c 'echo boom >&2; exit 3'"],
        timeout=30,
    )
    assert bounce is not None
    assert bounce["reason"] == "gate_failed"
    assert bounce["command"] == "sh -c 'echo boom >&2; exit 3'"
    assert bounce["exit_code"] == 3
    assert "boom" in bounce["excerpt"]
    assert isinstance(bounce["files"], list)


def test_gate_command_not_found_bounces_127(tmp_path):
    bounce = run_pre_merge_gate(
        tmp_path, ["definitely_not_a_real_binary_xyz"], timeout=30
    )
    assert bounce is not None
    assert bounce["exit_code"] == 127
    assert "not found" in bounce["excerpt"].lower()


def test_gate_excerpt_is_bounded(tmp_path):
    """Excerpt is bounded (~2KB tail) to avoid prompt bloat / secret spray."""
    bounce = run_pre_merge_gate(
        tmp_path,
        ["sh -c 'for i in $(seq 1 5000); do echo XXXXXXXXXX; done; exit 1'"],
        timeout=30,
    )
    assert bounce is not None
    assert len(bounce["excerpt"]) <= 2048


def test_gate_files_lists_untracked(tmp_path):
    """gate_failed.files surfaces the task's changed/new files for bounce context."""
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "foo.txt").write_text("new work\n")
    bounce = run_pre_merge_gate(tmp_path, ["false"], timeout=30)
    assert bounce is not None
    assert "foo.txt" in bounce["files"]


def test_symlink_node_modules_links_from_base(tmp_path):
    base = tmp_path / "base"
    wt = tmp_path / "wt"
    (base / "node_modules" / "pkg").mkdir(parents=True)
    wt.mkdir()
    _symlink_node_modules(wt, str(base))
    link = wt / "node_modules"
    assert link.is_symlink()
    assert (link / "pkg").is_dir()


def test_symlink_node_modules_noop_when_base_absent(tmp_path):
    wt = tmp_path / "wt"
    wt.mkdir()
    _symlink_node_modules(wt, str(tmp_path / "missing-base"))
    assert not (wt / "node_modules").exists()


# ---------------------------------------------------------------------------
# Bounce-into-reprompt — a re-dispatched task's prompt carries the prior bounce
# ---------------------------------------------------------------------------

from types import SimpleNamespace as _NS  # noqa: E402

from stratum_mcp.parallel_exec import (  # noqa: E402
    ParallelExecutor,
    _format_bounce_for_prompt,
)
from stratum_mcp.executor import ParallelTaskState  # noqa: E402


def _exec_with_tasks(parallel_tasks):
    state = _NS(flow_id="f1", cwd="", parallel_tasks=parallel_tasks)
    return ParallelExecutor(
        state=state, step_id="s1", tasks=[{"id": t} for t in parallel_tasks],
        max_concurrent=1, isolation="none", task_timeout=30, agent="claude",
        intent_template="Implement {id}", task_reasoning_template=None,
        require="all", persist_callable=lambda s: None,
    )


def test_format_bounce_for_prompt_gate_failed():
    out = _format_bounce_for_prompt({
        "task_id": "t1", "reason": "gate_failed", "files": ["src/a.ts"],
        "command": "pnpm build", "exit_code": 1, "excerpt": "TS2304",
    })
    assert "rejected before merge" in out
    assert "pnpm build" in out
    assert "exit 1" in out
    assert "src/a.ts" in out
    assert "TS2304" in out


def test_format_bounce_for_prompt_merge_conflict():
    out = _format_bounce_for_prompt({
        "task_id": "t2", "reason": "merge_conflict", "files": ["src/b.ts"],
        "command": None, "exit_code": None, "excerpt": "patch failed",
    })
    assert "CONFLICTED" in out
    assert "src/b.ts" in out


def test_render_prompt_injects_inbound_gate_bounce():
    ts = ParallelTaskState(task_id="t1")
    ts.gate_bounce = {
        "task_id": "t1", "reason": "gate_failed", "files": ["src/a.ts"],
        "command": "pnpm build", "exit_code": 1, "excerpt": "TS2304: cannot find name",
    }
    ex = _exec_with_tasks({"t1": ts})
    prompt = ex._render_prompt({"id": "t1"})
    assert "Implement t1" in prompt           # original intent preserved
    assert "rejected before merge" in prompt   # bounce injected
    assert "pnpm build" in prompt
    assert "TS2304" in prompt


def test_render_prompt_without_bounce_is_unchanged():
    ts = ParallelTaskState(task_id="t1")  # no gate_bounce
    ex = _exec_with_tasks({"t1": ts})
    prompt = ex._render_prompt({"id": "t1"})
    assert prompt == "Implement t1"


# ---------------------------------------------------------------------------
# COMP-PAR-MERGE-QUEUE-CONSUMER: resolved pre_merge_verify on the dispatch surface
# ---------------------------------------------------------------------------

import asyncio  # noqa: E402

from stratum_mcp.executor import _flows, get_current_step_info  # noqa: E402
from stratum_mcp.server import stratum_plan, stratum_step_done  # noqa: E402

_SPEC_GATE_SURFACE = """\
version: "0.3"
contracts:
  TaskGraph:
    tasks: {type: array}
flows:
  main:
    input: {}
    steps:
      - id: analyze
        type: decompose
        agent: claude
        intent: "Break down"
        output_contract: TaskGraph
      - id: execute
        type: parallel_dispatch
        source: "$.steps.analyze.output.tasks"
        agent: claude
        isolation: worktree
        require: all
        pre_merge_verify: ["pnpm lint", "pnpm build"]
        intent_template: "Do: {desc}"
        depends_on: [analyze]
"""


def test_dispatch_surface_carries_resolved_pre_merge_verify():
    """get_current_step_info surfaces the resolved gate so the Compose
    consumer-dispatch path can enforce it."""
    async def _drive():
        result = await stratum_plan(spec=_SPEC_GATE_SURFACE, flow="main", inputs={}, ctx=None)
        flow_id = result["flow_id"]
        task_graph = {"tasks": [{"id": "t1", "desc": "x", "files_owned": ["a.py"], "depends_on": []}]}
        await stratum_step_done(flow_id, "analyze", task_graph, ctx=None)
        return _flows[flow_id]

    state = asyncio.run(_drive())
    try:
        surface = get_current_step_info(state)
        assert surface["step_mode"] == "parallel_dispatch"
        assert surface["pre_merge_verify"] == ["pnpm lint", "pnpm build"]
    finally:
        _flows.pop(state.flow_id, None)


def test_dispatch_surface_omits_pre_merge_verify_when_absent():
    """A parallel step without pre_merge_verify omits the key entirely (byte-identical
    envelope — the consumer reads `dispatchResponse.pre_merge_verify ?? []`)."""
    async def _drive():
        spec = _SPEC_GATE_SURFACE.replace(
            '        pre_merge_verify: ["pnpm lint", "pnpm build"]\n', ""
        )
        result = await stratum_plan(spec=spec, flow="main", inputs={}, ctx=None)
        flow_id = result["flow_id"]
        task_graph = {"tasks": [{"id": "t1", "desc": "x", "files_owned": ["a.py"], "depends_on": []}]}
        await stratum_step_done(flow_id, "analyze", task_graph, ctx=None)
        return _flows[flow_id]

    state = asyncio.run(_drive())
    try:
        surface = get_current_step_info(state)
        # Byte-identical: the key is omitted entirely when no gate is declared.
        assert "pre_merge_verify" not in surface
    finally:
        _flows.pop(state.flow_id, None)


# ---------------------------------------------------------------------------
# COMP-PAR-MERGE-QUEUE-CONSUMER: done-path structured bounces + readable violations
# ---------------------------------------------------------------------------

from stratum_mcp.server import _evaluate_parallel_results  # noqa: E402


def test_evaluate_surfaces_consumer_bounces_and_readable_violations():
    """The consumer-dispatch path passes gate + conflict bounces via a structured
    merge_status; they surface on bounced_tasks AND as readable violation strings."""
    state = _NS(parallel_tasks={}, inputs={}, step_outputs={})
    step = _NS(
        task_reasoning_template=None, agent="claude", require="all",
        step_type="parallel_dispatch", stages=None, source="$.x", step_ensure=[],
    )
    task_results = [
        {"task_id": "t1", "status": "complete", "result": {}},
        {"task_id": "t2", "status": "failed", "error": "gate"},
    ]
    gate_b = {"task_id": "t2", "reason": "gate_failed", "command": "pnpm build",
              "exit_code": 1, "files": ["a.ts"], "excerpt": "e"}
    conf_b = {"task_id": "t1", "reason": "merge_conflict", "files": ["b.ts"],
              "command": None, "exit_code": None, "excerpt": "c"}
    merge_status = {"status": "conflict", "bounced_tasks": [gate_b, conf_b]}

    can_advance, ev = _evaluate_parallel_results(state, step, task_results, merge_status)
    assert can_advance is False
    reasons = sorted(b["reason"] for b in ev["bounced_tasks"])
    assert reasons == ["gate_failed", "merge_conflict"]
    joined = " ".join(ev["per_task_cert_strs"])
    assert "pre-merge gate" in joined
    assert "merge conflict" in joined
    assert "t2" in joined and "pnpm build" in joined


def test_evaluate_bare_clean_no_bounces_byte_identical():
    """No bounces + clean + all complete ⇒ can_advance True, empty bounced_tasks."""
    state = _NS(parallel_tasks={}, inputs={}, step_outputs={})
    step = _NS(
        task_reasoning_template=None, agent="claude", require="all",
        step_type="parallel_dispatch", stages=None, source="$.x", step_ensure=[],
    )
    task_results = [{"task_id": "t1", "status": "complete", "result": {}}]
    can_advance, ev = _evaluate_parallel_results(state, step, task_results, "clean")
    assert can_advance is True
    assert ev["bounced_tasks"] == []
