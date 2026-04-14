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
