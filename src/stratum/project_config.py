"""stratum.toml project config — policy overrides, capability mapping, connector routing."""

from __future__ import annotations

import dataclasses
import os
import tomllib
import types
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .exceptions import StratumCompileError
from .pipeline_types import Capability, Policy


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class PipelineConfig:
    """
    Parsed [pipeline.*] sections from stratum.toml.

    policy:       phase-name → Policy override
    capabilities: capability-tier-name → model hint string
    connector:    "default" key + phase-name keys → connector name

    All mapping fields are read-only (MappingProxyType) after construction.
    """
    policy:       Mapping[str, Policy]
    capabilities: Mapping[str, str]
    connector:    Mapping[str, str]

    def __post_init__(self) -> None:
        object.__setattr__(self, "policy",       types.MappingProxyType(dict(self.policy)))
        object.__setattr__(self, "capabilities", types.MappingProxyType(dict(self.capabilities)))
        object.__setattr__(self, "connector",    types.MappingProxyType(dict(self.connector)))


@dataclasses.dataclass(frozen=True)
class LearnConfig:
    """
    Parsed [learn.*] sections from stratum.toml.

    STRAT-LEARN-INLINE: opt-in, default-OFF inline judge self-patch harvester.
    When ``inline_patch_enabled`` is False (the default), the harvester edge
    never runs and the judge path is byte-identical to the no-config baseline.
    """
    inline_patch_enabled:    bool = False
    inline_patch_classifier: str = "heuristic"   # "heuristic" | "llm"


@dataclasses.dataclass(frozen=True)
class StratumConfig:
    """
    Loaded stratum.toml project config.

    Optional. Sensible defaults exist without it. Teams use it to override
    policy dials, map capability tiers to models, and route phases to
    specific connectors without touching the pipeline definition.
    """
    pipeline: PipelineConfig
    learn:    LearnConfig = dataclasses.field(default_factory=LearnConfig)

    # -----------------------------------------------------------------------
    # Construction
    # -----------------------------------------------------------------------

    @classmethod
    def load(cls, path: Path | str | None = None) -> StratumConfig:
        """
        Load config from stratum.toml. Returns empty config if the file does
        not exist. Raises StratumCompileError on parse or validation errors.

        Args:
            path: Path to stratum.toml. Defaults to ./stratum.toml.
        """
        resolved = Path(path) if path is not None else Path("stratum.toml")
        if not resolved.exists():
            return cls.empty()
        with open(resolved, "rb") as fh:
            try:
                raw = tomllib.load(fh)
            except tomllib.TOMLDecodeError as exc:
                raise StratumCompileError(
                    f"stratum.toml: TOML parse error — {exc}"
                ) from exc
        return cls._parse(raw)

    @classmethod
    def empty(cls) -> StratumConfig:
        """Return a config with no overrides (all defaults)."""
        return cls(
            pipeline=PipelineConfig(policy={}, capabilities={}, connector={})
        )

    @classmethod
    def _parse(cls, raw: dict[str, Any]) -> StratumConfig:
        pipeline_raw = raw.get("pipeline", {})
        if not isinstance(pipeline_raw, dict):
            raise StratumCompileError(
                "stratum.toml: [pipeline] must be a table"
            )

        # -- policy overrides ------------------------------------------------
        policy_raw = pipeline_raw.get("policy", {})
        if not isinstance(policy_raw, dict):
            raise StratumCompileError(
                "stratum.toml: [pipeline.policy] must be a table"
            )
        policy: dict[str, Policy] = {}
        for phase_name, value in policy_raw.items():
            if not isinstance(phase_name, str):
                raise StratumCompileError(
                    f"stratum.toml: [pipeline.policy] keys must be strings, "
                    f"got {type(phase_name).__name__!r}"
                )
            try:
                policy[phase_name] = Policy(value)
            except ValueError:
                valid = [p.value for p in Policy]
                raise StratumCompileError(
                    f"stratum.toml: invalid policy '{value}' for phase "
                    f"'{phase_name}'. Valid values: {valid}"
                )

        # -- capability → model hints ----------------------------------------
        capabilities_raw = pipeline_raw.get("capabilities", {})
        if not isinstance(capabilities_raw, dict):
            raise StratumCompileError(
                "stratum.toml: [pipeline.capabilities] must be a table"
            )
        valid_tiers = {c.value for c in Capability}
        capabilities: dict[str, str] = {}
        for tier, hint in capabilities_raw.items():
            if tier not in valid_tiers:
                raise StratumCompileError(
                    f"stratum.toml: unknown capability tier '{tier}'. "
                    f"Valid tiers: {sorted(valid_tiers)}"
                )
            if not isinstance(hint, str):
                raise StratumCompileError(
                    f"stratum.toml: capability hint for '{tier}' must be a string"
                )
            capabilities[tier] = hint

        # -- connector routing -----------------------------------------------
        connector_raw = pipeline_raw.get("connector", {})
        if not isinstance(connector_raw, dict):
            raise StratumCompileError(
                "stratum.toml: [pipeline.connector] must be a table"
            )
        connector: dict[str, str] = {}
        for key, value in connector_raw.items():
            if not isinstance(key, str):
                raise StratumCompileError(
                    f"stratum.toml: [pipeline.connector] keys must be strings, "
                    f"got {type(key).__name__!r}"
                )
            if not isinstance(value, str):
                raise StratumCompileError(
                    f"stratum.toml: connector value for '{key}' must be a string"
                )
            connector[key] = value

        # -- learn (STRAT-LEARN-INLINE) --------------------------------------
        learn = cls._parse_learn(raw)

        return cls(
            pipeline=PipelineConfig(
                policy=policy,
                capabilities=capabilities,
                connector=connector,
            ),
            learn=learn,
        )

    @staticmethod
    def _parse_learn(raw: dict[str, Any]) -> "LearnConfig":
        learn_raw = raw.get("learn", {})
        if not isinstance(learn_raw, dict):
            raise StratumCompileError("stratum.toml: [learn] must be a table")
        inline_raw = learn_raw.get("inline_patch", {})
        if not isinstance(inline_raw, dict):
            raise StratumCompileError(
                "stratum.toml: [learn.inline_patch] must be a table"
            )
        enabled = inline_raw.get("enabled", False)
        if not isinstance(enabled, bool):
            raise StratumCompileError(
                "stratum.toml: [learn.inline_patch] enabled must be a boolean"
            )
        classifier = inline_raw.get("classifier", "heuristic")
        if classifier not in ("heuristic", "llm"):
            raise StratumCompileError(
                f"stratum.toml: [learn.inline_patch] classifier must be "
                f"'heuristic' or 'llm', got {classifier!r}"
            )
        return LearnConfig(
            inline_patch_enabled=enabled,
            inline_patch_classifier=classifier,
        )

    # -----------------------------------------------------------------------
    # Resolution helpers — used by the harness when executing a pipeline
    # -----------------------------------------------------------------------

    def effective_policy(self, phase_name: str, phase_policy: Policy) -> Policy:
        """
        Return the effective policy for a phase.

        Priority (highest first):
        1. stratum.toml [pipeline.policy] override
        2. @phase policy= argument
        """
        return self.pipeline.policy.get(phase_name, phase_policy)

    def effective_connector(
        self,
        phase_name: str,
        phase_connector: str | None,
        pipeline_default: str | None,
    ) -> str | None:
        """
        Resolve the effective connector for a phase.

        Priority (highest first):
        1. @phase connector= argument
        2. stratum.toml [pipeline.connector] phase-specific key
        3. stratum.toml [pipeline.connector] "default" key
        4. @pipeline connector= argument
        """
        if phase_connector is not None:
            return phase_connector
        toml_phase = self.pipeline.connector.get(phase_name)
        if toml_phase is not None:
            return toml_phase
        toml_default = self.pipeline.connector.get("default")
        if toml_default is not None:
            return toml_default
        return pipeline_default

    def model_hint(self, capability: str) -> str | None:
        """
        Return the model hint for a capability tier, or None if not configured.

        The hint is a suggestion — connectors are free to ignore it. It maps
        abstract tiers to concrete model identifiers for connectors that support
        model selection (e.g. "haiku", "sonnet", "claude-sonnet-4-6").
        """
        return self.pipeline.capabilities.get(capability)


