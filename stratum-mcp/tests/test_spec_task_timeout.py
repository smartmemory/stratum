"""Tests for T2-F5-ENFORCE T3: task_timeout field on parallel_dispatch steps.

Covers:
- task_timeout parsed from YAML into IRStepDef
- Schema-level rejection of zero / negative task_timeout (minimum: 1)
- Semantic-level rejection of task_timeout / max_concurrent on non-parallel steps
- task_timeout omitted defaults to None on IRStepDef
"""
import textwrap

import pytest

from stratum_mcp.errors import IRSemanticError, IRValidationError
from stratum_mcp.spec import parse_and_validate


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _parallel_spec(task_timeout_line: str = "") -> str:
    """Valid v0.3 spec with a parallel_dispatch step. Optionally inject a
    task_timeout field into that step via `task_timeout_line`."""
    return textwrap.dedent(f"""\
        version: "0.3"
        contracts:
          TaskGraph:
            tasks: {{type: array}}
          PhaseResult:
            outcome: {{type: string}}
        flows:
          build:
            input: {{plan: {{type: string}}}}
            output: PhaseResult
            steps:
              - id: analyze
                type: decompose
                agent: claude
                intent: "Analyze the plan and produce a TaskGraph"
                output_contract: TaskGraph
              - id: execute
                type: parallel_dispatch
                source: "$.steps.analyze.output.tasks"
                agent: claude
                max_concurrent: 3
                isolation: worktree
                require: all
                merge: sequential_apply
                intent_template: "Implement: {{task.description}}"
                {task_timeout_line}
                depends_on: [analyze]
        """)


def _non_parallel_spec_with(field_line: str) -> str:
    """Valid v0.3 spec with an inline step that includes an extra field line
    (e.g. 'task_timeout: 600' or 'max_concurrent: 2'). Used to exercise the
    parallel-only semantic gate."""
    return textwrap.dedent(f"""\
        version: "0.3"
        flows:
          build:
            input: {{}}
            output: ""
            steps:
              - id: s1
                type: inline
                agent: claude
                intent: "Do something"
                {field_line}
        """)


# ---------------------------------------------------------------------------
# Schema-level: task_timeout accepted on parallel_dispatch steps
# ---------------------------------------------------------------------------

class TestTaskTimeoutSchema:
    def test_parallel_dispatch_accepts_task_timeout_positive_int(self):
        spec = parse_and_validate(_parallel_spec("task_timeout: 600"))
        step = next(s for s in spec.flows["build"].steps if s.id == "execute")
        assert step.task_timeout == 600

    def test_parallel_dispatch_accepts_task_timeout_null(self):
        # task_timeout omitted entirely → None on the step
        spec = parse_and_validate(_parallel_spec(""))
        step = next(s for s in spec.flows["build"].steps if s.id == "execute")
        assert step.task_timeout is None

    def test_parallel_dispatch_rejects_task_timeout_zero(self):
        with pytest.raises(IRValidationError):
            parse_and_validate(_parallel_spec("task_timeout: 0"))

    def test_parallel_dispatch_rejects_task_timeout_negative(self):
        with pytest.raises(IRValidationError):
            parse_and_validate(_parallel_spec("task_timeout: -1"))


# ---------------------------------------------------------------------------
# Semantic-level: parallel_dispatch-only gate rejects task_timeout/max_concurrent
# on non-parallel_dispatch steps.
# ---------------------------------------------------------------------------

class TestParallelOnlyGate:
    def test_non_parallel_step_rejects_task_timeout(self):
        with pytest.raises(IRSemanticError) as exc:
            parse_and_validate(_non_parallel_spec_with("task_timeout: 600"))
        msg = str(exc.value)
        assert "task_timeout" in msg
        assert "parallel_dispatch" in msg

    def test_non_parallel_step_rejects_max_concurrent(self):
        with pytest.raises(IRSemanticError) as exc:
            parse_and_validate(_non_parallel_spec_with("max_concurrent: 2"))
        msg = str(exc.value)
        assert "max_concurrent" in msg
        assert "parallel_dispatch" in msg


# ---------------------------------------------------------------------------
# _build_step populates task_timeout on IRStepDef.
# ---------------------------------------------------------------------------

def test_build_step_populates_task_timeout():
    spec = parse_and_validate(_parallel_spec("task_timeout: 600"))
    step = next(s for s in spec.flows["build"].steps if s.id == "execute")
    assert step.task_timeout == 600
    # Also sanity-check default max_concurrent still works
    assert step.max_concurrent == 3
