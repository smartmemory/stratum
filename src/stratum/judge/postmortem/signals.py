"""Ground-truth label extraction from a Candidate's post-claim window.

Strong negative signals (direct correction, revert, repeat request) override
positive signals. Absence of any signal yields an `ambiguous` label.

v1 is regex/heuristic. v2 may swap in an LLM classifier (see design doc
open questions). The output schema is stable either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from stratum.judge.postmortem.loader import Event
from stratum.judge.postmortem.segmenter import Candidate

# --- Subject-token extraction -----------------------------------------------

# Tokens that are too generic to be evidence of relatedness on their own.
# Augmented with common path-segment components that appear in *every*
# project (users, forge, projects, memory, src, lib, node_modules, …).
_STOPWORD_TOKENS = {
    # Language / generic file fragments
    "main", "src", "lib", "test", "tests", "docs", "doc", "readme",
    "package", "json", "config", "index", "app", "build", "node",
    "py", "js", "ts", "tsx", "md", "yaml", "yml", "txt", "sh", "rs",
    # English stopwords
    "the", "a", "an", "and", "or", "to", "for", "of", "in", "on",
    "with", "is", "it", "this", "that", "from", "by", "as", "at",
    # Generic directory components likely shared across many paths
    "users", "home", "tmp", "var", "etc", "bin", "ruze", "projects",
    "claude", "memory", "node_modules", "dist", "out", "target",
    "forge", "scope", "section", "sections", "print", "iname",
    "maxdepth", "stratum", "compose", "smart",
}

# Path/identifier shapes likely to be load-bearing references.
_PATH_LIKE = re.compile(r"[A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6}")
_DIR_PATH = re.compile(r"/[A-Za-z0-9_\-./]{3,}")
_CODE_IDENT = re.compile(r"\b[A-Z][A-Z0-9]+(?:[-_][A-Z0-9]+)+\b")  # STRAT-GOAL, COMP-RT-4
_CAMEL_IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")


def _tokenise_paths(text: str) -> set[str]:
    """Pull file-like and dir-like path tokens from a string, normalised."""
    out: set[str] = set()
    if not text:
        return out
    for m in _PATH_LIKE.findall(text):
        # Full path and basename
        out.add(m.lower())
        base = m.rsplit("/", 1)[-1].lower()
        if base != m.lower():
            out.add(base)
        # Also stem (drop extension)
        stem = base.rsplit(".", 1)[0]
        if len(stem) >= 4:
            out.add(stem)
    for m in _DIR_PATH.findall(text):
        out.add(m.lower())
        last = m.rstrip("/").rsplit("/", 1)[-1].lower()
        if len(last) >= 4:
            out.add(last)
    return out


def _tokenise_identifiers(text: str) -> set[str]:
    out: set[str] = set()
    if not text:
        return out
    # Strong: SHOUTY-DASH-IDS (ticket-like)
    for m in _CODE_IDENT.findall(text):
        out.add(m.lower())
    # Weaker: longer camel-or-snake identifiers
    for m in _CAMEL_IDENT.findall(text):
        if len(m) >= 5 and m.lower() not in _STOPWORD_TOKENS:
            out.add(m.lower())
    return out


def _is_strong_token(t: str) -> bool:
    """A token strong enough to attribute a signal on its own.

    Strong = has a path separator, a file extension, or is an all-caps
    dashed identifier (STRAT-GOAL, COMP-RT-4). Weak tokens (bare words)
    can be subject tokens but won't survive the gate.
    """
    if "/" in t:
        return True
    if "." in t:
        ext = t.rsplit(".", 1)[-1]
        if 1 <= len(ext) <= 6 and ext.isalnum():
            return True
    if "-" in t and t.upper() == t:
        return True
    return False


@dataclass
class SubjectTokens:
    strong: set[str] = field(default_factory=set)
    weak: set[str] = field(default_factory=set)

    @property
    def all(self) -> set[str]:
        return self.strong | self.weak


def extract_subject_tokens(cand: Candidate) -> SubjectTokens:
    """Compute the file paths and identifiers this candidate is "about".

    Returns a SubjectTokens split into `strong` (paths, extensions, all-caps
    dashed IDs) and `weak` (bare words). A post-claim event must mention
    at least one strong token before its failure/revert signal fires; this
    is what gates unrelated tracebacks / test runs from contaminating the
    label.
    """
    raw: set[str] = set()
    raw |= _tokenise_paths(cand.request_text)
    raw |= _tokenise_identifiers(cand.request_text)
    for ev in cand.work_span:
        if ev.kind == "tool_use" and ev.tool_input:
            for key in ("file_path", "path", "pattern", "command", "url", "notebook_path"):
                val = ev.tool_input.get(key)
                if isinstance(val, str):
                    raw |= _tokenise_paths(val)
                    raw |= _tokenise_identifiers(val)
        elif ev.kind == "tool_result" and ev.text:
            head = ev.text.split("\n", 2)[0]
            raw |= _tokenise_paths(head[:200])
    # Drop stopword-only tokens
    raw = {t for t in raw if t not in _STOPWORD_TOKENS and len(t) >= 4}
    strong = {t for t in raw if _is_strong_token(t)}
    weak = raw - strong
    return SubjectTokens(strong=strong, weak=weak)


def _event_mentions_subject(ev: Event, tokens: SubjectTokens) -> bool:
    """Return True if this event references at least one *strong* subject token.

    A weak-token-only overlap (e.g. both paths contain "users") is not enough
    to attribute a signal — too easy to get spurious matches on shared path
    components.
    """
    if not tokens.strong:
        # No strong evidence available — fall back to *any* token match.
        # This keeps tiny work_spans from blocking all signals.
        haystack = _haystack(ev)
        if not tokens.all:
            return True
        return any(tok in haystack for tok in tokens.all)
    haystack = _haystack(ev)
    if not haystack:
        return False
    return any(tok in haystack for tok in tokens.strong)


def _haystack(ev: Event) -> str:
    parts: list[str] = []
    if ev.text:
        parts.append(ev.text.lower())
    if ev.tool_input:
        for v in ev.tool_input.values():
            if isinstance(v, str):
                parts.append(v.lower())
    return " ".join(parts)

SignalKind = Literal[
    "direct_correction",
    "repeat_request",
    "test_failure",
    "revert",
    "re_edit",
    "acceptance",
    "topic_shift",
    "test_pass",
]

SignalPolarity = Literal["negative", "positive"]

Label = Literal["false_met", "true_met", "ambiguous"]


@dataclass
class SignalHit:
    kind: SignalKind
    polarity: SignalPolarity
    confidence: float            # 0-1
    line_no: int
    snippet: str                 # short excerpt for human review


@dataclass
class CandidateLabel:
    candidate_id: str
    label: Label
    confidence: float
    hits: list[SignalHit] = field(default_factory=list)
    rationale: str = ""


# --- Negative-signal patterns ------------------------------------------------

_DIRECT_CORRECTION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bno wait\b",
        r"\bactually,?\s*(no|that's|that is|let)",
        r"\byou missed\b",
        r"\bthat's not right\b",
        r"\bthat's wrong\b",
        r"\bthat didn'?t work\b",
        r"\bdoesn'?t work\b",
        r"\bstill broken\b",
        r"\bstill failing\b",
        r"\bnot quite\b",
        r"\bnot what i\b",
        r"\bthat's not what\b",
        r"\bhold on\b",
        r"\bstop\b",
        r"\bundo\b",
        r"\brevert\b",
        r"\byou broke\b",
        r"\byou (also )?need to\b",
        r"\bforgot to\b",
        r"\bmissing\b",
        r"\bdidn'?t (you )?(catch|notice|see)\b",
        r"^(no|nope|wrong|broken)\b",
    )
]

_REVERT_TOOLS = {"Bash"}
_REVERT_COMMAND_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"git\s+revert\b",
        r"git\s+reset\s+--hard\b",
        r"git\s+checkout\s+--\s",
        r"git\s+restore\b",
        r"git\s+stash\s+(pop|apply)\b",
    )
]


# --- Positive-signal patterns ------------------------------------------------

_ACCEPTANCE_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"^(thanks|thank you|thx|ty)\b",
        r"^(perfect|great|nice|excellent|awesome|beautiful)\b",
        r"^(ok|okay|cool|got it|sounds good)\b",
        r"\bnice work\b",
        r"\blooks good\b",
        r"\blgtm\b",
    )
]


# --- Helpers -----------------------------------------------------------------

def _snippet(text: str, max_len: int = 140) -> str:
    text = (text or "").strip().replace("\n", " ")
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


# Strong, runner-specific framing patterns. Each must be specific enough that
# matching is near-certain evidence the text is a test/lint/build runner's
# stdout — not prose, not code, not markdown.
_RUNNER_FRAMING_PATTERNS = [
    re.compile(p, re.IGNORECASE if ci else 0)
    for p, ci in (
        # pytest summary banner: ====== N passed, M failed in T s ======
        (r"={5,}.{0,80}\b\d+\s+passed(\b|,)", True),
        (r"={5,}.{0,80}\b\d+\s+failed\b", True),
        # node:test / TAP "# tests N # suites N # pass N # fail N"
        (r"#\s*tests\s+\d+.*#\s*pass\s+\d+", True),
        (r"^\s*1\.\.\d+\s*$", True),
        # mocha
        (r"\b\d+\s+passing\b", True),
        (r"\b\d+\s+failing\b", True),
        # jest summary block — fields appear together
        (r"Tests:\s+\d+\s+(passed|failed)", False),
        (r"Test Suites:\s+\d+\s+(passed|failed)", False),
        # cargo
        (r"test result:\s*(ok|FAILED)", True),
        # jest per-file PASS/FAIL line prefix (case-sensitive)
        (r"^(PASS|FAIL)\s+\S+\.(test|spec)\.", False),
        # rust runner running N tests
        (r"^running\s+\d+\s+tests\s*$", False),
        # python unittest
        (r"\bRan\s+\d+\s+tests?\s+in\s+", False),
    )
]

# Patterns that are diagnostic of a *failure* when runner framing is present.
_FAILURE_DIAGNOSTIC = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"traceback \(most recent call last\)",
        r"\b(AssertionError|SyntaxError|TypeError|ModuleNotFoundError|ReferenceError)\b",
        r"={5,}.{0,80}\b\d+\s+failed\b",
        r"\b[1-9]\d*\s+failing\b",
        r"\b[1-9]\d*\s+failed\b",
        r"test result:\s*FAILED",
        r"Tests:\s+\d+\s+failed",
        r"^FAIL\s+\S+\.(test|spec)\.",
        r"#\s*fail\s+[1-9]",
    )
]

# Patterns diagnostic of a *pass*. Crucially, "# fail 0" or "0 failed" both
# satisfy this.
_PASS_DIAGNOSTIC = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"={5,}.{0,80}\b\d+\s+passed(?!.*\b\d+\s+failed)",
        r"test result:\s*ok\.",
        r"\b\d+\s+passing\b(?!.*\b\d+\s+failing\b)",
        r"#\s*pass\s+\d+\s.*#\s*fail\s+0\b",
        r"Tests:\s+\d+\s+passed,\s+\d+\s+total",
        r"^PASS\s+\S+\.(test|spec)\.",
    )
]


def _looks_like_runner_output(text: str) -> bool:
    if len(text) < 60:
        return False
    return any(p.search(text) for p in _RUNNER_FRAMING_PATTERNS)


def _is_test_failure_result(ev: Event) -> bool:
    if ev.kind != "tool_result":
        return False
    text = ev.text or ""
    if not _looks_like_runner_output(text):
        # Tool errors with stack traces still count even without runner framing
        if ev.tool_result_status == "error" and any(p.search(text) for p in _FAILURE_DIAGNOSTIC):
            return True
        return False
    return any(p.search(text) for p in _FAILURE_DIAGNOSTIC)


def _is_test_pass_result(ev: Event) -> bool:
    if ev.kind != "tool_result":
        return False
    if ev.tool_result_status == "error":
        return False
    text = ev.text or ""
    if not _looks_like_runner_output(text):
        return False
    # Failures take precedence — never call something a pass if any failure
    # diagnostic is present.
    if any(p.search(text) for p in _FAILURE_DIAGNOSTIC):
        return False
    return any(p.search(text) for p in _PASS_DIAGNOSTIC)


def _is_revert_tool_use(ev: Event) -> bool:
    if ev.kind != "tool_use" or ev.tool_name not in _REVERT_TOOLS:
        return False
    cmd = ""
    if ev.tool_input:
        cmd = str(ev.tool_input.get("command") or "")
    return any(p.search(cmd) for p in _REVERT_COMMAND_PATTERNS)


_OVERLAP_STOPWORDS = {
    "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with",
    "is", "it", "this", "that",
}

# Forward-pivot markers (STRAT-JUDGE-POSTMORTEM v2.2 #2). When one of these
# appears in a post-claim user turn, a leading pleasantry is a pivot to new
# work ("thanks, now let's …"), not acknowledgement of the prior work.
_FORWARD_PIVOT_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\b(now|next|then)\b",
        r"\blet'?s\b",
        r"\blet us\b",
        r"\bmove on\b",
        r"\banother\b",
        r"\balso\b",
        r"\bone more\b",
        r"\bwhile you'?re\b",
        r"\bcan you (also|now)\b",
    )
]


def _token_overlap(text_a: str, text_b: str, *, symmetric: bool = False) -> float | None:
    """Stopword-filtered token overlap. Returns None when either side is
    empty after filtering (no signal).

    Default normalises by ``len(a)`` — preserves the shipped
    `_is_topic_shift` semantics (a = request side). ``symmetric=True``
    normalises by the larger side (stricter; used by the conservative
    acceptance gate so a short request can't make a long unrelated reply
    look like acknowledgement).
    """
    a = set(re.findall(r"[a-z0-9]+", (text_a or "").lower())) - _OVERLAP_STOPWORDS
    b = set(re.findall(r"[a-z0-9]+", (text_b or "").lower())) - _OVERLAP_STOPWORDS
    if not a or not b:
        return None
    denom = max(len(a), len(b)) if symmetric else max(len(a), 1)
    return len(a & b) / denom


def _is_topic_shift(next_user: Event, request_text: str) -> bool:
    """Cheap word-overlap heuristic: <20% token overlap = topic shift."""
    ov = _token_overlap(request_text, next_user.text or "")
    return ov is not None and ov < 0.2


def _is_genuine_acceptance(text: str, request_text: str) -> bool:
    """v2.2 #2 — distinguish "thanks for X" from "thanks, now Y".

    A post-claim pleasantry counts as acceptance only when it neither
    pivots forward to new work nor reads as a topic shift away from the
    request. Conservative: when unsure, NOT acceptance — losing a true
    acceptance only softens the label (true_met → ambiguous via
    `_aggregate`); it can never flip a label or create a negative.
    """
    t = (text or "").strip()
    if any(p.search(t) for p in _FORWARD_PIVOT_PATTERNS):
        return False
    # A short pure pleasantry ("thanks", "perfect", "lgtm") is acceptance by
    # nature — too little content to *be* a topic shift. Only apply the
    # overlap test once the reply is substantive enough to be "about"
    # something else (mirrors _is_topic_shift needing real content).
    content = set(re.findall(r"[a-z0-9]+", t.lower())) - _OVERLAP_STOPWORDS
    if len(content) <= 4:
        return True
    ov = _token_overlap(request_text, t, symmetric=True)
    # Low overlap on a substantive reply → topic shift, not acknowledgement.
    if ov is not None and ov < 0.2:
        return False
    return True


def label_candidate(cand: Candidate) -> CandidateLabel:
    """Apply signal detectors over the post-claim window.

    Failure/revert/re-edit signals are gated by subject-token attribution:
    a traceback that doesn't mention any file or identifier the work_span
    touched is treated as unrelated activity, not evidence about this goal.
    """
    hits: list[SignalHit] = []
    next_user: Event | None = None
    subject_tokens = extract_subject_tokens(cand)

    for ev in cand.post_claim_events:
        # Track the first user_text we encounter — used for several signals
        if ev.kind == "user_text" and next_user is None:
            next_user = ev
            text = ev.text or ""
            # Direct correction
            for pat in _DIRECT_CORRECTION_PATTERNS:
                if pat.search(text):
                    hits.append(
                        SignalHit(
                            kind="direct_correction",
                            polarity="negative",
                            confidence=0.9,
                            line_no=ev.line_no,
                            snippet=_snippet(text),
                        )
                    )
                    break
            # Acceptance (only if no correction fired AND it's a genuine
            # acknowledgement, not a "thanks, now do Y" forward-pivot — v2.2 #2)
            if not any(h.kind == "direct_correction" for h in hits) and (
                _is_genuine_acceptance(text, cand.request_text)
            ):
                for pat in _ACCEPTANCE_PATTERNS:
                    if pat.search(text.strip()):
                        hits.append(
                            SignalHit(
                                kind="acceptance",
                                polarity="positive",
                                confidence=0.6,
                                line_no=ev.line_no,
                                snippet=_snippet(text),
                            )
                        )
                        break
            # Repeat request: contains overlapping nouns/verbs with original
            # and looks like another imperative.
            if _looks_like_repeat(text, cand.request_text):
                hits.append(
                    SignalHit(
                        kind="repeat_request",
                        polarity="negative",
                        confidence=0.7,
                        line_no=ev.line_no,
                        snippet=_snippet(text),
                    )
                )

        # Tool-result level signals (across the whole window). Gated by
        # subject-token attribution so unrelated tracebacks / test runs in
        # the post-claim window don't contaminate the label.
        if _is_test_failure_result(ev) and _event_mentions_subject(ev, subject_tokens):
            hits.append(
                SignalHit(
                    kind="test_failure",
                    polarity="negative",
                    confidence=0.8,
                    line_no=ev.line_no,
                    snippet=_snippet(ev.text),
                )
            )
        elif _is_test_pass_result(ev) and _event_mentions_subject(ev, subject_tokens):
            hits.append(
                SignalHit(
                    kind="test_pass",
                    polarity="positive",
                    confidence=0.7,
                    line_no=ev.line_no,
                    snippet=_snippet(ev.text),
                )
            )

        if _is_revert_tool_use(ev) and _event_mentions_subject(ev, subject_tokens):
            cmd = str((ev.tool_input or {}).get("command", ""))
            hits.append(
                SignalHit(
                    kind="revert",
                    polarity="negative",
                    confidence=0.85,
                    line_no=ev.line_no,
                    snippet=_snippet(cmd),
                )
            )

    # Topic shift is a weak positive — only when no negatives fired and we
    # actually saw a next user turn.
    if next_user is not None and not any(h.polarity == "negative" for h in hits):
        if _is_topic_shift(next_user, cand.request_text):
            hits.append(
                SignalHit(
                    kind="topic_shift",
                    polarity="positive",
                    confidence=0.4,
                    line_no=next_user.line_no,
                    snippet=_snippet(next_user.text),
                )
            )

    return _aggregate(cand.candidate_id, hits)


def _looks_like_repeat(new_text: str, orig_text: str) -> bool:
    if len(new_text) < 12:
        return False
    new_l = new_text.lower()
    if not any(
        new_l[:50].startswith(v + " ") or new_l[:50].startswith(v + ",")
        for v in ("fix", "redo", "try", "again", "still", "but", "also")
    ):
        return False
    # token overlap
    a = set(re.findall(r"[a-z0-9]{4,}", new_l))
    b = set(re.findall(r"[a-z0-9]{4,}", orig_text.lower()))
    if not a or not b:
        return False
    return len(a & b) / len(a | b) > 0.25


def _aggregate(candidate_id: str, hits: list[SignalHit]) -> CandidateLabel:
    if not hits:
        return CandidateLabel(
            candidate_id=candidate_id,
            label="ambiguous",
            confidence=0.0,
            hits=[],
            rationale="no signals matched in post-claim window",
        )
    neg = [h for h in hits if h.polarity == "negative"]
    pos = [h for h in hits if h.polarity == "positive"]
    if neg:
        # Highest-confidence negative wins; aggregate confidence is its conf
        # boosted slightly by count.
        best = max(neg, key=lambda h: h.confidence)
        conf = min(0.99, best.confidence + 0.05 * (len(neg) - 1))
        rat = f"false_met: {best.kind} (conf {best.confidence:.2f})"
        if len(neg) > 1:
            rat += f" + {len(neg) - 1} other negative signal(s)"
        return CandidateLabel(
            candidate_id=candidate_id,
            label="false_met",
            confidence=conf,
            hits=hits,
            rationale=rat,
        )
    # Positives only
    best = max(pos, key=lambda h: h.confidence)
    # Require at least 0.5 aggregate confidence to commit to true_met
    conf = min(0.95, best.confidence + 0.05 * (len(pos) - 1))
    if conf < 0.5:
        return CandidateLabel(
            candidate_id=candidate_id,
            label="ambiguous",
            confidence=conf,
            hits=hits,
            rationale=f"weak positive only: {best.kind} (conf {best.confidence:.2f})",
        )
    return CandidateLabel(
        candidate_id=candidate_id,
        label="true_met",
        confidence=conf,
        hits=hits,
        rationale=f"true_met: {best.kind} (conf {best.confidence:.2f})",
    )