# ---------------------------------------------------------------------------
# STRAT-LEARN-INLINE — resolved inline-learn config (TOML + env precedence)
# ---------------------------------------------------------------------------

_INLINE_LEARN_ENV = "STRATUM_LEARN_INLINE_PATCH_ENABLED"


def resolve_inline_learn(workspace_root: Path | str | None) -> "InlineLearnConfig":
    """Resolve the effective inline-learn config for a workspace.

    Reads ``[learn.inline_patch]`` from ``<workspace_root>/stratum.toml`` and
    applies the ``STRATUM_LEARN_INLINE_PATCH_ENABLED`` env override on top:
    a truthy env value (``1``/``true``/``yes``, case-insensitive) forces
    ``enabled=True`` regardless of TOML; any other set value forces
    ``enabled=False``; unset → TOML wins. Default is disabled.

    Returns the small ``InlineLearnConfig`` (defined in
    ``stratum.judge.inline_learn``), imported lazily to avoid an import cycle.
    """
    from .judge.inline_learn import InlineLearnConfig  # late import: no cycle

    root = Path(workspace_root) if workspace_root is not None else Path(".")
    cfg = StratumConfig.load(root / "stratum.toml")
    enabled = cfg.learn.inline_patch_enabled

    raw_env = os.environ.get(_INLINE_LEARN_ENV)
    if raw_env is not None:
        enabled = raw_env.strip().lower() in ("1", "true", "yes")

    return InlineLearnConfig(
        enabled=enabled,
        classifier=cfg.learn.inline_patch_classifier,
    )
