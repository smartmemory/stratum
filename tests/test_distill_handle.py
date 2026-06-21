"""CORE-RECALL-CENTERED-1 Phase 1 — (session_id, line_no) handle on candidates.

A detected workflow must carry the source handle of its first observed step so a
reviewer can jump straight to the transcript with read_centered. The handle flows
detector → WorkflowCandidate → synthesize → AssetCandidate → sidecar, additively
(existing consumers keep working).
"""
from __future__ import annotations

from pathlib import Path

from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.distill.detector import detect, tool_steps
from stratum.judge.distill.synthesize import synthesize


def _ev(line, kind, tool_name=None, tool_input=None, text=""):
    return Event(
        session_id="S",
        line_no=line,
        timestamp="t",
        kind=kind,
        text=text,
        tool_name=tool_name,
        tool_input=tool_input,
    )


def _session(sid, tool_seq, start_line=10):
    events = [_ev(start_line - 1, "user_text", text="go")]
    n = start_line
    for tname, tinput in tool_seq:
        events.append(_ev(n, "tool_use", tool_name=tname, tool_input=tinput))
        n += 1
    return Session(session_id=sid, source_path=Path(f"/tmp/{sid}.jsonl"), events=events)


def test_tool_steps_carries_line_no():
    s = _session("S", [("Bash", {"command": "ls"}), ("Edit", {"file_path": "a"})], start_line=10)
    steps = tool_steps(s)
    # backward-compatible: still (tool, canon) at [0] and [1]
    assert steps[0][0] == "Bash"
    assert steps[0][1] == "command=ls"
    # additive: line_no available as a third element
    assert steps[0][2] == 10
    assert steps[1][2] == 11


def test_candidate_carries_session_id_and_line_no():
    seq = [("Bash", {"command": "npm test"}), ("Edit", {"file_path": "a.js"})]
    sessions = [_session("S1", seq, start_line=10), _session("S2", seq, start_line=20)]
    cands = detect(sessions, min_count=2)
    assert cands
    for c in cands:
        # additive handle fields, never None for a detected candidate
        assert c.source_session_id, f"missing source_session_id on {c.signature}"
        assert isinstance(c.source_line_no, int) and c.source_line_no > 0
        d = c.to_dict()
        assert d["source_session_id"] == c.source_session_id
        assert d["source_line_no"] == c.source_line_no


def test_asset_candidate_propagates_handle():
    seq = [("Bash", {"command": "npm test"})]
    sessions = [_session("S1", seq, start_line=10), _session("S2", seq, start_line=33)]
    cands = detect(sessions, min_count=2)
    wf = next(c for c in cands if c.kind == "single")
    asset = synthesize(wf, min_count=2)
    assert asset is not None
    assert asset.source_session_id == wf.source_session_id
    assert asset.source_line_no == wf.source_line_no
    d = asset.to_dict()
    assert d["source_session_id"] == wf.source_session_id
    assert d["source_line_no"] == wf.source_line_no
