"""Typed exceptions for the goal orchestrator.

All errors descend from ``GoalError`` so callers can catch the family with a
single except clause. Each subclass signals a distinct, actionable failure mode
that surfaces to the caller rather than being swallowed.

Pattern mirrors ``stratum.judge.errors`` — one base, named subclasses, no logic.
"""


class GoalError(Exception):
    """Base class for all goal-orchestrator errors."""


class GoalImmutabilityError(GoalError):
    """A repeat ``stratum_goal`` call supplied predicates, mode, or
    artifact_contract that differ from what was recorded at goal creation.

    The predicate list is sha256-canonicalized on first call and stored in
    ``GoalState.predicates_hash``. Subsequent calls recompute the hash and
    raise this error on mismatch, preventing silent goal redefinition across
    sessions.
    """


class GoalNotFoundError(GoalError):
    """A ``goal_id`` was supplied to ``stratum_goal_status``,
    ``stratum_goal_decide``, or ``stratum_goal_archive`` but no corresponding
    ``GoalState`` or ``FlowState`` record exists on disk."""


class WorkerTypeNotSupportedError(GoalError):
    """``worker.type == 'codex'`` was supplied for a driven mode
    (``shadow-driven``, ``advisory``, or ``autonomous``).

    Codex is rejected for driven modes because the Codex connector:
    1. Silently drops ``allowed_tools`` / ``disallowed_tools``
       (connectors/factory.py:45-50).
    2. Hardcodes ``--sandbox read-only`` (connectors/codex.py:167-177),
       preventing any write-producing task.

    ``codex`` is permitted only for ``shadow-observed`` mode where no worker
    dispatch occurs — the caller hands in pre-produced artifacts.
    """


class NoPendingDecisionError(GoalError):
    """``stratum_goal_decide`` was called on a goal that is not currently
    in the ``awaiting_decision`` state.

    Either the goal has not yet reached a ``met`` claim, has already been
    decided, or was killed. Callers should check ``stratum_goal_status``
    before invoking ``stratum_goal_decide``.
    """


class ArtifactExtractionError(GoalError):
    """The regex-based artifact extraction failed to parse the worker's
    response in a way that cannot be recovered by re-prompting.

    Distinct from the per-turn "required artifact missing" path (which retries
    with an explicit missing-artifact list): this error is raised when the
    extraction logic itself encounters an unrecoverable parse failure — e.g. a
    malformed fence that confuses the regex state machine.
    """


# --- v2 slice 2: decomposer-mode failures ---------------------------------
# Each carries an ``error_type`` class attribute holding the stable snake_case
# string the MCP boundary emits (server.py maps these explicitly *before* the
# generic ``except GoalError`` so the contract strings are not the PascalCase
# class names ``type(exc).__name__`` would otherwise produce).


class DecomposeFailed(GoalError):
    """``decomposer='auto'`` but ``LiteLLMDecomposer.decompose`` returned
    ``applied=False`` (fail-open: LLM/parse/validation failure). The goal does
    NOT run — never on an empty/guessed predicate list."""

    error_type = "decompose_failed"


class AutoPredicatesConflict(GoalError):
    """``decomposer='auto'`` was supplied together with a non-empty
    ``predicates`` list. ``auto`` derives predicates from prose; supplying both
    is a caller bug."""

    error_type = "auto_predicates_conflict"


class InvalidDecomposerError(GoalError):
    """``decomposer`` was not one of ``{"user","auto","hybrid"}``. Validated
    inside ``run_goal`` itself (not only the MCP wrapper) because ``run_goal``
    is a public entry point called directly outside ``stratum_goal``. ``ask`` is
    a skill-layer concept and is rejected here."""

    error_type = "invalid_decomposer"


class AutoCheapMismatch(GoalError):
    """An ``auto``-origin resolved predicate set contains a non-``deterministic``
    predicate under ``stakes='cheap'``. Surfaced before the loop instead of
    letting ``run_judge`` raise ``StakesPredicateMismatchError`` mid-run (which
    ``run_goal``'s broad judge-loop except would swallow into budget burn)."""

    error_type = "auto_cheap_mismatch"
