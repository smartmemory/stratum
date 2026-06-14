"""STRAT-DISTILL detector core (net-new).

Cross-session recurrence counting over tool-call sequences. Reads the postmortem
loader's Session/Event model directly; does NOT depend on judge verdicts (that is
LEARN-INLINE's path). Pure + deterministic: same sessions -> same candidates.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Iterable, Sequence

from stratum.judge.postmortem.loader import Event, Session

# Canonical input keys — mirrors the meaningful-key priority in signals.py.
_CANON_KEYS = ("command", "file_path", "path", "pattern", "url", "notebook_path")
_PREVIEW_LEN = 120
_DEFAULT_NGRAM = (2, 4)

# Secret redaction — command args / URLs can carry credentials, and a preview
# flows into the staged sidecar + the MCP tool result. Redacting also *improves*
# recurrence grouping (the same command with different tokens collapses to one).
_RE_BEARER = re.compile(r"(?i)\bbearer\s+\S+")
_RE_SECRET_KV = re.compile(
    r"(?i)\b(authorization|api[-_]?key|access[-_]?token|client[-_]?secret|token|secret|password|passwd|pwd)(\s*[:=]\s*|\s+)(\S+)"
)
_RE_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:token|key|secret|password|access_token|sig|signature)=)[^&\s]+"
)
_RE_PREFIXED = re.compile(r"\b(?:sk|ghp|gho|ghs|xox[baprs]|AKIA)[-_]?[A-Za-z0-9]{8,}\b")


def _redact(s: str) -> str:
    s = _RE_BEARER.sub("bearer <redacted>", s)
    s = _RE_SECRET_KV.sub(lambda m: f"{m.group(1)}{m.group(2)}<redacted>", s)
    s = _RE_QUERY_SECRET.sub(r"\1<redacted>", s)
    s = _RE_PREFIXED.sub("<redacted>", s)
    return s


def canonicalize_input(tool_input: dict | None) -> str:
    """Reduce a tool_input dict to a stable, secret-redacted preview string for
    recurrence grouping."""
    if not tool_input:
        return ""
    for key in _CANON_KEYS:
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            return f"{key}={_redact(val.strip())[:_PREVIEW_LEN]}"
    try:
        return _redact(json.dumps(tool_input, sort_keys=True))[:_PREVIEW_LEN]
    except (TypeError, ValueError):
        return _redact(str(tool_input))[:_PREVIEW_LEN]


def tool_steps(session: Session) -> list[tuple[str, str]]:
    """All (tool_name, canonical_input) steps in a session, in order.

    Tolerates malformed events (missing kind / tool_name / tool_input) by skipping.
    v1 reads the whole session event stream; goal-bounded spans (via segmenter) are
    a deferred refinement (STRAT-DISTILL follow-up) — see blueprint.
    """
    out: list[tuple[str, str]] = []
    for ev in getattr(session, "events", None) or ():
        if getattr(ev, "kind", None) == "tool_use" and getattr(ev, "tool_name", None):
            out.append((ev.tool_name, canonicalize_input(getattr(ev, "tool_input", None))))
    return out


@dataclass(frozen=True)
class WorkflowCandidate:
    """A repeated workflow observed across sessions. Detection output, pre-synthesis."""

    signature: str
    kind: str  # "single" | "sequence"
    steps: tuple
    count: int
    session_count: int
    evidence_session_ids: tuple
    sample_inputs: tuple

    def to_dict(self) -> dict:
        return {
            "signature": self.signature,
            "kind": self.kind,
            "steps": list(self.steps),
            "count": self.count,
            "session_count": self.session_count,
            "evidence_session_ids": list(self.evidence_session_ids),
            "sample_inputs": list(self.sample_inputs),
        }


def detect(
    sessions: Sequence[Session],
    *,
    min_count: int = 2,
    min_sessions: int = 2,
    ngram_range: tuple[int, int] = _DEFAULT_NGRAM,
) -> list[WorkflowCandidate]:
    """Find repeated tool-call workflows.

    A candidate qualifies when it recurs at least ``min_count`` times across at
    least ``min_sessions`` distinct sessions. The default ``min_sessions=2``
    enforces *cross-session* recurrence (the stated design bar) — a loop repeated
    within a single session is likelier transient noise; lower it explicitly to
    include within-session repeats. Two candidate kinds:
      - ``single``   : a specific (tool, canonical_input) that recurs (e.g. always
                       running the same command).
      - ``sequence`` : a tool-name n-gram (n in ngram_range) that recurs.

    Returns a deterministically-sorted list; an empty list is a valid, expected
    outcome ("nothing recurred -> create nothing").
    """
    single_count: Counter = Counter()
    single_sids: defaultdict = defaultdict(set)
    single_inputs: defaultdict = defaultdict(list)
    seq_count: Counter = Counter()
    seq_sids: defaultdict = defaultdict(set)
    lo, hi = ngram_range

    for sess in sessions:
        sid = getattr(sess, "session_id", "") or ""
        steps = tool_steps(sess)
        for tool, canon in steps:
            key = (tool, canon)
            single_count[key] += 1
            single_sids[key].add(sid)
            if canon and canon not in single_inputs[key]:
                single_inputs[key].append(canon)
        names = [t for t, _ in steps]
        for n in range(lo, hi + 1):
            for i in range(len(names) - n + 1):
                ng = tuple(names[i : i + n])
                seq_count[ng] += 1
                seq_sids[ng].add(sid)

    out: list[WorkflowCandidate] = []

    for (tool, canon), cnt in single_count.items():
        sids = single_sids[(tool, canon)]
        if cnt >= min_count and len(sids) >= min_sessions:
            out.append(
                WorkflowCandidate(
                    signature=f"{tool}({canon})" if canon else f"{tool}()",
                    kind="single",
                    steps=((tool, canon),),
                    count=cnt,
                    session_count=len(sids),
                    evidence_session_ids=tuple(sorted(sids)),
                    sample_inputs=tuple(single_inputs[(tool, canon)][:3]),
                )
            )

    for ng, cnt in seq_count.items():
        sids = seq_sids[ng]
        if cnt >= min_count and len(sids) >= min_sessions:
            out.append(
                WorkflowCandidate(
                    signature="→".join(ng),
                    kind="sequence",
                    steps=tuple(ng),
                    count=cnt,
                    session_count=len(sids),
                    evidence_session_ids=tuple(sorted(sids)),
                    sample_inputs=(),
                )
            )

    out.sort(key=lambda c: (-c.count, -c.session_count, c.kind, c.signature))
    return out
