"""Postmortem: retroactive judge-stack calibration from Claude Code session transcripts.

See docs/features/STRAT-JUDGE-POSTMORTEM/design.md for the full v1 design.
"""

from stratum.judge.postmortem.loader import Event, Session, load_session, iter_sessions, read_centered
from stratum.judge.postmortem.segmenter import Candidate, segment
from stratum.judge.postmortem.signals import (
    CandidateLabel,
    SignalHit,
    label_candidate,
)
from stratum.judge.postmortem.provenance import (
    AuthorshipEvidence,
    SessionEdits,
    cc_session_edits,
)
from stratum.judge.postmortem.codex_loader import codex_session_edits
from stratum.judge.postmortem.transcript_reader import read_transcript_centered

__all__ = [
    "Event",
    "Session",
    "load_session",
    "iter_sessions",
    "read_centered",
    "Candidate",
    "segment",
    "CandidateLabel",
    "SignalHit",
    "label_candidate",
    # CORE-CODE-PROVENANCE-1 Phase 1
    "AuthorshipEvidence",
    "SessionEdits",
    "cc_session_edits",
    "codex_session_edits",
    "read_transcript_centered",
]
