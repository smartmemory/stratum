"""Tests for compile_ensure violation passthrough (STRAT-VOCAB companion fix)."""
import pytest
import textwrap

from stratum_mcp.executor import (
    _flows,
    compile_ensure,
    EnsureCompileError,
    create_flow_state,
    get_current_step_info,
    process_step_result,
)
from stratum_mcp.spec import parse_and_validate


@pytest.fixture(autouse=True)
def _cleanup():
    _flows.clear()
    yield
    _flows.clear()


# ---------------------------------------------------------------------------
# Direct compile_ensure passthrough tests
# ---------------------------------------------------------------------------

def test_compile_ensure_preserves_value_error_list():
    """ValueError([list of strings]) is preserved as exc.violations on EnsureCompileError."""
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _raise_violations(result):
        raise ValueError(["violation 1", "violation 2", "violation 3"])

    _ENSURE_BUILTINS["_raise_violations"] = _raise_violations
    try:
        fn = compile_ensure("_raise_violations(result)")
        with pytest.raises(EnsureCompileError) as exc_info:
            fn({"dummy": True})
        assert hasattr(exc_info.value, "violations")
        assert exc_info.value.violations == ["violation 1", "violation 2", "violation 3"]
    finally:
        _ENSURE_BUILTINS.pop("_raise_violations", None)


def test_compile_ensure_wraps_value_error_single_string():
    """ValueError('single string') is wrapped normally, not treated as violations."""
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _raise_string(result):
        raise ValueError("some message")

    _ENSURE_BUILTINS["_raise_string"] = _raise_string
    try:
        fn = compile_ensure("_raise_string(result)")
        with pytest.raises(EnsureCompileError) as exc_info:
            fn({"dummy": True})
        assert not hasattr(exc_info.value, "violations")
        assert "some message" in str(exc_info.value)
    finally:
        _ENSURE_BUILTINS.pop("_raise_string", None)


def test_compile_ensure_wraps_non_value_error():
    """TypeError and other exceptions are wrapped normally."""
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _raise_type_error(result):
        raise TypeError("not a value error")

    _ENSURE_BUILTINS["_raise_type_error"] = _raise_type_error
    try:
        fn = compile_ensure("_raise_type_error(result)")
        with pytest.raises(EnsureCompileError) as exc_info:
            fn({"dummy": True})
        assert not hasattr(exc_info.value, "violations")
        assert "not a value error" in str(exc_info.value)
    finally:
        _ENSURE_BUILTINS.pop("_raise_type_error", None)


def test_compile_ensure_wraps_value_error_with_non_string_list():
    """ValueError([1, 2, 3]) (list of non-strings) is wrapped normally."""
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _raise_numeric_list(result):
        raise ValueError([1, 2, 3])

    _ENSURE_BUILTINS["_raise_numeric_list"] = _raise_numeric_list
    try:
        fn = compile_ensure("_raise_numeric_list(result)")
        with pytest.raises(EnsureCompileError) as exc_info:
            fn({"dummy": True})
        assert not hasattr(exc_info.value, "violations")
    finally:
        _ENSURE_BUILTINS.pop("_raise_numeric_list", None)


# ---------------------------------------------------------------------------
# End-to-end: structured violations flow through process_step_result
# ---------------------------------------------------------------------------

_PASSTHROUGH_SPEC = textwrap.dedent("""\
    version: "0.2"
    contracts:
      Out:
        v: {type: string}
    functions:
      work:
        mode: infer
        intent: "Produce output"
        input: {}
        output: Out
        ensure:
          - "_passthrough_violations(result)"
        retries: 1
    flows:
      main:
        input: {}
        output: Out
        steps:
          - id: s1
            function: work
            inputs: {}
""")


def test_process_step_result_receives_individual_violations():
    """End-to-end: violations from ValueError(list) appear as individual entries in the violations list."""
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _passthrough_violations(result):
        raise ValueError(["first violation", "second violation"])

    _ENSURE_BUILTINS["_passthrough_violations"] = _passthrough_violations
    try:
        spec = parse_and_validate(_PASSTHROUGH_SPEC)
        state = create_flow_state(spec, "main", {}, raw_spec=_PASSTHROUGH_SPEC)
        get_current_step_info(state)

        status, violations = process_step_result(state, "s1", {"v": "test"})

        assert status in ("ensure_failed", "retries_exhausted")
        assert "first violation" in violations
        assert "second violation" in violations
        # Not a single stringified list
        assert all(not v.startswith("[") for v in violations)
    finally:
        _ENSURE_BUILTINS.pop("_passthrough_violations", None)


def test_plan_completion_violations_are_clean():
    """Regression: plan_completion-style violations appear cleanly, not as stringified list.

    Uses a locally-registered mock that mirrors the ValueError(list) contract
    plan_completion will/does use, so the test is independent of whether the
    plan_completion builtin itself is present on this branch.
    """
    from stratum_mcp.executor import _ENSURE_BUILTINS

    def _mock_plan_completion(plan_items, files_changed, threshold):
        """Mock mirroring plan_completion's structured violation contract."""
        missing_critical: list[str] = []
        for item in plan_items or []:
            if item.get("critical") and item.get("file") not in (files_changed or []):
                missing_critical.append(
                    f"Missing critical item: {item.get('text')!r} "
                    f"(expected file {item.get('file')!r} not in diff)"
                )
        if missing_critical:
            raise ValueError(missing_critical)
        return True

    _ENSURE_BUILTINS["_mock_plan_completion"] = _mock_plan_completion

    spec_yaml = textwrap.dedent("""\
        version: "0.2"
        contracts:
          Out:
            plan_items: {type: array}
            files_changed: {type: array}
        functions:
          work:
            mode: infer
            intent: "Produce output"
            input: {}
            output: Out
            ensure:
              - "_mock_plan_completion(result.plan_items, result.files_changed, 90)"
            retries: 1
        flows:
          main:
            input: {}
            output: Out
            steps:
              - id: s1
                function: work
                inputs: {}
    """)
    try:
        spec = parse_and_validate(spec_yaml)
        state = create_flow_state(spec, "main", {}, raw_spec=spec_yaml)
        get_current_step_info(state)

        # Plan with a critical missing item
        result = {
            "plan_items": [
                {"text": "Implement auth", "file": "src/auth.py", "critical": True}
            ],
            "files_changed": [],  # auth.py not in diff
        }
        status, violations = process_step_result(state, "s1", result)

        assert status in ("ensure_failed", "retries_exhausted")
        # Should see a clean "Missing critical item" string, not a stringified list
        assert any("Missing critical item" in v for v in violations)
        assert all(not v.startswith("['") for v in violations)
    finally:
        _ENSURE_BUILTINS.pop("_mock_plan_completion", None)
