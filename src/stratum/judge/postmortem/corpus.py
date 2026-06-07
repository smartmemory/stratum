"""STRAT-LEARN-INLINE — inline-candidate sidecar writer.

The transcript-mined postmortem corpus (``candidates.jsonl``, written by
``cli.cmd_extract``) is a strict, transcript-shaped schema whose readers
dereference fields like ``request_text`` / ``claim_kind`` / ``work_tool_uses``
directly, and whose ``label`` field is the replay ground-truth contract.
Inline harvest candidates are NOT transcript spans, so they must never be
written into that file.

This module writes them to a separate sidecar
(``.stratum/postmortem/inline_candidates.jsonl``) with its own schema
(``_schema_version="inline-1.0"``), append-only, idempotent on a
turn-scoped ``candidate_id``, and ``fcntl.flock``-guarded so concurrent MCP
flows can't lose or duplicate rows. A later curator/``--all`` pass may promote
reviewed entries into the canonical corpus — the inline edge never does.
"""

from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import TYPE_CHECKING, Sequence

if TYPE_CHECKING:
    from ..inline_learn import PatchCandidate

INLINE_SCHEMA_VERSION = "inline-1.0"


def inline_sidecar_path(workspace_root: Path | str) -> Path:
    """Canonical inline-sidecar location for a workspace."""
    return Path(workspace_root) / ".stratum" / "postmortem" / "inline_candidates.jsonl"


def _candidate_id(flow_id: str, step_id: str, predicate_id: str, turn: int) -> str:
    return f"inline:{flow_id}:{step_id}:{predicate_id}:{turn}"


def _existing_ids(text: str) -> set[str]:
    ids: set[str] = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ids.add(json.loads(line)["candidate_id"])
        except (json.JSONDecodeError, KeyError, TypeError):
            continue  # tolerate a torn/foreign line; never crash the harvester
    return ids


def append_inline_candidates(
    sidecar_path: Path | str,
    candidates: Sequence["PatchCandidate"],
    *,
    flow_id: str,
    step_id: str,
    turn: int,
    project: str,
) -> int:
    """Append inline candidates to the sidecar, flock-guarded and idempotent
    on ``candidate_id`` (turn-scoped). Returns the number of rows written
    (skips ids already present). A no-op for an empty ``candidates``."""
    if not candidates:
        return 0
    path = Path(sidecar_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # Open r+ (create if absent) so the read and the append share one locked fd.
    with open(path, "a+", encoding="utf-8") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        try:
            fh.seek(0)
            seen = _existing_ids(fh.read())
            written = 0
            fh.seek(0, 2)  # end — append
            for cand in candidates:
                cid = _candidate_id(flow_id, step_id, cand.predicate_id, turn)
                if cid in seen:
                    continue
                seen.add(cid)
                record = {
                    "candidate_id": cid,
                    "origin": "inline",
                    "_schema_version": INLINE_SCHEMA_VERSION,
                    "flow_id": flow_id,
                    "step_id": step_id,
                    "turn": turn,
                    "project": project,
                    "fix_target": cand.fix_target,
                    "classifier_confidence": cand.confidence,
                    "source_finding": cand.source_finding,
                    "predicate_id": cand.predicate_id,
                    "predicate_type": cand.predicate_type,
                    "inline_patch": cand.to_dict(),
                }
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1
            fh.flush()
            return written
        finally:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
