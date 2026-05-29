"""STRAT-JUDGE-T3-READJAIL — read-jail profile generator + probe.

The OS-enforcement proof (a real confined process being denied a read)
lives in test_judge_readjail.py; this file covers the pure profile/probe
surface.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

from stratum.judge import sandbox


# ── STRAT-JUDGE-T3-READJAIL-CODEXNEST: probe semantics moved off the
# falsified `sandbox-exec`-wrapping onto the JailDriver seam. These two
# tests are RETARGETED (the asserted invariants are preserved verbatim on
# the symbol that now owns them — SandboxExecJailDriver for the inert
# Seatbelt semantics, DockerJailDriver / read_jail_available for the live
# probe), never weakened.


def test_sandbox_exec_driver_unavailable_even_on_darwin(monkeypatch):
    """Verbatim old `test_read_jail_unavailable_today_even_on_darwin`
    invariant, now on its owner: the Seatbelt driver is unavailable even
    where sandbox-exec is present, because `_CODEX_READJAIL_VERIFIED`
    stays False forever (the parent live gate falsified nested Seatbelt)."""
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/sandbox-exec")
    assert sandbox._sandbox_exec_present() is True
    assert sandbox._CODEX_READJAIL_VERIFIED is False
    assert sandbox.SandboxExecJailDriver().available() is False
    # And it is never the selected codex driver regardless.
    assert not isinstance(
        sandbox.select_jail_driver(), sandbox.SandboxExecJailDriver
    )


def test_sandbox_exec_driver_semantics_when_flag_flipped(monkeypatch):
    """Verbatim old darwin-True / linux-False Seatbelt semantics, now on
    SandboxExecJailDriver — proves the wiring stayed correct even though
    the flag is (and stays) False in production."""
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/sandbox-exec")
    monkeypatch.setattr(sandbox, "_CODEX_READJAIL_VERIFIED", True)
    assert sandbox.SandboxExecJailDriver().available() is True
    monkeypatch.setattr(sandbox.sys, "platform", "linux")
    assert sandbox.SandboxExecJailDriver().available() is False


def test_read_jail_available_tracks_docker_driver(monkeypatch):
    """`read_jail_available()` now reflects the selectable JailDriver
    (Docker). False unless docker present AND the Docker-lane live-gate
    flag is flipped; True only when both — and never via the inert
    Seatbelt flag (proves the two flags are not conflated)."""
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/local/bin/docker")
    # Seatbelt flag must NOT enable the Docker lane.
    monkeypatch.setattr(sandbox, "_CODEX_READJAIL_VERIFIED", True)
    monkeypatch.setattr(sandbox, "_docker_readjail_verified", lambda: False)
    assert sandbox.read_jail_available() is False
    assert sandbox.select_jail_driver() is None

    monkeypatch.setattr(sandbox, "_docker_readjail_verified", lambda: True)
    assert sandbox.read_jail_available() is True
    drv = sandbox.select_jail_driver()
    assert isinstance(drv, sandbox.DockerJailDriver)

    # No docker binary → unavailable again (static capability gate).
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: None)
    assert sandbox.read_jail_available() is False
    assert sandbox.select_jail_driver() is None


def test_sandbox_exec_present_off_darwin(monkeypatch):
    monkeypatch.setattr(sandbox.sys, "platform", "linux")
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/sandbox-exec")
    assert sandbox._sandbox_exec_present() is False


def test_profile_is_deny_default_with_single_evidence_allow(tmp_path):
    allow = tmp_path / "turn-1"
    allow.mkdir()
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    prof = sandbox.build_seatbelt_profile(allow, scratch)

    assert prof.startswith("(version 1)\n(deny default)")
    assert '(import "system.sb")' in prof
    # exactly one evidence read-allow line for the staged tree
    evidence_lines = [
        ln for ln in prof.splitlines()
        if ln.strip() == f'(allow file-read* (subpath "{os.path.realpath(allow)}"))'
    ]
    assert len(evidence_lines) == 1
    # scratch is the only writable subtree
    assert f'(allow file-write* file-read* (subpath "{os.path.realpath(scratch)}"))' in prof


@pytest.mark.skipif(
    sys.platform != "darwin",
    reason="exercises macOS /tmp -> /private/tmp symlink canonicalization; "
    "Linux has no such symlink (Seatbelt is macOS-only anyway)",
)
def test_profile_realresolves_paths(tmp_path, monkeypatch):
    # /tmp -> /private/tmp canonicalization must happen at generation.
    prof = sandbox.build_seatbelt_profile("/tmp/nope-not-real-xyz", tmp_path)
    assert '(subpath "/tmp/nope-not-real-xyz")' not in prof
    assert '(subpath "/private/tmp/nope-not-real-xyz")' in prof


def test_profile_allows_codex_home_for_auth(tmp_path):
    prof = sandbox.build_seatbelt_profile(tmp_path, tmp_path)
    codex_home = os.path.realpath(os.path.expanduser("~/.codex"))
    assert f'(subpath "{codex_home}")' in prof


def test_materialize_profile_yields_then_unlinks(tmp_path):
    seen = {}
    with sandbox.materialize_profile(tmp_path, tmp_path) as p:
        seen["path"] = p
        assert os.path.exists(p)
        assert p.endswith(".sb")
    assert not os.path.exists(seen["path"])


def test_materialize_profile_unlinks_on_exception(tmp_path):
    captured = {}
    with pytest.raises(RuntimeError):
        with sandbox.materialize_profile(tmp_path, tmp_path) as p:
            captured["path"] = p
            assert os.path.exists(p)
            raise RuntimeError("boom")
    assert not os.path.exists(captured["path"])
