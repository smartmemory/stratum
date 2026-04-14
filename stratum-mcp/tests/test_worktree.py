"""Tests for stratum_mcp.worktree — isolated git worktree helper."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from stratum_mcp.worktree import (
    STRATUM_WT_ROOT,
    WorktreeError,
    create_worktree,
    remove_worktree,
)


def _init_git_repo(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "t@t"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=path, check=True)
    (path / "README").write_text("x")
    subprocess.run(["git", "add", "README"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=path, check=True)


def test_create_worktree_in_real_git_repo(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)

    src = tmp_path / "src"
    _init_git_repo(src)

    target = create_worktree("flow1", "task1", str(src))

    assert target.exists()
    # worktrees have a .git file (not directory) pointing back to the main repo
    assert (target / ".git").exists()


def test_create_worktree_outside_git_raises_WorktreeError(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)

    not_a_repo = tmp_path / "not_a_repo"
    not_a_repo.mkdir()

    with pytest.raises(WorktreeError) as excinfo:
        create_worktree("flow1", "task1", str(not_a_repo))

    assert "git worktree add" in str(excinfo.value)


def test_remove_worktree_cleans_up(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)

    src = tmp_path / "src"
    _init_git_repo(src)

    target = create_worktree("flow1", "task1", str(src))
    assert target.exists()

    remove_worktree(target)
    assert not target.exists()


def test_remove_worktree_idempotent_when_missing(tmp_path):
    # No exception expected; silent no-op.
    remove_worktree(tmp_path / "nonexistent")


def test_worktree_root_isolated_from_repo(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)

    src = tmp_path / "src"
    _init_git_repo(src)

    target = create_worktree("flow1", "task1", str(src))

    expected_root = home / ".stratum" / "worktrees"
    resolved_target = target.resolve()
    resolved_root = expected_root.resolve()
    resolved_src = src.resolve()

    # Must live under the stratum worktree root.
    assert resolved_root in resolved_target.parents or resolved_target == resolved_root
    # Must NOT be anywhere inside the source repo tree.
    assert resolved_src not in resolved_target.parents
    assert resolved_target != resolved_src
