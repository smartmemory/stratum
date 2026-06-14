"""STRAT-DISTILL orchestrator — load → detect → synthesize → stage.

Shared by the CLI (`cli.py`) and the MCP tool (`stratum_distill`). Stateless and
side-effect-light: only effect is appending staged candidates to the distill
sidecar (when ``write=True`` and candidates exist).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from stratum.judge.distill.detector import detect
from stratum.judge.distill.synthesize import LlmForm, synthesize
from stratum.judge.postmortem.corpus import append_distill_candidates, distill_sidecar_path
from stratum.judge.postmortem.loader import Session, iter_sessions


def load_sessions(project_dir: Path | str, *, window_days: Optional[int] = None) -> list[Session]:
    """Load sessions for a Claude Code project dir, optionally filtered to the
    last ``window_days`` by source-file mtime. Missing dir → empty list."""
    p = Path(project_dir)
    if not p.exists():
        return []
    sessions = list(iter_sessions(p))
    if window_days:
        cutoff = time.time() - window_days * 86400
        kept: list[Session] = []
        for s in sessions:
            try:
                if s.source_path.stat().st_mtime >= cutoff:
                    kept.append(s)
            except OSError:
                kept.append(s)  # fail-open: keep if mtime unreadable
        return kept
    return sessions


def run_distill(
    project_dir: Path | str,
    *,
    out_path: Optional[Path | str] = None,
    min_count: int = 2,
    window_days: int = 30,
    project: str = "",
    llm_form: Optional[LlmForm] = None,
    write: bool = True,
) -> dict:
    """Mine a project's transcripts for repeated workflows and stage candidates.

    Returns ``{candidates, evaluated, written, reason, out_path}``. ``evaluated``
    is the number of detected workflows; ``written`` is rows appended to the
    sidecar. An empty result ("nothing to distill") is a valid, successful run.
    """
    sessions = load_sessions(project_dir, window_days=window_days)
    workflows = detect(sessions, min_count=min_count)

    candidates = []
    for wf in workflows:
        cand = synthesize(wf, llm_form=llm_form, min_count=min_count)
        if cand is not None:
            candidates.append(cand)

    # Default sidecar lives under the *current workspace* (cwd) — the convention
    # stratum/compose use for "the project being worked on" — NOT the transcript
    # source dir (which is global, ~/.claude/projects/<hash>). Callers (CLI, MCP
    # tool) pass an explicit out_path to be unambiguous.
    out = Path(out_path) if out_path else distill_sidecar_path(Path.cwd())
    written = 0
    if write and candidates:
        written = append_distill_candidates(out, candidates, project=project or Path(project_dir).name)

    reason = (
        "nothing to distill — no repeated workflow worth packaging"
        if not candidates
        else f"{len(candidates)} candidate(s) staged from {len(sessions)} session(s)"
    )
    return {
        "candidates": [c.to_dict() for c in candidates],
        "evaluated": len(workflows),
        "written": written,
        "reason": reason,
        "out_path": str(out),
    }
