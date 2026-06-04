"""Isolated git worktree helpers for parallel Stratum tasks.

Each parallel task gets its own worktree under ``~/.stratum/worktrees/<flow>/<task>``
so that concurrent writes never touch the source repository directly.
"""

from __future__ import annotations

import os
import shlex
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


# ---------------------------------------------------------------------------
# COMP-PAR-MERGE-QUEUE: per-task pre-merge verify gate
# ---------------------------------------------------------------------------

def _gate_changed_files(worktree_path: Path) -> list[str]:
    """Best-effort list of files changed in the worktree (tracked + untracked).

    Used to populate a gate-failure bounce record's ``files``. Never raises —
    returns ``[]`` if git can't be queried.
    """
    common = ["-c", "core.hooksPath=/dev/null"]
    out: list[str] = []
    seen: set[str] = set()
    for argv in (
        ["git", *common, "diff", "--name-only", "HEAD"],
        ["git", *common, "ls-files", "--others", "--exclude-standard"],
    ):
        try:
            res = subprocess.run(
                argv, cwd=str(worktree_path), capture_output=True,
                check=False, timeout=30,
            )
        except Exception:
            continue
        for line in res.stdout.decode("utf-8", errors="replace").splitlines():
            f = line.strip()
            if f and f not in seen:
                seen.add(f)
                out.append(f)
    return out


def _symlink_node_modules(worktree_path: Path, base_cwd: str | None) -> None:
    """Best-effort: symlink the base repo's ``node_modules`` into the worktree.

    A bare ``git worktree add`` does not bring gitignored ``node_modules``, so
    JS gate commands (``pnpm lint``/``pnpm build``) would fail on missing deps.
    Non-fatal on any failure — other ecosystems may not need it, and a genuine
    missing-deps state is itself a legitimate gate result.
    """
    if not base_cwd:
        return
    try:
        base_nm = Path(base_cwd) / "node_modules"
        wt_nm = worktree_path / "node_modules"
        if base_nm.is_dir() and not wt_nm.exists():
            os.symlink(base_nm, wt_nm, target_is_directory=True)
    except OSError:
        pass


def run_pre_merge_gate(
    worktree_path: Path,
    commands: list[str],
    timeout: int,
    base_cwd: str | None = None,
) -> dict | None:
    """Run a parallel task's pre-merge verify gate inside its worktree.

    Each command runs in ``worktree_path`` with git hooks disabled at the call
    level (commands themselves are arbitrary) and the parent environment
    inherited (so ``PATH`` resolves ``pnpm`` etc.), bounded by ``timeout``
    seconds per command. The first command that exits non-zero — or that cannot
    be launched, or times out — returns a structured ``gate_failed`` bounce
    record (the caller stamps ``task_id``)::

        {reason: "gate_failed", command, exit_code, files, excerpt}

    All commands passing returns ``None`` (proceed to diff capture as usual).
    ``node_modules`` is best-effort symlinked from ``base_cwd`` first.
    """
    if not commands:
        return None
    _symlink_node_modules(worktree_path, base_cwd)
    for cmd in commands:
        try:
            argv = shlex.split(cmd)
        except ValueError:
            argv = [cmd]
        if not argv:
            continue
        try:
            proc = subprocess.run(
                argv,
                cwd=str(worktree_path),
                capture_output=True,
                check=False,
                timeout=timeout,
            )
        except FileNotFoundError as exc:
            return {
                "reason": "gate_failed",
                "command": cmd,
                "exit_code": 127,
                "files": _gate_changed_files(worktree_path),
                "excerpt": f"command not found: {exc}"[-2048:],
            }
        except subprocess.TimeoutExpired:
            return {
                "reason": "gate_failed",
                "command": cmd,
                "exit_code": None,
                "files": _gate_changed_files(worktree_path),
                "excerpt": f"pre_merge_verify command timed out after {timeout}s: {cmd}"[-2048:],
            }
        if proc.returncode != 0:
            out = proc.stdout.decode("utf-8", errors="replace")
            err = proc.stderr.decode("utf-8", errors="replace")
            sep = "\n" if out and err else ""
            return {
                "reason": "gate_failed",
                "command": cmd,
                "exit_code": proc.returncode,
                "files": _gate_changed_files(worktree_path),
                "excerpt": (out + sep + err)[-2048:],
            }
    return None
