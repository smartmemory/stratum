"""S01 pure matcher tests (CORE-CODE-PROVENANCE-1 Phase 1).

Covers the design's hard acceptance criteria for the scoring/ranking core:
structural-not-clock, strong-evidence-beats-fuzzy, strong-tie ambiguity,
multi-author, degenerate targets (no div-by-zero), and the no-I/O guard.
"""

from __future__ import annotations

from pathlib import Path

from stratum.judge.postmortem.provenance import (
    AuthorshipEvidence,
    SessionEdits,
    TargetSpan,
    compute_idf,
    normalize,
    resolve,
    score_span,
    trigrams,
)


# --------------------------------------------------------------------------- #
# builders
# --------------------------------------------------------------------------- #
def _ev(session_id: str, file_path: str, text: str, line: int = 1) -> AuthorshipEvidence:
    return AuthorshipEvidence.make(
        source="cc",
        source_path=f"/x/{session_id}.jsonl",
        session_id=session_id,
        line_no=line,
        tool_ref=f"tu_{session_id}_{line}",
        timestamp="2026-06-22T00:00:00Z",
        file_path=file_path,
        op="edit",
        block_text=text,
    )


def _sess(session_id: str, *evs: AuthorshipEvidence) -> SessionEdits:
    return SessionEdits(
        source="cc",
        source_path=f"/x/{session_id}.jsonl",
        session_id=session_id,
        cwd="/repo",
        repo="/repo",
        edits=list(evs),
    )


def _span(file_path: str, text: str, span_id: str = "s1", line_range=(1, 1)) -> TargetSpan:
    return TargetSpan.make(file_path=file_path, span_id=span_id, line_range=line_range, text=text)


def _blame(spans, candidates, **kw):
    idf = compute_idf(candidates)
    per_span: dict[str, list] = {}
    for span in spans:
        for c in candidates:
            sm = score_span(span, c, idf)
            if sm is not None:
                per_span.setdefault(span.span_id, []).append(sm)
    return resolve(spans=spans, per_span=per_span, query={"mode": "commit"}, **kw)


# --------------------------------------------------------------------------- #
# units
# --------------------------------------------------------------------------- #
def test_normalize_collapses_whitespace():
    assert normalize("def  f( ):\n    return   1") == "def f( ): return 1"


def test_trigrams_short_text_empty():
    assert trigrams("ab") == set()
    assert "def" in trigrams("def x")


# --------------------------------------------------------------------------- #
# structural-not-clock + strong-evidence-beats-fuzzy
# --------------------------------------------------------------------------- #
TARGET_FN = "def settle_invoice(amount, currency):\n    total = amount * fx_rate(currency)\n    return round(total, 2)\n"


def test_strong_evidence_beats_high_trigram_decoy():
    """The verbatim author wins by `exact`; a prolific unrelated session that only
    shares generic same-language idioms must NOT win, regardless of clock order."""
    author = _sess("author", _ev("author", "billing.py", "# wrote it\n" + TARGET_FN))
    # decoy wrote LOTS of generic python — high tri-gram overlap, never the target
    decoy_blob = "\n".join(
        f"def helper_{i}(x, y):\n    total = x + y\n    return round(total, 2)\n" for i in range(40)
    )
    decoy = _sess("decoy", _ev("decoy", "billing.py", decoy_blob))
    res = _blame([_span("billing.py", TARGET_FN)], [author, decoy])
    assert res.status == "ok"
    assert len(res.matches) == 1
    assert res.matches[0].session_id == "author"
    assert res.matches[0].method == "exact"


def test_normalized_match_survives_whitespace_reflow():
    """Reindentation / internal whitespace differences the raw substring misses are
    bridged by the `normalized` tier (whitespace-run collapse). (Operator-spacing
    like `a=b` vs `a = b` is deliberately NOT bridged — a deferred open question.)"""
    # block has extra indentation + a double space the target lacks → not a raw substring,
    # but equal after whitespace collapse.
    block = "def f():\n        alpha  =  beta + gamma\n        return alpha\n"
    target = "alpha = beta + gamma"
    author = _sess("author", _ev("author", "billing.py", block))
    res = _blame([_span("billing.py", target)], [author])
    assert res.status == "ok"
    assert res.matches[0].session_id == "author"
    assert res.matches[0].method == "normalized"  # not exact (raw spacing differs)


