#!/usr/bin/env python3
"""Run P6's hand-authored v0 references through the Python public test seam.

This intentionally imports the checkout read-only and drives the same manual
``stratum_plan`` / ``stratum_step_done`` / ``stratum_parallel_done`` APIs used
by the Python integration tests. It never translates or rewrites a spec.
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# The engine repo keeps the core and MCP test dependencies in sibling virtual
# environments.  Importing them here is read-only; it avoids an install step.
for site_packages in (ROOT / ".venv" / "lib").glob("python*/site-packages"):
    sys.path.insert(0, str(site_packages))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "stratum-mcp" / "src"))

from stratum_mcp import executor  # noqa: E402
from stratum_mcp.executor import _flows  # noqa: E402
from stratum_mcp.server import (  # noqa: E402
    stratum_gate_resolve,
    stratum_parallel_done,
    stratum_plan,
    stratum_step_done,
)


def spec(name: str) -> str:
    return (Path(__file__).parent / f"{name}.v0.yaml").read_text()


def step_ok(response: dict) -> dict:
    assert response.get("status") not in {"ensure_failed", "error"}, response
    return response


async def linear_gate() -> dict:
    plan = await stratum_plan(spec("linear-gate"), "main", {"name": "Ada"}, None)
    flow_id = plan["flow_id"]
    for step in ("prepare", "draft", "check"):
        step_ok(await stratum_step_done(flow_id, step, {"value": step}, None))
    gate = await stratum_gate_resolve(flow_id, "review", "approve", "P6 reference", "human", None)
    assert gate.get("status") != "error", gate
    for step in ("refine", "publish"):
        response = step_ok(await stratum_step_done(flow_id, step, {"value": step}, None))
    # step_ok asserted no step hit ensure_failed, so "passed" is observed.
    # An approve outcome is also observed: on_revise routes back to prepare,
    # so refine/publish only complete in order after a real approve.
    return {"terminal": response["status"], "ensures": "passed", "gate": "approve"}


async def fanout() -> dict:
    plan = await stratum_plan(spec("fanout"), "main", {"tasks": [{"name": "a"}, {"name": "b"}]}, None)
    response = step_ok(await stratum_parallel_done(
        plan["flow_id"], "fan",
        [{"task_id": "a", "status": "complete", "result": {"value": "a"}}, {"task_id": "b", "status": "complete", "result": {"value": "b"}}],
        "clean", None,
    ))
    return {"terminal": response["status"], "ensures": "passed", "gate": None}


async def subflow() -> dict:
    plan = await stratum_plan(spec("subflow"), "main", {"name": "Ada"}, None)
    flow_id = plan["flow_id"]
    response = step_ok(await stratum_step_done(flow_id, "before", {"value": "before"}, None))
    child_id = response["child_flow_id"]
    step_ok(await stratum_step_done(child_id, "child_one", {"value": "one"}, None))
    child_done = step_ok(await stratum_step_done(child_id, "child_two", {"value": "two"}, None))
    step_ok(await stratum_step_done(flow_id, "wrap", child_done, None))
    response = step_ok(await stratum_step_done(flow_id, "after", {"value": "after"}, None))
    return {"terminal": response["status"], "ensures": "passed", "gate": None}


EXPECTED = {
    "linear-gate": {"terminal": "complete", "ensures": "passed", "gate": "approve"},
    "fanout": {"terminal": "complete", "ensures": "passed", "gate": None},
    "subflow": {"terminal": "complete", "ensures": "passed", "gate": None},
}


async def main() -> None:
    with tempfile.TemporaryDirectory(prefix="stratum-p6-parity-") as directory:
        executor._FLOWS_DIR = Path(directory)
        try:
            result = {"linear-gate": await linear_gate(), "fanout": await fanout(), "subflow": await subflow()}
            print(json.dumps(result, sort_keys=True))
            if result != EXPECTED:
                raise SystemExit(f"parity mismatch: expected {json.dumps(EXPECTED, sort_keys=True)}")
        finally:
            _flows.clear()


if __name__ == "__main__":
    asyncio.run(main())
