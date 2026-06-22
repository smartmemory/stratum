"""S03 source-aware reader tests (CORE-CODE-PROVENANCE-1 Phase 1).

Proves the blame -> read chain works for BOTH a CC and a Codex handle (rev-1's
read_centered was CC-only).
"""

from __future__ import annotations

import json

import pytest

from stratum.judge.postmortem.transcript_reader import read_transcript_centered


def _cc_line(text: str) -> str:
    return json.dumps({"type": "assistant", "timestamp": "t", "message": {"content": [{"type": "text", "text": text}]}})


def test_cc_chain_reads_centered_window(tmp_path):
    lines = [_cc_line(f"line-{i}") for i in range(1, 11)]
    lines[4] = _cc_line("CC_CENTER_MARKER")  # 1-indexed line 5
    (tmp_path / "S.jsonl").write_text("\n".join(lines) + "\n")
    res = read_transcript_centered("S", 5, source="cc", project_dir=tmp_path)
    assert "CC_CENTER_MARKER" in res["window"]
    assert res["handle"] == {"source": "cc", "source_path": str(tmp_path / "S.jsonl"), "session_id": "S", "line_no": 5}
    assert res["chars_used"] <= res["char_budget"]


def test_codex_chain_reads_apply_patch_window(tmp_path):
    root = tmp_path / "sessions" / "2026" / "06" / "22"
    root.mkdir(parents=True)
    patch = "*** Begin Patch\n*** Update File: a.py\n+CODEX_AUTHORED_MARKER\n*** End Patch"
    records = [
        {"type": "session_meta", "payload": {"id": "019codex", "cwd": "/repo"}},
        {"type": "event_msg", "payload": {"message": "some chatter"}},
        {"type": "response_item", "payload": {"type": "custom_tool_call", "status": "completed", "call_id": "c1", "name": "apply_patch", "input": patch}},
        {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": "{}"}},
    ]
    p = root / "rollout-2026-06-22T00-00-00-019codex.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    # line 3 = the apply_patch record
    res = read_transcript_centered(p, 3, source="codex", codex_dir=tmp_path / "sessions")
    assert "CODEX_AUTHORED_MARKER" in res["window"]
    assert res["handle"]["source"] == "codex"
    assert res["handle"]["session_id"] == "019codex"  # from payload.id, not the filename stem
    assert res["chars_used"] <= res["char_budget"]


def test_codex_path_confinement_enforced(tmp_path):
    outside = tmp_path / "evil.jsonl"
    outside.write_text("{}\n")
    with pytest.raises(ValueError):
        read_transcript_centered(outside, 1, source="codex", codex_dir=tmp_path / "sessions")


def test_unknown_source_raises(tmp_path):
    with pytest.raises(ValueError):
        read_transcript_centered("S", 1, source="svn")
