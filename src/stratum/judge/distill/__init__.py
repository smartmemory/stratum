"""STRAT-DISTILL — success-pattern workflow → reusable-asset distiller.

Mines Claude Code session transcripts for repeated tool-call workflows and stages
asset candidates (skill / subagent / command). The success-pattern complement to
STRAT-LEARN-INLINE (failure-triggered, patches existing scaffold): DISTILL is
recurrence-triggered and synthesizes new assets. Staged, never auto-applied.
"""
from __future__ import annotations

from stratum.judge.distill.candidate import AssetCandidate
from stratum.judge.distill.detector import (
    WorkflowCandidate,
    canonicalize_input,
    detect,
    tool_steps,
)
from stratum.judge.distill.runner import load_sessions, run_distill
from stratum.judge.distill.synthesize import synthesize

__all__ = [
    "AssetCandidate",
    "WorkflowCandidate",
    "canonicalize_input",
    "detect",
    "tool_steps",
    "synthesize",
    "run_distill",
    "load_sessions",
]
