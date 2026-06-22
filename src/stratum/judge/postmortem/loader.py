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


# --- CORE-RECALL-CENTERED-1 — matched-item handle + auto-centered read --------
#
# `read_centered` mirrors crispy-recall's centered read: given a 1-indexed
# `line_no` handle (the same handle the loader assigns every Event), it returns a
# char-budgeted ASYMMETRIC window of the transcript around that line — ~30% of the
# budget spent walking backward, ~70% forward — so a caller can pull just the
# relevant slice of a multi-hundred-KB transcript into context instead of the
# whole file. If one side runs out of lines, its leftover budget spills to the
# other so the total stays ≈ char_budget.


def _render_record_line(line: str) -> str:
    """Render one raw JSONL line into the SAME normalised text the loader emits.

    A record may yield several Events (e.g. assistant text + tool_use, or a user
    prompt + tool_results); their texts are joined so the rendered unit matches
    what downstream judging sees. A malformed / dropped / sidechain line renders
    to "" but still occupies a line slot (so line_no indexing stays exact).
    """
    line = line.strip()
    if not line:
        return ""
    try:
        record = json.loads(line)
    except json.JSONDecodeError:
        return ""
    if not isinstance(record, dict) or record.get("isSidechain"):
        return ""
    top = record.get("type")
    if top not in _KEEP_TOP_LEVEL_TYPES:
        return ""
    # line_no/session_id are irrelevant to rendering; pass placeholders.
    if top == "user":
        events = _events_from_user(record, "", 0)
    elif top == "assistant":
        events = _events_from_assistant(record, "", 0)
    else:
        events = _events_from_system(record, "", 0)
    parts: list[str] = []
    for ev in events:
        if ev.kind == "tool_use":
            label = ev.tool_name or "tool"
            inp = json.dumps(ev.tool_input, ensure_ascii=False) if ev.tool_input else ""
            parts.append(f"[{label}] {inp}".rstrip())
        elif ev.text:
            parts.append(ev.text)
    return "\n".join(parts)


def _resolve_transcript_path(session: "Path | str", project_dir: Path | str | None) -> Path:
    """Accept a transcript path OR a session_id and return the JSONL path.

    Resolution is CONFINED to the project transcripts root so a caller cannot
    read arbitrary files (e.g. ``/var/secret.jsonl``). The allowed root is
    ``project_dir`` when given, else the default ~/.claude/projects/<cwd-hash>
    dir; ~/.claude/projects (the parent that holds every project's transcripts)
    is always allowed too.

    A bare session_id resolves to ``<allowed_root>/<session_id>.jsonl``. A value
    that looks like a path (ends with .jsonl or points at an existing file) is
    resolved (symlinks followed) and must live UNDER one of the allowed roots —
    otherwise a ValueError is raised."""
    base = Path(project_dir) if project_dir is not None else _default_project_dir()

    # The set of roots a resolved path may legally live under.
    allowed_roots: list[Path] = []
    for root in (base, _projects_root()):
        try:
            allowed_roots.append(root.resolve())
        except OSError:
            allowed_roots.append(root)

    def _under_allowed(candidate: Path) -> bool:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        for root in allowed_roots:
            try:
                resolved.relative_to(root)
                return True
            except ValueError:
                continue
        return False

    p = Path(session)
    if p.suffix == ".jsonl" or p.exists():
        # Explicit path: must resolve to within an allowed transcripts root.
        if not _under_allowed(p):
            raise ValueError(
                f"transcript path {p} is outside the allowed transcripts root "
                f"({', '.join(str(r) for r in allowed_roots)})"
            )
        return p
    # session_id → <allowed_root>/<session_id>.jsonl (confined by construction;
    # reject a session_id that smuggles path separators / traversal).
    candidate = base / f"{p.name}.jsonl"
    if not _under_allowed(candidate):
        raise ValueError(f"session id {session!r} resolves outside the allowed root")
    return candidate


def _projects_root() -> Path:
    """The parent dir holding every Claude Code project's transcript dir."""
    return Path.home() / ".claude" / "projects"


def _default_project_dir() -> Path:
    """The Claude Code transcript dir for the current workspace.

    Claude Code hashes the cwd path with '/' → '-' (and a leading '-'). This
    mirrors that convention so a bare session_id resolves for the running project.
    """
    cwd = str(Path.cwd())
    hashed = cwd.replace("/", "-")
    return Path.home() / ".claude" / "projects" / hashed


