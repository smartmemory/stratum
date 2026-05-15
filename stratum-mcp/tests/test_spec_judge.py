"""Tests for STRAT-JUDGE v1 spec.py edits.

Covers:
- judge: block on a step parses into JudgeStepConfig
- Exclusivity validator rejects judge + function together
- Exclusivity validator accepts judge alone
- Schema rejects empty predicates list (minItems: 1)
"""
import textwrap

import pytest

from stratum_mcp.errors import IRSemanticError, IRValidationError
from stratum_mcp.spec import JudgeStepConfig, parse_and_validate


def _judge_spec(judge_block: str = None, extra_step_line: str = "") -> str:
    """v0.3 spec with a single judge step. ``judge_block`` is YAML for the
    judge: subtree (indented to match an 8-space step indent).
    """
    if judge_block is None:
        judge_block = textwrap.dedent("""\
            judge:
                  predicates:
                    - id: p1
                      type: deterministic
                      statement: "file_exists('artifacts/out.txt')"
        """).rstrip()
        # Re-indent each line under "              " (14 spaces step body)
        lines = judge_block.splitlines()
        judge_block = "\n".join("              " + ln if i > 0 else ln
                                for i, ln in enumerate(lines))
    return textwrap.dedent(f"""\
        version: "0.3"
        flows:
          build:
            input: {{}}
            output: ""
            steps:
              - id: verify
                agent: claude
                {extra_step_line}
                {judge_block}
        """)


class TestJudgeSpecParse:
    def test_judge_block_parses_into_step_config(self):
        spec = parse_and_validate(_judge_spec())
        step = spec.flows["build"].steps[0]
        assert step.judge is not None
        assert isinstance(step.judge, JudgeStepConfig)
        assert len(step.judge.predicates) == 1
        p = step.judge.predicates[0]
        assert p["id"] == "p1"
        assert p["type"] == "deterministic"
        assert step.judge.stakes == "default"
        assert step.judge.budget is None

    def test_judge_step_has_judge_mode(self):
        from stratum_mcp.executor import _step_mode
        spec = parse_and_validate(_judge_spec())
        step = spec.flows["build"].steps[0]
        assert _step_mode(step) == "judge"

    def test_judge_with_budget_and_stakes(self):
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    judge:
                      stakes: cheap
                      budget:
                        max_turns: 3
                        max_wall_clock_s: 30
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "file_exists('artifacts/out.txt')"
            """)
        spec = parse_and_validate(yaml_text)
        step = spec.flows["build"].steps[0]
        assert step.judge.stakes == "cheap"
        assert step.judge.budget == {"max_turns": 3, "max_wall_clock_s": 30}


class TestJudgeExclusivity:
    def test_judge_alone_passes(self):
        # Should not raise
        parse_and_validate(_judge_spec())

    def test_judge_plus_function_rejected(self):
        # Function is invalid because no function-def, but exclusivity should
        # fire FIRST. We assert IRSemanticError is raised with the new message.
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            functions:
              do_it:
                mode: infer
                intent: "do the thing"
                input: {}
                output: Result
            contracts:
              Result:
                ok: {type: boolean}
            flows:
              build:
                input: {}
                output: Result
                steps:
                  - id: verify
                    agent: claude
                    function: do_it
                    inputs: {}
                    judge:
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "True"
            """)
        with pytest.raises(IRSemanticError) as exc_info:
            parse_and_validate(yaml_text)
        assert "exactly one of function, intent, flow, or judge" in str(exc_info.value)

    def test_judge_plus_intent_rejected(self):
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    intent: "do something"
                    judge:
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "True"
            """)
        with pytest.raises(IRSemanticError):
            parse_and_validate(yaml_text)


class TestJudgeSchema:
    def test_empty_predicates_rejected_by_schema(self):
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    judge:
                      predicates: []
            """)
        with pytest.raises(IRValidationError):
            parse_and_validate(yaml_text)

    def test_unknown_judge_field_rejected(self):
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    judge:
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "True"
                      garbage_field: "x"
            """)
        with pytest.raises(IRValidationError):
            parse_and_validate(yaml_text)

    def test_invalid_stakes_rejected(self):
        yaml_text = textwrap.dedent("""\
            version: "0.3"
            flows:
              build:
                input: {}
                output: ""
                steps:
                  - id: verify
                    agent: claude
                    judge:
                      stakes: paranoid
                      predicates:
                        - id: p1
                          type: deterministic
                          statement: "True"
            """)
        with pytest.raises(IRValidationError):
            parse_and_validate(yaml_text)
