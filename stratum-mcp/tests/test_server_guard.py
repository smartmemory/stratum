"""E2E tests for the 5 STRAT-GUARD MCP tools (S5).

Tools are tested by importing and awaiting them directly with a fake Context,
mirroring tests/test_server_judge.py. Errors must come back as the canonical
{status: error, ...} dict, never as a raised exception across the boundary.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum_mcp import server
from stratum_mcp.guard import store


@pytest.fixture
def guards_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "GUARDS_DIR", tmp_path / "guards")
    store._locks.clear()
    yield tmp_path / "guards"
    store._locks.clear()


class _Ctx:
    async def report_progress(self, *a, **k):
        pass


@pytest.mark.asyncio
async def test_register_transition_history_e2e(guards_dir, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "design.md").write_text("design")

    reg = await server.stratum_guard_register(
        resource_id="compose:FEAT-9",
        graph={"draft": ["shipped"], "shipped": []},
        edge_predicates={
            "draft->shipped": [
                {"id": "p", "type": "deterministic", "statement": "server_file_exists('design.md')"}
            ]
        },
        initial="draft",
        ctx=_Ctx(),
        terminal=["shipped"],
        workspace_root=str(ws),
    )
    assert reg["status"] == "registered"
    assert reg["checksum"]

    res = await server.stratum_guard_transition(
        resource_id="compose:FEAT-9",
        from_state="draft",
        to_state="shipped",
        artifacts={},
        ctx=_Ctx(),
    )
    assert res["status"] == "applied"
    assert res["current_state"] == "shipped"

    hist = await server.stratum_guard_history(resource_id="compose:FEAT-9", ctx=_Ctx())
    assert hist["current_state"] == "shipped"
    assert len(hist["ledger"]) == 1


@pytest.mark.asyncio
async def test_transition_refused_returns_dict_not_exception(guards_dir, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()  # no design.md -> evidence fails
    await server.stratum_guard_register(
        resource_id="r",
        graph={"a": ["b"], "b": []},
        edge_predicates={"a->b": [{"id": "p", "statement": "server_file_exists('design.md')"}]},
        initial="a",
        ctx=_Ctx(),
        workspace_root=str(ws),
    )
    res = await server.stratum_guard_transition(
        resource_id="r", from_state="a", to_state="b", artifacts={}, ctx=_Ctx()
    )
    assert res["status"] == "refused"


@pytest.mark.asyncio
async def test_bad_register_returns_error_dict(guards_dir, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    # invalid state name -> error dict, not raise
    res = await server.stratum_guard_register(
        resource_id="r",
        graph={"a/b": ["c"], "c": []},
        edge_predicates={},
        initial="a/b",
        ctx=_Ctx(),
        workspace_root=str(ws),
    )
    assert res["status"] == "error"
    assert res["error_type"] == "invalid_state_name"


@pytest.mark.asyncio
async def test_unknown_resource_history_error_dict(guards_dir):
    res = await server.stratum_guard_history(resource_id="nope", ctx=_Ctx())
    assert res["status"] == "error"
    assert res["error_type"] == "guard_not_found"


@pytest.mark.asyncio
async def test_override_token_flow(guards_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"
    ws.mkdir()  # no design.md
    await server.stratum_guard_register(
        resource_id="r",
        graph={"a": ["b"], "b": []},
        edge_predicates={"a->b": [{"id": "p", "statement": "server_file_exists('design.md')"}]},
        initial="a",
        ctx=_Ctx(),
        workspace_root=str(ws),
    )
    res = await server.stratum_guard_override(
        resource_id="r",
        from_state="a",
        to_state="b",
        override_token="secret",
        rationale="manual",
        ctx=_Ctx(),
        resolved_by="human",
    )
    assert res["status"] == "deviation"
    assert res["current_state"] == "b"
