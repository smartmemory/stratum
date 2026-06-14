"""STRAT-DISTILL S3 — CLI verb tests (TDD)."""
from __future__ import annotations

import json
from pathlib import Path

from stratum.judge.distill.cli import main


def _write_session(path: Path, tool_seq):
    lines = [{"type": "user", "timestamp": "t", "message": {"content": [{"type": "text", "text": "do it"}]}}]
    for tname, tinput in tool_seq:
        lines.append(
            {
                "type": "assistant",
                "timestamp": "t",
                "message": {"content": [{"type": "tool_use", "name": tname, "input": tinput, "id": "x"}]},
            }
        )
    lines.append({"type": "assistant", "timestamp": "t", "message": {"content": [{"type": "text", "text": "Done."}]}})
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")


def _project(tmp_path: Path, seq) -> Path:
    proj = tmp_path / "proj"
    proj.mkdir()
    _write_session(proj / "S1.jsonl", seq)
    _write_session(proj / "S2.jsonl", seq)
    return proj


def test_extract_writes_sidecar(tmp_path):
    seq = [("Bash", {"command": "npm test"}), ("Edit", {"file_path": "a.js"})]
    proj = _project(tmp_path, seq)
    out = tmp_path / ".stratum/postmortem/distill_candidates.jsonl"
    rc = main(["extract", "--project", str(proj), "--out", str(out), "--min-count", "2"])
    assert rc == 0
    assert out.exists()
    rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
    assert rows
    assert all(r["origin"] == "distill" for r in rows)


def test_extract_creates_out_parent(tmp_path):
    proj = _project(tmp_path, [("Bash", {"command": "go"}), ("Read", {"file_path": "x"})])
    out = tmp_path / "nested/deep/distill.jsonl"
    rc = main(["extract", "--project", str(proj), "--out", str(out)])
    assert rc == 0
    assert out.exists()


def test_extract_nothing_to_distill(tmp_path):
    proj = tmp_path / "empty"
    proj.mkdir()
    _write_session(proj / "S1.jsonl", [("Bash", {"command": "unique"})])  # one session, no recurrence
    out = tmp_path / "out.jsonl"
    rc = main(["extract", "--project", str(proj), "--out", str(out), "--min-count", "2"])
    assert rc == 0
    assert (not out.exists()) or out.read_text().strip() == ""


def test_top_filters_and_prints(tmp_path, capsys):
    seq = [("Bash", {"command": "npm test"}), ("Edit", {"file_path": "a.js"})]
    proj = _project(tmp_path, seq)
    rc = main(["top", "--project", str(proj), "--min-count", "2", "--n", "10"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Bash" in out


def test_stats_runs(tmp_path, capsys):
    proj = _project(tmp_path, [("Bash", {"command": "x"}), ("Edit", {"file_path": "y"})])
    rc = main(["stats", "--project", str(proj), "--min-count", "2"])
    assert rc == 0
    assert "session" in capsys.readouterr().out
