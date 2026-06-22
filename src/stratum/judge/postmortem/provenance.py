"""Code↔conversation provenance matcher (CORE-CODE-PROVENANCE-1 Phase 1, S01).

Pure, no filesystem or git I/O: given per-session authored edits (`SessionEdits`)
and a git-resolved target (`TargetSpan`s), decide which session(s) *authored* a
span of code — by structural evidence (exact / normalized / block-hash / longest
common substring), with an IDF-weighted character-tri-gram **fallback**, never by
clock proximity. Ambiguity (including strong ties) is reported honestly.

Filesystem crawling, git target resolution, and the MCP tool live in the
`stratum-mcp` layer (see CORE-CODE-PROVENANCE-1/blueprint.md). This module takes
already-extracted inputs and returns a `BlameResult`.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Any, Iterable, Optional

from stratum.judge.postmortem.loader import Session  # type only (no I/O)

# --------------------------------------------------------------------------- #
# normalization + character tri-grams
# --------------------------------------------------------------------------- #
_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Collapse every run of whitespace (incl. newlines/indentation) to a single
    space and strip the ends, so reindentation/reflow does not fragment grams or
    block reformatted-but-same code. This is the *only* normalization in Phase 1
    (punctuation/quote stripping is a deferred open question)."""
    return _WS.sub(" ", text).strip()


def trigrams(text: str) -> set[str]:
    """Character 3-grams over the normalized text. <3 normalized chars → empty
    set (degenerate targets are handled by the caller, never divided by)."""
    n = normalize(text)
    if len(n) < 3:
        return set()
    return {n[i : i + 3] for i in range(len(n) - 2)}


def _sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


# --------------------------------------------------------------------------- #
# records
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class AuthorshipEvidence:
    """One successful Edit/Write/MultiEdit/apply_patch block authored in a session.
    `repo` is None from the pure extractor (S01 has no git); S04 crawl stamps it."""

    source: str  # "cc" | "codex"
    source_path: str
    session_id: str
    line_no: int
    tool_ref: Optional[str]  # CC tool_use_id / Codex call_id
    status: str  # always "ok" (only successful edits are emitted)
    timestamp: Optional[str]  # for Phase 2/audit only — NEVER used in ranking
    repo: Optional[str]
    file_path: str
    op: str  # "write" | "edit" | "multiedit" | "apply_patch"
    block_text: str
    block_hash: str
    norm_hash: str
    raw_len: int
    norm_len: int

    @staticmethod
    def make(
        *,
        source: str,
        source_path: str,
        session_id: str,
        line_no: int,
        tool_ref: Optional[str],
        timestamp: Optional[str],
        file_path: str,
        op: str,
        block_text: str,
        repo: Optional[str] = None,
        status: str = "ok",
    ) -> "AuthorshipEvidence":
        norm = normalize(block_text)
        return AuthorshipEvidence(
            source=source,
            source_path=source_path,
            session_id=session_id,
            line_no=line_no,
            tool_ref=tool_ref,
            status=status,
            timestamp=timestamp,
            repo=repo,
            file_path=file_path,
            op=op,
            block_text=block_text,
            block_hash=_sha1(block_text),
            norm_hash=_sha1(norm),
            raw_len=len(block_text),
            norm_len=len(norm),
        )


@dataclass
class SessionEdits:
    source: str
    source_path: str
    session_id: str
    cwd: Optional[str]
    repo: Optional[str]
    edits: list[AuthorshipEvidence]


@dataclass(frozen=True)
class TargetSpan:
    """A unit of target code to attribute (a commit hunk, or a blamed file:line
    span). Frozen + hashable so it is safe to key by — but callers key `per_span`
    by ``span_id`` (str), never the object, to avoid hashing the gram set."""

    file_path: str
    span_id: str
    line_range: tuple[int, int]
    text: str
    norm_text: str
    trigrams: frozenset[str]

    @staticmethod
    def make(*, file_path: str, span_id: str, line_range: tuple[int, int], text: str) -> "TargetSpan":
        return TargetSpan(
            file_path=file_path,
            span_id=span_id,
            line_range=line_range,
            text=text,
            norm_text=normalize(text),
            trigrams=frozenset(trigrams(text)),
        )

    @property
    def indexable(self) -> bool:
        """A span with <3 normalizable chars has no tri-grams — degenerate."""
        return len(self.trigrams) > 0


# method → tier (higher = stronger evidence). Tier dominates score in ranking.
_TIER = {"exact": 5, "normalized": 4, "block_hash": 3, "lcs": 2, "trigram": 1}
_LCS_MIN_COVERAGE = 0.60  # below this, lcs is not claimed; fall through to trigram


