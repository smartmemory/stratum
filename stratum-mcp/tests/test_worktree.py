"""Tests for stratum_mcp.worktree — isolated git worktree helper."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from stratum_mcp.worktree import (
    STRATUM_WT_ROOT,
    WorktreeError,
    capture_worktree_diff,
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


def _init_repo_with_file(tmp_path: Path, filename: str = "a.txt", content: str = "hello\n") -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    (repo / filename).write_text(content)
    subprocess.run(["git", "add", filename], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    return repo


def test_capture_diff_empty_when_no_changes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-1", str(repo))
    try:
        assert capture_worktree_diff(wt) == ""
    finally:
        remove_worktree(wt)


def test_capture_diff_includes_modified_file(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    repo = _init_repo_with_file(tmp_path, "a.txt", "one\n")
    wt = create_worktree("flow-1", "task-2", str(repo))
    try:
        (wt / "a.txt").write_text("one\ntwo\n")
        diff = capture_worktree_diff(wt)
        assert "+two" in diff
        assert "diff --git" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_includes_untracked_file(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-3", str(repo))
    try:
        (wt / "new.txt").write_text("fresh\n")
        diff = capture_worktree_diff(wt)
        assert "new.txt" in diff
        assert "+fresh" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_handles_binary_file(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    repo = _init_repo_with_file(tmp_path)
    wt = create_worktree("flow-1", "task-4", str(repo))
    try:
        (wt / "blob.bin").write_bytes(b"\x00\x01\x02\xffhello\x00world")
        diff = capture_worktree_diff(wt)
        assert "blob.bin" in diff
    finally:
        remove_worktree(wt)


def test_capture_diff_respects_gitignore(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    repo = _init_repo_with_file(tmp_path)
    (repo / ".gitignore").write_text("ignored.txt\n")
    subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "ignore"], cwd=repo, check=True)
    wt = create_worktree("flow-1", "task-5", str(repo))
    try:
        (wt / "ignored.txt").write_text("secret\n")
        (wt / "kept.txt").write_text("public\n")
        diff = capture_worktree_diff(wt)
        assert "ignored.txt" not in diff
        assert "kept.txt" in diff
    finally:
        remove_worktree(wt)


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
