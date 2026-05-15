"""Tests for the stratum_judge MCP tool registration (STRAT-JUDGE v1 C3).

Real backend = the kernel itself; only ``stratum_agent_run`` would be mocked
when T2 fires. v1 deterministic predicates do NOT invoke T2, so the kernel
runs end-to-end with no stub. The cwd-based flow lookup paths are exercised
against a real FlowState.
"""
from __future__ import annotations

import shutil
import textwrap
from pathlib import Path

import pytest

from stratum.judge.staging import JUDGE_ROOT
from stratum_mcp import server as server_mod
from stratum_mcp.executor import _flows, create_flow_state
from stratum_mcp.server import stratum_judge, _parse_budget
from stratum_mcp.spec import parse_and_validate


def _judge_spec() -> str:
    return textwrap.dedent("""\
        version: "0.3"
        flows:
          build:
            input: {}
            output: ""
            steps:
              - id: verify
                agent: claude
                ensure: ["result.met == True"]
                judge:
                  predicates:
                    - id: p1
                      type: deterministic
                      statement: "file_exists('artifacts/out.txt')"
        """)


@pytest.fixture
def flow_state(tmp_path, monkeypatch):
    from stratum_mcp import executor as _exec
    monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
    spec = parse_and_validate(_judge_spec())
    state = create_flow_state(
        spec=spec, flow_name="build", inputs={}, raw_spec=_judge_spec(),
    )
    state.flow_id = "judge-e2e-1"
    state.cwd = str(tmp_path)
    _flows[state.flow_id] = state
    yield state
    _flows.pop(state.flow_id, None)
    judge_dir = JUDGE_ROOT / state.flow_id
    if judge_dir.exists():
        shutil.rmtree(judge_dir, ignore_errors=True)


class _Ctx:
    async def report_progress(self, *args, **kwargs):
        pass


@pytest.mark.asyncio
async def test_stratum_judge_returns_judge_result_dict(flow_state):
    result = await stratum_judge(
        flow_id=flow_state.flow_id,
        step_id="verify",
        predicates=[{
            "id": "p1",
            "type": "deterministic",
            "statement": "file_exists('artifacts/out.txt')",
        }],
        artifacts={"out": "hello world"},
        ctx=_Ctx(),
    )
    # Shape: JudgeResult.to_dict()
    assert result["judge_version"] == "1.0"
    assert result["met"] is True
    assert result["clean"] is True
    assert result["stakes"] == "default"
    assert isinstance(result["predicates"], list)
    assert result["predicates"][0]["verdict"] == "met"
    # Persistence: FlowState updated.
    assert "verify" in flow_state.judge_history
    assert flow_state.judge_outcome["verify"]["met"] is True


@pytest.mark.asyncio
async def test_stratum_judge_flow_not_found_response():
    response = await stratum_judge(
        flow_id="nonexistent-flow-id",
        step_id="x",
        predicates=[{"id": "p", "type": "deterministic", "statement": "True"}],
        artifacts={},
        ctx=_Ctx(),
    )
    assert response["status"] == "error"
    assert response["error_type"] == "flow_not_found"


# --- STRAT-IMMUTABLE: caller payload must match IR declaration ---------------
# These tests cover the new layered defence: predicates / stakes / budget
# mismatches are rejected at the MCP boundary before reaching the kernel.

@pytest.mark.asyncio
async def test_stratum_judge_predicates_mismatch_rejected(flow_state):
    """Caller-supplied predicates that diverge from the IR's judge: block
    are rejected — prevents weakening the gate the flow declared."""
    response = await stratum_judge(
        flow_id=flow_state.flow_id,
        step_id="verify",
        predicates=[],  # empty — does not match the IR's [{p1...}]
        artifacts={},
        ctx=_Ctx(),
    )
    assert response["status"] == "error"
    assert response["error_type"] == "predicates_mismatch"


