"""FastMCP server entry point. MCP controller: plan management, step tracking, audit."""
from __future__ import annotations

import dataclasses
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP, Context

from .errors import IRParseError, IRValidationError, IRSemanticError, MCPExecutionError, exception_to_mcp_error
from .executor import (
    FlowState,
    _flows,
    _step_mode,
    create_flow_state,
    get_current_step_info,
    process_step_result,
    resolve_gate,
    apply_gate_policy,
    skip_step,
    start_iteration,
    report_iteration,
    abort_iteration,
    persist_flow,
    restore_flow,
    delete_persisted_flow,
    commit_checkpoint,
    revert_checkpoint,
    verify_spec_integrity,
    validate_certificate,
)
from .spec import parse_and_validate
from .connectors import AgentConnector, ClaudeConnector, CodexConnector
from .connectors.factory import make_agent_connector as _make_agent_connector
from .events import (
    BuildStreamEvent,
    INTERNAL_RESULT_KIND,
    TaskSeqCounter,
    now_iso,
)
import asyncio
import uuid as _uuid

_AGENT_RUN_TASKS: "dict[str, asyncio.Task[Any]]" = {}

mcp = FastMCP(
    "stratum-mcp",
    instructions=(
        "Stratum execution controller for Claude Code. "
        "Validates .stratum.yaml IR specs, manages flow execution state, "
        "and tracks step results with ensure postcondition enforcement."
    ),
)


