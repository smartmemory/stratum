"""STRAT-LEARN-INLINE — pure classify + emit for the inline self-patch edge.

This module is pure (no IO). Given a ``JudgeResult`` and an
``InlineLearnConfig``, it classifies each ``must-fix`` (``not_met``) predicate
as ``transient`` / ``step-local`` / ``durable`` and, for ``durable`` cases,
builds a *described* skill/MEMORY patch candidate (never a literal diff,
never applied). The IO edges (FlowState mutation, sidecar append, audit
surfacing) live in the stratum-mcp server layer.

Departures from Hermes ``skill_manage(patch)`` are structural here: the
candidate target is constrained to ``skill``/``memory`` (never the running
spec), and the candidate is a description, not an applied edit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Optional

from .result import JudgeResult, PredicateResult

FixTarget = Literal["transient", "step-local", "durable"]

# Default durable-note home — project-memory convention
# (skills/stratum-feature/SKILL.md, stratum-onboard/SKILL.md).
DEFAULT_MEMORY_PATH = ".claude/memory/MEMORY.md"

# Markers in a deterministic predicate's reason that indicate the failure is
# flaky/environmental rather than a real, generalizable gap.
_TRANSIENT_MARKERS = re.compile(
    r"\b(flak|timed?\s*out|timeout|transient|raised|exception|connection|"
    r"unavailable|temporarily)\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class InlineLearnConfig:
    """Resolved inline-learn config (built by
    ``stratum.project_config.resolve_inline_learn`` from TOML + env)."""

    enabled: bool = False
    classifier: str = "heuristic"   # "heuristic" | "llm"


@dataclass(frozen=True)
class PatchCandidate:
    """A staged, *described* skill/MEMORY patch proposal. Never applied."""

    fix_target: FixTarget
    target_kind: Literal["skill", "memory"]
    target_path: str
    patch_type: Literal["create", "patch", "edit"]
    rationale: str
    suggested_change: str
    source_finding: str
    predicate_id: str
    predicate_type: str
    confidence: int

    def to_dict(self) -> dict:
        return {
            "fix_target": self.fix_target,
            "target_kind": self.target_kind,
            "target_path": self.target_path,
            "patch_type": self.patch_type,
            "rationale": self.rationale,
            "suggested_change": self.suggested_change,
            "source_finding": self.source_finding,
            "predicate_id": self.predicate_id,
            "predicate_type": self.predicate_type,
            "confidence": self.confidence,
        }


def _reason_of(pr: PredicateResult) -> str:
    return pr.tier_history[-1].reason if pr.tier_history else ""


def classify_fix_target(pr: PredicateResult) -> FixTarget:
    """Deterministic heuristic classifier (the default path).

    - ``judged`` failure        → ``durable``   (subjective gap a note generalizes)
    - ``deterministic`` + flaky → ``transient`` (retry, no lesson)
    - everything else           → ``step-local`` (fix the code in this run)
    """
    if pr.type == "judged":
        return "durable"
    if pr.type == "deterministic" and _TRANSIENT_MARKERS.search(_reason_of(pr)):
        return "transient"
    return "step-local"


async def _llm_classify(
    pr: PredicateResult,
    agent_run: Optional[Callable[..., Awaitable]],
) -> FixTarget:
    """Optional LLM classifier — fail-open to the heuristic on any problem."""
    if agent_run is None:
        return classify_fix_target(pr)
    try:
        prompt = (
            "Classify the fix target for this failed acceptance predicate as "
            "exactly one of: transient, step-local, durable.\n"
            "- transient: flaky/environmental, just retry.\n"
            "- step-local: a real bug to fix in this run; the lesson does not "
            "generalize.\n"
            "- durable: the lesson generalizes — a skill/MEMORY note would "
            "help future runs.\n\n"
            f"Predicate ({pr.type}): {pr.statement}\n"
            f"Why it failed: {_reason_of(pr)}\n\n"
            "Answer with only the single word."
        )
        resp = await agent_run(prompt=prompt, type="claude")
        text = (resp.get("text") if isinstance(resp, dict) else str(resp)) or ""
        low = text.strip().lower()
        # Whole-word match so "not durable" doesn't read as durable; if the
        # reply names more than one label it's ambiguous → fall back.
        found = {
            ft for ft in ("durable", "step-local", "transient")
            if re.search(rf"(?<![\w-]){re.escape(ft)}(?![\w-])", low)
        }
        if len(found) == 1:
            return found.pop()  # type: ignore[return-value]
    except Exception:
        pass
    return classify_fix_target(pr)


def _target_for(pr: PredicateResult) -> tuple[Literal["skill", "memory"], str, Literal["create", "patch", "edit"]]:
    """Best-guess target for a durable candidate. Described-intent only, so an
    inexact path is a hint, not load-bearing. Defaults to the project-memory
    note home; switches to a skill target when the finding names a skill."""
    text = f"{pr.statement} {_reason_of(pr)}".lower()
    if re.search(r"\bskill\b", text):
        return "skill", "<owning-skill>/SKILL.md", "patch"
    return "memory", DEFAULT_MEMORY_PATH, "edit"


def build_candidate(pr: PredicateResult, fix_target: FixTarget = "durable") -> PatchCandidate:
    """Build a described patch candidate for a durable predicate failure."""
    reason = _reason_of(pr)
    target_kind, target_path, patch_type = _target_for(pr)
    return PatchCandidate(
        fix_target=fix_target,
        target_kind=target_kind,
        target_path=target_path,
        patch_type=patch_type,
        rationale=(
            f"A {pr.type} acceptance predicate failed in a way that may recur "
            f"across runs; a durable note could prevent re-deriving the fix."
        ),
        suggested_change=(
            f"Add guidance so future runs satisfy: \"{pr.statement}\". "
            f"Observed gap: {reason or '(no reason recorded)'}"
        ),
        source_finding=f"{pr.statement} — {reason}",
        predicate_id=pr.id,
        predicate_type=pr.type,
        confidence=pr.confidence,
    )


async def emit_candidates(
    result: JudgeResult,
    cfg: InlineLearnConfig,
    *,
    agent_run: Optional[Callable[..., Awaitable]] = None,
) -> list[PatchCandidate]:
    """Classify every ``not_met`` predicate; return candidates for the
    ``durable`` ones only. ``transient``/``step-local`` produce nothing."""
    if not cfg.enabled:
        return []
    out: list[PatchCandidate] = []
    for pr in result.predicates:
        if pr.verdict != "not_met":
            continue
        if cfg.classifier == "llm":
            ft = await _llm_classify(pr, agent_run)
        else:
            ft = classify_fix_target(pr)
        if ft == "durable":
            out.append(build_candidate(pr, ft))
    return out
