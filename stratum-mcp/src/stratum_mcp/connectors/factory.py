"""Agent connector factory (T2-F5-ENFORCE T1).

Single dispatch point for constructing agent connectors from a v1 agent-type
string. The v1 server-dispatch supports only "claude" and "codex"; "opencode"
is explicitly reserved for a future feature (T2-F5-OPENCODE-DISPATCH) and
raises a ValueError pointing at that roadmap ID.
"""
from __future__ import annotations

from typing import Any, Optional

from .base import AgentConnector
from .claude import ClaudeConnector
from .codex import CodexConnector

_VALID_AGENT_TYPES = frozenset({"claude", "codex"})


def make_agent_connector(
    agent_type: str, model_id: Optional[str], cwd: Optional[str]
) -> AgentConnector:
    """Factory — raises ValueError on unknown type or bad codex model.

    "opencode" raises ValueError with T2-F5-OPENCODE-DISPATCH pointer — that
    agent type is not yet wired into server-dispatch.
    """
    if agent_type == "opencode":
        raise ValueError(
            "stratum_agent_run: agent_type 'opencode' is not yet supported "
            "in server-dispatch (see T2-F5-OPENCODE-DISPATCH). "
            f"Valid types for v1: {sorted(_VALID_AGENT_TYPES)}"
        )
    if agent_type not in _VALID_AGENT_TYPES:
        raise ValueError(
            f"stratum_agent_run: unknown type '{agent_type}'. "
            f"Valid types: {sorted(_VALID_AGENT_TYPES)}"
        )
    if agent_type == "codex":
        return CodexConnector(model_id=model_id or "gpt-5.4", cwd=cwd)
    kwargs: dict[str, Any] = {"cwd": cwd}
    if model_id:
        kwargs["model"] = model_id
    return ClaudeConnector(**kwargs)
