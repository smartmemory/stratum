"""STRAT-GOAL v1: GoalState persistence.

Provides:
- GoalState dataclass (no sticky status field — derived from FlowState per design.md Decision 5)
- TurnRecord dataclass
- DecisionGateRecord dataclass
- ArtifactSpec dataclass
- persist_goal_state(state, *, root=None) — write-tmp + os.replace (atomic on POSIX)
- restore_goal_state(goal_id, *, root=None, expected_predicates_hash=None, expected_mode=None)
- compute_predicates_hash(predicates) — sha256 of canonical sorted (id, type, statement, applied_gate) tuples

Persistence root: ~/.stratum/goal/<goal_id>/state.json
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from stratum.goal.errors import GoalImmutabilityError

_GOAL_ROOT_DEFAULT = Path.home() / ".stratum" / "goal"


def _goal_dir(goal_id: str, root: Path | None) -> Path:
    base = root if root is not None else _GOAL_ROOT_DEFAULT
    return base / goal_id


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class ArtifactSpec:
    """Specification for a single artifact the worker must produce."""
    name: str
    required: bool = True
    description: str = ""


@dataclasses.dataclass
class TurnRecord:
    """Record for a single worker→judge turn."""
    turn: int
    agent_correlation_id: str
    duration_ms: int
    worker_text: str
    judge_result_summary: dict[str, Any] = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class DecisionGateRecord:
    """Record for a human decision gate."""
    round: int
    decision: str  # "confirm" | "reject" | "kill" | "pending"
    note: str = ""
    resolved_by: str = "human"
    # Finding 3: stale-detection timestamp (ms since epoch) set when goal enters
    # awaiting_decision; read by _goal_awaiting_since_ms in server.py.
    registered_at_ms: int | None = None
    # Finding 4: human rejection note threaded into the next worker prompt.
    rejection_note: str | None = None
    # Finding 3 (follow-up): final human verdict written by stratum_goal_decide.
    # "approve" | "revise" | "kill" | None (pending)
    outcome: str | None = None
    resolved_at_ms: int | None = None


@dataclasses.dataclass
class GoalState:
    """Mutable loop state for a STRAT-GOAL run.

    IMPORTANT: No ``status`` field. Status is derived from FlowState.current_idx
    on every re-entry (design.md Decision 5). Storing it here would create stale
    sentinel risk on resume.
    """
    goal_id: str
    mode: str  # "shadow" | "advisory" | "autonomous"
    predicates: list[dict[str, Any]]
    predicates_hash: str
    artifact_contract: list[ArtifactSpec] = dataclasses.field(default_factory=list)
    turns: list[TurnRecord] = dataclasses.field(default_factory=list)
    decision_gates: list[DecisionGateRecord] = dataclasses.field(default_factory=list)
    round: int = 0
    cwd: str = ""
    autonomy: dict[str, bool] = dataclasses.field(default_factory=dict)


# ---------------------------------------------------------------------------
# Hash
# ---------------------------------------------------------------------------

def compute_predicates_hash(predicates: list[dict[str, Any]]) -> str:
    """SHA-256 of canonical sorted (id, type, statement, applied_gate) tuples.

    Order-independent: predicates in any order produce the same hash.
    """
    tuples = sorted(
        (
            p.get("id", ""),
            p.get("type", ""),
            p.get("statement", ""),
            str(p.get("applied_gate", "")),
        )
        for p in predicates
    )
    payload = json.dumps(tuples, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _artifact_spec_to_dict(a: ArtifactSpec) -> dict:
    return {"name": a.name, "required": a.required, "description": a.description}


def _artifact_spec_from_dict(d: dict) -> ArtifactSpec:
    return ArtifactSpec(
        name=d["name"],
        required=d.get("required", True),
        description=d.get("description", ""),
    )


def _turn_record_to_dict(t: TurnRecord) -> dict:
    return {
        "turn": t.turn,
        "agent_correlation_id": t.agent_correlation_id,
        "duration_ms": t.duration_ms,
        "worker_text": t.worker_text,
        "judge_result_summary": t.judge_result_summary,
    }


def _turn_record_from_dict(d: dict) -> TurnRecord:
    return TurnRecord(
        turn=d["turn"],
        agent_correlation_id=d["agent_correlation_id"],
        duration_ms=d.get("duration_ms", 0),
        worker_text=d.get("worker_text", ""),
        judge_result_summary=d.get("judge_result_summary", {}),
    )


def _gate_record_to_dict(g: DecisionGateRecord) -> dict:
    d: dict = {
        "round": g.round,
        "decision": g.decision,
        "note": g.note,
        "resolved_by": g.resolved_by,
    }
    if g.registered_at_ms is not None:
        d["registered_at_ms"] = g.registered_at_ms
    if g.rejection_note is not None:
        d["rejection_note"] = g.rejection_note
    if g.outcome is not None:
        d["outcome"] = g.outcome
    if g.resolved_at_ms is not None:
        d["resolved_at_ms"] = g.resolved_at_ms
    return d


def _gate_record_from_dict(d: dict) -> DecisionGateRecord:
    return DecisionGateRecord(
        round=d["round"],
        decision=d["decision"],
        note=d.get("note", ""),
        resolved_by=d.get("resolved_by", "human"),
        registered_at_ms=d.get("registered_at_ms"),
        rejection_note=d.get("rejection_note"),
        outcome=d.get("outcome"),
        resolved_at_ms=d.get("resolved_at_ms"),
    )


def _state_to_dict(state: GoalState) -> dict:
    return {
        "goal_id": state.goal_id,
        "mode": state.mode,
        "predicates": state.predicates,
        "predicates_hash": state.predicates_hash,
        "artifact_contract": [_artifact_spec_to_dict(a) for a in state.artifact_contract],
        "turns": [_turn_record_to_dict(t) for t in state.turns],
        "decision_gates": [_gate_record_to_dict(g) for g in state.decision_gates],
        "round": state.round,
        "cwd": state.cwd,
        "autonomy": state.autonomy,
    }


def _state_from_dict(d: dict) -> GoalState:
    return GoalState(
        goal_id=d["goal_id"],
        mode=d["mode"],
        predicates=d.get("predicates", []),
        predicates_hash=d["predicates_hash"],
        artifact_contract=[_artifact_spec_from_dict(a) for a in d.get("artifact_contract", [])],
        turns=[_turn_record_from_dict(t) for t in d.get("turns", [])],
        decision_gates=[_gate_record_from_dict(g) for g in d.get("decision_gates", [])],
        round=d.get("round", 0),
        cwd=d.get("cwd", ""),
        autonomy=d.get("autonomy", {}),
    )


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def persist_goal_state(state: GoalState, *, root: Path | None = None) -> None:
    """Write GoalState atomically to ~/.stratum/goal/<goal_id>/state.json.

    Uses write-tmp + os.replace for atomicity on POSIX (PRD M16).
    The temp file is created in the same directory as the final file so that
    os.replace is a same-filesystem rename (no copy+unlink fallback).
    """
    goal_dir = _goal_dir(state.goal_id, root)
    goal_dir.mkdir(parents=True, exist_ok=True)

    final_path = goal_dir / "state.json"
    payload = json.dumps(_state_to_dict(state), indent=2)

    # Write to a temp file in the same directory, then atomically replace.
    fd, tmp_path_str = tempfile.mkstemp(dir=str(goal_dir), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(payload)
        os.replace(tmp_path_str, str(final_path))
    except Exception:
        # Best-effort cleanup of the temp file on failure.
        try:
            os.unlink(tmp_path_str)
        except OSError:
            pass
        raise


def restore_goal_state(
    goal_id: str,
    *,
    root: Path | None = None,
    expected_predicates_hash: str | None = None,
    expected_mode: str | None = None,
) -> GoalState:
    """Read GoalState from disk.

    Raises GoalImmutabilityError if the persisted predicates_hash or mode
    doesn't match the expected values (PRD M8, M9).

    Returns the restored GoalState if all checks pass.
    Raises FileNotFoundError if state.json doesn't exist.
    """
    goal_dir = _goal_dir(goal_id, root)
    path = goal_dir / "state.json"

    if not path.exists():
        raise FileNotFoundError(f"No GoalState found for goal_id={goal_id!r} at {path}")

    try:
        payload = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        raise GoalImmutabilityError(
            f"Could not read GoalState for goal_id={goal_id!r}: {exc}"
        ) from exc

    state = _state_from_dict(payload)

    if expected_predicates_hash is not None:
        if state.predicates_hash != expected_predicates_hash:
            raise GoalImmutabilityError(
                f"Predicate hash mismatch for goal_id={goal_id!r}: "
                f"persisted={state.predicates_hash!r}, expected={expected_predicates_hash!r}. "
                "The predicate set cannot change across resumes (PRD M8)."
            )

    if expected_mode is not None:
        if state.mode != expected_mode:
            raise GoalImmutabilityError(
                f"Mode mismatch for goal_id={goal_id!r}: "
                f"persisted={state.mode!r}, expected={expected_mode!r}. "
                "The mode cannot change across resumes (PRD M9)."
            )

    return state
