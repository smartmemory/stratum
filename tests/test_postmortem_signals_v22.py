"""STRAT-JUDGE-POSTMORTEM v2.2 #2 — acceptance vs topic-shift discrimination."""

from __future__ import annotations

from pathlib import Path

import pytest

from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.postmortem.segmenter import segment
from stratum.judge.postmortem.signals import (
    _is_genuine_acceptance,
    _token_overlap,
    label_candidate,
)


def _ev(kind, line, text="", tool_name=None):
    return Event(session_id="S", line_no=line, timestamp="t", kind=kind,
                 text=text, tool_name=tool_name)


REQ = "add a --decompose flag to the extract CLI and wire predicate decomposition"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("thanks, that's exactly the decompose flag wiring I wanted", True),
        ("perfect, the extract CLI decompose wiring looks right", True),
        ("thanks, now let's line up the follow-on features", False),   # forward pivot
        ("perfect. next, can you also add a replay command", False),   # pivot
        ("ok now move on to the scorecard", False),                    # pivot
        ("thanks", True),                                              # bare pleasantry, no pivot/shift
        ("great, now do the database migration instead", False),       # pivot
    ],
)
def test_is_genuine_acceptance(text, expected):
    assert _is_genuine_acceptance(text, REQ) is expected


def test_token_overlap_none_when_empty():
    assert _token_overlap("", "anything") is None
    assert _token_overlap("the a an", "to for of") is None  # all stopwords


def test_low_overlap_pleasantry_is_not_acceptance():
    # pleasantry but talks about something unrelated → topic shift, not acceptance
    assert _is_genuine_acceptance("thanks — unrelated kubernetes helm chart stuff", REQ) is False


def _session(next_user_text: str) -> Session:
    return Session(
        session_id="S", source_path=Path("/tmp/S.jsonl"),
        events=[
            _ev("user_text", 1, REQ),
            _ev("tool_use", 2, tool_name="Edit"),
            _ev("assistant_text", 3, "Done. Wired the --decompose flag."),
            _ev("user_text", 4, next_user_text),
        ],
    )


def test_forward_pivot_does_not_become_true_met():
    """The design.md:201 bug: 'thanks, now line up follow-ons' must NOT be
    scored true_met. With acceptance suppressed it falls to topic_shift
    (weak positive, conf 0.4) → aggregate < 0.5 → ambiguous."""
    cand = segment(_session("thanks, now let's line up the follow-on features"))[0]
    lab = label_candidate(cand)
    assert lab.label == "ambiguous"
    assert not any(h.kind == "acceptance" for h in lab.hits)


def test_genuine_acceptance_still_true_met():
    cand = segment(_session("thanks, that decompose flag wiring is exactly right"))[0]
    lab = label_candidate(cand)
    assert lab.label == "true_met"
    assert any(h.kind == "acceptance" for h in lab.hits)


def test_invariant_no_negative_flips_to_positive():
    """#2 only ever suppresses a wrong acceptance. A negative signal
    (direct correction) must still dominate regardless of pleasantry."""
    cand = segment(_session("no wait, that's wrong — thanks though"))[0]
    lab = label_candidate(cand)
    assert lab.label == "false_met"  # direct_correction dominates; never flipped
