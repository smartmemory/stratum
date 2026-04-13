"""
stratum-mcp migrate CLI — upgrade .stratum.yaml specs across IR versions.

Design:    docs/features/T2-PAR-5/design.md
Blueprint: docs/features/T2-PAR-5/blueprint.md

Exit code contract:
  0 — success or no-op (already at target, user accepted)
  1 — validation error, file I/O error, or flag misuse
  2 — user declined at prompt
  3 — unknown version or no transform path to target
"""
from __future__ import annotations

import difflib
import os
import re
import shutil
import sys
import tempfile
from collections import deque
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path
from typing import Any, Callable

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from .errors import IRParseError, IRSemanticError, IRValidationError
from .spec import SCHEMAS, parse_and_validate


class UnknownVersion(Exception):
    """Version literal is not in SCHEMAS.keys()."""


class NoTransformPath(Exception):
    """Both endpoints are known IR versions but no chain connects them."""


@dataclass
class Upgrade:
    id: str
    description: str
    detect: Callable[[Any], list[Any]]
    apply: Callable[[Any, Any], Any]


@dataclass
class Transform:
    from_version: str
    to_version: str
    description: str
    apply: Callable[[Any], Any]
    opportunistic: list[Upgrade] = field(default_factory=list)


def _version_key(v: str) -> tuple[int, ...]:
    """'0.10' -> (0, 10); '0.3' -> (0, 3). Use everywhere versions are compared."""
    return tuple(int(p) for p in v.split("."))


@dataclass
class MigrateArgs:
    path: Path
    to: str | None = None
    yes: bool = False
    interactive: bool = False
    output: Path | None = None
    backup: bool = False
    force: bool = False
    dry_run: bool = False


_VALUE_FLAGS = {"--to", "--output"}
_BOOL_FLAGS = {"--yes", "-y", "--interactive", "--backup", "--force", "--dry-run"}


def _parse_migrate_args(argv: list[str]) -> MigrateArgs:
    """
    Walk argv. Return MigrateArgs on success; raise ValueError on any misuse.

    Argv excludes the program name — i.e. what `sys.argv[2:]` produces after
    the `migrate` subcommand.
    """
    if not argv:
        raise ValueError("missing required <path>; usage: stratum-mcp migrate <path> [options]")

    path: Path | None = None
    to: str | None = None
    yes = False
    interactive = False
    output: Path | None = None
    backup = False
    force = False
    dry_run = False

    i = 0
    while i < len(argv):
        tok = argv[i]
        if tok.startswith("-"):
            if tok in _VALUE_FLAGS:
                if i + 1 >= len(argv):
                    raise ValueError(f"flag {tok} requires a value")
                val = argv[i + 1]
                if tok == "--to":
                    to = val
                elif tok == "--output":
                    output = Path(val)
                i += 2
                continue
            if tok == "--yes" or tok == "-y":
                yes = True
            elif tok == "--interactive":
                interactive = True
            elif tok == "--backup":
                backup = True
            elif tok == "--force":
                force = True
            elif tok == "--dry-run":
                dry_run = True
            else:
                raise ValueError(f"unknown flag: {tok}")
            i += 1
            continue
        # positional path (only the first positional is accepted)
        if path is not None:
            raise ValueError(f"unexpected positional argument: {tok}")
        path = Path(tok)
        i += 1

    if path is None:
        raise ValueError("missing required <path>")
    if yes and interactive:
        raise ValueError("--yes and --interactive are mutually exclusive")

    return MigrateArgs(
        path=path,
        to=to,
        yes=yes,
        interactive=interactive,
        output=output,
        backup=backup,
        force=force,
        dry_run=dry_run,
    )


def _set_version(doc: Any, v: str) -> Any:
    """Update the top-level `version` field in a ruamel CommentedMap in place."""
    doc["version"] = v
    return doc


TRANSFORMS: list[Transform] = [
    Transform(
        from_version="0.2",
        to_version="0.3",
        description=(
            "v0.3 is a backward-compatible superset of v0.2; "
            "upgrade is a version-field bump only."
        ),
        apply=lambda doc: _set_version(doc, "0.3"),
        opportunistic=[],
    ),
]


def latest_registered_version(registry: list[Transform] | None = None) -> str:
    """Newest `to_version` across the registry, compared numerically."""
    reg = TRANSFORMS if registry is None else registry
    if not reg:
        raise ValueError("empty transform registry")
    return max((t.to_version for t in reg), key=_version_key)


