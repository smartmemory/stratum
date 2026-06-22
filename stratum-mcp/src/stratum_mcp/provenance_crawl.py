"""Git + filesystem orchestration for code provenance (CORE-CODE-PROVENANCE-1
Phase 1, S04). Lives in stratum-mcp (the impure layer): resolves the git target,
narrows candidate transcript sessions, runs the pure matcher, and computes
survival. The matcher (`stratum.judge.postmortem.provenance`) does no I/O.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Optional

from stratum.judge.postmortem.codex_loader import codex_session_edits, iter_codex_sessions
from stratum.judge.postmortem.loader import load_session
from stratum.judge.postmortem.provenance import (
    BlameResult,
    SessionEdits,
    TargetSpan,
    cc_session_edits,
    compute_idf,
    resolve,
    score_span,
    trigrams,
)

_ZERO = re.compile(r"^0+$")


# --------------------------------------------------------------------------- #
# git plumbing
# --------------------------------------------------------------------------- #
def _git(repo: str, *args: str, timeout: int = 10) -> Optional[subprocess.CompletedProcess]:
    try:
        return subprocess.run(
            ["git", *args], cwd=repo, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None


@dataclass
class GitTarget:
    spans: dict[str, list[TargetSpan]]
    commit: Optional[str] = None
    merge: bool = False
    uncommitted: bool = False
    error: Optional[str] = None


def _parse_diff_added(diff: str, prefix: str) -> dict[str, list[TargetSpan]]:
    """Parse a `--unified=0` unified diff into per-file added-line spans (each
    contiguous run of `+` lines = one TargetSpan with its new-file line range)."""
    spans: dict[str, list[TargetSpan]] = {}
    cur_file: Optional[str] = None
    new_line = 0
    run: list[str] = []
    run_start = 0
    counter = 0

    def _flush() -> None:
        nonlocal run, counter
        if cur_file and run:
            counter += 1
            lo, hi = run_start, run_start + len(run) - 1
            sid = f"{prefix[:8]}:{cur_file}:{lo}-{hi}:{counter}"
            spans.setdefault(cur_file, []).append(
                TargetSpan.make(file_path=cur_file, span_id=sid, line_range=(lo, hi), text="\n".join(run))
            )
        run = []

    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            _flush()
            f = raw[4:].strip()
            cur_file = None if f == "/dev/null" else (f[2:] if f.startswith("b/") else f)
        elif raw.startswith("--- ") or raw.startswith("diff --git") or raw.startswith("index ") \
                or raw.startswith("rename ") or raw.startswith("new file") or raw.startswith("deleted file") \
                or raw.startswith("similarity ") or raw.startswith("old mode") or raw.startswith("new mode"):
            _flush()
        elif raw.startswith("@@"):
            _flush()
            m = re.search(r"\+(\d+)", raw)
            new_line = int(m.group(1)) if m else 0
        elif raw.startswith("+") and not raw.startswith("+++"):
            if not run:
                run_start = new_line
            run.append(raw[1:])
            new_line += 1
        else:  # context / removal / blank → ends a run
            _flush()
    _flush()
    return spans


def git_show_added(repo: str, commit: str) -> GitTarget:
    rc = _git(repo, "rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}")
    if rc is None or rc.returncode != 0:
        return GitTarget(spans={}, commit=None, error=f"unknown commit or not a git repo: {commit}")
    parents = _git(repo, "rev-list", "--parents", "-n1", commit)
    merge = bool(parents and parents.returncode == 0 and len(parents.stdout.split()) > 2)
    show = _git(repo, "show", commit, "--first-parent", "--unified=0", "--format=")
    if show is None or show.returncode != 0:
        return GitTarget(spans={}, commit=commit, merge=merge, error="git show failed")
    return GitTarget(spans=_parse_diff_added(show.stdout, commit), commit=commit, merge=merge)


def _read_worktree_slice(repo: str, file: str, line: int, window: int) -> Optional[tuple[str, tuple[int, int]]]:
    p = (Path(repo) / file).resolve()
    try:
        p.relative_to(Path(repo).resolve())
    except ValueError:
        return None
    if not p.is_file():
        return None
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines:
        return None
    half = max(1, window // 2)
    lo = max(1, line - half)
    hi = min(len(lines), line + half)
    return "\n".join(lines[lo - 1 : hi]), (lo, hi)


def git_blame_target(repo: str, file: str, line: int, ref: str, window: int) -> GitTarget:
    # blame the WORKING TREE (no ref) so an uncommitted line is detectable (0000000 sha)
    bl = _git(repo, "blame", "-L", f"{line},{line}", "--porcelain", "--", file)
    if bl is None or bl.returncode != 0:
        return GitTarget(spans={}, commit=None, error=f"git blame failed for {file}:{line}")
    sha = bl.stdout.split()[0] if bl.stdout.strip() else ""
    if sha and _ZERO.match(sha):  # uncommitted working-tree line
        wt = _read_worktree_slice(repo, file, line, window)
        if wt is None:
            return GitTarget(spans={}, commit=None, uncommitted=True, error=f"file not readable: {file}")
        text, rng = wt
        sid = f"wt:{file}:{rng[0]}-{rng[1]}"
        return GitTarget(
            spans={file: [TargetSpan.make(file_path=file, span_id=sid, line_range=rng, text=text)]},
            commit=None,
            uncommitted=True,
        )
    if not sha:
        return GitTarget(spans={}, commit=None, error=f"git blame returned no commit for {file}:{line}")
    # porcelain header: "<sha> <orig_line> <final_line> [num]" — orig_line is the line
    # number in the blamed commit, which matches git_show_added's new-file numbering.
    parts = bl.stdout.split()
    orig_line = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else None
    gt = git_show_added(repo, sha)
    if gt.error:
        return gt
    file_spans = gt.spans.get(file, [])
    if orig_line is not None:
        # keep only the hunk CONTAINING the blamed line ("who authored THIS line"), and
        # FAIL CLOSED: if a parsed orig_line matches no added-span (blame/diff line-number
        # mismatch — e.g. the blamed line is a context line), return NO spans rather than
        # all hunks → caller maps to no_indexable_content, never a wrong-hunk attribution.
        file_spans = [s for s in file_spans if s.line_range[0] <= orig_line <= s.line_range[1]]
    return GitTarget(spans={file: file_spans}, commit=sha, merge=gt.merge)


def git_file_at(repo: str, ref: str, file: str) -> Optional[str]:
    r = _git(repo, "show", f"{ref}:{file}")
    if r is None or r.returncode != 0:
        return None
    return r.stdout


# --------------------------------------------------------------------------- #
# candidate narrowing
# --------------------------------------------------------------------------- #
def iter_cc_sessions(cc_dir: str | Path) -> Iterator[Path]:
    yield from sorted(Path(cc_dir).rglob("*.jsonl"))


def _realpath(p: str | None) -> Optional[str]:
    if not p:
        return None
    try:
        return str(Path(p).resolve())
    except OSError:
        return None


def _cwd_in_repo(cwd: Optional[str], repo_real: str) -> bool:
    c = _realpath(cwd)
    if c is None:
        return False
    return c == repo_real or c.startswith(repo_real + "/") or repo_real.startswith(c + "/")


def _touched(se: SessionEdits, target_files: set[str]) -> bool:
    for e in se.edits:
        for tf in target_files:
            a, b = e.file_path, tf
            if a == b or a.endswith("/" + b) or b.endswith("/" + a):
                return True
    return False


def narrow_candidates(
    repo: str, target_files: set[str], sources: tuple[str, ...], cc_dir: Optional[str], codex_dir: Optional[str]
) -> list[SessionEdits]:
    repo_real = str(Path(repo).resolve())
    cands: list[SessionEdits] = []
    if "cc" in sources and cc_dir:
        for p in iter_cc_sessions(cc_dir):
            try:
                se = cc_session_edits(load_session(p))
            except Exception:
                continue
            if se.edits and _cwd_in_repo(se.cwd, repo_real) and _touched(se, target_files):
                se.repo = repo_real
                cands.append(se)
    if "codex" in sources and codex_dir:
        for p in iter_codex_sessions(codex_dir):
            se = codex_session_edits(p)
            if se and se.edits and _cwd_in_repo(se.cwd, repo_real) and _touched(se, target_files):
                se.repo = repo_real
                cands.append(se)
    return cands


# --------------------------------------------------------------------------- #
# survival (span-scoped, per file)
# --------------------------------------------------------------------------- #
def _fill_survival(match, repo: str, ref: str, span_by_id: dict[str, TargetSpan]) -> None:
    """Survival scoped to the spans this match actually WON (via span_id), not all
    of the file's target spans — so a same-file multi-author commit reports each
    match's own survival."""
    auth_by_file: dict[str, set[str]] = {}
    for sp in match.authored_spans:
        ts = span_by_id.get(sp.get("span_id"))
        if ts is not None:
            auth_by_file.setdefault(ts.file_path, set()).update(ts.trigrams)
    by_file: list[dict[str, Any]] = []
    tot_inter = tot_auth = 0
    for f, auth in auth_by_file.items():
        head = git_file_at(repo, ref, f)
        if head is None:  # file absent at ref → 0 survival, not an error
            by_file.append({"file": f, "authored_grams": len(auth), "surviving_grams": 0, "ratio": 0.0})
            tot_auth += len(auth)
            continue
        inter = auth & trigrams(head)
        ratio = (len(inter) / len(auth)) if auth else None
        by_file.append({"file": f, "authored_grams": len(auth), "surviving_grams": len(inter), "ratio": ratio})
        tot_inter += len(inter)
        tot_auth += len(auth)
    match.survival = {"overall": (tot_inter / tot_auth) if tot_auth else None, "by_file": by_file}


