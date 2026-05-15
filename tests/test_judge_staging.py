"""Tests for stratum.judge.staging — per-turn staging directory writer."""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum.judge import staging as staging_mod
from stratum.judge.staging import stage_turn, _manifest_entry


# Well-known SHA256 of zero bytes.
EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


@pytest.fixture
def isolated_judge_root(tmp_path, monkeypatch):
    """Redirect JUDGE_ROOT to a tmp dir so tests don't pollute ~/.stratum."""
    root = tmp_path / "judge"
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", root)
    return root


@pytest.fixture
def workspace(tmp_path):
    ws = tmp_path / "workspace"
    ws.mkdir()
    return ws


def test_stage_turn_creates_expected_layout(isolated_judge_root, workspace):
    artifacts = {"pytest_output": "12 passed\n"}
    (workspace / "lib").mkdir()
    (workspace / "lib" / "auth.py").write_text("def login(): pass\n")
    modified = ["lib/auth.py"]

    turn_dir, actual_turn = stage_turn(
        flow_id="F1", step_id="S1", turn=1,
        artifacts=artifacts, modified_files=modified,
        workspace_root=workspace,
    )

    assert actual_turn == 1
    assert turn_dir == isolated_judge_root / "F1" / "S1" / "turn-1"
    assert (turn_dir / "artifacts" / "pytest_output.txt").read_text() == "12 passed\n"
    assert (turn_dir / "modified" / "lib" / "auth.py").read_text() == "def login(): pass\n"
    manifest = json.loads((turn_dir / "manifest.json").read_text())
    assert isinstance(manifest, list)
    # 1 artifact + 1 modified
    assert len(manifest) == 2
    buckets = {(e["bucket"], e["path"]) for e in manifest}
    assert ("artifacts", "pytest_output.txt") in buckets
    assert ("modified", "lib/auth.py") in buckets
    for e in manifest:
        assert "sha256" in e and "byte_size" in e and "written_at_ms" in e


def test_stage_turn_refuses_overwrite_scans_next_free(isolated_judge_root, workspace):
    artifacts = {"a": "hello"}
    turn_dir1, t1 = stage_turn("F", "S", 1, artifacts, [], workspace)
    assert t1 == 1
    # Re-stage with turn=1 — should find next free.
    turn_dir2, t2 = stage_turn("F", "S", 1, artifacts, [], workspace)
    assert t2 == 2
    assert turn_dir2 == isolated_judge_root / "F" / "S" / "turn-2"
    assert turn_dir1 != turn_dir2
    # Third call also escalates.
    _, t3 = stage_turn("F", "S", 1, artifacts, [], workspace)
    assert t3 == 3


def test_modified_snapshot_byte_identical(isolated_judge_root, workspace):
    payload = b"\x00\x01raw\xffbytes\x00"
    (workspace / "bin.dat").write_bytes(payload)
    turn_dir, _ = stage_turn("F", "S", 1, {}, ["bin.dat"], workspace)
    assert (turn_dir / "modified" / "bin.dat").read_bytes() == payload


def test_concurrent_worker_change_after_staging(isolated_judge_root, workspace):
    """Snapshot isolation: changing the source after staging doesn't affect snapshot."""
    src = workspace / "file.txt"
    src.write_text("v1")
    turn_dir, _ = stage_turn("F", "S", 1, {}, ["file.txt"], workspace)
    # Worker writes new content.
    src.write_text("v2-larger-content")
    assert (turn_dir / "modified" / "file.txt").read_text() == "v1"


def test_missing_modified_file_manifest_entry(isolated_judge_root, workspace):
    turn_dir, _ = stage_turn(
        "F", "S", 1, {}, ["nope/gone.py"], workspace,
    )
    # No file written on disk.
    assert not (turn_dir / "modified" / "nope" / "gone.py").exists()
    manifest = json.loads((turn_dir / "manifest.json").read_text())
    entries = [e for e in manifest if e["path"] == "nope/gone.py"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["bucket"] == "modified"
    assert entry["sha256"] is None
    assert entry["byte_size"] == 0
    assert entry.get("missing") is True


def test_manifest_entry_empty_bytes_hashes_to_well_known(isolated_judge_root, workspace):
    entry = _manifest_entry("artifacts", "empty.txt", b"")
    assert entry["sha256"] == EMPTY_SHA256
    assert entry["byte_size"] == 0
    assert entry["bucket"] == "artifacts"
    assert entry["path"] == "empty.txt"


def test_real_empty_artifact_distinguishable_from_missing(isolated_judge_root, workspace):
    """Real empty file: sha256 = e3b0...; missing file: sha256 = None."""
    artifacts = {"empty": ""}
    turn_dir, _ = stage_turn(
        "F", "S", 1, artifacts, ["ghost.py"], workspace,
    )
    manifest = json.loads((turn_dir / "manifest.json").read_text())
    by_path = {e["path"]: e for e in manifest}
    assert by_path["empty.txt"]["sha256"] == EMPTY_SHA256
    assert by_path["ghost.py"]["sha256"] is None


# ----------------------------------------------------------------------------
# Sanitization regression tests (Codex impl review #2 — staging path traversal)
# ----------------------------------------------------------------------------


def test_artifact_name_rejects_path_separator(tmp_path, monkeypatch):
    from stratum.judge import staging as staging_mod
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")
    import pytest
    with pytest.raises(ValueError, match="path separators"):
        staging_mod.stage_turn(
            flow_id="f", step_id="s", turn=1,
            artifacts={"../escape": "evil"},
            modified_files=[],
            workspace_root=tmp_path,
        )


def test_artifact_name_rejects_traversal_segment(tmp_path, monkeypatch):
    from stratum.judge import staging as staging_mod
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")
    import pytest
    with pytest.raises(ValueError, match=r"'\.\.'"):
        staging_mod.stage_turn(
            flow_id="f", step_id="s", turn=1,
            artifacts={"..": "evil"},
            modified_files=[],
            workspace_root=tmp_path,
        )


def test_artifact_name_rejects_empty(tmp_path, monkeypatch):
    from stratum.judge import staging as staging_mod
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")
    import pytest
    with pytest.raises(ValueError, match="non-empty"):
        staging_mod.stage_turn(
            flow_id="f", step_id="s", turn=1,
            artifacts={"": "evil"},
            modified_files=[],
            workspace_root=tmp_path,
        )


def test_modified_path_rejects_absolute(tmp_path, monkeypatch):
    from stratum.judge import staging as staging_mod
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")
    import pytest
    with pytest.raises(ValueError, match="workspace-relative"):
        staging_mod.stage_turn(
            flow_id="f", step_id="s", turn=1,
            artifacts={"ok": ""},
            modified_files=["/etc/passwd"],
            workspace_root=tmp_path,
        )


def test_modified_path_rejects_traversal(tmp_path, monkeypatch):
    from stratum.judge import staging as staging_mod
    monkeypatch.setattr(staging_mod, "JUDGE_ROOT", tmp_path / "judge")
    import pytest
    with pytest.raises(ValueError, match=r"'\.\.'"):
        staging_mod.stage_turn(
            flow_id="f", step_id="s", turn=1,
            artifacts={"ok": ""},
            modified_files=["../../etc/passwd"],
            workspace_root=tmp_path,
        )
