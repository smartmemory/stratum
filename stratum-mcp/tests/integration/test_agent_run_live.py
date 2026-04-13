"""Opt-in live smoke tests for stratum_agent_run (T2-F5).

These make real API calls and cost a small amount of money.
Run only when explicitly requested:

    STRATUM_LIVE_AGENT_TESTS=1 pytest tests/integration/test_agent_run_live.py

Requires:
- ANTHROPIC_API_KEY set (for claude test)
- opencode auth set up OR OPENAI_API_KEY set (for codex test)
"""
from __future__ import annotations

import os

import pytest

from stratum_mcp.server import stratum_agent_run

LIVE_TESTS_ENABLED = os.environ.get("STRATUM_LIVE_AGENT_TESTS") == "1"

pytestmark = pytest.mark.skipif(
    not LIVE_TESTS_ENABLED,
    reason="set STRATUM_LIVE_AGENT_TESTS=1 to enable live agent tests",
)


@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="ANTHROPIC_API_KEY not set",
)
@pytest.mark.asyncio
async def test_live_claude_haiku_responds():
    """Real Haiku call. Costs ~$0.0001."""
    result = await stratum_agent_run(
        prompt="Reply with exactly the word: pong",
        ctx=None,
        type="claude",
        modelID="claude-haiku-4-5",
    )
    assert "pong" in result["text"].lower()


@pytest.mark.skipif(
    not os.environ.get("OPENAI_API_KEY"),
    reason="OPENAI_API_KEY not set (opencode OAuth auth can substitute but is harder to detect)",
)
@pytest.mark.asyncio
async def test_live_codex_responds():
    """Real codex call via opencode. Requires opencode installed and authed."""
    result = await stratum_agent_run(
        prompt="Reply with exactly the word: pong",
        ctx=None,
        type="codex",
        modelID="gpt-5.4",
    )
    assert "pong" in result["text"].lower()
