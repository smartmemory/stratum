"""Postmortem: retroactive judge-stack calibration from Claude Code session transcripts.

See docs/features/STRAT-JUDGE-POSTMORTEM/design.md for the full v1 design.
"""

from stratum.judge.postmortem.loader import Event, Session, load_session, iter_sessions
from stratum.judge.postmortem.segmenter import Candidate, segment
from stratum.judge.postmortem.signals import (
    CandidateLabel,
    SignalHit,
    label_candidate,
)

__all__ = [
    "Event",
    "Session",
    "load_session",
    "iter_sessions",
    "Candidate",
    "segment",
    "CandidateLabel",
    "SignalHit",
    "label_candidate",
]
