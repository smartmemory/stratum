"""STRAT-WORKFLOW-RESUME S4: result_cache_key + cache_enabled helpers.

The key folds only the step's own fingerprint + its function's fingerprint (NOT
the whole-flow spec_checksum), so editing a later step does not change an earlier
step's key — that is the prefix property.
"""
from types import SimpleNamespace

from stratum_mcp.executor import cache_enabled, result_cache_key, create_flow_state
from stratum_mcp.spec import parse_and_validate


def _spec(fn_intent="Research a value"):
    return f"""
version: "0.2"
contracts:
  Out:
    value: {{type: string}}
functions:
  research:
    mode: compute
    intent: "{fn_intent}"
    input: {{topic: {{type: string}}}}
    output: Out
    ensure: ["len(result.value) > 0"]
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
      - id: s_research
        function: research
        inputs: {{topic: "$.input.topic"}}
        cache: true
"""


def _state(fn_intent="Research a value", flow_name="main"):
    ir = _spec(fn_intent)
    spec = parse_and_validate(ir)
    st = create_flow_state(spec, "main", {"topic": "alpha"}, raw_spec=ir)
    st.flow_name = flow_name
    return st


def _step(state):
    return state.ordered_steps[0]


RESOLVED = {"topic": "alpha", "n": 3}


def test_key_is_deterministic():
    s = _state()
    a = result_cache_key(s, _step(s), RESOLVED)
    b = result_cache_key(s, _step(s), dict(RESOLVED))
    assert a is not None and a == b


def test_key_is_sha256_hex():
    s = _state()
    k = result_cache_key(s, _step(s), RESOLVED)
    assert len(k) == 64 and all(c in "0123456789abcdef" for c in k)


def test_key_changes_with_resolved_input():
    s = _state()
    a = result_cache_key(s, _step(s), {"topic": "alpha"})
    b = result_cache_key(s, _step(s), {"topic": "beta"})
    assert a != b


def test_key_changes_with_function_intent():
    """Editing the step's function intent changes its key (fn fingerprint)."""
    s1 = _state(fn_intent="Research a value")
    s2 = _state(fn_intent="Research a DIFFERENT value")
    a = result_cache_key(s1, _step(s1), RESOLVED)
    b = result_cache_key(s2, _step(s2), RESOLVED)
    assert a != b


def test_key_changes_with_output_contract_shape():
    """Editing the function's output contract field shape invalidates the key."""
    ir_a = """
version: "0.2"
contracts:
  Out:
    value: {type: string}
functions:
  research:
    mode: compute
    intent: "Research a value"
    input: {topic: {type: string}}
    output: Out
flows:
  main:
    input: {topic: {type: string}}
    output: Out
    steps:
      - id: s_research
        function: research
        inputs: {topic: "$.input.topic"}
        cache: true
"""
    ir_b = ir_a.replace("    value: {type: string}", "    value: {type: string}\n    extra: {type: string}")
    sa = parse_and_validate(ir_a)
    sb = parse_and_validate(ir_b)
    st_a = create_flow_state(sa, "main", {"topic": "alpha"}, raw_spec=ir_a)
    st_b = create_flow_state(sb, "main", {"topic": "alpha"}, raw_spec=ir_b)
    a = result_cache_key(st_a, st_a.ordered_steps[0], RESOLVED)
    b = result_cache_key(st_b, st_b.ordered_steps[0], RESOLVED)
    assert a != b


def test_key_changes_with_output_schema():
    """Editing a step's output_schema invalidates the key."""
    base = """
version: "0.2"
contracts:
  Out:
    value: {type: string}
functions:
  research:
    mode: compute
    intent: "Research a value"
    input: {topic: {type: string}}
    output: Out
flows:
  main:
    input: {topic: {type: string}}
    output: Out
    steps:
      - id: s_research
        function: research
        inputs: {topic: "$.input.topic"}
        cache: true
"""
    with_schema = base.replace(
        '        cache: true\n',
        '        cache: true\n        output_schema: {type: object, required: [value]}\n',
    )
    s1 = parse_and_validate(base)
    s2 = parse_and_validate(with_schema)
    st1 = create_flow_state(s1, "main", {"topic": "alpha"}, raw_spec=base)
    st2 = create_flow_state(s2, "main", {"topic": "alpha"}, raw_spec=with_schema)
    a = result_cache_key(st1, st1.ordered_steps[0], RESOLVED)
    b = result_cache_key(st2, st2.ordered_steps[0], RESOLVED)
    assert a != b


def test_key_changes_with_flow_name():
    s1 = _state(flow_name="f1")
    s2 = _state(flow_name="f2")
    a = result_cache_key(s1, _step(s1), RESOLVED)
    b = result_cache_key(s2, _step(s2), RESOLVED)
    assert a != b


def test_key_none_on_nonserializable_resolved():
    s = _state()
    assert result_cache_key(s, _step(s), {"bad": {1, 2, 3}}) is None


def test_cache_enabled_step_level():
    assert cache_enabled(SimpleNamespace(cache=True), None) is True


def test_cache_enabled_function_level():
    assert cache_enabled(SimpleNamespace(cache=False), SimpleNamespace(cache=True)) is True


def test_cache_disabled_when_neither():
    assert cache_enabled(SimpleNamespace(cache=False), SimpleNamespace(cache=False)) is False
