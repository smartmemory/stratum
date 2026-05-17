"""Predicate decomposition (STRAT-JUDGE-POSTMORTEM v2.2 #3).

Back-decompose a transcript candidate's `request_text` (+ work summary)
into a `list[Predicate]` in the *kernel's real taxonomy*
(`result.Predicate`, `PredicateType ∈ {deterministic, verified, judged}`).
Dual purpose (design): exercises the decomposer AND produces the judgment
targets the replay harness (#4) scores against.

Mirrors `llm_gate.py` exactly — litellm-routed, pydantic-validated,
**fail-open**. Fail-open here means an EMPTY predicate list (never a
fabricated predicate): a wrong predicate corrupts the corpus far worse
than a missing one, and replay treats zero predicates as explicitly
unscorable (it must NOT run `all([]) → met`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

import litellm

from stratum.judge.result import Predicate

DEFAULT_DECOMPOSE_MODEL = "claude-haiku-4-5"

_REQUEST_CAP = 2000
_WORK_SUMMARY_CAP = 800
_MAX_PREDICATES = 6


@dataclass(frozen=True)
class DecomposeResult:
    predicates: list[Predicate] = field(default_factory=list)
    applied: bool = True
    reason: str = ""
    model: str = ""


class _PredicateModel(BaseModel):
    id: str
    type: Literal["deterministic", "verified", "judged"]
    statement: str


class _DecomposeModel(BaseModel):
    predicates: list[_PredicateModel] = Field(min_length=1, max_length=_MAX_PREDICATES)


def build_decompose_prompt(request_text: str, work_summary: str) -> str:
    """Pure. The taxonomy wording matches the kernel contract exactly so the
    corpus calibrates against the *shipped* judge surface, not a variant."""
    req = (request_text or "").strip()[:_REQUEST_CAP]
    work = (work_summary or "").strip()[:_WORK_SUMMARY_CAP]
    return (
        "Decompose the user's request into 1-6 atomic acceptance predicates "
        "— the checkable conditions that must hold for the request to be "
        '"done". Use EXACTLY this taxonomy for each predicate\'s "type":\n'
        '  - "deterministic": a mechanically-checkable expression (exit code, '
        "file exists, git status, schema valid). NOT subjective.\n"
        '  - "verified": needs tool/filesystem evidence to confirm — e.g. '
        '"the tests pass", "the endpoint returns 200". (Tests passing is '
        "verified, NOT deterministic.)\n"
        '  - "judged": subjective / requires interpretation — e.g. "the '
        'error message is actionable".\n\n'
        f"USER REQUEST:\n{req}\n\n"
        f"WORK PERFORMED (tool summary):\n{work}\n\n"
        "Reply with ONLY this JSON, no prose:\n"
        '{"predicates": [{"id": "p1", "type": "verified", '
        '"statement": "<one atomic condition>"}, ...]}'
    )


def _strip_to_json(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else ""
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    lo, hi = s.find("{"), s.rfind("}")
    if lo == -1 or hi == -1 or hi < lo:
        return s.strip()
    return s[lo : hi + 1]


def parse_decompose_response(text: str, model: str = "") -> DecomposeResult:
    """Pure. Single fail-open path: any failure → empty predicate list,
    ``applied=False``. Never fabricates predicates."""
    try:
        raw = json.loads(_strip_to_json(text))
        parsed = _DecomposeModel.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — fail-open is the contract
        return DecomposeResult(
            predicates=[],
            applied=False,
            reason=f"decompose_error:{type(exc).__name__}",
            model=model,
        )
    preds = [
        Predicate(id=p.id, type=p.type, statement=p.statement, applied_gate=7)
        for p in parsed.predicates
    ]
    return DecomposeResult(predicates=preds, applied=True, reason="", model=model)


class LiteLLMDecomposer:
    """Concrete decomposer over ``litellm.completion``. Never raises —
    all exceptions become a fail-open empty-predicate result."""

    def __init__(
        self,
        model: str = DEFAULT_DECOMPOSE_MODEL,
        max_tokens: int = 512,
        timeout: float = 30.0,
    ) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout

    def decompose(self, request_text: str, work_summary: str) -> DecomposeResult:
        prompt = build_decompose_prompt(request_text, work_summary)
        try:
            resp = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.max_tokens,
                timeout=self.timeout,
            )
            content = resp["choices"][0]["message"]["content"]
        except Exception as exc:  # noqa: BLE001 — fail-open is the contract
            return DecomposeResult(
                predicates=[],
                applied=False,
                reason=f"decompose_error:{type(exc).__name__}",
                model=self.model,
            )
        return parse_decompose_response(content, model=self.model)