@pytest.mark.asyncio
async def test_stratum_judge_paranoid_stakes_mismatch_rejected(flow_state):
    """Stakes override is also rejected at the boundary, before the kernel
    can see 'paranoid' and raise StakesNotAvailableError."""
    response = await stratum_judge(
        flow_id=flow_state.flow_id,
        step_id="verify",
        predicates=[{
            "id": "p1",
            "type": "deterministic",
            "statement": "file_exists('artifacts/out.txt')",
        }],
        artifacts={},
        stakes="paranoid",
        ctx=_Ctx(),
    )
    assert response["status"] == "error"
    assert response["error_type"] == "stakes_mismatch"


@pytest.mark.asyncio
async def test_stratum_judge_step_id_mismatch_rejected(flow_state):
    """Invoking against a different step_id than the current judge step is
    rejected — prevents firing the kernel for a non-current step."""
    response = await stratum_judge(
        flow_id=flow_state.flow_id,
        step_id="some_other_step",
        predicates=[{
            "id": "p1",
            "type": "deterministic",
            "statement": "file_exists('artifacts/out.txt')",
        }],
        artifacts={},
        ctx=_Ctx(),
    )
    assert response["status"] == "error"
    assert response["error_type"] == "step_mismatch"


# --- Verified-predicate path: requires spec with matching verified predicate -

def _verified_judge_spec() -> str:
    return textwrap.dedent("""\
        version: "0.3"
        flows:
          build:
            input: {}
            output: ""
            steps:
              - id: verify
                agent: claude
                ensure: ["result.met == True"]
                judge:
                  predicates:
                    - id: p2
                      type: verified
                      statement: "evidence is fine"
        """)


@pytest.fixture
def verified_flow_state(tmp_path, monkeypatch):
    from stratum_mcp import executor as _exec
    monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
    spec = parse_and_validate(_verified_judge_spec())
    state = create_flow_state(
        spec=spec, flow_name="build", inputs={},
        raw_spec=_verified_judge_spec(),
    )
    state.flow_id = "judge-verified-1"
    state.cwd = str(tmp_path)
    _flows[state.flow_id] = state
    yield state
    _flows.pop(state.flow_id, None)
    judge_dir = JUDGE_ROOT / state.flow_id
    if judge_dir.exists():
        shutil.rmtree(judge_dir, ignore_errors=True)


@pytest.mark.asyncio
async def test_stratum_judge_calls_kernel_with_agent_run_reference(
    verified_flow_state, monkeypatch
):
    """When T2 fires (verified predicate), the kernel receives the
    server's ``stratum_agent_run`` as the dispatch callable. Mock at the
    test boundary per testing.md."""
    captured = {}

    async def fake_evaluate_t2(predicate, staging_root, stratum_agent_run, ctx):
        captured["passed_callable"] = stratum_agent_run
        captured["predicate_id"] = predicate.id
        from stratum.judge import Evidence, TierRecord
        return TierRecord(tier="T2", verdict="met", confidence=10,
                          reason="mocked"), [
            Evidence(source="artifacts/x.txt:1", quote="ok", tier="T2"),
        ]

    monkeypatch.setattr("stratum.judge.kernel.evaluate_t2", fake_evaluate_t2)

    result = await stratum_judge(
        flow_id=verified_flow_state.flow_id,
        step_id="verify",
        predicates=[{
            "id": "p2",
            "type": "verified",
            "statement": "evidence is fine",
        }],
        artifacts={"x": "hello"},
        ctx=_Ctx(),
    )
    assert "passed_callable" in captured
    assert captured["passed_callable"] is server_mod.stratum_agent_run
    assert result["met"] is True


class TestParseBudget:
    def test_none(self):
        assert _parse_budget(None) is None

    def test_empty(self):
        assert _parse_budget({}) is None

    def test_known_keys(self):
        bc = _parse_budget({"max_turns": 3, "max_wall_clock_s": 30})
        assert bc.max_turns == 3
        assert bc.max_wall_clock_s == 30
        assert bc.max_dollars is None

    def test_unknown_keys_ignored(self):
        bc = _parse_budget({"max_turns": 1, "bogus": "x"})
        assert bc.max_turns == 1
