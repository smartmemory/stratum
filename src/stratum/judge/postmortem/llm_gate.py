"""LLM-augmented segmenter gate (STRAT-JUDGE-POSTMORTEM v2.1).

The regex segmenter is the *recall* layer. This gate is the *precision*
layer: after a candidate (request, work span, claim) is assembled, a single
cheap-SLM call confirms the request and the completion claim are about the
*same task*. This surgically rejects the documented failure mode where the
segmenter latches a claim onto a later, unrelated task in the same session
(design.md — the "soft-wrap" misattribution).

Design constraints realised here:

  * Inject-a-callable, mirroring ``verifier.py`` — ``segment()`` takes a
    :class:`SegmenterGate` Protocol; logic stays pure and unit-testable.
  * Routed through ``litellm`` (a declared dependency, already used in
    ``executor.py``) — *not* the ``anthropic`` SDK, which is not declared.
  * Fail-open: any error — network, timeout, JSON parse failure, *or*
    syntactically-valid-but-semantically-invalid output — keeps the
    candidate and records ``applied=False``. A calibration corpus must not
    silently shrink because of infra flakiness or a malformed model reply.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from pydantic import BaseModel, Field, StrictBool

import litellm

DEFAULT_GATE_MODEL = "claude-haiku-4-5"
DEFAULT_GATE_THRESHOLD = 0.7

# Field caps keep the cheap-SLM prompt cheap and bounded.
_REQUEST_CAP = 1500
_CLAIM_CAP = 1500
_WORK_SUMMARY_CAP = 800


@dataclass(frozen=True)
class GateVerdict:
    """The gate's judgement on one candidate.

    ``applied`` is False whenever the gate could not produce a trustworthy
    answer (error / malformed output). Callers MUST NOT drop a candidate on
    a verdict with ``applied=False`` — that is the fail-open contract.
    """

    same_task: bool
    confidence: float
    reason: str
    applied: bool = True
    model: str = ""


@dataclass
class SegmentStats:
    """Mutable accumulator threaded through ``segment()`` calls.

    Rejected candidates are not persisted anywhere; this is the only cheap
    visibility into how much the gate is shrinking the corpus.
    """

    gate_checked: int = 0
    gate_rejected: int = 0


@runtime_checkable
class SegmenterGate(Protocol):
    """One same-task check. Implementations must never raise — they return a
    fail-open :class:`GateVerdict` instead (``applied=False``)."""

    def check(
        self, request_text: str, claim_text: str, work_summary: str
    ) -> GateVerdict: ...


class _GateResponse(BaseModel):
    """Schema the model is asked to emit. ``StrictBool`` rejects strings and
    ints for ``same_task``; ``confidence`` is range-bound to ``[0, 1]``.
    Anything outside this shape raises ``ValidationError`` → fail-open."""

    same_task: StrictBool
    confidence: float = Field(ge=0.0, le=1.0)
    reason: str


def build_gate_prompt(
    request_text: str, claim_text: str, work_summary: str
) -> str:
    """Pure. Build the same-task adjudication prompt with bounded fields."""
    req = (request_text or "").strip()[:_REQUEST_CAP]
    claim = (claim_text or "").strip()[:_CLAIM_CAP]
    work = (work_summary or "").strip()[:_WORK_SUMMARY_CAP]
    return (
        "You judge whether an AI assistant's completion claim is about the "
        "SAME task as the user's original request. The claim may belong to "
        "a later, unrelated task in the same session — that is what you must "
        "catch.\n\n"
        f"USER REQUEST:\n{req}\n\n"
        f"WORK PERFORMED (tool summary):\n{work}\n\n"
        f"ASSISTANT COMPLETION CLAIM:\n{claim}\n\n"
        'Reply with ONLY this JSON object, no prose:\n'
        '{"same_task": <true|false>, "confidence": <0.0-1.0>, '
        '"reason": "<one sentence>"}'
    )


def _strip_to_json(text: str) -> str:
    """Strip ``` fences and slice the first '{' .. last '}' (tolerance
    approach mirrored from verifier.py:_parse_t2_json)."""
    s = (text or "").strip()
    if s.startswith("```"):
        # drop the opening fence line and any trailing fence
        s = s.split("\n", 1)[1] if "\n" in s else ""
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    lo = s.find("{")
    hi = s.rfind("}")
    if lo == -1 or hi == -1 or hi < lo:
        return s.strip()
    return s[lo : hi + 1]


def parse_gate_response(text: str, model: str = "") -> GateVerdict:
    """Pure. Parse + validate a model reply into a :class:`GateVerdict`.

    Single fail-open path: JSON decode failure, pydantic ``ValidationError``
    (out-of-range confidence, non-bool same_task, missing reason), or any
    other exception all yield ``applied=False`` (candidate kept).
    """
    try:
        raw = json.loads(_strip_to_json(text))
        parsed = _GateResponse.model_validate(raw)
    except Exception as exc:  # noqa: BLE001 — single fail-open path is the contract
        return GateVerdict(
            same_task=True,
            confidence=0.0,
            reason=f"gate_error:{type(exc).__name__}",
            applied=False,
            model=model,
        )
    return GateVerdict(
        same_task=parsed.same_task,
        confidence=parsed.confidence,
        reason=parsed.reason,
        applied=True,
        model=model,
    )


class LiteLLMGate:
    """Concrete gate over ``litellm.completion``. Never raises — all
    exceptions (auth, rate-limit, network, timeout) become a fail-open
    verdict so corpus extraction is resilient to infra flakiness."""

    def __init__(
        self,
        model: str = DEFAULT_GATE_MODEL,
        max_tokens: int = 256,
        timeout: float = 30.0,
    ) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout

    def check(
        self, request_text: str, claim_text: str, work_summary: str
    ) -> GateVerdict:
        prompt = build_gate_prompt(request_text, claim_text, work_summary)
        try:
            resp = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.max_tokens,
                timeout=self.timeout,
            )
            content = resp["choices"][0]["message"]["content"]
        except Exception as exc:  # noqa: BLE001 — fail-open is the contract
            return GateVerdict(
                same_task=True,
                confidence=0.0,
                reason=f"gate_error:{type(exc).__name__}",
                applied=False,
                model=self.model,
            )
        return parse_gate_response(content, model=self.model)
