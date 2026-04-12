"""Tests for STRAT-CERT reasoning certificate support.

Covers:
- reasoning_template parsed from YAML into IRStepDef
- Default sections expansion when sections not specified
- validate_certificate detects missing sections
- validate_certificate detects missing citations
- inject_cert_instructions produces correct output
- Certificate validation wired into process_step_result
- CERT-1: reasoning_template rejected on function/parallel_dispatch steps
"""
import textwrap

import pytest

from stratum_mcp.executor import (
    create_flow_state,
    get_current_step_info,
    inject_cert_instructions,
    process_step_result,
    validate_certificate,
)
from stratum_mcp.spec import (
    CERT_DEFAULT_SECTIONS,
    IRSemanticError,
    parse_and_validate,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_INLINE_CERT_SPEC = textwrap.dedent("""\
    version: "0.2"
    flows:
      main:
        input: {}
        output: ""
        steps:
          - id: s1
            agent: claude
            intent: "Analyze the code"
            retries: 2
            reasoning_template:
              require_citations: true
""")

_INLINE_CERT_CUSTOM_SECTIONS_SPEC = textwrap.dedent("""\
    version: "0.2"
    flows:
      main:
        input: {}
        output: ""
        steps:
          - id: s1
            agent: claude
            intent: "Analyze the code"
            reasoning_template:
              sections:
                - id: obs
                  label: Observations
                  description: What you see
                - id: verdict
                  label: Verdict
                  description: Final call
              require_citations: false
""")

_CERT_ON_FUNCTION_SPEC = textwrap.dedent("""\
    version: "0.2"
    contracts:
      Out:
        v: {type: string}
    functions:
      work:
        mode: infer
        intent: "Do work"
        input: {}
        output: Out
    flows:
      main:
        input: {}
        output: Out
        steps:
          - id: s1
            function: work
            inputs: {}
            reasoning_template:
              require_citations: false
""")


# ---------------------------------------------------------------------------
# Parse tests
# ---------------------------------------------------------------------------

class TestReasoningTemplateParsing:

    def test_parsed_with_default_sections(self):
        spec = parse_and_validate(_INLINE_CERT_SPEC)
        step = spec.flows["main"].steps[0]
        assert step.reasoning_template is not None
        assert step.reasoning_template["require_citations"] is True
        # Default sections should have been applied
        assert len(step.reasoning_template["sections"]) == len(CERT_DEFAULT_SECTIONS)
        labels = [s["label"] for s in step.reasoning_template["sections"]]
        assert labels == ["Premises", "Trace", "Conclusion"]

    def test_parsed_with_custom_sections(self):
        spec = parse_and_validate(_INLINE_CERT_CUSTOM_SECTIONS_SPEC)
        step = spec.flows["main"].steps[0]
        assert step.reasoning_template is not None
        labels = [s["label"] for s in step.reasoning_template["sections"]]
        assert labels == ["Observations", "Verdict"]
        assert step.reasoning_template["require_citations"] is False

    def test_no_reasoning_template(self):
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: claude
                    intent: "Do something"
        """)
        spec = parse_and_validate(spec_yaml)
        step = spec.flows["main"].steps[0]
        assert step.reasoning_template is None

    def test_cert_rejected_on_function_step(self):
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(_CERT_ON_FUNCTION_SPEC)

    def test_malformed_section_rejected(self):
        """Section missing label/description should fail validation."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: review
                    agent: claude
                    intent: "Review"
                    reasoning_template:
                      require_citations: true
                      sections:
                        - id: premises
        """)
        with pytest.raises(IRSemanticError, match="missing required field"):
            parse_and_validate(spec_yaml)

    def test_has_validation_codex_agent_cert_only(self):
        """Codex step with reasoning_template but no ensure should not count as validated."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: codex
                    intent: "Review code"
                    on_fail: s1
                    reasoning_template:
                      require_citations: false
        """)
        with pytest.raises(IRSemanticError, match="on_fail but no ensure"):
            parse_and_validate(spec_yaml)


# ---------------------------------------------------------------------------
# validate_certificate tests
# ---------------------------------------------------------------------------

class TestValidateCertificate:

    def test_all_sections_present(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "..."},
                {"label": "Trace", "description": "..."},
                {"label": "Conclusion", "description": "..."},
            ],
            "require_citations": False,
        }
        result = {
            "artifact": "## Premises\nFact A\n## Trace\nStep 1\n## Conclusion\nDone"
        }
        assert validate_certificate(template, result) == []

    def test_missing_section(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "..."},
                {"label": "Trace", "description": "..."},
                {"label": "Conclusion", "description": "..."},
            ],
            "require_citations": False,
        }
        result = {
            "artifact": "## Premises\nFact A\n## Conclusion\nDone"
        }
        violations = validate_certificate(template, result)
        assert len(violations) == 1
        assert "Trace" in violations[0]

    def test_missing_citations(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "..."},
                {"label": "Conclusion", "description": "..."},
            ],
            "require_citations": True,
        }
        result = {
            "artifact": "## Premises\n[P1] something\n## Conclusion\nNo references here"
        }
        violations = validate_certificate(template, result)
        assert len(violations) == 1
        assert "premise citations" in violations[0]

    def test_citations_present(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "..."},
                {"label": "Conclusion", "description": "..."},
            ],
            "require_citations": True,
        }
        result = {
            "artifact": "## Premises\n[P1] something\n## Conclusion\nBased on [P1], done"
        }
        assert validate_certificate(template, result) == []

    def test_citations_not_checked_when_sections_missing(self):
        """When sections are missing, citations are not checked (sections take priority)."""
        template = {
            "sections": [
                {"label": "Premises", "description": "..."},
                {"label": "Conclusion", "description": "..."},
            ],
            "require_citations": True,
        }
        result = {"artifact": "## Conclusion\nNo refs"}
        violations = validate_certificate(template, result)
        # Only section violation, not citation violation
        assert len(violations) == 1
        assert "Premises" in violations[0]

    def test_empty_artifact(self):
        template = {
            "sections": [{"label": "A", "description": "..."}],
            "require_citations": False,
        }
        result = {"artifact": ""}
        violations = validate_certificate(template, result)
        assert len(violations) == 1

    def test_no_artifact_key(self):
        template = {
            "sections": [{"label": "A", "description": "..."}],
            "require_citations": False,
        }
        result = {"summary": "something"}
        violations = validate_certificate(template, result)
        assert len(violations) == 1


# ---------------------------------------------------------------------------
# inject_cert_instructions tests
# ---------------------------------------------------------------------------

class TestInjectCertInstructions:

    def test_basic_injection(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "State facts"},
                {"label": "Conclusion", "description": "Final finding"},
            ],
            "require_citations": False,
        }
        result = inject_cert_instructions("Analyze code", template)
        assert "Analyze code" in result
        assert "## Premises" in result
        assert "## Conclusion" in result
        assert "You MUST structure your response" in result
        # No citation instructions when require_citations=False
        assert "[P1]" not in result

    def test_citation_instructions(self):
        template = {
            "sections": [
                {"label": "Premises", "description": "State facts"},
                {"label": "Conclusion", "description": "Final finding"},
            ],
            "require_citations": True,
        }
        result = inject_cert_instructions("Review code", template)
        assert "Format each fact as: [P1]" in result
        assert "Reference premises by their [P<n>] ID." in result


# ---------------------------------------------------------------------------
# Integration: cert validation wired into process_step_result
# ---------------------------------------------------------------------------

class TestCertInProcessStepResult:

    def test_cert_failure_returns_ensure_failed(self):
        spec = parse_and_validate(_INLINE_CERT_SPEC)
        state = create_flow_state(spec, "main", {})
        step_info = get_current_step_info(state)
        assert step_info is not None
        assert step_info["step_id"] == "s1"
        # Intent should have cert instructions injected
        assert "## Premises" in step_info["intent"]

        # Submit result missing required sections
        status, violations = process_step_result(state, "s1", {"artifact": "no sections"})
        assert status == "ensure_failed"
        assert any("certificate missing section" in v for v in violations)

    def test_cert_pass_with_all_sections(self):
        spec = parse_and_validate(_INLINE_CERT_SPEC)
        state = create_flow_state(spec, "main", {})
        get_current_step_info(state)

        artifact = (
            "## Premises\n[P1] fact at file:1\n"
            "## Trace\nBased on [P1]\n"
            "## Conclusion\nPer [P1], done"
        )
        status, violations = process_step_result(state, "s1", {"artifact": artifact})
        assert status == "ok"
        assert violations == []

    def test_cert_failure_exhausts_retries(self):
        spec = parse_and_validate(_INLINE_CERT_SPEC)
        state = create_flow_state(spec, "main", {})
        get_current_step_info(state)

        # retries=2: attempt 1 → ensure_failed (retry available)
        status, violations = process_step_result(state, "s1", {"artifact": "nope"})
        assert status == "ensure_failed"
        assert any("certificate missing section" in v for v in violations)

        # Re-dispatch and fail again — should exhaust retries
        get_current_step_info(state)
        status, violations = process_step_result(state, "s1", {"artifact": "still nope"})
        assert status == "retries_exhausted"
        assert any("certificate missing section" in v for v in violations)


class TestCertIntentInjection:

    def test_inline_step_intent_includes_cert(self):
        spec = parse_and_validate(_INLINE_CERT_SPEC)
        state = create_flow_state(spec, "main", {})
        step_info = get_current_step_info(state)
        assert "## Premises" in step_info["intent"]
        assert "## Trace" in step_info["intent"]
        assert "## Conclusion" in step_info["intent"]

    def test_custom_sections_in_intent(self):
        spec = parse_and_validate(_INLINE_CERT_CUSTOM_SECTIONS_SPEC)
        state = create_flow_state(spec, "main", {})
        step_info = get_current_step_info(state)
        assert "## Observations" in step_info["intent"]
        assert "## Verdict" in step_info["intent"]

    def test_no_cert_no_injection(self):
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: claude
                    intent: "Plain intent"
        """)
        spec = parse_and_validate(spec_yaml)
        state = create_flow_state(spec, "main", {})
        step_info = get_current_step_info(state)
        assert step_info["intent"] == "Plain intent"
        assert "## Premises" not in step_info["intent"]


