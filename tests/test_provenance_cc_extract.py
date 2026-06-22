"""S01 CC extractor tests (CORE-CODE-PROVENANCE-1 Phase 1).

The loader exposes `tool_result_status` on the result event but does not join it
to the tool_use; `cc_session_edits` builds that join and drops failed/unpaired
edits (a failed edit never wrote the text).
"""

from __future__ import annotations

from pathlib import Path

from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.postmortem.provenance import cc_session_edits


def _tool_use(line, name, tool_input, tool_use_id):
    return Event(
        session_id="S",
        line_no=line,
        timestamp="2026-06-22T00:00:00Z",
        kind="tool_use",
        tool_name=name,
        tool_input=tool_input,
        tool_use_id=tool_use_id,
    )


def _tool_result(line, tool_use_id, status):
    return Event(
        session_id="S",
        line_no=line,
        timestamp="2026-06-22T00:00:01Z",
        kind="tool_result",
        tool_use_id=tool_use_id,
        tool_result_status=status,
    )


def _session(*events):
    return Session(session_id="S", source_path=Path("/x/S.jsonl"), events=list(events), cwd="/repo")


def test_successful_edit_and_write_extracted():
    s = _session(
        _tool_use(1, "Edit", {"file_path": "a.py", "old_string": "x", "new_string": "AUTHORED_EDIT"}, "t1"),
        _tool_result(2, "t1", "ok"),
        _tool_use(3, "Write", {"file_path": "b.py", "content": "AUTHORED_WRITE"}, "t2"),
        _tool_result(4, "t2", "ok"),
    )
    se = cc_session_edits(s)
    assert se.source == "cc" and se.session_id == "S" and se.cwd == "/repo" and se.repo is None
    bodies = {(e.file_path, e.op, e.block_text, e.tool_ref, e.line_no) for e in se.edits}
    assert ("a.py", "edit", "AUTHORED_EDIT", "t1", 1) in bodies
    assert ("b.py", "write", "AUTHORED_WRITE", "t2", 3) in bodies


def test_failed_edit_excluded():
    s = _session(
        _tool_use(1, "Edit", {"file_path": "a.py", "new_string": "FAILED_TEXT"}, "t1"),
        _tool_result(2, "t1", "error"),
    )
    assert cc_session_edits(s).edits == []


def test_unpaired_edit_excluded():
    # tool_use with no matching tool_result → cannot confirm it applied → dropped
    s = _session(_tool_use(1, "Edit", {"file_path": "a.py", "new_string": "UNPAIRED"}, "t1"))
    assert cc_session_edits(s).edits == []


def test_multiedit_yields_one_evidence_per_edit():
    s = _session(
        _tool_use(
            1,
            "MultiEdit",
            {"file_path": "a.py", "edits": [{"new_string": "BLOCK_ONE"}, {"new_string": "BLOCK_TWO"}]},
            "t1",
        ),
        _tool_result(2, "t1", "ok"),
    )
    se = cc_session_edits(s)
    assert {e.block_text for e in se.edits} == {"BLOCK_ONE", "BLOCK_TWO"}
    assert all(e.op == "multiedit" and e.file_path == "a.py" for e in se.edits)


def test_non_edit_tools_ignored():
    s = _session(
        _tool_use(1, "Bash", {"command": "ls"}, "t1"),
        _tool_result(2, "t1", "ok"),
        _tool_use(3, "Read", {"file_path": "a.py"}, "t2"),
        _tool_result(4, "t2", "ok"),
    )
    assert cc_session_edits(s).edits == []
