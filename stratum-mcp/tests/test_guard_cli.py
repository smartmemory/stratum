"""CLI surface for STRAT-GUARD (`stratum-mcp guard <action>`).

The guard primitive ships as MCP tools + a Python library, but compose's server
reaches stratum over the CLI-subprocess seam (server/stratum-client.js). This
exposes register/transition/override/migrate/history as `guard` subcommands so
that seam can drive the guard. Wire format: each action reads ONE JSON object of
kwargs from stdin and prints a JSON result; domain errors print the canonical
{status: error, ...} dict and exit non-zero.
"""

import io
import json
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


def _run(monkeypatch, capsys, action, kwargs):
    """Invoke `_cmd_guard([action])` with `kwargs` piped on stdin.

    Returns (parsed_json, exit_code). exit_code is 0 unless _cmd_guard called
    sys.exit (domain error / bad input)."""
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(kwargs)))
    code = 0
    try:
        server._cmd_guard([action])
    except SystemExit as exc:  # noqa: PT017 — we assert on the code below
        code = exc.code if isinstance(exc.code, int) else 1
    out = capsys.readouterr().out
    return json.loads(out), code


# --------------------------------------------------------------------------- #
# Golden flow: register -> transition(applied) -> transition(refused) -> history
# --------------------------------------------------------------------------- #


def test_guard_cli_golden_flow(guards_dir, tmp_path, monkeypatch, capsys):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "design.md").write_text("# design")

    reg, code = _run(monkeypatch, capsys, "register", {
        "resource_id": "compose:abc:FEAT-1",
        "graph": {"explore_design": ["blueprint"], "blueprint": ["verification"], "verification": []},
        "edge_predicates": {
            "explore_design->blueprint": [
                {"id": "design", "type": "deterministic", "statement": "server_file_exists('design.md')"}
            ],
            "blueprint->verification": [
                {"id": "bp", "type": "deterministic", "statement": "server_file_exists('blueprint.md')"}
            ],
        },
        "initial": "explore_design",
        "terminal": ["verification"],
        "workspace_root": str(ws),
    })
    assert code == 0
    assert reg["status"] in ("registered", "exists")
    assert reg["checksum"]

    # design.md exists -> applied
    applied, code = _run(monkeypatch, capsys, "transition", {
        "resource_id": "compose:abc:FEAT-1",
        "from_state": "explore_design",
        "to_state": "blueprint",
        "resolved_by": "agent",
    })
    assert code == 0
    assert applied["status"] == "applied"
    assert applied["current_state"] == "blueprint"

    # blueprint.md absent -> refused (server-read evidence, not caller claim)
    refused, code = _run(monkeypatch, capsys, "transition", {
        "resource_id": "compose:abc:FEAT-1",
        "from_state": "blueprint",
        "to_state": "verification",
    })
    assert code == 0  # refusal is a normal verdict, not a CLI error
    assert refused["status"] == "refused"
    assert refused["current_state"] == "blueprint"  # state did NOT advance

    hist, code = _run(monkeypatch, capsys, "history", {"resource_id": "compose:abc:FEAT-1"})
    assert code == 0
    assert hist["current_state"] == "blueprint"
    outcomes = [e["outcome"] for e in hist["ledger"]]
    assert "applied" in outcomes and "refused" in outcomes


def test_guard_cli_idempotent_register(guards_dir, tmp_path, monkeypatch, capsys):
    ws = tmp_path / "ws"
    ws.mkdir()
    payload = {
        "resource_id": "compose:abc:FEAT-2",
        "graph": {"a": ["b"], "b": []},
        "edge_predicates": {},
        "initial": "a",
        "terminal": ["b"],
        "workspace_root": str(ws),
    }
    first, _ = _run(monkeypatch, capsys, "register", payload)
    second, code = _run(monkeypatch, capsys, "register", payload)
    assert code == 0
    assert second["status"] == "exists"
    assert second["checksum"] == first["checksum"]


# --------------------------------------------------------------------------- #
# Override / history
# --------------------------------------------------------------------------- #


def test_guard_cli_override(guards_dir, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret-token")
    ws = tmp_path / "ws"
    ws.mkdir()
    _run(monkeypatch, capsys, "register", {
        "resource_id": "compose:abc:FEAT-3",
        "graph": {"a": ["b"], "b": []},
        "edge_predicates": {"a->b": [
            {"id": "x", "type": "deterministic", "statement": "server_file_exists('never.md')"}
        ]},
        "initial": "a",
        "terminal": ["b"],
        "workspace_root": str(ws),
    })
    dev, code = _run(monkeypatch, capsys, "override", {
        "resource_id": "compose:abc:FEAT-3",
        "from_state": "a",
        "to_state": "b",
        "override_token": "secret-token",
        "rationale": "manual ship, predicate known-stale",
        "resolved_by": "human",
    })
    assert code == 0
    assert dev["status"] == "deviation"
    assert dev["current_state"] == "b"


# --------------------------------------------------------------------------- #
# Error harness
# --------------------------------------------------------------------------- #


def test_guard_cli_unknown_action(guards_dir, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    with pytest.raises(SystemExit) as exc:
        server._cmd_guard(["frobnicate"])
    assert exc.value.code != 0


def test_guard_cli_bad_json(guards_dir, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("{not json"))
    with pytest.raises(SystemExit) as exc:
        server._cmd_guard(["history"])
    assert exc.value.code != 0
    out = capsys.readouterr().out
    assert json.loads(out)["status"] == "error"


def test_guard_cli_illegal_edge_is_error_dict(guards_dir, tmp_path, monkeypatch, capsys):
    ws = tmp_path / "ws"
    ws.mkdir()
    _run(monkeypatch, capsys, "register", {
        "resource_id": "compose:abc:FEAT-4",
        "graph": {"a": ["b"], "b": []},
        "edge_predicates": {},
        "initial": "a",
        "terminal": ["b"],
        "workspace_root": str(ws),
    })
    res, code = _run(monkeypatch, capsys, "transition", {
        "resource_id": "compose:abc:FEAT-4",
        "from_state": "a",
        "to_state": "nonexistent",
    })
    assert code != 0
    assert res["status"] == "error"
    assert res["error_type"]  # canonical GuardError surface


def test_guard_cli_history_not_found(guards_dir, monkeypatch, capsys):
    res, code = _run(monkeypatch, capsys, "history", {"resource_id": "compose:nope:NONE"})
    assert code != 0
    assert res["status"] == "error"
