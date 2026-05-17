"""STRAT-JUDGE-POSTMORTEM v2.1 — LLM-augmented segmenter gate."""

from __future__ import annotations

from pathlib import Path

import pytest

import json as _json

from stratum.judge.postmortem import cli as pm_cli
from stratum.judge.postmortem.cli import _candidate_to_dict
from stratum.judge.postmortem.llm_gate import (
    DEFAULT_GATE_MODEL,
    GateVerdict,
    LiteLLMGate,
    SegmentStats,
    build_gate_prompt,
    parse_gate_response,
)
from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.postmortem.segmenter import segment
from stratum.judge.postmortem.signals import label_candidate


# --- fixtures ----------------------------------------------------------------

def _ev(kind, line, text="", tool_name=None):
    return Event(
        session_id="S",
        line_no=line,
        timestamp="2026-05-17T00:00:00Z",
        kind=kind,
        text=text,
        tool_name=tool_name,
    )


def _softwrap_session() -> Session:
    """The design.md:194 misattribution shape: a vague request, real tool
    work, then an explicit completion claim about a *different* task."""
    events = [
        _ev("user_text", 1, "remove the memory id, and let's figure out how to ingest the corpus"),
        _ev("assistant_text", 2, "Looking into it."),
        _ev("tool_use", 3, tool_name="Edit"),
        _ev("tool_use", 4, tool_name="Bash"),
        _ev("assistant_text", 5, "Done. All four paragraphs now soft-wrap uniformly."),
        _ev("user_text", 6, "thanks"),
    ]
    return Session(session_id="S", source_path=Path("/tmp/S.jsonl"), events=events)


class _FakeGate:
    def __init__(self, verdict: GateVerdict):
        self._v = verdict
        self.calls = 0

    def check(self, request_text, claim_text, work_summary) -> GateVerdict:
        self.calls += 1
        return self._v


# --- segment() integration ---------------------------------------------------

def test_no_gate_preserves_segmenter_behavior():
    """gate=None ⇒ segmenter behavior unchanged from pre-v2.1: same
    candidate identity, span, and claim. (Serialized JSONL legitimately
    changes — schema is now 1.1 with an always-present `gate` key.)"""
    sess = _softwrap_session()
    cands = segment(sess)
    assert len(cands) == 1
    c = cands[0]
    # Frozen expected values from the fixture, not a self-comparison.
    assert c.candidate_id == "S:L1"
    assert c.request_line == 1
    assert c.claim_marker.line_no == 5
    assert c.claim_kind == "explicit"
    assert len(c.work_span) == 3  # events L2..L4 (assistant + 2 tool_use)
    assert c.gate_verdict is None


def test_confident_mismatch_is_dropped():
    sess = _softwrap_session()
    gate = _FakeGate(GateVerdict(same_task=False, confidence=0.95, reason="different task"))
    stats = SegmentStats()
    cands = segment(sess, gate=gate, gate_threshold=0.7, stats=stats)
    assert cands == []
    assert gate.calls == 1
    assert stats.gate_checked == 1
    assert stats.gate_rejected == 1


def test_same_task_is_kept_with_verdict_recorded():
    sess = _softwrap_session()
    gate = _FakeGate(GateVerdict(same_task=True, confidence=0.9, reason="same"))
    stats = SegmentStats()
    cands = segment(sess, gate=gate, stats=stats)
    assert len(cands) == 1
    assert cands[0].gate_verdict.same_task is True
    assert stats.gate_checked == 1
    assert stats.gate_rejected == 0


def test_below_threshold_mismatch_is_kept():
    sess = _softwrap_session()
    gate = _FakeGate(GateVerdict(same_task=False, confidence=0.5, reason="unsure"))
    cands = segment(sess, gate=gate, gate_threshold=0.7)
    assert len(cands) == 1
    assert cands[0].gate_verdict.confidence == 0.5


