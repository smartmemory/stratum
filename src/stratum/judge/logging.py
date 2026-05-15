"""Per-turn JSONL audit log.

Each tier verdict on each predicate is appended as one JSON line to
``~/.stratum/judge/<flow_id>/turns.jsonl``. The file is opened in append
mode per call so concurrent writers (resume after crash, multi-process
flows in future) interleave cleanly at the line boundary.

Schema (v1.0):

    {
      "schema": "1.0",
      "flow_id": str,
      "step_id": str,
      "turn": int,
      "ts_ms": int,         # millisecond epoch
      "tier": "T1" | "T2" | ...,
      "predicate_id": str,
      "verdict": "met" | "not_met" | "ambiguous" | "n/a",
      "confidence": int | None,
      ...                   # any extra fields the caller passes via `record`
    }
"""

from __future__ import annotations

import json
import time

from .staging import JUDGE_ROOT


def append_turn_log(
    flow_id: str,
    step_id: str,
    turn: int,
    record: dict,
) -> None:
    """Append one envelope-wrapped record to the per-flow turns.jsonl file."""
    flow_dir = JUDGE_ROOT / flow_id
    flow_dir.mkdir(parents=True, exist_ok=True)
    path = flow_dir / "turns.jsonl"
    envelope = {
        "schema": "1.0",
        "flow_id": flow_id,
        "step_id": step_id,
        "turn": turn,
        "ts_ms": int(time.time() * 1000),
        **record,
    }
    line = json.dumps(envelope)
    with path.open("a") as f:
        f.write(line + "\n")
