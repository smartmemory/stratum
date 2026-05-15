"""Worker-prompt template assembly and artifact-block extraction.

Public API
----------
mk_turn_nonce()
    Generate a fresh 16-char hex nonce for one turn (``secrets.token_hex(8)``).

build_turn_prompt(prompt, artifact_contract, prior_findings, turn_nonce)
    Assemble the four-section worker prompt per design.md Decision 6.

extract_artifacts(worker_text, artifact_contract, turn_nonce)
    Regex-extract ``===ARTIFACT-<turn_nonce>:<name>===`` fenced blocks.
    Returns ``(artifacts_dict, missing_required: list[str])``.
"""

from __future__ import annotations

import re
import secrets
from typing import Any


# ---------------------------------------------------------------------------
# Nonce
# ---------------------------------------------------------------------------

def mk_turn_nonce() -> str:
    """Return a fresh 16-char hex string from 8 bytes of cryptographic entropy.

    Per-turn nonces make artifact fences un-guessable: a worker that tries to
    fake the fence without knowing the nonce cannot produce a matching block.
    """
    return secrets.token_hex(8)


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

_ARTIFACT_FENCE_EXAMPLE = "===ARTIFACT-<turn_nonce>:<name>==="
_ARTIFACT_END = "===END==="


def build_turn_prompt(
    prompt: str,
    artifact_contract: list[dict],
    prior_findings: list[dict],
    turn_nonce: str,
    *,
    rejection_note: str | None = None,
) -> str:
    """Assemble the four-section (or five-section) worker prompt.

    Section order (design.md Decision 6):

    [Task]
        The caller-supplied task description.

    [Human override]  (Finding 4 — present only when rejection_note is set)
        The human's rejection note from the most-recent stratum_goal_decide(reject).

    [Artifacts to produce this turn]
        Rendered artifact contract: name, description, how_to_capture.

    [Previous judge feedback]
        PRD M10 feedback window: most-recent 3 turns verbatim;
        older turns summarised as a 1-line count.

    [Constraints]
        Fence format instructions with the per-turn nonce.
    """
    sections = [_task_section(prompt)]
    if rejection_note:
        sections.append(_human_override_section(rejection_note))
    sections += [
        _artifacts_section(artifact_contract, turn_nonce),
        _feedback_section(prior_findings),
        _constraints_section(artifact_contract, turn_nonce),
    ]
    return "\n\n".join(sections)


def _task_section(prompt: str) -> str:
    return f"[Task]\n{prompt}"


def _human_override_section(rejection_note: str) -> str:
    """Finding 4: surface the human's rejection note as a named section.

    This is injected into the prompt immediately after [Task] whenever the
    most-recent stratum_goal_decide call was a 'reject'. The worker sees the
    literal note text so it can address the reviewer's concern on the next turn.
    """
    return f"[Human override]\n{rejection_note}"


def _artifacts_section(artifact_contract: list[dict], turn_nonce: str) -> str:
    if not artifact_contract:
        return "[Artifacts to produce this turn]\n(none required)"
    lines = ["[Artifacts to produce this turn]"]
    for spec in artifact_contract:
        name = spec["name"]
        desc = spec.get("description", "")
        how = spec.get("how_to_capture", "")
        required_tag = "" if spec.get("required", True) else " (optional)"
        lines.append(f"- {name}{required_tag}: {desc}")
        if how:
            lines.append(f"  How to capture: {how}")
        lines.append(
            f"  Fence: ===ARTIFACT-{turn_nonce}:{name}===  ...  ===END==="
        )
    return "\n".join(lines)


def _feedback_section(prior_findings: list[dict]) -> str:
    """Render prior-turn feedback with the PRD M10 feedback window.

    Keeps the most-recent 3 turns verbatim; older turns are collapsed
    to a 1-line summary: "N earlier turn(s) also had not_met verdicts."
    """
    header = "[Previous judge feedback]"
    if not prior_findings:
        return f"{header}\n(no prior feedback — first turn)"

    recent = prior_findings[-3:]
    older = prior_findings[:-3]

    parts: list[str] = [header]

    if older:
        parts.append(
            f"(Previously: {len(older)} earlier turn(s) with not-met or ambiguous verdicts.)"
        )

    for turn_record in recent:
        turn_num = turn_record.get("turn", "?")
        findings = turn_record.get("findings", [])
        if findings:
            finding_lines = "\n".join(
                f"  - [{f.get('predicate_id', '?')}] {f.get('verdict', '?')}: {f.get('reason', '')}"
                for f in findings
            )
            parts.append(f"Turn {turn_num} findings:\n{finding_lines}")
        else:
            parts.append(f"Turn {turn_num}: (no findings)")

    return "\n".join(parts)


def _constraints_section(artifact_contract: list[dict], turn_nonce: str) -> str:
    artifact_names = ", ".join(f'"{s["name"]}"' for s in artifact_contract) or "(none)"
    lines = [
        "[Constraints]",
        f"- Produce each listed artifact verbatim in your response, fenced exactly as:",
        f"  ===ARTIFACT-{turn_nonce}:<name>===",
        f"  <artifact content>",
        f"  ===END===",
        f"- The nonce `{turn_nonce}` is unique to this turn. Use it exactly.",
        f"- Required artifacts: {artifact_names}",
        f"- The judge will read these as captured outputs; do not paraphrase.",
        f"- Do not emit the fence string with a different nonce — it will not be parsed.",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Artifact extraction
# ---------------------------------------------------------------------------

# Compiled once per process. Uses (?s) DOTALL so content can span newlines.
# The pattern is parameterized by the turn nonce at call time.
def _make_artifact_pattern(turn_nonce: str) -> re.Pattern:
    """Return a compiled regex for artifact blocks with the given nonce."""
    escaped = re.escape(turn_nonce)
    return re.compile(
        r"===ARTIFACT-" + escaped + r":([A-Za-z0-9_]+)===\n(.*?)\n===END===",
        re.DOTALL,
    )


def extract_artifacts(
    worker_text: str,
    artifact_contract: list[dict],
    turn_nonce: str,
) -> tuple[dict[str, str], list[str]]:
    """Extract fenced artifact blocks from worker output.

    Parameters
    ----------
    worker_text:
        The full text of the worker's response.
    artifact_contract:
        The declared artifacts for this turn (list of ArtifactSpec dicts).
    turn_nonce:
        The per-turn nonce that was embedded in the worker's prompt. Only
        fences that contain this exact nonce are extracted; any fence with a
        different nonce is ignored (anti-spoofing).

    Returns
    -------
    (artifacts, missing_required):
        ``artifacts`` is a dict mapping artifact name → content string.
        ``missing_required`` is a list of required artifact names that were
        absent from the worker's response.
    """
    pattern = _make_artifact_pattern(turn_nonce)
    artifacts: dict[str, str] = {}
    for match in pattern.finditer(worker_text):
        name = match.group(1)
        content = match.group(2)
        artifacts[name] = content

    missing_required: list[str] = []
    for spec in artifact_contract:
        name = spec["name"]
        if name not in artifacts and spec.get("required", True):
            missing_required.append(name)

    return artifacts, missing_required
