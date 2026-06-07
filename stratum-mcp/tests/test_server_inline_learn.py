"""STRAT-LEARN-INLINE — S4 MCP harvest + audit integration tests.

Real backend = the judge kernel + the real inline-learn classifier + the real
sidecar writer. Off-path byte-identity is the load-bearing assertion.
"""
from __future__ import annotations

import json
import shutil
import textwrap
from pathlib import Path

import pytest

from stratum.judge.result import JudgeResult, PredicateResult, TierRecord
from stratum.judge.staging import JUDGE_ROOT
from stratum_mcp.executor import _flows, create_flow_state, persist_flow
from stratum_mcp.server import (
    _build_audit_snapshot,
    _harvest_inline_learn,
    stratum_judge,
)
from stratum_mcp.spec import parse_and_validate

_ENV = "STRATUM_LEARN_INLINE_PATCH_ENABLED"


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
                      statement: "file_exists('artifacts/missing.txt')"
        """)


@pytest.fixture
def flow_state(tmp_path, monkeypatch):
    from stratum_mcp import executor as _exec
    monkeypatch.setattr(_exec, "_FLOWS_DIR", tmp_path)
    spec = parse_and_validate(_judge_spec())
    state = create_flow_state(
        spec=spec, flow_name="build", inputs={}, raw_spec=_judge_spec(),
    )
    state.flow_id = "inline-e2e-1"
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


def _run_judge(flow_state):
    return stratum_judge(
        flow_id=flow_state.flow_id,
        step_id="verify",
        predicates=[{
            "id": "p1",
            "type": "deterministic",
            "statement": "file_exists('artifacts/missing.txt')",
        }],
        artifacts={"out": "hello"},
        ctx=_Ctx(),
    )


# --- off-path byte-identity (load-bearing) ----------------------------------

@pytest.mark.asyncio
async def test_off_path_no_inline_keys(flow_state, tmp_path, monkeypatch):
    monkeypatch.delenv(_ENV, raising=False)  # default-OFF, no stratum.toml
    result = await _run_judge(flow_state)

    # judge result dict carries no inline-learn keys
    assert "staged_patch_candidates" not in result
    assert "learn_inline" not in result
    # FlowState defaults untouched
    assert flow_state.learn_candidates == []
    assert flow_state.learn_inline_evaluated == 0
    # audit snapshot has no inline keys
    snap = _build_audit_snapshot(flow_state)
    assert "learn_inline" not in snap
    assert "staged_patch_candidates" not in snap
    # persisted JSON is free of any learn_* key
    persisted = json.loads((tmp_path / f"{flow_state.flow_id}.json").read_text())
    assert not any(k.startswith("learn_") for k in persisted)


# --- enabled, deterministic not_met → evaluated but nothing durable ---------

@pytest.mark.asyncio
async def test_enabled_evaluated_but_no_durable(flow_state, tmp_path, monkeypatch):
    monkeypatch.setenv(_ENV, "1")
    # The deterministic predicate fails (file absent) → verdict not_met →
    # classified step-local → evaluated, but no durable candidate.
    result = await _run_judge(flow_state)
    assert result["met"] is False
    assert flow_state.learn_inline_evaluated == 1
    assert flow_state.learn_candidates == []

    snap = _build_audit_snapshot(flow_state)
    assert snap["learn_inline"] == {"evaluated": 1, "durable": 0}
    assert "staged_patch_candidates" not in snap
    # no sidecar written when nothing durable
    sidecar = tmp_path / ".stratum" / "postmortem" / "inline_candidates.jsonl"
    assert not sidecar.exists()


# --- enabled, durable candidate via the real harvest path -------------------

def _judged_not_met_result():
    pr = PredicateResult(
        id="p9", type="judged", statement="the error message is actionable",
        verdict="not_met", confidence=8, applied_gate=7, evidence=[],
        tier_history=[TierRecord(tier="T2", verdict="not_met",
                                 confidence=8, reason="message lacks remediation")],
    )
    return JudgeResult(clean=False, summary="s", findings=[], meta={},
                       met=False, predicates=[pr])


@pytest.mark.asyncio
async def test_enabled_durable_harvest_writes_sidecar_and_audit(
    flow_state, tmp_path, monkeypatch
):
    monkeypatch.setenv(_ENV, "1")
    result = _judged_not_met_result()

    await _harvest_inline_learn(flow_state, result, "verify", tmp_path, _Ctx())

    # state mutated
    assert flow_state.learn_inline_evaluated == 1
    assert len(flow_state.learn_candidates) == 1
    assert flow_state.learn_candidates[0]["fix_target"] == "durable"

    # sidecar written (own schema, no label)
    sidecar = tmp_path / ".stratum" / "postmortem" / "inline_candidates.jsonl"
    rows = [json.loads(l) for l in sidecar.read_text().splitlines() if l.strip()]
    assert len(rows) == 1 and rows[0]["origin"] == "inline"
    assert "label" not in rows[0]

    # audit surfaces both keys
    snap = _build_audit_snapshot(flow_state)
    assert snap["learn_inline"] == {"evaluated": 1, "durable": 1}
    assert len(snap["staged_patch_candidates"]) == 1

    # persisted JSON now carries the (non-empty) keys
    persist_flow(flow_state)
    persisted = json.loads((tmp_path / f"{flow_state.flow_id}.json").read_text())
    assert persisted["learn_inline_evaluated"] == 1
    assert len(persisted["learn_candidates"]) == 1


# --- fail-open: a broken harvest never breaks the judge ---------------------

@pytest.mark.asyncio
async def test_harvest_fail_open(flow_state, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv(_ENV, "1")
    import stratum.judge.inline_learn as il

    async def boom(*a, **k):
        raise RuntimeError("classifier exploded")

    # The harvest helper does `from stratum.judge.inline_learn import
    # emit_candidates` per call, so patch the module attribute it reads.
    monkeypatch.setattr(il, "emit_candidates", boom)
    # Should not raise even though the harvest internals blow up.
    result = _judged_not_met_result()
    await _harvest_inline_learn(flow_state, result, "verify", tmp_path, _Ctx())
    # warning emitted, no crash
    assert "inline-learn harvest skipped" in capsys.readouterr().err


# --- LLM classifier path is actually wired (ctx threaded through) -----------

@pytest.mark.asyncio
async def test_llm_classifier_receives_ctx_and_routes(
    flow_state, tmp_path, monkeypatch
):
    """Regression for the dead-LLM-path bug: the real stratum_agent_run requires
    a ctx positional. Stub it with the real signature and assert the harvest
    threads ctx through so the LLM verdict actually steers classification."""
    monkeypatch.setenv(_ENV, "1")
    (tmp_path / "stratum.toml").write_text(
        '[learn.inline_patch]\nenabled = true\nclassifier = "llm"\n'
    )
    import stratum_mcp.server as srv

    seen = {}

    async def fake_agent_run(prompt, ctx, type="claude", **kwargs):
        # ctx must be the real object, not None — proves threading.
        seen["ctx"] = ctx
        seen["prompt"] = prompt
        return {"text": "step-local"}

    monkeypatch.setattr(srv, "stratum_agent_run", fake_agent_run)

    result = _judged_not_met_result()  # heuristic would say durable
    ctx = _Ctx()
    await _harvest_inline_learn(flow_state, result, "verify", tmp_path, ctx)

    assert seen["ctx"] is ctx                       # ctx really threaded
    assert "actionable" in seen["prompt"]           # the predicate reached the LLM
    # LLM said step-local → overrides heuristic durable → no candidate harvested
    assert flow_state.learn_candidates == []
    assert flow_state.learn_inline_evaluated == 1
