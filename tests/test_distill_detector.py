"""STRAT-DISTILL S0 — detector core tests (TDD)."""
from __future__ import annotations

from pathlib import Path

from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.distill.detector import (
    WorkflowCandidate,
    canonicalize_input,
    detect,
    tool_steps,
)


def _ev(line: int, kind: str, tool_name=None, tool_input=None, text=""):
    return Event(
        session_id="S",
        line_no=line,
        timestamp="t",
        kind=kind,
        text=text,
        tool_name=tool_name,
        tool_input=tool_input,
    )


def _session(sid: str, tool_seq):
    """tool_seq: list of (tool_name, tool_input_dict | None)."""
    events = [_ev(1, "user_text", text="do the thing")]
    n = 2
    for tname, tinput in tool_seq:
        events.append(_ev(n, "tool_use", tool_name=tname, tool_input=tinput))
        n += 1
    events.append(_ev(n, "assistant_text", text="Done."))
    return Session(session_id=sid, source_path=Path(f"/tmp/{sid}.jsonl"), events=events)


def test_canonicalize_input_key_priority():
    # command wins over file_path
    assert canonicalize_input({"command": "npm test", "file_path": "x"}) == "command=npm test"
    assert canonicalize_input({"file_path": "/a/b.py"}) == "file_path=/a/b.py"
    assert canonicalize_input({}) == ""
    assert canonicalize_input(None) == ""
    # unknown keys fall back to a deterministic json preview
    out = canonicalize_input({"zzz": "v"})
    assert "zzz" in out
    assert canonicalize_input({"zzz": "v"}) == canonicalize_input({"zzz": "v"})


def test_tool_steps_extracts_only_tool_use():
    s = _session("S", [("Bash", {"command": "ls"}), ("Edit", {"file_path": "a.js"})])
    steps = tool_steps(s)
    assert steps == [("Bash", "command=ls"), ("Edit", "file_path=a.js")]


def test_repeated_sequence_across_sessions_detected():
    seq = [("Bash", {"command": "npm test"}), ("Edit", {"file_path": "a.js"})]
    sessions = [_session("S1", seq), _session("S2", seq)]
    cands = detect(sessions, min_count=2)
    assert cands, "expected at least one candidate"
    assert all(isinstance(c, WorkflowCandidate) for c in cands)
    assert all(c.count >= 2 for c in cands)
    # the recurring single command surfaces
    assert any("npm test" in c.signature for c in cands)
    # the recurring tool-name sequence surfaces
    assert any(c.kind == "sequence" and c.steps == ("Bash", "Edit") for c in cands)


def test_single_occurrence_not_detected():
    sessions = [_session("S1", [("Bash", {"command": "ls"})])]
    assert detect(sessions, min_count=2) == []


def test_malformed_events_skipped_not_raised():
    bad = Session(
        session_id="B",
        source_path=Path("/tmp/B.jsonl"),
        events=[
            _ev(1, "tool_use", tool_name=None, tool_input=None),
            _ev(2, "tool_use", tool_name="Bash", tool_input={"command": "x"}),
            _ev(3, "tool_use", tool_name="Bash", tool_input=None),
        ],
    )
    # must not raise on None tool_name / None tool_input
    detect([bad, bad], min_count=2)


def test_determinism():
    seq = [("Read", {"file_path": "a"}), ("Bash", {"command": "go"})]
    sessions = [_session("S1", seq), _session("S2", seq)]
    a = [c.to_dict() for c in detect(sessions, min_count=2)]
    b = [c.to_dict() for c in detect(sessions, min_count=2)]
    assert a == b


def test_single_session_repeat_not_detected_by_default():
    # same sequence twice WITHIN one session → count 2 but only 1 session.
    seq = [("Bash", {"command": "go"}), ("Edit", {"file_path": "a"})]
    s = _session("S1", seq + seq)
    assert detect([s], min_count=2) == []  # default min_sessions=2 (cross-session bar)


def test_single_session_repeat_detected_when_min_sessions_1():
    seq = [("Bash", {"command": "go"}), ("Edit", {"file_path": "a"})]
    s = _session("S1", seq + seq)
    cands = detect([s], min_count=2, min_sessions=1)
    assert any(c.kind == "sequence" for c in cands)


def test_secret_redaction_in_canonicalize():
    assert "<redacted>" in canonicalize_input(
        {"command": "curl -H 'Authorization: Bearer sk-abc123def456'"}
    )
    assert "sk-abc123def456ghi" not in canonicalize_input({"command": "x sk-abc123def456ghi"})
    assert "<redacted>" in canonicalize_input({"command": "deploy --api-key=SUPERSECRETVALUE"})
    assert "<redacted>" in canonicalize_input({"url": "https://x.com/api?token=abc123secret&page=2"})
    # benign command is untouched
    assert canonicalize_input({"command": "npm test"}) == "command=npm test"
