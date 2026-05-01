"""Regression coverage for STRAT-MCP-CHUNK-SIZE.

The codex connector was creating its subprocess via
``asyncio.create_subprocess_exec(...)`` without passing ``limit=``, which left
the default 64 KiB ``StreamReader`` buffer in place. Codex's ``--json`` preamble
on the first stdout line could exceed 64 KiB and trigger
``asyncio.LimitOverrunError("Separator is not found, and chunk exceed the limit")``
before any agent event reached the caller.

These tests pin:
1. The constant exists, defaults to >= 4 MiB, honors the env override, and
   clamps to a 64 KiB floor.
2. ``CodexConnector.run()`` and ``CodexConnector.stream_events()`` both pass
   that limit to ``asyncio.create_subprocess_exec``.
3. A long stdout line that would exceed the asyncio default (64 KiB) is read
   without raising.
4. A line that exceeds the configured limit yields/raises an actionable error
   that names the env knob.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
from typing import Any
from unittest.mock import patch

import pytest

from stratum_mcp.connectors import CodexConnector
from stratum_mcp.connectors import codex as codex_module


# ---------------------------------------------------------------------------
# Constant + env override
# ---------------------------------------------------------------------------


def test_codex_stdout_limit_default_is_at_least_4mib():
    """Default limit must comfortably exceed the 64 KiB asyncio default."""
    assert hasattr(codex_module, "_CODEX_STDOUT_LIMIT")
    assert codex_module._CODEX_STDOUT_LIMIT >= 4 * 1024 * 1024


def test_codex_stdout_limit_honors_env_override(monkeypatch):
    monkeypatch.setenv("STRATUM_CODEX_STREAM_LIMIT_BYTES", str(8 * 1024 * 1024))
    reloaded = importlib.reload(codex_module)
    try:
        assert reloaded._CODEX_STDOUT_LIMIT == 8 * 1024 * 1024
    finally:
        monkeypatch.delenv("STRATUM_CODEX_STREAM_LIMIT_BYTES", raising=False)
        importlib.reload(codex_module)


def test_codex_stdout_limit_clamps_to_64kib_floor(monkeypatch):
    """Setting an absurdly low value must not silently re-enable the bug."""
    monkeypatch.setenv("STRATUM_CODEX_STREAM_LIMIT_BYTES", "1024")
    reloaded = importlib.reload(codex_module)
    try:
        assert reloaded._CODEX_STDOUT_LIMIT >= 64 * 1024
    finally:
        monkeypatch.delenv("STRATUM_CODEX_STREAM_LIMIT_BYTES", raising=False)
        importlib.reload(codex_module)


# ---------------------------------------------------------------------------
# create_subprocess_exec is called with the limit kwarg
# ---------------------------------------------------------------------------


class _DeadProc:
    """Minimal stand-in for an asyncio subprocess that yields nothing."""

    def __init__(self) -> None:
        self.stdin = _NullStdin()
        self.stdout = _EmptyReader()
        self.stderr = _EmptyReader()
        self.returncode = 0

    async def wait(self) -> int:
        return 0


class _NullStdin:
    def write(self, data: bytes) -> None:
        return None

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


class _EmptyReader:
    async def readline(self) -> bytes:
        return b""


@pytest.mark.asyncio
async def test_run_passes_limit_to_create_subprocess_exec():
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured.update(kwargs)
        return _DeadProc()

    connector = CodexConnector()
    with patch.object(asyncio, "create_subprocess_exec", side_effect=fake_exec):
        async for _ in connector.run("hi", model_id="gpt-5.4"):
            pass

    assert "limit" in captured, "create_subprocess_exec must receive a limit kwarg"
    assert captured["limit"] >= 4 * 1024 * 1024


@pytest.mark.asyncio
async def test_stream_events_passes_limit_to_create_subprocess_exec():
    captured: dict[str, Any] = {}

    async def fake_exec(*args, **kwargs):
        captured.update(kwargs)
        return _DeadProc()

    connector = CodexConnector()
    with patch.object(asyncio, "create_subprocess_exec", side_effect=fake_exec):
        async for _ in connector.stream_events("hi", model_id="gpt-5.4"):
            pass

    assert "limit" in captured
    assert captured["limit"] >= 4 * 1024 * 1024


# ---------------------------------------------------------------------------
# Real subprocess: large stdout line is read without raising
# ---------------------------------------------------------------------------


def _emit_big_line_program(size: int) -> str:
    """Python one-liner that prints a JSON line of `size` bytes then exits."""
    return (
        "import json,sys;"
        f"payload='x'*{size};"
        "sys.stdout.write(json.dumps({'type':'thread.started','payload':payload}));"
        "sys.stdout.write('\\n');"
        "sys.stdout.flush();"
    )


@pytest.mark.asyncio
async def test_readline_handles_line_larger_than_asyncio_default():
    """A 200 KiB line must be readable — proves the limit override works."""
    limit = codex_module._CODEX_STDOUT_LIMIT
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _emit_big_line_program(200 * 1024),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=limit,
    )
    try:
        line = await proc.stdout.readline()
    finally:
        await proc.wait()

    assert len(line) > 64 * 1024
    parsed = json.loads(line)
    assert parsed["type"] == "thread.started"


@pytest.mark.asyncio
async def test_readline_with_default_limit_still_fails():
    """Sanity: confirms the bug repros with the asyncio default (64 KiB)."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _emit_big_line_program(200 * 1024),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # Python 3.12 wraps LimitOverrunError as ValueError inside readline()
        # but preserves the original message — assert on the message text.
        with pytest.raises((asyncio.LimitOverrunError, ValueError)) as exc_info:
            await proc.stdout.readline()
        assert "chunk" in str(exc_info.value).lower()
    finally:
        proc.kill()
        await proc.wait()


