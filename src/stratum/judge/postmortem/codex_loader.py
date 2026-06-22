"""Codex rollout reader for code provenance (CORE-CODE-PROVENANCE-1 Phase 1, S02).

Reads Codex rollout JSONL (``~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl``) and
extracts the authored text of successful ``apply_patch`` edits into the same
`SessionEdits`/`AuthorshipEvidence` shape the CC extractor produces, so the pure
matcher (S01) is format-agnostic.

Codex specifics (verified against the real corpus): edits are
``response_item`` / ``custom_tool_call`` / ``name:"apply_patch"`` records carrying
an inline ``status:"completed"`` + ``call_id`` and a V4A diff ``input``; the paired
``custom_tool_call_output`` (by ``call_id``) holds success inside a JSON-string
``output`` (``metadata.exit_code`` / ``"Success"`` prefix). ``apply_patch`` is rare
in the wild (most Codex edits use shell ``exec_command``, out of scope), so a
rollout with no successful patch yields ``None`` and is simply not a candidate.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator, Optional

from stratum.judge.postmortem.provenance import AuthorshipEvidence, SessionEdits


def _codex_root() -> Path:
    return Path.home() / ".codex" / "sessions"


def resolve_codex_path(source_path: str | Path, codex_dir: str | Path | None = None) -> Path:
    """Confine a Codex rollout path under ``~/.codex/sessions`` (symlink-safe);
    raise ``ValueError`` on escape or non-rollout file."""
    root = (Path(codex_dir) if codex_dir else _codex_root()).resolve()
    p = Path(source_path).resolve()
    try:
        p.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path escapes codex sessions root: {source_path}") from exc
    if not p.name.endswith(".jsonl"):
        raise ValueError(f"not a rollout jsonl: {source_path}")
    return p


def iter_codex_sessions(codex_dir: str | Path) -> Iterator[Path]:
    yield from sorted(Path(codex_dir).rglob("rollout-*.jsonl"))


def _output_success(output: Any) -> Optional[bool]:
    """Parse the JSON-string `custom_tool_call_output.output`; True/False on a clear
    signal, None when unknown/malformed (inline status then decides, never a crash)."""
    if not isinstance(output, str):
        return None
    try:
        d = json.loads(output)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    md = d.get("metadata") or {}
    if isinstance(md, dict) and isinstance(md.get("exit_code"), int):
        return md["exit_code"] == 0
    o = d.get("output")
    if isinstance(o, str):
        return o.lstrip().startswith("Success")
    return None


def parse_apply_patch(v4a: str) -> list[tuple[str, str, str]]:
    """Parse a V4A ``apply_patch`` input into ``(file_path, op, added_text)`` for
    each Add/Update block. ``*** Delete File:`` is recognized and skipped (no
    authored text). ``added_text`` is the ``+`` lines (leading ``+`` stripped)."""
    results: list[tuple[str, str, str]] = []
    cur_file: Optional[str] = None
    cur_op: Optional[str] = None
    cur_lines: list[str] = []

    def _flush() -> None:
        nonlocal cur_file, cur_op, cur_lines
        if cur_file is not None and cur_op in ("add", "update") and cur_lines:
            results.append((cur_file, cur_op, "\n".join(cur_lines)))
        cur_lines = []

    for raw in v4a.splitlines():
        if raw.startswith("*** Add File:"):
            _flush()
            cur_file, cur_op = raw[len("*** Add File:") :].strip(), "add"
        elif raw.startswith("*** Update File:"):
            _flush()
            cur_file, cur_op = raw[len("*** Update File:") :].strip(), "update"
        elif raw.startswith("*** Delete File:"):
            _flush()
            cur_file, cur_op = raw[len("*** Delete File:") :].strip(), "delete"
        elif raw.startswith("*** Move to:"):  # rename target — keep op, retarget path
            cur_file = raw[len("*** Move to:") :].strip()
        elif raw.startswith("*** Begin Patch") or raw.startswith("*** End Patch"):
            _flush()
        elif raw.startswith("@@"):
            continue  # hunk marker
        elif raw.startswith("+") and not raw.startswith("+++"):
            cur_lines.append(raw[1:])
        # context (' '), removals ('-'), '---', and other lines are ignored
    _flush()
    return results


def codex_session_edits(path: str | Path) -> Optional[SessionEdits]:
    """Extract successful apply_patch authored blocks from a Codex rollout. Returns
    None when there is no session_meta or no successful patch (so the session is
    simply absent from the candidate set)."""
    p = Path(path)
    session_id: Optional[str] = None
    cwd: Optional[str] = None
    calls: list[tuple[int, Optional[str], str, Optional[str]]] = []  # (line_no, call_id, input, inline_status)
    outputs: dict[str, Optional[bool]] = {}

    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except (FileNotFoundError, OSError):
        return None
    for idx, raw in enumerate(text.splitlines(), start=1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except (ValueError, TypeError):
            continue
        top = rec.get("type")
        pl = rec.get("payload") or {}
        if top == "session_meta":
            session_id = pl.get("id")
            cwd = pl.get("cwd")
        elif top == "response_item" and pl.get("type") == "custom_tool_call" and pl.get("name") == "apply_patch":
            calls.append((idx, pl.get("call_id"), pl.get("input") or "", pl.get("status")))
        elif top == "response_item" and pl.get("type") == "custom_tool_call_output":
            cid = pl.get("call_id")
            if cid:
                outputs[cid] = _output_success(pl.get("output"))

    if session_id is None:
        return None

    edits: list[AuthorshipEvidence] = []
    for line_no, call_id, inp, inline_status in calls:
        if inline_status != "completed":  # primary success signal
            continue
        if outputs.get(call_id or "") is False:  # explicit failure in the paired output
            continue
        for file_path, _op, block_text in parse_apply_patch(inp):
            if not block_text:
                continue
            edits.append(
                AuthorshipEvidence.make(
                    source="codex",
                    source_path=str(p),
                    session_id=session_id,
                    line_no=line_no,
                    tool_ref=call_id,
                    timestamp=None,
                    file_path=file_path,
                    op="apply_patch",
                    block_text=block_text,
                )
            )

    if not edits:
        return None  # #11: no successful patch → not a candidate
    return SessionEdits(
        source="codex", source_path=str(p), session_id=session_id, cwd=cwd, repo=None, edits=edits
    )
