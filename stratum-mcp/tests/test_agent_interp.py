"""STRAT-AGENT-INTERP: interpolatable per-step ``agent``.

A flow can select a step's executor at runtime by interpolating the ``agent``
field through the same JSONPath resolver that handles ``inputs`` — e.g. a router
step emits ``{agent: "codex"}`` and a later step uses
``agent: "$.steps.route.output.agent"``.
"""
import pytest

from stratum_mcp.errors import MCPExecutionError
from stratum_mcp.executor import (
    resolve_agent,
    effective_agent,
    resolve_ref,
    RefResolutionError,
    result_cache_key,
    create_flow_state,
    get_current_step_info,
)
from stratum_mcp.spec import parse_and_validate


# ---------------------------------------------------------------------------
# 1. resolve_agent unit
# ---------------------------------------------------------------------------

FLOW_INPUTS = {"who": "codex"}
STEP_OUTPUTS = {"route": {"agent": "codex"}, "route_profile": {"agent": "claude:reviewer"}}


def test_resolve_agent_none():
    assert resolve_agent(None, {}, {}) is None


def test_resolve_agent_literal_identity():
    assert resolve_agent("claude", {}, {}) == "claude"
    assert resolve_agent("codex", {}, {}) == "codex"


def test_resolve_agent_literal_profile_identity():
    # A literal profile agent is returned untouched (no new validation on literals).
    assert resolve_agent("claude:reviewer", {}, {}) == "claude:reviewer"


def test_resolve_agent_ref_from_step_output():
    assert resolve_agent("$.steps.route.output.agent", FLOW_INPUTS, STEP_OUTPUTS) == "codex"


def test_resolve_agent_ref_from_input():
    assert resolve_agent("$.input.who", FLOW_INPUTS, STEP_OUTPUTS) == "codex"


def test_resolve_agent_ref_profile_prefix_allowed():
    # Resolved "claude:reviewer" — only the connector prefix must be known.
    assert resolve_agent("$.steps.route_profile.output.agent", FLOW_INPUTS, STEP_OUTPUTS) == "claude:reviewer"


def test_resolve_agent_ref_unknown_type_raises():
    with pytest.raises(MCPExecutionError):
        resolve_agent("$.input.who", {"who": "opus"}, {})


def test_resolve_agent_ref_non_string_raises():
    with pytest.raises(MCPExecutionError):
        resolve_agent("$.steps.route.output.agent", {}, {"route": {"agent": {"nested": 1}}})


def test_resolve_agent_ref_unrun_step_raises_ref_error():
    # Referencing a step that has not produced output yet → resolver's own error.
    with pytest.raises(RefResolutionError):
        resolve_agent("$.steps.route.output.agent", {}, {})


# ---------------------------------------------------------------------------
# Flow fixtures
# ---------------------------------------------------------------------------

def _router_spec(impl_agent='"$.steps.route.output.agent"'):
    """route (emits an agent) → implement (agent interpolated from route)."""
    return f"""
version: "0.2"
contracts:
  RouteOut:
    agent: {{type: string}}
  ImplOut:
    ok: {{type: boolean}}
functions:
  route:
    mode: compute
    intent: "Pick the implementation executor."
    input: {{topic: {{type: string}}}}
    output: RouteOut
  implement:
    mode: compute
    intent: "Implement using the routed executor."
    input: {{topic: {{type: string}}}}
    output: ImplOut
    cache: true
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: ImplOut
    steps:
      - id: route
        function: route
        inputs: {{topic: "$.input.topic"}}
      - id: implement
        function: implement
        agent: {impl_agent}
        inputs: {{topic: "$.input.topic"}}
        depends_on: [route]
        cache: true
"""


def _state(spec_text, topic="alpha"):
    spec = parse_and_validate(spec_text)
    return create_flow_state(spec, "main", {"topic": topic}, raw_spec=spec_text)


# ---------------------------------------------------------------------------
# 2 + 5. Dispatch envelope + completion record carry the RESOLVED agent
# ---------------------------------------------------------------------------

def test_dispatch_envelope_carries_resolved_agent():
    st = _state(_router_spec())
    # route is current; advance past it by recording its output.
    info_route = get_current_step_info(st)
    assert info_route["step_id"] == "route"
    st.step_outputs["route"] = {"agent": "codex"}
    st.current_idx += 1
    info_impl = get_current_step_info(st)
    assert info_impl["step_id"] == "implement"
    assert info_impl["agent"] == "codex"  # resolved, not the "$..." literal


