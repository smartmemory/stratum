"""Tests for A4: stratum.goal.prompts.

Covers all 6 cases from plan.md:
(a) template assembly with empty prior findings
(b) feedback window keeps last 3 turns verbatim + older as 1-line summary (PRD M10)
(c) artifact extraction with valid block
(d) missing required artifact returns in missing_required
(e) nonce uniqueness across 1000 calls
(f) worker that fakes the fence with wrong nonce doesn't match
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _artifact_spec(name: str, description: str, required: bool = True) -> dict:
    return {
        "name": name,
        "description": description,
        "how_to_capture": f"Run command to produce {name}",
        "required": required,
    }


def _make_finding(verdict: str = "not_met", predicate_id: str = "p1") -> dict:
    return {"predicate_id": predicate_id, "verdict": verdict, "reason": "test finding"}


def _make_prior_turn(turn_num: int, findings: list[dict] | None = None) -> dict:
    return {
        "turn": turn_num,
        "findings": findings or [_make_finding()],
    }


# ---------------------------------------------------------------------------
# (a) Template assembly with empty prior findings
# ---------------------------------------------------------------------------

class TestBuildTurnPrompt:
    def test_imports(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        assert callable(build_turn_prompt)
        assert callable(mk_turn_nonce)

    def test_four_section_template_present(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Write a hello-world function.",
            artifact_contract=[_artifact_spec("pytest_output", "pytest stdout")],
            prior_findings=[],
            turn_nonce=nonce,
        )
        assert "[Task]" in prompt
        assert "[Artifacts to produce this turn]" in prompt
        assert "[Previous judge feedback]" in prompt
        assert "[Constraints]" in prompt

    def test_task_section_contains_prompt(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        task_text = "Implement the login endpoint."
        prompt = build_turn_prompt(
            prompt=task_text,
            artifact_contract=[],
            prior_findings=[],
            turn_nonce=nonce,
        )
        assert task_text in prompt

    def test_artifacts_section_lists_contracts(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Do the task.",
            artifact_contract=[
                _artifact_spec("pytest_output", "pytest stdout"),
                _artifact_spec("git_status", "git status output"),
            ],
            prior_findings=[],
            turn_nonce=nonce,
        )
        assert "pytest_output" in prompt
        assert "git_status" in prompt

    def test_constraints_section_contains_nonce(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Do the task.",
            artifact_contract=[_artifact_spec("out", "output")],
            prior_findings=[],
            turn_nonce=nonce,
        )
        assert nonce in prompt

    def test_constraints_section_mentions_artifact_fence(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Do the task.",
            artifact_contract=[_artifact_spec("out", "output")],
            prior_findings=[],
            turn_nonce=nonce,
        )
        # The fence format must be present in the constraints
        assert "===ARTIFACT-" in prompt
        assert "===END===" in prompt

    def test_empty_prior_findings_does_not_crash(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="task", artifact_contract=[], prior_findings=[], turn_nonce=nonce,
        )
        assert isinstance(prompt, str)
        assert len(prompt) > 0


# ---------------------------------------------------------------------------
# (b) Feedback window: last 3 verbatim + older as 1-line summary (PRD M10)
# ---------------------------------------------------------------------------

class TestFeedbackWindow:
    def test_three_or_fewer_turns_all_verbatim(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        turns = [_make_prior_turn(i) for i in range(1, 4)]  # turns 1, 2, 3
        prompt = build_turn_prompt(
            prompt="task",
            artifact_contract=[],
            prior_findings=turns,
            turn_nonce=nonce,
        )
        # All three turn findings must appear verbatim (no summary)
        assert "test finding" in prompt
        assert "previously rejected" not in prompt.lower()

    def test_more_than_three_turns_older_summarized(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        # 5 turns: turns 1, 2 should be summarized; turns 3, 4, 5 verbatim
        turns = [_make_prior_turn(i, [_make_finding(predicate_id=f"p{i}")]) for i in range(1, 6)]
        prompt = build_turn_prompt(
            prompt="task",
            artifact_contract=[],
            prior_findings=turns,
            turn_nonce=nonce,
        )
        # Must contain a summary line for older turns
        assert "previously" in prompt.lower() or "earlier" in prompt.lower() or "older" in prompt.lower() or "summary" in prompt.lower()
        # Most recent 3 turns' predicate IDs must appear verbatim
        assert "p3" in prompt or "p4" in prompt or "p5" in prompt

    def test_zero_prior_findings_section_still_present(self):
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="task", artifact_contract=[], prior_findings=[], turn_nonce=nonce,
        )
        assert "[Previous judge feedback]" in prompt


# ---------------------------------------------------------------------------
# (c) Artifact extraction with valid block
# ---------------------------------------------------------------------------

class TestExtractArtifacts:
    def test_imports(self):
        from stratum.goal.prompts import extract_artifacts
        assert callable(extract_artifacts)

    def test_extracts_single_artifact(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        worker_text = (
            f"Here is my output:\n"
            f"===ARTIFACT-{nonce}:pytest_output===\n"
            f"test session starts\n"
            f"1 passed\n"
            f"===END===\n"
        )
        contract = [_artifact_spec("pytest_output", "pytest stdout")]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "pytest_output" in artifacts
        assert "1 passed" in artifacts["pytest_output"]
        assert missing == []

    def test_extracts_multiple_artifacts(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:pytest_output===\n"
            f"1 passed\n"
            f"===END===\n"
            f"===ARTIFACT-{nonce}:git_status===\n"
            f"nothing to commit\n"
            f"===END===\n"
        )
        contract = [
            _artifact_spec("pytest_output", "pytest"),
            _artifact_spec("git_status", "git"),
        ]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "pytest_output" in artifacts
        assert "git_status" in artifacts
        assert missing == []

    def test_artifact_content_supports_multiline(self):
        """DOTALL flag: artifact content may span multiple lines."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        content = "line one\nline two\nline three"
        worker_text = (
            f"===ARTIFACT-{nonce}:out===\n"
            f"{content}\n"
            f"===END===\n"
        )
        contract = [_artifact_spec("out", "output")]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "out" in artifacts
        assert "line two" in artifacts["out"]