# --------------------------------------------------------------------------- #
# orchestrator
# --------------------------------------------------------------------------- #
def blame(
    *,
    commit: Optional[str] = None,
    file: Optional[str] = None,
    line: Optional[int] = None,
    repo: str,
    ref: str = "HEAD",
    cc_dir: Optional[str] = None,
    codex_dir: Optional[str] = None,
    sources: tuple[str, ...] = ("cc", "codex"),
    top_k: int = 5,
    window: int = 40,
    min_score: float = 0.2,
    margin_delta: float = 0.1,
) -> dict[str, Any]:
    """Resolve commit/file:line → authoring session(s). Raises ValueError on a git
    error (bad commit / not a repo) so the MCP layer emits a `git_error` envelope —
    distinct from a valid-but-empty target (`no_indexable_content`)."""
    if commit:
        gt = git_show_added(repo, commit)
        query: dict[str, Any] = {"mode": "commit", "commit": commit, "repo": repo, "ref": ref}
        if gt.merge:
            query["merge"] = True
    elif file and line:
        gt = git_blame_target(repo, file, int(line), ref, window)
        query = {"mode": "file_line", "file": file, "line": int(line), "repo": repo, "ref": ref}
        if gt.uncommitted:
            query["uncommitted"] = True
    else:
        raise ValueError("provide either `commit`, or `file` + `line`")

    if gt.error:
        raise ValueError(gt.error)  # → MCP {status:"error", error_type:"git_error"}

    # Drop non-indexable spans (whitespace-only / sub-3-char additions). If nothing
    # indexable remains, the target is valid-but-empty → no_indexable_content (NOT
    # no_overlap, which means "indexable target, no authoring session found").
    spans = [s for file_spans in gt.spans.values() for s in file_spans if s.indexable]
    if not spans:
        status = "merge_no_direct_changes" if gt.merge else "no_indexable_content"
        return BlameResult(query=query, status=status, matches=[], ambiguous_spans=[]).to_dict()

    target_files = {s.file_path for s in spans}
    candidates = narrow_candidates(repo, target_files, sources, cc_dir, codex_dir)
    idf = compute_idf(candidates)
    per_span: dict[str, list] = {}
    for span in spans:
        for c in candidates:
            sm = score_span(span, c, idf)
            if sm is not None:
                per_span.setdefault(span.span_id, []).append(sm)

    res = resolve(spans=spans, per_span=per_span, query=query, min_score=min_score, margin_delta=margin_delta)
    span_by_id = {s.span_id: s for s in spans}
    for m in res.matches:
        _fill_survival(m, repo, ref, span_by_id)
    res.matches = res.matches[:top_k]
    return res.to_dict()
