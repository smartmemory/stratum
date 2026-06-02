"""Guarded-transition orchestration (S4).

Ties the store (S1), checksum (S2), and trusted-evidence evaluator (S3) together,
plus the LLM-tier verifier (``run_judge``, consumed as-is). Public surface:
``register_guard``, ``guard_transition``, ``guard_override``, ``guard_migrate``,
``guard_history``.

Concurrency discipline (blueprint S4 / Codex finding-5): the cheap structural
checks run under the per-resource lock; the potentially slow predicate evaluation
(subprocess / ``run_judge``) runs OUTSIDE the lock; the commit re-acquires the lock
and re-validates ``current_state == from_state`` (optimistic concurrency) before the
durable ledger append, which is the atomic commit point.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Optional

from ..result_cache import canonical_json
from . import evidence as ev
from . import store
from .errors import (
    CommandExecutionDisabled,
    EvidenceParseError,
    GuardAlreadyRegistered,
    GuardNotFound,
    GuardTampered,
    IdempotencyConflict,
    IllegalEdge,
    InvalidStateName,
    InvalidWorkspaceRoot,
    OverrideUnavailable,
    ParanoidEdgeNeedsTrustedEvidence,
    StaleFromState,
)
from .fingerprint import guard_checksum
from .store import GuardRegistry, LedgerEntry

# A predicate's `type` decides its evaluation path:
#   "deterministic" -> server-side trusted-evidence (evidence.py), MUST parse as a
#                       trusted builtin (fail-closed; a typo is rejected at registration).
#   "verified"/"judged" -> LLM-tier, routed through run_judge at the edge's stakes.
_TRUSTED_TYPE = "deterministic"
_LLM_TYPES = {"verified", "judged"}


def _ptype(p: dict[str, Any]) -> str:
    return p.get("type", _TRUSTED_TYPE)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _edge_key(from_state: str, to_state: str) -> str:
    return f"{from_state}->{to_state}"


def _payload_digest(
    from_state: str,
    to_state: str,
    artifacts: dict[str, str],
    modified_files: list[str],
    resolved_by: str,
) -> str:
    canonical = canonical_json(
        {
            "from_state": from_state,
            "to_state": to_state,
            "artifacts": artifacts,
            "modified_files": sorted(modified_files),
            "resolved_by": resolved_by,
        }
    )
    import hashlib

    return hashlib.sha256((canonical or "").encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Verdict synthesis (uniform JudgeResult shape — Codex finding-6)
# --------------------------------------------------------------------------- #


def _evidence_to_verdict_dict(
    evidence: "ev.EvidenceResult", stakes: str, summary: str
) -> dict[str, Any]:
    """Build a JudgeResult-shaped dict from server-side evidence only.

    Imported lazily so the guard package does not hard-require the judge lib at
    import time (only when a verdict is produced).
    """
    from stratum.judge.result import JudgeResult, PredicateResult

    preds = [
        PredicateResult(
            id=str(p.get("id") or f"e{i}"),
            type="deterministic",
            statement=p.get("statement", ""),
            verdict="met" if p.get("met") else "not_met",
            confidence=10,
            applied_gate=0,
            evidence=[],
            tier_history=[],
        )
        for i, p in enumerate(evidence.per_predicate)
    ]
    jr = JudgeResult(
        clean=evidence.met,
        summary=summary,
        findings=[],
        meta={"agent_type": "guard", "source": "evidence", "guard_evidence": evidence.per_predicate},
        met=evidence.met,
        stakes=stakes,
        predicates=preds,
    )
    return jr.to_dict()


def _merge_verdict(
    evidence: "ev.EvidenceResult",
    judge_result,
    stakes: str,
) -> tuple[bool, dict[str, Any]]:
    """Combine server-side evidence with an LLM-tier JudgeResult. Returns
    (combined_met, verdict_dict). met = evidence.met AND judge.met."""
    from stratum.judge.result import JudgeResult, PredicateResult

    combined = evidence.met and judge_result.met
    ev_preds = [
        PredicateResult(
            id=str(p.get("id") or f"e{i}"),
            type="deterministic",
            statement=p.get("statement", ""),
            verdict="met" if p.get("met") else "not_met",
            confidence=10,
            applied_gate=0,
            evidence=[],
            tier_history=[],
        )
        for i, p in enumerate(evidence.per_predicate)
    ]
    merged = JudgeResult(
        clean=combined,
        summary=judge_result.summary or "guard transition verdict",
        findings=list(judge_result.findings),
        meta={**dict(judge_result.meta), "agent_type": "guard", "guard_evidence": evidence.per_predicate},
        met=combined,
        stakes=stakes,
        predicates=ev_preds + list(judge_result.predicates),
    )
    return combined, merged.to_dict()


# --------------------------------------------------------------------------- #
# Registration
# --------------------------------------------------------------------------- #


def _all_edge_predicates(edge_predicates: dict[str, list[dict[str, Any]]]):
    for edge, preds in edge_predicates.items():
        for p in preds:
            yield edge, p


def _validate_policy(
    graph: dict[str, list[str]],
    edge_predicates: dict[str, list[dict[str, Any]]],
    initial: str,
    terminal: list[str],
    stakes: dict[str, str],
    workspace_root: Optional[str],
) -> None:
    # State-name charset (Codex finding-F3 support).
    names = set(graph.keys()) | set(terminal) | {initial}
    for targets in graph.values():
        names.update(targets)
    for n in names:
        if not store.is_valid_state_name(n):
            raise InvalidStateName(f"invalid state name {n!r} (allowed: [A-Za-z0-9_.-])")
    if initial not in (set(graph.keys()) | set(terminal)):
        raise InvalidStateName(f"initial state {initial!r} is not a node in the graph")

    # Validate every predicate by type (fail-closed — Codex finding-4).
    needs_workspace = False
    uses_command = False
    for _edge, p in _all_edge_predicates(edge_predicates):
        ptype = _ptype(p)
        stmt = p.get("statement", "")
        if ptype in _LLM_TYPES:
            continue  # LLM-tier — free-text, verified via run_judge at eval time
        if ptype != _TRUSTED_TYPE:
            raise EvidenceParseError(
                f"unknown predicate type {ptype!r} (expected deterministic|verified|judged)"
            )
        # deterministic == trusted-evidence: MUST parse as a known trusted builtin,
        # else a typo (e.g. server_file_exist) would silently fall through to the
        # judge path. parse_predicate_statement raises EvidenceParseError.
        name, _ = ev.parse_predicate_statement(stmt)
        if name == "command_exit_zero":
            uses_command = True
        if name in ("server_file_exists", "git_commit_exists", "command_exit_zero"):
            needs_workspace = True

    if uses_command and not ev.commands_allowed():
        raise CommandExecutionDisabled(
            "guard declares command_exit_zero predicates; set STRATUM_GUARD_ALLOW_COMMANDS=1 to register"
        )

    if needs_workspace:
        if not workspace_root:
            raise InvalidWorkspaceRoot(
                "guard declares file/git/command evidence but no workspace_root given"
            )
    if workspace_root:
        wr = Path(workspace_root)
        if not wr.is_absolute() or not wr.is_dir():
            raise InvalidWorkspaceRoot(
                f"workspace_root must be an existing absolute directory: {workspace_root!r}"
            )

    # Paranoid edges require >=1 trusted-evidence (deterministic) predicate (design rule).
    for edge, preds in edge_predicates.items():
        if stakes.get(edge) == "paranoid":
            if not any(_ptype(p) == _TRUSTED_TYPE for p in preds):
                raise ParanoidEdgeNeedsTrustedEvidence(
                    f"paranoid edge {edge!r} has no trusted-evidence predicate"
                )


async def register_guard(
    resource_id: str,
    graph: dict[str, list[str]],
    edge_predicates: dict[str, list[dict[str, Any]]],
    initial: str,
    terminal: Optional[list[str]] = None,
    stakes: Optional[dict[str, str]] = None,
    workspace_root: Optional[str] = None,
) -> dict[str, Any]:
    terminal = terminal or []
    stakes = stakes or {}
    edge_predicates = edge_predicates or {}

    # Validation + checksum are pure — do them before taking the lock.
    _validate_policy(graph, edge_predicates, initial, terminal, stakes, workspace_root)
    checksum = guard_checksum(graph, edge_predicates, terminal, stakes)

    # The existence-check + persist must be atomic, else two concurrent first-time
    # registrations both observe "not found" and last-writer-wins (Codex finding-3).
    async with store.resource_lock(resource_id):
        existing = store._load_registry_raw(resource_id)
        if existing is not None:
            if existing.checksum == checksum:
                return {"guard_id": resource_id, "checksum": checksum, "status": "exists"}
            raise GuardAlreadyRegistered(
                f"guard {resource_id!r} already registered with a different policy; use migrate"
            )
        reg = GuardRegistry(
            resource_id=resource_id,
            graph=graph,
            edge_predicates=edge_predicates,
            initial=initial,
            terminal=terminal,
            stakes=stakes,
            checksum=checksum,
            graph_version=1,
            workspace_root=workspace_root,
            current_state=initial,
        )
        store.persist_registry(reg)
    return {"guard_id": resource_id, "checksum": checksum, "status": "registered"}


# --------------------------------------------------------------------------- #
# Transition
# --------------------------------------------------------------------------- #


def _maybe_replay(
    reg: GuardRegistry, idempotency_key: Optional[str], payload_digest: str
) -> Optional[dict[str, Any]]:
    """If this idempotency_key was already used, return the replay dict (or raise
    IdempotencyConflict on a payload mismatch). Returns None if the key is unseen.
    Caller MUST hold the resource lock."""
    if not idempotency_key:
        return None
    prior = store.find_by_idempotency_key(reg.resource_id, idempotency_key)
    if prior is None:
        return None
    if prior.payload_digest != payload_digest:
        raise IdempotencyConflict(
            f"idempotency_key {idempotency_key!r} reused with a different payload"
        )
    verdict = prior.verdict
    if verdict is None:  # legacy entry without a stored verdict — synthesize a summary
        verdict = _evidence_to_verdict_dict(
            ev.EvidenceResult(met=prior.outcome == "applied", per_predicate=[]),
            reg.stakes.get(_edge_key(prior.from_state, prior.to_state), "default"),
            "replayed idempotent transition",
        )
    return {
        "status": "replayed",
        "verdict": verdict,
        "ledger_ref": prior.entry_digest,
        "current_state": reg.current_state,
    }


async def guard_transition(
    resource_id: str,
    from_state: str,
    to_state: str,
    artifacts: Optional[dict[str, str]] = None,
    modified_files: Optional[list[str]] = None,
    idempotency_key: Optional[str] = None,
    resolved_by: str = "agent",
    stratum_agent_run=None,
    ctx=None,
) -> dict[str, Any]:
    artifacts = artifacts or {}
    modified_files = modified_files or []
    payload_digest = _payload_digest(
        from_state, to_state, artifacts, modified_files, resolved_by
    )

    # ----- Phase 1: structural checks under the lock --------------------- #
    async with store.resource_lock(resource_id):
        reg = store.load_registry(resource_id)  # may raise LedgerCorrupt
        if reg is None:
            raise GuardNotFound(f"no guard registered for {resource_id!r}")
        if guard_checksum(reg.graph, reg.edge_predicates, reg.terminal, reg.stakes) != reg.checksum:
            raise GuardTampered(f"guard {resource_id!r} policy checksum mismatch")

        replay = _maybe_replay(reg, idempotency_key, payload_digest)
        if replay is not None:
            return replay

        if from_state != reg.current_state:
            raise StaleFromState(
                f"from_state {from_state!r} != current_state {reg.current_state!r}"
            )
        if to_state not in reg.graph.get(from_state, []):
            raise IllegalEdge(f"{_edge_key(from_state, to_state)} is not a legal edge")

        edge = _edge_key(from_state, to_state)
        edge_preds = list(reg.edge_predicates.get(edge, []))
        stakes = reg.stakes.get(edge, "default")
        workspace_root = reg.workspace_root
        ledger_entries = store.read_ledger(resource_id)

    # ----- Phase 2: predicate evaluation OUTSIDE the lock ---------------- #
    # Split by declared type (validated fail-closed at registration).
    trusted = [p for p in edge_preds if _ptype(p) == _TRUSTED_TYPE]
    llm = [p for p in edge_preds if _ptype(p) in _LLM_TYPES]

    evidence = await ev.evaluate_evidence(trusted, workspace_root, ledger_entries)

    if llm:
        if stratum_agent_run is None:
            # No verifier wired but the edge needs LLM judgment — cannot verify.
            verdict = _evidence_to_verdict_dict(
                ev.EvidenceResult(met=False, per_predicate=evidence.per_predicate),
                stakes,
                "LLM-tier predicates present but no verifier available",
            )
            combined_met = False
        else:
            from stratum.judge.kernel import run_judge
            from stratum.judge.result import Predicate

            import hashlib

            rid_hash = hashlib.sha256(resource_id.encode()).hexdigest()[:16]
            edge_hash = hashlib.sha256(
                f"{edge}@{idempotency_key or ''}".encode()
            ).hexdigest()[:16]
            judge_result = await run_judge(
                flow_id=f"guard-{rid_hash}",
                step_id=f"e-{edge_hash}",
                predicates=[Predicate(**p) for p in llm],
                artifacts=artifacts,
                modified_files=modified_files,
                stakes=stakes,
                budget=None,
                workspace_root=Path(workspace_root) if workspace_root else Path.cwd(),
                stratum_agent_run=stratum_agent_run,
                ctx=ctx,
            )
            combined_met, verdict = _merge_verdict(evidence, judge_result, stakes)
    else:
        combined_met = evidence.met
        verdict = _evidence_to_verdict_dict(evidence, stakes, "guard transition verdict")

    # ----- Phase 3: optimistic commit under the lock --------------------- #
    async with store.resource_lock(resource_id):
        reg = store.load_registry(resource_id)
        if reg is None:
            raise GuardNotFound(f"no guard registered for {resource_id!r}")
        # Re-check idempotency: a concurrent twin sharing the key may have
        # committed while we evaluated without the lock (Codex finding-1).
        replay = _maybe_replay(reg, idempotency_key, payload_digest)
        if replay is not None:
            return replay
        if reg.current_state != from_state:
            raise StaleFromState(
                f"current_state advanced to {reg.current_state!r} during evaluation"
            )
        outcome = "applied" if combined_met else "refused"
        entry = LedgerEntry(
            ts_ms=_now_ms(),
            from_state=from_state,
            # Record the TRUE attempted target even when refused — the ledger is
            # the audit trail; current_state only advances on applied/deviation.
            to_state=to_state,
            outcome=outcome,
            kind="transition",
            resolved_by=resolved_by,
            idempotency_key=idempotency_key,
            payload_digest=payload_digest,
            verdict=verdict,  # stored so a future replay returns the original decision
        )
        ledger_ref = store.append_ledger(resource_id, entry)
        if combined_met:
            reg.current_state = to_state
            store.persist_registry(reg)
        current_state = reg.current_state

    return {
        "status": outcome,
        "verdict": verdict,
        "ledger_ref": ledger_ref,
        "current_state": current_state,
    }


# --------------------------------------------------------------------------- #
# Override / Migrate / History
# --------------------------------------------------------------------------- #


def _check_override_token(token: str) -> None:
    expected = os.environ.get("STRATUM_GUARD_OVERRIDE_TOKEN")
    if not expected:
        raise OverrideUnavailable(
            "override unavailable: STRATUM_GUARD_OVERRIDE_TOKEN not set in server env"
        )
    if token != expected:
        raise OverrideUnavailable("override token mismatch")


async def guard_override(
    resource_id: str,
    from_state: str,
    to_state: str,
    override_token: str,
    rationale: str,
    resolved_by: str = "human",
) -> dict[str, Any]:
    _check_override_token(override_token)
    if resolved_by != "human":
        raise OverrideUnavailable("override requires resolved_by='human'")
    if not rationale or not rationale.strip():
        raise OverrideUnavailable("override requires a non-empty rationale")

    async with store.resource_lock(resource_id):
        reg = store.load_registry(resource_id)
        if reg is None:
            raise GuardNotFound(f"no guard registered for {resource_id!r}")
        if from_state != reg.current_state:
            raise StaleFromState(
                f"from_state {from_state!r} != current_state {reg.current_state!r}"
            )
        if to_state not in reg.graph.get(from_state, []):
            raise IllegalEdge(
                f"{_edge_key(from_state, to_state)} is not a legal edge (override bypasses predicates, not the graph)"
            )
        entry = LedgerEntry(
            ts_ms=_now_ms(),
            from_state=from_state,
            to_state=to_state,
            outcome="deviation",
            kind="deviation",
            resolved_by=resolved_by,
            payload_digest=None,
            idempotency_key=None,
            rationale=rationale,
        )
        ledger_ref = store.append_ledger(resource_id, entry)
        reg.current_state = to_state
        store.persist_registry(reg)
        current_state = reg.current_state

    return {
        "status": "deviation",
        "ledger_ref": ledger_ref,
        "current_state": current_state,
        "rationale": rationale,
    }


async def guard_migrate(
    resource_id: str,
    new_graph: dict[str, list[str]],
    new_edge_predicates: dict[str, list[dict[str, Any]]],
    override_token: str,
    rationale: str,
    new_terminal: Optional[list[str]] = None,
    new_stakes: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    _check_override_token(override_token)
    if not rationale or not rationale.strip():
        raise OverrideUnavailable("migrate requires a non-empty rationale")
    new_terminal = new_terminal or []
    new_stakes = new_stakes or {}

    async with store.resource_lock(resource_id):
        reg = store.load_registry(resource_id)
        if reg is None:
            raise GuardNotFound(f"no guard registered for {resource_id!r}")
        _validate_policy(
            new_graph,
            new_edge_predicates,
            reg.initial,
            new_terminal,
            new_stakes,
            reg.workspace_root,
        )
        # The in-flight current_state must remain a node in the new graph.
        if reg.current_state not in (set(new_graph.keys()) | set(new_terminal)):
            raise InvalidStateName(
                f"current_state {reg.current_state!r} is not a node in the new graph"
            )
        new_checksum = guard_checksum(
            new_graph, new_edge_predicates, new_terminal, new_stakes
        )
        new_version = reg.graph_version + 1
        entry = LedgerEntry(
            ts_ms=_now_ms(),
            from_state=reg.current_state,
            to_state=reg.current_state,
            outcome="graph_version",
            kind="graph_version",
            resolved_by="human",
            payload_digest=None,
            idempotency_key=None,
            rationale=rationale,
        )
        ledger_ref = store.append_ledger(resource_id, entry)
        reg.graph = new_graph
        reg.edge_predicates = new_edge_predicates
        reg.terminal = new_terminal
        reg.stakes = new_stakes
        reg.checksum = new_checksum
        reg.graph_version = new_version
        store.persist_registry(reg)

    return {
        "status": "migrated",
        "checksum": new_checksum,
        "graph_version": new_version,
        "ledger_ref": ledger_ref,
        "rationale": rationale,
    }


def guard_history(resource_id: str) -> dict[str, Any]:
    reg = store.load_registry(resource_id)
    if reg is None:
        raise GuardNotFound(f"no guard registered for {resource_id!r}")
    entries = store.read_ledger(resource_id)
    return {
        "resource_id": resource_id,
        "current_state": reg.current_state,
        "graph_version": reg.graph_version,
        "ledger": [e.to_dict() for e in entries],
    }
