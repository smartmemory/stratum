"""STRAT-GOAL v1: Worker→judge orchestrator core loop.

``run_goal(...)`` is the single public entry point. It:

  1. Loads or creates GoalState; enforces predicate/mode/contract immutability.
  2. Builds or restores the synthetic FlowState for gate machinery.
  3. Derives current status from FlowState (no sticky GoalState.status).
  4. Routes to the appropriate mode path:
     - shadow-observed: skips dispatch, judges caller artifacts once.
     - shadow-driven / advisory / autonomous: dispatches worker, judges,
       applies predicate-class autonomy partition, advances synthetic flow.
  5. Returns a GoalResult.

All callables (dispatch_worker, run_judge, stratum_gate_resolve) are injected
— no module-level imports of live callables. Tests stub every boundary.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional

import yaml

from stratum.goal.autonomy import resolve_autonomy
from stratum.goal.errors import GoalImmutabilityError
from stratum.goal.prompts import build_turn_prompt, extract_artifacts, mk_turn_nonce
from stratum.goal.result import GoalResult, PredicateOutcome
from stratum.goal.state import (
    ArtifactSpec,
    DecisionGateRecord,
    GoalState,
    TurnRecord,
    compute_predicates_hash,
    persist_goal_state,
    restore_goal_state,
)
from stratum.goal.worker import WorkerFailureTracker, validate_worker_spec
from stratum.judge.result import BudgetCaps, JudgeResult, Predicate

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Synthetic flow IR
# ---------------------------------------------------------------------------

def _build_synthetic_flow_yaml(goal_id: str, max_rounds: int) -> str:
    """Construct the goal synthetic flow IR as YAML for parse_and_validate.

    Design.md Decision 5: the spec dict is rendered via yaml.safe_dump and
    fed to parse_and_validate (which calls yaml.safe_load internally).
    """
    spec_dict = {
        "version": "0.2",
        # Declare a minimal output contract so the semantic validator is satisfied.
        # Synthetic flows don't actually use this contract at runtime — it's a
        # parse-time requirement for non-gate compute functions (spec.py:1320).
        "contracts": {
            "GoalTurnOutput": {"status": {"type": "string"}},
        },
        "functions": {
            "goal_turn": {
                "mode": "compute",
                "intent": "Drive worker-to-judge cycle for one goal turn",
                "input": {"goal_id": {"type": "string"}},
                "output": "GoalTurnOutput",
            },
            "goal_decision": {
                "mode": "gate",
            },
        },
        "flows": {
            "goal": {
                "input": {"goal_id": {"type": "string"}},
                "max_rounds": max(1, max_rounds),
                "steps": [
                    {
                        "id": "goal_turn",
                        "function": "goal_turn",
                    },
                    {
                        "id": "goal_decision",
                        "function": "goal_decision",
                        "depends_on": ["goal_turn"],
                        "on_approve": None,
                        "on_revise": "goal_turn",
                        "on_kill": None,
                    },
                ],
            }
        },
    }
    return yaml.safe_dump(spec_dict, sort_keys=False)


def _make_flow_state(goal_id: str, max_rounds: int, *, flow_state_root: Path | None):
    """Build a new FlowState for a synthetic goal flow and persist it.

    Returns the FlowState.
    """
    from stratum_mcp.executor import FlowState, _topological_sort, persist_flow, compute_spec_checksum
    from stratum_mcp.spec import parse_and_validate

    raw_yaml = _build_synthetic_flow_yaml(goal_id, max_rounds)
    spec = parse_and_validate(raw_yaml)
    flow_def = spec.flows["goal"]
    ordered = _topological_sort(flow_def)
    checksum = compute_spec_checksum(flow_def, spec)

    state = FlowState(
        flow_id=goal_id,
        flow_name="goal",
        raw_spec=raw_yaml,
        spec=spec,
        ordered_steps=ordered,
        inputs={"goal_id": goal_id},
        step_outputs={},
        records=[],
        attempts={},
        dispatched_at={},
        flow_start=time.monotonic(),
        current_idx=0,
        synthetic=True,
        spec_checksum=checksum,
    )

    if flow_state_root is not None:
        import os
        flow_state_root.mkdir(parents=True, exist_ok=True)
        payload = _flow_state_to_dict(state)
        path = flow_state_root / f"{goal_id}.json"
        path.write_text(json.dumps(payload, indent=2))
    else:
        persist_flow(state)

    return state


def _flow_state_to_dict(state) -> dict:
    """Serialize FlowState to a persistence dict."""
    import dataclasses as dc
    return {
        "flow_id": state.flow_id,
        "flow_name": state.flow_name,
        "raw_spec": state.raw_spec,
        "inputs": state.inputs,
        "step_outputs": state.step_outputs,
        "records": [dc.asdict(r) for r in state.records],
        "attempts": state.attempts,
        "current_idx": state.current_idx,
        "checkpoints": state.checkpoints,
        "round": state.round,
        "rounds": state.rounds,
        "round_start_step_id": state.round_start_step_id,
        "terminal_status": state.terminal_status,
        "iterations": state.iterations,
        "archived_iterations": state.archived_iterations,
        "active_iteration": state.active_iteration,
        "iteration_outcome": state.iteration_outcome,
        "iteration_best": state.iteration_best,
        "parent_flow_id": state.parent_flow_id,
        "parent_step_id": state.parent_step_id,
        "active_child_flow_id": state.active_child_flow_id,
        "child_audits": state.child_audits,
        "spec_checksum": state.spec_checksum,
        "parallel_tasks": {},
        "cwd": state.cwd,
        "judge_history": state.judge_history,
        "judge_outcome": state.judge_outcome,
        "synthetic": state.synthetic,
    }


def _restore_or_create_flow_state(goal_id: str, max_rounds: int, *, flow_state_root: Path | None):
    """Restore existing FlowState or create a fresh one.

    Lookup order:
      1. Custom flow_state_root (tests / isolated runs) — disk path.
      2. In-memory _flows dict (may hold a completed/killed flow whose JSON
         was already removed by delete_persisted_flow but whose state is still
         live in the server process — e.g. after stratum_gate_resolve(approve)).
      3. Disk via restore_flow (the default ~/.stratum/flows/ path).
      4. Fresh flow constructed from scratch.
    """
    if flow_state_root is not None:
        path = flow_state_root / f"{goal_id}.json"
        if path.exists():
            return _restore_flow_state_from_path(path)
        return _make_flow_state(goal_id, max_rounds, flow_state_root=flow_state_root)
    else:
        # Check the in-memory _flows dict first so that a flow whose JSON was
        # removed by delete_persisted_flow (e.g. after approve) is still found.
        # Use module-attribute access (not `from ... import _flows`) so monkeypatching
        # the dict at the module level is visible here.
        try:
            import stratum_mcp.executor as _exc_mod
            in_memory = _exc_mod._flows.get(goal_id)
        except (ImportError, AttributeError):
            in_memory = None
        if in_memory is not None:
            return in_memory

        from stratum_mcp.executor import restore_flow
        existing = restore_flow(goal_id)
        if existing is not None:
            return existing
        return _make_flow_state(goal_id, max_rounds, flow_state_root=None)


def _restore_flow_state_from_path(path: Path):
    """Restore FlowState from a custom path (used in tests)."""
    from stratum_mcp.executor import FlowState, _topological_sort, _record_from_dict, ParallelTaskState, compute_spec_checksum
    from stratum_mcp.spec import parse_and_validate

    payload = json.loads(path.read_text())
    spec = parse_and_validate(payload["raw_spec"])
    flow_def = spec.flows.get(payload["flow_name"])
    if flow_def is None:
        raise ValueError(f"Flow '{payload['flow_name']}' not found in spec")
    ordered = _topological_sort(flow_def)
    records = [_record_from_dict(r) for r in payload.get("records", [])]

    return FlowState(
        flow_id=payload["flow_id"],
        flow_name=payload["flow_name"],
        raw_spec=payload["raw_spec"],
        spec=spec,
        ordered_steps=ordered,
        inputs=payload["inputs"],
        step_outputs=payload["step_outputs"],
        records=records,
        attempts=payload.get("attempts", {}),
        dispatched_at={},
        flow_start=time.monotonic(),
        current_idx=payload["current_idx"],
        checkpoints=payload.get("checkpoints", {}),
        round=payload.get("round", 0),
        rounds=payload.get("rounds", []),
        round_start_step_id=payload.get("round_start_step_id"),
        terminal_status=payload.get("terminal_status"),
        iterations=payload.get("iterations", {}),
        archived_iterations=payload.get("archived_iterations", []),
        active_iteration=payload.get("active_iteration"),
        iteration_outcome=payload.get("iteration_outcome", {}),
        iteration_best=payload.get("iteration_best", {}),
        parent_flow_id=payload.get("parent_flow_id"),
        parent_step_id=payload.get("parent_step_id"),
        active_child_flow_id=payload.get("active_child_flow_id"),
        child_audits=payload.get("child_audits", {}),
        spec_checksum=payload.get("spec_checksum", ""),
        parallel_tasks={},
        cwd=payload.get("cwd", ""),
        judge_history=payload.get("judge_history", {}),
        judge_outcome=payload.get("judge_outcome", {}),
        synthetic=payload.get("synthetic", False),
    )


def _persist_flow_state(flow_state, *, flow_state_root: Path | None) -> None:
    """Persist FlowState to custom path or default ~/.stratum/flows/."""
    if flow_state_root is not None:
        flow_state_root.mkdir(parents=True, exist_ok=True)
        path = flow_state_root / f"{flow_state.flow_id}.json"
        path.write_text(json.dumps(_flow_state_to_dict(flow_state), indent=2))
    else:
        from stratum_mcp.executor import persist_flow
        persist_flow(flow_state)


# ---------------------------------------------------------------------------
# FlowState status derivation
# ---------------------------------------------------------------------------

def _is_at_goal_decision_step(flow_state) -> bool:
    """True iff the synthetic flow's current step is goal_decision."""
    if flow_state.current_idx >= len(flow_state.ordered_steps):
        return False
    step = flow_state.ordered_steps[flow_state.current_idx]
    return step.id == "goal_decision"


