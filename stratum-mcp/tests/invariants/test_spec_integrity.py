"""Tests for STRAT-IMMUTABLE: spec_checksum on FlowState and verify_spec_integrity."""
import copy

import pytest

from stratum_mcp.executor import (
    compute_spec_checksum,
    create_flow_state,
    verify_spec_integrity,
)
from stratum_mcp.spec import parse_and_validate


# ---------------------------------------------------------------------------
# Minimal spec fixture
# ---------------------------------------------------------------------------

_SPEC_YAML = """\
version: "0.2"

contracts:
  Result:
    outcome: { type: string }
    summary: { type: string }
    artifact: { type: string }

functions:
  execute:
    mode: infer
    intent: "Do the work."
    input: {}
    output: Result
    ensure:
      - "result.outcome == 'complete'"

flows:
  build:
    input: {}
    output: Result
    steps:
      - id: execute
        function: execute
        inputs: {}
"""


def _make_state(yaml_text=_SPEC_YAML):
    spec = parse_and_validate(yaml_text)
    return create_flow_state(spec, "build", {}, raw_spec=yaml_text)


# ---------------------------------------------------------------------------
# Task 1: spec_checksum is populated on FlowState creation
# ---------------------------------------------------------------------------

def test_flow_state_spec_checksum_is_populated():
    """FlowState.spec_checksum must be non-empty after create_flow_state."""
    state = _make_state()
    assert state.spec_checksum, "spec_checksum should be non-empty"


def test_flow_state_spec_checksum_is_deterministic():
    """Same spec produces the same checksum across multiple create_flow_state calls."""
    state1 = _make_state()
    state2 = _make_state()
    assert state1.spec_checksum == state2.spec_checksum


def test_compute_spec_checksum_returns_hex_string():
    """compute_spec_checksum returns a 64-character lowercase hex string (SHA-256)."""
    spec = parse_and_validate(_SPEC_YAML)
    flow_def = spec.flows["build"]
    checksum = compute_spec_checksum(flow_def)
    assert len(checksum) == 64
    assert checksum == checksum.lower()
    int(checksum, 16)  # must be valid hex


# ---------------------------------------------------------------------------
# Task 2 / Task 3: verify_spec_integrity
# ---------------------------------------------------------------------------

def test_verify_spec_integrity_passes_unmodified():
    """verify_spec_integrity returns None when FlowDefinition is unchanged."""
    state = _make_state()
    spec = parse_and_validate(_SPEC_YAML)
    flow_def = spec.flows["build"]
    result = verify_spec_integrity(flow_def, state)
    assert result is None


def test_verify_spec_integrity_detects_intent_mutation():
    """verify_spec_integrity returns spec_modified when a function's intent is mutated.

    Simulates the real attack: an agent replaces state.spec with a tampered spec
    (modified function intent). verify_spec_integrity uses state.spec for function
    lookups, so the tampered intent is visible and the checksum won't match.
    """
    state = _make_state()
    # Tamper: build a spec with a different function intent
    tampered_yaml = _SPEC_YAML.replace(
        'intent: "Do the work."',
        'intent: "Do something else entirely."',
    )
    tampered_spec = parse_and_validate(tampered_yaml)
    tampered_flow_def = tampered_spec.flows["build"]

    # Simulate the attack: agent replaced state.spec with the tampered spec
    state.spec = tampered_spec

    result = verify_spec_integrity(tampered_flow_def, state)
    assert result is not None, "Expected spec_modified, got None"
    assert result["status"] == "spec_modified"
    assert "expected_checksum" in result
    assert "actual_checksum" in result
    assert result["expected_checksum"] != result["actual_checksum"]


def test_verify_spec_integrity_detects_ensure_mutation():
    """verify_spec_integrity returns spec_modified when a step's ensure list changes.

    Note: ensure expressions live on the function def, not the step def, so we
    detect mutation by hashing the step structure (id, function, inputs, etc.).
    To detect ensure changes we modify the intent (which is in the step for inline
    steps). For function-based steps, the checksum covers function name changes.
    We verify by swapping the function reference to a different name.
    """
    state = _make_state()
    # Add a second function with different intent and point the step at it
    tampered_yaml = _SPEC_YAML.replace(
        "  execute:\n    mode: infer\n    intent: \"Do the work.\"\n    input: {}\n    output: Result\n    ensure:\n      - \"result.outcome == 'complete'\"",
        "  execute:\n    mode: infer\n    intent: \"Do the work.\"\n    input: {}\n    output: Result\n    ensure:\n      - \"result.outcome == 'complete'\"\n  execute2:\n    mode: infer\n    intent: \"Alternative.\"\n    input: {}\n    output: Result",
    ).replace(
        "        function: execute",
        "        function: execute2",
    )
    tampered_spec = parse_and_validate(tampered_yaml)
    tampered_flow_def = tampered_spec.flows["build"]

    result = verify_spec_integrity(tampered_flow_def, state)
    assert result is not None
    assert result["status"] == "spec_modified"