@dataclass(frozen=True)
class SpanMatch:
    span_id: str
    session_id: str
    source: str
    source_path: str
    line_no: int
    method: str
    tier: int
    score: float
    jaccard: Optional[float]
    coverage: float
    matched_edit_tool_ref: Optional[str]


@dataclass
class BlameMatch:
    source: str
    session_id: str
    source_path: str
    line_no: int
    handle: dict[str, Any]
    method: str
    score: float
    jaccard: Optional[float]
    target_coverage: float
    authored_spans: list[dict[str, Any]]
    survival: dict[str, Any] = field(default_factory=lambda: {"overall": None, "by_file": []})
    evidence: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "session_id": self.session_id,
            "source_path": self.source_path,
            "line_no": self.line_no,
            "handle": self.handle,
            "method": self.method,
            "score": self.score,
            "jaccard": self.jaccard,
            "target_coverage": self.target_coverage,
            "authored_spans": self.authored_spans,
            "survival": self.survival,
            "evidence": self.evidence,
        }


@dataclass
class BlameResult:
    query: dict[str, Any]
    status: str  # ok | no_clear_author | no_overlap | no_indexable_content | merge_no_direct_changes
    matches: list[BlameMatch]
    ambiguous_spans: list[dict[str, Any]]
    ranked_by: str = "evidence_tier_then_coverage"

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "status": self.status,
            "matches": [m.to_dict() for m in self.matches],
            "ambiguous_spans": self.ambiguous_spans,
            "ranked_by": self.ranked_by,
        }


# --------------------------------------------------------------------------- #
# IDF over the (already narrowed) candidate corpus
# --------------------------------------------------------------------------- #
def compute_idf(candidates: Iterable[SessionEdits]) -> dict[str, float]:
    """Smoothed inverse document frequency of tri-grams across candidate sessions,
    so near-universal grams (``def ``/``return``/license headers) get ~0 weight and
    distinctive code grams dominate. Smoothed so it is always > 0 (no all-zero at
    N=1) — ``log((N+1)/(df+0.5))``."""
    cands = list(candidates)
    n = max(1, len(cands))
    df: dict[str, int] = {}
    for c in cands:
        grams: set[str] = set()
        for e in c.edits:
            grams |= trigrams(e.block_text)
        for g in grams:
            df[g] = df.get(g, 0) + 1
    return {g: math.log((n + 1) / (df_g + 0.5)) for g, df_g in df.items()}


def _weighted(grams: Iterable[str], idf: dict[str, float], default: float = 0.0) -> float:
    return sum(idf.get(g, default) for g in grams)


# --------------------------------------------------------------------------- #
# per-candidate scoring against one span
# --------------------------------------------------------------------------- #
def _blocks_for_file(cand: SessionEdits, file_path: str) -> list[AuthorshipEvidence]:
    """Authored blocks of `cand` that touched `file_path` (suffix-relative match,
    since transcripts may carry absolute paths and the target a repo-relative one)."""
    out = []
    for e in cand.edits:
        a, b = e.file_path, file_path
        if a == b or a.endswith("/" + b) or b.endswith("/" + a):
            out.append(e)
    return out


