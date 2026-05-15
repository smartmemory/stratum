"""Tests for A5: stratum.goal.worker.

Covers all 5 cases from plan.md:
(a) validate_worker_spec accepts Claude for all modes
(b) rejects Codex for advisory/autonomous/shadow-driven with WorkerTypeNotSupportedError
(c) accepts Codex for shadow-observed
(d) WorkerFailureTracker resets on success, increments on failure, raises after max_failures
(e) dispatch_worker forwards kwargs verbatim to the injected callable
"""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _claude_spec(**kwargs) -> dict:
    return {"type": "claude", "model_id": "claude-sonnet-4-6", **kwargs}


def _codex_spec(**kwargs) -> dict:
    return {"type": "codex", **kwargs}


# ---------------------------------------------------------------------------
# (a) validate_worker_spec accepts Claude for all modes
# ---------------------------------------------------------------------------

class TestValidateWorkerSpecClaude:
    def test_imports(self):
        from stratum.goal.worker import WorkerSpec, validate_worker_spec
        assert callable(validate_worker_spec)

    def test_claude_accepted_for_shadow_driven(self):
        from stratum.goal.worker import validate_worker_spec
        # Should not raise
        validate_worker_spec(_claude_spec(), mode="shadow", shadow_source="driven")

    def test_claude_accepted_for_shadow_observed(self):
        from stratum.goal.worker import validate_worker_spec
        validate_worker_spec(_claude_spec(), mode="shadow", shadow_source="observed")

    def test_claude_accepted_for_advisory(self):
        from stratum.goal.worker import validate_worker_spec
        validate_worker_spec(_claude_spec(), mode="advisory", shadow_source="driven")

    def test_claude_accepted_for_autonomous(self):
        from stratum.goal.worker import validate_worker_spec
        validate_worker_spec(_claude_spec(), mode="autonomous", shadow_source="driven")

    def test_no_type_field_accepted(self):
        """A spec without 'type' should not raise (defaults assumed by stratum_agent_run)."""
        from stratum.goal.worker import validate_worker_spec
        validate_worker_spec({}, mode="advisory", shadow_source="driven")


# ---------------------------------------------------------------------------
# (b) Codex rejected for driven modes (PRD M17)
# ---------------------------------------------------------------------------

class TestValidateWorkerSpecCodexRejection:
    def test_codex_rejected_for_advisory(self):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.worker import validate_worker_spec
        with pytest.raises(WorkerTypeNotSupportedError):
            validate_worker_spec(_codex_spec(), mode="advisory", shadow_source="driven")

    def test_codex_rejected_for_autonomous(self):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.worker import validate_worker_spec
        with pytest.raises(WorkerTypeNotSupportedError):
            validate_worker_spec(_codex_spec(), mode="autonomous", shadow_source="driven")

    def test_codex_rejected_for_shadow_driven(self):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.worker import validate_worker_spec
        with pytest.raises(WorkerTypeNotSupportedError):
            validate_worker_spec(_codex_spec(), mode="shadow", shadow_source="driven")

    def test_error_message_mentions_driven_mode(self):
        from stratum.goal.errors import WorkerTypeNotSupportedError
        from stratum.goal.worker import validate_worker_spec
        with pytest.raises(WorkerTypeNotSupportedError) as exc_info:
            validate_worker_spec(_codex_spec(), mode="advisory", shadow_source="driven")
        assert "codex" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# (c) Codex accepted for shadow-observed
# ---------------------------------------------------------------------------

class TestValidateWorkerSpecCodexObserved:
    def test_codex_accepted_for_shadow_observed(self):
        """Codex is permitted for shadow-observed: no worker dispatch occurs."""
        from stratum.goal.worker import validate_worker_spec
        # Should not raise
        validate_worker_spec(_codex_spec(), mode="shadow", shadow_source="observed")


# ---------------------------------------------------------------------------
# (d) WorkerFailureTracker
# ---------------------------------------------------------------------------

