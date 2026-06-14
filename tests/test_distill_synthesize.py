"""STRAT-DISTILL S2 — synthesis tests (TDD)."""
from __future__ import annotations

from pathlib import Path

from stratum.judge.distill.candidate import AssetCandidate
from stratum.judge.distill.detector import WorkflowCandidate
from stratum.judge.distill.synthesize import synthesize


def _wf(kind="sequence", steps=("Bash", "Edit"), count=3, sessions=2, sample=()):
    sig = "→".join(steps) if kind == "sequence" else f"{steps[0][0]}({steps[0][1]})"
    return WorkflowCandidate(
        signature=sig,
        kind=kind,
        steps=steps,
        count=count,
        session_count=sessions,
        evidence_session_ids=tuple(f"S{i}" for i in range(sessions)),
        sample_inputs=sample,
    )


def test_single_becomes_command():
    wf = _wf(kind="single", steps=(("Bash", "command=npm test"),), sample=("command=npm test",))
    c = synthesize(wf)
    assert isinstance(c, AssetCandidate)
    assert c.asset_kind == "command"
    assert c.patch_type == "create"


def test_multistep_sequence_becomes_skill():
    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit", "Read")))
    assert c.asset_kind == "skill"


def test_readonly_sequence_becomes_subagent():
    c = synthesize(_wf(kind="sequence", steps=("Read", "Grep", "Glob")))
    assert c.asset_kind == "subagent"


def test_below_bar_returns_none():
    assert synthesize(_wf(count=1), min_count=2) is None


def test_llm_none_uses_heuristic():
    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")), llm_form=None)
    assert c.asset_kind == "skill"


def test_llm_failure_falls_open_to_heuristic():
    def boom(_w):
        raise RuntimeError("llm down")

    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")), llm_form=boom)
    assert c.asset_kind == "skill"


def test_llm_ambiguous_reply_ignored():
    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")), llm_form=lambda _w: "garbage")
    assert c.asset_kind == "skill"


def test_llm_valid_override_applied():
    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")), llm_form=lambda _w: "command")
    assert c.asset_kind == "command"


def test_suggested_content_is_described_no_file():
    c = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")))
    assert isinstance(c.suggested_content, str) and c.suggested_content
    # described only — nothing is written to the working tree
    assert not Path(c.target_path).exists()


def test_deterministic_cluster_id():
    a = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")))
    b = synthesize(_wf(kind="sequence", steps=("Bash", "Edit")))
    assert a.cluster_id == b.cluster_id
