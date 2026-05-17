"""STRAT-JUDGE-T3-READJAIL — read-jail profile generator + probe.

The OS-enforcement proof (a real confined process being denied a read)
lives in test_judge_readjail.py; this file covers the pure profile/probe
surface.
"""

from __future__ import annotations

import os
import re

import pytest

from stratum.judge import sandbox


def test_read_jail_unavailable_today_even_on_darwin(monkeypatch):
    """Honest by construction: the live gate falsified codex-exec under
    sandbox-exec (nested Seatbelt), so the probe is False even where
    sandbox-exec is present — paranoid degrades to Claude cold-read."""
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/sandbox-exec")
    assert sandbox._sandbox_exec_present() is True
    assert sandbox.read_jail_available() is False  # gated on verified flag


def test_read_jail_true_only_when_verified_and_present(monkeypatch):
    """When a non-nesting primitive lands and the flag flips, the probe
    activates — wiring is correct, only empirically gated today."""
    monkeypatch.setattr(sandbox.sys, "platform", "darwin")
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/sandbox-exec")
    monkeypatch.setattr(sandbox, "_CODEX_READJAIL_VERIFIED", True)
    assert sandbox.read_jail_available() is True
    monkeypatch.setattr(sandbox.sys, "platform", "linux")
    assert sandbox.read_jail_available() is False


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