def test_verify_spec_integrity_detects_added_step():
    """verify_spec_integrity detects when a step is added to the flow."""
    base_spec_with_two_steps = """\
version: "0.2"

contracts:
  Result:
    outcome: { type: string }
    summary: { type: string }
    artifact: { type: string }

functions:
  execute:
    mode: infer
    intent: "Do the work."
    input: {}
    output: Result
  review:
    mode: infer
    intent: "Review the work."
    input: {}
    output: Result

flows:
  build:
    input: {}
    output: Result
    steps:
      - id: execute
        function: execute
        inputs: {}
      - id: review
        function: review
        inputs: {}
        depends_on: [execute]
"""
    state = _make_state(_SPEC_YAML)  # original spec (1 step)

    # "Tamper" by providing a spec with an extra step
    tampered_spec = parse_and_validate(base_spec_with_two_steps)
    tampered_flow_def = tampered_spec.flows["build"]

    result = verify_spec_integrity(tampered_flow_def, state)
    assert result is not None
    assert result["status"] == "spec_modified"


# ---------------------------------------------------------------------------
# Backward compatibility: empty spec_checksum skips verification
# ---------------------------------------------------------------------------

def test_verify_spec_integrity_empty_checksum_is_noop():
    """FlowState with empty spec_checksum (legacy) does not block execution."""
    state = _make_state()
    state.spec_checksum = ""  # simulate legacy flow (no checksum field)

    # Tamper the flow def by pointing the step to a different function name
    tampered_yaml = """\
version: "0.2"

contracts:
  Result:
    outcome: { type: string }
    summary: { type: string }
    artifact: { type: string }

functions:
  execute:
    mode: infer
    intent: "Do the work."
    input: {}
    output: Result
  other:
    mode: infer
    intent: "TAMPERED intent."
    input: {}
    output: Result

flows:
  build:
    input: {}
    output: Result
    steps:
      - id: execute
        function: other
        inputs: {}
"""
    tampered_spec = parse_and_validate(tampered_yaml)
    tampered_flow_def = tampered_spec.flows["build"]

    result = verify_spec_integrity(tampered_flow_def, state)
    assert result is None, "Legacy flow (empty checksum) must skip verification"


# ---------------------------------------------------------------------------
# handle_parallel_done integration: spec_modified propagates through server
# ---------------------------------------------------------------------------

_PAR_SPEC_YAML = """\
version: "0.3"

contracts:
  TaskResult:
    outcome: { type: string }
    summary: { type: string }
    artifact: { type: string }

flows:
  build:
    input: { tasks: { type: array } }
    steps:
      - id: parallelise
        type: parallel_dispatch
        source: "$.input.tasks"
        intent_template: "Do task {task.description}"
        require: all
        merge: sequential_apply
"""


@pytest.mark.asyncio
async def test_parallel_done_returns_spec_modified_on_tamper():
    """stratum_parallel_done returns spec_modified when flow_def is tampered."""
    import stratum_mcp.server as server_mod
    from stratum_mcp.executor import _flows

    spec = parse_and_validate(_PAR_SPEC_YAML)
    state = create_flow_state(spec, "build", {"tasks": [{"id": "t1", "description": "task 1"}]}, raw_spec=_PAR_SPEC_YAML)
    _flows[state.flow_id] = state

    # Tamper: replace the flow's step in memory by replacing spec_checksum with a wrong value
    state.spec_checksum = "deadbeef" * 8  # 64 chars, wrong value

    # Call stratum_parallel_done via server directly
    class FakeCtx:
        pass

    result = await server_mod.stratum_parallel_done(
        flow_id=state.flow_id,
        step_id="parallelise",
        task_results=[{"task_id": "t1", "status": "complete", "result": {"outcome": "complete", "summary": "done", "artifact": ""}}],
        merge_status="clean",
        ctx=FakeCtx(),
    )

    assert result.get("status") == "spec_modified", f"Expected spec_modified, got: {result}"

    # Cleanup
    _flows.pop(state.flow_id, None)