def center_over_rendered(
    rendered: list[str],
    line_no: int,
    char_budget: int = 20000,
    before_ratio: float = 0.3,
    after_ratio: float = 0.7,
    cursor: dict | None = None,
) -> dict:
    """Char-budgeted asymmetric centered window over already-rendered transcript
    lines (1-indexed). Source-agnostic core shared by ``read_centered`` (CC) and
    ``read_transcript_centered`` (CC + Codex). Returns ``{window, center,
    continue_cursor, chars_used, char_budget}`` where ``center`` is the clamped
    effective line; callers attach their own (source-aware) handle."""
    directional = False
    if cursor:
        nxt = cursor.get("next_line")
        prv = cursor.get("prev_line")
        if line_no is None or line_no <= 0:
            line_no = nxt or prv or 1
        if line_no == nxt and nxt is not None:
            before_ratio, after_ratio = 0.0, 1.0
            directional = True
        elif line_no == prv and prv is not None:
            before_ratio, after_ratio = 1.0, 0.0
            directional = True

    total = len(rendered)
    if total == 0:
        return {
            "window": "",
            "center": line_no if line_no and line_no > 0 else 1,
            "continue_cursor": {"prev_line": None, "next_line": None},
            "chars_used": 0,
            "char_budget": char_budget,
        }

    center = max(1, min(line_no, total))
    center_text = rendered[center - 1]
    if len(center_text) > char_budget:
        window = center_text[:char_budget]
        return {
            "window": window,
            "center": center,
            "continue_cursor": {
                "prev_line": center - 1 if center > 1 else None,
                "next_line": center + 1 if center < total else None,
            },
            "chars_used": len(window),
            "char_budget": char_budget,
        }

    included: dict[int, str] = {center: center_text}
    chars_used = len(center_text)
    remaining = char_budget - chars_used
    back_budget = int(remaining * before_ratio)
    fwd_budget = remaining - back_budget
    lo = center - 1
    hi = center + 1
    back_used = 0
    fwd_used = 0

    def _back_available() -> bool:
        return lo >= 1

    def _fwd_available() -> bool:
        return hi <= total

    while True:
        progressed = False
        if _back_available():
            text = rendered[lo - 1]
            cost = len(text) + 1
            within_side = (back_used + cost <= back_budget) or (not directional and not _fwd_available())
            if within_side and chars_used + cost <= char_budget:
                included[lo] = text
                chars_used += cost
                back_used += cost
                lo -= 1
                progressed = True
        if _fwd_available():
            text = rendered[hi - 1]
            cost = len(text) + 1
            within_side = (fwd_used + cost <= fwd_budget) or (not directional and not _back_available())
            if within_side and chars_used + cost <= char_budget:
                included[hi] = text
                chars_used += cost
                fwd_used += cost
                hi += 1
                progressed = True
        if not progressed:
            break
        if not _back_available() and not _fwd_available():
            break

    ordered = sorted(included)
    window = "\n".join(included[i] for i in ordered)
    first, last = ordered[0], ordered[-1]
    return {
        "window": window,
        "center": center,
        "continue_cursor": {
            "prev_line": first - 1 if first > 1 else None,
            "next_line": last + 1 if last < total else None,
        },
        "chars_used": len(window),
        "char_budget": char_budget,
    }


def read_centered(
    session: "Path | str",
    line_no: int,
    char_budget: int = 20000,
    before_ratio: float = 0.3,
    after_ratio: float = 0.7,
    cursor: dict | None = None,
    *,
    project_dir: Path | str | None = None,
) -> dict:
    """Read a char-budgeted, asymmetric window of a transcript around ``line_no``.

    Walks OUTWARD from the centered line: targets ~``before_ratio`` of the budget
    backward and ~``after_ratio`` forward. If one side runs out of lines, its
    leftover budget spills to the other so total chars ≈ ``char_budget``. If the
    centered line alone exceeds the budget, it is hard-truncated and returned
    alone (mirrors crispy-recall).

    ``session`` may be a transcript path or a session_id (resolved via
    ``project_dir`` / the cwd-hash convention). ``cursor`` is accepted for API
    symmetry with the continue_cursor it returns; when given a ``prev_line`` /
    ``next_line`` it re-centers reads on that edge (callers normally just pass the
    edge as ``line_no`` directly).

    Returns::

        {window, handle: {session_id, line_no}, continue_cursor: {prev_line,
         next_line}, chars_used, char_budget}

    where ``prev_line`` / ``next_line`` are the next lines to read further each
    way (``None`` at a file edge).
    """
    path = _resolve_transcript_path(session, project_dir)
    session_id = path.stem
    rendered: list[str] = []
    with path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            rendered.append(_render_record_line(raw))
    r = center_over_rendered(rendered, line_no, char_budget, before_ratio, after_ratio, cursor)
    return {
        "window": r["window"],
        "handle": {"session_id": session_id, "line_no": r["center"]},
        "continue_cursor": r["continue_cursor"],
        "chars_used": r["chars_used"],
        "char_budget": r["char_budget"],
    }