def test_fail_open_verdict_never_drops():
    sess = _softwrap_session()
    gate = _FakeGate(
        GateVerdict(same_task=False, confidence=1.0, reason="gate_error:X", applied=False)
    )
    stats = SegmentStats()
    cands = segment(sess, gate=gate, gate_threshold=0.7, stats=stats)
    assert len(cands) == 1  # applied=False ⇒ kept despite confident mismatch
    assert stats.gate_rejected == 0


def test_stats_accumulate_across_sessions():
    gate = _FakeGate(GateVerdict(same_task=False, confidence=0.99, reason="x"))
    stats = SegmentStats()
    segment(_softwrap_session(), gate=gate, stats=stats)
    segment(_softwrap_session(), gate=gate, stats=stats)
    assert stats.gate_checked == 2
    assert stats.gate_rejected == 2


# --- prompt builder ----------------------------------------------------------

def test_build_gate_prompt_includes_request_and_claim():
    p = build_gate_prompt("REQ_TOKEN add a feature", "CLAIM_TOKEN done", "Edit, Bash")
    assert "REQ_TOKEN" in p and "CLAIM_TOKEN" in p and "Edit, Bash" in p


def test_build_gate_prompt_caps_fields():
    p = build_gate_prompt("r" * 5000, "c" * 5000, "w" * 5000)
    assert p.count("r") <= 1600 and p.count("c") <= 1600


# --- parser ------------------------------------------------------------------

@pytest.mark.parametrize(
    "text",
    [
        '{"same_task": true, "confidence": 0.8, "reason": "ok"}',
        '```json\n{"same_task": true, "confidence": 0.8, "reason": "ok"}\n```',
        'Sure! {"same_task": true, "confidence": 0.8, "reason": "ok"} hope that helps',
    ],
)
def test_parse_valid_variants(text):
    v = parse_gate_response(text, model="m")
    assert v.applied is True and v.same_task is True
    assert v.confidence == 0.8 and v.model == "m"


@pytest.mark.parametrize(
    "text",
    [
        "not json at all",
        "{",
        '{"same_task": "no", "confidence": 7}',          # out-of-range + missing reason
        '{"same_task": "no", "confidence": 0.5, "reason": "x"}',  # non-bool same_task
        '{"confidence": null, "same_task": true, "reason": "x"}',  # null confidence
        '{"same_task": true, "confidence": 0.5}',          # missing reason
    ],
)
def test_parse_invalid_is_fail_open(text):
    v = parse_gate_response(text, model="m")
    assert v.applied is False
    assert v.same_task is True  # fail-open ⇒ never causes a drop
    assert v.reason.startswith("gate_error:")


# --- LiteLLMGate -------------------------------------------------------------

def test_litellm_gate_constructs_without_api_key():
    g = LiteLLMGate()
    assert g.model == DEFAULT_GATE_MODEL  # no network, no key needed


def test_litellm_gate_is_fail_open_on_error(monkeypatch):
    import stratum.judge.postmortem.llm_gate as mod

    def _boom(*a, **k):
        raise RuntimeError("auth failed")

    monkeypatch.setattr(mod.litellm, "completion", _boom)
    v = LiteLLMGate().check("req", "claim", "Edit")
    assert v.applied is False and v.same_task is True
    assert v.reason == "gate_error:RuntimeError"


def test_litellm_gate_fail_open_on_non_string_content(monkeypatch):
    """Regression: a non-string message.content (block list) must not escape
    parse_gate_response and abort extraction — it fail-opens."""
    import stratum.judge.postmortem.llm_gate as mod

    def _weird(*a, **k):
        return {"choices": [{"message": {"content": [{"type": "text", "text": "x"}]}}]}

    monkeypatch.setattr(mod.litellm, "completion", _weird)
    v = LiteLLMGate().check("req", "claim", "Edit")
    assert v.applied is False and v.same_task is True
    assert v.reason.startswith("gate_error:")


