"""Typed exceptions for the judge kernel.

All errors descend from `JudgeError` so callers can catch the family.
Each subclass signals a distinct, actionable failure mode that should
surface to the caller rather than being swallowed.
"""


class JudgeError(Exception):
    """Base class for all judge-kernel errors."""


class StakesPredicateMismatchError(JudgeError):
    """`stakes='cheap'` but the predicate list contains a non-deterministic
    predicate. Cheap means "no LLM tier fires"; non-deterministic predicates
    have no way to be decided without T2."""


class StakesNotAvailableError(JudgeError):
    """`stakes='paranoid'` requested in v1. Paranoid requires T3 adversary,
    which ships in v2. Failing loudly is preferred over silently aliasing
    to default — callers must not believe they received adversarial
    verification when they didn't."""


class PredicatePathError(JudgeError):
    """A deterministic predicate's expression references a path outside
    the staged tree (i.e. not prefixed with ``artifacts/`` or ``modified/``).
    T1 evaluates only against the staged turn directory; live-workspace
    paths are rejected so T1's truth surface stays identical to T2's."""


class PredicateBuiltinError(JudgeError):
    """A deterministic predicate calls a builtin not in the v1 T1 surface.

    Supported in v1: ``file_exists``, ``file_contains``, ``len``, ``min``,
    ``max``, ``bool``, ``int``, ``str``.

    Excluded: ``vocabulary_compliance``, ``plan_completion``,
    ``no_file_conflicts`` — these depend on process-cwd semantics that
    don't translate to the staged tree. Broader builtin surface is a v2
    candidate after the namespace-rebinding work matures.
    """


class CitationFormatError(JudgeError):
    """T2 returned an evidence citation that fails kernel-boundary
    validation: either it doesn't match ``<bucket>/<path>:<line>``,
    escapes the staging root via path traversal, or names a file that
    doesn't exist in the current turn's staging tree."""


class BudgetExceededError(JudgeError):
    """A hard budget cap was hit. v1 enforces ``max_turns`` (at entry, as a
    gate) and ``max_wall_clock_s`` (per predicate, mid-loop). ``max_dollars``
    is recorded but not enforced in v1."""


class EmptyPredicateListError(JudgeError):
    """Caller passed ``predicates=[]``. Empty list aggregates as vacuous
    ``met=True`` via ``all([])``, which would silently bypass any gate built
    on the judge. Reject loudly at the kernel boundary; the IR JSON schema
    also enforces ``minItems: 1`` so most callers can't even construct one."""
