"""Unit tests for stratum_agent_run connectors (T2-F5).

All tests use mocks — no real API calls or subprocess spawns.
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from stratum_mcp.connectors import (
    CODEX_MODEL_IDS,
    ClaudeConnector,
    CodexConnector,
    OpencodeConnector,
    inject_schema,
)
from stratum_mcp.connectors.codex import _translate_codex_event
from stratum_mcp.connectors.opencode import _translate_opencode_event


# ---------------------------------------------------------------------------
# inject_schema — byte-for-byte parity with Node agent-connector.js:52-62
# ---------------------------------------------------------------------------


def test_inject_schema_matches_node_format():
    """Golden test: Python output must equal the Node.js reference string."""
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    result = inject_schema("Do X", schema)
    expected = (
        "Do X\n\n"
        "IMPORTANT: After completing the task, include a JSON code block at the very end "
        "of your response matching this schema:\n"
        "```json\n"
        '{\n  "type": "object",\n  "properties": {\n    "ok": {\n      "type": "boolean"\n    }\n  }\n}\n'
        "```\n"
        "The JSON block must be the last thing in your response."
    )
    assert result == expected


# ---------------------------------------------------------------------------
# ClaudeConnector — normalization with mocked SDK
# ---------------------------------------------------------------------------


async def _collect(agen):
    return [event async for event in agen]


class _FakeTextBlock:
    """Duck-types claude_agent_sdk.types.TextBlock for isinstance checks."""

    def __init__(self, text: str):
        self.text = text


class _FakeToolUseBlock:
    def __init__(self, name: str, input_: dict):
        self.name = name
        self.input = input_


class _FakeAssistantMessage:
    def __init__(self, content):
        self.content = content


class _FakeResultMessage:
    def __init__(self, result=None, usage=None):
        self.result = result
        self.usage = usage


async def _async_gen(items):
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_claude_connector_yields_envelope():
    """Mocked query() → connector yields expected init/assistant/result/complete."""
    msgs = [
        _FakeAssistantMessage([_FakeTextBlock("hi")]),
        _FakeResultMessage(result="hi", usage={"input_tokens": 5, "output_tokens": 1}),
    ]
    with patch("stratum_mcp.connectors.claude.query", return_value=_async_gen(msgs)), \
         patch("stratum_mcp.connectors.claude.AssistantMessage", _FakeAssistantMessage), \
         patch("stratum_mcp.connectors.claude.ResultMessage", _FakeResultMessage), \
         patch("stratum_mcp.connectors.claude.TextBlock", _FakeTextBlock), \
         patch("stratum_mcp.connectors.claude.ToolUseBlock", _FakeToolUseBlock):
        conn = ClaudeConnector(model="claude-test")
        events = await _collect(conn.run("say hi"))
    types = [(e.get("type"), e.get("subtype")) for e in events]
    assert types[0] == ("system", "init")
    assert ("assistant", None) in types
    assert ("result", None) in types
    assert ("usage", None) in types
    assert types[-1] == ("system", "complete")


@pytest.mark.asyncio
async def test_claude_connector_schema_injects_into_prompt():
    """When schema is provided, the prompt passed to query() contains the schema block."""
    captured = {}

    def _fake_query(*, prompt, options):
        captured["prompt"] = prompt
        captured["options"] = options
        return _async_gen([])

    with patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        await _collect(conn.run("Do X", schema={"type": "object"}))
    assert "```json" in captured["prompt"]
    assert '"type": "object"' in captured["prompt"]


@pytest.mark.asyncio
async def test_claude_connector_error_yields_error_event():
    """If query() raises, connector yields an error envelope event instead."""

    def _fake_query(*, prompt, options):
        async def _gen():
            raise RuntimeError("boom")
            yield  # pragma: no cover — unreachable, here to keep it a generator
        return _gen()

    with patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        events = await _collect(conn.run("x"))
    errors = [e for e in events if e.get("type") == "error"]
    assert errors, f"expected an error event, got {events}"
    assert "boom" in errors[0]["message"]


@pytest.mark.asyncio
async def test_claude_connector_strips_claudecode_env():
    """CLAUDECODE env var is removed from options.env to allow nested execution."""
    captured = {}

    def _fake_query(*, prompt, options):
        captured["env"] = options.env
        return _async_gen([])

    import os as _os
    with patch.dict(_os.environ, {"CLAUDECODE": "1"}, clear=False), \
         patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        await _collect(conn.run("x"))
    assert "CLAUDECODE" not in captured["env"]


# ---------------------------------------------------------------------------
# OpencodeConnector — translate events + subprocess integration (mocked)
# ---------------------------------------------------------------------------


def test_translate_text_event():
    events = _translate_opencode_event(
        {"type": "text", "part": {"text": "hello"}}, "model-x"
    )
    assert events == [{"type": "assistant", "content": "hello"}]


def test_translate_tool_use_event_with_output():
    events = _translate_opencode_event(
        {
            "type": "tool_use",
            "part": {
                "tool": "bash",
                "state": {"input": {"command": "ls"}, "output": "a\nb\nc"},
            },
        },
        "model-x",
    )
    assert events[0] == {"type": "tool_use", "tool": "bash", "input": {"command": "ls"}}
    assert events[1]["type"] == "tool_use_summary"
    assert events[1]["output"] == "a\nb\nc"


def test_translate_step_finish_with_cost_and_tokens():
    events = _translate_opencode_event(
        {
            "type": "step_finish",
            "part": {
                "cost": 0.0003,
                "tokens": {"input": 10, "output": 20, "cache_write": 1, "cache_read": 2},
            },
        },
        "model-x",
    )
    assert events == [
        {
            "type": "usage",
            "input_tokens": 10,
            "output_tokens": 20,
            "cache_creation_input_tokens": 1,
            "cache_read_input_tokens": 2,
            "cost_usd": 0.0003,
            "model": "model-x",
        }
    ]


def test_translate_unknown_event_returns_empty():
    assert _translate_opencode_event({"type": "step_start"}, "model-x") == []


@pytest.mark.asyncio
async def test_opencode_missing_binary_yields_friendly_error():
    """opencode binary not on PATH → yields error event with install hint."""
    async def _fake_create(*args, **kwargs):
        raise FileNotFoundError("opencode")

    with patch(
        "stratum_mcp.connectors.opencode.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
        events = await _collect(conn.run("test"))
    errors = [e for e in events if e.get("type") == "error"]
    assert errors, f"expected error event, got {events}"
    assert "opencode binary not found" in errors[0]["message"]
    assert "brew install opencode" in errors[0]["message"]


@pytest.mark.asyncio
async def test_claude_connector_default_uses_claude_code_preset():
    """When no allowed_tools, options.tools is the claude_code preset."""
    captured = {}

    def _fake_query(*, prompt, options):
        captured["tools"] = options.tools
        return _async_gen([])

    with patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        await _collect(conn.run("x"))
    assert captured["tools"] == {"type": "preset", "preset": "claude_code"}


@pytest.mark.asyncio
async def test_opencode_strips_openai_api_key_from_env():
    """Spawned subprocess env has OPENAI_API_KEY removed (opencode uses OAuth)."""
    captured: dict = {}

    class _FakeStream:
        async def readline(self):
            return b""

    class _FakeProc:
        stdout = _FakeStream()
        stderr = _FakeStream()
        returncode = 0

        async def wait(self):
            return 0

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        captured["args"] = args
        return _FakeProc()

    import os as _os
    with patch.dict(_os.environ, {"OPENAI_API_KEY": "secret"}, clear=False), \
         patch(
             "stratum_mcp.connectors.opencode.asyncio.create_subprocess_exec",
             side_effect=_fake_create,
         ):
        conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
        await _collect(conn.run("test"))
    assert "OPENAI_API_KEY" not in captured["env"]


# ---------------------------------------------------------------------------
# CodexConnector — model validation
# ---------------------------------------------------------------------------


def test_codex_connector_accepts_known_model():
    conn = CodexConnector(model_id="gpt-5.4")
    assert conn._default_model_id == "gpt-5.4"


def test_codex_connector_rejects_unknown_model_at_construction():
    with pytest.raises(ValueError, match="not a supported Codex model"):
        CodexConnector(model_id="gpt-fake-9000")


@pytest.mark.asyncio
async def test_codex_connector_rejects_unknown_model_at_run_time():
    """Override model via run() kwarg — validation still runs."""
    conn = CodexConnector(model_id="gpt-5.4")
    with pytest.raises(ValueError, match="not a supported Codex model"):
        await _collect(conn.run("prompt", model_id="gpt-fake-9000"))


def test_codex_model_ids_snapshot():
    """Lock the supported set. Update this snapshot when adding new codex models."""
    assert "gpt-5.4" in CODEX_MODEL_IDS
    assert "gpt-5.2-codex" in CODEX_MODEL_IDS
    assert "gpt-5.1-codex-mini" in CODEX_MODEL_IDS
    # Non-members
    assert "gpt-4" not in CODEX_MODEL_IDS
    assert "claude-opus-4-6" not in CODEX_MODEL_IDS


# ---------------------------------------------------------------------------
# CodexConnector — event translation (`codex exec --json` → envelope events)
# ---------------------------------------------------------------------------


def test_translate_codex_agent_message_becomes_assistant_event():
    events = _translate_codex_event(
        {"type": "item.completed", "item": {"type": "agent_message", "text": "hi"}},
        "gpt-5.4",
    )
    assert events == [{"type": "assistant", "content": "hi"}]


def test_translate_codex_empty_agent_message_is_dropped():
    assert _translate_codex_event(
        {"type": "item.completed", "item": {"type": "agent_message", "text": ""}},
        "gpt-5.4",
    ) == []


def test_translate_codex_command_execution_emits_tool_use_and_summary():
    events = _translate_codex_event(
        {
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "command": "ls /tmp",
                "aggregated_output": "a\nb\nc",
            },
        },
        "gpt-5.4",
    )
    assert events[0] == {
        "type": "tool_use",
        "tool": "bash",
        "input": {"command": "ls /tmp"},
    }
    assert events[1]["type"] == "tool_use_summary"
    assert events[1]["summary"] == "a\nb\nc"
    assert events[1]["output"] == "a\nb\nc"


def test_translate_codex_command_execution_truncates_long_output():
    long_out = "x" * 5000
    events = _translate_codex_event(
        {
            "type": "item.completed",
            "item": {"type": "command_execution", "command": "ls", "output": long_out},
        },
        "gpt-5.4",
    )
    assert len(events) == 2
    assert events[1]["summary"].endswith("...")
    assert len(events[1]["summary"]) == 80
    assert len(events[1]["output"]) == 2048


def test_translate_codex_file_change_becomes_edit_tool_use():
    events = _translate_codex_event(
        {
            "type": "item.completed",
            "item": {"type": "file_change", "path": "src/foo.py"},
        },
        "gpt-5.4",
    )
    assert events == [
        {"type": "tool_use", "tool": "edit", "input": {"path": "src/foo.py"}}
    ]


def test_translate_codex_reasoning_surfaces_as_assistant():
    events = _translate_codex_event(
        {"type": "item.completed", "item": {"type": "reasoning", "text": "hmm"}},
        "gpt-5.4",
    )
    assert events == [{"type": "assistant", "content": "hmm"}]


def test_translate_codex_turn_completed_emits_usage():
    events = _translate_codex_event(
        {
            "type": "turn.completed",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 42,
                "cached_input_tokens": 10,
            },
        },
        "gpt-5.4/high",
    )
    assert events == [
        {
            "type": "usage",
            "input_tokens": 100,
            "output_tokens": 42,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 10,
            "cost_usd": 0,
            "model": "gpt-5.4/high",
        }
    ]


def test_translate_codex_error_event_forwards_message():
    assert _translate_codex_event(
        {"type": "error", "message": "boom"}, "gpt-5.4"
    ) == [{"type": "error", "message": "boom"}]


def test_translate_codex_ignores_unknown_types():
    assert _translate_codex_event({"type": "thread.started"}, "gpt-5.4") == []
    assert _translate_codex_event({"type": "turn.started"}, "gpt-5.4") == []
    assert _translate_codex_event({"type": "unknown.type"}, "gpt-5.4") == []


@pytest.mark.asyncio
async def test_codex_missing_binary_yields_friendly_error():
    """codex binary not on PATH → yields error event with install hint."""
    async def _raise_file_not_found(*args, **kwargs):
        raise FileNotFoundError("codex")

    with patch(
        "stratum_mcp.connectors.codex.asyncio.create_subprocess_exec",
        _raise_file_not_found,
    ):
        conn = CodexConnector(model_id="gpt-5.4")
        events = await _collect(conn.run("hi"))

    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1
    assert "codex binary not found" in errors[0]["message"]
    assert "npm i -g @openai/codex" in errors[0]["message"]