# ---------------------------------------------------------------------------
# Graceful failure: line larger than the configured limit yields/raises
# an actionable error that names the env knob.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_emits_actionable_error_on_overrun(monkeypatch):
    """If a line still exceeds our limit, surface a clear, env-named error."""
    # Force a tiny limit so a small line overruns deterministically.
    monkeypatch.setattr(codex_module, "_CODEX_STDOUT_LIMIT", 64 * 1024)

    async def fake_exec(*args, **kwargs):
        # Spawn a real subprocess that emits a 200 KiB line.
        return await asyncio.subprocess.create_subprocess_exec(
            sys.executable,
            "-c",
            _emit_big_line_program(200 * 1024),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=kwargs.get("limit", 64 * 1024),
        )

    connector = CodexConnector()
    events = []
    with patch.object(asyncio, "create_subprocess_exec", side_effect=fake_exec):
        async for ev in connector.run("hi", model_id="gpt-5.4"):
            events.append(ev)

    error_events = [e for e in events if e.get("type") == "error"]
    assert error_events, f"expected an error event; got {events!r}"
    msg = error_events[0]["message"].lower()
    assert "limit" in msg
    assert "stratum_codex_stream_limit_bytes" in msg


@pytest.mark.asyncio
async def test_stream_events_raises_actionable_error_on_overrun(monkeypatch):
    monkeypatch.setattr(codex_module, "_CODEX_STDOUT_LIMIT", 64 * 1024)

    async def fake_exec(*args, **kwargs):
        return await asyncio.subprocess.create_subprocess_exec(
            sys.executable,
            "-c",
            _emit_big_line_program(200 * 1024),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=kwargs.get("limit", 64 * 1024),
        )

    connector = CodexConnector()
    with patch.object(asyncio, "create_subprocess_exec", side_effect=fake_exec):
        with pytest.raises(RuntimeError) as excinfo:
            async for _ in connector.stream_events("hi", model_id="gpt-5.4"):
                pass

    msg = str(excinfo.value).lower()
    assert "limit" in msg
    assert "stratum_codex_stream_limit_bytes" in msg
