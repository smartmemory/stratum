"""CodexConnector — extends OpencodeConnector, locked to OpenAI Codex models.

Port of compose/server/connectors/codex-connector.js:15-82 (T2-F5).
Requires the opencode CLI: brew install opencode.
Auth: OPENAI_API_KEY env var, or `opencode auth login` for OAuth.
"""
from __future__ import annotations

import os
from typing import Any, AsyncIterator, Optional

from .base import Event
from .opencode import OpencodeConnector

CODEX_MODEL_IDS: frozenset[str] = frozenset(
    {
        "gpt-5.4",
        "gpt-5.4/low",
        "gpt-5.4/medium",
        "gpt-5.4/high",
        "gpt-5.4/xhigh",
        "gpt-5.2-codex",
        "gpt-5.2-codex/low",
        "gpt-5.2-codex/medium",
        "gpt-5.2-codex/high",
        "gpt-5.2-codex/xhigh",
        "gpt-5.1-codex-max",
        "gpt-5.1-codex-max/low",
        "gpt-5.1-codex-max/medium",
        "gpt-5.1-codex-max/high",
        "gpt-5.1-codex-max/xhigh",
        "gpt-5.1-codex",
        "gpt-5.1-codex/low",
        "gpt-5.1-codex/medium",
        "gpt-5.1-codex/high",
        "gpt-5.1-codex-mini",
        "gpt-5.1-codex-mini/medium",
        "gpt-5.1-codex-mini/high",
    }
)

_DEFAULT_MODEL_ID = os.environ.get("CODEX_MODEL", "gpt-5.4")
_DEFAULT_PROVIDER_ID = "openai"


def _assert_codex_model(model_id: str) -> None:
    if model_id not in CODEX_MODEL_IDS:
        supported = ", ".join(sorted(CODEX_MODEL_IDS))
        raise ValueError(
            f"CodexConnector: '{model_id}' is not a supported Codex model.\n"
            f"Supported models: {supported}"
        )


class CodexConnector(OpencodeConnector):
    """OpencodeConnector locked to OpenAI Codex models."""

    def __init__(
        self, *, model_id: str = _DEFAULT_MODEL_ID, cwd: Optional[str] = None
    ):
        _assert_codex_model(model_id)
        super().__init__(
            provider_id=_DEFAULT_PROVIDER_ID,
            model_id=model_id,
            cwd=cwd,
            agent_name="codex",
        )

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,  # ignored — always 'openai'
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[Event]:
        resolved = model_id or self._default_model_id
        _assert_codex_model(resolved)
        async for event in super().run(
            prompt,
            schema=schema,
            model_id=resolved,
            provider_id=_DEFAULT_PROVIDER_ID,
            cwd=cwd,
            tools=tools,
            env=env,
        ):
            yield event