def test_dispatch_envelope_resolves_to_claude():
    st = _state(_router_spec())
    st.step_outputs["route"] = {"agent": "claude"}
    st.current_idx += 1
    info_impl = get_current_step_info(st)
    assert info_impl["agent"] == "claude"


def test_literal_agent_envelope_unchanged():
    st = _state(_router_spec(impl_agent="codex"))
    st.step_outputs["route"] = {"agent": "ignored"}
    st.current_idx += 1
    info_impl = get_current_step_info(st)
    assert info_impl["agent"] == "codex"


# ---------------------------------------------------------------------------
# 4. Cache-key correctness
# ---------------------------------------------------------------------------

def _impl_step(st):
    return next(s for s in st.ordered_steps if s.id == "implement")


def test_cache_key_distinct_for_resolved_agents():
    st = _state(_router_spec())
    step = _impl_step(st)
    resolved = {"topic": "alpha"}
    k_codex = result_cache_key(st, step, resolved, "codex")
    k_claude = result_cache_key(st, step, resolved, "claude")
    assert k_codex is not None and k_claude is not None
    assert k_codex != k_claude  # no cross-executor cache collision


def test_cache_key_literal_agent_unaffected_by_resolved_arg():
    # For a literal-agent step the resolved_agent arg must NOT change the key
    # (gated on step.agent.startswith("$")), so existing on-disk caches survive.
    st = _state(_router_spec(impl_agent="codex"))
    step = _impl_step(st)
    resolved = {"topic": "alpha"}
    base = result_cache_key(st, step, resolved)
    with_arg = result_cache_key(st, step, resolved, "claude")
    assert base == with_arg


# ---------------------------------------------------------------------------
# effective_agent
# ---------------------------------------------------------------------------

def test_effective_agent_recomputes_from_state():
    st = _state(_router_spec())
    st.step_outputs["route"] = {"agent": "codex"}
    step = _impl_step(st)
    assert effective_agent(st, step) == "codex"


# ---------------------------------------------------------------------------
# 6. parallel_dispatch envelope carries the resolved agent (server-dispatch path)
# ---------------------------------------------------------------------------

_PARALLEL_SPEC = """
version: "0.3"
contracts:
  RouteOut:
    agent: {type: string}
    tasks: {type: array}
  Out:
    ok: {type: boolean}
functions:
  route:
    mode: infer
    intent: "Pick executor + produce a task graph."
    input: {topic: {type: string}}
    output: RouteOut
flows:
  main:
    input: {topic: {type: string}}
    output: Out
    steps:
      - id: route
        function: route
        inputs: {topic: "$.input.topic"}
      - id: fanout
        type: parallel_dispatch
        agent: "$.steps.route.output.agent"
        source: "$.steps.route.output.tasks"
        intent_template: "Do {description}"
        depends_on: [route]
"""


def test_parallel_dispatch_envelope_resolves_agent():
    st = _state(_PARALLEL_SPEC)
    get_current_step_info(st)  # route is current
    st.step_outputs["route"] = {
        "agent": "codex",
        "tasks": [{"id": "t1", "description": "task one"}],
    }
    st.current_idx += 1
    info = get_current_step_info(st)
    assert info["step_mode"] == "parallel_dispatch"
    assert info["agent"] == "codex"  # resolved from the router output, not the $-ref


# ---------------------------------------------------------------------------
# 7. Cert injection gates on the RESOLVED agent, not the literal $-ref
# ---------------------------------------------------------------------------

_CERT_INTERP_SPEC = """
version: "0.2"
contracts:
  RouteOut:
    agent: {type: string}
functions:
  route:
    mode: compute
    intent: "Pick executor."
    input: {topic: {type: string}}
    output: RouteOut
flows:
  main:
    input: {topic: {type: string}}
    output: ""
    steps:
      - id: route
        function: route
        inputs: {topic: "$.input.topic"}
      - id: s1
        agent: "$.steps.route.output.agent"
        intent: "Analyze the code"
        depends_on: [route]
        reasoning_template:
          require_citations: true
"""

_CERT_MARKER = "You MUST structure your response"


def test_cert_injected_when_ref_resolves_to_claude():
    st = _state(_CERT_INTERP_SPEC)
    st.step_outputs["route"] = {"agent": "claude"}
    st.current_idx += 1
    info = get_current_step_info(st)
    assert info["agent"] == "claude"
    assert _CERT_MARKER in info["intent"]


def test_cert_skipped_when_ref_resolves_to_codex():
    st = _state(_CERT_INTERP_SPEC)
    st.step_outputs["route"] = {"agent": "codex"}
    st.current_idx += 1
    info = get_current_step_info(st)
    assert info["agent"] == "codex"
    assert _CERT_MARKER not in info["intent"]
