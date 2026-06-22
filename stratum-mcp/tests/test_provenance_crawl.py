"""S04 git/crawl orchestration tests (CORE-CODE-PROVENANCE-1 Phase 1).

Uses a real `tmp_path` git repo + synthetic CC transcripts.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from stratum_mcp.provenance_crawl import (
    blame,
    git_blame_target,
    git_file_at,
    git_show_added,
    narrow_candidates,
)

FN_ALPHA = "def alpha(x):\n    total = x * 2\n    return total + 99\n"
FN_BRAVO = "def bravo(y):\n    acc = y - 7\n    return acc * acc\n"


def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "t@t.com")
    _git(repo, "config", "user.name", "t")
    _git(repo, "config", "commit.gpgsign", "false")
    return repo


def _commit(repo, file, content, msg="c"):
    (repo / file).write_text(content)
    _git(repo, "add", file)
    _git(repo, "commit", "-q", "-m", msg)
    return _git(repo, "rev-parse", "HEAD").stdout.strip()


def _cc_session(cc_dir, sid, cwd, edits):
    """edits: list of (file_path, new_string). Writes a CC transcript whose
    tool_use Edits succeed."""
    proj = cc_dir / "proj"
    proj.mkdir(parents=True, exist_ok=True)
    records = []
    for i, (fp, ns) in enumerate(edits, start=1):
        tid = f"t{i}"
        records.append({"type": "assistant", "cwd": str(cwd), "message": {"content": [
            {"type": "tool_use", "id": tid, "name": "Edit", "input": {"file_path": fp, "old_string": "", "new_string": ns}}]}})
        records.append({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": tid, "is_error": False}]}})
    (proj / f"{sid}.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")


# --------------------------------------------------------------------------- #
# git helpers
# --------------------------------------------------------------------------- #
def test_git_show_added_parses_spans(tmp_path):
    repo = _repo(tmp_path)
    sha = _commit(repo, "a.py", FN_ALPHA)
    gt = git_show_added(str(repo), sha)
    assert gt.error is None and not gt.merge
    assert "a.py" in gt.spans
    joined = "\n".join(s.text for s in gt.spans["a.py"])
    assert "def alpha(x):" in joined and "return total + 99" in joined


def test_git_error_unknown_commit_and_non_repo(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    assert git_show_added(str(repo), "deadbeefdeadbeef").error is not None
    non_repo = tmp_path / "plain"
    non_repo.mkdir()
    assert git_show_added(str(non_repo), "HEAD").error is not None
    # bad commit -> blame() raises ValueError (becomes git_error envelope at the tool)
    with pytest.raises(ValueError):
        blame(commit="deadbeefdeadbeef", repo=str(repo))


def test_merge_commit_detected_and_attributed_via_first_parent(tmp_path):
    # A merge is detected (query.merge=True) and its first-parent diff is attributed
    # to the session that authored the merged-in change (not silently dropped).
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    default = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    _git(repo, "checkout", "-q", "-b", "feature")
    _commit(repo, "b.py", FN_BRAVO)
    _git(repo, "checkout", "-q", default)
    _commit(repo, "c.py", "def cee():\n    return 30000\n")
    _git(repo, "merge", "-q", "--no-ff", "feature", "-m", "merge")
    merge_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    cc = tmp_path / "cc"
    _cc_session(cc, "feat_author", repo, [("b.py", FN_BRAVO)])
    res = blame(commit=merge_sha, repo=str(repo), cc_dir=str(cc), sources=("cc",))
    assert res["query"].get("merge") is True
    assert res["status"] == "ok"
    assert res["matches"][0]["session_id"] == "feat_author"


def test_blame_target_uncommitted_reads_worktree(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    # append an UNCOMMITTED line in the working tree
    (repo / "a.py").write_text(FN_ALPHA + "WORKTREE_ONLY_LINE = 1\n")
    gt = git_blame_target(str(repo), "a.py", 4, "HEAD", window=10)  # line 4 = the new uncommitted line
    assert gt.uncommitted is True and gt.error is None
    assert "WORKTREE_ONLY_LINE" in "\n".join(s.text for fs in gt.spans.values() for s in fs)


def test_git_file_at_absent_returns_none(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    assert git_file_at(str(repo), "HEAD", "a.py") is not None
    assert git_file_at(str(repo), "HEAD", "nope.py") is None


# --------------------------------------------------------------------------- #
# blame() end-to-end
# --------------------------------------------------------------------------- #
def test_blame_commit_mode_finds_authoring_session(tmp_path):
    repo = _repo(tmp_path)
    sha = _commit(repo, "a.py", FN_ALPHA)
    cc = tmp_path / "cc"
    _cc_session(cc, "author", repo, [("a.py", FN_ALPHA)])
    _cc_session(cc, "unrelated", repo, [("z.py", "def zed():\n    return 0\n")])
    res = blame(commit=sha, repo=str(repo), cc_dir=str(cc), sources=("cc",))
    assert res["status"] == "ok"
    assert [m["session_id"] for m in res["matches"]] == ["author"]
    m = res["matches"][0]
    assert m["handle"]["source"] == "cc"
    assert m["target_coverage"] > 0
    assert m["survival"]["overall"] == 1.0  # fully survives at HEAD


def test_blame_file_line_mode(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    cc = tmp_path / "cc"
    _cc_session(cc, "author", repo, [("a.py", FN_ALPHA)])
    res = blame(file="a.py", line=1, repo=str(repo), cc_dir=str(cc), sources=("cc",))
    assert res["status"] == "ok"
    assert res["matches"][0]["session_id"] == "author"
    assert res["query"]["mode"] == "file_line"


def test_no_captured_author_is_no_overlap(tmp_path):
    repo = _repo(tmp_path)
    sha = _commit(repo, "a.py", FN_ALPHA)
    cc = tmp_path / "cc"
    # a session in the repo, but it authored a DIFFERENT file → no overlap for a.py
    _cc_session(cc, "other", repo, [("b.py", FN_BRAVO)])
    res = blame(commit=sha, repo=str(repo), cc_dir=str(cc), sources=("cc",))
    assert res["status"] == "no_overlap"


def test_whitespace_only_commit_is_no_indexable_content(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    (repo / "a.py").write_text(FN_ALPHA + "\n\n   \n\t\n")  # only blank/whitespace lines added
    _git(repo, "add", "a.py")
    _git(repo, "commit", "-q", "-m", "ws")
    sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
    res = blame(commit=sha, repo=str(repo), sources=("cc",))
    assert res["status"] == "no_indexable_content"  # not no_overlap


def test_file_line_targets_only_the_containing_hunk(tmp_path):
    # one commit adds TWO separate hunks (FN_ALPHA before, FN_BRAVO after an anchor);
    # blaming a line in the BRAVO hunk must attribute only bravo's author.
    repo = _repo(tmp_path)
    _commit(repo, "a.py", "ANCHOR = 1\n")
    new = FN_ALPHA + "ANCHOR = 1\n" + FN_BRAVO  # FN_ALPHA = lines 1-3, ANCHOR = 4, FN_BRAVO = 5-7
    _commit(repo, "a.py", new)
    cc = tmp_path / "cc"
    _cc_session(cc, "alpha_auth", repo, [("a.py", FN_ALPHA)])
    _cc_session(cc, "bravo_auth", repo, [("a.py", FN_BRAVO)])
    res = blame(file="a.py", line=5, repo=str(repo), cc_dir=str(cc), sources=("cc",))  # line 5 = def bravo
    assert res["status"] == "ok"
    assert {m["session_id"] for m in res["matches"]} == {"bravo_auth"}


def test_narrow_candidates_requires_repo_and_touch(tmp_path):
    repo = _repo(tmp_path)
    _commit(repo, "a.py", FN_ALPHA)
    cc = tmp_path / "cc"
    _cc_session(cc, "in_repo", repo, [("a.py", FN_ALPHA)])
    _cc_session(cc, "other_repo", tmp_path / "elsewhere", [("a.py", FN_ALPHA)])  # cwd not in repo
    cands = narrow_candidates(str(repo), {"a.py"}, ("cc",), str(cc), None)
    assert {c.session_id for c in cands} == {"in_repo"}
    assert all(c.repo == str(repo.resolve()) for c in cands)
