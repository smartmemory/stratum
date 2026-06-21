"""CORE-RECALL-CENTERED-1 Phase 1 — read_centered MCP tool tests (TDD)."""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest


def _ctx() -> MagicMock:
    c = MagicMock()
    c.request_context = MagicMock()
    return c


def _write_jsonl(path, texts):
    lines = []
    for t in texts:
        lines.append(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": "t",
                    "message": {"content": [{"type": "text", "text": t}]},
                }
            )
        )
    path.write_text("\n".join(lines) + "\n")


@pytest.mark.asyncio
async def test_read_centered_tool_returns_window_and_handle(tmp_path):
    import stratum_mcp.server as srv

    texts = [f"L{i:02d} " + ("x" * 95) for i in range(1, 42)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = await srv.read_centered(
        ctx=_ctx(), session=str(p), line_no=21, char_budget=2000, project_dir=str(tmp_path)
    )

    assert "L21" in res["window"]
    assert res["handle"] == {"session_id": "S", "line_no": 21}
    assert res["char_budget"] == 2000
    assert res["chars_used"] > 0
    assert set(res.keys()) == {
        "window",
        "handle",
        "continue_cursor",
        "chars_used",
        "char_budget",
    }
    assert set(res["continue_cursor"].keys()) == {"prev_line", "next_line"}


@pytest.mark.asyncio
async def test_read_centered_tool_resolves_session_id_via_project_dir(tmp_path):
    import stratum_mcp.server as srv

    proj = tmp_path / "proj"
    proj.mkdir()
    _write_jsonl(proj / "abc.jsonl", [f"L{i:02d} " + ("y" * 95) for i in range(1, 12)])

    res = await srv.read_centered(
        ctx=_ctx(), session="abc", line_no=5, char_budget=1500, project_dir=str(proj)
    )
    assert res["handle"] == {"session_id": "abc", "line_no": 5}
    assert "L05" in res["window"]


@pytest.mark.asyncio
async def test_read_centered_tool_unresolved_session_returns_error_envelope(tmp_path):
    import stratum_mcp.server as srv

    proj = tmp_path / "proj"
    proj.mkdir()
    # No transcript written for this session id → unresolved.
    res = await srv.read_centered(
        ctx=_ctx(), session="does-not-exist", line_no=5, char_budget=1500,
        project_dir=str(proj),
    )
    # Error envelope shaped like the sibling tools — never an uncaught exception.
    assert res["status"] == "error"
    assert "error_type" in res
    assert "message" in res
    assert "window" not in res


@pytest.mark.asyncio
async def test_read_centered_tool_out_of_tree_path_returns_error_envelope(tmp_path):
    import stratum_mcp.server as srv

    proj = tmp_path / "proj"
    proj.mkdir()
    outside = tmp_path / "secret.jsonl"
    outside.write_text(
        json.dumps(
            {
                "type": "assistant",
                "timestamp": "t",
                "message": {"content": [{"type": "text", "text": "TOP SECRET"}]},
            }
        )
        + "\n"
    )
    res = await srv.read_centered(
        ctx=_ctx(), session=str(outside), line_no=1, char_budget=1500,
        project_dir=str(proj),
    )
    assert res["status"] == "error"
    assert "window" not in res