# ---------------------------------------------------------------------------
# Empty sections guard tests
# ---------------------------------------------------------------------------

class TestEmptySectionsGuard:

    def test_validate_certificate_empty_sections_no_crash(self):
        """validate_certificate with empty sections and require_citations should not crash."""
        template = {"require_citations": True, "sections": []}
        result = {"artifact": "some text"}
        violations = validate_certificate(template, result)
        # No IndexError — should return empty violations (no sections to check)
        assert violations == []

    def test_empty_sections_list_rejected_at_parse(self):
        """Explicitly passing sections: [] should be rejected during parsing."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: review
                    agent: claude
                    intent: "Review"
                    reasoning_template:
                      require_citations: false
                      sections: []
        """)
        with pytest.raises(IRSemanticError, match="at least one section"):
            parse_and_validate(spec_yaml)


# ---------------------------------------------------------------------------
# CERT-1: reasoning_template rejected on flow steps
# ---------------------------------------------------------------------------

class TestCertOnFlowStep:

    def test_cert_rejected_on_flow_step(self):
        """reasoning_template is not valid on flow steps."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              sub:
                input: {}
                output: ""
                steps:
                  - id: work
                    agent: claude
                    intent: "Do work"
              main:
                input: {}
                output: ""
                steps:
                  - id: delegate
                    flow: sub
                    reasoning_template:
                      require_citations: false
        """)
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(spec_yaml)


