"""STRAT-DISTILL synthesis — WorkflowCandidate -> staged AssetCandidate.

Picks the smallest appropriate asset form (command / skill / subagent) for a
detected repeated workflow, with an opt-in, fail-open LLM override. Honors the
anti-slop bar: below-recurrence or formless workflows yield ``None`` ("create
nothing"). Produces *described* content only — never writes a file.
"""
from __future__ import annotations

import hashlib
import re
from typing import Callable, Optional

from stratum.judge.distill.candidate import AssetCandidate, AssetKind
from stratum.judge.distill.detector import WorkflowCandidate

# Read-only investigation tools — a sequence built only of these reads like a
# delegatable specialist, so it maps to a subagent rather than a skill.
_READ_ONLY = {"Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"}
_VALID_FORMS = ("skill", "subagent", "command")

# Opt-in LLM override: workflow -> form string (or anything else / raise → ignored).
LlmForm = Callable[[WorkflowCandidate], Optional[str]]


def _heuristic_form(workflow: WorkflowCandidate) -> Optional[AssetKind]:
    if workflow.kind == "single":
        # a single recurring invocation → a re-runnable parameterized command
        return "command"
    if workflow.kind == "sequence":
        tools = {t for t in workflow.steps}
        if tools and tools <= _READ_ONLY:
            return "subagent"
        return "skill"
    return None


def _slug(workflow: WorkflowCandidate) -> str:
    if workflow.kind == "sequence":
        base = "-".join(str(t) for t in workflow.steps)
    else:
        tool = workflow.steps[0][0] if workflow.steps else "workflow"
        hint = ""
        if workflow.sample_inputs:
            hint = workflow.sample_inputs[0].split("=", 1)[-1]
        base = f"{tool}-{hint}" if hint else str(tool)
    slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-")
    return (slug or "workflow")[:48]


def _target_path(form: AssetKind, name: str) -> str:
    return {
        "skill": f"skills/{name}/SKILL.md",
        "subagent": f"agents/{name}.md",
        "command": f"commands/{name}.md",
    }[form]


def _describe(workflow: WorkflowCandidate, form: AssetKind, name: str) -> str:
    seq = " → ".join(str(t) for t in workflow.steps) if workflow.kind == "sequence" else workflow.signature
    header = {
        "skill": f"# Skill: {name}\n\nA reusable playbook for a workflow seen "
        f"{workflow.count}x. Steps observed: {seq}.",
        "subagent": f"# Subagent: {name}\n\nA delegatable investigation that recurred "
        f"{workflow.count}x. Read-only steps: {seq}.",
        "command": f"# Command: /{name}\n\nA parameterized command for a recurring "
        f"invocation ({workflow.count}x): {workflow.signature}.",
    }[form]
    return (
        header
        + "\n\nThis is a STAGED suggestion derived from your transcripts; review and "
        "edit before creating the asset. Evidence sessions: "
        + ", ".join(workflow.evidence_session_ids)
        + "."
    )


def synthesize(
    workflow: WorkflowCandidate,
    *,
    llm_form: Optional[LlmForm] = None,
    min_count: int = 2,
) -> Optional[AssetCandidate]:
    """Synthesize a staged AssetCandidate, or ``None`` if not worth packaging.

    ``llm_form`` is the opt-in LLM clustering/worth-packaging override; it is
    fail-open — any exception or an invalid/ambiguous reply falls back to the
    heuristic form. Never writes a file.
    """
    if workflow.count < min_count:
        return None

    form: Optional[AssetKind] = _heuristic_form(workflow)

    if llm_form is not None:
        try:
            suggested = llm_form(workflow)
            if suggested in _VALID_FORMS:
                form = suggested  # type: ignore[assignment]
            # invalid / None / ambiguous → keep heuristic
        except Exception:
            pass  # fail-open to heuristic

    if form is None:
        return None

    name = _slug(workflow)
    # Include the chosen form in the idempotency key so that if synthesis later
    # picks a *different* asset form for the same workflow, the improved candidate
    # is a new sidecar row rather than being silently deduped against the old one.
    cluster_id = hashlib.sha1(
        f"{workflow.kind}:{workflow.signature}:{form}".encode("utf-8")
    ).hexdigest()[:12]
    confidence = min(95, 50 + 10 * workflow.count + 5 * workflow.session_count)

    return AssetCandidate(
        asset_kind=form,
        asset_name=name,
        target_path=_target_path(form, name),
        trigger_pattern=workflow.signature,
        rationale=f"Recurred {workflow.count}x across {workflow.session_count} session(s).",
        suggested_content=_describe(workflow, form, name),
        evidence_session_ids=tuple(workflow.evidence_session_ids),
        cluster_id=cluster_id,
        confidence=confidence,
    )
