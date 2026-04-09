"""Tests for plan_completion ensure builtin (COMP-PLAN-VERIFY)."""
import pytest

from stratum_mcp.spec import plan_completion


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _item(text, file=None, critical=False):
    return {"text": text, "file": file, "critical": critical}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPlanCompletionPasses:
    def test_all_items_in_diff_returns_true(self):
        items = [
            _item("Implement parser", "lib/plan-parser.js"),
            _item("Add ensure builtin", "spec.py"),
        ]
        files = ["lib/plan-parser.js", "spec.py"]
        assert plan_completion(items, files) is True

    def test_empty_plan_items_returns_true(self):
        """Division-by-zero guard: empty items → pass immediately."""
        assert plan_completion([], []) is True
        assert plan_completion([], ["some/file.py"]) is True

    def test_items_without_file_refs_count_as_done(self):
        """Items with no file reference are assumed complete."""
        items = [
            _item("Write design doc"),
            _item("Update CHANGELOG"),
        ]
        assert plan_completion(items, []) is True

    def test_threshold_100_requires_all_items(self):
        items = [
            _item("Task A", "a.py"),
            _item("Task B", "b.py"),
        ]
        files = ["a.py", "b.py"]
        assert plan_completion(items, files, threshold=100) is True

    def test_above_threshold_passes(self):
        """9 of 10 items present → 90% → passes at default threshold."""
        items = [_item(f"Task {i}", f"file{i}.py") for i in range(10)]
        files = [f"file{i}.py" for i in range(9)]  # 9 of 10 present
        assert plan_completion(items, files, threshold=90) is True


class TestPlanCompletionCriticalViolations:
    def test_critical_item_missing_raises(self):
        items = [
            _item("MUST implement auth", "auth.py", critical=True),
            _item("Add tests", "test_auth.py"),
        ]
        files = ["test_auth.py"]
        with pytest.raises(ValueError) as exc_info:
            plan_completion(items, files)
        violations = exc_info.value.args[0]
        assert isinstance(violations, list)
        assert len(violations) == 1
        assert "Missing critical item" in violations[0]
        assert "auth.py" in violations[0]

    def test_critical_violation_is_plain_string(self):
        """Violations must be plain strings, not dicts or structured objects."""
        items = [_item("required: security check", "security.py", critical=True)]
        files = []
        with pytest.raises(ValueError) as exc_info:
            plan_completion(items, files)
        violations = exc_info.value.args[0]
        for v in violations:
            assert isinstance(v, str), f"Expected str violation, got {type(v)}: {v!r}"

    def test_non_critical_missing_does_not_trigger_critical_violation(self):
        """Non-critical missing items only trigger threshold violation, not critical."""
        items = [
            _item("Update README", "README.md", critical=False),
            _item("Core task", "core.py"),
        ]
        files = ["core.py"]  # README missing but not critical
        # With threshold=50, 1 of 2 = 50% — passes
        assert plan_completion(items, files, threshold=50) is True


class TestPlanCompletionThresholdViolations:
    def test_below_threshold_raises_with_percentage(self):
        items = [_item(f"Task {i}", f"file{i}.py") for i in range(10)]
        files = []  # nothing done → 0%
        with pytest.raises(ValueError) as exc_info:
            plan_completion(items, files, threshold=90)
        violations = exc_info.value.args[0]
        assert isinstance(violations, list)
        # First message contains the percentage
        assert "0%" in violations[0] or "0" in violations[0]
        assert "90%" in violations[0] or "90" in violations[0]

    def test_below_threshold_violations_list_missing_items(self):
        items = [
            _item("Task A", "a.py"),
            _item("Task B", "b.py"),
            _item("Task C", "c.py"),
        ]
        files = ["a.py"]  # 1 of 3 = 33% → below 90
        with pytest.raises(ValueError) as exc_info:
            plan_completion(items, files)
        violations = exc_info.value.args[0]
        # Should mention both missing files
        all_text = " ".join(violations)
        assert "b.py" in all_text
        assert "c.py" in all_text

    def test_threshold_100_fails_when_one_missing(self):
        items = [
            _item("Task A", "a.py"),
            _item("Task B", "b.py"),
        ]
        files = ["a.py"]
        with pytest.raises(ValueError):
            plan_completion(items, files, threshold=100)

    def test_violations_contain_only_strings(self):
        """No structured dicts — all violations are plain strings."""
        items = [_item(f"Task {i}", f"file{i}.py") for i in range(5)]
        files = []
        with pytest.raises(ValueError) as exc_info:
            plan_completion(items, files)
        violations = exc_info.value.args[0]
        for v in violations:
            assert isinstance(v, str), f"Violation must be a plain string, got {type(v)}"
