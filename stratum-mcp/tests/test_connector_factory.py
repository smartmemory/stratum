"""Unit tests for the agent connector factory (T2-F5-ENFORCE T1).

Validates that make_agent_connector dispatches to the right connector class
for v1 agent types ("claude", "codex"), and that unsupported agent types
(including "opencode" in server-dispatch) raise ValueError with helpful messages.
"""
from __future__ import annotations

import pytest

from stratum_mcp.connectors import ClaudeConnector, CodexConnector
from stratum_mcp.connectors.factory import make_agent_connector


def test_make_claude():
    """make_agent_connector("claude", None, None) returns a ClaudeConnector."""
    conn = make_agent_connector("claude", None, None)
    assert isinstance(conn, ClaudeConnector)


def test_make_codex_default_model():
    """make_agent_connector("codex", None, None) returns a CodexConnector with default model."""
    conn = make_agent_connector("codex", None, None)
    assert isinstance(conn, CodexConnector)
    assert conn._default_model_id == "gpt-5.4"


def test_make_unknown_agent_raises():
    """Unknown agent_type raises ValueError mentioning both valid types."""
    with pytest.raises(ValueError) as excinfo:
        make_agent_connector("bogus", None, None)
    msg = str(excinfo.value)
    assert "claude" in msg
    assert "codex" in msg


def test_make_opencode_raises_with_roadmap_pointer():
    """opencode agent_type raises ValueError citing T2-F5-OPENCODE-DISPATCH."""
    with pytest.raises(ValueError) as excinfo:
        make_agent_connector("opencode", None, None)
    msg = str(excinfo.value)
    assert "T2-F5-OPENCODE-DISPATCH" in msg


def test_codex_durable_stream_path_threaded():
    """T2-F5-RESUME: stream_path/stderr_path are threaded into CodexConnector."""
    conn = make_agent_connector(
        "codex", None, None,
        stream_path="/tmp/flow/streams/t1.jsonl",
        stderr_path="/tmp/flow/streams/t1.err",
    )
    assert isinstance(conn, CodexConnector)
    assert conn._stream_path == "/tmp/flow/streams/t1.jsonl"
    assert conn._stderr_path == "/tmp/flow/streams/t1.err"
    assert conn._durable is True


def test_codex_no_stream_path_is_non_durable():
    """Default (no stream_path) → non-durable, today's PIPE behavior."""
    conn = make_agent_connector("codex", None, None)
    assert conn._stream_path is None
    assert conn._durable is False


def test_claude_ignores_stream_path():
    """stream_path is codex-only; passing it for claude is harmless."""
    conn = make_agent_connector("claude", None, None, stream_path="/tmp/x.jsonl")
    assert isinstance(conn, ClaudeConnector)
