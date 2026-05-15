"""Worker validation, dispatch, and failure-cap accounting.

Public API
----------
WorkerSpec
    Dataclass representing the worker configuration forwarded to
    ``stratum_agent_run``.

validate_worker_spec(spec, mode, shadow_source)
    Enforces PRD M17: Codex rejected for all driven modes.

dispatch_worker(stratum_agent_run_callable, prompt, worker_spec, correlation_id, *, ctx=None)
    Builds ``stratum_agent_run`` kwargs from WorkerSpec and dispatches.
    Returns ``(worker_text, correlation_id_returned)``.

WorkerFailureTracker(max_failures)
    Counts consecutive worker-dispatch errors. On cap hit, raises
    ``BudgetExceededError`` (re-using STRAT-JUDGE's exception class).
    ``record_success()`` resets the counter.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Literal, Optional

from stratum.goal.errors import WorkerTypeNotSupportedError
from stratum.judge.errors import BudgetExceededError

WorkerType = Literal["claude", "codex"]
GoalMode = Literal["shadow", "advisory", "autonomous"]
ShadowSource = Literal["driven", "observed"]


# ---------------------------------------------------------------------------
# WorkerSpec
# ---------------------------------------------------------------------------

@dataclass
class WorkerSpec:
    """Configuration forwarded verbatim to ``stratum_agent_run``.

    Maps directly to ``stratum_agent_run`` parameters. All fields except
    ``type`` are optional and forwarded as-is (no transformation). STRAT-GOAL
    performs only the M17 safety check (Codex driven-mode rejection); all
    other parameter validation is ``stratum_agent_run``'s responsibility.
    """

    type: WorkerType = "claude"
    model_id: Optional[str] = None
    allowed_tools: Optional[list[str]] = None
    disallowed_tools: Optional[list[str]] = None
    cwd: Optional[str] = None
    effort: Optional[str] = None
    thinking: Optional[bool] = None


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_worker_spec(
    spec: dict,
    mode: GoalMode,
    shadow_source: ShadowSource,
) -> None:
    """Enforce PRD M17: Codex workers are not supported in driven modes.

    Driven modes (shadow-driven, advisory, autonomous) require a worker that
    can write files. The shipped Codex connector:
    1. Silently drops ``allowed_tools`` / ``disallowed_tools``
       (connectors/factory.py:45-50).
    2. Hardcodes ``--sandbox read-only`` (connectors/codex.py:167-177) —
       Codex cannot produce file changes through that surface.

    Codex is permitted only for ``shadow-observed`` mode where no worker
    dispatch occurs — the caller hands in pre-produced artifacts.

    Raises
    ------
    WorkerTypeNotSupportedError
        When ``spec["type"] == "codex"`` and the mode is a driven mode.
    """
    if spec.get("type") != "codex":
        return  # Claude or unset — always allowed

    # Determine if this is a driven mode
    is_driven = mode in ("advisory", "autonomous") or (
        mode == "shadow" and shadow_source == "driven"
    )
    if is_driven:
        raise WorkerTypeNotSupportedError(
            "codex worker not supported in driven modes "
            f"(mode={mode!r}, shadow_source={shadow_source!r}). "
            "Reason: the Codex connector hardcodes --sandbox read-only "
            "(connectors/codex.py:167-177) and silently drops allowed_tools/"
            "disallowed_tools (connectors/factory.py:45-50), so codex cannot "
            "produce file changes. Use mode='shadow' with shadow_source='observed' "
            "to observe pre-produced Codex artifacts, or use a claude worker for "
            "driven modes."
        )


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

async def dispatch_worker(
    stratum_agent_run_callable: Callable[..., Coroutine[Any, Any, dict]],
    prompt: str,
    worker_spec: dict,
    correlation_id: str,
    *,
    ctx: Any = None,
) -> tuple[str, str]:
    """Dispatch a single worker turn via the injected ``stratum_agent_run`` callable.

    Parameters
    ----------
    stratum_agent_run_callable:
        The injected callable (either the real ``stratum_agent_run`` module-level
        function or a test stub). Receives kwargs matching the
        ``stratum_agent_run`` MCP tool signature (server.py:133-249).
    prompt:
        The assembled worker prompt for this turn.
    worker_spec:
        Passthrough worker configuration dict. Fields forwarded as kwargs:
        ``type``, ``model_id``, ``allowed_tools``, ``disallowed_tools``,
        ``cwd``, ``effort``, ``thinking``.
    correlation_id:
        Caller-supplied correlation ID for this turn.
    ctx:
        Optional MCP Context passed through to the callable.

    Returns
    -------
    (worker_text, correlation_id_returned):
        ``worker_text`` is the assistant's full text response.
        ``correlation_id_returned`` is the flow ID from the callable's response
        (may differ from the input ``correlation_id`` if the callable generates
        its own).
    """
    kwargs: dict[str, Any] = {
        "prompt": prompt,
        "correlation_id": correlation_id,
    }
    if ctx is not None:
        kwargs["ctx"] = ctx

    # Forward all recognised worker spec fields — pure passthrough (no transformation)
    _PASSTHROUGH_FIELDS = (
        "type", "model_id", "allowed_tools", "disallowed_tools", "cwd", "effort", "thinking",
    )
    for field_name in _PASSTHROUGH_FIELDS:
        if field_name in worker_spec and worker_spec[field_name] is not None:
            kwargs[field_name] = worker_spec[field_name]

    result = await stratum_agent_run_callable(**kwargs)

    # stratum_agent_run returns {"text": str, "correlation_id": str}
    worker_text: str = result.get("text", "")
    returned_cid: str = result.get("correlation_id", correlation_id)
    return worker_text, returned_cid


# ---------------------------------------------------------------------------
# Failure-cap accounting
# ---------------------------------------------------------------------------

class WorkerFailureTracker:
    """Count consecutive worker-dispatch failures; raise on cap hit.

    ``record_success()`` resets the counter — a successful turn resets the
    failure window so transient errors don't accumulate across many turns.

    ``record_failure(exc)`` increments the counter. When the counter reaches
    ``max_failures``, raises ``BudgetExceededError`` (re-using STRAT-JUDGE's
    exception class per PRD M20).

    Parameters
    ----------
    max_failures:
        Number of consecutive worker failures tolerated before the goal
        budget is considered exhausted. Default 3 (PRD M20).
    """

    def __init__(self, max_failures: int = 3) -> None:
        self._max_failures = max_failures
        self._consecutive_failures = 0

    def record_success(self) -> None:
        """Reset the consecutive-failure counter."""
        self._consecutive_failures = 0

    def record_failure(self, exc: Exception) -> None:
        """Increment the failure counter; raise ``BudgetExceededError`` on cap hit.

        Parameters
        ----------
        exc:
            The exception raised by the worker dispatch. Stored as context in
            the BudgetExceededError if the cap is hit.

        Raises
        ------
        BudgetExceededError
            When the consecutive failure count reaches ``max_failures``.
        """
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._max_failures:
            raise BudgetExceededError(
                f"Worker failure cap hit: {self._consecutive_failures} consecutive "
                f"failures (max_failures={self._max_failures}). "
                f"Last error: {exc}"
            ) from exc