# --------------------------------------------------------------------------- #
# strong-tie ambiguity
# --------------------------------------------------------------------------- #
def test_strong_tie_is_no_clear_author():
    """Two sessions that both authored the exact same block → ambiguous, not a
    confident pick (copied code / same patch applied twice)."""
    a = _sess("a", _ev("a", "billing.py", TARGET_FN))
    b = _sess("b", _ev("b", "billing.py", TARGET_FN))
    res = _blame([_span("billing.py", TARGET_FN)], [a, b])
    assert res.status == "no_clear_author"
    assert res.matches == []
    assert len(res.ambiguous_spans) == 1
    tied_ids = {c["session_id"] for c in res.ambiguous_spans[0]["candidates"]}
    assert tied_ids == {"a", "b"}


# --------------------------------------------------------------------------- #
# multi-author commit
# --------------------------------------------------------------------------- #
def test_multi_author_across_files_is_ok():
    """Different files authored by different sessions → status ok, two matches,
    each carrying its own authored_spans."""
    fn_a = "def alpha():\n    return 'AAAAAAAAAAAA'\n"
    fn_b = "def bravo():\n    return 'BBBBBBBBBBBB'\n"
    a = _sess("a", _ev("a", "a.py", fn_a))
    b = _sess("b", _ev("b", "b.py", fn_b))
    spans = [_span("a.py", fn_a, span_id="sa"), _span("b.py", fn_b, span_id="sb")]
    res = _blame(spans, [a, b])
    assert res.status == "ok"
    got = {m.session_id: [s["file"] for s in m.authored_spans] for m in res.matches}
    assert got == {"a": ["a.py"], "b": ["b.py"]}


# --------------------------------------------------------------------------- #
# degenerate targets (no div-by-zero)
# --------------------------------------------------------------------------- #
def test_degenerate_short_span_no_overlap_no_crash():
    # a <3-char span absent from the author's blocks → no trigrams, no substring
    # match → None (no candidate) → no_overlap, and crucially no div-by-zero.
    # (Sub-3-char *rejection* as no_indexable_content is the crawl's job, not here.)
    author = _sess("author", _ev("author", "billing.py", TARGET_FN))
    res = _blame([_span("billing.py", "qz")], [author])
    assert res.status == "no_overlap"
    assert res.matches == []


def test_no_candidates_is_no_overlap():
    res = _blame([_span("billing.py", TARGET_FN)], [])
    assert res.status == "no_overlap"


# --------------------------------------------------------------------------- #
# fuzzy fallback: honest, never confidently mis-attributing a tiny overlap
# --------------------------------------------------------------------------- #
def test_tiny_fragment_overlap_is_not_a_confident_author():
    # a candidate sharing only a tiny generic fragment of a large distinctive target
    # must NOT score ~1.0 / win confidently (the denominator must count target grams
    # the candidate lacks). This is the confident-misattribution failure mode.
    target = (
        "def reconcile_ledger(entries, currency, precision):\n"
        "    grand_total = sum(adjusted_amount(e, currency) for e in entries)\n"
        "    return quantize_to_minor_units(grand_total, precision)\n"
    )
    frag = _sess("frag", _ev("frag", "x.py", "    return result\n"))  # shares only a sliver
    res = _blame([_span("x.py", target)], [frag])
    assert res.status in {"no_overlap", "no_clear_author"}
    assert res.matches == []


def test_genuine_high_overlap_fuzzy_author_is_found():
    # a candidate sharing MOST of the target (drifted, no exact verbatim substring)
    # IS attributed (status ok) — the fuzzy path still works for real authors.
    target = "alpha = 1\nbeta = computed_value * 2\ngamma = beta + alpha\ndelta = gamma - 7\nresult = finalize(delta)\n"
    drifted = "alpha = 1\nbeta = computed_value * 2\ngamma = beta + alpha\ndelta = gamma - 8\nresult = finalize(delta, mode='x')\n"
    auth = _sess("auth", _ev("auth", "x.py", drifted))
    res = _blame([_span("x.py", target)], [auth])
    assert res.status == "ok"
    assert res.matches[0].session_id == "auth"


# --------------------------------------------------------------------------- #
# no-I/O guard
# --------------------------------------------------------------------------- #
def test_provenance_module_is_pure_no_io():
    src = (Path(__file__).resolve().parents[1] / "src/stratum/judge/postmortem/provenance.py").read_text()
    for banned in ("subprocess", "import os", "os.", "open(", "Path("):
        assert banned not in src, f"pure matcher must not perform I/O ({banned!r})"