def _is_flow_complete(flow_state) -> bool:
    """True iff the synthetic flow has exhausted all steps."""
    return flow_state.current_idx >= len(flow_state.ordered_steps)


def _mark_budget_exhausted(flow_state, *, flow_state_root: Path | None) -> None:
    """Set terminal_status='budget_exhausted' on FlowState and persist.

    Mirrors the 'killed' pattern so that stratum_goal_status can derive the
    correct contract-valid status from FlowState without additional heuristics.
    """
    if flow_state is not None:
        flow_state.terminal_status = "budget_exhausted"
        _persist_flow_state(flow_state, flow_state_root=flow_state_root)


def _advance_to_goal_decision(flow_state, *, flow_state_root: Path | None) -> None:
    """Advance FlowState.current_idx from goal_turn to goal_decision and persist."""
    for i, step in enumerate(flow_state.ordered_steps):
        if step.id == "goal_decision":
            flow_state.current_idx = i
            break
    _persist_flow_state(flow_state, flow_state_root=flow_state_root)


# ---------------------------------------------------------------------------
# GoalState helpers
# ---------------------------------------------------------------------------

def _load_or_create_goal_state(
    goal_id: str,
    predicates: list[Predicate],
    mode: str,
    artifact_contract_dicts: list[dict] | None,
    cwd: str,
    *,
    goal_state_root: Path | None,
) -> GoalState:
    """Load persisted GoalState or create fresh; enforce immutability on resume."""
    pred_dicts = [dataclasses.asdict(p) for p in predicates]
    pred_hash = compute_predicates_hash(pred_dicts)

    try:
        state = restore_goal_state(
            goal_id,
            root=goal_state_root,
            expected_predicates_hash=pred_hash,
            expected_mode=mode,
        )
        # Contract immutability check (C2 note: add inline here)
        if artifact_contract_dicts is not None:
            existing_contract_hash = _hash_artifact_contract(
                [dataclasses.asdict(a) for a in state.artifact_contract]
            )
            new_contract_hash = _hash_artifact_contract(artifact_contract_dicts)
            if existing_contract_hash != new_contract_hash:
                raise GoalImmutabilityError(
                    f"artifact_contract mismatch for goal_id={goal_id!r}: "
                    "the artifact contract cannot change across resumes (PRD M8)."
                )
        return state
    except FileNotFoundError:
        # Fresh goal
        artifact_contract = _parse_artifact_contract(artifact_contract_dicts)
        state = GoalState(
            goal_id=goal_id,
            mode=mode,
            predicates=pred_dicts,
            predicates_hash=pred_hash,
            artifact_contract=artifact_contract,
            cwd=cwd,
        )
        persist_goal_state(state, root=goal_state_root)
        return state