def score_span(span: TargetSpan, cand: SessionEdits, idf: dict[str, float]) -> Optional[SpanMatch]:
    """Best (highest-tier) evidence this candidate has for authoring `span`.
    Returns None when the candidate has no authored block for the span's file or
    no evidence clears the trigram floor (the caller's `min_score` decides the
    floor; here we still return the trigram match so the caller can threshold)."""
    blocks = _blocks_for_file(cand, span.file_path)
    if not blocks:
        return None

    def _mk(method: str, score: float, coverage: float, jaccard: Optional[float], ev: AuthorshipEvidence) -> SpanMatch:
        return SpanMatch(
            span_id=span.span_id,
            session_id=cand.session_id,
            source=cand.source,
            source_path=cand.source_path,
            line_no=ev.line_no,
            method=method,
            tier=_TIER[method],
            score=score,
            jaccard=jaccard,
            coverage=coverage,
            matched_edit_tool_ref=ev.tool_ref,
        )

    # tier 5: raw verbatim substring
    for ev in blocks:
        if span.text and span.text in ev.block_text:
            return _mk("exact", 1.0, 1.0, None, ev)
    # tier 4: whitespace-normalized substring
    for ev in blocks:
        if span.norm_text and span.norm_text in normalize(ev.block_text):
            return _mk("normalized", 1.0, 1.0, None, ev)
    # tier 3: the span exactly equals an authored block (norm-hash equality)
    span_norm_hash = _sha1(span.norm_text)
    for ev in blocks:
        if ev.norm_hash == span_norm_hash:
            return _mk("block_hash", 1.0, 1.0, None, ev)
    # tier 2: longest common substring coverage over normalized text
    best_lcs = 0.0
    best_lcs_ev: Optional[AuthorshipEvidence] = None
    if span.norm_text:
        for ev in blocks:
            m = SequenceMatcher(None, span.norm_text, normalize(ev.block_text), autojunk=False)
            match = m.find_longest_match(0, len(span.norm_text), 0, len(normalize(ev.block_text)))
            cov = match.size / len(span.norm_text)
            if cov > best_lcs:
                best_lcs, best_lcs_ev = cov, ev
    if best_lcs_ev is not None and best_lcs >= _LCS_MIN_COVERAGE:
        return _mk("lcs", best_lcs, best_lcs, None, best_lcs_ev)
    # tier 1: IDF-weighted tri-gram containment (fuzzy fallback)
    if not span.trigrams:
        return None
    cand_grams: set[str] = set()
    for ev in blocks:
        cand_grams |= trigrams(ev.block_text)
    inter = span.trigrams & cand_grams
    if not inter:
        return None
    # CRITICAL: the denominator must span the WHOLE target, including target grams
    # present in NO candidate (otherwise a candidate sharing a tiny fragment scores
    # 1.0). Unseen grams are at least as rare as the rarest seen gram → weight them
    # at the max seen IDF so they count against the denominator.
    unseen = max(idf.values(), default=1.0)
    denom = _weighted(span.trigrams, idf, default=unseen)
    score = (_weighted(inter, idf, default=unseen) / denom) if denom > 0 else 0.0
    coverage = len(inter) / len(span.trigrams)  # raw fraction of the target explained
    union = span.trigrams | cand_grams
    jaccard = len(inter) / len(union) if union else 0.0
    best_ev = max(blocks, key=lambda e: len(span.trigrams & trigrams(e.block_text)))
    return _mk("trigram", score, coverage, jaccard, best_ev)


# --------------------------------------------------------------------------- #
# resolution (per span, honest about ambiguity) → BlameResult
# --------------------------------------------------------------------------- #
def _rank_key(m: SpanMatch) -> tuple[int, float, float]:
    return (m.tier, m.coverage, m.score)


def resolve(
    *,
    spans: list[TargetSpan],
    per_span: dict[str, list[SpanMatch]],
    query: dict[str, Any],
    min_score: float = 0.2,
    margin_delta: float = 0.1,
    min_coverage: float = 0.5,
) -> BlameResult:
    """Resolve authorship PER SPAN. A commit can have several clear authors across
    different spans (multi-author → still ``ok``). A span is ambiguous (→
    ``no_clear_author``) when ≥2 top candidates tie *regardless of method* (strong
    ties included), or the best is a fallback trigram below ``min_score`` / within
    ``margin_delta`` of the runner-up."""
    span_by_id = {s.span_id: s for s in spans}
    clear: dict[str, SpanMatch] = {}  # span_id -> winning match
    ambiguous: list[dict[str, Any]] = []
    matched_any = False

    for span in spans:
        cands = sorted(per_span.get(span.span_id, []), key=_rank_key, reverse=True)
        if not cands:
            continue
        top = cands[0]
        # weak trigram floor: a fuzzy fallback must clear BOTH the IDF score floor
        # AND a raw-coverage floor — a candidate sharing only a small fraction of the
        # target's grams (the confident-misattribution failure mode) is not an author.
        if top.tier == _TIER["trigram"] and (top.score < min_score or top.coverage < min_coverage):
            continue
        matched_any = True
        rivals = [c for c in cands if c.session_id != top.session_id]
        runner = rivals[0] if rivals else None
        # tie test: same tier AND coverage within epsilon (strong OR weak tie)
        tied = runner is not None and runner.tier == top.tier and abs(runner.coverage - top.coverage) < 1e-9
        # for the trigram tier, also treat a within-margin score gap as a tie
        if not tied and top.tier == _TIER["trigram"] and runner is not None:
            if (top.score - runner.score) < margin_delta:
                tied = True
        if tied:
            ambiguous.append(
                {
                    "file": span.file_path,
                    "span": list(span.line_range),
                    "score_gap": (top.score - runner.score) if runner else None,
                    "candidates": [
                        {
                            "session_id": c.session_id,
                            "source": c.source,
                            "method": c.method,
                            "score": c.score,
                            "handle": _handle(c),
                        }
                        for c in cands
                        if c.tier == top.tier
                    ],
                }
            )
        else:
            clear[span.span_id] = top

    if not matched_any:
        return BlameResult(query=query, status="no_overlap", matches=[], ambiguous_spans=[])

    # group clear spans by session → BlameMatch
    by_session: dict[str, list[SpanMatch]] = {}
    for span_id, m in clear.items():
        by_session.setdefault(m.session_id, []).append(m)

    total_target_chars = sum(len(s.norm_text) for s in spans) or 1
    matches: list[BlameMatch] = []
    for session_id, sms in by_session.items():
        best = max(sms, key=_rank_key)
        won_chars = sum(len(span_by_id[m.span_id].norm_text) for m in sms)
        matches.append(
            BlameMatch(
                source=best.source,
                session_id=session_id,
                source_path=best.source_path,
                line_no=best.line_no,
                handle=_handle(best),
                method=best.method,
                score=best.score,
                jaccard=best.jaccard,
                target_coverage=won_chars / total_target_chars,
                authored_spans=[
                    {
                        "file": span_by_id[m.span_id].file_path,
                        "span": list(span_by_id[m.span_id].line_range),
                        "span_id": m.span_id,
                    }
                    for m in sms
                ],
                evidence=[
                    {
                        "file": span_by_id[m.span_id].file_path,
                        "target_span": list(span_by_id[m.span_id].line_range),
                        "matched_edit_handle": m.matched_edit_tool_ref,
                        "method": m.method,
                    }
                    for m in sms
                ],
            )
        )
    matches.sort(key=lambda bm: bm.target_coverage, reverse=True)

    # status: any ambiguous queried span → no_clear_author; else ok
    status = "no_clear_author" if ambiguous else "ok"
    return BlameResult(query=query, status=status, matches=matches, ambiguous_spans=ambiguous)


