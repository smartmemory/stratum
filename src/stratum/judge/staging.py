"""Per-turn staging-directory writer for the judge kernel.

Each ``run_judge`` invocation snapshots the worker's claimed artifacts and
modified-file outputs into a stable, read-only tree:

    ~/.stratum/judge/<flow_id>/<step_id>/turn-<N>/
      artifacts/<name>.txt        # one file per artifacts dict entry
      modified/<rel_path>         # snapshot of each modified file
      manifest.json               # [{bucket, path, sha256, byte_size, written_at_ms, [missing]}]

The staging tree is what T1's path-rebound builtins and T2's tool-using
verifier operate against. Snapshotting decouples the audit from any later
worker changes (poison-test protection) and gives every tier the same
identical evidence surface.

``stage_turn`` refuses to overwrite an existing ``turn-N/`` directory: if
a prior invocation raised after staging but before recording history, the
next call scans upward for the next free N and returns the actually
allocated turn number. This is the race-protection layer required by
blueprint fix #23.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path, PurePosixPath

JUDGE_ROOT = Path.home() / ".stratum" / "judge"


def stage_turn(
    flow_id: str,
    step_id: str,
    turn: int,
    artifacts: dict[str, str],
    modified_files: list[str],
    workspace_root: Path,
) -> tuple[Path, int]:
    """Stage one turn's evidence under ``~/.stratum/judge/<flow_id>/<step_id>/turn-<N>/``.

    Returns the ``(turn_dir, actual_turn)`` pair. ``actual_turn`` may exceed the
    caller-supplied ``turn`` if a previous orphan staging directory already
    occupies the requested slot.
    """
    # Validate inputs before touching disk — reject traversal / absolute /
    # separator-bearing names that would escape the staged buckets.
    # flow_id and step_id also become path segments and must be safe.
    _validate_id_segment("flow_id", flow_id)
    _validate_id_segment("step_id", step_id)
    for name in artifacts:
        _validate_artifact_name(name)
    for rel in modified_files:
        _validate_modified_path(rel)

    # Pre-mkdir ancestor validation. Two layers:
    #   1. JUDGE_ROOT itself must not be a symlink. If it is, refuse — an
    #      attacker who can plant ~/.stratum or ~/.stratum/judge as a
    #      symlink to /tmp/evil would otherwise see this code happily
    #      mkdir under the target and treat the resolved path as trusted.
    #      Beyond JUDGE_ROOT, write-access to ~ is outside the kernel's
    #      threat model (the attacker can already replace the kernel itself).
    #   2. Any existing ancestor of step_root must resolve under JUDGE_ROOT.
    if JUDGE_ROOT.is_symlink():
        raise ValueError(
            f"JUDGE_ROOT must not be a symlink: {JUDGE_ROOT!r} → "
            f"{JUDGE_ROOT.readlink()!r}"
        )
    JUDGE_ROOT.mkdir(parents=True, exist_ok=True)
    if JUDGE_ROOT.is_symlink():  # double-check after mkdir-parents
        raise ValueError(f"JUDGE_ROOT became a symlink after mkdir: {JUDGE_ROOT!r}")
    judge_root_resolved = JUDGE_ROOT.resolve()
    # Walk down the path components, verifying every existing ancestor still
    # resolves under JUDGE_ROOT. Non-existent components are fine — they'll
    # be created by mkdir under known-safe parents.
    cursor = JUDGE_ROOT
    for segment in (flow_id, step_id):
        cursor = cursor / segment
        if cursor.exists() or cursor.is_symlink():
            _ensure_path_under(cursor.resolve(), judge_root_resolved)

    step_root = JUDGE_ROOT / flow_id / step_id
    step_root.mkdir(parents=True, exist_ok=True)
    # Post-mkdir defence-in-depth: confirm the resolved step_root is still
    # inside JUDGE_ROOT after the creation completed.
    _ensure_path_under(step_root.resolve(), judge_root_resolved)

    # Refuse to overwrite — scan upward for next free turn-N.
    while (step_root / f"turn-{turn}").exists():
        turn += 1

    turn_dir = step_root / f"turn-{turn}"
    (turn_dir / "artifacts").mkdir(parents=True, exist_ok=True)
    (turn_dir / "modified").mkdir(parents=True, exist_ok=True)
    artifacts_root = (turn_dir / "artifacts").resolve()
    modified_root = (turn_dir / "modified").resolve()

    manifest: list[dict] = []

    for name, content in artifacts.items():
        path = turn_dir / "artifacts" / f"{name}.txt"
        # Defence-in-depth: re-check the resolved path stays in the bucket
        # even after `_validate_artifact_name` accepted it. Path-aware via
        # relative_to so symlinks with shared string prefixes can't escape.
        _ensure_path_under(path.resolve(), artifacts_root)
        path.write_text(content)
        manifest.append(_manifest_entry("artifacts", f"{name}.txt", content.encode()))

    workspace_resolved = workspace_root.resolve()
    for rel in modified_files:
        src = workspace_root / rel
        dst = turn_dir / "modified" / rel
        # Defence-in-depth: re-check resolved paths via relative_to so symlinks
        # with shared string prefixes (e.g. /tmp/ws → /tmp/ws-evil) cannot escape.
        _ensure_path_under(dst.resolve(), modified_root)
        _ensure_path_under(src.resolve(), workspace_resolved)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.exists():
            data = src.read_bytes()
            dst.write_bytes(data)
            manifest.append(_manifest_entry("modified", rel, data))
        else:
            # Worker claimed the path was modified but it isn't on disk now.
            # Record provenance: sha256 reserved-null distinguishes this from
            # a real zero-byte file (whose hash is the well-known empty-bytes
            # digest, never null). See blueprint fix #13.
            manifest.append({
                "bucket": "modified",
                "path": rel,
                "sha256": None,
                "byte_size": 0,
                "written_at_ms": int(time.time() * 1000),
                "missing": True,
            })

    (turn_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return turn_dir, turn


def _validate_id_segment(label: str, value: str) -> None:
    """``flow_id``/``step_id`` become path segments under JUDGE_ROOT. They
    must be safe — no path separators, traversal segments, absolute paths,
    or control characters. This closes the otherwise-trusted outer
    directory components.
    """
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string: {value!r}")
    if value in (".", ".."):
        raise ValueError(f"{label} cannot be '.' or '..': {value!r}")
    if "/" in value or "\\" in value or "\x00" in value:
        raise ValueError(
            f"{label} must not contain path separators or null: {value!r}"
        )


def _ensure_path_under(path: Path, root: Path) -> None:
    """Path-aware containment check via ``Path.relative_to``. Defeats the
    string-prefix bypass where ``/tmp/ws`` accepts ``/tmp/ws-evil/x``.
    """
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise ValueError(
            f"path escapes its declared root: {str(path)!r} not under {str(root)!r}"
        ) from exc


def _validate_artifact_name(name: str) -> None:
    """Artifact dict keys become filenames under ``artifacts/<name>.txt``.
    They must be safe single-segment names — no path separators, traversal
    components, absolute paths, or control characters. Empty names are
    rejected to avoid writing ``.txt`` directly into the bucket root.
    """
    if not isinstance(name, str) or not name:
        raise ValueError(f"artifact name must be a non-empty string: {name!r}")
    if name in (".", ".."):
        raise ValueError(f"artifact name cannot be '.' or '..': {name!r}")
    if "/" in name or "\\" in name or "\x00" in name:
        raise ValueError(
            f"artifact name must not contain path separators or null: {name!r}"
        )
    if name.startswith("."):
        # Reject dotfile-style names so the bucket stays scannable and
        # platform tools don't hide artifacts from review.
        raise ValueError(f"artifact name cannot start with '.': {name!r}")


def _validate_modified_path(rel: str) -> None:
    """`modified_files` paths are workspace-relative. Reject absolute paths
    and any segment that is ``..`` so callers cannot read sibling
    directories or escape into the host filesystem via staging.
    """
    if not isinstance(rel, str) or not rel:
        raise ValueError(f"modified path must be a non-empty string: {rel!r}")
    if "\x00" in rel:
        raise ValueError(f"modified path must not contain null: {rel!r}")
    p = PurePosixPath(rel.replace("\\", "/"))
    if p.is_absolute() or rel.startswith("/") or rel.startswith("\\"):
        raise ValueError(f"modified path must be workspace-relative: {rel!r}")
    if any(part == ".." for part in p.parts):
        raise ValueError(f"modified path cannot contain '..': {rel!r}")


def _manifest_entry(bucket: str, path: str, data: bytes) -> dict:
    """Build one manifest row.

    ``sha256`` is *always* computed from ``data`` — including for empty
    bytes, which hash to the well-known ``e3b0c4...`` digest. ``sha256: null``
    is reserved exclusively for the missing-file branch in ``stage_turn``;
    that distinction is the provenance guarantee.
    """
    return {
        "bucket": bucket,
        "path": path,
        "sha256": hashlib.sha256(data).hexdigest(),
        "byte_size": len(data),
        "written_at_ms": int(time.time() * 1000),
    }
