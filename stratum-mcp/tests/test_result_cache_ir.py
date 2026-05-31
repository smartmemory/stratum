"""STRAT-WORKFLOW-RESUME S2: `cache` IR field parse + checksum fingerprint.

Also locks in the guardrail-checksum fix (guardrails were previously absent from
compute_spec_checksum, so a guardrail edit did not invalidate a cached result).

`cache` and `guardrails` are v0.2+ IR features, so these specs declare
`version: "0.2"`. Step-level `guardrails` are forbidden on function-referencing
steps (must live on the function), so the step-guardrail checksum case uses an
inline step.
"""
from stratum_mcp.executor import compute_spec_checksum
from stratum_mcp.spec import parse_and_validate


def _spec(cache_step="", cache_fn="", fn_guardrails=""):
    return f"""
version: "0.2"
contracts:
  Out:
    value: {{type: string}}
functions:
  research:
    mode: compute
    intent: "Research a value"
    input: {{topic: {{type: string}}}}
    output: Out
    retries: 2
    ensure: ["len(result.value) > 0"]{fn_guardrails}{cache_fn}
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
      - id: s_research
        function: research
        inputs: {{topic: "$.input.topic"}}{cache_step}
"""


def _inline_spec(step_guardrails=""):
    return f"""
version: "0.2"
contracts:
  Out:
    value: {{type: string}}
functions:
  research:
    mode: compute
    intent: "Research a value"
    input: {{topic: {{type: string}}}}
    output: Out
flows:
  main:
    input: {{topic: {{type: string}}}}
    output: Out
    steps:
      - id: s_inline
        intent: "inline produce"
        inputs: {{topic: "$.input.topic"}}
        output_schema: {{type: object}}{step_guardrails}
"""


def _checksum(yaml_text):
    spec = parse_and_validate(yaml_text)
    return compute_spec_checksum(spec.flows["main"], spec)


def test_cache_defaults_false():
    spec = parse_and_validate(_spec())
    assert spec.flows["main"].steps[0].cache is False
    assert spec.functions["research"].cache is False


def test_cache_parses_on_step():
    spec = parse_and_validate(_spec(cache_step="\n        cache: true"))
    assert spec.flows["main"].steps[0].cache is True


def test_cache_parses_on_function():
    spec = parse_and_validate(_spec(cache_fn="\n    cache: true"))
    assert spec.functions["research"].cache is True


def test_toggling_cache_changes_checksum():
    assert _checksum(_spec()) != _checksum(_spec(cache_step="\n        cache: true"))


def test_function_guardrail_edit_changes_checksum():
    """The fix: a function guardrail change must invalidate the checksum."""
    assert _checksum(_spec()) != _checksum(
        _spec(fn_guardrails='\n    guardrails: ["SECRET"]')
    )


def test_step_guardrail_edit_changes_checksum():
    """The fix: a step (inline) guardrail change must invalidate the checksum."""
    assert _checksum(_inline_spec()) != _checksum(
        _inline_spec(step_guardrails='\n        guardrails: ["SECRET"]')
    )