def _handle(m: SpanMatch) -> dict[str, Any]:
    return {"source": m.source, "source_path": m.source_path, "session_id": m.session_id, "line_no": m.line_no}


# --------------------------------------------------------------------------- #
# CC extractor (consumes a loaded Session; pure w.r.t. that in-memory object)
# --------------------------------------------------------------------------- #
_CC_EDIT_OPS = {"Edit": "edit", "Write": "write", "MultiEdit": "multiedit"}


def cc_session_edits(session: Session) -> SessionEdits:
    """Extract successful Edit/Write/MultiEdit authored blocks from a loaded CC
    `Session`. The loader surfaces `tool_result_status` on the *result* event but
    does NOT join it to the tool_use — so we build the `tool_use_id → status` index
    here (net-new) and drop any edit whose paired result errored or is missing
    (a failed edit never wrote that text, so attributing it would be wrong)."""
    status_by_id: dict[str, str] = {}
    for ev in session.events:
        if ev.kind == "tool_result" and ev.tool_use_id:
            status_by_id[ev.tool_use_id] = ev.tool_result_status or "ok"

    edits: list[AuthorshipEvidence] = []
    for ev in session.events:
        if ev.kind != "tool_use" or ev.tool_name not in _CC_EDIT_OPS:
            continue
        if status_by_id.get(ev.tool_use_id or "") != "ok":  # require a successful paired result
            continue
        ti = ev.tool_input or {}
        op = _CC_EDIT_OPS[ev.tool_name]
        if ev.tool_name == "Write":
            blocks = [(ti.get("file_path", ""), ti.get("content", "") or "")]
        elif ev.tool_name == "Edit":
            blocks = [(ti.get("file_path", ""), ti.get("new_string", "") or "")]
        else:  # MultiEdit — contract-derived: input{file_path, edits:[{new_string}]}
            fp = ti.get("file_path", "")
            blocks = [(fp, (e or {}).get("new_string", "") or "") for e in (ti.get("edits") or [])]
        for fp, text in blocks:
            if not text:
                continue
            edits.append(
                AuthorshipEvidence.make(
                    source="cc",
                    source_path=str(session.source_path),
                    session_id=session.session_id,
                    line_no=ev.line_no,
                    tool_ref=ev.tool_use_id,
                    timestamp=ev.timestamp,
                    file_path=fp,
                    op=op,
                    block_text=text,
                )
            )
    return SessionEdits(
        source="cc",
        source_path=str(session.source_path),
        session_id=session.session_id,
        cwd=session.cwd,
        repo=None,  # S04 crawl stamps repo after git resolution
        edits=edits,
    )
