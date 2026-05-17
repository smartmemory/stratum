"""Event stream → Candidate goals.

A Candidate is one (user request, work span, claim marker) triple — an
"implicit goal" we can later judge for retroactive ground-truth.

The segmenter is intentionally heuristic for v1. The success criterion is
70% precision on hand-review (see design doc); recall is not yet measured.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from stratum.judge.postmortem.loader import Event, Session
from stratum.judge.postmortem.llm_gate import (
    GateVerdict,
    SegmenterGate,
    SegmentStats,
)

# --- Request detection -------------------------------------------------------

# Imperative verbs commonly opening a task request. Lowercase match on the
# first ~40 characters. The list is deliberately short — we'd rather miss
# borderline requests than over-segment chitchat into "goals".
_IMPERATIVE_PREFIXES = (
    "add",
    "build",
    "change",
    "check",
    "clean",
    "configure",
    "create",
    "delete",
    "deploy",
    "design",
    "diagnose",
    "document",
    "extract",
    "find",
    "finish",
    "fix",
    "generate",
    "implement",
    "improve",
    "investigate",
    "kick off",
    "make",
    "migrate",
    "move",
    "patch",
    "plan",
    "polish",
    "port",
    "refactor",
    "remove",
    "rename",
    "rewrite",
    "run",
    "scaffold",
    "set up",
    "ship",
    "start",
    "test",
    "trace",
    "update",
    "upgrade",
    "validate",
    "verify",
    "wire",
    "write",
)

# Slash commands that almost always frame a work request.
_REQUEST_SLASH_COMMANDS = (
    "/compose",
    "/stratum",
    "/build",
    "/fix",
    "/loop",
    "/codex",
    "/buddy",
)

# --- Claim detection ---------------------------------------------------------

# Phrases assistants use when announcing completion. Matched case-insensitively
# anywhere in the assistant's text. Tuned to be specific enough to avoid
# matching "almost done" or "starting on...".
# Patterns are matched only against the closing few lines of an assistant
# turn AND only when the turn doesn't end in a question. This prevents
# mid-narrative or interrogative "done"s from triggering a spurious claim.
_EXPLICIT_CLAIM_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\ball (tests?|checks?|gates?) (now )?pass(ing|ed)\b",
        r"(^|\n)done\b[\s.!]*(\n|$)",
        r"(^|\n)done[\s,.\-—]",
        r"(^|\.\s|\n)fixed\b[\s.!]*(\n|$)",
        r"\bcommitted (and|&) pushed\b",
        r"\bpushed to (main|origin|master)\b",
        r"\b(now |just )shipped\b",
        r"\bready (to|for) (commit|review|merge|ship)\b",
        r"(^|\n)complete[d]?\b[\s.!]*(\n|$)",
        r"\b(implementation|feature|task|ticket) (is )?complete[d]?\b",
        r"\ball (done|finished|set|wired up|in place)\b",
        r"\b(merged|landed) (to|into|on) (main|origin|master)\b",
        r"\bgreen across the board\b",
        r"\bsuite (is )?clean\b",
        r"\ball checks pass\b",
    )
]

# Past-tense descriptors that look like claims but are actually narrating prior
# state. If the match is preceded by one of these within ~30 chars, skip it.
_PRECEDING_DESCRIPTOR_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\balready\b",
        r"\bwas\b",
        r"\bwere\b",
        r"\bhad (been|already)\b",
        r"\bpreviously\b",
    )
]

# Minimum work performed before an explicit "done" claim is credible. A claim
# with zero tool_use events is almost always a recommendation or summary of
# someone else's work, not a completion claim. Kept at 0 to maximise recall
# for v1 hand-review; raise once a labeled corpus exists.
MIN_TOOL_USES_FOR_EXPLICIT_CLAIM = 0

# --- Tunables ----------------------------------------------------------------

# Maximum events between a request and its claim before we give up on this
# candidate (avoids segments that span half a session).
MAX_WORK_SPAN_EVENTS = 200

# Maximum events to include in post-claim window when looking for signals.
POST_CLAIM_WINDOW = 20

# Minimum length of a request to count. Cuts out one-word answers.
MIN_REQUEST_CHARS = 12


@dataclass
class Candidate:
    session_id: str
    candidate_id: str
    request_text: str
    request_line: int
    request_index: int             # index into Session.events
    work_span: list[Event]
    claim_marker: Event
    claim_kind: Literal["explicit", "structural"]
    post_claim_events: list[Event] = field(default_factory=list)
    gate_verdict: GateVerdict | None = None
    predicates: list | None = None  # v2.2 #3 — list[Predicate] when --decompose


def _is_request(event: Event) -> bool:
    if event.kind != "user_text":
        return False
    text = (event.text or "").strip()
    if len(text) < MIN_REQUEST_CHARS:
        return False
    lower = text.lower()
    # Slash command framing
    if any(lower.startswith(cmd) or f" {cmd}" in lower[:60] for cmd in _REQUEST_SLASH_COMMANDS):
        return True
    # Pure question (ends in ?) without imperative is not a request
    head = lower[:60]
    starts_with_imperative = any(
        head.startswith(verb + " ") or head.startswith(verb + ",")
        for verb in _IMPERATIVE_PREFIXES
    )
    if starts_with_imperative:
        return True
    # Direct second-person directives ("you should", "please add", "can you fix")
    if re.match(r"^(please |could you |can you |you (need|should|must) )", head):
        return True
    return False


def _is_explicit_claim(event: Event) -> bool:
    if event.kind != "assistant_text":
        return False
    text = (event.text or "").rstrip()
    if len(text) < 4:
        return False
    # Turns ending with a question are asking, not claiming.
    if text.endswith("?"):
        return False
    # Look only at the closing region: last paragraph, capped at 250 chars.
    tail = text.rsplit("\n\n", 1)[-1]
    if len(tail) > 250:
        tail = tail[-250:]
    for pat in _EXPLICIT_CLAIM_PATTERNS:
        m = pat.search(tail)
        if not m:
            continue
        # Reject if a past-tense descriptor sits in the 30 chars before the
        # match — these narrate prior state, not new completion.
        ctx_start = max(0, m.start() - 30)
        preceding = tail[ctx_start : m.start()]
        if any(d.search(preceding) for d in _PRECEDING_DESCRIPTOR_PATTERNS):
            continue
        return True
    return False


def _work_summary(work_span: list[Event]) -> str:
    """One-line tool summary for the gate prompt (mirrors cli.py:62-65)."""
    names = [ev.tool_name for ev in work_span if ev.kind == "tool_use" and ev.tool_name]
    if not names:
        return "(no tool activity)"
    return ", ".join(names[:50])


def segment(
    session: Session,
    *,
    gate: SegmenterGate | None = None,
    gate_threshold: float = 0.7,
    stats: SegmentStats | None = None,
) -> list[Candidate]:
    """Produce candidate goals from a Session's event stream.

    Strategy: walk the events linearly. When a request is found, scan forward
    for either (a) an explicit claim within MAX_WORK_SPAN_EVENTS, or (b) the
    next request (structural boundary — the prior work was implicitly closed
    by the user moving on). The last assistant_text inside the span is treated
    as the structural claim marker.

    If ``gate`` is provided it runs the recall→precision second stage: each
    assembled candidate is checked for request↔claim coherence and dropped
    only when the gate is confident they are *different* tasks
    (``applied and not same_task and confidence >= gate_threshold``).
    Fail-open verdicts (``applied=False``) never drop. ``gate=None``
    preserves pre-v2.1 *segmenter behavior* (candidate identity, span,
    claim); the serialized JSONL legitimately changes — schema is now 1.1
    with an always-present ``gate`` key (null when the gate is off).
    """
    events = session.events
    candidates: list[Candidate] = []
    i = 0
    n = len(events)
    while i < n:
        if not _is_request(events[i]):
            i += 1
            continue
        req_event = events[i]
        # Scan forward for claim or next request
        span_start = i + 1
        claim_idx: int | None = None
        claim_kind: Literal["explicit", "structural"] = "explicit"
        next_request_idx: int | None = None
        for j in range(span_start, min(n, span_start + MAX_WORK_SPAN_EVENTS)):
            if _is_explicit_claim(events[j]):
                claim_idx = j
                claim_kind = "explicit"
                break
            if _is_request(events[j]):
                next_request_idx = j
                break

        if claim_idx is None and next_request_idx is not None:
            # Structural boundary: pick the last assistant_text in the span as
            # the closing statement. If intermediate user turns exist, prefer
            # the last assistant_text *after* the most recent intermediate
            # user turn so the "claim" reflects the closing utterance rather
            # than answering a side question mid-span.
            span_range = events[span_start:next_request_idx]
            last_user_intermediate = -1
            for off, ev in enumerate(span_range):
                if ev.kind == "user_text":
                    last_user_intermediate = span_start + off
            search_lo = max(span_start, last_user_intermediate + 1)
            last_a_idx = -1
            for j in range(next_request_idx - 1, search_lo - 1, -1):
                if events[j].kind == "assistant_text":
                    last_a_idx = j
                    break
            if last_a_idx > i:
                claim_idx = last_a_idx
                claim_kind = "structural"

        if claim_idx is None:
            # No claim found within the window — skip this candidate
            i = span_start
            continue

        work_span = events[span_start:claim_idx]

        # Reject explicit claims that didn't actually do any tool work — these
        # are almost always plan-recitation, not completion. Structural claims
        # are already a weaker signal so we exempt them.
        if claim_kind == "explicit":
            tool_uses = sum(1 for ev in work_span if ev.kind == "tool_use")
            if tool_uses < MIN_TOOL_USES_FOR_EXPLICIT_CLAIM:
                i = span_start
                continue

        claim_marker = events[claim_idx]
        post_end = min(n, claim_idx + 1 + POST_CLAIM_WINDOW)
        post_claim = events[claim_idx + 1 : post_end]

        cand_id = f"{session.session_id}:L{req_event.line_no}"
        cand = Candidate(
            session_id=session.session_id,
            candidate_id=cand_id,
            request_text=req_event.text,
            request_line=req_event.line_no,
            request_index=i,
            work_span=work_span,
            claim_marker=claim_marker,
            claim_kind=claim_kind,
            post_claim_events=post_claim,
        )

        drop = False
        if gate is not None:
            verdict = gate.check(
                req_event.text or "",
                claim_marker.text or "",
                _work_summary(work_span),
            )
            cand.gate_verdict = verdict
            if stats is not None:
                stats.gate_checked += 1
            if (
                verdict.applied
                and verdict.same_task is False
                and verdict.confidence >= gate_threshold
            ):
                drop = True
                if stats is not None:
                    stats.gate_rejected += 1

        if not drop:
            candidates.append(cand)

        # Advance past the claim so we don't double-count overlapping requests
        # (unconditional — a gate-dropped span must not be re-segmented).
        i = claim_idx + 1
    return candidates
