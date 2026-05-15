"""Tests for stratum.judge.predicates — T1 deterministic evaluation."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum.judge.errors import PredicateBuiltinError, PredicatePathError
from stratum.judge.predicates import evaluate_t1
from stratum.judge.result import Predicate


def _staged(tmp_path, artifacts=None, modified=None):
    """Build a minimal staged turn directory."""
    artifacts = artifacts or {}
    modified = modified or {}
    art_dir = tmp_path / "artifacts"
    art_dir.mkdir()
    for name, content in artifacts.items():
        (art_dir / name).write_text(content)
    mod_dir = tmp_path / "modified"
    mod_dir.mkdir()
    for rel, content in modified.items():
        p = mod_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    return tmp_path


# ---------------------------------------------------------------------------
# Non-deterministic predicates short-circuit to n/a.
# ---------------------------------------------------------------------------


def test_verified_predicate_returns_na(tmp_path):
    p = Predicate(id="v1", type="verified", statement="True")
    staging = _staged(tmp_path)
    rec = evaluate_t1(p, str(staging), {}, [])
    assert rec.tier == "T1"
    assert rec.verdict == "n/a"
    assert rec.confidence is None


def test_judged_predicate_returns_na(tmp_path):
    p = Predicate(id="j1", type="judged", statement="True")
    staging = _staged(tmp_path)
    rec = evaluate_t1(p, str(staging), {}, [])
    assert rec.verdict == "n/a"
    assert rec.confidence is None


# ---------------------------------------------------------------------------
# Path-prefix enforcement.
# ---------------------------------------------------------------------------


def test_artifact_path_resolves_under_staging(tmp_path):
    staging = _staged(tmp_path, artifacts={"out.txt": "hello world"})
    p = Predicate(
        id="d1", type="deterministic",
        statement="file_exists('artifacts/out.txt')",
    )
    rec = evaluate_t1(p, str(staging), {"out": "hello world"}, [])
    assert rec.verdict == "met"
    assert rec.confidence == 10


def test_modified_path_resolves_under_staging(tmp_path):
    staging = _staged(tmp_path, modified={"lib/auth.py": "def login(): pass\n"})
    p = Predicate(
        id="d2", type="deterministic",
        statement="file_contains('modified/lib/auth.py', 'def login')",
    )
    rec = evaluate_t1(p, str(staging), {}, ["lib/auth.py"])
    assert rec.verdict == "met"


def test_workspace_rooted_path_raises_path_error(tmp_path):
    staging = _staged(tmp_path)
    p = Predicate(
        id="d3", type="deterministic",
        statement="file_exists('lib/auth.py')",
    )
    with pytest.raises(PredicatePathError):
        evaluate_t1(p, str(staging), {}, [])


def test_absolute_path_raises_path_error(tmp_path):
    staging = _staged(tmp_path)
    p = Predicate(
        id="d4", type="deterministic",
        statement="file_contains('/etc/passwd', 'root')",
    )
    with pytest.raises(PredicatePathError):
        evaluate_t1(p, str(staging), {}, [])


# ---------------------------------------------------------------------------
# Builtin surface — v1 explicit subset.
# ---------------------------------------------------------------------------


def test_supported_builtins_pure_functions(tmp_path):
    staging = _staged(tmp_path, artifacts={"x.txt": "abcdef"})
    cases = [
        "len('abc') == 3",
        "max(1, 2) == 2",
        "min(1, 2) == 1",
        "bool(1) == True",
        "int('42') == 42",
        "str(1) == '1'",
    ]
    for stmt in cases:
        p = Predicate(id="b", type="deterministic", statement=stmt)
        rec = evaluate_t1(p, str(staging), {}, [])
        assert rec.verdict == "met", f"failed: {stmt}"


def test_unsupported_builtin_raises_builtin_error(tmp_path):
    """vocabulary_compliance / plan_completion / no_file_conflicts are NOT in T1 v1."""
    staging = _staged(tmp_path)
    for name in ("vocabulary_compliance", "plan_completion", "no_file_conflicts"):
        p = Predicate(
            id="u", type="deterministic",
            statement=f"{name}([])",
        )
        with pytest.raises(PredicateBuiltinError):
            evaluate_t1(p, str(staging), {}, [])


def test_unknown_name_raises_builtin_error(tmp_path):
    """Any undefined name surfaces as PredicateBuiltinError, not raw NameError."""
    staging = _staged(tmp_path)
    p = Predicate(
        id="u", type="deterministic",
        statement="totally_made_up_name(1)",
    )
    with pytest.raises(PredicateBuiltinError):
        evaluate_t1(p, str(staging), {}, [])


# ---------------------------------------------------------------------------
# Evaluation-failure handling.
# ---------------------------------------------------------------------------


def test_eval_failure_returns_not_met(tmp_path):
    """A TypeError mid-eval → not_met with reason. Not raised."""
    staging = _staged(tmp_path)
    p = Predicate(
        id="bad", type="deterministic",
        statement="len(1)",  # int has no len
    )
    rec = evaluate_t1(p, str(staging), {}, [])
    assert rec.verdict == "not_met"
    assert "t1 eval raised" in rec.reason


def test_false_expression_yields_not_met(tmp_path):
    staging = _staged(tmp_path, artifacts={"out.txt": "hello"})
    p = Predicate(
        id="d", type="deterministic",
        statement="file_contains('artifacts/out.txt', 'goodbye')",
    )
    rec = evaluate_t1(p, str(staging), {}, [])
    assert rec.verdict == "not_met"
    assert rec.confidence == 10


def test_file_exists_chrooted_under_staging(tmp_path):
    """file_exists() must NOT see real cwd files; only staging tree."""
    staging = _staged(tmp_path)  # empty artifacts dir
    p = Predicate(
        id="d", type="deterministic",
        statement="file_exists('artifacts/nope.txt')",
    )
    rec = evaluate_t1(p, str(staging), {}, [])
    assert rec.verdict == "not_met"
