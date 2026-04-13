"""AgentConnector base class and inject_schema helper.

Port of compose/server/connectors/agent-connector.js. Keeps the event envelope
byte-for-byte compatible with the Node.js implementation so the MCP tool
contract is preserved.
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Optional

Event = dict[str, Any]
"""The connector envelope — kept as a plain dict for flexibility.

Shape (matches Node agent-connector.js envelope):
    {"type": "system",    "subtype": "init" | "complete", "agent": str, "model": str}
    {"type": "assistant", "content": str}
    {"type": "tool_use",           "tool": str, "input": dict}
    {"type": "tool_use_summary",   "summary": str, "output": Optional[str]}
    {"type": "error",              "message": str}
    {"type": "result",             "content": str}
    {"type": "usage",              "input_tokens": int, "output_tokens": int, ...}

Schema mode: if run() is called with schema=..., the connector injects it into
the prompt as instructions. JSON parsing happens at the MCP tool layer, never
inside connectors.
"""


class AgentConnector(ABC):
    """Abstract base for agent connectors. Subclasses implement run()."""

    @abstractmethod
    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,
    ) -> AsyncIterator[Event]:
        """Run a prompt against the agent, yielding envelope events."""
        ...  # pragma: no cover

    def interrupt(self) -> None:
        """No-op if not running."""

    @property
    def is_running(self) -> bool:
        return False


def inject_schema(prompt: str, schema: dict) -> str:
    """Inject a JSON schema into a prompt so the agent returns structured JSON.

    Byte-for-byte compatible with the Node.js injectSchema() in
    compose/server/connectors/agent-connector.js:52-62 for JSON-Schema inputs
    we pass in practice (ASCII property names, no large numbers).
    """
    return (
        f"{prompt}\n\n"
        "IMPORTANT: After completing the task, include a JSON code block at the very end "
        "of your response matching this schema:\n"
        "```json\n"
        f"{json.dumps(schema, indent=2)}\n"
        "```\n"
        "The JSON block must be the last thing in your response."
    )
