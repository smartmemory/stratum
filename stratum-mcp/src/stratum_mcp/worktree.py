"""Isolated git worktree helpers for parallel Stratum tasks.

Each parallel task gets its own worktree under ``~/.stratum/worktrees/<flow>/<task>``
so that concurrent writes never touch the source repository directly.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# NOTE: ``Path.home()`` is resolved lazily inside each function so tests can
# monkeypatch ``Path.home`` to redirect the worktree root into a temp dir.
STRATUM_WT_ROOT = Path.home() / ".stratum" / "worktrees"


class WorktreeError(Exception):
    """Raised when a git worktree operation cannot be completed."""


def _wt_root() -> Path:
    """Resolve the worktree root lazily so tests can monkeypatch ``Path.home``."""
    return Path.home() / ".stratum" / "worktrees"


def create_worktree(flow_id: str, task_id: str, base_cwd: str) -> Path:
    """Create an isolated git worktree for a parallel task.

    Runs ``git worktree add --detach <target> HEAD`` with ``cwd=base_cwd`` and a
    30s timeout. The target path is ``~/.stratum/worktrees/<flow_id>/<task_id>``
    — never inside the source repo.

    Raises :class:`WorktreeError` when ``base_cwd`` is not a git repo, when git
    fails for any other reason, or when the subprocess times out.
    """
    target = _wt_root() / flow_id / task_id
    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(target), "HEAD"],
            cwd=base_cwd,
            capture_output=True,
            check=True,
            timeout=30,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise WorktreeError(f"git worktree add failed: {stderr}") from exc
    except subprocess.TimeoutExpired as exc:
        raise WorktreeError("git worktree add timed out after 30s") from exc

    return target


def remove_worktree(path: Path, force: bool = True) -> None:
    """Remove a worktree directory.

    Runs ``git worktree remove [--force] <path>``. If git refuses (non-zero
    exit) or errors for any reason, falls back to ``shutil.rmtree`` with
    ``ignore_errors=True``. No-op when ``path`` does not exist. Never raises.
    """
    if not path.exists():
        return

    cmd = ["git", "worktree", "remove"]
    if force:
        cmd.append("--force")
    cmd.append(str(path))

    try:
        result = subprocess.run(cmd, capture_output=True, check=False)
        if result.returncode != 0:
            shutil.rmtree(path, ignore_errors=True)
    except Exception:
        shutil.rmtree(path, ignore_errors=True)


def capture_worktree_diff(path: Path) -> str:
    """Return a unified diff of a worktree vs HEAD, including untracked files.

    Runs ``git add -A`` (to stage all working-tree changes) then
    ``git diff --cached HEAD``. Both calls use ``-c core.hooksPath=/dev/null``
    to prevent parent-repo pre-commit hooks from firing in the ephemeral worktree.

    ``git add -A`` respects ``.gitignore`` — files matching parent-repo ignore
    rules are excluded.

    Returns empty string if there are no changes. Raises CalledProcessError
    or TimeoutExpired on subprocess failure; caller is responsible for
    swallowing exceptions if needed.
    """
    common = ["-c", "core.hooksPath=/dev/null"]
    subprocess.run(
        ["git", *common, "add", "-A"],
        cwd=path,
        capture_output=True,
        check=True,
        timeout=30,
    )
    result = subprocess.run(
        ["git", *common, "diff", "--cached", "HEAD"],
        cwd=path,
        capture_output=True,
        check=True,
        timeout=30,
    )
    return result.stdout.decode("utf-8", errors="replace")