def walk_registry(
    current: str,
    target: str,
    registry: list[Transform] | None = None,
    known_versions: set[str] | None = None,
) -> list[Transform]:
    """
    Return an ordered list of Transforms converting `current` to `target`.

    - Raises `UnknownVersion` if either endpoint is not in the known-version set
      (default: `SCHEMAS.keys()` from spec.py).
    - Returns `[]` when `current == target` (both endpoints valid).
    - Raises `NoTransformPath` when both endpoints are valid versions but no
      chain connects them.
    """
    reg = TRANSFORMS if registry is None else registry
    known = set(SCHEMAS.keys()) if known_versions is None else known_versions

    if current not in known:
        raise UnknownVersion(
            f'unknown version "{current}"; known: {", ".join(sorted(known, key=_version_key))}'
        )
    if target not in known:
        raise UnknownVersion(
            f'unknown version "{target}"; known: {", ".join(sorted(known, key=_version_key))}'
        )
    if current == target:
        return []

    # BFS over transform edges.
    adj: dict[str, list[Transform]] = {}
    for t in reg:
        adj.setdefault(t.from_version, []).append(t)

    queue: deque[tuple[str, list[Transform]]] = deque([(current, [])])
    seen = {current}
    while queue:
        node, path = queue.popleft()
        for edge in adj.get(node, []):
            nxt = edge.to_version
            new_path = path + [edge]
            if nxt == target:
                return new_path
            if nxt not in seen:
                seen.add(nxt)
                queue.append((nxt, new_path))

    raise NoTransformPath(f"no transform from {current} to {target}")


_SEQ_STYLE_RE = re.compile(
    r"^(?P<p>[ ]*)[^\s#\-\[\]\{\}][^\n:]*:[ \t]*\n"  # mapping key line
    r"(?:^[ ]*(?:#.*)?\n)*"                           # blank/comment lines
    r"^(?P<d>[ ]*)-[ \t]",                            # first child dash
    re.MULTILINE,
)

_MAP_STYLE_RE = re.compile(
    r"^(?P<outer>[ ]*)[^\s#\-\[\]\{\}][^\n:]*:[ \t]*\n"  # outer key: (no scalar value)
    r"(?:^[ ]*(?:#.*)?\n)*"                               # blank/comment lines
    r"^(?P<inner>[ ]*)[^\s#\-\[\]\{\}][^\n:]*:",          # inner key:
    re.MULTILINE,
)


def _detect_sequence_style(raw: str) -> tuple[int, int]:
    """
    Infer ruamel's (sequence, offset) indent from source. Returns (2, 0)
    when no sequence-under-mapping pattern is found — ruamel's default.
    """
    for m in _SEQ_STYLE_RE.finditer(raw):
        parent_indent = len(m.group("p"))
        dash_indent = len(m.group("d"))
        delta = dash_indent - parent_indent
        if delta < 0:
            continue
        return delta + 2, delta
    return 2, 0


def _detect_mapping_indent(raw: str) -> int:
    """
    Infer ruamel's `mapping` indent (per-level) from source. Scans for the
    first nested `key:\\n  nested_key:` pattern where `nested_key` is indented
    relative to `key`. Returns 2 if no nested mapping is found.
    """
    for m in _MAP_STYLE_RE.finditer(raw):
        outer = len(m.group("outer"))
        inner = len(m.group("inner"))
        delta = inner - outer
        if delta > 0:
            return delta
    return 2


def _yaml_obj(raw: str | None = None) -> YAML:
    y = YAML(typ="rt")
    y.preserve_quotes = True
    if raw is not None:
        seq, offset = _detect_sequence_style(raw)
        mapping = _detect_mapping_indent(raw)
        y.indent(mapping=mapping, sequence=seq, offset=offset)
    return y


def _load_yaml(path: Path) -> tuple[YAML, Any]:
    with path.open("r", encoding="utf-8") as f:
        raw = f.read()
    y = _yaml_obj(raw)
    return y, y.load(raw)


def _dump_to_string(y: YAML, doc: Any) -> str:
    buf = StringIO()
    y.dump(doc, buf)
    return buf.getvalue()