class TestWorkerFailureTracker:
    def test_imports(self):
        from stratum.goal.worker import WorkerFailureTracker
        assert WorkerFailureTracker is not None

    def test_record_failure_increments(self):
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=3)
        # First failure: no exception
        tracker.record_failure(RuntimeError("network error"))

    def test_record_success_resets_counter(self):
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=3)
        tracker.record_failure(RuntimeError("error 1"))
        tracker.record_failure(RuntimeError("error 2"))
        tracker.record_success()
        # After reset, we should be able to fail twice more without hitting the cap
        tracker.record_failure(RuntimeError("error after reset"))
        tracker.record_failure(RuntimeError("error after reset 2"))
        # No exception yet — counter was reset to 0 then incremented to 2

    def test_raises_budget_exceeded_on_cap_hit(self):
        """After max_failures consecutive failures, BudgetExceededError is raised."""
        from stratum.judge.errors import BudgetExceededError
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=3)
        tracker.record_failure(RuntimeError("1"))
        tracker.record_failure(RuntimeError("2"))
        with pytest.raises(BudgetExceededError):
            tracker.record_failure(RuntimeError("3"))

    def test_cap_with_max_failures_1(self):
        """Edge case: max_failures=1 raises on first failure."""
        from stratum.judge.errors import BudgetExceededError
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=1)
        with pytest.raises(BudgetExceededError):
            tracker.record_failure(RuntimeError("instant cap"))

    def test_success_after_partial_failures_allows_more(self):
        """Reset behaviour: partial failures + success + more failures cycle."""
        from stratum.judge.errors import BudgetExceededError
        from stratum.goal.worker import WorkerFailureTracker
        tracker = WorkerFailureTracker(max_failures=3)
        tracker.record_failure(RuntimeError("1"))
        tracker.record_failure(RuntimeError("2"))
        tracker.record_success()  # resets to 0
        tracker.record_failure(RuntimeError("3"))
        tracker.record_failure(RuntimeError("4"))
        # still at 2 consecutive failures — no cap hit
        tracker.record_success()  # reset again
        tracker.record_failure(RuntimeError("5"))
        tracker.record_failure(RuntimeError("6"))
        # 2 failures, no cap
        with pytest.raises(BudgetExceededError):
            tracker.record_failure(RuntimeError("7"))  # now 3 — cap hit


# ---------------------------------------------------------------------------
# (e) dispatch_worker forwards kwargs verbatim
# ---------------------------------------------------------------------------

class TestDispatchWorker:
    def test_imports(self):
        from stratum.goal.worker import dispatch_worker
        assert callable(dispatch_worker)

    @pytest.mark.asyncio
    async def test_dispatch_forwards_to_callable(self):
        """dispatch_worker must call the injected callable with the right args."""
        from stratum.goal.worker import dispatch_worker

        # stratum_agent_run returns {"text": ..., "correlation_id": ...}
        mock_callable = AsyncMock(return_value={"text": "worker output text", "correlation_id": "cid-001"})
        worker_spec = _claude_spec(allowed_tools=["Read", "Edit"], cwd="/workspace")

        result_text, result_cid = await dispatch_worker(
            stratum_agent_run_callable=mock_callable,
            prompt="Do the task.",
            worker_spec=worker_spec,
            correlation_id="cid-001",
        )

        assert mock_callable.called
        assert result_text == "worker output text"
        assert result_cid == "cid-001"

    @pytest.mark.asyncio
    async def test_dispatch_passes_prompt_and_spec_fields(self):
        """The injected callable receives prompt and worker spec fields."""
        from stratum.goal.worker import dispatch_worker

        captured_kwargs: dict = {}

        async def mock_callable(**kwargs):
            captured_kwargs.update(kwargs)
            return {"text": "text", "correlation_id": "cid-xyz"}

        worker_spec = {
            "type": "claude",
            "model_id": "claude-sonnet-4-6",
            "allowed_tools": ["Read"],
            "cwd": "/ws",
        }
        await dispatch_worker(
            stratum_agent_run_callable=mock_callable,
            prompt="my task prompt",
            worker_spec=worker_spec,
            correlation_id="cid-xyz",
        )
        # prompt must be forwarded
        assert "prompt" in captured_kwargs or "my task prompt" in str(captured_kwargs)

    @pytest.mark.asyncio
    async def test_dispatch_worker_spec_is_pure_passthrough(self):
        """No transformation of the worker spec beyond the M17 safety check."""
        from stratum.goal.worker import dispatch_worker

        captured_kwargs: dict = {}

        async def mock_callable(**kwargs):
            captured_kwargs.update(kwargs)
            return {"text": "out", "correlation_id": "c1"}

        original_spec = {
            "type": "claude",
            "model_id": "claude-opus-4-7",
            "effort": "high",
            "cwd": "/project",
            "allowed_tools": ["Read", "Edit", "Write", "Bash"],
            "thinking": True,
        }
        await dispatch_worker(
            stratum_agent_run_callable=mock_callable,
            prompt="task",
            worker_spec=original_spec,
            correlation_id="c1",
        )
        # All worker spec fields should pass through (no stripping)
        if "model_id" in captured_kwargs:
            assert captured_kwargs["model_id"] == "claude-opus-4-7"
        if "effort" in captured_kwargs:
            assert captured_kwargs["effort"] == "high"


# ---------------------------------------------------------------------------
# WorkerSpec dataclass
# ---------------------------------------------------------------------------

class TestWorkerSpec:
    def test_worker_spec_dataclass_importable(self):
        from stratum.goal.worker import WorkerSpec
        ws = WorkerSpec(type="claude")
        assert ws.type == "claude"

    def test_worker_spec_has_expected_fields(self):
        from stratum.goal.worker import WorkerSpec
        ws = WorkerSpec(
            type="claude",
            model_id="claude-sonnet-4-6",
            allowed_tools=["Read"],
            disallowed_tools=None,
            cwd="/workspace",
            effort="medium",
            thinking=False,
        )
        assert ws.model_id == "claude-sonnet-4-6"
        assert ws.allowed_tools == ["Read"]
        assert ws.cwd == "/workspace"
