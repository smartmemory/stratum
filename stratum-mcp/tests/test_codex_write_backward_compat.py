from __future__ import annotations

import os
from typing import AsyncIterator

import pytest

from stratum_mcp.connectors.codex import CodexConnector
from stratum_mcp import server as server_mod


def test_default_connector_argv_is_read_only():
    # The non-jailed default path must still emit --sandbox read-only.
    conn = CodexConnector(model_id="gpt-5.5")
    a = conn._exec_args("gpt-5.5", "", "/work")
    assert a[a.index("--sandbox") + 1] == "read-only"


def test_review_uses_read_only_by_construction():
    # The review path constructs the connector without sandbox_mode -> defaults
    # read-only. Regression guard against a default flip.
    conn = CodexConnector(model_id="gpt-5.5", read_jail="/staging")
    assert conn.sandbox_mode == "read-only"


def test_docker_jail_argv_is_read_only_mount(monkeypatch):
    sandbox = pytest.importorskip("stratum.judge.sandbox")
    monkeypatch.setattr(sandbox, "_ensure_image", lambda: "stratum-codexjail:test")

    driver = sandbox.DockerJailDriver()
    inner = ["exec", "--json", "--sandbox", "read-only", "-C", "/staging", "-"]
    argv = driver.wrap_argv(inner, read_root="/staging", env={})
    joined = " ".join(argv)
    read_root = os.path.realpath("/staging")

    # The container is the sandbox: read-only rootfs + a :ro bind of the tree.
    assert "--read-only" in argv
    bind_args = [argv[i + 1] for i, arg in enumerate(argv) if arg == "-v"]
    assert f"{read_root}:{read_root}:ro" in bind_args

    # No host-writable bind of the staged tree.
    assert f"{read_root}:{read_root}:rw" not in bind_args
    assert not any(
        bind.startswith(f"{read_root}:{read_root}:") and bind.endswith(":rw")
        for bind in bind_args
    )

    # Codex sandbox flag is stripped in favor of the container guarantee.
    assert "--sandbox" not in joined
    assert "--dangerously-bypass-approvals-and-sandbox" in joined


class _DummyConnector:
    async def run(self, prompt: str, **_kwargs) -> AsyncIterator[dict]:
        yield {"type": "result", "content": "ok"}


@pytest.mark.asyncio
async def test_public_tool_threads_resolved_sandbox_mode_to_factory(monkeypatch):
    monkeypatch.delenv("STRATUM_CODEX_ALLOW_WRITE", raising=False)
    assert server_mod._resolve_sandbox_mode("codex", True, "/repo") == "workspace-write"

    captured: dict[str, object] = {}

    def _factory(agent_type, model_id, cwd, **kwargs):
        captured["agent_type"] = agent_type
        captured["model_id"] = model_id
        captured["cwd"] = cwd
        captured.update(kwargs)
        return _DummyConnector()

    monkeypatch.setattr(server_mod, "_make_agent_connector", _factory)

    result = await server_mod.stratum_agent_run(
        prompt="hi",
        ctx=None,
        type="codex",
        write=True,
        cwd="/repo",
    )

    assert result["text"] == "ok"
    assert captured["agent_type"] == "codex"
    assert captured["cwd"] == "/repo"
    assert captured["sandbox_mode"] == "workspace-write"