def _atomic_write(path: Path, content: str) -> None:
    """Write content to path atomically via tempfile + os.replace()."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w",
        dir=path.parent,
        delete=False,
        suffix=".tmp",
        encoding="utf-8",
    )
    try:
        tmp.write(content)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


def _render_diff(original: str, draft: str, label: str) -> str:
    """Return a unified-diff string; empty when inputs are identical."""
    return "".join(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            draft.splitlines(keepends=True),
            fromfile=f"{label} (before)",
            tofile=f"{label} (after)",
        )
    )


def _prompt_yn(msg: str) -> bool:
    sys.stdout.write(f"{msg} [y/N]: ")
    sys.stdout.flush()
    ans = sys.stdin.readline().strip().lower()
    return ans == "y"


_IR_EXC = (IRParseError, IRValidationError, IRSemanticError)


def _err(msg: str) -> None:
    sys.stderr.write(msg.rstrip() + "\n")


def _cmd_migrate(argv: list[str]) -> None:
    """
    Stratum CLI `migrate` handler. See design.md + blueprint.md for flow.
    Terminates via sys.exit() with a documented code.
    """
    # Step 1: parse args.
    try:
        args = _parse_migrate_args(argv)
    except ValueError as exc:
        _err(f"error: {exc}")
        sys.exit(1)

    target_path = args.output if args.output is not None else args.path

    # Pre-flight: --output collision with existing file. Skipped when --dry-run
    # is set, since dry-run never writes.
    if (
        args.output is not None
        and not args.dry_run
        and args.output.exists()
        and not args.force
    ):
        _err(f"error: refusing to overwrite {args.output} without --force")
        sys.exit(1)

    # Step 2: load YAML. Distinguish I/O errors ("cannot read") from parse
    # errors ("invalid YAML") — they exit the same code but with different
    # messages per the design contract.
    try:
        y, doc = _load_yaml(args.path)
    except FileNotFoundError:
        _err(f"error: cannot read: {args.path}")
        sys.exit(1)
    except (OSError, UnicodeDecodeError) as exc:
        _err(f"error: cannot read: {args.path}: {exc}")
        sys.exit(1)
    except YAMLError as exc:
        _err(f"error: invalid YAML in {args.path}: {exc}")
        sys.exit(1)

    # Step 3: shape guard.
    # 3a. Root must be a mapping. Anything else (list, scalar, None) is a
    # schema error — parse_and_validate would crash on .get(), so handle here.
    if not _is_mapping(doc):
        _err(f"error: spec root must be a mapping in {args.path}")
        sys.exit(1)

    raw = doc.get("version")
    # 3b. Missing or non-string version → delegate to parse_and_validate which
    # emits a controlled schema error; skip the exit-3 branch.
    if not isinstance(raw, str):
        try:
            parse_and_validate(_dump_to_string(y, doc))
        except _IR_EXC as exc:
            _err(f"error: source spec validation failed: {exc}")
            sys.exit(1)
        # Unreachable: parse_and_validate would have raised on missing/non-string version.
        _err("error: source spec has missing or invalid version field")
        sys.exit(1)

    # Step 4–5: resolve target + walk registry.
    target = args.to if args.to is not None else latest_registered_version()
    try:
        transforms = walk_registry(current=raw, target=target)
    except (UnknownVersion, NoTransformPath) as exc:
        _err(f"error: {exc}")
        sys.exit(3)

    # Step 6: no-op.
    if not transforms:
        sys.stdout.write(f"already at v{target}\n")
        sys.exit(0)

    # Step 7: validate source.
    original_text = _dump_to_string(y, doc)
    try:
        parse_and_validate(original_text)
    except _IR_EXC as exc:
        _err(f"error: source spec fails v{raw} validation: {exc}")
        sys.exit(1)

    # Step 8: apply transforms to `doc` in place. Wrap in a single try/except
    # so any transform or upgrade bug exits 1 with a readable message instead
    # of leaking a raw traceback.
    for t in transforms:
        try:
            doc = t.apply(doc)
            for up in t.opportunistic:
                matches = up.detect(doc)
                for match in matches:
                    if args.interactive and not _prompt_yn(f"{up.description}"):
                        continue
                    doc = up.apply(doc, match)
        except Exception as exc:
            _err(
                f"error: transform {t.from_version}->{t.to_version} failed: "
                f"{type(exc).__name__}: {exc}"
            )
            sys.exit(1)

    draft_text = _dump_to_string(y, doc)

    # Step 9: validate draft.
    try:
        parse_and_validate(draft_text)
    except _IR_EXC as exc:
        _err(
            f"error: internal error: produced invalid spec; file unchanged "
            f"(target v{target}): {exc}"
        )
        sys.exit(1)

    # Step 10: diff.
    diff = _render_diff(original_text, draft_text, str(args.path))

    # Step 11: dry-run.
    if args.dry_run:
        sys.stdout.write(diff)
        sys.exit(0)

    # Step 12: preview prompt (skipped when --yes).
    if not args.yes:
        sys.stdout.write(
            f"Migrating {args.path}: v{raw} -> v{target} ({len(transforms)} transform"
            f"{'s' if len(transforms) != 1 else ''})\n"
        )
        sys.stdout.write(diff)
        if not _prompt_yn("Apply?"):
            sys.exit(2)

    # Step 13-14: backup (in-place only) + atomic write, wrapped so any
    # filesystem failure exits 1 cleanly instead of leaking a stack trace.
    try:
        if args.backup and args.output is None:
            bak = args.path.with_suffix(args.path.suffix + ".bak")
            shutil.copyfile(args.path, bak)
        _atomic_write(target_path, draft_text)
    except OSError as exc:
        _err(f"error: cannot write: {target_path}: {exc}")
        sys.exit(1)
    sys.stdout.write("Written.\n")
    sys.exit(0)


def _is_mapping(doc: Any) -> bool:
    """True when the YAML root is a mapping (dict or ruamel CommentedMap)."""
    # ruamel's CommentedMap is a dict subclass; bare dict is also fine.
    return isinstance(doc, dict)
