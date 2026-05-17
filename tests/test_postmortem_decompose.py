"""STRAT-JUDGE-POSTMORTEM v2.2 #3 — predicate decomposition."""

from __future__ import annotations

import pytest

from stratum.judge.postmortem.decompose import (
    DEFAULT_DECOMPOSE_MODEL,
    LiteLLMDecomposer,
    build_decompose_prompt,
    parse_decompose_response,
)
from stratum.judge.result import Predicate

_GOOD = '{"predicates": [{"id": "p1", "type": "verified", "statement": "tests pass"}]}'


def test_prompt_includes_request_and_taxonomy():
    p = build_decompose_prompt("REQ_TOKEN add a flag", "Edit, Bash")
    assert "REQ_TOKEN" in p
    # taxonomy wording must match the kernel contract
    assert "deterministic" in p and "verified" in p and "judged" in p
    assert "Tests passing is verified" in p


@pytest.mark.parametrize("text", [
    _GOOD,
    f"```json\n{_GOOD}\n```",
    f"Here you go: {_GOOD} — done",
])
def test_parse_valid(text):
    r = parse_decompose_response(text, model="m")
    assert r.applied is True and len(r.predicates) == 1
    p = r.predicates[0]
    assert isinstance(p, Predicate)
    assert p.id == "p1" and p.type == "verified" and p.applied_gate == 7


@pytest.mark.parametrize("text", [
    "not json",
    "{",
    '{"predicates": []}',                                  # min_length=1
    '{"predicates": [{"id":"p1","type":"bogus","statement":"x"}]}',  # bad type
    '{"predicates": [{"id":"p1","type":"verified"}]}',     # missing statement
    '{"predicates": ' + "[" + ",".join(['{"id":"p%d","type":"judged","statement":"s"}' % i for i in range(7)]) + "]}",  # >6
    "",
])
def test_parse_fail_open_empty(text):
    r = parse_decompose_response(text, model="m")
    assert r.applied is False
    assert r.predicates == []                              # never fabricated
    assert r.reason.startswith("decompose_error:")


def test_parse_non_string_fail_open():
    r = parse_decompose_response(None, model="m")  # type: ignore[arg-type]
    assert r.applied is False and r.predicates == []


def test_litellm_decomposer_constructs_keyfree():
    assert LiteLLMDecomposer().model == DEFAULT_DECOMPOSE_MODEL


def test_litellm_decomposer_fail_open(monkeypatch):
    import stratum.judge.postmortem.decompose as mod

    monkeypatch.setattr(mod.litellm, "completion",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    r = LiteLLMDecomposer().decompose("req", "Edit")
    assert r.applied is False and r.predicates == []
    assert r.reason == "decompose_error:RuntimeError"


def test_litellm_decomposer_success(monkeypatch):
    import stratum.judge.postmortem.decompose as mod

    monkeypatch.setattr(
        mod.litellm, "completion",
        lambda *a, **k: {"choices": [{"message": {"content": _GOOD}}]},
    )
    r = LiteLLMDecomposer(model="mdl").decompose("req", "Edit")
    assert r.applied is True and len(r.predicates) == 1 and r.model == "mdl"
