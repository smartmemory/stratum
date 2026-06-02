"""Tests for STRAT-PAR-STREAM-TOOLDETAIL.

Enriches the claude streaming connector so each tool CALL carries the raw
(size-capped) tool input + a tool_use_id, and each tool RESULT (ToolResultBlock
inside a UserMessage) produces a `tool_result` event with ok/output.

Schema bump 0.2.6 -> 0.2.7. `tool_use_summary` and `tool_result` ride the open
catch-all metadata block — no closed schema is added for them.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from stratum_mcp.connectors import ClaudeConnector
from stratum_mcp.connectors.claude import _cap_text
from stratum_mcp.events import INTERNAL_RESULT_KIND, BuildStreamEvent


# ---------------------------------------------------------------------------
# Fakes — mirror the installed claude_agent_sdk.types dataclasses.
# ToolUseBlock: id, name, input. ToolResultBlock: tool_use_id, content, is_error.
# UserMessage: content (str | list[ContentBlock]).
# ---------------------------------------------------------------------------


class _FakeTextBlock:
    def __init__(self, text):
        self.text = text


class _FakeToolUseBlock:
    def __init__(self, name, input_, id="toolu_default"):
        self.id = id
        self.name = name
        self.input = input_


class _FakeToolResultBlock:
    def __init__(self, tool_use_id, content=None, is_error=None):
        self.tool_use_id = tool_use_id
        self.content = content
        self.is_error = is_error


class _FakeAssistantMessage:
    def __init__(self, content):
        self.content = content


class _FakeUserMessage:
    def __init__(self, content):
        self.content = content


class _FakeResultMessage:
    def __init__(self, result=None, usage=None):
        self.result = result
        self.usage = usage


async def _async_gen(items):
    for item in items:
        yield item


async def _collect(agen):
    return [ev async for ev in agen]


def _patched(msgs):
    """Patch the SDK message classes + query() on the claude connector module."""
    return [
        patch("stratum_mcp.connectors.claude.query", return_value=_async_gen(msgs)),
        patch("stratum_mcp.connectors.claude.AssistantMessage", _FakeAssistantMessage),
        patch("stratum_mcp.connectors.claude.UserMessage", _FakeUserMessage),
        patch("stratum_mcp.connectors.claude.ResultMessage", _FakeResultMessage),
        patch("stratum_mcp.connectors.claude.TextBlock", _FakeTextBlock),
        patch("stratum_mcp.connectors.claude.ToolUseBlock", _FakeToolUseBlock),
        patch("stratum_mcp.connectors.claude.ToolResultBlock", _FakeToolResultBlock),
    ]


async def _run_stream(msgs):
    patchers = _patched(msgs)
    for p in patchers:
        p.start()
    try:
        conn = ClaudeConnector(model="claude-test")
        return await _collect(conn.stream_events("ping"))
    finally:
        for p in reversed(patchers):
            p.stop()


# ---------------------------------------------------------------------------
# Schema version bump
# ---------------------------------------------------------------------------


def test_schema_version_is_0_2_7():
    ev = BuildStreamEvent(
        flow_id="f",
        step_id="s",
        seq=0,
        ts="2026-06-02T00:00:00.000Z",
        kind="tool_use_summary",
        metadata={},
    )
    assert ev.schema_version == "0.2.7"
    obj = json.loads(ev.to_json())
    assert obj["schema_version"] == "0.2.7"


# ---------------------------------------------------------------------------
# Size-cap helper
# ---------------------------------------------------------------------------


def test_cap_text_under_limit_is_unchanged():
    s = "short string"
    assert _cap_text(s) == s


def test_cap_text_over_limit_truncates_with_marker():
    big = "x" * 5000
    capped = _cap_text(big)
    # The emitted value (prefix + marker) must stay within the cap.
    assert len(capped) <= 2048
    assert capped.startswith("x")
    assert "…[truncated" in capped
    # marker reports dropped CHARACTERS (honest unit), not bytes
    assert "chars]" in capped
    assert "bytes]" not in capped


def test_cap_text_exactly_at_limit_is_unchanged():
    s = "y" * 2048
    assert _cap_text(s) == s


# ---------------------------------------------------------------------------
# Tool CALL event carries raw input + tool_use_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_use_summary_carries_raw_input_and_id():
    msgs = [
        _FakeAssistantMessage(
            [
                _FakeToolUseBlock(
                    "Edit",
                    {"file_path": "/repo/app.py", "old_string": "a", "new_string": "b"},
                    id="toolu_42",
                )
            ]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tus = next(e for e in events if e.kind == "tool_use_summary")
    # Back-compat fields retained
    assert tus.metadata["tool"] == "Edit"
    assert tus.metadata["ok"] is True
    assert tus.metadata["duration_ms"] == 0
    assert "summary" in tus.metadata
    # New fields
    assert tus.metadata["tool_use_id"] == "toolu_42"
    assert tus.metadata["input"] == {
        "file_path": "/repo/app.py",
        "old_string": "a",
        "new_string": "b",
    }
    # input is the raw dict so a consumer can recover input.file_path structurally
    assert tus.metadata["input"]["file_path"] == "/repo/app.py"


@pytest.mark.asyncio
async def test_tool_use_summary_input_is_size_capped():
    huge = "Z" * 5000
    msgs = [
        _FakeAssistantMessage(
            [_FakeToolUseBlock("Write", {"file_path": "/x", "content": huge}, id="t1")]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tus = next(e for e in events if e.kind == "tool_use_summary")
    inp = tus.metadata["input"]
    # Over-cap input is serialized to a capped string with a truncation marker.
    assert isinstance(inp, str)
    assert "…[truncated" in inp
    assert len(inp) <= 2048 + 40  # cap + marker overhead


# ---------------------------------------------------------------------------
# Tool RESULT event (ToolResultBlock inside UserMessage)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_result_success_event():
    msgs = [
        _FakeUserMessage(
            [_FakeToolResultBlock("toolu_42", content="File written", is_error=False)]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    assert tr.metadata["tool_use_id"] == "toolu_42"
    assert tr.metadata["ok"] is True
    assert tr.metadata["output"] == "File written"


@pytest.mark.asyncio
async def test_tool_result_error_event_has_ok_false_and_error_text():
    msgs = [
        _FakeUserMessage(
            [
                _FakeToolResultBlock(
                    "toolu_99",
                    content="String not found in file",
                    is_error=True,
                )
            ]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    assert tr.metadata["tool_use_id"] == "toolu_99"
    assert tr.metadata["ok"] is False
    assert "String not found" in tr.metadata["output"]


@pytest.mark.asyncio
async def test_tool_result_missing_is_error_defaults_ok_true():
    # SDK is_error is Optional[bool]; None / absent means not an error.
    msgs = [
        _FakeUserMessage([_FakeToolResultBlock("t", content="ok", is_error=None)]),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    assert tr.metadata["ok"] is True


@pytest.mark.asyncio
async def test_tool_result_content_list_coerced_to_string():
    # block.content may be a list of content blocks (dicts), not a plain string.
    msgs = [
        _FakeUserMessage(
            [
                _FakeToolResultBlock(
                    "t",
                    content=[{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}],
                    is_error=False,
                )
            ]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    out = tr.metadata["output"]
    assert isinstance(out, str)
    assert "line one" in out
    assert "line two" in out


@pytest.mark.asyncio
async def test_tool_result_output_is_size_capped():
    msgs = [
        _FakeUserMessage([_FakeToolResultBlock("t", content="Q" * 5000, is_error=False)]),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    out = tr.metadata["output"]
    assert "…[truncated" in out
    assert len(out) <= 2048 + 40


@pytest.mark.asyncio
async def test_tool_result_none_content_is_empty_string():
    msgs = [
        _FakeUserMessage([_FakeToolResultBlock("t", content=None, is_error=False)]),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tr = next(e for e in events if e.kind == "tool_result")
    assert tr.metadata["output"] == ""


@pytest.mark.asyncio
async def test_user_message_string_content_emits_no_tool_result():
    # A UserMessage may carry a plain string (no tool results) — must not crash
    # and must not emit a tool_result.
    msgs = [
        _FakeUserMessage("just a string, no blocks"),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    assert not any(e.kind == "tool_result" for e in events)


# ---------------------------------------------------------------------------
# End-to-end call + result correlation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_call_and_result_correlate_via_tool_use_id():
    msgs = [
        _FakeAssistantMessage(
            [_FakeToolUseBlock("Read", {"file_path": "/a/b.py"}, id="toolu_corr")]
        ),
        _FakeUserMessage(
            [_FakeToolResultBlock("toolu_corr", content="contents", is_error=False)]
        ),
        _FakeResultMessage(result="done"),
    ]
    events = await _run_stream(msgs)
    tus = next(e for e in events if e.kind == "tool_use_summary")
    tr = next(e for e in events if e.kind == "tool_result")
    assert tus.metadata["tool_use_id"] == tr.metadata["tool_use_id"] == "toolu_corr"
    # Last event is still the internal result sentinel.
    assert events[-1].kind == INTERNAL_RESULT_KIND