def _apply_policy_loop(
    state: FlowState,
    step_info: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Apply gate policy in a loop until a non-auto-resolvable state is reached.

    Handles chained flag/skip gates. Bounded by visited-set to prevent
    on_approve routing cycles from hanging.
    """
    visited: set[str] = set()
    while step_info is not None and step_info.get("status") == "await_gate":
        gate_step_id = step_info["step_id"]
        if gate_step_id in visited:
            break  # cycle detected — treat as gate (require manual resolution)
        visited.add(gate_step_id)
        policy_result = apply_gate_policy(state, gate_step_id)
        if policy_result is None:
            break  # policy is "gate" — return await_gate to caller
        step_info = policy_result
    return step_info


@mcp.tool(description=(
    "Validate a .stratum.yaml IR spec. "
    "Input: spec (str) — inline YAML only, not a file path. "
    "Returns {valid: bool, errors: list}."
))
async def stratum_validate(spec: str, ctx: Context) -> dict[str, Any]:
    try:
        parse_and_validate(spec)
        return {"valid": True, "errors": []}
    except (IRParseError, IRValidationError, IRSemanticError) as exc:
        return {"valid": False, "errors": [exception_to_mcp_error(exc)]}


# ---------------------------------------------------------------------------
# STRAT-CERT-PAR / T2-F5: agent_run — dispatch prompts to claude or codex
# ---------------------------------------------------------------------------

_JSON_BLOCK_RE = re.compile(r"```json\s*\n([\s\S]*?)\n\s*```")


def _extract_json_result(text: str) -> tuple[Optional[dict], Optional[str]]:
    """Try to parse text as JSON; fall back to last ```json code block.

    Mirrors compose/server/agent-mcp.js:81-98 extraction logic.
    Returns (result, parse_error). Success: (dict, None). Failure: (None, reason).
    """
    try:
        return json.loads(text), None
    except json.JSONDecodeError:
        pass
    matches = _JSON_BLOCK_RE.findall(text)
    if matches:
        try:
            return json.loads(matches[-1]), None
        except json.JSONDecodeError:
            pass
    return None, "Response was not valid JSON"


@mcp.tool(description=(
    "Run a prompt against an AI agent (claude or codex). "
    "Returns the full response text. If schema is provided, the agent is instructed "
    "to return JSON matching the schema and the parsed result is included in the response. "
    "Inputs: prompt (str, required); type ('claude'|'codex', default 'claude'); "
    "context (str, optional — prepended verbatim to prompt; callers build their own "
    "context strings, Stratum does no file reading or feature-code detection); "
    "schema (dict, optional JSON Schema for structured output); modelID (str, optional); "
    "cwd (str, optional working directory). "
    "Returns {text: str, result?: dict, parseError?: str}."
))
async def stratum_agent_run(
    prompt: str,
    ctx: Context,
    type: str = "claude",  # noqa: A002 — shadows builtin; matches Node contract
    context: Optional[str] = None,
    schema: Optional[dict] = None,
    modelID: Optional[str] = None,  # noqa: N803 — contract parity with Node
    model_id: Optional[str] = None,
    allowed_tools: Optional[list[str]] = None,
    disallowed_tools: Optional[list[str]] = None,
    thinking: Optional[dict] = None,
    effort: Optional[str] = None,
    cwd: Optional[str] = None,
    read_jail: Optional[str] = None,
    correlation_id: Optional[str] = None,
) -> dict[str, Any]:
    if not prompt or not prompt.strip():
        raise ValueError("stratum_agent_run: prompt is required")

    active_model_id = modelID if modelID is not None else model_id

    full_prompt = f"{context}\n\n{prompt}" if context and context.strip() else prompt

    connector = _make_agent_connector(
        type,
        active_model_id,
        cwd,
        allowed_tools=allowed_tools,
        disallowed_tools=disallowed_tools,
        thinking=thinking,
        effort=effort,
        read_jail=read_jail,
    )

    flow_id = correlation_id or str(_uuid.uuid4())
    step_id = "_agent_run"
    seq_counter = TaskSeqCounter()

    parts: list[str] = []
    final_result: Optional[str] = None

    cls = connector.__class__
    base_stream = AgentConnector.stream_events
    own_stream = getattr(cls, "stream_events", None)
    supports_stream = own_stream is not None and own_stream is not base_stream

    current = asyncio.current_task()
    if current is not None:
        _AGENT_RUN_TASKS[flow_id] = current

    async def _emit(envelope: BuildStreamEvent) -> None:
        if ctx is None:
            return
        try:
            await ctx.report_progress(
                progress=envelope.seq, message=envelope.to_json()
            )
        except Exception:
            pass

    try:
        if supports_stream:
            async for cev in connector.stream_events(
                full_prompt, schema=schema, model_id=active_model_id, cwd=cwd
            ):
                if cev.kind == INTERNAL_RESULT_KIND:
                    final_result = cev.metadata.get("content")
                    continue
                envelope = BuildStreamEvent(
                    flow_id=flow_id,
                    step_id=step_id,
                    task_id=None,
                    seq=seq_counter.next(flow_id, step_id, None),
                    ts=now_iso(),
                    kind=cev.kind,
                    metadata=dict(cev.metadata),
                )
                await _emit(envelope)
                if cev.kind == "agent_relay" and cev.metadata.get("role") == "assistant":
                    text = cev.metadata.get("text", "")
                    if text:
                        parts.append(text)
        else:
            async for event in connector.run(
                full_prompt, schema=schema, model_id=active_model_id, cwd=cwd
            ):
                etype = event.get("type")
                if etype == "assistant" and event.get("content"):
                    parts.append(event["content"])
                elif etype == "result" and event.get("content"):
                    final_result = event["content"]
                elif etype == "error":
                    raise RuntimeError(
                        f"stratum_agent_run ({type}): "
                        f"{event.get('message', 'unknown error')}"
                    )
    finally:
        _AGENT_RUN_TASKS.pop(flow_id, None)

    if supports_stream:
        # Streaming connectors: prefer the _result sentinel (authoritative final
        # text from the SDK); fall back to concatenated assistant relays.
        text = final_result if final_result is not None else "".join(parts)
    else:
        # Legacy run() path: assistant events are authoritative when present.
        text = "".join(parts) if parts else (final_result or "")

    if schema is not None:
        result, parse_error = _extract_json_result(text)
        if result is not None:
            return {"text": text, "result": result, "correlation_id": flow_id}
        return {
            "text": text,
            "result": None,
            "parseError": parse_error,
            "correlation_id": flow_id,
        }

    return {"text": text, "correlation_id": flow_id}


@mcp.tool(description=(
    "Cancel an in-flight stratum_agent_run identified by correlation_id. "
    "Idempotent: returns {status: 'not_found'} if no matching task exists. "
    "Input: correlation_id (str). "
    "Returns {status: 'cancelled'|'not_found', correlation_id: str}."
))
async def stratum_cancel_agent_run(
    correlation_id: str,
    ctx: Context,
) -> dict[str, Any]:
    task = _AGENT_RUN_TASKS.get(correlation_id)
    if task is None:
        return {"status": "not_found", "correlation_id": correlation_id}
    task.cancel()
    return {"status": "cancelled", "correlation_id": correlation_id}


@mcp.tool(description=(
    "Create an execution plan from a validated .stratum.yaml spec. "
    "Inputs: spec (str, inline YAML), flow (str, flow name), inputs (dict, flow-level inputs). "
    "Returns the first step to execute with resolved inputs and output contract details. "
    "Call stratum_step_done when each step is complete."
))
async def stratum_plan(
    spec: str,
    flow: str,
    inputs: dict[str, Any],
    ctx: Context,
) -> dict[str, Any]:
    try:
        ir_spec = parse_and_validate(spec)
    except (IRParseError, IRValidationError, IRSemanticError) as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    try:
        state = create_flow_state(ir_spec, flow, inputs, raw_spec=spec)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    # T2-F5-ENFORCE: capture caller's cwd at plan time so parallel executor
    # can resolve relative paths for worktrees later in the flow lifecycle.
    state.cwd = os.getcwd()

    _flows[state.flow_id] = state
    try:
        step_info = get_current_step_info(state)  # may skip steps, mutating state
        step_info = _apply_policy_loop(state, step_info)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}
    if step_info is not None and step_info.get("status") == "complete":
        delete_persisted_flow(state.flow_id)
        return step_info
    persist_flow(state)                        # persist AFTER skip/policy mutations
    return step_info  # always non-None: schema enforces minItems: 1


@mcp.tool(description=(
    "Resume an in-progress flow. Loads the persisted flow state and returns "
    "the current step dispatch (execute_step, await_gate, execute_flow, or "
    "flow completion). Use this instead of stratum_plan when a flow_id already "
    "exists from a previous session. "
    "Input: flow_id (str). "
    "Returns the same dispatch format as stratum_plan / stratum_step_done."
))
async def stratum_resume(flow_id: str, ctx: Context) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    if state.terminal_status == "killed":
        return {"status": "killed", "flow_id": flow_id}

    if state.current_idx >= len(state.ordered_steps):
        delete_persisted_flow(flow_id)
        return {"status": "complete", "flow_id": flow_id}

    try:
        step_info = get_current_step_info(state)
        step_info = _apply_policy_loop(state, step_info)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}
    persist_flow(state)
    return step_info


@mcp.tool(description=(
    "Report a completed step result. "
    "Inputs: flow_id (str), step_id (str), result (dict matching the step's output contract). "
    "Checks ensure postconditions. Returns next step to execute, ensure failure with retry "
    "instructions, or flow completion with final output and trace."
))
async def stratum_step_done(
    flow_id: str,
    step_id: str,
    result: dict[str, Any],
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    # STRAT-IMMUTABLE: verify spec has not been tampered with since flow creation.
    flow_def = state.spec.flows.get(state.flow_name)
    if flow_def is not None:
        integrity_err = verify_spec_integrity(flow_def, state)
        if integrity_err is not None:
            return integrity_err

    # Gate step rejection: must not process gate steps through stratum_step_done.
    # This check fires before process_step_result so no state is mutated on rejection.
    if state.current_idx < len(state.ordered_steps):
        _cur = state.ordered_steps[state.current_idx]
        _fn = state.spec.functions.get(_cur.function) if _cur.function else None
        if _fn and _fn.mode == "gate":
            return {
                "status": "error",
                "error_type": "gate_step_requires_gate_resolve",
                "message": (
                    f"Step '{_cur.id}' is a gate step. "
                    "Use stratum_gate_resolve to resolve it."
                ),
            }

    # Flow_ref step unwrapping: capture child audit and unwrap result
    _is_flow_step = (
        state.current_idx < len(state.ordered_steps)
        and _step_mode(state.ordered_steps[state.current_idx]) == "flow"
    )
    _child_audit = None
    _child_fid_before = state.active_child_flow_id if _is_flow_step else None
    if _is_flow_step:
        child_st = _flows.get(_child_fid_before) if _child_fid_before else None
        if child_st is not None:
            _child_audit = _build_audit_snapshot(child_st)
        # Unwrap child result: extract output if wrapped in completion envelope
        if isinstance(result, dict) and "status" in result and "output" in result:
            result = result["output"]

    try:
        status, violations = process_step_result(state, step_id, result)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    # Accumulate child audit on every flow step completion (success or failure)
    if _is_flow_step and _child_audit is not None:
        state.child_audits.setdefault(step_id, []).append(_child_audit)

    def _cleanup_child():
        """Remove child flow from memory and disk after parent processes result."""
        # Use pre-captured child ID since process_step_result may have cleared
        # active_child_flow_id via _clear_from (e.g., on_fail_routed path)
        fid = _child_fid_before
        if fid:
            _flows.pop(fid, None)
            delete_persisted_flow(fid)
            state.active_child_flow_id = None

    if status == "retries_exhausted":
        if _is_flow_step:
            _cleanup_child()
        delete_persisted_flow(flow_id)
        _step = state.ordered_steps[state.current_idx]
        return {
            "status": "error",
            "error_type": "retries_exhausted",
            "flow_id": flow_id,
            "step_id": step_id,
            "step_mode": _step_mode(_step),
            "agent": _step.agent,
            "message": f"Step '{step_id}' exhausted all retries",
            "violations": violations,
        }

    if status == "on_fail_routed":
        if _is_flow_step:
            _cleanup_child()
        try:
            next_step = get_current_step_info(state)
            next_step = _apply_policy_loop(state, next_step)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **(next_step or {}),
            "routed_from": step_id,
            "violations": violations,
        }

    if status in ("ensure_failed", "schema_failed", "guardrail_blocked"):
        if _is_flow_step:
            # Delete child — next retry creates a new child
            _cleanup_child()
        # Clear iteration state so a new loop can be started on retry
        state.iteration_outcome.pop(step_id, None)
        state.iteration_best.pop(step_id, None)
        # Persist incremented attempts so retry budget survives an MCP server restart.
        # current_idx has not advanced — get_current_step_info returns the same step
        # with updated retries_remaining. Persist AFTER get_current_step_info in case
        # skip mutations occur on subsequent steps (consistent with stratum_plan ordering).
        try:
            step_info = get_current_step_info(state)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **step_info,
            "status": status,
            "violations": violations,
        }

    # "ok" — current_idx was advanced by process_step_result
    if _is_flow_step:
        _cleanup_child()
    # Consume iteration outcome (ENG-5 will read before clearing)
    state.iteration_outcome.pop(step_id, None)
    try:
        next_step = get_current_step_info(state)
        next_step = _apply_policy_loop(state, next_step)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}
    if next_step is not None and next_step.get("status") == "complete":
        delete_persisted_flow(flow_id)
        return next_step
    if next_step is None:
        # Flow complete — clean up persistence
        delete_persisted_flow(flow_id)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        # Gate steps write no output; find the last step that actually produced one.
        output = next(
            (state.step_outputs[s.id] for s in reversed(state.ordered_steps)
             if s.id in state.step_outputs and state.step_outputs[s.id] is not None),
            None,
        )
        return {
            "status": state.terminal_status or "complete",
            "flow_id": state.flow_id,
            "output": output,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    persist_flow(state)
    return next_step


# ---------------------------------------------------------------------------
# T13: shared parallel-result evaluation + server-dispatch registry
# ---------------------------------------------------------------------------

# Module-level registry of in-flight parallel executors, keyed by
# (flow_id, step_id). T14 adds the shutdown hook; T13 only populates it.
_RUNNING_EXECUTORS: dict[tuple[str, str], Any] = {}

# STRAT-PAR-STREAM: per-(flow_id, step_id) reference to the live ParallelExecutor
# so stratum_parallel_poll can drain its event queue under the poll request's ctx.
# parallel_start's ctx is dead by the time the background executor emits.
_PARALLEL_EXECUTORS: dict[tuple[str, str], Any] = {}


def _evaluate_parallel_results(
    state: FlowState,
    step: Any,
    task_results: list[dict[str, Any]],
    merge_status: str = "clean",
) -> tuple[bool, dict[str, Any]]:
    """Evaluate whether a parallel_dispatch step can advance.

    Extracted from ``stratum_parallel_done`` so ``stratum_parallel_poll`` can
    reuse the same cert + require + merge semantics. Mutates ``task_results``
    in place to flip cert-failed tasks to ``status="failed"`` — same behavior
    as the pre-extraction inline code.

    Returns ``(can_advance, evaluation)`` where ``evaluation`` contains:
      - ``aggregate``: the dict passed to ``process_step_result``
      - ``per_task_cert_strs``: per-task cert violation strings
      - ``require``: the resolved require policy
      - ``completed`` / ``failed``: partitioned task lists
      - ``require_satisfied``: require policy check
      - ``merge_ok``: merge_status != 'conflict'
    """
    # STRAT-CERT-PAR: per-task certificate validation before require evaluation.
    # Only for claude-agent steps with a task_reasoning_template.
    # Cert-failed tasks are flipped to status="failed" so they count against the
    # require threshold naturally. Violations are collected and surfaced in
    # every failure-response path.
    task_template = step.task_reasoning_template
    per_task_cert_strs: list[str] = []
    if task_template and (step.agent or 'claude').startswith('claude'):
        for task in task_results:
            if task.get("status") != "complete":
                continue  # already failed — skip cert check
            task_result = task.get("result") or {}
            cert_violations = validate_certificate(task_template, task_result)
            if cert_violations:
                task["status"] = "failed"
                task["error"] = f"cert validation: {'; '.join(cert_violations)}"
                task["cert_violations"] = cert_violations
                task_id = task.get("task_id", "?")
                per_task_cert_strs.append(
                    f"task '{task_id}' cert: {'; '.join(cert_violations)}"
                )

    completed = [t for t in task_results if t.get("status") == "complete"]
    failed = [t for t in task_results if t.get("status") != "complete"]

    require = step.require or "all"
    if require == "all":
        require_satisfied = len(failed) == 0
    elif require == "any":
        require_satisfied = len(completed) > 0
    elif isinstance(require, int):
        require_satisfied = len(completed) >= require
    else:
        require_satisfied = len(failed) == 0  # default to "all"

    merge_ok = merge_status != "conflict"

    aggregate = {
        "tasks": task_results,
        "merge_status": merge_status,
        "completed": completed,
        "failed": failed,
        "outcome": "complete" if (require_satisfied and merge_ok) else "failed",
    }

    can_advance = require_satisfied and merge_ok
    evaluation = {
        "aggregate": aggregate,
        "per_task_cert_strs": per_task_cert_strs,
        "require": require,
        "completed": completed,
        "failed": failed,
        "require_satisfied": require_satisfied,
        "merge_ok": merge_ok,
    }
    return can_advance, evaluation


@mcp.tool(description=(
    "Report results for a completed parallel_dispatch step. "
    "Inputs: flow_id (str), step_id (str), "
    "task_results (list of {task_id, result, status}), "
    "merge_status ('clean' or 'conflict'). "
    "Validates ensure postconditions against the aggregate result and advances the flow."
))
async def stratum_parallel_done(
    flow_id: str,
    step_id: str,
    task_results: list[dict[str, Any]],
    merge_status: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    # STRAT-IMMUTABLE: verify spec has not been tampered with since flow creation.
    _pd_flow_def = state.spec.flows.get(state.flow_name)
    if _pd_flow_def is not None:
        _pd_integrity_err = verify_spec_integrity(_pd_flow_def, state)
        if _pd_integrity_err is not None:
            return _pd_integrity_err

    # Verify current step is a parallel_dispatch step with matching step_id
    if state.current_idx >= len(state.ordered_steps):
        return {
            "status": "error",
            "error_type": "flow_complete",
            "message": "Flow is already complete",
        }

    cur_step = state.ordered_steps[state.current_idx]
    if cur_step.id != step_id:
        return {
            "status": "error",
            "error_type": "step_mismatch",
            "message": f"Expected step '{cur_step.id}', got '{step_id}'",
        }

    mode = _step_mode(cur_step)
    if mode != "parallel_dispatch":
        return {
            "status": "error",
            "error_type": "wrong_step_type",
            "message": (
                f"Step '{step_id}' is a {mode} step, not parallel_dispatch. "
                "Use stratum_step_done for non-parallel steps."
            ),
        }

    # T13: shared cert + require + aggregate evaluation (used by both
    # stratum_parallel_done and stratum_parallel_poll). Mutates task_results
    # in place to flip cert-failed tasks → status="failed" (byte-identical to
    # the pre-extraction behavior).
    can_advance, evaluation = _evaluate_parallel_results(
        state, cur_step, task_results, merge_status=merge_status,
    )
    per_task_cert_strs = evaluation["per_task_cert_strs"]
    require = evaluation["require"]
    completed = evaluation["completed"]
    failed = evaluation["failed"]
    aggregate = evaluation["aggregate"]

    # Process through process_step_result (handles ensure, retries, on_fail)
    try:
        status, violations = process_step_result(state, step_id, aggregate)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    # If require or merge failed but ensure passed, we still need to fail
    if status == "ok" and aggregate["outcome"] == "failed":
        # Undo the advance — process_step_result already advanced current_idx
        # We need to treat this as an ensure failure
        # Revert: remove the output, decrement idx
        state.step_outputs.pop(step_id, None)
        state.current_idx = next(
            i for i, s in enumerate(state.ordered_steps) if s.id == step_id
        )
        # Pop the last record (the one just added)
        if state.records and state.records[-1].step_id == step_id:
            state.records.pop()

        max_retries = cur_step.step_retries or 2
        attempt = state.attempts.get(step_id, 0)

        if merge_status == "conflict":
            fail_reasons = ["merge conflict: merge_status='conflict'"]
        else:
            fail_reasons = [f"require='{require}' not satisfied: {len(completed)} completed, {len(failed)} failed"]
        # STRAT-CERT-PAR: append per-task cert violations so they surface on both merge-conflict
        # and require-failure paths.
        fail_reasons.extend(per_task_cert_strs)

        if attempt >= max_retries:
            if cur_step.on_fail:
                state.step_outputs[step_id] = aggregate
                from .executor import _find_step_idx, _clear_from
                target_idx = _find_step_idx(state, cur_step.on_fail)
                _clear_from(state, target_idx, preserve={step_id})
                state.current_idx = target_idx
                try:
                    next_step = get_current_step_info(state)
                    next_step = _apply_policy_loop(state, next_step)
                except MCPExecutionError as exc:
                    return {"status": "error", **exception_to_mcp_error(exc)}
                persist_flow(state)
                return {
                    **(next_step or {}),
                    "routed_from": step_id,
                    "violations": fail_reasons,
                }
            delete_persisted_flow(flow_id)
            return {
                "status": "error",
                "error_type": "retries_exhausted",
                "flow_id": flow_id,
                "step_id": step_id,
                "step_mode": "parallel_dispatch",
                "agent": cur_step.agent,
                "message": f"Step '{step_id}' exhausted all retries",
                "violations": fail_reasons,
            }

        # Retry available
        try:
            step_info = get_current_step_info(state)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **step_info,
            "status": "ensure_failed",
            "violations": fail_reasons,
        }

    # Standard status handling (same pattern as stratum_step_done)
    # STRAT-CERT-PAR: merge per-task cert violations into every failure-response path.
    if status == "retries_exhausted":
        delete_persisted_flow(flow_id)
        _step = state.ordered_steps[state.current_idx]
        return {
            "status": "error",
            "error_type": "retries_exhausted",
            "flow_id": flow_id,
            "step_id": step_id,
            "step_mode": _step_mode(_step),
            "agent": _step.agent,
            "message": f"Step '{step_id}' exhausted all retries",
            "violations": violations + per_task_cert_strs,
        }

    if status == "on_fail_routed":
        try:
            next_step = get_current_step_info(state)
            next_step = _apply_policy_loop(state, next_step)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **(next_step or {}),
            "routed_from": step_id,
            "violations": violations + per_task_cert_strs,
        }

    if status in ("ensure_failed", "schema_failed", "guardrail_blocked"):
        try:
            step_info = get_current_step_info(state)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **step_info,
            "status": status,
            "violations": violations + per_task_cert_strs,
        }

    # "ok" — flow advanced
    state.iteration_outcome.pop(step_id, None)
    try:
        next_step = get_current_step_info(state)
        next_step = _apply_policy_loop(state, next_step)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}
    if next_step is not None and next_step.get("status") == "complete":
        delete_persisted_flow(flow_id)
        return next_step
    if next_step is None:
        delete_persisted_flow(flow_id)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        output = next(
            (state.step_outputs[s.id] for s in reversed(state.ordered_steps)
             if s.id in state.step_outputs and state.step_outputs[s.id] is not None),
            None,
        )
        return {
            "status": state.terminal_status or "complete",
            "flow_id": state.flow_id,
            "output": output,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    persist_flow(state)
    return next_step


# ---------------------------------------------------------------------------
# T13: stratum_parallel_start + stratum_parallel_poll
# ---------------------------------------------------------------------------


def _resolve_dispatch_tasks(state: FlowState, step: Any) -> list[dict]:
    """Resolve the task list for a parallel_dispatch step.

    Follows the same resolution path as ``get_current_step_info`` so
    start-side task materialization matches what the dispatch object
    already advertised to the caller.
    """
    from .executor import resolve_ref
    assert step.source is not None, "parallel_dispatch step must have source"
    return list(resolve_ref(step.source, state.inputs, state.step_outputs) or [])


async def _advance_after_parallel(
    state: FlowState,
    step_id: str,
    aggregate: dict[str, Any],
) -> dict[str, Any]:
    """Run a completed parallel step's aggregate through process_step_result
    and return the next-step dispatch (or flow-complete payload).

    Mirrors the "ok" / non-ok handling in ``stratum_parallel_done`` — enough
    to cover the path taken by ``stratum_parallel_poll`` when all tasks
    settle. Errors surface as structured dicts, not exceptions.
    """
    try:
        status, violations = process_step_result(state, step_id, aggregate)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    if status == "retries_exhausted":
        delete_persisted_flow(state.flow_id)
        _step = state.ordered_steps[state.current_idx]
        return {
            "status": "error",
            "error_type": "retries_exhausted",
            "flow_id": state.flow_id,
            "step_id": step_id,
            "step_mode": _step_mode(_step),
            "agent": _step.agent,
            "message": f"Step '{step_id}' exhausted all retries",
            "violations": violations,
        }
    if status == "on_fail_routed":
        try:
            next_step = get_current_step_info(state)
            next_step = _apply_policy_loop(state, next_step)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **(next_step or {}),
            "routed_from": step_id,
            "violations": violations,
        }
    if status in ("ensure_failed", "schema_failed", "guardrail_blocked"):
        try:
            step_info = get_current_step_info(state)
        except MCPExecutionError as exc:
            return {"status": "error", **exception_to_mcp_error(exc)}
        persist_flow(state)
        return {
            **step_info,
            "status": status,
            "violations": violations,
        }
    # "ok" — flow advanced
    state.iteration_outcome.pop(step_id, None)
    try:
        next_step = get_current_step_info(state)
        next_step = _apply_policy_loop(state, next_step)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}
    if next_step is not None and next_step.get("status") == "complete":
        delete_persisted_flow(state.flow_id)
        return next_step
    if next_step is None:
        delete_persisted_flow(state.flow_id)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        output = next(
            (state.step_outputs[s.id] for s in reversed(state.ordered_steps)
             if s.id in state.step_outputs and state.step_outputs[s.id] is not None),
            None,
        )
        return {
            "status": state.terminal_status or "complete",
            "flow_id": state.flow_id,
            "output": output,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }
    persist_flow(state)
    return next_step


@mcp.tool(description=(
    "Start server-dispatched execution of a parallel_dispatch step. "
    "Inputs: flow_id (str), step_id (str). "
    "Spawns a ParallelExecutor that drives all tasks concurrently. "
    "Use stratum_parallel_poll to observe progress and advance the flow."
))
async def stratum_parallel_start(
    flow_id: str,
    step_id: str,
    ctx: Context,
) -> dict[str, Any]:
    import asyncio as _asyncio
    from .parallel_exec import DEFAULT_TASK_TIMEOUT, ParallelExecutor

    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    if state.current_idx >= len(state.ordered_steps):
        return {
            "error": "flow_complete",
            "message": "Flow is already complete",
        }

    cur_step = state.ordered_steps[state.current_idx]
    if cur_step.id != step_id:
        return {
            "error": "step_mismatch",
            "message": f"Expected step '{cur_step.id}', got '{step_id}'",
        }

    mode = _step_mode(cur_step)
    if mode != "parallel_dispatch":
        return {
            "error": "wrong_step_type",
            "message": (
                f"Step '{step_id}' is a {mode} step, not parallel_dispatch."
            ),
        }

    isolation = cur_step.isolation or "worktree"
    if isolation == "branch":
        return {
            "error": (
                "branch-mode isolation is not yet supported in server-side "
                "parallel dispatch (see roadmap T2-F5-BRANCH). Use "
                "'worktree' or 'none'."
            ),
        }

    # Reject re-start: any task already past pending means we're mid-flight or
    # finished; caller should use stratum_parallel_poll.
    already = [
        tid for tid, ts in state.parallel_tasks.items()
        if ts.state in ("running", "complete", "failed", "cancelled")
    ]
    if already or (flow_id, step_id) in _RUNNING_EXECUTORS:
        return {
            "error": "already_started",
            "message": (
                f"Step '{step_id}' already dispatched; use stratum_parallel_poll."
            ),
        }

    try:
        tasks = _resolve_dispatch_tasks(state, cur_step)
    except Exception as exc:
        return {
            "error": "source_resolution_failed",
            "message": f"Could not resolve tasks for step '{step_id}': {exc}",
        }
    if not tasks:
        return {
            "error": "no_tasks",
            "message": f"Step '{step_id}' source resolved to zero tasks.",
        }

    # Seed per-task state so a poll immediately after start sees entries.
    from .executor import ParallelTaskState as _PTS
    for t in tasks:
        tid = t["id"]
        if tid not in state.parallel_tasks:
            state.parallel_tasks[tid] = _PTS(task_id=tid)
    persist_flow(state)

    task_timeout = cur_step.task_timeout or DEFAULT_TASK_TIMEOUT

    executor = ParallelExecutor(
        state=state,
        step_id=step_id,
        tasks=tasks,
        max_concurrent=cur_step.max_concurrent or 3,
        isolation=isolation,
        task_timeout=task_timeout,
        agent=cur_step.agent,
        intent_template=cur_step.intent_template or "",
        task_reasoning_template=cur_step.task_reasoning_template,
        require=cur_step.require or "all",
        capture_diff=cur_step.capture_diff and isolation == "worktree",
        ctx=ctx,
    )
    handle = _asyncio.create_task(executor.run())
    _RUNNING_EXECUTORS[(flow_id, step_id)] = handle
    _PARALLEL_EXECUTORS[(flow_id, step_id)] = executor

    return {
        "status": "started",
        "flow_id": flow_id,
        "step_id": step_id,
        "task_count": len(tasks),
        "tasks": [t["id"] for t in tasks],
    }


@mcp.tool(description=(
    "Poll the state of a server-dispatched parallel_dispatch step. "
    "Inputs: flow_id (str), step_id (str). "
    "Returns a summary of per-task states and, once all tasks settle, "
    "advances the flow and includes the outcome. Safe to call at any cadence."
))
async def stratum_parallel_poll(
    flow_id: str,
    step_id: str,
    ctx: Context,
) -> dict[str, Any]:
    import asyncio as _asyncio
    # STRAT-PAR-STREAM: drain the executor's event queue under THIS poll's live
    # ctx. The parallel_start ctx that constructed the executor is long gone.
    executor = _PARALLEL_EXECUTORS.get((flow_id, step_id))
    if executor is not None:
        drained = 0
        while drained < 1000:
            try:
                ev = executor.events.get_nowait()
            except _asyncio.QueueEmpty:
                break
            try:
                await ctx.report_progress(progress=ev.seq, message=ev.to_json())
            except Exception:
                pass
            drained += 1

    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "error": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    # If the step has already advanced past parallel_dispatch (idempotent poll
    # after completion), we still want to report a sensible final view.
    step: Any = None
    for s in state.ordered_steps:
        if s.id == step_id:
            step = s
            break
    if step is None:
        return {
            "error": "unknown_step",
            "message": f"Step '{step_id}' not found in flow",
        }

    # Collect the per-task entries that belong to this step. ParallelExecutor
    # seeds them for every task in the step's task list at start time, so
    # "no entries" means start was never called.
    try:
        expected_task_ids = {t["id"] for t in _resolve_dispatch_tasks(state, step)}
    except Exception:
        expected_task_ids = set()
    ts_map = {
        tid: ts for tid, ts in state.parallel_tasks.items()
        if tid in expected_task_ids
    }
    if not ts_map:
        return {
            "error": (
                f"step '{step_id}' not dispatched yet; call "
                "stratum_parallel_start first"
            ),
        }

    # Build summary counts.
    summary = {"pending": 0, "running": 0, "complete": 0, "failed": 0, "cancelled": 0}
    for ts in ts_map.values():
        if ts.state in summary:
            summary[ts.state] += 1

    all_terminal = all(
        ts.state in ("complete", "failed", "cancelled") for ts in ts_map.values()
    )

    # Idempotent advance: only run process_step_result when (a) all tasks are
    # terminal AND (b) current_idx still points at this step. A prior poll
    # may have already advanced the flow — in that case we just report the
    # final state without re-running the aggregate through process_step_result.
    outcome: dict[str, Any] | None = None
    require_satisfied = False
    can_advance = False

    cur_step = None
    if state.current_idx < len(state.ordered_steps):
        cur_step = state.ordered_steps[state.current_idx]

    step_still_pending = (cur_step is not None and cur_step.id == step_id)

    if all_terminal:
        # Convert ParallelTaskState entries → done-style task_results.
        task_results = [
            {
                "task_id": tid,
                "result": ts.result,
                "status": "complete" if ts.state == "complete" else "failed",
            }
            for tid, ts in ts_map.items()
        ]
        # cert validation on poll-side results is a no-op (the executor has
        # already flipped cert-failed tasks to state="failed"), but running
        # the shared helper keeps aggregate construction in one place.
        can_advance, evaluation = _evaluate_parallel_results(
            state, step, task_results, merge_status="clean",
        )
        require_satisfied = evaluation["require_satisfied"]

        if step_still_pending:
            if getattr(step, "defer_advance", False):
                # T2-F5-DEFER-ADVANCE: hold advance for consumer. Leave
                # _RUNNING_EXECUTORS in place; stratum_parallel_advance pops
                # it on successful advance.
                outcome = {
                    "status": "awaiting_consumer_advance",
                    "aggregate": evaluation["aggregate"],
                }
            else:
                advance_result = await _advance_after_parallel(
                    state, step_id, evaluation["aggregate"],
                )
                outcome = advance_result
                # If the flow advanced, drop the executor handle from the
                # registry so we don't double-advance on subsequent polls.
                _RUNNING_EXECUTORS.pop((flow_id, step_id), None)
                # STRAT-PAR-STREAM: drain any final tail events left in the
                # queue after task termination but before we pop the executor.
                final_exec = _PARALLEL_EXECUTORS.pop((flow_id, step_id), None)
                if final_exec is not None:
                    while True:
                        try:
                            ev = final_exec.events.get_nowait()
                        except _asyncio.QueueEmpty:
                            break
                        try:
                            await ctx.report_progress(progress=ev.seq, message=ev.to_json())
                        except Exception:
                            pass
        else:
            # Already advanced — report the aggregate without re-processing.
            outcome = {
                "status": "already_advanced",
                "aggregate": evaluation["aggregate"],
            }
    # Build tasks serialization.
    tasks_out = {tid: dataclasses.asdict(ts) for tid, ts in ts_map.items()}

    return {
        "flow_id": flow_id,
        "step_id": step_id,
        "summary": summary,
        "tasks": tasks_out,
        "require_satisfied": require_satisfied,
        "can_advance": can_advance,
        "outcome": outcome,
    }


@mcp.tool(description=(
    "Advance a parallel_dispatch step whose spec declared defer_advance: true. "
    "Inputs: flow_id (str), step_id (str), merge_status ('clean' | 'conflict'). "
    "Call after observing 'awaiting_consumer_advance' from stratum_parallel_poll. "
    "Feeds merge_status into _evaluate_parallel_results and advances the flow. "
    "Idempotent: returns {status: 'already_advanced', step_id} if the flow has "
    "already moved past step_id."
))
async def stratum_parallel_advance(
    flow_id: str,
    step_id: str,
    merge_status: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {"error": "flow_not_found", "message": f"No active flow with id '{flow_id}'"}
        _flows[flow_id] = state

    # STRAT-IMMUTABLE gate — mirrors stratum_parallel_done / stratum_step_done
    _flow_def = state.spec.flows.get(state.flow_name)
    if _flow_def is not None:
        _integrity_err = verify_spec_integrity(_flow_def, state)
        if _integrity_err is not None:
            return _integrity_err

    step = next((s for s in state.ordered_steps if s.id == step_id), None)
    if step is None:
        return {"error": "unknown_step", "message": f"Step '{step_id}' not found in flow"}
    if getattr(step, "step_type", None) != "parallel_dispatch":
        return {"error": "wrong_step_type", "message": f"Step '{step_id}' is not a parallel_dispatch step"}
    if not getattr(step, "defer_advance", False):
        return {
            "error": "advance_not_deferred",
            "message": (
                f"Step '{step_id}' does not have defer_advance: true. "
                f"Auto-advance fires from stratum_parallel_poll; this tool is a no-op."
            ),
        }
    if merge_status not in ("clean", "conflict"):
        return {
            "error": "invalid_merge_status",
            "message": f"merge_status must be 'clean' or 'conflict', got {merge_status!r}",
        }

    # Idempotency check — if the flow has moved past this step, return minimal envelope
    cur_step = None
    if state.current_idx < len(state.ordered_steps):
        cur_step = state.ordered_steps[state.current_idx]
    if cur_step is None or cur_step.id != step_id:
        return {"status": "already_advanced", "step_id": step_id}

    # Verify all tasks are terminal
    try:
        expected_task_ids = {t["id"] for t in _resolve_dispatch_tasks(state, step)}
    except Exception:
        expected_task_ids = set()
    ts_map = {
        tid: ts for tid, ts in state.parallel_tasks.items()
        if tid in expected_task_ids
    }
    if not ts_map:
        return {
            "error": "step_not_dispatched",
            "message": f"Step '{step_id}' not dispatched yet; call stratum_parallel_start first",
        }
    if not all(ts.state in ("complete", "failed", "cancelled") for ts in ts_map.values()):
        return {
            "error": "tasks_not_terminal",
            "message": (
                f"Step '{step_id}' still has running tasks. "
                f"Poll until outcome.status == 'awaiting_consumer_advance' before calling advance."
            ),
        }

    # Advance
    task_results = [
        {
            "task_id": tid,
            "result": ts.result,
            "status": "complete" if ts.state == "complete" else "failed",
        }
        for tid, ts in ts_map.items()
    ]
    _, evaluation = _evaluate_parallel_results(
        state, step, task_results, merge_status=merge_status,
    )
    advance_result = await _advance_after_parallel(
        state, step_id, evaluation["aggregate"],
    )
    _RUNNING_EXECUTORS.pop((flow_id, step_id), None)
    _PARALLEL_EXECUTORS.pop((flow_id, step_id), None)
    return advance_result


@mcp.tool(description=(
    "Return execution trace for a flow. "
    "Input: flow_id (str) from stratum_plan. "
    "Returns step-by-step trace with attempt counts and durations."
))
async def stratum_audit(flow_id: str, ctx: Context) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    return _build_audit_snapshot(state)


def _build_audit_snapshot(state: FlowState) -> dict[str, Any]:
    """Build a full audit snapshot from a FlowState.

    Used by stratum_audit and by flow composition to capture child flow audits
    before deletion.
    """
    total_ms = int((time.monotonic() - state.flow_start) * 1000)
    is_complete = state.current_idx >= len(state.ordered_steps)

    if state.terminal_status == "killed":
        flow_status = "killed"
    elif is_complete:
        flow_status = "complete"
    else:
        flow_status = "in_progress"

    return {
        "flow_id": state.flow_id,
        "flow_name": state.flow_name,
        "status": flow_status,
        "steps_completed": len(state.records),
        "total_steps": len(state.ordered_steps),
        "trace": [dataclasses.asdict(r) for r in state.records],
        "total_duration_ms": total_ms,
        "round": state.round,
        "rounds": [{"round": i, "steps": r} for i, r in enumerate(state.rounds)],
        "iterations": {
            sid: [
                {k: v for k, v in entry.items() if k != "result"}
                for entry in entries
            ]
            for sid, entries in state.iterations.items()
        },
        "archived_iterations": [
            {
                sid: [
                    {k: v for k, v in entry.items() if k != "result"}
                    for entry in entries
                ]
                for sid, entries in archive.items()
            }
            for archive in state.archived_iterations
        ],
        "child_audits": state.child_audits,
    }


@mcp.tool(description=(
    "Resolve a gate step in a flow (IR v0.2). "
    "Inputs: flow_id (str), step_id (str, must be the current gate step), "
    "outcome (str: 'approve' | 'revise' | 'kill'), "
    "rationale (str, human-readable reason), "
    "resolved_by (str: 'human' | 'agent' | 'system'). "
    "approve routes to on_approve target (or completes the flow if null). "
    "revise archives the current round and routes to on_revise target. "
    "kill routes to on_kill target (or terminates the flow if null). "
    "Returns next step to execute, status: complete, or status: killed."
))
async def stratum_gate_resolve(
    flow_id: str,
    step_id: str,
    outcome: str,
    rationale: str,
    resolved_by: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    # Reject if current step is not a gate step (before resolve_gate mutates state)
    if state.current_idx >= len(state.ordered_steps):
        return {
            "status": "error",
            "error_type": "flow_already_complete",
            "message": "Flow is already complete",
        }
    current_step = state.ordered_steps[state.current_idx]
    current_fn = state.spec.functions.get(current_step.function)
    if current_fn is None or current_fn.mode != "gate":
        return {
            "status": "error",
            "error_type": "not_a_gate_step",
            "message": f"Step '{current_step.id}' is not a gate step",
        }

    result_status, extra = resolve_gate(state, step_id, outcome, rationale, resolved_by)

    if result_status == "error":
        return {"status": "error", **extra}

    if result_status == "complete":
        # Finding 2: synthetic flows must not have their flow JSON deleted here —
        # they are torn down by stratum_goal_archive (Phase D). Pass synthetic= so
        # delete_persisted_flow skips only the judge-tree cleanup for synthetic flows;
        # the flow JSON itself is also preserved by adding the guard below.
        _is_synthetic = getattr(state, "synthetic", False)
        if not _is_synthetic:
            delete_persisted_flow(flow_id, synthetic=False)
        else:
            # Synthetic flows skip deletion but MUST persist the updated state
            # (current_idx advanced to terminal) so that stratum_goal_status
            # reads the correct terminal status after a process restart.
            persist_flow(state)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        output = next(
            (state.step_outputs[s.id] for s in reversed(state.ordered_steps)
             if s.id in state.step_outputs and state.step_outputs[s.id] is not None),
            None,
        )
        return {
            "status": "complete",
            "flow_id": flow_id,
            "output": output,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    if result_status == "killed":
        _is_synthetic = getattr(state, "synthetic", False)
        if not _is_synthetic:
            delete_persisted_flow(flow_id, synthetic=False)
        else:
            # Same as complete: persist the terminal state for synthetic flows.
            persist_flow(state)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        return {
            "status": "killed",
            "flow_id": flow_id,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    if result_status == "max_rounds_exceeded":
        # GateRecord was written to state.records but not archived; persist the updated state.
        persist_flow(state)
        return {"status": "error", **extra}

    # "execute_step" — route to the target step; persist AFTER get_current_step_info
    # in case the routed-to step has skip_if that fires (mutating state).
    next_step = get_current_step_info(state)
    next_step = _apply_policy_loop(state, next_step)
    if next_step is not None and next_step.get("status") == "complete":
        delete_persisted_flow(flow_id)
        return next_step
    persist_flow(state)
    return next_step


@mcp.tool(description=(
    "Check whether any pending gate step in a flow has exceeded its timeout (IR v0.2). "
    "Input: flow_id (str). "
    "If the current gate step has a timeout configured and the timeout has expired, "
    "fires an auto-kill with resolved_by: system following the same on_kill routing "
    "as an explicit kill outcome. "
    "Returns the same response shapes as stratum_gate_resolve: execute_step, killed, or "
    "status: no_timeout when no gate is pending or the timeout has not expired."
))
async def stratum_check_timeouts(flow_id: str, ctx: Context) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    if state.current_idx >= len(state.ordered_steps):
        return {"status": "no_timeout", "message": "Flow is already complete"}

    current_step = state.ordered_steps[state.current_idx]
    fn_def = state.spec.functions.get(current_step.function)

    if fn_def is None or fn_def.mode != "gate":
        return {"status": "no_timeout", "message": "Current step is not a gate step"}

    if fn_def.timeout is None:
        return {"status": "no_timeout", "message": "Gate has no timeout configured"}

    dispatched = state.dispatched_at.get(current_step.id)
    if dispatched is None:
        return {"status": "no_timeout", "message": "Gate not yet dispatched"}

    elapsed = time.time() - dispatched
    if elapsed < fn_def.timeout:
        return {
            "status": "no_timeout",
            "remaining_seconds": fn_def.timeout - elapsed,
        }

    # Timeout expired — auto-kill with resolved_by=system
    result_status, extra = resolve_gate(
        state, current_step.id, "kill", "timeout", "system"
    )

    if result_status == "error":
        return {"status": "error", **extra}

    if result_status == "killed":
        delete_persisted_flow(flow_id)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        return {
            "status": "killed",
            "flow_id": flow_id,
            "reason": "timeout",
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    if result_status == "execute_step":
        next_step = get_current_step_info(state)  # may skip; persist after
        next_step = _apply_policy_loop(state, next_step)
        if next_step is not None and next_step.get("status") == "complete":
            delete_persisted_flow(flow_id)
            return next_step
        persist_flow(state)
        return next_step

    return {"status": "error", "message": f"Unexpected gate result: {result_status}"}


@mcp.tool(description=(
    "Explicitly skip the current step in a flow. "
    "Inputs: flow_id (str), step_id (str, must be the current step), "
    "reason (str, recorded in audit trail). "
    "Cannot skip gate steps — use stratum_gate_resolve instead. "
    "Returns next step to execute or flow completion."
))
async def stratum_skip_step(
    flow_id: str,
    step_id: str,
    reason: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    try:
        skip_step(state, step_id, reason)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    try:
        next_info = get_current_step_info(state)
        next_info = _apply_policy_loop(state, next_info)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    if next_info is not None and next_info.get("status") == "complete":
        delete_persisted_flow(flow_id)
        return next_info
    if next_info is None:
        delete_persisted_flow(flow_id)
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        output = next(
            (state.step_outputs[s.id] for s in reversed(state.ordered_steps)
             if s.id in state.step_outputs and state.step_outputs[s.id] is not None),
            None,
        )
        return {
            "status": state.terminal_status or "complete",
            "flow_id": state.flow_id,
            "output": output,
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    persist_flow(state)
    return next_info


# ---------------------------------------------------------------------------
# Per-step iteration tools (STRAT-ENG-4)
# ---------------------------------------------------------------------------

@mcp.tool(description=(
    "Start an iteration loop on the current step. "
    "Inputs: flow_id (str), step_id (str, must be the current step). "
    "The step must have max_iterations defined in the spec. "
    "Returns iteration_started with max_iterations and exit_criterion."
))
async def stratum_iteration_start(
    flow_id: str,
    step_id: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    try:
        result = start_iteration(state, step_id)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    return result


@mcp.tool(description=(
    "Report one iteration result. Evaluates exit_criterion, increments count, "
    "checks max_iterations. "
    "Inputs: flow_id (str), step_id (str), result (dict). "
    "Returns iteration_continue or iteration_exit with outcome."
))
async def stratum_iteration_report(
    flow_id: str,
    step_id: str,
    result: dict[str, Any],
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    try:
        response = report_iteration(state, step_id, result)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    return response


@mcp.tool(description=(
    "Tiered judge for self-correction loops (STRAT-JUDGE v1). "
    "T1 evaluates deterministic predicates against staged artifacts; T2 dispatches a "
    "Claude verifier with read-only tools and citation-format enforcement. Returns a "
    "JudgeResult that supersets CrossModelReviewResult — existing review consumers read "
    "it unchanged. v1: T1 + T2 only; Claude-backed T2; user-supplied predicates; no "
    "SmartMemory wiring. "
    "Inputs: flow_id (str), step_id (str), predicates (list[dict] with id/type/statement), "
    "artifacts (dict[str, str]), modified_files (list[str], optional), "
    "stakes ('cheap'|'default'|'paranoid', default 'default'; paranoid adds the T3 cold-read adversary), budget (dict, optional). "
    "Returns the JudgeResult dict (validates against compose/contracts/judge-result.json)."
))
async def stratum_judge(
    flow_id: str,
    step_id: str,
    predicates: list[dict],
    artifacts: dict[str, str],
    ctx: Context,
    modified_files: Optional[list[str]] = None,
    stakes: str = "default",
    budget: Optional[dict] = None,
) -> dict[str, Any]:
    from stratum.judge import (
        BudgetCaps,
        JudgeError,
        Predicate,
    )
    from stratum.judge.kernel import run_judge

    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    # STRAT-IMMUTABLE: spec-level integrity check FIRST — confirms the
    # persisted spec has not been tampered with since flow creation. Matches
    # the pattern at server.py:370 (stratum_step_done), server.py:632
    # (stratum_parallel_done), server.py:1225 (other entry points).
    # Without this, a mutated raw_spec/state.spec could redefine the judge:
    # block in a way that still passes the per-step mismatch checks below.
    flow_def = state.spec.flows.get(state.flow_name)
    if flow_def is not None:
        integrity_err = verify_spec_integrity(flow_def, state)
        if integrity_err is not None:
            return integrity_err

    # STRAT-IMMUTABLE enforcement: when the flow has a current judge: step,
    # the caller MUST be invoking that step with the IR-declared payload —
    # not arbitrary predicates/stakes/budget of their own choosing. Otherwise
    # a caller can weaken the gate the flow declared.
    current_step = None
    if state.current_idx is not None and 0 <= state.current_idx < len(state.ordered_steps):
        current_step = state.ordered_steps[state.current_idx]
    if current_step is None or current_step.id != step_id:
        return {
            "status": "error",
            "error_type": "step_mismatch",
            "message": (
                f"step_id '{step_id}' is not the current judge step "
                f"(current: {current_step.id if current_step else None})"
            ),
        }
    if current_step.judge is None:
        return {
            "status": "error",
            "error_type": "not_a_judge_step",
            "message": f"step '{step_id}' is not declared as a judge step",
        }
    # Enforce that the caller's payload matches the IR declaration. Compare
    # canonicalized forms — the spec's JudgeStepConfig may hold tuples while
    # callers send lists.
    ir_predicates = [dict(p) for p in current_step.judge.predicates]
    if list(predicates) != ir_predicates:
        return {
            "status": "error",
            "error_type": "predicates_mismatch",
            "message": "predicates payload does not match the flow's judge: declaration",
        }
    if stakes != current_step.judge.stakes:
        return {
            "status": "error",
            "error_type": "stakes_mismatch",
            "message": (
                f"stakes '{stakes}' does not match IR declaration "
                f"'{current_step.judge.stakes}'"
            ),
        }
    if (budget or None) != (current_step.judge.budget or None):
        return {
            "status": "error",
            "error_type": "budget_mismatch",
            "message": "budget payload does not match the flow's judge: declaration",
        }

    try:
        parsed_predicates = [Predicate(**p) for p in predicates]
    except TypeError as exc:
        return {
            "status": "error",
            "error_type": "invalid_predicate",
            "message": f"failed to parse predicate dict: {exc}",
        }

    parsed_budget = _parse_budget(budget)
    workspace_root = Path(state.cwd or os.getcwd())

    try:
        result = await run_judge(
            flow_id=flow_id,
            step_id=step_id,
            predicates=parsed_predicates,
            artifacts=artifacts,
            modified_files=list(modified_files or []),
            stakes=stakes,
            budget=parsed_budget,
            workspace_root=workspace_root,
            stratum_agent_run=stratum_agent_run,
            ctx=ctx,
        )
    except JudgeError as exc:
        return {
            "status": "error",
            "error_type": exc.__class__.__name__,
            "message": str(exc),
        }

    # Runtime contract validation at the MCP boundary — catches result-shape
    # regressions even when unit tests miss them. MUST run before persistence
    # so a regressed result never lands in FlowState or on disk; otherwise the
    # "containment" check becomes a "state-corruption-after-warning".
    result_dict = result.to_dict()
    try:
        _validate_judge_result(result_dict)
    except Exception as exc:  # noqa: BLE001 — surface any validator failure
        return {
            "status": "error",
            "error_type": "schema_validation_failed",
            "message": f"JudgeResult failed contract validation: {exc}",
        }

    state.record_judge_turn(step_id, result)
    persist_flow(state)
    return result_dict


_JUDGE_RESULT_VALIDATOR = None


def _validate_judge_result(result_dict: dict) -> None:
    """Validate a JudgeResult dict against compose/contracts/judge-result.json.
    Lazy-builds the validator on first use; reuses across calls."""
    global _JUDGE_RESULT_VALIDATOR
    if _JUDGE_RESULT_VALIDATOR is None:
        import json
        from jsonschema import Draft7Validator
        from referencing import Registry, Resource

        contracts_dir = (
            Path(__file__).resolve().parents[4] / "compose" / "contracts"
        )
        resources = []
        for name in (
            "review-result.json",
            "cross-model-review-result.json",
            "judge-result.json",
        ):
            contents = json.loads((contracts_dir / name).read_text())
            resources.append((name, Resource.from_contents(contents)))
        registry = Registry().with_resources(resources)
        schema = json.loads((contracts_dir / "judge-result.json").read_text())
        _JUDGE_RESULT_VALIDATOR = Draft7Validator(schema, registry=registry)
    errors = list(_JUDGE_RESULT_VALIDATOR.iter_errors(result_dict))
    if errors:
        raise ValueError("; ".join(e.message for e in errors[:3]))


def _parse_budget(budget: Optional[dict]):
    """Parse a runtime budget dict into a ``stratum.judge.BudgetCaps``.

    ``None`` and empty dicts return ``None`` (= no budget). Unknown keys
    are ignored; missing keys default to ``None`` (= no cap on that axis).
    Imported lazily so importing this module doesn't require the
    ``stratum.judge`` package at import time.
    """
    if not budget:
        return None
    from stratum.judge import BudgetCaps
    return BudgetCaps(
        max_turns=budget.get("max_turns"),
        max_dollars=budget.get("max_dollars"),
        max_wall_clock_s=budget.get("max_wall_clock_s"),
    )


# ---------------------------------------------------------------------------
# STRAT-GOAL v1 — stratum_goal / stratum_goal_status / stratum_goal_decide /
#                  stratum_goal_archive
# ---------------------------------------------------------------------------

# Process-level singleton for the SmartMemory search callable.
# Built once on first stratum_goal invocation; None when SmartMemory is absent.
_SMART_MEMORY_SEARCH: Any = "unset"  # sentinel so None means "absent, already checked"


def _build_smart_memory_search():
    """Return a SmartMemory search callable, or None when unavailable.

    Imported lazily so this module stays importable without SmartMemory installed.
    Guards both the import and the instantiation: SmartMemory raises on __init__
    when the graph-DB config is missing, so we treat any exception as "absent".
    """
    try:
        from smartmemory.smart_memory import SmartMemory  # type: ignore[import]
        sm = SmartMemory()
        return sm.search
    except Exception:  # noqa: BLE001 — ImportError, KeyError, AttributeError, …
        return None


def _goal_awaiting_since_ms(goal_state) -> Optional[int]:
    """Return the timestamp (ms) when the goal entered awaiting_decision, or None.

    Reads the last decision_gates entry's registered_at_ms if available,
    otherwise falls back to None (stale check is skipped).
    """
    if not goal_state.decision_gates:
        return None
    last = goal_state.decision_gates[-1]
    return getattr(last, "registered_at_ms", None)


@mcp.tool(description=(
    "STRAT-GOAL v1: Worker→judge orchestrator. "
    "Accepts a predicate list and a task description; dispatches a worker agent, "
    "stages outputs, runs the STRAT-JUDGE kernel, and retries until predicates are met "
    "or budget is exhausted. "
    "Modes: shadow (observe without binding), advisory (pause for human on met), "
    "autonomous (auto-bind predicate classes whitelisted by autonomy gate). "
    "Inputs: goal_id (str, stable caller-supplied ID), predicates (list[dict] with "
    "id/type/statement/applied_gate), mode ('shadow'|'advisory'|'autonomous'), "
    "prompt (str, initial worker task), "
    "decomposer ('user'|'auto'|'hybrid', default 'user'; 'auto' decomposes the "
    "prompt into predicates via the LLM decomposer on a fresh goal — supply an "
    "empty predicates list; 'hybrid' = use stratum_decompose then pass the "
    "edited list back here; 'ask' is a skill-layer concept and is rejected), "
    "artifact_contract (list[dict], optional), "
    "worker (dict, optional passthrough to stratum_agent_run), "
    "stakes ('cheap'|'default'|'paranoid', default 'default'; paranoid adds the T3 cold-read adversary), budget (dict, optional: "
    "{max_turns, max_dollars, max_wall_clock_s}), autonomy (dict, optional per-call "
    "override: {deterministic, verified, judged} → bool), "
    "shadow_source ('driven'|'observed', default 'driven'), "
    "observed_artifacts (dict[str,str], required when shadow_source='observed'), "
    "observed_modified_files (list[str], optional). "
    "Returns GoalResult dict (superset of JudgeResult). "
    "Repeat calls with the same goal_id resume the prior loop; predicates/mode are "
    "immutable after first call (GoalImmutabilityError on mismatch)."
))
async def stratum_goal(
    goal_id: str,
    predicates: list[dict],
    mode: str,
    ctx: Context,
    prompt: Optional[str] = None,
    decomposer: str = "user",
    artifact_contract: Optional[list[dict]] = None,
    worker: Optional[dict] = None,
    stakes: str = "default",
    budget: Optional[dict] = None,
    autonomy: Optional[dict] = None,
    shadow_source: str = "driven",
    observed_artifacts: Optional[dict[str, str]] = None,
    observed_modified_files: Optional[list[str]] = None,
) -> dict[str, Any]:
    global _SMART_MEMORY_SEARCH
    from stratum.goal.errors import (
        AutoCheapMismatch,
        AutoPredicatesConflict,
        DecomposeFailed,
        GoalError,
        InvalidDecomposerError,
    )
    from stratum.goal.orchestrator import run_goal
    from stratum.goal.worker import dispatch_worker
    from stratum.judge.kernel import run_judge
    from stratum.judge.result import Predicate

    # Cache the SmartMemory callable at process level (built once, reused).
    if _SMART_MEMORY_SEARCH == "unset":
        _SMART_MEMORY_SEARCH = _build_smart_memory_search()
    sm_callable = _SMART_MEMORY_SEARCH

    # Validate decomposer at the boundary BEFORE predicate parsing so the
    # invalid_decomposer contract is not order-dependent on payload validity
    # ('ask' is a skill-layer concept, rejected here).
    if decomposer not in ("user", "auto", "hybrid"):
        return {
            "status": "error",
            "error_type": "invalid_decomposer",
            "message": (
                f"decomposer={decomposer!r} is invalid; expected one of "
                "'user'|'auto'|'hybrid' ('ask' is a skill-layer concept)."
            ),
        }

    # Parse list[dict] → list[Predicate]
    try:
        parsed_predicates = [Predicate(**p) for p in predicates]
    except TypeError as exc:
        return {
            "status": "error",
            "error_type": "invalid_predicate",
            "message": f"Failed to parse predicate: {exc}",
        }

    # Finding 1: bind stratum_agent_run as arg-0 of dispatch_worker so the
    # orchestrator can call dispatch_worker_callable(prompt, worker_spec, corr_id, ctx=ctx)
    # without knowing about the injected stratum_agent_run_callable.
    import functools as _functools
    wired_dispatch_worker = _functools.partial(dispatch_worker, stratum_agent_run)

    try:
        result = await run_goal(
            goal_id=goal_id,
            predicates=parsed_predicates,
            mode=mode,
            dispatch_worker_callable=wired_dispatch_worker,
            run_judge_callable=run_judge,
            stratum_agent_run_callable=stratum_agent_run,
            stratum_gate_resolve_callable=stratum_gate_resolve,
            smart_memory_search_callable=sm_callable,
            ctx=ctx,
            prompt=prompt,
            decomposer=decomposer,
            artifact_contract=artifact_contract,
            worker_spec=worker,
            stakes=stakes,
            budget=budget,
            autonomy=autonomy,
            shadow_source=shadow_source,
            observed_artifacts=observed_artifacts,
            observed_modified_files=observed_modified_files,
        )
    except (
        DecomposeFailed,
        AutoPredicatesConflict,
        AutoCheapMismatch,
        InvalidDecomposerError,
    ) as exc:
        # Explicit snake_case contract strings (the generic handler below would
        # emit the PascalCase class name via type(exc).__name__).
        return {
            "status": "error",
            "error_type": exc.error_type,
            "message": str(exc),
        }
    except GoalError as exc:
        return {
            "status": "error",
            "error_type": type(exc).__name__,
            "message": str(exc),
        }

    return result.to_dict()


@mcp.tool(description=(
    "STRAT-JUDGE v2: Stateless LLM predicate decomposer (the 'hybrid' phase-1 "
    "primitive). Turns a prose task description into a draft predicate list so "
    "a caller can present it, let the user edit, then pass the final list to "
    "stratum_goal. Also usable to preview an 'auto' draft before committing. "
    "No flow state, no persistence. Inputs: prompt (str, the task prose), "
    "work_context (str, optional extra context), model (str, optional litellm "
    "model id; default claude-haiku-4-5). Returns "
    "{predicates: list[dict {id,type,statement,applied_gate}], applied: bool, "
    "reason: str, model: str}. Fail-open: applied=false with empty predicates "
    "and a reason on any LLM/parse failure — never fabricated predicates; the "
    "caller must not proceed to stratum_goal on applied=false."
))
async def stratum_decompose(
    prompt: str,
    ctx: Context,
    work_context: str = "",
    model: Optional[str] = None,
) -> dict[str, Any]:
    import asyncio
    import dataclasses

    from stratum.judge.postmortem.decompose import (
        DEFAULT_DECOMPOSE_MODEL,
        LiteLLMDecomposer,
    )

    dec = LiteLLMDecomposer(model or DEFAULT_DECOMPOSE_MODEL)
    res = await asyncio.to_thread(dec.decompose, prompt, work_context)
    return {
        "predicates": [dataclasses.asdict(p) for p in res.predicates],
        "applied": res.applied,
        "reason": res.reason,
        "model": res.model,
    }


@mcp.tool(description=(
    "STRAT-GOAL v1: Read-only status surface for a running or paused goal. "
    "Does NOT advance the loop. "
    "Returns a status envelope shaped like GoalResult: "
    "status, goal_version, mode, turns_run, worker_runs, round, predicate_outcomes, "
    "decision_gates, and stale. "
    "Does NOT include the full judge findings/meta of an active GoalResult — "
    "for the complete GoalResult call stratum_goal (which advances the loop). "
    "Status values: 'met' | 'not_met' | 'awaiting_decision' | 'budget_exhausted' | "
    "'killed' | 'in_progress' (goal started but no terminal condition yet). "
    "Returns {status:'error', error_type:'GoalNotFoundError'} for an unknown goal_id. "
    "Sets stale:true when the goal has been in awaiting_decision for >24h (PRD S3)."
))
async def stratum_goal_status(
    goal_id: str,
    ctx: Context,
) -> dict[str, Any]:
    from stratum.goal.errors import GoalNotFoundError
    from stratum.goal.state import restore_goal_state
    from stratum_mcp.executor import restore_flow

    # Load GoalState
    try:
        goal_state = restore_goal_state(goal_id)
    except FileNotFoundError:
        return {
            "status": "error",
            "error_type": "GoalNotFoundError",
            "message": f"No goal found with id '{goal_id}'",
        }

    # Load FlowState
    flow_state = restore_flow(goal_id)
    if flow_state is None:
        return {
            "status": "error",
            "error_type": "GoalNotFoundError",
            "message": f"No flow state found for goal '{goal_id}'",
        }

    # Derive status from FlowState (no sticky GoalState.status — design.md Decision 5).
    # "running" is NOT a valid GoalResult contract status; use "in_progress" for any
    # in-flight goal that hasn't reached a terminal step or awaiting_decision.
    if flow_state.terminal_status == "killed":
        status = "killed"
    elif flow_state.terminal_status == "budget_exhausted":
        status = "budget_exhausted"
    elif flow_state.current_idx >= len(flow_state.ordered_steps):
        status = "met"
    else:
        current_step = flow_state.ordered_steps[flow_state.current_idx]
        if current_step.id == "goal_decision":
            status = "awaiting_decision"
        else:
            status = "in_progress"

    # Stale detection (PRD S3): >24h in awaiting_decision
    stale = False
    if status == "awaiting_decision":
        since_ms = _goal_awaiting_since_ms(goal_state)
        if since_ms is not None:
            elapsed_s = (time.time() * 1000 - since_ms) / 1000
            stale = elapsed_s > 24 * 3600

    # Build gate history joining records + rounds + decision_gates
    all_gate_records = []
    # Archived rounds
    for round_records in flow_state.rounds:
        if isinstance(round_records, list):
            for rec in round_records:
                if isinstance(rec, dict) and rec.get("type") == "gate":
                    all_gate_records.append(rec)
    # Current round records
    for rec in flow_state.records:
        import dataclasses as _dc
        rec_dict = _dc.asdict(rec) if hasattr(rec, "__dataclass_fields__") else rec
        if rec_dict.get("type") == "gate":
            all_gate_records.append(rec_dict)

    # Synthesise worker_runs from GoalState.turns so the envelope matches the
    # GoalResult contract shape (required field: list of {turn, agent_correlation_id,
    # duration_ms} objects).
    worker_runs = [
        {
            "turn": t.turn,
            "agent_correlation_id": t.agent_correlation_id,
            "duration_ms": t.duration_ms,
        }
        for t in goal_state.turns
    ]

    # Synthesise lightweight predicate_outcomes from the latest turn's judge summary
    # when available; otherwise fall back to ambiguous placeholders keyed by predicate
    # id.  This satisfies the required field without re-running the judge.
    #
    # Per-predicate map built from predicate_results so that per-predicate fields
    # (verdict, confidence) are sourced from the correct place rather than the
    # non-existent top-level "confidence" key on the turn summary.
    # bound_autonomously reflects the actual autonomy allowlist (goal_state.autonomy
    # is a dict keyed by predicate type → bool), not a hardcoded False.
    latest_judge_summary: dict = {}
    if goal_state.turns:
        latest_judge_summary = goal_state.turns[-1].judge_result_summary or {}
    # Build per-predicate map: id → {verdict, confidence, ...}
    pred_map: dict[str, dict] = {}
    for pv in latest_judge_summary.get("predicate_results", []):
        pid = pv.get("id", "")
        pred_map[pid] = {
            "verdict": pv.get("verdict", "ambiguous"),
            "confidence": pv.get("confidence", 0),
        }

    autonomy_map: dict[str, bool] = goal_state.autonomy or {}
    predicate_outcomes = [
        {
            "id": p.get("id", ""),
            "type": p.get("type", "judged"),
            "verdict": pred_map.get(p.get("id", ""), {}).get("verdict", "ambiguous"),
            # confidence sourced per-predicate from predicate_results; default 0
            # (contract minimum is 1 for judged results, but 0 is the safe sentinel
            # for synthesised status responses that have not yet run the judge)
            "confidence": pred_map.get(p.get("id", ""), {}).get("confidence", 0),
            "applied_gate": p.get("applied_gate", 7),
            "judge_verdict": pred_map.get(p.get("id", ""), {}).get("verdict", "ambiguous"),
            # bound_autonomously: True iff this predicate type is on the allowlist AND
            # the judge verdict was "met".  Only ever True in autonomous mode.
            "bound_autonomously": (
                bool(autonomy_map.get(p.get("type", ""), False))
                and pred_map.get(p.get("id", ""), {}).get("verdict") == "met"
            ),
            "awaiting_human": status == "awaiting_decision",
        }
        for p in goal_state.predicates
    ]

    response: dict[str, Any] = {
        "goal_id": goal_id,
        "goal_version": "1.0",
        "mode": goal_state.mode,
        "status": status,
        "round": flow_state.round,
        "turns_run": len(goal_state.turns),
        "worker_runs": worker_runs,
        "predicate_outcomes": predicate_outcomes,
        "gate_history": all_gate_records,
        "decision_gates": [
            {
                "round": dg.round,
                "decision": dg.decision,
                "note": dg.note,
                "resolved_by": dg.resolved_by,
                # Codex Round-3 Finding 2b: include resolution metadata so callers
                # can see the full resolved state rather than stale "pending" fields.
                "outcome": dg.outcome,
                "resolved_at_ms": dg.resolved_at_ms,
                "rejection_note": dg.rejection_note,
                "registered_at_ms": dg.registered_at_ms,
            }
            for dg in goal_state.decision_gates
        ],
    }
    if stale:
        response["stale"] = True

    return response


@mcp.tool(description=(
    "STRAT-GOAL v1: Resolve an Advisory pause for a goal in awaiting_decision. "
    "Translates the human decision into a stratum_gate_resolve call: "
    "confirm → outcome=approve (goal completes), "
    "reject → outcome=revise (loop resumes; rejection note folded into next prompt), "
    "kill → outcome=kill (goal terminated). "
    "Returns the stratum_gate_resolve response, or "
    "{status:'error', error_type:'no_pending_decision'} when the goal is not paused. "
    "Inputs: goal_id (str), decision ('confirm'|'reject'|'kill'), "
    "note (str, human rationale; required on reject)."
))
async def stratum_goal_decide(
    goal_id: str,
    decision: str,
    ctx: Context,
    note: str = "",
) -> dict[str, Any]:
    from stratum.goal.errors import GoalNotFoundError, NoPendingDecisionError
    from stratum.goal.state import restore_goal_state
    from stratum_mcp.executor import restore_flow

    # Load GoalState and FlowState
    try:
        goal_state = restore_goal_state(goal_id)
    except FileNotFoundError:
        return {
            "status": "error",
            "error_type": "GoalNotFoundError",
            "message": f"No goal found with id '{goal_id}'",
        }

    flow_state = restore_flow(goal_id)
    if flow_state is None:
        return {
            "status": "error",
            "error_type": "GoalNotFoundError",
            "message": f"No flow state found for goal '{goal_id}'",
        }

    # Verify the goal is currently awaiting a decision
    if flow_state.current_idx >= len(flow_state.ordered_steps):
        return {
            "status": "error",
            "error_type": "no_pending_decision",
            "message": f"Goal '{goal_id}' is already complete — no pending decision.",
        }
    current_step = flow_state.ordered_steps[flow_state.current_idx]
    if current_step.id != "goal_decision":
        return {
            "status": "error",
            "error_type": "no_pending_decision",
            "message": (
                f"Goal '{goal_id}' is not awaiting a decision "
                f"(current step: '{current_step.id}')."
            ),
        }

    # Translate decision → gate outcome
    decision_map = {
        "confirm": "approve",
        "reject": "revise",
        "kill": "kill",
    }
    outcome = decision_map.get(decision)
    if outcome is None:
        return {
            "status": "error",
            "error_type": "invalid_decision",
            "message": f"decision must be 'confirm', 'reject', or 'kill'; got '{decision}'",
        }

    # Build rationale: thread note for reject
    if decision == "reject" and note:
        rationale = f"Human override: {note}"
    elif note:
        rationale = note
    else:
        rationale = f"Human {decision}"

    # Finding 4: store the rejection note onto the pending DecisionGateRecord so
    # the orchestrator can surface it in the next worker prompt via build_turn_prompt.
    if decision == "reject" and note:
        from stratum.goal.state import persist_goal_state as _persist_gs
        if goal_state.decision_gates:
            last_gate = goal_state.decision_gates[-1]
            last_gate.rejection_note = note
            _persist_gs(goal_state)

    # Call the public stratum_gate_resolve (handles persist/delete/policy routing)
    gate_result = await stratum_gate_resolve(
        flow_id=goal_id,
        step_id="goal_decision",
        outcome=outcome,
        rationale=rationale,
        resolved_by="human",
        ctx=ctx,
    )

    # Finding 3 (follow-up): persist the human verdict on the matching gate record
    # so callers can audit the final decision after a process restart.
    # Codex Round-3 Finding 2a: also update the 'decision' field to reflect the
    # resolved outcome so stratum_goal_status callers see the resolved value
    # (confirm→"approve", reject→"revise", kill→"kill") instead of stale "pending".
    if gate_result.get("status") not in ("error",) and goal_state.decision_gates:
        from stratum.goal.state import persist_goal_state as _persist_gs
        last_gate = goal_state.decision_gates[-1]
        if last_gate.outcome is None:
            last_gate.outcome = outcome       # "approve" | "revise" | "kill"
            last_gate.resolved_at_ms = int(time.time() * 1000)
        # Always sync 'decision' to the resolved outcome value so the status
        # surface never exposes stale "pending" after a decide call.
        last_gate.decision = outcome         # "approve" | "revise" | "kill"
        _persist_gs(goal_state)

    return gate_result


@mcp.tool(description=(
    "STRAT-GOAL v1: Archive (tear down) all persistence for a completed goal. "
    "Best-effort sequential cleanup of: "
    "~/.stratum/flows/<goal_id>.json, "
    "~/.stratum/judge/<goal_id>/, "
    "~/.stratum/goal/<goal_id>/. "
    "Idempotent — re-archiving a fully-removed goal returns {status:'already_archived'}. "
    "Returns {status:'complete', removed:[...]} on full success, "
    "{status:'partial', removed:[...], remaining:[...]} on partial failure, "
    "or {status:'already_archived'} when all paths were already absent."
))
async def stratum_goal_archive(
    goal_id: str,
    ctx: Context,
) -> dict[str, Any]:
    import shutil
    from stratum_mcp.executor import _FLOWS_DIR
    from stratum.judge.staging import JUDGE_ROOT
    from stratum.goal.state import _GOAL_ROOT_DEFAULT

    # Define the three cleanup targets
    flow_json = _FLOWS_DIR / f"{goal_id}.json"
    judge_dir = JUDGE_ROOT / goal_id
    goal_dir = _GOAL_ROOT_DEFAULT / goal_id

    targets = [
        ("flow_json", flow_json),
        ("judge_dir", judge_dir),
        ("goal_dir", goal_dir),
    ]

    # Evict the in-memory _flows entry unconditionally — pop is idempotent (default=None).
    # Done here, BEFORE any return path, so that even the already_archived early-return
    # does not leave a stale in-memory cache entry that could resurrect the goal.
    _flows.pop(goal_id, None)

    # Check whether any exist before we start (for already_archived detection)
    any_present = flow_json.exists() or judge_dir.exists() or goal_dir.exists()
    if not any_present:
        return {"status": "already_archived"}

    removed: list[str] = []
    remaining: list[str] = []

    # Sequential best-effort cleanup
    # Flow JSON: use delete_persisted_flow with synthetic=True so judge tree
    # cleanup is skipped (we handle judge_dir separately here for full control).
    if flow_json.exists():
        try:
            delete_persisted_flow(goal_id, synthetic=True)
            removed.append("flow_json")
        except Exception:
            remaining.append("flow_json")
    else:
        # Not present = already gone; counts as removed for idempotency
        removed.append("flow_json")

    if judge_dir.exists():
        try:
            shutil.rmtree(judge_dir, ignore_errors=False)
            removed.append("judge_dir")
        except Exception:
            remaining.append("judge_dir")
    else:
        removed.append("judge_dir")

    if goal_dir.exists():
        try:
            shutil.rmtree(goal_dir, ignore_errors=False)
            removed.append("goal_dir")
        except Exception:
            remaining.append("goal_dir")
    else:
        removed.append("goal_dir")

    if remaining:
        return {"status": "partial", "removed": removed, "remaining": remaining}
    return {"status": "complete", "removed": removed}


@mcp.tool(description=(
    "Abort an active iteration loop before completion. "
    "Inputs: flow_id (str), step_id (str), reason (str). "
    "Returns iteration_aborted with the current count."
))
async def stratum_iteration_abort(
    flow_id: str,
    step_id: str,
    reason: str,
    ctx: Context,
) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    try:
        response = abort_iteration(state, step_id, reason)
    except MCPExecutionError as exc:
        return {"status": "error", **exception_to_mcp_error(exc)}

    return response


@mcp.tool(description=(
    "Save a named checkpoint of the current flow state. "
    "Inputs: flow_id (str), label (str, e.g. 'after_analysis'). "
    "Snapshots step_outputs, attempts, records, and current_idx under the label. "
    "Call stratum_revert to roll back to this point if a later step fails."
))
async def stratum_commit(flow_id: str, label: str, ctx: Context) -> dict[str, Any]:
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    label = label.strip()
    if not label:
        return {
            "status": "error",
            "error_type": "invalid_label",
            "message": "label must be a non-empty string",
        }

    commit_checkpoint(state, label)
    is_complete = state.current_idx >= len(state.ordered_steps)
    current_step_id = (
        state.ordered_steps[state.current_idx].id
        if not is_complete
        else None
    )
    return {
        "status": "committed",
        "flow_id": flow_id,
        "label": label,
        "step_number": state.current_idx + 1,
        "current_step_id": current_step_id,
        "checkpoints": list(state.checkpoints.keys()),
    }


@mcp.tool(description=(
    "Roll back flow state to a previously committed checkpoint. "
    "Inputs: flow_id (str), label (str, must match a prior stratum_commit label). "
    "Restores step_outputs, attempts, records, and current_idx to the checkpoint. "
    "Returns the step to re-execute next, as if stratum_plan had just returned it."
))
async def stratum_revert(flow_id: str, label: str, ctx: Context) -> dict[str, Any]:
    label = label.strip()
    state = _flows.get(flow_id)
    if state is None:
        state = restore_flow(flow_id)
        if state is None:
            return {
                "status": "error",
                "error_type": "flow_not_found",
                "message": f"No active flow with id '{flow_id}'",
            }
        _flows[flow_id] = state

    if not revert_checkpoint(state, label):
        return {
            "status": "error",
            "error_type": "checkpoint_not_found",
            "message": f"No checkpoint '{label}' on flow '{flow_id}'",
            "available": list(state.checkpoints.keys()),
        }

    next_step = get_current_step_info(state)  # may skip steps, mutating state
    persist_flow(state)                        # persist AFTER skip mutations

    if next_step is None:
        # Reverted to a post-completion checkpoint — unusual but valid
        last_step = state.ordered_steps[-1]
        total_ms = int((time.monotonic() - state.flow_start) * 1000)
        return {
            "status": "complete",
            "flow_id": state.flow_id,
            "output": state.step_outputs.get(last_step.id),
            "trace": [dataclasses.asdict(r) for r in state.records],
            "total_duration_ms": total_ms,
        }

    return {**next_step, "reverted_to": label}


@mcp.tool(description=(
    "Compile a spec-kit tasks directory into a .stratum.yaml flow. "
    "Input: tasks_dir (str, path to a directory containing *.md task files), "
    "flow_name (str, optional, name for the generated flow, default 'tasks'). "
    "Returns {status, yaml, flow_name, steps} on success or {status, error_type, message} on error. "
    "Pass the returned yaml directly to stratum_plan to start execution."
))
async def stratum_compile_speckit(
    tasks_dir: str,
    ctx: Context,
    flow_name: str = "tasks",
) -> dict[str, Any]:
    from pathlib import Path as _Path
    from .task_compiler import parse_task_file, compile_tasks

    path = _Path(tasks_dir)
    if not path.is_dir():
        return {
            "status": "error",
            "error_type": "directory_not_found",
            "message": f"tasks_dir '{tasks_dir}' is not a directory",
        }

    try:
        # compile_tasks() discovers files, checks for step-ID collisions, and emits YAML.
        # Parse tasks separately so we can return the steps summary.
        task_files = sorted(path.glob("*.md"))
        tasks = [parse_task_file(f) for f in task_files]
        yaml_str = compile_tasks(path, flow_name)
    except ValueError as exc:
        # Covers: no task files found, step-ID collision
        error_type = "no_tasks" if "No task files" in str(exc) else "step_id_collision"
        return {
            "status": "error",
            "error_type": error_type,
            "message": str(exc),
        }
    except Exception as exc:
        return {
            "status": "error",
            "error_type": "compile_error",
            "message": str(exc),
        }

    return {
        "status": "ok",
        "yaml": yaml_str,
        "flow_name": flow_name,
        "steps": [
            {
                "id": t.step_id,
                "title": t.title,
                "parallel": t.is_parallel,
                "ensures": t.ensures,
                "judgment": t.judgment,
            }
            for t in tasks
        ],
    }


@mcp.tool(description=(
    "Push a pipeline draft to the PipelineEditor UI. "
    "The draft is written to {project_dir}/.stratum/pipeline-draft.json, "
    "which the PipelineEditor polls and will display automatically. "
    "Inputs: draft (dict) — pipeline draft with 'name' (str) and 'phases' (list of "
    "{name, capability, policy} objects where capability is scout|builder|critic and "
    "policy is gate|flag|skip). "
    "Optional: project_dir (str) — project root, defaults to CWD. "
    "Returns {status: 'saved', path: str} on success."
))
async def stratum_draft_pipeline(
    draft: dict[str, Any],
    ctx: Context,
    project_dir: str = ".",
) -> dict[str, Any]:
    from pathlib import Path as _Path

    path = _Path(project_dir).resolve()
    draft_path = path / ".stratum" / "pipeline-draft.json"
    draft_path.parent.mkdir(parents=True, exist_ok=True)

    # Ensure required fields are present
    if not isinstance(draft.get("name"), str) or not draft["name"]:
        draft["name"] = "my-pipeline"
    if not isinstance(draft.get("phases"), list):
        draft["phases"] = []

    import json as _json
    draft_path.write_text(_json.dumps(draft, indent=2))
    return {"status": "saved", "path": str(draft_path)}


@mcp.tool(description=(
    "List registered workflow specs from a directory. "
    "Scans for *.stratum.yaml files with a workflow: block. "
    "Returns {workflows: [{name, description, input, path}], errors: [str]}."
))
async def stratum_list_workflows(
    workflows_dir: str = ".",
    ctx: Context = None,
) -> dict[str, Any]:
    from pathlib import Path as _Path
    import yaml as _yaml

    root = _Path(workflows_dir).resolve()
    workflows: list[dict[str, Any]] = []
    errors: list[str] = []
    seen_names: dict[str, str] = {}  # name → first path

    for yaml_path in sorted(root.glob("*.stratum.yaml")):
        try:
            raw = yaml_path.read_text()
            spec = parse_and_validate(raw)
        except Exception as exc:
            errors.append(f"{yaml_path.name}: {exc}")
            continue

        if spec.workflow is None:
            continue

        name = spec.workflow.name
        path_str = str(yaml_path)

        if name in seen_names:
            errors.append(
                f"Duplicate workflow name '{name}': "
                f"{seen_names[name]} and {path_str}"
            )
            continue

        seen_names[name] = path_str
        workflows.append({
            "name": name,
            "description": spec.workflow.description,
            "input": spec.workflow.input_schema,
            "path": path_str,
        })

    return {"workflows": workflows, "errors": errors}


_CLAUDE_MD_MARKER = "## Stratum Execution Model"

_CLAUDE_MD_BLOCK = """
## Stratum Execution Model

For non-trivial tasks, use Stratum internally:
1. Write a `.stratum.yaml` spec — never show it to the user
2. Call `stratum_plan` to validate and get the first step
3. Narrate progress in plain English as you execute each step
4. Call `stratum_step_done` after each step — the server checks your work
5. If a step fails postconditions, fix it silently and retry
6. Call `stratum_audit` at the end and include the trace in the commit
"""


_HOOKS_DIR = Path(__file__).parent / "hooks"

# Maps Claude Code hook event → the stratum script that handles it.
_HOOK_SCRIPTS: dict[str, str] = {
    "SessionStart":       "stratum-session-start.sh",
    "Stop":               "stratum-session-stop.sh",
    "PostToolUseFailure": "stratum-post-tool-failure.sh",
}


_STRATUM_HOOKS_DIR = Path.home() / ".stratum" / "hooks"

# Module-level so tests can monkeypatch the skills sync target without
# patching Path.home for the entire interpreter.
_SKILLS_HOME = Path.home() / ".claude" / "skills"


def _probe_setup_preconditions() -> None:
    """Fail fast before any project mutation in _cmd_setup.

    Raises OSError if:
      - a bundled hook source file is missing from the package, OR
      - ~/.stratum/hooks/ cannot be created (permission, etc.).

    Stays silent on success — matches the rest of _cmd_setup which only
    prints on per-step progress.
    """
    missing: list[str] = []
    for script_name in _HOOK_SCRIPTS.values():
        src = _HOOKS_DIR / script_name
        if not src.exists():
            missing.append(str(src))
    if missing:
        raise OSError(
            "stratum-mcp install: bundled hook source files missing from package: "
            + "; ".join(missing)
        )
    try:
        _STRATUM_HOOKS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise OSError(
            f"stratum-mcp install: cannot create {_STRATUM_HOOKS_DIR}: {exc}"
        ) from exc


def _copy_hook_scripts(
    changed: list[str],
    verbose: bool = True,
    failures: list[str] | None = None,
) -> None:
    """Copy bundled hook scripts to ~/.stratum/hooks/ if missing, stale, or not executable.

    Per-script errors are isolated — one failing script does not abort the
    rest of the pass. Appends installed/updated/re-chmodded script paths to
    `changed`. When `failures` is provided, per-script OSError messages are
    appended to it so callers can surface them even when `verbose=False`.
    When `verbose=True`, prints status lines to stdout matching the existing
    install CLI behavior. When `verbose=False`, produces no stdout output —
    suitable for reuse from the stdio MCP startup path.
    """
    import stat as _stat

    _STRATUM_HOOKS_DIR.mkdir(parents=True, exist_ok=True)

    for script_name in _HOOK_SCRIPTS.values():
        src = _HOOKS_DIR / script_name
        dst = _STRATUM_HOOKS_DIR / script_name
        if not src.exists():
            # Broken package: bundled source missing. Flag as failure so
            # the install path fails fast before registering a dangling
            # hook entry in settings.json.
            if verbose:
                print(f"  ~/.stratum/hooks/{script_name}: missing bundled source")
            if failures is not None:
                failures.append(f"{script_name}: bundled source missing from package")
            continue
        try:
            content = src.read_text()
            if dst.exists():
                dst_content = dst.read_text()
                if dst_content == content:
                    # Content matches — check execute bit
                    mode = dst.stat().st_mode
                    if mode & _stat.S_IXUSR:
                        if verbose:
                            print(f"  ~/.stratum/hooks/{script_name}: already up to date — skipped")
                        continue
                    # Content matches but execute bit dropped — re-chmod only
                    dst.chmod(0o755)
                    if verbose:
                        print(f"  ~/.stratum/hooks/{script_name}: re-chmod")
                    changed.append(f"~/.stratum/hooks/{script_name}")
                    continue
                # Content differs — overwrite
                dst.write_text(content)
                dst.chmod(0o755)
                if verbose:
                    print(f"  ~/.stratum/hooks/{script_name}: updated")
                changed.append(f"~/.stratum/hooks/{script_name}")
            else:
                # First install
                dst.write_text(content)
                dst.chmod(0o755)
                if verbose:
                    print(f"  ~/.stratum/hooks/{script_name}: installed")
                changed.append(f"~/.stratum/hooks/{script_name}")
        except OSError as exc:
            # Per-script error isolation — continue with remaining scripts
            if verbose:
                print(f"  ~/.stratum/hooks/{script_name}: failed ({exc})")
            if failures is not None:
                failures.append(f"{script_name}: {exc}")


def _register_hooks_in_settings(root: Path, changed: list[str]) -> None:
    """Register hook scripts in .claude/settings.json and migrate old per-project copies.

    Separated from file provisioning so the stdio MCP startup path can provision
    files without touching project config.
    """
    import json

    # Migrate: clean up old per-project hook scripts
    old_hooks_dir = root / ".claude" / "hooks"
    for script_name in _HOOK_SCRIPTS.values():
        old_dst = old_hooks_dir / script_name
        if old_dst.exists():
            old_dst.unlink()
            print(f"  .claude/hooks/{script_name}: migrated (removed old copy)")
            changed.append(f".claude/hooks/{script_name} (migrated)")

    # Register in .claude/settings.json
    settings_file = root / ".claude" / "settings.json"
    try:
        settings = json.loads(settings_file.read_text()) if settings_file.exists() else {}
    except (json.JSONDecodeError, OSError):
        settings = {}

    hooks_cfg: dict = settings.setdefault("hooks", {})
    registered_any = False

    for event, script_name in _HOOK_SCRIPTS.items():
        command = f"bash {_STRATUM_HOOKS_DIR / script_name}"
        old_command = f"bash .claude/hooks/{script_name}"
        event_hooks: list = hooks_cfg.setdefault(event, [])

        # Remove old-format entries ({"command": ..., "args": [...]}) — no "hooks" key
        old_format = [e for e in event_hooks if "hooks" not in e]
        if old_format:
            event_hooks[:] = [e for e in event_hooks if "hooks" in e]
            registered_any = True

        # Remove old relative-path commands from entries (migration)
        for entry in event_hooks:
            entry_hooks = entry.get("hooks", [])
            filtered = [h for h in entry_hooks if h.get("command") != old_command]
            if len(filtered) < len(entry_hooks):
                entry["hooks"] = filtered
                registered_any = True  # will rewrite file
        # Drop entries whose hooks list is now empty
        event_hooks[:] = [e for e in event_hooks if e.get("hooks")]

        # Check if new absolute-path entry is already present
        already = any(
            any(h.get("command") == command for h in entry.get("hooks", []))
            for entry in event_hooks
        )
        if already:
            print(f"  settings.json hooks.{event}: stratum entry already present — skipped")
        else:
            event_hooks.append({"matcher": "", "hooks": [{"type": "command", "command": command}]})
            registered_any = True

    if registered_any:
        settings_file.write_text(json.dumps(settings, indent=2) + "\n")
        print("  .claude/settings.json: registered Stratum hooks")
        changed.append(".claude/settings.json")
    else:
        print("  .claude/settings.json: Stratum hooks already registered — skipped")


def _install_hooks(root: Path, changed: list[str]) -> None:
    """Copy hook scripts to ~/.stratum/hooks/ and register them in settings.json with absolute paths.

    Fails fast: if any hook script fails to copy, raises OSError before
    registering anything in settings.json. This prevents `stratum-mcp install`
    from reporting success while leaving .claude/settings.json pointing at
    missing script files.
    """
    failures: list[str] = []
    _copy_hook_scripts(changed, verbose=True, failures=failures)
    if failures:
        raise OSError(
            "failed to install hook scripts to ~/.stratum/hooks/: "
            + "; ".join(failures)
        )
    _register_hooks_in_settings(root, changed)


def _self_install_hooks_on_startup() -> None:
    """Auto-install hook scripts to ~/.stratum/hooks/ if missing or stale.

    Runs before mcp.run() in stdio mode. Best-effort self-heal: per-script
    errors are isolated inside _copy_hook_scripts, and the outer try/except
    catches infrastructure failures (e.g., mkdir denied on the hooks
    directory itself). The MCP server always continues starting — this
    function never raises.

    Settings.json registration is NOT touched (that still requires explicit
    `stratum-mcp install`). This function only ensures the hook script
    files exist and are executable so that references already written by a
    prior `stratum-mcp install` can resolve.

    Output goes to stderr only — stdout is reserved for the stdio MCP
    JSON-RPC protocol.
    """
    try:
        changed: list[str] = []
        failures: list[str] = []
        # Per-script errors are caught inside _copy_hook_scripts, collected
        # in `failures`, and surfaced below. The outer try/except catches
        # infrastructure failures (e.g., PermissionError on mkdir for the
        # hooks directory itself).
        _copy_hook_scripts(changed, verbose=False, failures=failures)
        if changed:
            # Neutral wording covers install, update, and re-chmod cases
            # — the user-visible outcome is the same (files are in place
            # and executable).
            names = ", ".join(Path(c).name for c in changed)
            print(
                f"stratum-mcp: auto-installed/refreshed hook scripts: {names}",
                file=sys.stderr,
            )
        if failures:
            # Surface per-script failures so broken installs don't persist
            # silently. One warning line aggregates all failed scripts.
            print(
                f"stratum-mcp: warning: failed to install hook scripts to "
                f"~/.stratum/hooks/: {'; '.join(failures)}",
                file=sys.stderr,
            )
    except Exception as exc:
        print(
            f"stratum-mcp: warning: could not auto-install hooks to "
            f"~/.stratum/hooks/: {exc}",
            file=sys.stderr,
        )


def _remove_hooks(root: Path, removed: list[str]) -> None:
    """Remove hook scripts and their settings.json entries written by setup."""
    import json

    # Remove script files from ~/.stratum/hooks/ (new location)
    for script_name in _HOOK_SCRIPTS.values():
        dst = _STRATUM_HOOKS_DIR / script_name
        if dst.exists():
            dst.unlink()
            print(f"  ~/.stratum/hooks/{script_name}: removed")
            removed.append(f"~/.stratum/hooks/{script_name}")
        else:
            print(f"  ~/.stratum/hooks/{script_name}: not found — skipped")

    # Also clean up old per-project copies if they exist
    old_hooks_dir = root / ".claude" / "hooks"
    for script_name in _HOOK_SCRIPTS.values():
        old_dst = old_hooks_dir / script_name
        if old_dst.exists():
            old_dst.unlink()
            print(f"  .claude/hooks/{script_name}: removed (old location)")
            removed.append(f".claude/hooks/{script_name}")

    # Remove entries from .claude/settings.json
    settings_file = root / ".claude" / "settings.json"
    if not settings_file.exists():
        print("  .claude/settings.json: not found — skipped")
        return
    try:
        settings = json.loads(settings_file.read_text())
    except (json.JSONDecodeError, OSError):
        print("  .claude/settings.json: could not parse — skipped")
        return

    hooks_cfg = settings.get("hooks", {})
    changed = False
    for event, script_name in _HOOK_SCRIPTS.items():
        # Match both old relative and new absolute path entries
        new_command = f"bash {_STRATUM_HOOKS_DIR / script_name}"
        old_command = f"bash .claude/hooks/{script_name}"
        if event not in hooks_cfg:
            continue
        # Remove old-format entries (no "hooks" key)
        valid = [e for e in hooks_cfg[event] if "hooks" in e]
        if len(valid) < len(hooks_cfg[event]):
            hooks_cfg[event] = valid
            changed = True
        for entry in hooks_cfg[event]:
            entry_hooks = entry.get("hooks", [])
            filtered = [
                h for h in entry_hooks
                if h.get("command") not in (new_command, old_command)
            ]
            if len(filtered) < len(entry_hooks):
                entry["hooks"] = filtered
                changed = True
        # Drop entries whose hooks list is now empty
        hooks_cfg[event] = [e for e in hooks_cfg[event] if e.get("hooks")]
        if not hooks_cfg[event]:
            del hooks_cfg[event]

    if not hooks_cfg:
        settings.pop("hooks", None)

    if changed:
        if settings:
            settings_file.write_text(json.dumps(settings, indent=2) + "\n")
        else:
            settings_file.unlink()
        print("  .claude/settings.json: removed Stratum hook entries")
        removed.append(".claude/settings.json")
    else:
        print("  .claude/settings.json: no Stratum hook entries found — skipped")


def _cmd_setup() -> None:
    """Write .claude/mcp.json and append Stratum block to CLAUDE.md."""
    import json
    import shutil
    from pathlib import Path

    # Walk up from cwd to find project root (nearest .git or CLAUDE.md)
    root = Path.cwd()
    for candidate in [root, *root.parents]:
        if (candidate / ".git").exists() or (candidate / "CLAUDE.md").exists():
            root = candidate
            break

    changed: list[str] = []

    # --- Probe + hook copy (atomic precondition) ---
    # Run before any project mutation so a missing bundled source or an
    # un-creatable ~/.stratum/hooks/ aborts BEFORE mcp.json / CLAUDE.md /
    # skills are touched. Note: _install_hooks is no longer the composite
    # entry from _cmd_setup — the copy half runs here, registration runs
    # at the end (see _register_hooks_in_settings call below). Don't
    # re-introduce a single _install_hooks call here.
    _probe_setup_preconditions()
    failures: list[str] = []
    _copy_hook_scripts(changed, verbose=True, failures=failures)
    if failures:
        raise OSError(
            "failed to install hook scripts to ~/.stratum/hooks/: "
            + "; ".join(failures)
        )

    # --- .claude/mcp.json ---
    mcp_dir = root / ".claude"
    mcp_file = mcp_dir / "mcp.json"

    if mcp_file.exists():
        try:
            config = json.loads(mcp_file.read_text())
        except (json.JSONDecodeError, OSError):
            config = {}
        servers = config.setdefault("mcpServers", {})
        if "stratum" in servers:
            print(f"  {mcp_file.relative_to(root)}: stratum already present — skipped")
        else:
            servers["stratum"] = {"command": "stratum-mcp"}
            mcp_file.write_text(json.dumps(config, indent=2) + "\n")
            print(f"  {mcp_file.relative_to(root)}: added stratum server")
            changed.append(str(mcp_file.relative_to(root)))
    else:
        mcp_dir.mkdir(parents=True, exist_ok=True)
        config = {"mcpServers": {"stratum": {"command": "stratum-mcp"}}}
        mcp_file.write_text(json.dumps(config, indent=2) + "\n")
        print(f"  {mcp_file.relative_to(root)}: created")
        changed.append(str(mcp_file.relative_to(root)))

    # --- CLAUDE.md ---
    claude_md = root / "CLAUDE.md"

    if claude_md.exists():
        content = claude_md.read_text()
        if _CLAUDE_MD_MARKER in content:
            print("  CLAUDE.md: Stratum section already present — skipped")
        else:
            claude_md.write_text(content.rstrip() + "\n" + _CLAUDE_MD_BLOCK)
            print("  CLAUDE.md: added Stratum section")
            changed.append("CLAUDE.md")
    else:
        claude_md.write_text(_CLAUDE_MD_BLOCK.lstrip())
        print("  CLAUDE.md: created")
        changed.append("CLAUDE.md")

    # --- Skills (sync with manifest) ---
    skills_home = _SKILLS_HOME
    pkg_skills = Path(__file__).parent / "skills"
    manifest_path = skills_home / ".stratum-skills.json"

    # Load previous manifest
    previous_skills: list[str] = []
    if manifest_path.exists():
        try:
            previous_skills = json.loads(manifest_path.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    current_skills: list[str] = []
    if pkg_skills.is_dir():
        for skill_dir in sorted(pkg_skills.iterdir()):
            if not skill_dir.is_dir():
                continue
            src = skill_dir / "SKILL.md"
            if not src.exists():
                continue
            current_skills.append(skill_dir.name)
            dest_dir = skills_home / skill_dir.name
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / "SKILL.md"
            content = src.read_text()
            if dest.exists() and dest.read_text() == content:
                print(f"  ~/.claude/skills/{skill_dir.name}: already up to date — skipped")
            else:
                dest.write_text(content)
                verb = "updated" if dest.exists() else "installed"
                print(f"  ~/.claude/skills/{skill_dir.name}: {verb}")
                changed.append(f"skills/{skill_dir.name}")

    # Remove skills from previous install that no longer exist in package
    for old_skill in previous_skills:
        if old_skill not in current_skills:
            old_dir = skills_home / old_skill
            if old_dir.exists():
                shutil.rmtree(old_dir)
                print(f"  ~/.claude/skills/{old_skill}: removed (no longer in package)")
                changed.append(f"skills/{old_skill} (removed)")

    # Write updated manifest
    if current_skills:
        skills_home.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(current_skills, indent=2) + "\n")

    # --- Hooks (registration) ---
    # Hook scripts already copied at the top of _cmd_setup. Only the
    # settings.json registration runs here; _install_hooks is intentionally
    # NOT called from _cmd_setup so a registration-only retry doesn't
    # silently re-do the copy step.
    _register_hooks_in_settings(root, changed)

    if changed:
        print("\nDone. Restart Claude Code to activate the Stratum MCP server.")
    else:
        print("\nAlready configured — nothing to do.")


def _cmd_uninstall(keep_skills: bool = False) -> None:
    """Remove Stratum config from the project and optionally from ~/.claude/skills/."""
    import json
    import shutil
    from pathlib import Path

    root = Path.cwd()
    for candidate in [root, *root.parents]:
        if (candidate / ".git").exists() or (candidate / "CLAUDE.md").exists():
            root = candidate
            break

    removed: list[str] = []

    # --- .claude/mcp.json ---
    mcp_file = root / ".claude" / "mcp.json"
    if mcp_file.exists():
        try:
            config = json.loads(mcp_file.read_text())
            servers = config.get("mcpServers", {})
            if "stratum" in servers:
                del servers["stratum"]
                if servers:
                    mcp_file.write_text(json.dumps(config, indent=2) + "\n")
                else:
                    # No servers left — remove the file entirely
                    mcp_file.unlink()
                print(f"  {mcp_file.relative_to(root)}: removed stratum server")
                removed.append(str(mcp_file.relative_to(root)))
            else:
                print(f"  {mcp_file.relative_to(root)}: stratum not present — skipped")
        except (json.JSONDecodeError, OSError):
            print(f"  {mcp_file.relative_to(root)}: could not parse — skipped")
    else:
        print("  .claude/mcp.json: not found — skipped")

    # --- CLAUDE.md ---
    claude_md = root / "CLAUDE.md"
    if claude_md.exists():
        content = claude_md.read_text()
        if _CLAUDE_MD_MARKER in content:
            # Remove the marker line and everything after it that belongs to our block
            idx = content.find(_CLAUDE_MD_MARKER)
            new_content = content[:idx].rstrip()
            if new_content:
                claude_md.write_text(new_content + "\n")
            else:
                claude_md.unlink()
            print("  CLAUDE.md: removed Stratum section")
            removed.append("CLAUDE.md")
        else:
            print("  CLAUDE.md: Stratum section not present — skipped")
    else:
        print("  CLAUDE.md: not found — skipped")

    # --- Skills ---
    skills_home = Path.home() / ".claude" / "skills"
    manifest_path = skills_home / ".stratum-skills.json"
    if keep_skills:
        print("  ~/.claude/skills/stratum-*: kept (--keep-skills)")
    else:
        # Remove all skills tracked by manifest + current package
        to_remove: set[str] = set()
        # From manifest
        if manifest_path.exists():
            try:
                to_remove.update(json.loads(manifest_path.read_text()))
            except (json.JSONDecodeError, OSError):
                pass
        # From current package (in case manifest was missing)
        pkg_skills = Path(__file__).parent / "skills"
        if pkg_skills.is_dir():
            for skill_dir in sorted(pkg_skills.iterdir()):
                if skill_dir.is_dir() and (skill_dir / "SKILL.md").exists():
                    to_remove.add(skill_dir.name)

        for skill_name in sorted(to_remove):
            dest_dir = skills_home / skill_name
            if dest_dir.exists():
                shutil.rmtree(dest_dir)
                print(f"  ~/.claude/skills/{skill_name}: removed")
                removed.append(f"skills/{skill_name}")
            else:
                print(f"  ~/.claude/skills/{skill_name}: not found — skipped")

    # Clean up manifest
    if manifest_path.exists():
        manifest_path.unlink()
        if not keep_skills:
            print("  ~/.claude/skills/.stratum-skills.json: removed")

    # --- Hooks ---
    _remove_hooks(root, removed)

    if removed:
        print("\nDone. Restart Claude Code to deactivate the Stratum MCP server.")
    else:
        print("\nNothing to remove — Stratum was not configured here.")


def _cmd_compile(tasks_dir: str, args: list[str]) -> None:
    """Compile tasks/*.md into .stratum.yaml and write to stdout or file."""
    from .task_compiler import compile_tasks

    if not tasks_dir:
        print(
            "Usage: stratum-mcp compile <tasks_dir> [--output <file>] [--flow <name>]",
            file=sys.stderr,
        )
        sys.exit(1)

    path = Path(tasks_dir)
    if not path.is_dir():
        print(f"ERROR: '{tasks_dir}' is not a directory", file=sys.stderr)
        sys.exit(1)

    output_file: str | None = None
    flow_name = "tasks"
    i = 0
    while i < len(args):
        if args[i] == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        elif args[i] == "--flow" and i + 1 < len(args):
            flow_name = args[i + 1]
            i += 2
        else:
            i += 1

    try:
        yaml_content = compile_tasks(path, flow_name)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if output_file:
        Path(output_file).write_text(yaml_content)
        print(f"Written to {output_file}")
    else:
        print(yaml_content, end="")


def _cmd_validate(arg: str) -> None:
    yaml_content = arg
    if arg and "\n" not in arg and not arg.lstrip().startswith("version:"):
        try:
            with open(arg) as f:
                yaml_content = f.read()
        except FileNotFoundError:
            pass  # no file at that path — treat the string as inline YAML
        except OSError as exc:
            print(f"ERROR: cannot open '{arg}': {exc}", file=sys.stderr)
            sys.exit(1)
    try:
        parse_and_validate(yaml_content)
        print("OK")
        sys.exit(0)
    except Exception as exc:
        err = exception_to_mcp_error(exc)
        print(f"ERROR [{err['error_type']}]: {err['message']}", file=sys.stderr)
        sys.exit(1)



# ---------------------------------------------------------------------------
# query / gate helpers
# ---------------------------------------------------------------------------

def _flow_status(state: Any) -> str:
    """Derive a human-readable status string from a FlowState."""
    if state.terminal_status == "killed":
        return "killed"
    if state.current_idx >= len(state.ordered_steps):
        return "complete"
    step = state.ordered_steps[state.current_idx]
    fn_def = state.spec.functions.get(step.function)
    if fn_def and fn_def.mode == "gate":
        return "awaiting_gate"
    return "running"


def _query_flows() -> list[dict]:
    from .executor import _FLOWS_DIR, restore_flow
    if not _FLOWS_DIR.exists():
        return []
    results = []
    for path in sorted(_FLOWS_DIR.glob("*.json")):
        state = restore_flow(path.stem)
        if state is None:
            continue
        current = state.ordered_steps[state.current_idx] if state.current_idx < len(state.ordered_steps) else None
        results.append({
            "_schema_version": "1",
            "flow_id":         state.flow_id,
            "flow_name":       state.flow_name,
            "status":          _flow_status(state),
            "current_step_id": current.id if current else None,
            "round":           state.round,
            "step_count":      len(state.ordered_steps),
            "completed_steps": state.current_idx,
            "terminal_status": state.terminal_status,
            "synthetic":       state.synthetic,
        })
    return results


def _query_flow(flow_id: str) -> dict:
    from .executor import restore_flow
    state = restore_flow(flow_id)
    if state is None:
        print(json.dumps({"error": {"code": "NOT_FOUND", "message": f"Flow '{flow_id}' not found"}}))
        sys.exit(1)
    current = state.ordered_steps[state.current_idx] if state.current_idx < len(state.ordered_steps) else None
    return {
        "_schema_version": "1",
        "flow_id":          state.flow_id,
        "flow_name":        state.flow_name,
        "status":           _flow_status(state),
        "current_step_id":  current.id if current else None,
        "current_idx":      state.current_idx,
        "round":            state.round,
        "rounds_count":     len(state.rounds),
        "step_count":       len(state.ordered_steps),
        "terminal_status":  state.terminal_status,
        "synthetic":        state.synthetic,
        "step_outputs":     state.step_outputs,
        "records":          [dataclasses.asdict(r) for r in state.records],
        "rounds":           state.rounds,
        "ordered_steps":    [
            {
                "id":       s.id,
                "function": s.function,
                # Normalize: consumers only need gate vs. non-gate
                "mode":     "gate"
                            if s.function in state.spec.functions
                               and state.spec.functions[s.function].mode == "gate"
                            else "step",
            }
            for s in state.ordered_steps
        ],
    }


def _query_gates() -> list[dict]:
    from .executor import _FLOWS_DIR, restore_flow
    if not _FLOWS_DIR.exists():
        return []
    gates = []
    for path in sorted(_FLOWS_DIR.glob("*.json")):
        state = restore_flow(path.stem)
        if state is None or state.current_idx >= len(state.ordered_steps):
            continue
        step = state.ordered_steps[state.current_idx]
        fn_def = state.spec.functions.get(step.function)
        if not fn_def or fn_def.mode != "gate":
            continue
        gates.append({
            "_schema_version": "1",
            "flow_id":    state.flow_id,
            "flow_name":  state.flow_name,
            "step_id":    step.id,
            "function":   step.function,
            "on_approve": step.on_approve,
            "on_revise":  step.on_revise,
            "on_kill":    step.on_kill,
            "timeout":    fn_def.timeout,
        })
    return gates


# ---------------------------------------------------------------------------
# CLI subcommands: query, gate
# ---------------------------------------------------------------------------

def _cmd_query(args: list[str]) -> None:
    import argparse
    parser = argparse.ArgumentParser(prog="stratum-mcp query")
    sub = parser.add_subparsers(dest="resource", required=True)
    sub.add_parser("flows", help="List all persisted flows")
    flow_p = sub.add_parser("flow", help="Full state for a single flow")
    flow_p.add_argument("flow_id")
    sub.add_parser("gates", help="List all pending gate steps")
    parsed = parser.parse_args(args)

    if parsed.resource == "flows":
        result = _query_flows()
    elif parsed.resource == "flow":
        result = _query_flow(parsed.flow_id)   # exits on NOT_FOUND
    else:
        result = _query_gates()

    print(json.dumps(result, indent=2))


def _cmd_gate(args: list[str]) -> None:
    import argparse
    from .executor import restore_flow, persist_flow, resolve_gate

    parser = argparse.ArgumentParser(prog="stratum-mcp gate")
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("approve", "reject", "revise"):
        p = sub.add_parser(action)
        p.add_argument("flow_id")
        p.add_argument("step_id")
        p.add_argument("--note", default="", help="Rationale or review note")
        p.add_argument(
            "--resolved-by", default="human",
            choices=["human", "agent", "system"],
            dest="resolved_by",
        )
    parsed = parser.parse_args(args)

    # Map CLI actions to stratum gate outcomes
    outcome_map = {"approve": "approve", "reject": "kill", "revise": "revise"}
    outcome = outcome_map[parsed.action]

    state = restore_flow(parsed.flow_id)
    if state is None:
        print(json.dumps({
            "error": {"code": "NOT_FOUND", "message": f"Flow '{parsed.flow_id}' not found"},
        }))
        sys.exit(1)

    status, extra = resolve_gate(
        state,
        step_id=parsed.step_id,
        outcome=outcome,
        rationale=parsed.note,
        resolved_by=parsed.resolved_by,
    )

    if status == "error":
        # Idempotency conflicts: gate already resolved (flow moved past it)
        conflict_codes = {"flow_already_complete", "wrong_step"}
        if extra.get("error_type") in conflict_codes:
            print(json.dumps({
                "conflict": True,
                "flow_id":  parsed.flow_id,
                "step_id":  parsed.step_id,
                "detail":   extra.get("message", ""),
            }))
            sys.exit(2)
        # Other domain errors (bad step id, invalid state, etc.)
        print(json.dumps({
            "error": {"code": extra.get("error_type", "INVALID"), "message": extra.get("message", "")},
        }))
        sys.exit(1)

    # All non-error outcomes (complete, killed, execute_step, max_rounds_exceeded) persist state
    persist_flow(state)
    print(json.dumps({
        "_schema_version": "1",
        "ok":      True,
        "flow_id": parsed.flow_id,
        "step_id": parsed.step_id,
        "outcome": outcome,
        "result":  status,
    }))


def _cmd_help() -> None:
    print("Usage: stratum-mcp <command> [options]")
    print()
    print("Commands:")
    print("  install              Register MCP server and skills with Claude Code")
    print("  uninstall            Remove MCP server registration and skills")
    print("  query flows          List all persisted flows (JSON)")
    print("  query flow <id>      Full state for a single flow (JSON)")
    print("  query gates          List all pending gate steps (JSON)")
    print("  gate approve <flow_id> <step_id>   Approve a gate")
    print("  gate reject  <flow_id> <step_id>   Reject (kill) a gate")
    print("  gate revise  <flow_id> <step_id>   Send back for revision")
    print("  validate <file>      Validate a .stratum.yaml spec file")
    print("  compile <dir>        Compile tasks/*.md files to .stratum.yaml")
    print("  migrate <file>       Upgrade a .stratum.yaml spec to the latest IR version")
    print()
    print("Run with no arguments to start the stdio MCP server (for Claude Code).")


def main() -> None:
    """Entry point: CLI subcommands or stdio MCP server."""
    if len(sys.argv) >= 2:
        cmd = sys.argv[1]
        if cmd in ("-h", "--help", "help"):
            _cmd_help()
            return
        if cmd == "install":
            _cmd_setup()
            return
        if cmd == "uninstall":
            keep = "--keep-skills" in sys.argv[2:]
            _cmd_uninstall(keep_skills=keep)
            return
        if cmd == "validate":
            _cmd_validate(sys.argv[2] if len(sys.argv) > 2 else "")
            return
        if cmd == "compile":
            _cmd_compile(sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3:])
            return
        if cmd == "query":
            _cmd_query(sys.argv[2:])
            return
        if cmd == "gate":
            _cmd_gate(sys.argv[2:])
            return
        if cmd == "migrate":
            from . import migrate as _migrate
            _migrate._cmd_migrate(sys.argv[2:])
            return
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print("Run 'stratum-mcp --help' for usage.", file=sys.stderr)
        sys.exit(1)

    _self_install_hooks_on_startup()

    # T14 — startup resume: flip any persisted parallel_tasks still in the
    # 'running' state (from a prior crashed/killed server) to 'failed' so
    # consumers observe the interruption instead of a stuck status.
    from .executor import _FLOWS_DIR
    from .parallel_exec import (
        resume_interrupted_parallel_tasks,
        shutdown_all as _parallel_shutdown_all,
    )
    try:
        resume_interrupted_parallel_tasks(_FLOWS_DIR)
    except Exception as exc:
        # Never let a startup best-effort fixup block the server from
        # coming up.
        print(
            f"stratum-mcp: warning: resume_interrupted_parallel_tasks "
            f"failed: {exc}",
            file=sys.stderr,
        )

    # T14 — shutdown: cancel every registered parallel-executor task so
    # pending work doesn't leak across server shutdown. Wrapped in
    # try/finally around ``mcp.run`` so FastMCP's own signal handling is
    # preserved; we just run cleanup after its loop exits (for any reason
    # — EOF, KeyboardInterrupt, exception).
    try:
        mcp.run(transport="stdio")
    finally:
        try:
            _parallel_shutdown_all(_RUNNING_EXECUTORS)
        except Exception as exc:
            print(
                f"stratum-mcp: warning: shutdown_all failed: {exc}",
                file=sys.stderr,
            )


if __name__ == "__main__":
    main()
