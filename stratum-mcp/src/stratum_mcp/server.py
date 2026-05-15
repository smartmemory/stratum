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
        delete_persisted_flow(flow_id)
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
        delete_persisted_flow(flow_id)
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
    "stakes ('cheap'|'default', default 'default'), budget (dict, optional). "
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
