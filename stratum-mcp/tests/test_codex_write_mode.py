import pytest

from stratum_mcp.connectors.codex import CodexConnector


def _args(conn):
    return conn._exec_args("gpt-5.5", "", "/work")


def test_default_mode_is_read_only():
    conn = CodexConnector(model_id="gpt-5.5")
    assert conn.sandbox_mode == "read-only"
    a = _args(conn)
    assert a[a.index("--sandbox") + 1] == "read-only"


def test_write_mode_emits_workspace_write():
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    assert conn.sandbox_mode == "workspace-write"
    a = _args(conn)
    assert a[a.index("--sandbox") + 1] == "workspace-write"
    # No approval flag is injected.
    assert "--dangerously-bypass-approvals-and-sandbox" not in a


def test_exec_args_shape_preserved():
    # effort suffix still becomes a -c model_reasoning_effort override, prompt
    # is still read from stdin ("-" last).
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    a = conn._exec_args("gpt-5.5", "high", "/work")
    assert a[0] == "exec"
    assert a[-1] == "-"
    assert '-c' in a and 'model_reasoning_effort="high"' in a


def test_danger_full_access_rejected():
    with pytest.raises(ValueError, match="sandbox_mode"):
        CodexConnector(model_id="gpt-5.5", sandbox_mode="danger-full-access")


def test_write_plus_read_jail_rejected():
    with pytest.raises(ValueError, match="read_jail"):
        CodexConnector(
            model_id="gpt-5.5",
            sandbox_mode="workspace-write",
            read_jail="/some/staging",
        )


def test_write_plus_durable_constructs_for_gated_server_path():
    conn = CodexConnector(
        model_id="gpt-5.5",
        sandbox_mode="workspace-write",
        stream_path="/tmp/out.jsonl",
    )
    assert conn.sandbox_mode == "workspace-write"
    assert conn._durable is True
    assert conn._launch_gate_released is False


@pytest.mark.asyncio
async def test_run_init_event_reports_sandbox():
    # run() yields the init event BEFORE building argv / spawning codex, so we
    # can read it and close the generator without needing the real binary.
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    agen = conn.run("hi")
    first = await agen.__anext__()
    await agen.aclose()
    assert first["subtype"] == "init"
    assert first["sandbox"] == "workspace-write"


from stratum_mcp.connectors.factory import make_agent_connector


def test_factory_defaults_codex_read_only():
    conn = make_agent_connector("codex", "gpt-5.5", "/work")
    assert conn.sandbox_mode == "read-only"


def test_factory_threads_workspace_write():
    conn = make_agent_connector(
        "codex", "gpt-5.5", "/work", sandbox_mode="workspace-write"
    )
    assert conn.sandbox_mode == "workspace-write"


def test_factory_suffix_variant_still_gets_write():
    # A '::tier' suffix selects the codex connector by base and must still
    # receive the sandbox mode.
    conn = make_agent_connector(
        "codex::fast", "gpt-5.5", "/work", sandbox_mode="workspace-write"
    )
    assert conn.sandbox_mode == "workspace-write"


def test_factory_write_plus_read_jail_rejected():
    with pytest.raises(ValueError, match="read_jail"):
        make_agent_connector(
            "codex", "gpt-5.5", "/work",
            sandbox_mode="workspace-write", read_jail="/staging",
        )
