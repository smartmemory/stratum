"""Claude Code session JSONL → canonical Event stream.

Strips noise (permission events, hook attachments, file-history snapshots,
sidechain subagent turns, queue ops) and normalises user/assistant/system turns
into a uniform Event shape that downstream segmenter/signals modules consume.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator, Literal

EventKind = Literal["user_text", "assistant_text", "tool_use", "tool_result", "system"]


@dataclass(frozen=True)
class Event:
    """A normalised event from a session transcript.

    `line_no` is 1-indexed within the source JSONL; together with `session_id`
    it uniquely identifies the source line for replay / debugging.
    """

    session_id: str
    line_no: int
    timestamp: str
    kind: EventKind
    text: str = ""
    tool_name: str | None = None
    tool_input: dict[str, Any] | None = None
    tool_use_id: str | None = None
    tool_result_status: Literal["ok", "error"] | None = None


@dataclass
class Session:
    session_id: str
    source_path: Path
    events: list[Event] = field(default_factory=list)
    byte_size: int = 0
    cwd: str | None = None


_KEEP_TOP_LEVEL_TYPES = {"user", "assistant", "system"}


def _extract_text_blocks(content: Any) -> list[str]:
    """Pull plain-text chunks out of a message.content payload."""
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    out: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            t = block.get("text")
            if isinstance(t, str) and t:
                out.append(t)
    return out


def _normalise_tool_result_content(content: Any) -> tuple[str, Literal["ok", "error"]]:
    """Flatten a tool_result block's content into a single text string + status."""
    status: Literal["ok", "error"] = "ok"
    if isinstance(content, str):
        return content, status
    if not isinstance(content, list):
        return "", status
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            t = block.get("text")
            if isinstance(t, str):
                parts.append(t)
    return "\n".join(parts), status


def _events_from_user(record: dict[str, Any], session_id: str, line_no: int) -> list[Event]:
    """A user record may contain a free-text prompt and/or tool_result blocks."""
    ts = record.get("timestamp", "")
    msg = record.get("message") or {}
    content = msg.get("content")
    out: list[Event] = []

    # Free-text user prompt
    texts = _extract_text_blocks(content)
    if texts:
        joined = "\n".join(texts).strip()
        if joined:
            out.append(
                Event(
                    session_id=session_id,
                    line_no=line_no,
                    timestamp=ts,
                    kind="user_text",
                    text=joined,
                )
            )

    # Tool results embedded in user message
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                result_text, _ = _normalise_tool_result_content(block.get("content"))
                is_error = bool(block.get("is_error"))
                out.append(
                    Event(
                        session_id=session_id,
                        line_no=line_no,
                        timestamp=ts,
                        kind="tool_result",
                        text=result_text,
                        tool_use_id=block.get("tool_use_id"),
                        tool_result_status="error" if is_error else "ok",
                    )
                )
    return out


def _events_from_assistant(record: dict[str, Any], session_id: str, line_no: int) -> list[Event]:
    """An assistant record can contain text, tool_use, and thinking blocks.

    Thinking blocks are dropped (private to the worker; not useful for judging).
    """
    ts = record.get("timestamp", "")
    msg = record.get("message") or {}
    content = msg.get("content")
    out: list[Event] = []
    if not isinstance(content, list):
        return out
    for block in content:
        if not isinstance(block, dict):
            continue
        bt = block.get("type")
        if bt == "text":
            t = block.get("text")
            if isinstance(t, str) and t.strip():
                out.append(
                    Event(
                        session_id=session_id,
                        line_no=line_no,
                        timestamp=ts,
                        kind="assistant_text",
                        text=t,
                    )
                )
        elif bt == "tool_use":
            out.append(
                Event(
                    session_id=session_id,
                    line_no=line_no,
                    timestamp=ts,
                    kind="tool_use",
                    text="",
                    tool_name=block.get("name"),
                    tool_input=block.get("input") if isinstance(block.get("input"), dict) else None,
                    tool_use_id=block.get("id"),
                )
            )
        # thinking blocks intentionally skipped
    return out


def _events_from_system(record: dict[str, Any], session_id: str, line_no: int) -> list[Event]:
    ts = record.get("timestamp", "")
    msg = record.get("message") or record
    content = msg.get("content") if isinstance(msg, dict) else None
    texts = _extract_text_blocks(content)
    if not texts:
        return []
    joined = "\n".join(texts).strip()
    if not joined:
        return []
    return [
        Event(
            session_id=session_id,
            line_no=line_no,
            timestamp=ts,
            kind="system",
            text=joined,
        )
    ]


def load_session(path: Path) -> Session:
    """Parse one JSONL file into a Session.

    Malformed lines are silently skipped; sidechain (subagent) entries are
    excluded so the corpus reflects the primary conversation only.
    """
    path = Path(path)
    session_id = path.stem
    events: list[Event] = []
    cwd: str | None = None
    with path.open("r", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            if record.get("isSidechain"):
                continue
            if cwd is None and isinstance(record.get("cwd"), str):
                cwd = record["cwd"]
            top = record.get("type")
            if top not in _KEEP_TOP_LEVEL_TYPES:
                continue
            if top == "user":
                events.extend(_events_from_user(record, session_id, line_no))
            elif top == "assistant":
                events.extend(_events_from_assistant(record, session_id, line_no))
            elif top == "system":
                events.extend(_events_from_system(record, session_id, line_no))

    byte_size = path.stat().st_size if path.exists() else 0
    return Session(
        session_id=session_id,
        source_path=path,
        events=events,
        byte_size=byte_size,
        cwd=cwd,
    )


def iter_sessions(project_dir: Path) -> Iterator[Session]:
    """Yield Sessions for every *.jsonl in a Claude Code project directory."""
    project_dir = Path(project_dir)
    for jsonl in sorted(project_dir.glob("*.jsonl")):
        yield load_session(jsonl)
