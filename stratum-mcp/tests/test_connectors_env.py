"""Tests for AgentConnector.run() env parameter and SENSITIVE_ENV_VARS (T2-F5-ENFORCE).

These tests pin the public contract of the base connector:
  - run() accepts a keyword-only `env` parameter that defaults to None
  - SENSITIVE_ENV_VARS is a tuple with the exact expected shape

T5 adds concrete-connector behavior (claude/codex/opencode honor the env baseline
and scrub the full SENSITIVE_ENV_VARS list).
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Optional

import pytest

from stratum_mcp.connectors.base import AgentConnector, SENSITIVE_ENV_VARS


async def _collect(agen):
    return [event async for event in agen]


class _StubConnector(AgentConnector):
    """Trivial subclass that records run() kwargs and yields one event."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def run(
        self,
        prompt: str,
        *,
        schema: Optional[dict] = None,
        model_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        cwd: Optional[str] = None,
        tools: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
    ) -> AsyncIterator[dict]:
        self.calls.append(
            {
                "prompt": prompt,
                "schema": schema,
                "model_id": model_id,
                "provider_id": provider_id,
                "cwd": cwd,
                "tools": tools,
                "env": env,
            }
        )
        yield {"type": "system", "subtype": "complete"}


@pytest.mark.asyncio
async def test_run_accepts_env_kwarg():
    """run() must accept env={...} and still work with no env kwarg (legacy callers)."""
    conn = _StubConnector()

    # With env kwarg — should not raise TypeError
    events_with_env = await _collect(conn.run(prompt="hi", env={"FOO": "bar"}))
    assert len(events_with_env) == 1

    # Without env kwarg — legacy call path
    events_without_env = await _collect(conn.run(prompt="hi"))
    assert len(events_without_env) == 1

    # Verify both calls recorded with correct env values
    assert len(conn.calls) == 2
    assert conn.calls[0]["env"] == {"FOO": "bar"}
    assert conn.calls[1]["env"] is None


def test_sensitive_env_vars_tuple_shape():
    """SENSITIVE_ENV_VARS is a tuple with exactly these four names in this order."""
    assert isinstance(SENSITIVE_ENV_VARS, tuple)
    assert SENSITIVE_ENV_VARS == (
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDE_API_KEY",
        "CLAUDECODE",
    )


# ---------------------------------------------------------------------------
# T5 — concrete connector env plumbing + full SENSITIVE_ENV_VARS scrub
# ---------------------------------------------------------------------------


from unittest.mock import patch

from stratum_mcp.connectors import (
    ClaudeConnector,
    CodexConnector,
    OpencodeConnector,
)


class _FakeStream:
    async def readline(self):
        return b""


class _FakeProc:
    stdout = _FakeStream()
    stderr = _FakeStream()
    returncode = 0

    async def wait(self):
        return 0


