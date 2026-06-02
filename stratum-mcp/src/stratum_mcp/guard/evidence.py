"""Server-side trusted-evidence predicate evaluator (S3).

CRITICAL (blueprint C1): these predicates are NOT evaluated in the judge T1 jail
(``predicates.py`` runs ``eval`` over a read-only staged snapshot with no real fs /
git / subprocess). Trusted evidence means *the guard server reads the file / runs
the command / resolves the git object itself*, server-side, at the registered
``workspace_root``. So we evaluate them here, by an explicit 4-builtin allowlist —
parsed with ``ast`` (never ``eval``) — not by extending the sandbox namespace.

Supported builtins:
  * ``server_file_exists('rel/path')``      — file under workspace_root (traversal-guarded)
  * ``git_commit_exists('<sha>')``           — real git object in workspace_root
  * ``command_exit_zero(['cmd', 'arg'])``    — opt-in; real exit code, timeout-capped
  * ``verdict_receipt_clean('<entry_digest>')`` — prior applied/clean ledger entry
"""

from __future__ import annotations

import ast
import asyncio
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .errors import EvidenceParseError

TRUSTED_BUILTINS = {
    "server_file_exists",
    "git_commit_exists",
    "command_exit_zero",
    "verdict_receipt_clean",
}

_DEFAULT_CMD_TIMEOUT = 120


@dataclass
class EvidenceResult:
    met: bool
    per_predicate: list[dict[str, Any]] = field(default_factory=list)


def _cmd_timeout() -> int:
    try:
        return int(os.environ.get("STRATUM_GUARD_CMD_TIMEOUT_S", str(_DEFAULT_CMD_TIMEOUT)))
    except ValueError:
        return _DEFAULT_CMD_TIMEOUT


def commands_allowed() -> bool:
    return os.environ.get("STRATUM_GUARD_ALLOW_COMMANDS", "") == "1"


def parse_predicate_statement(statement: str) -> tuple[str, list[Any]]:
    """Parse ``name(literal, ...)`` into (name, [literal args]). No eval.

    Rejects anything that is not a single call to one of TRUSTED_BUILTINS with
    constant/list-of-constant arguments.
    """
    try:
        tree = ast.parse(statement, mode="eval")
    except SyntaxError as exc:
        raise EvidenceParseError(f"cannot parse predicate {statement!r}: {exc}")
    node = tree.body
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        raise EvidenceParseError(f"predicate must be a single call: {statement!r}")
    name = node.func.id
    if name not in TRUSTED_BUILTINS:
        raise EvidenceParseError(f"unknown trusted builtin {name!r} in {statement!r}")
    if node.keywords:
        raise EvidenceParseError(f"keyword args not allowed: {statement!r}")
    args: list[Any] = []
    for a in node.args:
        try:
            args.append(ast.literal_eval(a))
        except (ValueError, SyntaxError):
            raise EvidenceParseError(
                f"predicate args must be literals: {statement!r}"
            )
    return name, args


def statement_is_trusted(statement: str) -> bool:
    """True if the statement is a recognised trusted-evidence builtin call."""
    try:
        parse_predicate_statement(statement)
        return True
    except EvidenceParseError:
        return False


def statement_uses_command(statement: str) -> bool:
    try:
        name, _ = parse_predicate_statement(statement)
    except EvidenceParseError:
        return False
    return name == "command_exit_zero"


def _resolve_under(workspace_root: Path, rel: str) -> Optional[Path]:
    """Resolve ``rel`` under workspace_root, refusing traversal escapes."""
    base = workspace_root.resolve()
    target = (base / rel).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target


def _eval_server_file_exists(workspace_root: Path, args: list[Any]) -> tuple[bool, str]:
    if len(args) != 1 or not isinstance(args[0], str):
        return False, "server_file_exists expects one string path"
    target = _resolve_under(workspace_root, args[0])
    if target is None:
        return False, f"path escapes workspace_root: {args[0]!r}"
    return (target.is_file(), f"{args[0]} {'exists' if target.is_file() else 'missing'}")


def _eval_git_commit_exists(workspace_root: Path, args: list[Any]) -> tuple[bool, str]:
    if len(args) != 1 or not isinstance(args[0], str):
        return False, "git_commit_exists expects one sha string"
    sha = args[0]
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"],
            cwd=str(workspace_root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return False, f"git rev-parse failed: {exc}"
    ok = result.returncode == 0
    return ok, f"commit {sha[:12]} {'present' if ok else 'absent'}"


def _eval_command_exit_zero(workspace_root: Path, args: list[Any]) -> tuple[bool, str]:
    if not commands_allowed():
        # Should be caught at registration; defence in depth at eval time.
        return False, "command execution disabled (set STRATUM_GUARD_ALLOW_COMMANDS=1)"
    if len(args) != 1 or not isinstance(args[0], list) or not all(
        isinstance(x, str) for x in args[0]
    ):
        return False, "command_exit_zero expects one list[str]"
    cmd = args[0]
    if not cmd:
        return False, "empty command"
    try:
        result = subprocess.run(
            cmd,
            cwd=str(workspace_root),
            capture_output=True,
            text=True,
            timeout=_cmd_timeout(),
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        return False, f"command failed: {exc}"
    ok = result.returncode == 0
    return ok, f"{cmd[0]} exited {result.returncode}"


def _eval_verdict_receipt_clean(
    args: list[Any], ledger_entries: list[Any]
) -> tuple[bool, str]:
    if len(args) != 1 or not isinstance(args[0], str):
        return False, "verdict_receipt_clean expects one digest string"
    digest = args[0]
    for entry in ledger_entries:
        if getattr(entry, "entry_digest", None) == digest and getattr(
            entry, "outcome", None
        ) in ("applied", "review_clean"):
            return True, f"receipt {digest[:12]} found (clean)"
    return False, f"no clean receipt for {digest[:12]}"


async def evaluate_evidence(
    predicates: list[dict[str, Any]],
    workspace_root: Optional[str],
    ledger_entries: list[Any],
) -> EvidenceResult:
    """Evaluate every trusted-evidence predicate server-side. AND semantics.

    Predicates whose ``type`` is an LLM tier (``verified``/``judged``) are skipped
    here — the caller routes those through ``run_judge``.
    """
    per: list[dict[str, Any]] = []
    all_met = True
    wr = Path(workspace_root).resolve() if workspace_root else None

    for p in predicates:
        statement = p.get("statement", "")
        name, args = parse_predicate_statement(statement)  # may raise EvidenceParseError
        if name in ("server_file_exists", "git_commit_exists", "command_exit_zero") and wr is None:
            met, reason = False, "no workspace_root registered for trusted file/command/git evidence"
        elif name == "server_file_exists":
            met, reason = await asyncio.to_thread(_eval_server_file_exists, wr, args)
        elif name == "git_commit_exists":
            met, reason = await asyncio.to_thread(_eval_git_commit_exists, wr, args)
        elif name == "command_exit_zero":
            met, reason = await asyncio.to_thread(_eval_command_exit_zero, wr, args)
        else:  # verdict_receipt_clean
            met, reason = _eval_verdict_receipt_clean(args, ledger_entries)

        per.append(
            {
                "id": p.get("id"),
                "statement": statement,
                "met": met,
                "evidence": reason,
            }
        )
        all_met = all_met and met

    return EvidenceResult(met=all_met, per_predicate=per)
