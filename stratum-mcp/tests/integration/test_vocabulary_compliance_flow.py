"""End-to-end flow tests for vocabulary_compliance (STRAT-VOCAB)."""
import textwrap

import pytest

from stratum_mcp.executor import (
    _flows,
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


_VOCAB_FLOW_SPEC = textwrap.dedent("""\
    version: "0.2"
    contracts:
      Out:
        files_changed:
          type: array
          items: {type: string}
    functions:
      work:
        mode: infer
        intent: "Implement the feature"
        input: {}
        output: Out
        ensure:
          - "vocabulary_compliance('vocab.yaml', result.files_changed)"
        retries: 2
    flows:
      main:
        input: {}
        output: Out
        steps:
          - id: build
            function: work
            inputs: {}
""")


def test_golden_flow_clean_pass(tmp_path, monkeypatch):
    """Run a flow, report clean result -> step succeeds."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "vocab.yaml").write_text(
        "user_id:\n  reject: [userId]\n  reason: 'DB column is user_id'\n"
    )
    src = tmp_path / "clean.py"
    src.write_text("user_id = 1\n")

    spec = parse_and_validate(_VOCAB_FLOW_SPEC)
    state = create_flow_state(spec, "main", {}, raw_spec=_VOCAB_FLOW_SPEC)
    get_current_step_info(state)

    status, violations = process_step_result(
        state, "build", {"files_changed": [str(src)]}
    )
    assert status == "ok"
    assert violations == []


def test_golden_flow_violation_ensure_failed(tmp_path, monkeypatch):
    """Violation reported -> ensure_failed with clean individual violations."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "vocab.yaml").write_text(
        "user_id:\n  reject: [userId]\n  reason: 'DB column is user_id'\n"
    )
    bad = tmp_path / "bad.py"
    bad.write_text("userId = 1\n")

    spec = parse_and_validate(_VOCAB_FLOW_SPEC)
    state = create_flow_state(spec, "main", {}, raw_spec=_VOCAB_FLOW_SPEC)
    get_current_step_info(state)

    status, violations = process_step_result(
        state, "build", {"files_changed": [str(bad)]}
    )
    assert status in ("ensure_failed", "retries_exhausted")
    assert len(violations) >= 1
    # The violation should be a clean individual string, not a stringified list
    assert "userId" in violations[0]
    assert "user_id" in violations[0]
    assert "DB column is user_id" in violations[0]
    assert not violations[0].startswith("[")


def test_golden_flow_no_vocab_file_is_noop(tmp_path, monkeypatch):
    """Flow without a vocab.yaml -> ensure passes silently."""
    monkeypatch.chdir(tmp_path)
    src = tmp_path / "code.py"
    src.write_text("userId = 1\nuid = 2\nuserId = 3\n")

    spec = parse_and_validate(_VOCAB_FLOW_SPEC)
    state = create_flow_state(spec, "main", {}, raw_spec=_VOCAB_FLOW_SPEC)
    get_current_step_info(state)

    status, violations = process_step_result(
        state, "build", {"files_changed": [str(src)]}
    )
    assert status == "ok"
    assert violations == []


def test_golden_flow_multiple_violations_reported_individually(tmp_path, monkeypatch):
    """Multiple violations -> multiple individual entries, not a collapsed string."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "vocab.yaml").write_text(
        "user_id:\n"
        "  reject: [userId, uid]\n"
    )
    bad = tmp_path / "bad.py"
    bad.write_text(
        "userId = 1\n"
        "uid = 2\n"
        "def foo(userId): return uid\n"
    )

    spec = parse_and_validate(_VOCAB_FLOW_SPEC)
    state = create_flow_state(spec, "main", {}, raw_spec=_VOCAB_FLOW_SPEC)
    get_current_step_info(state)

    status, violations = process_step_result(
        state, "build", {"files_changed": [str(bad)]}
    )
    assert status in ("ensure_failed", "retries_exhausted")
    assert len(violations) == 4  # userId x2, uid x2
    # Each violation is a separate string
    assert all(isinstance(v, str) for v in violations)
    assert all(not v.startswith("[") for v in violations)
