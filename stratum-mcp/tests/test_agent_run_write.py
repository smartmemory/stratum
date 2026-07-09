import pytest

from stratum_mcp.server import _resolve_sandbox_mode, _codex_write_allowed


def test_default_no_write_is_read_only():
    assert _resolve_sandbox_mode("codex", False, None) == "read-only"


def test_codex_write_resolves_workspace_write(monkeypatch):
    monkeypatch.delenv("STRATUM_CODEX_ALLOW_WRITE", raising=False)
    assert _resolve_sandbox_mode("codex", True, "/repo") == "workspace-write"


def test_write_on_claude_is_rejected():
    with pytest.raises(ValueError, match="type='codex'"):
        _resolve_sandbox_mode("claude", True, "/repo")


def test_write_requires_cwd():
    with pytest.raises(ValueError, match="cwd"):
        _resolve_sandbox_mode("codex", True, None)
    with pytest.raises(ValueError, match="cwd"):
        _resolve_sandbox_mode("codex", True, "   ")


@pytest.mark.parametrize("val", ["0", "false", "no", "off", "FALSE"])
def test_kill_switch_disables_write(monkeypatch, val):
    monkeypatch.setenv("STRATUM_CODEX_ALLOW_WRITE", val)
    assert _codex_write_allowed() is False
    with pytest.raises(ValueError, match="STRATUM_CODEX_ALLOW_WRITE"):
        _resolve_sandbox_mode("codex", True, "/repo")


@pytest.mark.parametrize("val", ["1", "true", "yes", "on"])
def test_kill_switch_enabled_values(monkeypatch, val):
    monkeypatch.setenv("STRATUM_CODEX_ALLOW_WRITE", val)
    assert _codex_write_allowed() is True


def test_absent_env_means_enabled(monkeypatch):
    monkeypatch.delenv("STRATUM_CODEX_ALLOW_WRITE", raising=False)
    assert _codex_write_allowed() is True
