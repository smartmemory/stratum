"""S05 MCP tool tests for blame_session + read_transcript_centered (CORE-CODE-PROVENANCE-1)."""

from __future__ import annotations

import json
import subprocess
from unittest.mock import MagicMock

import pytest

import stratum_mcp.server as srv

FN = "def settle(amount):\n    total = amount * 100\n    return round(total, 2)\n"


def _ctx():
    return MagicMock()


def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.com")
    _git(repo, "config", "user.name", "t")
    repo_file = repo / "billing.py"
    repo_file.write_text(FN)
    _git(repo, "add", "billing.py")
    _git(repo, "commit", "-q", "-m", "c")
    sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    return repo, sha


def _cc_author(cc, repo):
    proj = cc / "proj"
    proj.mkdir(parents=True)
    recs = [
        {"type": "assistant", "cwd": str(repo), "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "Write", "input": {"file_path": "billing.py", "content": FN}}]}},
        {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": False}]}},
    ]
    (proj / "author.jsonl").write_text("\n".join(json.dumps(r) for r in recs) + "\n")


async def test_blame_session_commit_mode(tmp_path):
    repo, sha = _repo(tmp_path)
    cc = tmp_path / "cc"
    _cc_author(cc, repo)
    res = await srv.blame_session(ctx=_ctx(), commit=sha, repo=str(repo), cc_dir=str(cc), sources="cc")
    assert res["status"] == "ok"
    assert set(res.keys()) >= {"query", "status", "matches", "ambiguous_spans", "ranked_by"}
    m = res["matches"][0]
    assert m["session_id"] == "author"
    assert m["handle"]["source"] == "cc"
    assert set(m.keys()) >= {"handle", "method", "score", "target_coverage", "authored_spans", "survival", "evidence"}


async def test_blame_session_bad_commit_is_git_error(tmp_path):
    repo, _sha = _repo(tmp_path)
    res = await srv.blame_session(ctx=_ctx(), commit="deadbeef0000", repo=str(repo), sources="cc")
    assert res["status"] == "error"
    assert res["error_type"] == "git_error"


async def test_blame_then_read_transcript_centered_chain(tmp_path):
    repo, sha = _repo(tmp_path)
    cc = tmp_path / "cc"
    _cc_author(cc, repo)
    blamed = await srv.blame_session(ctx=_ctx(), commit=sha, repo=str(repo), cc_dir=str(cc), sources="cc")
    handle = blamed["matches"][0]["handle"]
    # production CC handles live under ~/.claude/projects (resolve handle-only); the test
    # transcript is in a tmp dir, so point project_dir at it (mirrors read_centered).
    read = await srv.read_transcript_centered(
        ctx=_ctx(), source_path=handle["source_path"], line_no=handle["line_no"],
        source=handle["source"], project_dir=str(cc),
    )
    assert "window" in read and read["handle"]["source"] == "cc"
    assert read["chars_used"] <= read["char_budget"]


async def test_read_transcript_centered_codex(tmp_path):
    root = tmp_path / "sessions" / "2026" / "06" / "22"
    root.mkdir(parents=True)
    patch = "*** Begin Patch\n*** Update File: a.py\n+CODEX_MARKER\n*** End Patch"
    recs = [
        {"type": "session_meta", "payload": {"id": "019c", "cwd": "/r"}},
        {"type": "response_item", "payload": {"type": "custom_tool_call", "status": "completed", "call_id": "c1", "name": "apply_patch", "input": patch}},
    ]
    p = root / "rollout-x-019c.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    # read_transcript_centered confines codex paths to ~/.codex/sessions by default;
    # pass an explicit out-of-default path → it should error cleanly (envelope), not crash.
    res = await srv.read_transcript_centered(ctx=_ctx(), source_path=str(p), line_no=2, source="codex")
    assert res["status"] == "error" and res["error_type"] == "transcript_not_found"


async def test_read_transcript_centered_codex_success_via_tool(tmp_path):
    root = tmp_path / "sessions" / "2026" / "06" / "22"
    root.mkdir(parents=True)
    patch = "*** Begin Patch\n*** Update File: a.py\n+CODEX_OK_MARKER\n*** End Patch"
    recs = [
        {"type": "session_meta", "payload": {"id": "019c", "cwd": "/r"}},
        {"type": "response_item", "payload": {"type": "custom_tool_call", "status": "completed", "call_id": "c1", "name": "apply_patch", "input": patch}},
    ]
    p = root / "rollout-x-019c.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    res = await srv.read_transcript_centered(
        ctx=_ctx(), source_path=str(p), line_no=2, source="codex", codex_dir=str(tmp_path / "sessions")
    )
    assert "CODEX_OK_MARKER" in res["window"]
    assert res["handle"]["source"] == "codex" and res["handle"]["session_id"] == "019c"
