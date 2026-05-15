"""T1 deterministic-predicate evaluation.

T1 compiles a predicate's ``statement`` and evaluates it against a tiny,
explicit namespace that is rebound to operate over the staged turn tree:

  * ``file_exists(path)`` / ``file_contains(path, substring)`` resolve
    ``path`` under ``staging_root`` and require the prefix ``artifacts/``
    or ``modified/``. Other prefixes raise :class:`PredicatePathError`.
  * The pure builtins (``len``, ``min``, ``max``, ``bool``, ``int``, ``str``)
    are exposed as-is.

Names outside this v1 surface (``vocabulary_compliance``,
``plan_completion``, ``no_file_conflicts``, or anything undefined) surface
as :class:`PredicateBuiltinError` — not raw ``NameError`` — so callers can
key on the typed contract.

Non-deterministic predicates (``verified``/``judged``) short-circuit to a
:class:`TierRecord` with ``verdict='n/a'`` so the kernel can branch into T2
without T1 producing a misleading "checked" record.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path

from .errors import PredicateBuiltinError, PredicatePathError
from .result import Predicate, TierRecord


# Explicit T1 v1 surface. Functions that take paths are rebound per-call
# (closures over staging_root); pure-data builtins are stable references.
_PATHFUL_BUILTINS = {"file_exists", "file_contains"}
_PURE_BUILTINS = {"len", "min", "max", "bool", "int", "str"}
T1_SUPPORTED_NAMES = _PATHFUL_BUILTINS | _PURE_BUILTINS


def evaluate_t1(
    predicate: Predicate,
    staging_root: str,
    artifacts: dict[str, str],
    modified_files: list[str],
) -> TierRecord:
    """Run T1 over ``predicate``.

    For ``type='deterministic'``: validate path prefixes, build a chrooted
    namespace, evaluate, and return ``met``/``not_met``.

    For ``type='verified'``/``'judged'``: return ``verdict='n/a'`` — these
    require an interpretive tier.
    """
    if predicate.type != "deterministic":
        return TierRecord(
            tier="T1",
            verdict="n/a",
            confidence=None,
            reason="non-deterministic predicate",
        )

    # AST-walk pathful builtins to enforce the artifacts/ | modified/ prefix
    # BEFORE any I/O. This is the layer that makes T1's truth surface match
    # T2's: predicates can never reach the live workspace through T1.
    _validate_paths(predicate.statement)

    namespace = _build_t1_namespace(staging_root)

    try:
        code = compile(predicate.statement, "<t1>", "eval")
        result = eval(code, {"__builtins__": {}}, namespace)
    except (PredicatePathError, PredicateBuiltinError):
        # Typed judge errors signal predicate malformation; surface them.
        raise
    except NameError as exc:
        # Unknown name → most often a builtin outside the v1 surface.
        raise PredicateBuiltinError(
            f"predicate '{predicate.id}' uses name not in T1 v1 surface: {exc}"
        ) from exc
    except Exception as exc:
        # Genuine eval failure (TypeError, ValueError, etc.). The predicate
        # was decidable but the expression itself failed — design Decision 3
        # treats anything not-passing as not_met.
        return TierRecord(
            tier="T1",
            verdict="not_met",
            confidence=10,
            reason=f"t1 eval raised: {exc}",
        )

    verdict = "met" if bool(result) else "not_met"
    return TierRecord(
        tier="T1",
        verdict=verdict,
        confidence=10,
        reason="deterministic check",
    )


# ---------------------------------------------------------------------------
# Path-prefix enforcement (AST walk over the predicate statement).
# ---------------------------------------------------------------------------


def _validate_paths(statement: str) -> None:
    """Walk the AST and reject any pathful-builtin call whose first
    string-literal argument lacks the ``artifacts/`` or ``modified/`` prefix.
    """
    try:
        tree = ast.parse(statement, mode="eval")
    except SyntaxError:
        # Let the actual eval raise so it can be classified normally.
        return

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not isinstance(func, ast.Name):
            continue
        if func.id not in _PATHFUL_BUILTINS:
            continue
        if not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and isinstance(first.value, str):
            path = first.value
            if not (path.startswith("artifacts/") or path.startswith("modified/")):
                raise PredicatePathError(
                    f"deterministic predicate references path outside staging tree: "
                    f"{path!r} (expected prefix 'artifacts/' or 'modified/')"
                )


# ---------------------------------------------------------------------------
# Namespace builder — pathful builtins are rebound per staging root.
# ---------------------------------------------------------------------------


def _build_t1_namespace(staging_root: str) -> dict:
    root = Path(staging_root)

    def _rebind(rel: str) -> Path:
        """Resolve a predicate-supplied relative path under the staging
        root. Re-checks the prefix at call time as a defence-in-depth
        layer in case a non-literal path argument slipped past the
        AST walk (e.g. concatenation, formatted string).
        """
        if not (rel.startswith("artifacts/") or rel.startswith("modified/")):
            raise PredicatePathError(
                f"runtime path rejected: {rel!r} (expected 'artifacts/' or 'modified/')"
            )
        return root / rel

    def file_exists(path: str) -> bool:
        return _rebind(path).is_file()

    def file_contains(path: str, substring: str) -> bool:
        full = _rebind(path)
        if not full.is_file():
            return False
        try:
            with full.open(encoding="utf-8", errors="replace") as f:
                return substring in f.read()
        except OSError:
            return False

    return {
        "file_exists": file_exists,
        "file_contains": file_contains,
        "len": len,
        "min": min,
        "max": max,
        "bool": bool,
        "int": int,
        "str": str,
    }
