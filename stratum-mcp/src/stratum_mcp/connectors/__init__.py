"""Agent connectors for stratum_agent_run.

T2-F5: Python port of Node.js connectors from compose/server/connectors/.
Exposes ClaudeConnector (via claude-agent-sdk) and CodexConnector (via opencode
subprocess), unified under the AgentConnector ABC.
"""
from .base import AgentConnector, Event, inject_schema
from .claude import ClaudeConnector
from .codex import CodexConnector, CODEX_MODEL_IDS
from .opencode import OpencodeConnector

__all__ = [
    "AgentConnector",
    "ClaudeConnector",
    "CodexConnector",
    "CODEX_MODEL_IDS",
    "Event",
    "OpencodeConnector",
    "inject_schema",
]