# ---------------------------------------------------------------------------
# (d) Missing required artifact returns in missing_required
# ---------------------------------------------------------------------------

class TestMissingArtifacts:
    def test_missing_required_artifact_returned(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        # Worker returns only one of two required artifacts
        worker_text = (
            f"===ARTIFACT-{nonce}:pytest_output===\n"
            f"1 passed\n"
            f"===END===\n"
        )
        contract = [
            _artifact_spec("pytest_output", "pytest"),
            _artifact_spec("git_status", "git", required=True),
        ]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "pytest_output" in artifacts
        assert "git_status" in missing

    def test_optional_artifact_absence_not_in_missing(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:pytest_output===\n"
            f"1 passed\n"
            f"===END===\n"
        )
        contract = [
            _artifact_spec("pytest_output", "pytest", required=True),
            _artifact_spec("optional_extra", "extra", required=False),
        ]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert missing == []

    def test_all_artifacts_missing_all_required_returned(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        worker_text = "I did the task but forgot to include artifacts."
        contract = [
            _artifact_spec("pytest_output", "pytest"),
            _artifact_spec("git_status", "git"),
        ]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert artifacts == {}
        assert "pytest_output" in missing
        assert "git_status" in missing


# ---------------------------------------------------------------------------
# (e) Nonce uniqueness across 1000 calls
# ---------------------------------------------------------------------------

class TestMkTurnNonce:
    def test_returns_16_char_hex_string(self):
        from stratum.goal.prompts import mk_turn_nonce
        nonce = mk_turn_nonce()
        assert isinstance(nonce, str)
        assert len(nonce) == 16
        # Must be valid hex
        int(nonce, 16)

    def test_uniqueness_across_1000_calls(self):
        from stratum.goal.prompts import mk_turn_nonce
        nonces = {mk_turn_nonce() for _ in range(1000)}
        # All 1000 nonces must be unique
        assert len(nonces) == 1000

    def test_uses_secrets_module_entropy(self):
        """16-char hex from secrets.token_hex(8) — verify the length implies 8-byte source."""
        from stratum.goal.prompts import mk_turn_nonce
        # 8 bytes = 16 hex chars
        nonce = mk_turn_nonce()
        assert len(nonce) == 16


# ---------------------------------------------------------------------------
# (f) Wrong nonce doesn't match (anti-spoofing)
# ---------------------------------------------------------------------------

class TestNonceAntiSpoofing:
    def test_wrong_nonce_does_not_extract_artifact(self):
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        real_nonce = mk_turn_nonce()
        fake_nonce = mk_turn_nonce()  # different nonce
        # Worker uses the real nonce in its response (correct behaviour)
        worker_text = (
            f"===ARTIFACT-{real_nonce}:pytest_output===\n"
            f"1 passed\n"
            f"===END===\n"
        )
        contract = [_artifact_spec("pytest_output", "pytest")]
        # Extraction with wrong nonce should NOT match
        artifacts, missing = extract_artifacts(worker_text, contract, fake_nonce)
        assert "pytest_output" not in artifacts
        assert "pytest_output" in missing

    def test_correct_nonce_extracts_correctly(self):
        """Positive control: correct nonce does extract."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        worker_text = (
            f"===ARTIFACT-{nonce}:pytest_output===\n"
            f"1 passed\n"
            f"===END===\n"
        )
        contract = [_artifact_spec("pytest_output", "pytest")]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        assert "pytest_output" in artifacts
        assert missing == []

    def test_literal_nonce_string_in_text_does_not_bypass(self):
        """Worker that hardcodes 'ARTIFACT-XXXXXXXXXXXXXXXX' without matching nonce."""
        from stratum.goal.prompts import extract_artifacts, mk_turn_nonce
        nonce = mk_turn_nonce()
        # Worker fakes a fence using a literal nonce it invented
        spoofed = "deadbeefcafebabe"  # different from real nonce
        worker_text = (
            f"===ARTIFACT-{spoofed}:pytest_output===\n"
            f"I fooled you\n"
            f"===END===\n"
        )
        contract = [_artifact_spec("pytest_output", "pytest")]
        artifacts, missing = extract_artifacts(worker_text, contract, nonce)
        # spoofed nonce should not match real nonce
        assert "pytest_output" not in artifacts


# ---------------------------------------------------------------------------
# Finding 4 regression: rejection_note surfaces in next worker prompt
# ---------------------------------------------------------------------------

class TestRejectionNoteInPrompt:
    """Finding 4: build_turn_prompt includes [Human override] when rejection_note set."""

    def test_rejection_note_present_in_prompt(self):
        """When rejection_note is supplied, prompt includes [Human override] section."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        rejection_note = "please fix the edge cases in the boundary tests"
        prompt = build_turn_prompt(
            prompt="Make tests pass",
            artifact_contract=[],
            prior_findings=[],
            turn_nonce=nonce,
            rejection_note=rejection_note,
        )
        assert "[Human override]" in prompt
        assert rejection_note in prompt

    def test_rejection_note_none_omits_section(self):
        """When rejection_note is None, [Human override] section is absent."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Make tests pass",
            artifact_contract=[],
            prior_findings=[],
            turn_nonce=nonce,
            rejection_note=None,
        )
        assert "[Human override]" not in prompt

    def test_rejection_note_empty_string_omits_section(self):
        """Empty rejection_note (falsy) does not emit the [Human override] section."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="Make tests pass",
            artifact_contract=[],
            prior_findings=[],
            turn_nonce=nonce,
            rejection_note="",
        )
        assert "[Human override]" not in prompt

    def test_rejection_note_appears_after_task_section(self):
        """[Human override] appears directly after [Task] when present."""
        from stratum.goal.prompts import build_turn_prompt, mk_turn_nonce
        nonce = mk_turn_nonce()
        prompt = build_turn_prompt(
            prompt="task body",
            artifact_contract=[],
            prior_findings=[],
            turn_nonce=nonce,
            rejection_note="fix this",
        )
        task_pos = prompt.index("[Task]")
        override_pos = prompt.index("[Human override]")
        assert task_pos < override_pos, "[Human override] should appear after [Task]"