def _hash_artifact_contract(contract_dicts: list[dict]) -> str:
    payload = json.dumps(
        sorted([(d.get("name", ""), d.get("required", True)) for d in contract_dicts]),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def _parse_artifact_contract(contract_dicts: list[dict] | None) -> list[ArtifactSpec]:
    if not contract_dicts:
        return []
    return [
        ArtifactSpec(
            name=d["name"],
            required=d.get("required", True),
            description=d.get("description", ""),
        )
        for d in contract_dicts
    ]


def _artifact_specs_to_dicts(specs: list[ArtifactSpec]) -> list[dict]:
    return [
        {"name": s.name, "required": s.required, "description": s.description}
        for s in specs
    ]


# ---------------------------------------------------------------------------
# Judge feedback helpers
# ---------------------------------------------------------------------------

def _collect_prior_findings(state: GoalState) -> list[dict]:
    """Build the prior_findings list for build_turn_prompt from TurnRecords."""
    findings = []
    for turn in state.turns:
        summary = turn.judge_result_summary
        findings.append({
            "turn": turn.turn,
            "findings": summary.get("findings", []),
        })
    return findings


def _get_latest_rejection_note(state: GoalState) -> str | None:
    """Finding 4: return the rejection_note from the most-recent DecisionGateRecord, or None."""
    if not state.decision_gates:
        return None
    last = state.decision_gates[-1]
    return getattr(last, "rejection_note", None) or None


# ---------------------------------------------------------------------------
# Autonomy partition
# ---------------------------------------------------------------------------

def _partition_outcomes(
    judge_result: JudgeResult,
    autonomy: dict[str, bool],
) -> tuple[list, list]:
    """Partition met predicates into (autobind, await_human).

    Returns two lists of PredicateResult objects.
    """
    autobind = []
    await_human = []
    for pr in judge_result.predicates:
        if pr.verdict != "met":
            continue
        if autonomy.get(pr.type, False):
            autobind.append(pr)
        else:
            await_human.append(pr)
    return autobind, await_human


# ---------------------------------------------------------------------------
# GoalResult builder
# ---------------------------------------------------------------------------

def _build_predicate_outcomes(
    judge_result: JudgeResult,
    autobind_ids: set[str],
    await_human_ids: set[str],
) -> list[PredicateOutcome]:
    outcomes = []
    for pr in judge_result.predicates:
        outcomes.append(PredicateOutcome(
            id=pr.id,
            type=pr.type,
            verdict=pr.verdict,
            confidence=pr.confidence,
            applied_gate=pr.applied_gate,
            judge_verdict=pr.verdict,
            bound_autonomously=(pr.id in autobind_ids),
            awaiting_human=(pr.id in await_human_ids),
        ))
    return outcomes


def _build_goal_result(
    state: GoalState,
    flow_state,
    judge_result: JudgeResult | None,
    status: str,
    *,
    would_have_decided: str | None = None,
    autobind_ids: set[str] | None = None,
    await_human_ids: set[str] | None = None,
) -> GoalResult:
    """Assemble the GoalResult from in-flight state."""
    from stratum.judge.result import (
        BudgetConsumed, JudgeKernelMeta, JudgeResult as JR, PredicateResult,
    )

    if judge_result is None:
        # No turns ran — synthesize a zero-verdict result
        judge_result = JR(
            clean=False, met=False,
            summary="No turns ran.",
            findings=[],
            meta={"agent_type": "judge", "model_id": "n/a"},
            stakes="default",
            predicates=[],
            budget_consumed=BudgetConsumed(turns=0),
            judge_kernel_meta=JudgeKernelMeta(),
        )

    worker_runs = [
        {
            "turn": t.turn,
            "agent_correlation_id": t.agent_correlation_id,
            "duration_ms": t.duration_ms,
        }
        for t in state.turns
    ]

    predicate_outcomes = _build_predicate_outcomes(
        judge_result,
        autobind_ids=autobind_ids or set(),
        await_human_ids=await_human_ids or set(),
    )

    return GoalResult(
        judge_result=judge_result,
        goal_id=state.goal_id,
        mode=state.mode,
        status=status,
        turns_run=len(state.turns),
        worker_runs=worker_runs,
        round=flow_state.round if flow_state is not None else 0,
        predicate_outcomes=predicate_outcomes,
        would_have_decided=would_have_decided,
    )


# ---------------------------------------------------------------------------
# Git diff helper
# ---------------------------------------------------------------------------

def _git_diff_files(cwd: str | None) -> list[str]:
    """Return files changed since HEAD in the workspace. Returns [] on error."""
    if not cwd:
        return []
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return [f for f in result.stdout.splitlines() if f]
    except Exception:  # noqa: BLE001
        pass
    return []


# ---------------------------------------------------------------------------
# Shadow-observed path
# ---------------------------------------------------------------------------

async def _observed_shadow_path(
    state: GoalState,
    flow_state,
    observed_artifacts: dict[str, str] | None,
    observed_modified_files: list[str] | None,
    run_judge_callable: Callable,
    predicates: list[Predicate],
    stakes: str,
    budget: dict,
    goal_state_root: Path | None,
    flow_state_root: Path | None,
    ctx: Any,
    stratum_agent_run_callable: Callable,
) -> GoalResult:
    """shadow-observed: skips worker, runs judge once on caller artifacts."""
    artifacts = observed_artifacts or {}
    modified_files = observed_modified_files or []

    budget_caps = BudgetCaps(
        max_turns=budget.get("max_turns", 10),
        max_dollars=budget.get("max_dollars"),
        max_wall_clock_s=budget.get("max_wall_clock_s"),
    )

    t_start = time.monotonic()
    try:
        judge_result = await run_judge_callable(
            flow_id=state.goal_id,
            step_id="goal_turn",
            predicates=predicates,
            artifacts=artifacts,
            modified_files=modified_files,
            stakes=stakes,
            budget=budget_caps,
            workspace_root=Path(state.cwd) if state.cwd else Path.cwd(),
            stratum_agent_run=stratum_agent_run_callable,
            ctx=ctx,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("shadow-observed judge failed: %s", exc)
        _mark_budget_exhausted(flow_state, flow_state_root=flow_state_root)
        return _build_goal_result(
            state, flow_state, None, "budget_exhausted"
        )

    duration_ms = int((time.monotonic() - t_start) * 1000)
    _record_turn(state, judge_result, "observed-0", duration_ms=duration_ms)
    persist_goal_state(state, root=goal_state_root)

    # shadow-observed never binds but reports would_have_decided.
    # Finding 6: derive the top-level status from the judge verdict instead of
    # hardcoding "met" — status must match the contract enum
    # (met | not_met | awaiting_decision | budget_exhausted | killed).
    if judge_result.met:
        wh = "met"
        observed_status = "met"
    elif any(p.verdict == "ambiguous" for p in judge_result.predicates):
        wh = "ambiguous"
        observed_status = "not_met"  # "ambiguous" is not in the GoalResult status enum
    else:
        wh = "not_met"
        observed_status = "not_met"

    return _build_goal_result(
        state, flow_state, judge_result, observed_status,
        would_have_decided=wh,
    )


def _record_turn(
    state: GoalState,
    judge_result: JudgeResult,
    correlation_id: str,
    *,
    duration_ms: int = 0,
) -> None:
    """Append a TurnRecord to GoalState."""
    turn_num = len(state.turns) + 1
    summary = {
        "met": judge_result.met,
        "findings": list(judge_result.findings),
        "predicate_results": [
            {"id": pr.id, "verdict": pr.verdict, "confidence": pr.confidence}
            for pr in judge_result.predicates
        ],
    }
    state.turns.append(TurnRecord(
        turn=turn_num,
        agent_correlation_id=correlation_id,
        duration_ms=duration_ms,
        worker_text="",  # not stored inline for memory efficiency
        judge_result_summary=summary,
    ))


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

async def run_goal(
    goal_id: str,
    predicates: list[Predicate],
    mode: str,
    *,
    # Injected callables (architecture.md cross-cutting DI rule)
    dispatch_worker_callable: Callable,
    run_judge_callable: Callable,
    stratum_agent_run_callable: Callable,
    stratum_gate_resolve_callable: Callable,
    smart_memory_search_callable: Optional[Callable] = None,
    ctx: Any = None,
    # Goal config
    prompt: Optional[str] = None,
    artifact_contract: Optional[list[dict]] = None,
    worker_spec: Optional[dict] = None,
    stakes: str = "default",
    budget: Optional[dict] = None,
    autonomy: Optional[dict] = None,
    shadow_source: str = "driven",
    observed_artifacts: Optional[dict[str, str]] = None,
    observed_modified_files: Optional[list[str]] = None,
    # Persistence roots (None = defaults; test-overrideable)
    goal_state_root: Optional[Path] = None,
    flow_state_root: Optional[Path] = None,
    cwd: Optional[str] = None,
) -> GoalResult:
    """Run a worker→judge goal loop and return a GoalResult.

    Parameters
    ----------
    goal_id:
        Stable caller-supplied identifier. Repeat calls with the same ID
        resume the prior loop (predicates and mode are immutable after first call).
    predicates:
        List of Predicate objects to evaluate per turn.
    mode:
        "shadow" | "advisory" | "autonomous"
    shadow_source:
        "driven" (dispatch worker) | "observed" (caller supplies artifacts).
        Only meaningful when mode == "shadow".
    dispatch_worker_callable:
        async (prompt, worker_spec, correlation_id, *, ctx) -> (text, cid)
    run_judge_callable:
        async (**kwargs) -> JudgeResult — same kwargs as stratum.judge.kernel.run_judge
    stratum_agent_run_callable:
        Forwarded to run_judge for T2 dispatch.
    stratum_gate_resolve_callable:
        async (**kwargs) -> dict — called for autonomous auto-approve or advisory advance.
    goal_state_root:
        Override persistence root for tests. None = ~/.stratum/goal/
    flow_state_root:
        Override flow persistence root for tests. None = ~/.stratum/flows/
    """
    budget = budget or {}
    max_turns = budget.get("max_turns", 10)
    max_worker_failures = budget.get("max_worker_failures", 3)
    # PRD M15: max_rounds = max_turns - 1 (off-by-one per executor semantics)
    max_rounds = max(1, max_turns - 1)
    effective_cwd = cwd or ""

    # 1. Load or create GoalState (immutability enforced on resume)
    state = _load_or_create_goal_state(
        goal_id, predicates, mode, artifact_contract,
        effective_cwd, goal_state_root=goal_state_root,
    )

    # 2. Restore or create the synthetic FlowState
    flow_state = _restore_or_create_flow_state(
        goal_id, max_rounds, flow_state_root=flow_state_root
    )

    # 3. Derive current status from FlowState (no sticky GoalState.status)
    if flow_state.terminal_status == "killed":
        return _build_goal_result(state, flow_state, None, "killed")

    if _is_flow_complete(flow_state):
        last_judge = _last_judge_result(state)
        return _build_goal_result(state, flow_state, last_judge, "met")

    if _is_at_goal_decision_step(flow_state):
        # Human decision pending; return without advancing
        last_judge = _last_judge_result(state)
        return _build_goal_result(state, flow_state, last_judge, "awaiting_decision")

    # 4. shadow-observed shortcut: skip dispatch
    if mode == "shadow" and shadow_source == "observed":
        return await _observed_shadow_path(
            state=state,
            flow_state=flow_state,
            observed_artifacts=observed_artifacts,
            observed_modified_files=observed_modified_files,
            run_judge_callable=run_judge_callable,
            predicates=predicates,
            stakes=stakes,
            budget=budget,
            goal_state_root=goal_state_root,
            flow_state_root=flow_state_root,
            ctx=ctx,
            stratum_agent_run_callable=stratum_agent_run_callable,
        )

    # 5. Resolve autonomy for autonomous mode
    resolved_autonomy: dict[str, bool] = {"deterministic": False, "verified": False, "judged": False}
    if mode == "autonomous":
        resolved_autonomy = await resolve_autonomy(
            effective_cwd or None,
            autonomy,
            smart_memory_search_callable=smart_memory_search_callable,
        )
    elif autonomy:
        # Allow caller autonomy dict even in advisory for testing; only acts in autonomous
        resolved_autonomy.update(autonomy)

    # 6. Effective artifact contract for prompts
    art_contract_dicts = _artifact_specs_to_dicts(state.artifact_contract)

    # 7. Worker spec
    ws = worker_spec or {}

    # Finding 5: enforce M17 Codex-driven-mode guard before entering the loop.
    validate_worker_spec(ws, mode, shadow_source)  # raises WorkerTypeNotSupportedError if needed

    # 8. Failure tracker
    failure_tracker = WorkerFailureTracker(max_failures=max_worker_failures)

    # 9. Main loop
    last_judge_result: JudgeResult | None = None
    budget_caps = BudgetCaps(
        max_turns=max_turns,
        max_dollars=budget.get("max_dollars"),
        max_wall_clock_s=budget.get("max_wall_clock_s"),
    )

    # state.round is the canonical "turns consumed" counter — persisted across
    # retries, missing-artifact skips, and judge failures.  Do not add
    # len(state.turns) here; that caused resumed goals to count prior turns twice
    # (once via state.round already being > 0, and again via turns_already_run).
    while state.round < max_turns:
        turn_nonce = mk_turn_nonce()
        prior_findings = _collect_prior_findings(state)
        # Finding 4: surface the most-recent rejection note (if any) in the prompt.
        latest_rejection_note = _get_latest_rejection_note(state)
        prompt_text = build_turn_prompt(
            prompt or "",
            art_contract_dicts,
            prior_findings,
            turn_nonce,
            rejection_note=latest_rejection_note,
        )

        # Worker dispatch
        t_start = time.monotonic()
        try:
            import uuid
            corr_id = str(uuid.uuid4())
            worker_text, returned_cid = await dispatch_worker_callable(
                prompt_text, ws, corr_id, ctx=ctx
            )
            failure_tracker.record_success()
        except Exception as exc:
            try:
                failure_tracker.record_failure(exc)
            except Exception:
                # BudgetExceededError from failure cap
                last_judge = _last_judge_result(state)
                _mark_budget_exhausted(flow_state, flow_state_root=flow_state_root)
                return _build_goal_result(
                    state, flow_state, last_judge,
                    "budget_exhausted",
                    would_have_decided=_derive_would_have_decided(state) if mode == "shadow" and state.turns else None,
                )
            state.round += 1
            persist_goal_state(state, root=goal_state_root)
            continue

        # Artifact extraction
        artifacts, missing = extract_artifacts(worker_text, art_contract_dicts, turn_nonce)
        if missing:
            log.debug("turn missing required artifacts: %s", missing)
            state.round += 1
            persist_goal_state(state, root=goal_state_root)
            continue

        # Modified files
        modified_files = _git_diff_files(effective_cwd or None)

        # Judge
        try:
            judge_result = await run_judge_callable(
                flow_id=goal_id,
                step_id="goal_turn",
                predicates=predicates,
                artifacts=artifacts,
                modified_files=modified_files,
                stakes=stakes,
                budget=budget_caps,
                workspace_root=Path(effective_cwd) if effective_cwd else Path.cwd(),
                stratum_agent_run=stratum_agent_run_callable,
                ctx=ctx,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("judge failed on turn: %s", exc)
            state.round += 1
            persist_goal_state(state, root=goal_state_root)
            continue

        duration_ms = int((time.monotonic() - t_start) * 1000)
        _record_turn(state, judge_result, returned_cid, duration_ms=duration_ms)
        persist_goal_state(state, root=goal_state_root)
        last_judge_result = judge_result

        # Shadow-driven: never bind, just report
        if mode == "shadow":
            state.round += 1
            persist_goal_state(state, root=goal_state_root)
            if judge_result.met:
                return _build_goal_result(
                    state, flow_state, judge_result, "met",
                    would_have_decided="met",
                )
            continue

        # Advisory / autonomous: check if met
        if judge_result.met:
            autobind, await_human = _partition_outcomes(judge_result, resolved_autonomy)
            autobind_ids = {pr.id for pr in autobind}
            await_human_ids = {pr.id for pr in await_human}

            # Advance synthetic flow to goal_decision step
            _advance_to_goal_decision(flow_state, flow_state_root=flow_state_root)

            if mode == "autonomous" and not await_human:
                # All auto-bind: auto-approve gate, complete goal
                await stratum_gate_resolve_callable(
                    flow_id=goal_id,
                    step_id="goal_decision",
                    outcome="approve",
                    rationale="autonomous: all predicate classes whitelisted",
                    resolved_by="agent",
                    ctx=ctx,
                )
                # Mark flow complete: advance past goal_decision
                flow_state.current_idx = len(flow_state.ordered_steps)
                _persist_flow_state(flow_state, flow_state_root=flow_state_root)

                return _build_goal_result(
                    state, flow_state, judge_result, "met",
                    autobind_ids=autobind_ids,
                    await_human_ids=await_human_ids,
                )

            # Advisory or mixed autonomous: await human
            state.decision_gates.append(DecisionGateRecord(
                round=flow_state.round,
                decision="pending",
                note="",
                registered_at_ms=int(time.time() * 1000),
            ))
            persist_goal_state(state, root=goal_state_root)

            return _build_goal_result(
                state, flow_state, judge_result, "awaiting_decision",
                autobind_ids=autobind_ids,
                await_human_ids=await_human_ids,
            )

        # Not met: loop with feedback
        state.round += 1
        persist_goal_state(state, root=goal_state_root)

    # 10. Budget exhausted
    if mode == "shadow" and state.turns:
        wh = _derive_would_have_decided(state)
    else:
        wh = None

    _mark_budget_exhausted(flow_state, flow_state_root=flow_state_root)
    return _build_goal_result(
        state, flow_state, last_judge_result, "budget_exhausted",
        would_have_decided=wh,
    )


def _last_judge_result(state: GoalState) -> JudgeResult | None:
    """Reconstruct a minimal JudgeResult from the last TurnRecord, or None."""
    if not state.turns:
        return None
    from stratum.judge.result import (
        BudgetConsumed, JudgeKernelMeta, JudgeResult as JR, PredicateResult, TierRecord,
    )
    last = state.turns[-1].judge_result_summary
    met = last.get("met", False)
    # Reconstruct minimal JudgeResult from summary
    pred_results = []
    for pr in last.get("predicate_results", []):
        pred_results.append(PredicateResult(
            id=pr["id"],
            type="deterministic",
            statement="",
            verdict=pr["verdict"],
            confidence=pr["confidence"],
            applied_gate=7,
            evidence=[],
            tier_history=[],
        ))
    return JR(
        clean=met,
        met=met,
        summary="",
        findings=list(last.get("findings", [])),
        meta={"agent_type": "judge", "model_id": "resumed"},
        stakes="default",
        predicates=pred_results,
        budget_consumed=BudgetConsumed(turns=len(state.turns)),
        judge_kernel_meta=JudgeKernelMeta(),
    )


def _derive_would_have_decided(state: GoalState) -> str:
    """Derive would_have_decided from the last turn's summary."""
    if not state.turns:
        return "not_met"
    last = state.turns[-1].judge_result_summary
    if last.get("met", False):
        return "met"
    if any(p.get("verdict") == "ambiguous" for p in last.get("predicate_results", [])):
        return "ambiguous"
    return "not_met"
