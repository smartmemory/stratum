"""Tests for stratum.judge.verifier — T2 Claude-only dispatch with citation validation."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum.judge.errors import CitationFormatError
from stratum.judge.result import Evidence, Predicate
from stratum.judge.verifier import (
    CITATION_RE,
    T2_ALLOWED_TOOLS,
    T2_DISALLOWED_TOOLS,
    _validate_citations,
    evaluate_t2,
)


@pytest.fixture
def staging(tmp_path):
    (tmp_path / "artifacts").mkdir()
    (tmp_path / "modified").mkdir()
    return tmp_path


def _t2_response(verdict="met", confidence=8, predicate_id="p1", evidence=None):
    return json.dumps({
        "predicate_id": predicate_id,
        "verdict": verdict,
        "confidence": confidence,
        "reason": "looks fine",
        "evidence": evidence or [],
    })


@pytest.mark.asyncio
async def test_t2_dispatch_passes_correct_tool_surface(staging):
    (staging / "artifacts" / "x.txt").write_text("hello\nworld\n")
    fake_run = AsyncMock(return_value=_t2_response(
        evidence=[{"source": "artifacts/x.txt:1", "quote": "hello", "tier": "T2"}],
    ))
    pred = Predicate(id="p1", type="verified", statement="x is hello")

    rec, ev = await evaluate_t2(pred, staging, fake_run, ctx=None)

    fake_run.assert_awaited_once()
    kwargs = fake_run.call_args.kwargs
    assert kwargs["type"] == "claude"
    assert kwargs["allowed_tools"] == T2_ALLOWED_TOOLS
    assert kwargs["disallowed_tools"] == T2_DISALLOWED_TOOLS
    assert kwargs["cwd"] == str(staging)
    assert "Bash" in T2_DISALLOWED_TOOLS  # sanity check on the constant

    assert rec.tier == "T2"
    assert rec.verdict == "met"
    assert rec.confidence == 8
    assert len(ev) == 1
    assert ev[0].source == "artifacts/x.txt:1"


@pytest.mark.asyncio
async def test_t2_response_parsed_from_code_fenced_json(staging):
    """Realism: Claude commonly wraps JSON in ``` fences."""
    (staging / "artifacts" / "x.txt").write_text("hi\n")
    fenced = "Here is the result:\n```json\n" + _t2_response(
        evidence=[{"source": "artifacts/x.txt:1", "quote": "hi", "tier": "T2"}],
    ) + "\n```"
    fake_run = AsyncMock(return_value=fenced)
    pred = Predicate(id="p1", type="verified", statement="s")
    rec, _ = await evaluate_t2(pred, staging, fake_run, ctx=None)
    assert rec.verdict == "met"


def test_citation_regex_canonical_forms():
    assert CITATION_RE.match("artifacts/x.txt:1")
    assert CITATION_RE.match("modified/lib/auth.py:42")
    assert not CITATION_RE.match("lib/auth.py:42")           # no bucket
    assert not CITATION_RE.match("artifacts/x.txt")          # no line
    assert not CITATION_RE.match("artifacts/x.txt:abc")      # non-numeric line
    assert not CITATION_RE.match("artifacts/x:y:1")          # colon in path


def test_validate_citations_rejects_bad_format(staging):
    (staging / "artifacts" / "x.txt").write_text("hi\n")
    bad = [Evidence(source="lib/auth.py:42", quote="x", tier="T2")]
    with pytest.raises(CitationFormatError):
        _validate_citations(bad, staging)


def test_validate_citations_rejects_path_traversal(staging):
    (staging / "secret.txt").write_text("oops")
    bad = [Evidence(source="artifacts/../secret.txt:1", quote="x", tier="T2")]
    with pytest.raises(CitationFormatError):
        _validate_citations(bad, staging)


def test_validate_citations_rejects_missing_file(staging):
    bad = [Evidence(source="artifacts/ghost.txt:1", quote="x", tier="T2")]
    with pytest.raises(CitationFormatError):
        _validate_citations(bad, staging)


def test_validate_citations_accepts_valid_modified(staging):
    p = staging / "modified" / "lib" / "auth.py"
    p.parent.mkdir(parents=True)
    p.write_text("def login(): pass\n")
    good = [Evidence(source="modified/lib/auth.py:1", quote="login", tier="T2")]
    _validate_citations(good, staging)  # no raise


@pytest.mark.asyncio
async def test_t2_raises_when_citation_invalid(staging):
    (staging / "artifacts" / "x.txt").write_text("hi\n")
    fake_run = AsyncMock(return_value=_t2_response(
        evidence=[{"source": "bogus", "quote": "q", "tier": "T2"}],
    ))
    pred = Predicate(id="p1", type="verified", statement="s")
    with pytest.raises(CitationFormatError):
        await evaluate_t2(pred, staging, fake_run, ctx=None)