# ---------------------------------------------------------------------------
# STRAT-CERT-PAR: task_reasoning_template on parallel_dispatch steps
# ---------------------------------------------------------------------------

_PAR_CERT_SPEC = textwrap.dedent("""\
    version: "0.3"
    contracts:
      TaskGraph:
        tasks: {type: array}
    flows:
      main:
        input: {}
        steps:
          - id: analyze
            type: decompose
            agent: claude
            intent: "Break down"
            output_contract: TaskGraph
          - id: execute
            type: parallel_dispatch
            source: "$.steps.analyze.output.tasks"
            agent: claude
            require: all
            intent_template: "Do: {task.desc}"
            depends_on: [analyze]
            task_reasoning_template:
              require_citations: true
""")

_PAR_CERT_CUSTOM_SECTIONS_SPEC = textwrap.dedent("""\
    version: "0.3"
    contracts:
      TaskGraph:
        tasks: {type: array}
    flows:
      main:
        input: {}
        steps:
          - id: analyze
            type: decompose
            agent: claude
            intent: "Break down"
            output_contract: TaskGraph
          - id: execute
            type: parallel_dispatch
            source: "$.steps.analyze.output.tasks"
            agent: claude
            require: all
            intent_template: "Do: {task.desc}"
            depends_on: [analyze]
            task_reasoning_template:
              require_citations: false
              sections:
                - id: findings
                  label: Findings
                  description: What you found
""")


