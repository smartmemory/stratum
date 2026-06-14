"""STRAT-DISTILL — AssetCandidate.

A staged proposal to CREATE a new reusable asset (skill / subagent / command)
from a detected repeated workflow. Mirrors LEARN-INLINE's PatchCandidate staging
discipline, but represents creation of a new asset rather than a patch to an
existing one — so ``patch_type`` is locked to ``"create"``. Described, never
written to the working tree (STRAT-IMMUTABLE).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

AssetKind = Literal["skill", "subagent", "command"]


@dataclass(frozen=True)
class AssetCandidate:
    asset_kind: AssetKind
    asset_name: str
    target_path: str          # intended path for the new asset (not yet created)
    trigger_pattern: str      # the recurring request/workflow that prompted it
    rationale: str
    suggested_content: str    # described content, NOT written to disk
    evidence_session_ids: tuple
    cluster_id: str           # stable idempotency key for the sidecar
    confidence: int
    patch_type: Literal["create"] = "create"

    def to_dict(self) -> dict:
        return {
            "asset_kind": self.asset_kind,
            "asset_name": self.asset_name,
            "target_path": self.target_path,
            "patch_type": self.patch_type,
            "trigger_pattern": self.trigger_pattern,
            "rationale": self.rationale,
            "suggested_content": self.suggested_content,
            "evidence_session_ids": list(self.evidence_session_ids),
            "cluster_id": self.cluster_id,
            "confidence": self.confidence,
        }
