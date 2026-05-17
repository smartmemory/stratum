"""STRAT-JUDGE v2 slice 1 — T3 cold-read adversary (paranoid-only)."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from stratum.judge import kernel as kmod
from stratum.judge.kernel import run_judge
from stratum.judge.result import BudgetCaps, Predicate, TierRecord
from stratum.judge.verifier import (
    T3_ALLOWED_TOOLS,
    _build_t3_prompt,
    evaluate_t3,
)


# --- helpers -----------------------------------------------------------------

def _stage(tmp: Path) -> Path:
    root = tmp / "turn"
    (root / "artifacts").mkdir(parents=True)
    (root / "modified").mkdir(parents=True)
    (root / "artifacts" / "out.txt").write_text("hello\n")
    return root


def _pred(typ="judged"):
    return Predicate(id="p1", type=typ, statement="the thing is done", applied_gate=7)


class _CaptureRun:
    """Fake stratum_agent_run capturing kwargs; returns a fixed verdict."""

    def __init__(self, verdict="not_met", conf=8, reason="counterexample at modified/x.py:1"):
        self.calls: list[dict] = []
        self._v, self._c, self._r = verdict, conf, reason

    async def __call__(self, **kw):
        self.calls.append(kw)
        return {"text": f'{{"predicate_id":"p1","verdict":"{self._v}",'
                        f'"confidence":{self._c},"reason":"{self._r}","evidence":[]}}'}


# --- evaluate_t3 isolation + dispatch ----------------------------------------

def test_evaluate_t3_signature_excludes_t2_records():
    """Cold-read is structural: the function cannot accept T2 evidence."""
    params = set(inspect.signature(evaluate_t3).parameters)
    assert params == {"predicate", "staging_root", "stratum_agent_run", "ctx"}
    # no tier_record / evidence / t2 param exists to leak through
    assert not any("t2" in p or "evidence" in p or "record" in p for p in params)


def test_t3_prompt_is_cold_no_t2_leak(tmp_path):
    p = _pred()
    prompt = _build_t3_prompt(p, _stage(tmp_path))
    assert "the thing is done" in prompt and "ADVERSARY" in prompt
    # a sentinel a caller might have in T2 reason must not appear
    assert "__T2_LEAK__" not in prompt


@pytest.mark.asyncio
async def test_evaluate_t3_dispatch_kwargs(tmp_path):
    run = _CaptureRun(verdict="not_met")
    root = _stage(tmp_path)
    await evaluate_t3(_pred(), root, run, ctx=None)
    kw = run.calls[0]
    assert kw["type"] == "claude"
    assert kw["allowed_tools"] == T3_ALLOWED_TOOLS == ["Read", "Grep", "Glob"]
    assert "Bash" in kw["disallowed_tools"]
    assert kw["cwd"] == str(root)


@pytest.mark.asyncio
async def test_evaluate_t3_fail_safe_empty_staging(tmp_path):
    empty = tmp_path / "empty"
    (empty / "artifacts").mkdir(parents=True)
    (empty / "modified").mkdir(parents=True)
    rec, ev = await evaluate_t3(_pred(), empty, _CaptureRun(), ctx=None)
    assert rec.verdict == "ambiguous" and rec.reason == "t3_no_staged_evidence"
    assert ev == []


@pytest.mark.asyncio
async def test_evaluate_t3_missing_root_never_met(tmp_path):
    rec, _ = await evaluate_t3(_pred(), tmp_path / "nope", _CaptureRun("met"), ctx=None)
    assert rec.verdict == "ambiguous"  # never fabricates met on no evidence


# --- kernel wiring: paranoid-only escalation ---------------------------------

async def _run(stakes, t2_verdict, t3_verdict, ptype="judged", tmp=None, monkeypatch=None):
    """Drive run_judge with faked T2/T3 evaluators."""
    async def fake_t2(p, root, run, ctx):
        return TierRecord(tier="T2", verdict=t2_verdict, confidence=9,
                          reason="__T2_LEAK__"), []

    t3_called = {"n": 0}

    async def fake_t3(p, root, run, ctx):
        t3_called["n"] += 1
        return TierRecord(tier="T3", verdict=t3_verdict, confidence=8,
                          reason="adv"), []

    monkeypatch.setattr(kmod, "evaluate_t2", fake_t2)
    monkeypatch.setattr(kmod, "evaluate_t3", fake_t3)
    res = await run_judge(
        flow_id="f1", step_id="s1",
        predicates=[Predicate(id="p1", type=ptype, statement="x", applied_gate=7)],
        artifacts={}, modified_files=[], stakes=stakes,
        budget=BudgetCaps(), workspace_root=tmp, stratum_agent_run=_CaptureRun(),
        ctx=None,
    )
    return res, t3_called["n"]


@pytest.mark.asyncio
async def test_paranoid_no_longer_raises(tmp_path, monkeypatch):
    res, n_t3 = await _run("paranoid", "met", "met", tmp=tmp_path, monkeypatch=monkeypatch)
    assert res.met is True and n_t3 == 1  # T3 ran, adversary failed → met stands


@pytest.mark.asyncio
async def test_default_does_not_run_t3(tmp_path, monkeypatch):
    res, n_t3 = await _run("default", "met", "not_met", tmp=tmp_path, monkeypatch=monkeypatch)
    assert n_t3 == 0  # default path byte-for-byte v1
    assert res.met is True


@pytest.mark.asyncio
async def test_paranoid_disagreement_to_ambiguous(tmp_path, monkeypatch):
    res, n_t3 = await _run("paranoid", "met", "not_met", tmp=tmp_path, monkeypatch=monkeypatch)
    assert n_t3 == 1
    assert res.met is False  # T2 met + T3 not_met → ambiguous, not met
    assert len(res.tier_disagreements) == 1
    d = res.tier_disagreements[0]
    assert d["predicate"] == "p1" and d["tiers"] == ["T2", "T3"]


@pytest.mark.asyncio
async def test_paranoid_t3_not_run_on_t2_not_met(tmp_path, monkeypatch):
    res, n_t3 = await _run("paranoid", "not_met", "met", tmp=tmp_path, monkeypatch=monkeypatch)
    assert n_t3 == 0  # adversary only attacks met claims


@pytest.mark.asyncio
async def test_t3_cannot_read_same_predicate_prior_rows(tmp_path, monkeypatch):
    """Cold-read side-channel: when T3 runs, this predicate's T1/T2 rows must
    NOT yet be on disk in turns.jsonl (deferred-flush ordering)."""
    from stratum.judge import logging as lmod

    # turns.jsonl is written via logging.JUDGE_ROOT (distinct from
    # staging.JUDGE_ROOT). Isolate it so this test is hermetic and reads the
    # SAME file append_turn_log writes.
    log_root = tmp_path / "judgelog"
    monkeypatch.setattr(lmod, "JUDGE_ROOT", log_root)

    async def fake_t2(p, root, run, ctx):
        return TierRecord("T2", "met", 9, "__T2_LEAK__"), []

    seen: dict = {}

    async def spy_t3(p, root, run, ctx):
        # inspect the real shared turns.jsonl at T3-dispatch time
        jr = log_root / "f1" / "turns.jsonl"  # per-flow, not per-step
        seen["text"] = jr.read_text() if jr.exists() else ""
        return TierRecord("T3", "met", 8, "ok"), []

    monkeypatch.setattr(kmod, "evaluate_t2", fake_t2)
    monkeypatch.setattr(kmod, "evaluate_t3", spy_t3)
    await run_judge(
        flow_id="f1", step_id="s1",
        predicates=[Predicate(id="p1", type="judged", statement="x", applied_gate=7)],
        artifacts={}, modified_files=[], stakes="paranoid",
        budget=BudgetCaps(), workspace_root=tmp_path,
        stratum_agent_run=_CaptureRun(), ctx=None,
    )
    # p1's T1/T2 verdicts must not be visible to T3
    assert '"predicate_id": "p1"' not in seen["text"]
    assert "__T2_LEAK__" not in seen["text"]


@pytest.mark.asyncio
async def test_degraded_judged_semantics(tmp_path, monkeypatch):
    # judged + default → no adversary → degraded True
    res_d, _ = await _run("default", "met", "met", ptype="judged", tmp=tmp_path, monkeypatch=monkeypatch)
    assert res_d.judge_kernel_meta.degraded_judged is True
    # judged + paranoid + T3 ran → degraded False
    res_p, _ = await _run("paranoid", "met", "met", ptype="judged", tmp=tmp_path, monkeypatch=monkeypatch)
    assert res_p.judge_kernel_meta.degraded_judged is False
