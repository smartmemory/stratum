"""STRAT-PAR-STREAM event types.

`ConnectorEvent` is the connector-local event yielded by `stream_events()`
on each agent connector. `BuildStreamEvent` is the wire envelope minted by
`parallel_exec._run_one` and serialized into the MCP progress notification's
`message` field per CONTRACT v0.2.6.

Schema history:
  v0.2.5 — initial parallel-stream contract
  v0.2.6 — STRAT-PAR-STREAM-LEGACY-CLOSE: closes 6 legacy metadata blocks
            (capability_profile, capability_violation, step_usage,
            gate_tier_result, health_score, build_end) with additionalProperties:false.
            Adds optional top-level reply_required: boolean (Option A,
            STRAT-PAR-STREAM-CONSUMER-VALIDATE).
            Contract: contracts/build-stream-event.v0.2.6.schema.json

`INTERNAL_RESULT_KIND` is a private kind used by `stream_events()` to hand
the final agent text back to the executor without polluting the wire schema.
The executor must NOT forward `_result` events to `ctx.report_progress`.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

INTERNAL_RESULT_KIND = "_result"


def now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class ConnectorEvent:
    kind: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class BuildStreamEvent:
    flow_id: str
    step_id: str
    seq: int
    ts: str
    kind: str
    metadata: dict[str, Any]
    task_id: Optional[str] = None
    # STRAT-PAR-STREAM-LEGACY-CLOSE: bumped to v0.2.6
    schema_version: str = "0.2.6"
    # STRAT-PAR-STREAM-CONSUMER-VALIDATE Option A: reply_required reserved slot.
    # False for all current live kinds; true for future gate/permission/question kinds.
    reply_required: bool = False

    def to_json(self) -> str:
        d = asdict(self)
        if d.get("task_id") is None:
            d.pop("task_id", None)
        return json.dumps(d)


class TaskSeqCounter:
    """Per-(flow_id, step_id, task_id) monotonic counter. Single-threaded."""

    def __init__(self) -> None:
        self._counts: dict[tuple[str, str, Optional[str]], int] = {}

    def next(
        self, flow_id: str, step_id: str, task_id: Optional[str]
    ) -> int:
        key = (flow_id, step_id, task_id)
        n = self._counts.get(key, 0)
        self._counts[key] = n + 1
        return n
