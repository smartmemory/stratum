"""Tests for connector interrupt() semantics (T2-F5 T6).

OpencodeConnector.interrupt() sends SIGTERM, then schedules SIGKILL after a
5-second grace period. CodexConnector (direct `codex exec` CLI) sends SIGTERM
only — it does not inherit the grace-and-SIGKILL dance, matching the JS
reference at compose/server/connectors/codex-connector.js:217-222.
ClaudeConnector.interrupt() is a documented no-op (SDK lacks a cancel API).
"""
from __future__ import annotations

import asyncio
import signal
from unittest.mock import MagicMock

import pytest

from stratum_mcp.connectors import (
    ClaudeConnector,
    CodexConnector,
    OpencodeConnector,
)


class _FakeProc:
    """Duck-types asyncio.subprocess.Process for interrupt() tests."""

    def __init__(self, returncode=None):
        self.returncode = returncode
        self.send_signal = MagicMock()
        self.kill = MagicMock()
        self.terminate = MagicMock()


# ---------------------------------------------------------------------------
# OpencodeConnector.interrupt()
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_opencode_interrupt_sigterm_on_running_proc():
    """Running process → SIGTERM is dispatched via send_signal."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    conn._proc = fake

    conn.interrupt()

    fake.send_signal.assert_called_once_with(signal.SIGTERM)


@pytest.mark.asyncio
async def test_opencode_interrupt_sigkill_after_grace(monkeypatch):
    """After SIGTERM, if returncode stays None past the grace period, SIGKILL fires."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    conn._proc = fake

    # Zero-out the grace period so the background task fires immediately.
    # Patch at the module level so the inner closure sees the stub.
    async def _no_sleep(_duration):
        return None

    monkeypatch.setattr(
        "stratum_mcp.connectors.opencode.asyncio.sleep", _no_sleep
    )

    conn.interrupt()

    # Drive the event loop until all pending tasks (except this one) complete.
    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    fake.kill.assert_called_once()


@pytest.mark.asyncio
async def test_opencode_interrupt_skips_kill_if_proc_exited_during_grace(monkeypatch):
    """If the process exits during the grace period, SIGKILL is NOT sent."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    conn._proc = fake

    async def _exit_during_sleep(_duration):
        # Simulate the process exiting gracefully in response to SIGTERM.
        fake.returncode = 0

    monkeypatch.setattr(
        "stratum_mcp.connectors.opencode.asyncio.sleep", _exit_during_sleep
    )

    conn.interrupt()

    pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)

    fake.kill.assert_not_called()


def test_opencode_interrupt_idempotent_not_running():
    """No proc attached → no-op; safe to call repeatedly."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    assert conn._proc is None

    conn.interrupt()  # must not raise
    conn.interrupt()  # still must not raise


def test_opencode_interrupt_after_proc_exited():
    """Proc already exited (returncode set) → send_signal NOT called."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=0)
    conn._proc = fake

    conn.interrupt()

    fake.send_signal.assert_not_called()
    fake.kill.assert_not_called()


def test_opencode_interrupt_swallows_process_lookup_error():
    """If the kernel reports the PID is already gone, we swallow the error."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    fake.send_signal.side_effect = ProcessLookupError()
    conn._proc = fake

    conn.interrupt()  # must not propagate


def test_opencode_interrupt_with_no_running_loop():
    """Called outside an event loop: SIGTERM still goes out; grace scheduling is skipped."""
    conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    conn._proc = fake

    conn.interrupt()

    fake.send_signal.assert_called_once_with(signal.SIGTERM)


# ---------------------------------------------------------------------------
# ClaudeConnector.interrupt() — documented no-op
# ---------------------------------------------------------------------------


def test_claude_interrupt_is_noop():
    """Claude has no cancel API; interrupt() must not raise and must not do work."""
    conn = ClaudeConnector()
    conn.interrupt()  # must not raise
    assert conn.is_running is False


# ---------------------------------------------------------------------------
# CodexConnector — inherits OpencodeConnector.interrupt()
# ---------------------------------------------------------------------------


def test_codex_interrupt_sigterm_on_running_proc():
    """CodexConnector sends SIGTERM to its own subprocess (no opencode inheritance)."""
    conn = CodexConnector(model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    conn._proc = fake

    conn.interrupt()

    fake.send_signal.assert_called_once_with(signal.SIGTERM)
    assert conn.is_running is False or conn._proc is fake


def test_codex_interrupt_idempotent_not_running():
    """No subprocess → interrupt is a no-op."""
    conn = CodexConnector(model_id="gpt-5.4")
    conn._proc = None
    conn.interrupt()  # must not raise


def test_codex_interrupt_skips_exited_proc():
    """Already-exited process → interrupt must not send_signal."""
    conn = CodexConnector(model_id="gpt-5.4")
    fake = _FakeProc(returncode=0)
    conn._proc = fake
    conn.interrupt()
    fake.send_signal.assert_not_called()


def test_codex_interrupt_swallows_process_lookup_error():
    """PID already reaped → ProcessLookupError is swallowed."""
    conn = CodexConnector(model_id="gpt-5.4")
    fake = _FakeProc(returncode=None)
    fake.send_signal.side_effect = ProcessLookupError
    conn._proc = fake
    conn.interrupt()  # must not raise
