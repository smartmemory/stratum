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
from .sandbox import read_jail_available

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

# --- T3: cold-read adversary (STRAT-JUDGE v2 slice 1) ----------------------
# Security boundary is REASONING-isolation (this function's signature does not
# accept the T2 TierRecord/Evidence — it cannot leak what it never receives).
# Tool-allowlist + cwd-outside-repo + no-Bash are blast-radius hardening, NOT
# a filesystem read-jail (the connector stack provides none). See design
# "## v2 slice 1" / STRAT-JUDGE-T3-READJAIL.
T3_ALLOWED_TOOLS = ["Read", "Grep", "Glob"]
T3_DISALLOWED_TOOLS = T2_DISALLOWED_TOOLS  # already includes Bash
# STRAT-JUDGE-T3-READJAIL: T3 is now a true cross-model adversary —
# jailed Codex when an OS read-jail is available, else the v1 in-process
# Claude cold-read as the honest probe-time degrade.
T3_DEFAULT_MODEL = "gpt-5.4"  # codex (cross-model) when jailed
T3_FALLBACK_MODEL = T2_DEFAULT_MODEL  # claude cold-read degrade

# Machine tag prefixed onto the T3 TierRecord.reason so the kernel can
# record honest per-predicate provenance without changing the 2-tuple
# return contract (and without re-deriving the lane). Stripped before the
# reason is shown to a human.
_T3_MODE_TAG_RE = re.compile(r"^\[t3:(codex_jailed|codex_jailed_error|claude_cold_fallback)\] ")

T3_SYSTEM_PROMPT = """\
You are an ADVERSARY. A worker has claimed a predicate is met. Your job is
to BREAK that claim: find a concrete counterexample, in the staged evidence,
showing the predicate is NOT met. You have NOT seen the worker's reasoning
or any prior verification — only the predicate and the staged tree. Do not
assume good faith; assume the claim is wrong until the evidence forces
otherwise. Cite every claim with a path under artifacts/ or modified/ in
this exact format: <bucket>/<path>:<line>.

Return JSON:
{
  "predicate_id": "<id>",
  "verdict": "not_met" | "met" | "ambiguous",
  "confidence": <integer 1-10>,
  "reason": "<the counterexample, or why you could not find one>",
  "evidence": [
    {"source": "modified/foo.py:42", "quote": "...", "tier": "T3"}
  ]
}
Reply "not_met" if you found a real counterexample; "met" ONLY if you
genuinely tried and the evidence withstands the attack; "ambiguous" if the
staged evidence is insufficient to attack or defend.
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


# ---------------------------------------------------------------------------
# T3 — cold-read adversary
# ---------------------------------------------------------------------------


def _build_t3_prompt(predicate: Predicate, staging_root: Path) -> str:
    # Mirrors _build_t2_prompt. Deliberately takes NO T2 record/evidence —
    # cold-read is enforced by this signature, not by prompt wording.
    return (
        f"{T3_SYSTEM_PROMPT}\n"
        f"You are operating against the staging tree at {staging_root}.\n"
        f"Predicate id: {predicate.id}\n"
        f"Predicate type: {predicate.type}\n"
        f"Predicate statement: {predicate.statement}\n"
        f"Applied gate (confidence floor for 'met'): {predicate.applied_gate}\n"
    )


def _t3_has_staged_evidence(staging_root: Path) -> bool:
    for bucket in ("artifacts", "modified"):
        d = staging_root / bucket
        if d.is_dir() and any(d.iterdir()):
            return True
    return False


async def evaluate_t3(
    predicate: Predicate,
    staging_root: Path,
    stratum_agent_run,
    ctx,
) -> tuple[TierRecord, list[Evidence]]:
    """Dispatch a cold-read Claude adversary against the staged turn tree.

    Same shape as :func:`evaluate_t2`. The signature intentionally excludes
    any T2 ``TierRecord``/``Evidence`` — reasoning-isolation is the security
    boundary and is enforced structurally here, not by prompt text.
    """
    if not staging_root or not _t3_has_staged_evidence(Path(staging_root)):
        return (
            TierRecord(
                tier="T3",
                verdict="ambiguous",
                confidence=0,
                reason="t3_no_staged_evidence",
            ),
            [],
        )

    prompt = _build_t3_prompt(predicate, staging_root)
    jailed = read_jail_available()
    mode = "codex_jailed" if jailed else "claude_cold_fallback"

    try:
        if jailed:
            # True cross-model adversary, OS read-jailed to the staged
            # turn tree. read_jail is codex-only (claude runs in-process,
            # unjailable). --ephemeral is added by the connector.
            response = await stratum_agent_run(
                prompt=prompt,
                ctx=ctx,
                type="codex",
                model_id=T3_DEFAULT_MODEL,
                cwd=str(staging_root),
                read_jail=str(staging_root),
            )
        else:
            # Probe-time degrade (NOT post-launch): in-process Claude
            # cold-read. Honest label; reasoning-isolation + ordering only.
            response = await stratum_agent_run(
                prompt=prompt,
                ctx=ctx,
                type="claude",
                model_id=T3_FALLBACK_MODEL,
                allowed_tools=T3_ALLOWED_TOOLS,
                disallowed_tools=T3_DISALLOWED_TOOLS,
                cwd=str(staging_root),
            )
        if isinstance(response, dict):
            response_text = response.get("text", "")
        else:
            response_text = response
        parsed = _parse_t2_json(response_text)  # format-generic parser, reused
        evidence = [Evidence(**e) for e in parsed.get("evidence", [])]
        _validate_citations(evidence, staging_root)
    except Exception as exc:  # noqa: BLE001
        # Honest by lane: a jailed-Codex post-launch failure is
        # codex_jailed_error (NEVER silently relabeled to a weaker
        # guarantee). A failure on the Claude fallback path is just a
        # degraded-fallback error — it must NOT claim a jailed launch
        # that never happened. Either way the kernel resolves ambiguous.
        err_tag = "codex_jailed_error" if jailed else "claude_cold_fallback"
        return (
            TierRecord(
                tier="T3",
                verdict="ambiguous",
                confidence=0,
                reason=f"[t3:{err_tag}] {type(exc).__name__}: {exc}",
            ),
            [],
        )

    return (
        TierRecord(
            tier="T3",
            verdict=parsed["verdict"],
            confidence=int(parsed["confidence"]),
            reason=f"[t3:{mode}] " + parsed.get("reason", ""),
        ),
        evidence,
    )