class TestTaskReasoningTemplate:

    def test_task_reasoning_template_accepted_on_parallel_dispatch(self):
        """task_reasoning_template parses cleanly on parallel_dispatch steps."""
        spec = parse_and_validate(_PAR_CERT_SPEC)
        exec_step = spec.flows["main"].steps[1]
        assert exec_step.task_reasoning_template is not None
        assert exec_step.task_reasoning_template["require_citations"] is True

    def test_task_reasoning_template_applies_defaults(self):
        """Missing sections → CERT_DEFAULT_SECTIONS applied."""
        spec = parse_and_validate(_PAR_CERT_SPEC)
        exec_step = spec.flows["main"].steps[1]
        sections = exec_step.task_reasoning_template["sections"]
        assert len(sections) == len(CERT_DEFAULT_SECTIONS)
        assert [s["id"] for s in sections] == [s["id"] for s in CERT_DEFAULT_SECTIONS]

    def test_task_reasoning_template_preserves_custom_sections(self):
        """Custom sections preserved as-is."""
        spec = parse_and_validate(_PAR_CERT_CUSTOM_SECTIONS_SPEC)
        exec_step = spec.flows["main"].steps[1]
        sections = exec_step.task_reasoning_template["sections"]
        assert len(sections) == 1
        assert sections[0]["id"] == "findings"

    def test_task_reasoning_template_rejects_missing_section_fields(self):
        """Section missing required field → IRSemanticError."""
        spec_yaml = textwrap.dedent("""\
            version: "0.3"
            contracts:
              TaskGraph:
                tasks: {type: array}
            flows:
              main:
                input: {}
                steps:
                  - id: analyze
                    type: decompose
                    agent: claude
                    intent: "Break down"
                    output_contract: TaskGraph
                  - id: execute
                    type: parallel_dispatch
                    source: "$.steps.analyze.output.tasks"
                    agent: claude
                    require: all
                    intent_template: "Do: {task.desc}"
                    depends_on: [analyze]
                    task_reasoning_template:
                      sections:
                        - label: Bad
                          description: missing id
        """)
        with pytest.raises(IRSemanticError, match="task_reasoning_template"):
            parse_and_validate(spec_yaml)

    def test_task_reasoning_template_rejected_on_inline_step(self):
        """task_reasoning_template only valid on parallel_dispatch."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: claude
                    intent: "Do work"
                    task_reasoning_template:
                      require_citations: false
        """)
        with pytest.raises(IRSemanticError, match="task_reasoning_template"):
            parse_and_validate(spec_yaml)

    def test_reasoning_template_still_rejected_on_parallel_dispatch(self):
        """CERT-1 preserved: reasoning_template (non-task variant) still blocked."""
        spec_yaml = textwrap.dedent("""\
            version: "0.3"
            contracts:
              TaskGraph:
                tasks: {type: array}
            flows:
              main:
                input: {}
                steps:
                  - id: analyze
                    type: decompose
                    agent: claude
                    intent: "Break down"
                    output_contract: TaskGraph
                  - id: execute
                    type: parallel_dispatch
                    source: "$.steps.analyze.output.tasks"
                    agent: claude
                    require: all
                    intent_template: "Do: {task.desc}"
                    depends_on: [analyze]
                    reasoning_template:
                      require_citations: false
        """)
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(spec_yaml)


# ---------------------------------------------------------------------------
# STRAT-CERT-PAR: claude-agent gate alignment (startswith('claude'))
# Regression locks for the four gate sites.
# ---------------------------------------------------------------------------

class TestClaudeProfileAgentGating:
    """After STRAT-CERT-PAR T2.2, claude-profile agents (e.g. claude:read-only-reviewer)
    are validated, have certs injected, and are accepted by the on_fail viability check."""

    def test_cert_validates_claude_profile_agents(self):
        """Inline step with agent=claude:read-only-reviewer runs cert validation."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: "claude:read-only-reviewer"
                    intent: "Review"
                    reasoning_template:
                      require_citations: false
        """)
        spec = parse_and_validate(spec_yaml)
        state = create_flow_state(spec, "main", {})
        get_current_step_info(state)  # dispatch step to set attempts
        # Result missing cert sections should fail validation
        bad_result = {"artifact": "no headings at all"}
        status, violations = process_step_result(state, "s1", bad_result)
        assert status in ("ensure_failed", "retries_exhausted")
        assert any("certificate" in v.lower() for v in violations)

    def test_cert_injects_for_claude_profile_agents(self):
        """Inline step with agent=claude:read-only-reviewer gets cert instructions injected."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: "claude:read-only-reviewer"
                    intent: "Review"
                    reasoning_template:
                      require_citations: false
        """)
        spec = parse_and_validate(spec_yaml)
        state = create_flow_state(spec, "main", {})
        step_info = get_current_step_info(state)
        assert "## Premises" in step_info["intent"]
        assert "## Trace" in step_info["intent"]
        assert "## Conclusion" in step_info["intent"]

    def test_on_fail_accepts_cert_as_validator_for_claude_profile(self):
        """Parse-time on_fail viability check treats reasoning_template as validation
        on claude-profile agents."""
        spec_yaml = textwrap.dedent("""\
            version: "0.2"
            flows:
              main:
                input: {}
                output: ""
                steps:
                  - id: s1
                    agent: "claude:read-only-reviewer"
                    intent: "Review"
                    reasoning_template:
                      require_citations: false
                    on_fail: fallback
                  - id: fallback
                    agent: claude
                    intent: "Fallback"
        """)
        # Should parse without raising (cert counts as validator for on_fail)
        parse_and_validate(spec_yaml)
