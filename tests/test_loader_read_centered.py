"""CORE-RECALL-CENTERED-1 Phase 1 — read_centered tests (TDD).

A char-budgeted, asymmetric (30%-back / 70%-forward) centered read of a
transcript around a 1-indexed line_no, mirroring crispy-recall.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from stratum.judge.postmortem.loader import read_centered


def _line(text: str, kind: str = "assistant") -> dict:
    if kind == "assistant":
        return {
            "type": "assistant",
            "timestamp": "t",
            "message": {"content": [{"type": "text", "text": text}]},
        }
    return {
        "type": "user",
        "timestamp": "t",
        "message": {"content": [{"type": "text", "text": text}]},
    }


def _write_jsonl(path: Path, texts: list[str]) -> None:
    lines = [json.dumps(_line(t)) for t in texts]
    path.write_text("\n".join(lines) + "\n")


def test_centered_window_contains_center_and_respects_budget(tmp_path):
    # 41 lines, each ~100 chars. Center on line 21 with a 2000-char budget.
    texts = [f"L{i:02d} " + ("x" * 95) for i in range(1, 42)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = read_centered(
        p, line_no=21, char_budget=2000, before_ratio=0.3, after_ratio=0.7,
        project_dir=tmp_path,
    )

    assert "L21" in res["window"], "window must contain the centered line"
    assert res["handle"] == {"session_id": "S", "line_no": 21}
    assert res["char_budget"] == 2000
    # INVARIANT: chars_used (== len('\n'.join(window))) never exceeds the budget.
    assert res["chars_used"] <= 2000
    # ...and the window is reasonably full (we charged join separators, so the
    # walk should still pack most of the budget).
    assert res["chars_used"] >= 2000 - 200
    # asymmetric: more forward lines than backward lines included
    # find the span of line markers present
    present = [i for i in range(1, 42) if f"L{i:02d}" in res["window"]]
    assert present, "expected some lines"
    back = [i for i in present if i < 21]
    fwd = [i for i in present if i > 21]
    assert len(fwd) > len(back), f"expected ~70/30 forward weighting, got back={back} fwd={fwd}"
    # cursors point just outside the included span
    assert res["continue_cursor"]["prev_line"] == (min(present) - 1 if min(present) > 1 else None)
    assert res["continue_cursor"]["next_line"] == (max(present) + 1 if max(present) < 41 else None)


def test_short_lines_charge_newline_separators_against_budget(tmp_path):
    # Mutation-resistant budget guard. With many SHORT lines the '\n' join
    # separators dominate the window length. If the outward walk failed to
    # charge those separators (the original bug), the joined window overshoots
    # the budget even though the sum of line texts fits. ~3-char lines + a tight
    # 100-char budget pushes the overshoot across the budget (pre-fix packs
    # ~33 lines -> ~131-char window), so a strict `chars_used <= budget` trips.
    texts = [f"L{i:02d}" for i in range(1, 81)]  # 80 lines, ~3 rendered chars each
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = read_centered(p, line_no=40, char_budget=100, project_dir=tmp_path)

    assert "L40" in res["window"], "window must contain the centered line"
    # chars_used is exactly the emitted window length (separators included)...
    assert res["chars_used"] == len(res["window"])
    # ...and the budget invariant holds even in the separator-dominated regime.
    assert res["chars_used"] <= 100


def test_center_at_file_start_spills_forward(tmp_path):
    texts = [f"L{i:02d} " + ("y" * 95) for i in range(1, 42)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = read_centered(p, line_no=1, char_budget=2000, project_dir=tmp_path)

    assert "L01" in res["window"]
    present = [i for i in range(1, 42) if f"L{i:02d}" in res["window"]]
    assert min(present) == 1, "no backward lines available at start"
    # budget never exceeded; backward budget spilled forward → still ~full
    assert res["chars_used"] <= 2000
    assert res["chars_used"] >= 2000 - 200
    assert res["continue_cursor"]["prev_line"] is None
    assert res["continue_cursor"]["next_line"] == max(present) + 1


def test_center_at_file_end_spills_backward(tmp_path):
    texts = [f"L{i:02d} " + ("z" * 95) for i in range(1, 42)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = read_centered(p, line_no=41, char_budget=2000, project_dir=tmp_path)

    assert "L41" in res["window"]
    present = [i for i in range(1, 42) if f"L{i:02d}" in res["window"]]
    assert max(present) == 41, "no forward lines available at end"
    assert res["chars_used"] <= 2000
    assert res["chars_used"] >= 2000 - 200
    assert res["continue_cursor"]["next_line"] is None
    assert res["continue_cursor"]["prev_line"] == min(present) - 1


def test_single_line_larger_than_budget_is_hard_truncated_alone(tmp_path):
    texts = [
        "small before",
        "BIG " + ("q" * 5000),
        "small after",
    ]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    res = read_centered(p, line_no=2, char_budget=1000, project_dir=tmp_path)

    assert "BIG" in res["window"]
    assert "small before" not in res["window"]
    assert "small after" not in res["window"]
    assert len(res["window"]) <= 1000
    assert res["chars_used"] <= 1000
    # cursors still let the caller step outward
    assert res["continue_cursor"]["prev_line"] == 1
    assert res["continue_cursor"]["next_line"] == 3


def test_continue_cursor_advances_without_overlap_or_gap(tmp_path):
    # Page through the transcript via the DEFAULT 30/70 cursor mechanism: an
    # initial centered read, then continue by feeding the returned cursor back in
    # (no manual ratio override). Successive pages must tile with no overlap and
    # no gap.
    texts = [f"L{i:02d} " + ("x" * 95) for i in range(1, 62)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    first = read_centered(p, line_no=21, char_budget=1500, project_dir=tmp_path)
    pages = [first]
    cursor = first["continue_cursor"]
    # Page forward 2 more times via the cursor (forward-only continuation).
    for _ in range(2):
        nxt = cursor["next_line"]
        if nxt is None:
            break
        page = read_centered(
            p, line_no=0, char_budget=1500, cursor=cursor, project_dir=tmp_path
        )
        pages.append(page)
        cursor = page["continue_cursor"]

    assert len(pages) >= 3, "expected to page forward at least twice via the cursor"

    spans = []
    for page in pages:
        present = [i for i in range(1, 62) if f"L{i:02d}" in page["window"]]
        assert present, "every page must contain some lines"
        # budget invariant holds on every page
        assert page["chars_used"] <= 1500
        spans.append((min(present), max(present), set(present)))

    # Continuation reads start exactly at the prior cursor's next_line.
    for prev, cur in zip(pages, pages[1:]):
        assert min(_present(cur)) == prev["continue_cursor"]["next_line"], (
            "continuation must start at the cursor"
        )

    # No overlap and no gap across consecutive pages.
    for (lo_a, hi_a, set_a), (lo_b, hi_b, set_b) in zip(spans, spans[1:]):
        assert set_a.isdisjoint(set_b), "pages must not overlap"
        assert lo_b == hi_a + 1, "pages must be contiguous (no gap)"


def _present(page):
    return [i for i in range(1, 200) if f"L{i:02d}" in page["window"]]


def test_out_of_range_line_no_clamps_handle(tmp_path):
    texts = [f"L{i:02d} " + ("x" * 30) for i in range(1, 12)]
    p = tmp_path / "S.jsonl"
    _write_jsonl(p, texts)

    # Above range: clamps to the last line (11) and the handle echoes the clamp.
    hi = read_centered(p, line_no=999, char_budget=1500, project_dir=tmp_path)
    assert hi["handle"]["line_no"] == 11, "handle must echo the clamped line, not 999"
    assert "L11" in hi["window"]

    # Below range: clamps to the first line (1).
    lo = read_centered(p, line_no=-5, char_budget=1500, project_dir=tmp_path)
    assert lo["handle"]["line_no"] == 1, "handle must echo the clamped line, not -5"
    assert "L01" in lo["window"]


def test_out_of_tree_path_is_rejected(tmp_path):
    # A transcript inside the allowed project root resolves fine...
    proj = tmp_path / "proj"
    proj.mkdir()
    inside = proj / "S.jsonl"
    _write_jsonl(inside, [f"L{i:02d} " + ("x" * 30) for i in range(1, 6)])
    ok = read_centered(inside, line_no=3, char_budget=1500, project_dir=proj)
    assert "L03" in ok["window"]

    # ...but an explicit path OUTSIDE the allowed root is rejected.
    outside = tmp_path / "secret.jsonl"
    _write_jsonl(outside, ["TOP SECRET"])
    with pytest.raises(ValueError):
        read_centered(outside, line_no=1, char_budget=1500, project_dir=proj)


def test_session_id_resolution_via_project_dir(tmp_path):
    texts = [f"L{i:02d} " + ("x" * 95) for i in range(1, 12)]
    proj = tmp_path / "proj"
    proj.mkdir()
    p = proj / "abc-session.jsonl"
    _write_jsonl(p, texts)

    res = read_centered("abc-session", line_no=5, char_budget=1500, project_dir=proj)
    assert res["handle"] == {"session_id": "abc-session", "line_no": 5}
    assert "L05" in res["window"]
