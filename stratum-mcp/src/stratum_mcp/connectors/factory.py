"""Agent connector factory (T2-F5-ENFORCE T1).

Single dispatch point for constructing agent connectors from a v1 agent-type
string. The v1 server-dispatch supports only "claude" and "codex"; "opencode"
is explicitly reserved for a future feature (T2-F5-OPENCODE-DISPATCH) and
raises a ValueError pointing at that roadmap ID.
"""
from __future__ import annotations

from typing import Any, Optional

from .base import AgentConnector
from .claude import ClaudeConnector
from .codex import DEFAULT_CODEX_MODEL, CodexConnector

_VALID_AGENT_TYPES = frozenset({"claude", "codex"})

# Public alias — single source of truth for the known agent connector prefixes.
# STRAT-AGENT-INTERP: executor.resolve_agent validates an interpolated agent's
# connector prefix against this set.
VALID_AGENT_TYPES = _VALID_AGENT_TYPES


def connector_base(agent_type: str) -> str:
    """The connector prefix of an agent-type string — the part before the first ``:``.

    Agent strings may carry a ``:profile`` or ``::tier`` suffix
    (e.g. ``claude:reviewer``, ``claude::critical``); only the prefix selects
    the connector. Every dispatch path — ``make_agent_connector``
    (``stratum_agent_run``), ``executor.resolve_agent`` (flow steps), and
    ``parallel_exec`` — normalizes through this one parser so they can never
    drift on what counts as a valid type.

    Non-strings (e.g. a ``$``-ref that resolved to a non-string) pass through
    unchanged for the caller to reject.
    """
    if not isinstance(agent_type, str):
        return agent_type
    return agent_type.split(":", 1)[0].strip()


def make_agent_connector(
    agent_type: str,
    model_id: Optional[str],
    cwd: Optional[str],
    *,
    allowed_tools: Optional[list[str]] = None,
    disallowed_tools: Optional[list[str]] = None,
    thinking: Optional[dict] = None,
    effort: Optional[str] = None,
    read_jail: Optional[str] = None,
    stream_path: Optional[str] = None,
    stderr_path: Optional[str] = None,
    sandbox_mode: str = "read-only",
) -> AgentConnector:
    """Factory — raises ValueError on unknown agent type.

    Codex model ids are NOT hard-gated: an unknown model warns and passes
    through to the codex CLI, which is the authority on which models exist.

    "opencode" raises ValueError with T2-F5-OPENCODE-DISPATCH pointer — that
    agent type is not yet wired into server-dispatch.

    T2-F5-RESUME: ``stream_path``/``stderr_path`` enable the codex connector's
    durable-stream (reparentable) mode. They are codex-only — ignored for
    claude (in-process, nothing to reparent).
    """
    # Select the connector by the base prefix so a ':profile' / '::tier' suffix
    # (e.g. claude::critical, claude:reviewer) is accepted here exactly as it is
    # on the flow-executor path (executor.resolve_agent). The suffix is metadata
    # for the caller (Compose resolves it to model/effort/tools, passed via the
    # kwargs above); it never gates connector selection.
    base = connector_base(agent_type)
    if base == "opencode":
        raise ValueError(
            "stratum_agent_run: agent_type 'opencode' is not yet supported "
            "in server-dispatch (see T2-F5-OPENCODE-DISPATCH). "
            f"Valid types for v1: {sorted(_VALID_AGENT_TYPES)}"
        )
    if base not in _VALID_AGENT_TYPES:
        raise ValueError(
            f"stratum_agent_run: unknown type '{agent_type}'. "
            f"Valid types: {sorted(_VALID_AGENT_TYPES)} "
            "(an optional ':profile' or '::tier' suffix is allowed)"
        )
    if base == "codex":
        codex_kwargs: dict[str, Any] = {
            "model_id": model_id or DEFAULT_CODEX_MODEL,
            "cwd": cwd,
            "read_jail": read_jail,
            "stream_path": stream_path,
            "stderr_path": stderr_path,
            "sandbox_mode": sandbox_mode,
        }
        return CodexConnector(**codex_kwargs)
    kwargs: dict[str, Any] = {"cwd": cwd}
    if model_id:
        kwargs["model"] = model_id
    if allowed_tools is not None:
        kwargs["allowed_tools"] = allowed_tools
    if disallowed_tools is not None:
        kwargs["disallowed_tools"] = disallowed_tools
    if thinking is not None:
        kwargs["thinking"] = thinking
    if effort is not None:
        kwargs["effort"] = effort
    return ClaudeConnector(**kwargs)