@pytest.mark.asyncio
async def test_opencode_subprocess_receives_stratum_env_vars():
    """env= kwarg is forwarded to create_subprocess_exec as the baseline env."""
    captured: dict = {}

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        return _FakeProc()

    with patch(
        "stratum_mcp.connectors.opencode.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
        await _collect(
            conn.run(
                prompt="hi",
                env={
                    "STRATUM_TASK_ID": "t1",
                    "STRATUM_FLOW_ID": "f1",
                    "PATH": "/usr/bin",
                },
            )
        )

    env = captured["env"]
    assert env.get("STRATUM_TASK_ID") == "t1"
    assert env.get("STRATUM_FLOW_ID") == "f1"
    assert env.get("PATH") == "/usr/bin"


@pytest.mark.asyncio
async def test_opencode_subprocess_does_not_receive_sensitive_vars(monkeypatch):
    """Full SENSITIVE_ENV_VARS scrub applies regardless of env source."""
    captured: dict = {}

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        return _FakeProc()

    # Plant a sensitive var in os.environ (covers the default/inherit path
    # even though we pass env= here — defense-in-depth).
    monkeypatch.setenv("ANTHROPIC_API_KEY", "secret")

    with patch(
        "stratum_mcp.connectors.opencode.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
        await _collect(
            conn.run(
                prompt="hi",
                env={
                    "STRATUM_TASK_ID": "t1",
                    "ANTHROPIC_API_KEY": "leaked",
                    "OPENAI_API_KEY": "leaked",
                    "CLAUDE_API_KEY": "leaked",
                    "CLAUDECODE": "1",
                },
            )
        )

    env = captured["env"]
    assert "ANTHROPIC_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert "CLAUDE_API_KEY" not in env
    assert "CLAUDECODE" not in env
    # STRATUM vars preserved
    assert env.get("STRATUM_TASK_ID") == "t1"


@pytest.mark.asyncio
async def test_opencode_default_path_scrubs_all_sensitive_vars(monkeypatch):
    """When env=None, baseline is os.environ but all SENSITIVE_ENV_VARS still scrubbed."""
    captured: dict = {}

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        return _FakeProc()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("OPENAI_API_KEY", "b")
    monkeypatch.setenv("CLAUDE_API_KEY", "c")
    monkeypatch.setenv("CLAUDECODE", "1")

    with patch(
        "stratum_mcp.connectors.opencode.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = OpencodeConnector(provider_id="openai", model_id="gpt-5.4")
        await _collect(conn.run(prompt="hi"))

    env = captured["env"]
    assert "ANTHROPIC_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert "CLAUDE_API_KEY" not in env
    assert "CLAUDECODE" not in env


async def _async_gen(items):
    for item in items:
        yield item


@pytest.mark.asyncio
async def test_claude_env_scrub_covers_all_sensitive_vars_default_path(monkeypatch):
    """ClaudeConnector scrubs all SENSITIVE_ENV_VARS when env=None (os.environ baseline)."""
    captured: dict = {}

    def _fake_query(*, prompt, options):
        captured["env"] = options.env
        return _async_gen([])

    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("OPENAI_API_KEY", "b")
    monkeypatch.setenv("CLAUDE_API_KEY", "c")
    monkeypatch.setenv("CLAUDECODE", "1")

    with patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        await _collect(conn.run("x"))

    env = captured["env"]
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"):
        assert var not in env, f"{var} leaked into claude SDK env"


@pytest.mark.asyncio
async def test_claude_env_scrub_covers_all_sensitive_vars_with_env_kwarg():
    """ClaudeConnector scrubs all SENSITIVE_ENV_VARS when env= kwarg is passed."""
    captured: dict = {}

    def _fake_query(*, prompt, options):
        captured["env"] = options.env
        return _async_gen([])

    with patch("stratum_mcp.connectors.claude.query", side_effect=_fake_query):
        conn = ClaudeConnector()
        await _collect(
            conn.run(
                "x",
                env={
                    "STRATUM_TASK_ID": "t1",
                    "ANTHROPIC_API_KEY": "leaked",
                    "OPENAI_API_KEY": "leaked",
                    "CLAUDE_API_KEY": "leaked",
                    "CLAUDECODE": "1",
                },
            )
        )

    env = captured["env"]
    assert env.get("STRATUM_TASK_ID") == "t1"
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"):
        assert var not in env, f"{var} leaked into claude SDK env"


@pytest.mark.asyncio
async def test_codex_subprocess_receives_stratum_env_vars():
    """env= kwarg is forwarded to create_subprocess_exec as the baseline env.

    Direct subprocess spawn — no more delegation through OpencodeConnector.
    """
    captured: dict = {}

    class _FakeStdin:
        def write(self, data):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

    class _FakeProcWithStdin(_FakeProc):
        stdin = _FakeStdin()

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        captured["args"] = args
        return _FakeProcWithStdin()

    with patch(
        "stratum_mcp.connectors.codex.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = CodexConnector(model_id="gpt-5.4")
        await _collect(
            conn.run(
                prompt="hi",
                env={
                    "STRATUM_TASK_ID": "t1",
                    "STRATUM_FLOW_ID": "f1",
                    "PATH": "/usr/bin",
                },
            )
        )

    env = captured["env"]
    assert env.get("STRATUM_TASK_ID") == "t1"
    assert env.get("STRATUM_FLOW_ID") == "f1"
    # codex binary invoked (positional arg 0)
    assert captured["args"][0] == "codex"


@pytest.mark.asyncio
async def test_codex_scrubs_cross_provider_creds_but_keeps_openai_api_key(monkeypatch):
    """OPENAI_API_KEY must pass through (codex uses it); ANTHROPIC/CLAUDE must not."""
    captured: dict = {}

    class _FakeStdin:
        def write(self, data):
            pass

        async def drain(self):
            pass

        def close(self):
            pass

    class _FakeProcWithStdin(_FakeProc):
        stdin = _FakeStdin()

    async def _fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}
        return _FakeProcWithStdin()

    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setenv("CLAUDE_API_KEY", "claude-secret")
    monkeypatch.setenv("CLAUDECODE", "1")

    with patch(
        "stratum_mcp.connectors.codex.asyncio.create_subprocess_exec",
        side_effect=_fake_create,
    ):
        conn = CodexConnector(model_id="gpt-5.4")
        await _collect(conn.run(prompt="hi"))

    env = captured["env"]
    assert env.get("OPENAI_API_KEY") == "openai-secret", "codex needs OPENAI_API_KEY"
    for var in ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE"):
        assert var not in env, f"{var} leaked into codex env"
