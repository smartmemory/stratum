"""S02 Codex rollout reader tests (CORE-CODE-PROVENANCE-1 Phase 1)."""

from __future__ import annotations

import json

import pytest

from stratum.judge.postmortem.codex_loader import (
    codex_session_edits,
    iter_codex_sessions,
    parse_apply_patch,
    resolve_codex_path,
)


def _patch(*body: str) -> str:
    return "*** Begin Patch\n" + "\n".join(body) + "\n*** End Patch"


def _rollout(tmp_path, *records, name="rollout-2026-06-22T00-00-00-019sess.jsonl"):
    p = tmp_path / name
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p


def _meta(sid="019sess", cwd="/repo"):
    return {"type": "session_meta", "payload": {"id": sid, "cwd": cwd}}


def _call(call_id, patch, status="completed"):
    return {
        "type": "response_item",
        "payload": {"type": "custom_tool_call", "status": status, "call_id": call_id, "name": "apply_patch", "input": patch},
    }


def _out(call_id, exit_code=0, output="Success. Updated.\n"):
    payload = json.dumps({"output": output, "metadata": {"exit_code": exit_code}})
    return {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": call_id, "output": payload}}


# --------------------------------------------------------------------------- #
# V4A parsing
# --------------------------------------------------------------------------- #
def test_parse_apply_patch_add_update_delete_multifile():
    patch = _patch(
        "*** Update File: a.py",
        "@@",
        " context",
        "-old",
        "+new_in_a",
        "*** Add File: b.py",
        "+created_b_line1",
        "+created_b_line2",
        "*** Delete File: gone.py",
    )
    got = parse_apply_patch(patch)
    files = {fp: (op, text) for fp, op, text in got}
    assert files["a.py"] == ("update", "new_in_a")
    assert files["b.py"] == ("add", "created_b_line1\ncreated_b_line2")
    assert "gone.py" not in files  # Delete → no authored text, skipped


# --------------------------------------------------------------------------- #
# session extraction + success correlation
# --------------------------------------------------------------------------- #
def test_successful_patch_extracted(tmp_path):
    p = _rollout(
        tmp_path,
        _meta(),
        _call("c1", _patch("*** Update File: a.py", "+AUTHORED_CODEX")),
        _out("c1"),
    )
    se = codex_session_edits(p)
    assert se is not None and se.source == "codex" and se.session_id == "019sess" and se.cwd == "/repo"
    assert {(e.file_path, e.block_text, e.tool_ref, e.op) for e in se.edits} == {
        ("a.py", "AUTHORED_CODEX", "c1", "apply_patch")
    }


def test_non_completed_status_dropped(tmp_path):
    p = _rollout(tmp_path, _meta(), _call("c1", _patch("*** Update File: a.py", "+X"), status="failed"), _out("c1"))
    assert codex_session_edits(p) is None


def test_output_exit_code_nonzero_dropped(tmp_path):
    # inline status completed but the paired output reports failure → dropped
    p = _rollout(tmp_path, _meta(), _call("c1", _patch("*** Update File: a.py", "+X")), _out("c1", exit_code=1, output="Error\n"))
    assert codex_session_edits(p) is None


def test_malformed_output_json_kept_inline_status_governs(tmp_path):
    bad_out = {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": "not json{{"}}
    p = _rollout(tmp_path, _meta(), _call("c1", _patch("*** Update File: a.py", "+KEPT")), bad_out)
    se = codex_session_edits(p)
    assert se is not None and se.edits[0].block_text == "KEPT"  # malformed output → inline 'completed' wins, no crash


def test_zero_apply_patch_returns_none(tmp_path):
    # a rollout with session_meta but no apply_patch (e.g. shell-only) → None (#11)
    p = _rollout(tmp_path, _meta(), {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command"}})
    assert codex_session_edits(p) is None


def test_no_session_meta_returns_none(tmp_path):
    p = _rollout(tmp_path, _call("c1", _patch("*** Update File: a.py", "+X")), _out("c1"))
    assert codex_session_edits(p) is None


# --------------------------------------------------------------------------- #
# enumeration + confinement
# --------------------------------------------------------------------------- #
def test_iter_codex_sessions_recursive(tmp_path):
    nested = tmp_path / "2026" / "06" / "22"
    nested.mkdir(parents=True)
    (nested / "rollout-x.jsonl").write_text("{}\n")
    (tmp_path / "not-a-rollout.jsonl").write_text("{}\n")
    found = [p.name for p in iter_codex_sessions(tmp_path)]
    assert found == ["rollout-x.jsonl"]


def test_resolve_codex_path_rejects_escape(tmp_path):
    root = tmp_path / "sessions"
    (root / "2026").mkdir(parents=True)
    inside = root / "2026" / "rollout-a.jsonl"
    inside.write_text("{}\n")
    assert resolve_codex_path(inside, codex_dir=root) == inside.resolve()
    with pytest.raises(ValueError):
        resolve_codex_path(tmp_path / "outside.jsonl", codex_dir=root)
