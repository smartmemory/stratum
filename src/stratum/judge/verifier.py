"""T2 — Claude-only, tool-using verifier with mandatory evidence citation.

The verifier reads the staged turn tree as its filesystem (the caller pins
``cwd=staging_root`` so :class:`Read`/:class:`Grep`/:class:`Glob` see exactly
the snapshotted evidence and nothing else) and emits structured JSON with a
verdict, confidence, and citations.

Defence stack:

  * Dispatch — ``allowed_tools=["Read", "Grep", "Glob"]`` (read-only) and
    ``disallowed_tools=["Edit", "Write", "NotebookEdit", "Task", "Bash"]``
    so the verifier can't modify state or shell out.
  * Citation — :func:`_validate_citations` rejects any source that fails the
    canonical regex, escapes the staging root via path traversal, or names
    a file that doesn't exist in the snapshot.
  * Prompt — :data:`T2_SYSTEM_PROMPT` repeats the constraints in natural
    language so the model treats them as part of the task.

Honest scope: this is citation-limited, not read-isolated. Tool-event
capture / read-only sandboxing is v2 work (design Decision 6).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .errors import CitationFormatError
from .result import Evidence, Predicate, TierRecord

# Canonical citation regex — single source of truth, mirrored in
# compose/contracts/judge-result.json (evidence.source.pattern).
CITATION_RE = re.compile(r"^(artifacts|modified)/[^:]+:[0-9]+$")

T2_ALLOWED_TOOLS = ["Read", "Grep", "Glob"]
T2_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit", "Task", "Bash"]
T2_DEFAULT_MODEL = "claude-sonnet-4-6"  # v1 Claude-only; Codex T2 deferred.

T2_SYSTEM_PROMPT = """\
You are a verifier. You read evidence already produced by a worker and
decide whether each predicate is met by that evidence. You do not run
commands. You do not modify files. You cite every claim with a path
under artifacts/ or modified/ in this exact format: <bucket>/<path>:<line>.

For each predicate you receive, return JSON:
{
  "predicate_id": "<id>",
  "verdict": "met" | "not_met" | "ambiguous",
  "confidence": <integer 1-10>,
  "reason": "<one or two sentences>",
  "evidence": [
    {"source": "artifacts/pytest_output.txt:142", "quote": "12 passed", "tier": "T2"}
  ]
}
"""


async def evaluate_t2(
    predicate: Predicate,
    staging_root: Path,
    stratum_agent_run,
    ctx,
) -> tuple[TierRecord, list[Evidence]]:
    """Dispatch a Claude verifier against the staged turn tree.

    ``stratum_agent_run`` is the function-ref injected by the MCP handler
    (blueprint §11 option b — no refactor needed). It is awaited with the
    full constraint set; the returned text is parsed as JSON and validated.
    """
    prompt = _build_t2_prompt(predicate, staging_root)
    response = await stratum_agent_run(
        prompt=prompt,
        ctx=ctx,
        type="claude",
        model_id=T2_DEFAULT_MODEL,
        allowed_tools=T2_ALLOWED_TOOLS,
        disallowed_tools=T2_DISALLOWED_TOOLS,
        cwd=str(staging_root),
    )

    # stratum_agent_run returns {text: str, result?: dict, parseError?: str}
    # — extract the text field for JSON parsing. Plain-string returns are
    # still tolerated for backwards-compat with hand-rolled test mocks.
    if isinstance(response, dict):
        response_text = response.get("text", "")
    else:
        response_text = response
    parsed = _parse_t2_json(response_text)
    evidence = [Evidence(**e) for e in parsed.get("evidence", [])]
    _validate_citations(evidence, staging_root)

    return (
        TierRecord(
            tier="T2",
            verdict=parsed["verdict"],
            confidence=int(parsed["confidence"]),
            reason=parsed.get("reason", ""),
        ),
        evidence,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_t2_prompt(predicate: Predicate, staging_root: Path) -> str:
    return (
        f"{T2_SYSTEM_PROMPT}\n"
        f"You are operating against the staging tree at {staging_root}.\n"
        f"Predicate id: {predicate.id}\n"
        f"Predicate type: {predicate.type}\n"
        f"Predicate statement: {predicate.statement}\n"
        f"Applied gate (confidence floor for 'met'): {predicate.applied_gate}\n"
    )


def _parse_t2_json(response_text: str) -> dict:
    """Parse the verifier's reply. Strips ``` fences if present; the model
    sometimes wraps JSON for readability."""
    text = response_text.strip()
    if text.startswith("```"):
        # Drop the opening fence (optionally with language tag) and the
        # trailing fence.
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # If there's extra prose around a JSON block, locate the outermost {...}.
    if not text.startswith("{"):
        first = text.find("{")
        last = text.rfind("}")
        if first != -1 and last > first:
            text = text[first : last + 1]
    return json.loads(text)


def _validate_citations(evidence: list[Evidence], staging_root: Path) -> None:
    """Reject any citation whose source string fails the canonical shape,
    escapes the staging root, or names a non-existent file in the snapshot.
    """
    root_resolved = staging_root.resolve()
    for e in evidence:
        if not CITATION_RE.match(e.source):
            raise CitationFormatError(f"bad citation format: {e.source!r}")
        path_part, _line = e.source.rsplit(":", 1)
        bucket = path_part.split("/", 1)[0]   # "artifacts" or "modified" per regex
        bucket_root = (staging_root / bucket).resolve()
        full = (staging_root / path_part).resolve()
        # The resolved path must remain within the declared bucket subdir.
        # `..` segments are allowed by the regex but cannot escape the bucket.
        try:
            full.relative_to(bucket_root)
        except ValueError as exc:
            raise CitationFormatError(
                f"citation escapes staging bucket: {e.source!r}"
            ) from exc
        if not full.exists():
            raise CitationFormatError(
                f"citation path missing in staging tree: {e.source!r}"
            )
