"""Source-aware centered transcript reader (CORE-CODE-PROVENANCE-1 Phase 1, S03).

`read_transcript_centered` makes the blame -> read-the-conversation chain work for
BOTH Claude Code and Codex handles. The existing `read_centered` is CC-only
(confined to ``~/.claude/projects`` and only renders CC record types); a Codex
handle resolves under ``~/.codex/sessions`` and is rendered by a Codex-aware
renderer. Both reuse the source-agnostic budget walk (`center_over_rendered`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

from stratum.judge.postmortem.codex_loader import resolve_codex_path
from stratum.judge.postmortem.loader import (
    _render_record_line,
    _resolve_transcript_path,
    center_over_rendered,
)


def _render_codex_record_line(raw: str) -> str:
    """Render one Codex rollout JSONL record to readable text (the parallel of
    loader._render_record_line for the Codex shape). Unknown/noise records → ""
    while still occupying a line slot so line_no stays exact."""
    try:
        rec = json.loads(raw)
    except (ValueError, TypeError):
        return ""
    top = rec.get("type")
    pl = rec.get("payload") or {}
    if top == "session_meta":
        return f"[session_meta] id={pl.get('id')} cwd={pl.get('cwd')}"
    if top == "event_msg":
        msg = pl.get("message") or pl.get("text")
        return msg if isinstance(msg, str) else ""
    if top == "response_item":
        pt = pl.get("type")
        if pt == "custom_tool_call" and pl.get("name") == "apply_patch":
            return f"[apply_patch]\n{pl.get('input', '')}"
        if pt == "function_call":
            return f"[{pl.get('name', 'call')}] {pl.get('arguments', '')}"
        if pt in ("message", "reasoning"):
            content = pl.get("content")
            if isinstance(content, list):
                parts = [c.get("text", "") for c in content if isinstance(c, dict)]
                return "\n".join(p for p in parts if p)
            if isinstance(content, str):
                return content
    return ""


def read_transcript_centered(
    source_path: str | Path,
    line_no: int,
    source: str = "cc",
    char_budget: int = 20000,
    before_ratio: float = 0.3,
    after_ratio: float = 0.7,
    cursor: Optional[dict] = None,
    *,
    project_dir: str | Path | None = None,
    codex_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Centered window of a transcript around ``line_no``, for ``source`` in
    {"cc","codex"}. Returns the same shape as ``read_centered`` but with a
    source-aware handle ``{source, source_path, session_id, line_no}``."""
    if source == "cc":
        path = _resolve_transcript_path(source_path, project_dir)
        session_id = path.stem
        with path.open("r", encoding="utf-8") as fh:
            rendered = [_render_record_line(raw) for raw in fh]
    elif source == "codex":
        path = resolve_codex_path(source_path, codex_dir=codex_dir)
        session_id: Optional[str] = None
        rendered = []
        with path.open("r", encoding="utf-8") as fh:
            for raw in fh:
                rendered.append(_render_codex_record_line(raw))
                if session_id is None:
                    try:
                        rec = json.loads(raw)
                        if rec.get("type") == "session_meta":
                            session_id = (rec.get("payload") or {}).get("id")
                    except (ValueError, TypeError):
                        pass
        session_id = session_id or path.stem
    else:
        raise ValueError(f"unknown source {source!r} (expected 'cc' or 'codex')")

    r = center_over_rendered(rendered, line_no, char_budget, before_ratio, after_ratio, cursor)
    return {
        "window": r["window"],
        "handle": {"source": source, "source_path": str(path), "session_id": session_id, "line_no": r["center"]},
        "continue_cursor": r["continue_cursor"],
        "chars_used": r["chars_used"],
        "char_budget": r["char_budget"],
    }
