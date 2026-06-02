"""Tests for STRAT-GUARD trusted-evidence evaluator (S3)."""

import asyncio
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum_mcp.guard import evidence as ev
from stratum_mcp.guard.errors import EvidenceParseError
from stratum_mcp.guard.store import LedgerEntry


def _run(coro):
    return asyncio.run(coro)


# ---- parser --------------------------------------------------------------- #


def test_parse_valid():
    name, args = ev.parse_predicate_statement("server_file_exists('a/b.txt')")
    assert name == "server_file_exists"
    assert args == ["a/b.txt"]


def test_parse_list_arg():
    name, args = ev.parse_predicate_statement("command_exit_zero(['pytest', '-q'])")
    assert name == "command_exit_zero"
    assert args == [["pytest", "-q"]]


def test_parse_rejects_unknown_builtin():
    with pytest.raises(EvidenceParseError):
        ev.parse_predicate_statement("os_system('rm -rf /')")


def test_parse_rejects_non_literal():
    with pytest.raises(EvidenceParseError):
        ev.parse_predicate_statement("server_file_exists(foo)")


def test_statement_is_trusted():
    assert ev.statement_is_trusted("git_commit_exists('abc')")
    assert not ev.statement_is_trusted("len(x) > 0")  # LLM/T1 expr, not a trusted builtin


# ---- server_file_exists --------------------------------------------------- #


def test_server_file_exists(tmp_path):
    (tmp_path / "design.md").write_text("hi")
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "type": "deterministic", "statement": "server_file_exists('design.md')"}],
            str(tmp_path),
            [],
        )
    )
    assert res.met is True


def test_server_file_missing(tmp_path):
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "server_file_exists('nope.md')"}], str(tmp_path), []
        )
    )
    assert res.met is False


def test_server_file_traversal_blocked(tmp_path):
    (tmp_path.parent / "secret.txt").write_text("s")
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "server_file_exists('../secret.txt')"}], str(tmp_path), []
        )
    )
    assert res.met is False
    assert "escapes" in res.per_predicate[0]["evidence"]


# ---- git_commit_exists ---------------------------------------------------- #


@pytest.fixture
def git_repo(tmp_path):
    def run(*args):
        subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, check=True)
    run("init", "-q")
    run("config", "user.email", "t@t.io")
    run("config", "user.name", "t")
    (tmp_path / "f.txt").write_text("x")
    run("add", "f.txt")
    run("commit", "-q", "-m", "init")
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, capture_output=True, text=True
    ).stdout.strip()
    return tmp_path, sha


def test_git_commit_exists(git_repo):
    repo, sha = git_repo
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": f"git_commit_exists('{sha}')"}], str(repo), []
        )
    )
    assert res.met is True


def test_git_commit_absent(git_repo):
    repo, _sha = git_repo
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "git_commit_exists('0000000000000000000000000000000000000000')"}],
            str(repo),
            [],
        )
    )
    assert res.met is False


# ---- command_exit_zero ---------------------------------------------------- #


def test_command_exit_zero_disabled_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("STRATUM_GUARD_ALLOW_COMMANDS", raising=False)
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "command_exit_zero(['true'])"}], str(tmp_path), []
        )
    )
    assert res.met is False
    assert "disabled" in res.per_predicate[0]["evidence"]


def test_command_exit_zero_runs_when_enabled(tmp_path, monkeypatch):
    monkeypatch.setenv("STRATUM_GUARD_ALLOW_COMMANDS", "1")
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "command_exit_zero(['true'])"}], str(tmp_path), []
        )
    )
    assert res.met is True
    res2 = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "command_exit_zero(['false'])"}], str(tmp_path), []
        )
    )
    assert res2.met is False


# ---- verdict_receipt_clean ------------------------------------------------ #


def test_verdict_receipt_clean(tmp_path):
    entry = LedgerEntry(
        ts_ms=1, from_state="a", to_state="b", outcome="applied", kind="transition",
        entry_digest="abc123",
    )
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "verdict_receipt_clean('abc123')"}], None, [entry]
        )
    )
    assert res.met is True


def test_verdict_receipt_absent(tmp_path):
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "verdict_receipt_clean('missing')"}], None, []
        )
    )
    assert res.met is False


def test_file_evidence_without_workspace_fails(tmp_path):
    res = _run(
        ev.evaluate_evidence(
            [{"id": "p", "statement": "server_file_exists('x')"}], None, []
        )
    )
    assert res.met is False
    assert "workspace_root" in res.per_predicate[0]["evidence"]
