"""Tests for `stratum-mcp doctor` — install/environment diagnostics (stratum#1)."""
from __future__ import annotations

import pytest

from stratum_mcp.doctor import (
    FAIL,
    OK,
    WARN,
    Probe,
    _cmd_doctor,
    evaluate,
    gather_probe,
)


def _probe(**overrides) -> Probe:
    """A healthy probe; override individual fields per test."""
    base = dict(
        python_version=(3, 11, 9),
        executable="/usr/bin/python3.11",
        which_stratum="/usr/bin/stratum-mcp",
        installed_version="0.2.50",
        installed_location="/usr/lib/python3.11/site-packages",
        has_console_script=True,
        path_python="/usr/bin/python3.11",
    )
    base.update(overrides)
    return Probe(**base)


def _by_name(report, name):
    return next(c for c in report.checks if c.name == name)


def _names(report):
    return [c.name for c in report.checks]


# ---------------------------------------------------------------------------
# healthy baseline
# ---------------------------------------------------------------------------

def test_healthy_environment_passes():
    report = evaluate(_probe())
    assert report.ok
    assert _by_name(report, "python-version").status == OK
    assert _by_name(report, "package-installed").status == OK
    assert _by_name(report, "binary-on-path").status == OK


# ---------------------------------------------------------------------------
# concern 1 — Python < 3.11
# ---------------------------------------------------------------------------

def test_old_python_fails_with_actionable_fix():
    report = evaluate(_probe(python_version=(3, 9, 13)))
    c = _by_name(report, "python-version")
    assert c.status == FAIL
    assert "3.9.13" in c.detail
    assert "3.11" in c.detail
    assert c.fix and "pyenv" in c.fix
    assert not report.ok


def test_python_312_passes():
    report = evaluate(_probe(python_version=(3, 12, 1)))
    assert _by_name(report, "python-version").status == OK


# ---------------------------------------------------------------------------
# concern 3 — installed-vs-binary diagnostics
# ---------------------------------------------------------------------------

def test_not_installed_fails():
    report = evaluate(
        _probe(
            installed_version=None,
            installed_location=None,
            has_console_script=False,
            which_stratum=None,
        )
    )
    assert _by_name(report, "package-installed").status == FAIL
    assert _by_name(report, "binary-on-path").status == FAIL
    assert "not installed" in _by_name(report, "binary-on-path").detail.lower()
    assert not report.ok


def test_installed_but_no_binary_on_path():
    # classic pyenv-shim / PATH mismatch: package present, console script declared,
    # but the binary isn't reachable on the active shell PATH.
    report = evaluate(_probe(which_stratum=None))
    assert _by_name(report, "package-installed").status == OK
    c = _by_name(report, "binary-on-path")
    assert c.status == FAIL
    assert "PATH" in c.detail
    assert c.fix and "ln -sf" in c.fix
    assert not report.ok


# ---------------------------------------------------------------------------
# concern 2 — shadowing vendored build with no console script
# ---------------------------------------------------------------------------

def test_shadow_build_without_console_script_detected():
    report = evaluate(
        _probe(installed_version="0.3.0", has_console_script=False, which_stratum=None)
    )
    c = _by_name(report, "binary-on-path")
    assert c.status == FAIL
    assert "console script" in c.detail.lower()
    assert "0.3.0" in c.detail
    assert c.fix and "uninstall" in c.fix
    assert not report.ok


# ---------------------------------------------------------------------------
# interpreter mismatch (warn, non-fatal)
# ---------------------------------------------------------------------------

def test_interpreter_mismatch_warns_but_does_not_fail():
    report = evaluate(
        _probe(path_python="/opt/pyenv/versions/3.9.13/bin/python")
    )
    c = _by_name(report, "interpreter")
    assert c.status == WARN
    assert "/opt/pyenv/versions/3.9.13/bin/python" in c.detail
    assert report.ok  # warn alone never fails the report


def test_no_interpreter_check_when_paths_match():
    report = evaluate(_probe())
    # when the active python matches the doctor interpreter there is no
    # spurious mismatch warning
    assert "interpreter" not in _names(report) or (
        _by_name(report, "interpreter").status != WARN
    )


# ---------------------------------------------------------------------------
# wiring — gather_probe + _cmd_doctor run against the real environment
# ---------------------------------------------------------------------------

def test_gather_probe_returns_well_formed_probe():
    p = gather_probe()
    assert isinstance(p.python_version, tuple) and len(p.python_version) == 3
    assert all(isinstance(x, int) for x in p.python_version)
    assert isinstance(p.executable, str) and p.executable


def test_cmd_doctor_prints_report_and_exits(capsys):
    with pytest.raises(SystemExit) as exc:
        _cmd_doctor()
    out = capsys.readouterr().out
    assert "stratum-mcp doctor" in out
    assert "python" in out.lower()
    assert exc.value.code in (0, 1)
