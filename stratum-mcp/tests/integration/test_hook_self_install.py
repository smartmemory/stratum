"""Tests for stdio MCP startup hook self-install (T2-HOOK-INSTALL)."""
import pytest
from pathlib import Path

from stratum_mcp.server import _HOOK_SCRIPTS


@pytest.fixture
def isolated_hooks_dir(tmp_path, monkeypatch):
    """Redirect _STRATUM_HOOKS_DIR to a temp dir so tests don't touch real ~/.stratum/."""
    hooks_dir = tmp_path / ".stratum-hooks-test"
    hooks_dir.mkdir()
    import stratum_mcp.server as srv
    monkeypatch.setattr(srv, "_STRATUM_HOOKS_DIR", hooks_dir)
    return hooks_dir


# ---------------------------------------------------------------------------
# _self_install_hooks_on_startup behavior
# ---------------------------------------------------------------------------

class TestSelfInstallHooksOnStartup:
    def test_clean_destination_installs_scripts_and_logs_stderr(
        self, isolated_hooks_dir, capsys
    ):
        """Empty hooks dir → scripts installed, one stderr line listing them, no stdout."""
        from stratum_mcp.server import _self_install_hooks_on_startup

        _self_install_hooks_on_startup()

        for script_name in _HOOK_SCRIPTS.values():
            assert (isolated_hooks_dir / script_name).exists()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "auto-installed/refreshed hook scripts" in captured.err
        for script_name in _HOOK_SCRIPTS.values():
            assert script_name in captured.err

    def test_up_to_date_destination_is_silent(self, isolated_hooks_dir, capsys):
        """Scripts already in place → silent on both stdout and stderr."""
        from stratum_mcp.server import _self_install_hooks_on_startup, _HOOKS_DIR

        for script_name in _HOOK_SCRIPTS.values():
            src = _HOOKS_DIR / script_name
            dst = isolated_hooks_dir / script_name
            dst.write_text(src.read_text())
            dst.chmod(0o755)

        _self_install_hooks_on_startup()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == ""

    def test_stale_content_is_refreshed_and_logged(self, isolated_hooks_dir, capsys):
        """Scripts present with stale content → refreshed, one stderr line."""
        from stratum_mcp.server import _self_install_hooks_on_startup, _HOOKS_DIR

        for script_name in _HOOK_SCRIPTS.values():
            dst = isolated_hooks_dir / script_name
            dst.write_text("#!/bin/bash\n# stale\n")
            dst.chmod(0o755)

        _self_install_hooks_on_startup()

        for script_name in _HOOK_SCRIPTS.values():
            src = _HOOKS_DIR / script_name
            dst = isolated_hooks_dir / script_name
            assert dst.read_text() == src.read_text()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "auto-installed/refreshed hook scripts" in captured.err

    def test_execute_bit_drift_is_repaired_and_logged(self, isolated_hooks_dir, capsys):
        """Scripts present, content matches, but not executable → re-chmodded, one stderr line."""
        from stratum_mcp.server import _self_install_hooks_on_startup, _HOOKS_DIR
        import stat

        for script_name in _HOOK_SCRIPTS.values():
            src = _HOOKS_DIR / script_name
            dst = isolated_hooks_dir / script_name
            dst.write_text(src.read_text())
            dst.chmod(0o644)

        _self_install_hooks_on_startup()

        for script_name in _HOOK_SCRIPTS.values():
            dst = isolated_hooks_dir / script_name
            assert dst.stat().st_mode & stat.S_IXUSR

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "auto-installed/refreshed hook scripts" in captured.err

    def test_mkdir_permission_error_prints_warning_and_returns(
        self, tmp_path, monkeypatch, capsys
    ):
        """Infrastructure error (mkdir denied) → stderr warning, function returns without raising."""
        from stratum_mcp.server import _self_install_hooks_on_startup
        import stratum_mcp.server as srv

        bad_hooks_dir = tmp_path / "nope.file" / "hooks"
        (tmp_path / "nope.file").write_text("not a directory")
        monkeypatch.setattr(srv, "_STRATUM_HOOKS_DIR", bad_hooks_dir)

        _self_install_hooks_on_startup()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "warning" in captured.err
        assert "could not auto-install hooks" in captured.err

    def test_missing_bundled_sources_is_silent_noop(
        self, isolated_hooks_dir, monkeypatch, capsys
    ):
        """Monkeypatch _HOOKS_DIR to empty dir → silent no-op, no error, no stderr."""
        from stratum_mcp.server import _self_install_hooks_on_startup
        import stratum_mcp.server as srv

        empty_dir = isolated_hooks_dir.parent / "empty_bundle"
        empty_dir.mkdir()
        monkeypatch.setattr(srv, "_HOOKS_DIR", empty_dir)

        _self_install_hooks_on_startup()

        captured = capsys.readouterr()
        assert captured.out == ""
        assert captured.err == ""
        for script_name in _HOOK_SCRIPTS.values():
            assert not (isolated_hooks_dir / script_name).exists()

    def test_per_script_write_failure_prints_warning(
        self, isolated_hooks_dir, monkeypatch, capsys
    ):
        """Per-script OSError surfaces as a stderr warning even when verbose=False."""
        from stratum_mcp.server import _self_install_hooks_on_startup

        scripts = list(_HOOK_SCRIPTS.values())
        bad_script_name = scripts[0]

        real_write_text = Path.write_text
        def fake_write_text(self, data, *args, **kwargs):
            if self.name == bad_script_name:
                raise OSError("simulated write failure")
            return real_write_text(self, data, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", fake_write_text)

        _self_install_hooks_on_startup()

        captured = capsys.readouterr()
        assert captured.out == ""
        # Warning should mention the failed script
        assert "warning" in captured.err
        assert "failed to install hook scripts" in captured.err
        assert bad_script_name in captured.err
        assert "simulated write failure" in captured.err
        # The other scripts were still installed → also see the "refreshed" line
        assert "auto-installed/refreshed hook scripts" in captured.err
        for script_name in scripts[1:]:
            assert script_name in captured.err


# ---------------------------------------------------------------------------
# main() branching — self-install runs only on stdio path
# ---------------------------------------------------------------------------

class TestMainSelfInstallBranching:
    def test_stdio_path_calls_self_install(self, isolated_hooks_dir, monkeypatch):
        """main() with no args → _self_install_hooks_on_startup called once before mcp.run."""
        import stratum_mcp.server as srv

        call_log: list[str] = []

        def fake_self_install():
            call_log.append("self_install")

        def fake_mcp_run(*args, **kwargs):
            call_log.append("mcp_run")

        monkeypatch.setattr(srv, "_self_install_hooks_on_startup", fake_self_install)
        monkeypatch.setattr(srv.mcp, "run", fake_mcp_run)
        monkeypatch.setattr("sys.argv", ["stratum-mcp"])

        srv.main()

        assert call_log == ["self_install", "mcp_run"]

    def test_help_cli_path_does_not_call_self_install(
        self, isolated_hooks_dir, monkeypatch, capsys
    ):
        """main() with 'help' arg → _self_install_hooks_on_startup NOT called."""
        import stratum_mcp.server as srv

        call_log: list[str] = []

        def fake_self_install():
            call_log.append("self_install")

        def fake_mcp_run(*args, **kwargs):
            call_log.append("mcp_run")

        monkeypatch.setattr(srv, "_self_install_hooks_on_startup", fake_self_install)
        monkeypatch.setattr(srv.mcp, "run", fake_mcp_run)
        monkeypatch.setattr("sys.argv", ["stratum-mcp", "help"])

        srv.main()

        assert call_log == []