def test_litellm_gate_parses_success(monkeypatch):
    import stratum.judge.postmortem.llm_gate as mod

    def _ok(*a, **k):
        return {"choices": [{"message": {"content": '{"same_task": false, "confidence": 0.91, "reason": "diff"}'}}]}

    monkeypatch.setattr(mod.litellm, "completion", _ok)
    v = LiteLLMGate(model="mdl").check("req", "claim", "Edit")
    assert v.applied is True and v.same_task is False
    assert v.confidence == 0.91 and v.model == "mdl"


# --- schema ------------------------------------------------------------------

def test_candidate_dict_schema_1_1_and_gate_key():
    sess = _softwrap_session()
    gate = _FakeGate(GateVerdict(same_task=True, confidence=0.8, reason="ok", model="m"))
    cand = segment(sess, gate=gate)[0]
    rec = _candidate_to_dict(cand, label_candidate(cand), project="p")
    assert rec["_schema_version"] == "1.2"
    assert rec["gate"] is not None
    assert rec["gate"]["same_task"] is True and rec["gate"]["applied"] is True

    plain = segment(sess)[0]
    rec2 = _candidate_to_dict(plain, label_candidate(plain), project="p")
    assert rec2["_schema_version"] == "1.2" and rec2["gate"] is None


# --- cmd_extract wiring ------------------------------------------------------

def test_cmd_extract_llm_gate_wiring(tmp_path, monkeypatch, capsys):
    """--llm-gate constructs the gate, threads a shared SegmentStats, writes
    the gate verdict into the JSONL, and reports checked/rejected counts."""
    proj = tmp_path / "proj"
    proj.mkdir()
    session = [
        {"type": "user", "message": {"content": "remove the memory id, and let's figure out how to ingest"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "name": "Edit", "id": "t1", "input": {}}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Done. All four paragraphs now soft-wrap uniformly."}]}},
        {"type": "user", "message": {"content": "thanks"}},
    ]
    (proj / "S1.jsonl").write_text("\n".join(_json.dumps(r) for r in session))

    class _RejectGate:
        def __init__(self, *a, **k):
            pass

        def check(self, *a, **k):
            return GateVerdict(same_task=False, confidence=0.99, reason="different task")

    monkeypatch.setattr(pm_cli, "LiteLLMGate", _RejectGate)
    out = tmp_path / "out.jsonl"
    args = pm_cli.build_parser().parse_args(
        ["extract", "--project", str(proj), "--out", str(out), "--llm-gate"]
    )
    assert args.func(args) == 0

    summary = capsys.readouterr().out
    assert "llm-gate: on" in summary
    assert "checked=1" in summary and "rejected=1" in summary
    # confident mismatch ⇒ candidate dropped ⇒ empty corpus
    assert out.read_text().strip() == ""


def test_cmd_extract_gate_off_default(tmp_path, capsys):
    proj = tmp_path / "proj"
    proj.mkdir()
    session = [
        {"type": "user", "message": {"content": "add a feature to the parser module please"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Edit", "id": "t1", "input": {}}]}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "Done. All tests pass."}]}},
        {"type": "user", "message": {"content": "next, unrelated thing"}},
    ]
    (proj / "S2.jsonl").write_text("\n".join(_json.dumps(r) for r in session))
    out = tmp_path / "o.jsonl"
    args = pm_cli.build_parser().parse_args(
        ["extract", "--project", str(proj), "--out", str(out)]
    )
    assert args.func(args) == 0
    assert "llm-gate: off" in capsys.readouterr().out
    rec = _json.loads(out.read_text().strip().splitlines()[0])
    assert rec["_schema_version"] == "1.2" and rec["gate"] is None


def test_gate_threshold_rejects_out_of_range():
    import pytest as _pt

    with _pt.raises(SystemExit):
        pm_cli.build_parser().parse_args(["extract", "--gate-threshold", "2"])
