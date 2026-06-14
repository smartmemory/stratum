"""STRAT-DISTILL S4 — stratum_distill MCP tool tests (TDD)."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest


def _ctx() -> MagicMock:
    c = MagicMock()
    c.request_context = MagicMock()
    return c


def _write_session(path, tool_seq):
    lines = [{"type": "user", "timestamp": "t", "message": {"content": [{"type": "text", "text": "do"}]}}]
    for tn, ti in tool_seq:
        lines.append(
            {
                "type": "assistant",
                "timestamp": "t",
                "message": {"content": [{"type": "tool_use", "name": tn, "input": ti, "id": "x"}]},
            }
        )
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")


def _project(tmp_path, seq):
    proj = tmp_path / "proj"
    proj.mkdir()
    _write_session(proj / "S1.jsonl", seq)
    _write_session(proj / "S2.jsonl", seq)
    return proj


@pytest.mark.asyncio
async def test_distill_returns_candidates_and_writes(tmp_path):
    import stratum_mcp.server as srv

    proj = _project(tmp_path, [("Bash", {"command": "npm test"}), ("Edit", {"file_path": "a.js"})])
    out = tmp_path / "distill.jsonl"
    res = await srv.stratum_distill(ctx=_ctx(), project_dir=str(proj), out_path=str(out), min_count=2)
    assert res["evaluated"] >= 1
    assert res["written"] >= 1
    assert res["candidates"]
    assert out.exists()
    assert res["applied"] is False


@pytest.mark.asyncio
async def test_distill_empty_is_nothing_to_distill(tmp_path):
    import stratum_mcp.server as srv

    proj = tmp_path / "empty"
    proj.mkdir()
    _write_session(proj / "S1.jsonl", [("Bash", {"command": "unique"})])  # one session, no recurrence
    out = tmp_path / "out.jsonl"
    res = await srv.stratum_distill(ctx=_ctx(), project_dir=str(proj), out_path=str(out), min_count=2)
    assert res["evaluated"] == 0
    assert res["written"] == 0
    assert "nothing to distill" in res["reason"]
    assert not out.exists()


@pytest.mark.asyncio
async def test_distill_is_stateless(tmp_path):
    import stratum_mcp.server as srv

    proj = _project(tmp_path, [("Bash", {"command": "go"}), ("Read", {"file_path": "x"})])
    flows_before = set(getattr(srv, "_flows", {}).keys())
    res = await srv.stratum_distill(
        ctx=_ctx(), project_dir=str(proj), out_path=str(tmp_path / "d.jsonl"), min_count=2
    )
    flows_after = set(getattr(srv, "_flows", {}).keys())
    assert flows_before == flows_after  # no FlowState created
    # envelope carries only documented keys (no flow-state / learn_* / distill_* leakage)
    assert set(res.keys()) == {"candidates", "evaluated", "written", "reason", "out_path", "applied"}
