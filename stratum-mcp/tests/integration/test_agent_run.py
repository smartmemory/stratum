"""Integration tests for the stratum_agent_run MCP tool (T2-F5)."""
from __future__ import annotations

import asyncio
from typing import AsyncIterator, Optional

import pytest

from stratum_mcp.connectors import AgentConnector
from stratum_mcp.server import stratum_agent_run


class _FakeConnector(AgentConnector):
    """Yields a canned event sequence — used to unit-test the tool logic
    without hitting the real connectors."""

    def __init__(self, events):
        self._events = events

    async def run(self, prompt, **_ignored) -> AsyncIterator[dict]:
        for event in self._events:
            yield event


def _install_fake_connector(monkeypatch, events):
    def _factory(agent_type, model_id, cwd):
        return _FakeConnector(events)

    monkeypatch.setattr(
        "stratum_mcp.server._make_agent_connector", _factory
    )


async def _run(**kwargs):
    # Provide a null ctx — the tool doesn't touch it for the agent_run path
    return await stratum_agent_run(ctx=None, **kwargs)


@pytest.mark.asyncio
async def test_agent_run_missing_prompt_raises():
    with pytest.raises(ValueError, match="prompt is required"):
        await _run(prompt="")


@pytest.mark.asyncio
async def test_agent_run_blank_prompt_raises():
    with pytest.raises(ValueError, match="prompt is required"):
        await _run(prompt="   \n  ")


@pytest.mark.asyncio
async def test_agent_run_unknown_type_raises(monkeypatch):
    # Use the real factory so it raises on bad type
    with pytest.raises(ValueError, match="unknown type"):
        await _run(prompt="hi", type="bogus")


@pytest.mark.asyncio
async def test_agent_run_claude_returns_text(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [{"type": "assistant", "content": "hello"}],
    )
    result = await _run(prompt="hi", type="claude")
    assert result == {"text": "hello"}


@pytest.mark.asyncio
async def test_agent_run_concatenates_multiple_assistant_events(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [
            {"type": "assistant", "content": "hello "},
            {"type": "assistant", "content": "world"},
        ],
    )
    result = await _run(prompt="hi", type="claude")
    assert result == {"text": "hello world"}


@pytest.mark.asyncio
async def test_agent_run_schema_extracts_json_from_code_block(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [
            {"type": "assistant", "content": "Thinking...\n\n```json\n{\"ok\": true}\n```"},
        ],
    )
    result = await _run(prompt="hi", type="claude", schema={"type": "object"})
    assert result["result"] == {"ok": True}
    assert "ok" in result["text"]


@pytest.mark.asyncio
async def test_agent_run_schema_extracts_last_block_when_multiple(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [
            {
                "type": "assistant",
                "content": "```json\n{\"first\": 1}\n```\n\nBut actually:\n\n```json\n{\"second\": 2}\n```",
            },
        ],
    )
    result = await _run(prompt="hi", type="claude", schema={"type": "object"})
    assert result["result"] == {"second": 2}


@pytest.mark.asyncio
async def test_agent_run_schema_parses_pure_json_text(monkeypatch):
    """When the whole response is valid JSON (no code block), that also works."""
    _install_fake_connector(
        monkeypatch,
        [{"type": "assistant", "content": '{"direct": "json"}'}],
    )
    result = await _run(prompt="hi", type="claude", schema={"type": "object"})
    assert result["result"] == {"direct": "json"}


@pytest.mark.asyncio
async def test_agent_run_schema_invalid_returns_parseError(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [{"type": "assistant", "content": "no json here"}],
    )
    result = await _run(prompt="hi", type="claude", schema={"type": "object"})
    assert result["result"] is None
    assert result["parseError"] == "Response was not valid JSON"


@pytest.mark.asyncio
async def test_agent_run_agent_error_raises(monkeypatch):
    _install_fake_connector(
        monkeypatch,
        [{"type": "error", "message": "boom"}],
    )
    with pytest.raises(RuntimeError, match="boom"):
        await _run(prompt="hi", type="claude")


@pytest.mark.asyncio
async def test_agent_run_result_only_connector_uses_result_as_fallback(monkeypatch):
    """If a connector emits only a result event (no assistant events), the tool
    still returns the text from the result."""
    _install_fake_connector(
        monkeypatch,
        [{"type": "result", "content": "final answer"}],
    )
    result = await _run(prompt="hi", type="claude")
    assert result == {"text": "final answer"}


@pytest.mark.asyncio
async def test_agent_run_assistant_takes_precedence_over_result(monkeypatch):
    """When both assistant and result events emit, assistant concatenation wins
    (matches Node behavior — assistant events are authoritative when present)."""
    _install_fake_connector(
        monkeypatch,
        [
            {"type": "assistant", "content": "streamed"},
            {"type": "result", "content": "aggregated"},
        ],
    )
    result = await _run(prompt="hi", type="claude")
    assert result == {"text": "streamed"}


@pytest.mark.asyncio
async def test_agent_run_codex_validates_model():
    """Unknown codex model surfaces as ValueError (matches Node behavior)."""
    with pytest.raises(ValueError, match="not a supported Codex model"):
        await _run(prompt="hi", type="codex", modelID="gpt-fake-9000")


class _PromptCapturingConnector(AgentConnector):
    """Captures the prompt it receives so tests can assert on concatenation."""

    def __init__(self):
        self.received_prompt: Optional[str] = None

    async def run(self, prompt, **_ignored) -> AsyncIterator[dict]:
        self.received_prompt = prompt
        yield {"type": "assistant", "content": "ok"}


@pytest.mark.asyncio
async def test_agent_run_prepends_context_when_provided(monkeypatch):
    captured = _PromptCapturingConnector()
    monkeypatch.setattr(
        "stratum_mcp.server._make_agent_connector",
        lambda *_a, **_k: captured,
    )
    await _run(prompt="do the thing", context="you are reviewing FEAT-1")
    assert captured.received_prompt == "you are reviewing FEAT-1\n\ndo the thing"


@pytest.mark.asyncio
async def test_agent_run_omits_context_when_blank(monkeypatch):
    captured = _PromptCapturingConnector()
    monkeypatch.setattr(
        "stratum_mcp.server._make_agent_connector",
        lambda *_a, **_k: captured,
    )
    await _run(prompt="do the thing", context="   \n  ")
    assert captured.received_prompt == "do the thing"


@pytest.mark.asyncio
async def test_agent_run_no_context_passes_prompt_through(monkeypatch):
    captured = _PromptCapturingConnector()
    monkeypatch.setattr(
        "stratum_mcp.server._make_agent_connector",
        lambda *_a, **_k: captured,
    )
    await _run(prompt="do the thing")
    assert captured.received_prompt == "do the thing"
