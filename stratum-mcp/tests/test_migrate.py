"""Tests for stratum-mcp migrate CLI (T2-PAR-5)."""
from __future__ import annotations

from pathlib import Path

import pytest


# ---------- T2: dataclasses + exceptions ----------


def test_dataclass_construction():
    from stratum_mcp.migrate import (
        MigrateArgs,
        NoTransformPath,
        Transform,
        UnknownVersion,
        Upgrade,
    )

    assert issubclass(UnknownVersion, Exception)
    assert issubclass(NoTransformPath, Exception)

    up = Upgrade(
        id="x",
        description="test",
        detect=lambda doc: [],
        apply=lambda doc, match: doc,
    )
    assert up.id == "x"

    t = Transform(
        from_version="0.2",
        to_version="0.3",
        description="test",
        apply=lambda doc: doc,
    )
    assert t.opportunistic == []

    args = MigrateArgs(path=Path("x.yaml"))
    assert args.to is None
    assert args.yes is False

    populated = MigrateArgs(
        path=Path("x.yaml"),
        to="0.3",
        yes=True,
        interactive=False,
        output=Path("y.yaml"),
        backup=True,
        force=True,
        dry_run=False,
    )
    assert populated.to == "0.3"
    assert populated.output == Path("y.yaml")


# ---------- T3: version ordering ----------


def test_version_key_numeric_order():
    from stratum_mcp.migrate import _version_key

    assert _version_key("0.10") > _version_key("0.9")
    assert _version_key("0.3") < _version_key("0.10")
    assert _version_key("1.0") > _version_key("0.99")
    assert _version_key("0.2") == (0, 2)


# ---------- T5: YAML load/dump helpers ----------


def test_yaml_roundtrip_preserves_comments(tmp_path: Path):
    from stratum_mcp.migrate import _dump_to_string, _load_yaml

    src = tmp_path / "x.yaml"
    src.write_text(
        "# top comment\n"
        'version: "0.2"\n'
        "\n"
        "# section\n"
        "contracts:\n"
        "  Foo: {type: object}   # inline\n"
    )
    y, doc = _load_yaml(src)
    out = _dump_to_string(y, doc)
    assert "# top comment" in out
    assert "# section" in out
    assert "# inline" in out
    assert 'version: "0.2"' in out


def test_yaml_dump_to_string_returns_text(tmp_path: Path):
    from stratum_mcp.migrate import _dump_to_string, _load_yaml

    src = tmp_path / "x.yaml"
    src.write_text('version: "0.2"\n')
    y, doc = _load_yaml(src)
    out = _dump_to_string(y, doc)
    assert isinstance(out, str)
    assert out.startswith("version:")


# ---------- T6: atomic write ----------


def test_atomic_write_writes_content(tmp_path: Path):
    from stratum_mcp.migrate import _atomic_write

    target = tmp_path / "x.yaml"
    _atomic_write(target, "hello\n")
    assert target.read_text() == "hello\n"


def test_atomic_write_leaves_no_tmp(tmp_path: Path):
    from stratum_mcp.migrate import _atomic_write

    target = tmp_path / "x.yaml"
    _atomic_write(target, "content\n")
    stray = list(tmp_path.glob("*.tmp"))
    assert stray == [], f"stray temp files: {stray}"


# ---------- T8: diff + prompt ----------


def test_render_diff_identical_is_empty():
    from stratum_mcp.migrate import _render_diff

    assert _render_diff("hello\n", "hello\n", "x.yaml") == ""


def test_render_diff_unified_format():
    from stratum_mcp.migrate import _render_diff

    out = _render_diff('version: "0.2"\n', 'version: "0.3"\n', "flow.yaml")
    assert "flow.yaml (before)" in out
    assert "flow.yaml (after)" in out
    assert '-version: "0.2"' in out
    assert '+version: "0.3"' in out


def test_prompt_yn_accepts_y(monkeypatch):
    import io

    from stratum_mcp import migrate

    monkeypatch.setattr("sys.stdin", io.StringIO("y\n"))
    assert migrate._prompt_yn("apply?") is True


def test_prompt_yn_rejects_blank(monkeypatch):
    import io

    from stratum_mcp import migrate

    monkeypatch.setattr("sys.stdin", io.StringIO("\n"))
    assert migrate._prompt_yn("apply?") is False


def test_prompt_yn_rejects_n(monkeypatch):
    import io

    from stratum_mcp import migrate

    monkeypatch.setattr("sys.stdin", io.StringIO("n\n"))
    assert migrate._prompt_yn("apply?") is False


# ---------- T4: registry + walk_registry + latest_registered_version ----------


def _synthetic_transforms():
    from stratum_mcp.migrate import Transform

    return [
        Transform(
            from_version="0.1",
            to_version="0.2",
            description="synth 1->2",
            apply=lambda doc: doc,
        ),
        Transform(
            from_version="0.2",
            to_version="0.3",
            description="synth 2->3",
            apply=lambda doc: doc,
        ),
    ]


def test_walk_registry_single_hop():
    from stratum_mcp.migrate import TRANSFORMS, walk_registry

    result = walk_registry("0.2", "0.3")
    assert len(result) == 1
    assert result[0].from_version == "0.2"
    assert result[0].to_version == "0.3"


def test_walk_registry_noop():
    from stratum_mcp.migrate import walk_registry

    assert walk_registry("0.3", "0.3") == []


def test_walk_registry_unknown_current():
    from stratum_mcp.migrate import UnknownVersion, walk_registry

    with pytest.raises(UnknownVersion):
        walk_registry("9.9", "0.3")


def test_walk_registry_unknown_target():
    from stratum_mcp.migrate import UnknownVersion, walk_registry

    with pytest.raises(UnknownVersion):
        walk_registry("0.2", "9.9")


def test_walk_registry_both_unknown():
    from stratum_mcp.migrate import UnknownVersion, walk_registry

    with pytest.raises(UnknownVersion):
        walk_registry("9.9", "9.9")


def test_walk_registry_no_transform_path():
    from stratum_mcp.migrate import NoTransformPath, walk_registry

    with pytest.raises(NoTransformPath):
        walk_registry("0.1", "0.3")


def test_walk_registry_synthetic_chain():
    from stratum_mcp.migrate import walk_registry

    synth = _synthetic_transforms()
    known = {"0.1", "0.2", "0.3"}
    result = walk_registry("0.1", "0.3", registry=synth, known_versions=known)
    assert [(t.from_version, t.to_version) for t in result] == [
        ("0.1", "0.2"),
        ("0.2", "0.3"),
    ]


def test_walk_registry_to_pinning():
    from stratum_mcp.migrate import walk_registry

    synth = _synthetic_transforms()
    known = {"0.1", "0.2", "0.3"}
    result = walk_registry("0.1", "0.2", registry=synth, known_versions=known)
    assert [(t.from_version, t.to_version) for t in result] == [("0.1", "0.2")]


def test_latest_registered_version_production():
    from stratum_mcp.migrate import latest_registered_version

    assert latest_registered_version() == "0.3"


def test_latest_registered_version_numeric():
    from stratum_mcp.migrate import Transform, latest_registered_version

    synth = [
        Transform(
            from_version="0.2",
            to_version="0.9",
            description="",
            apply=lambda d: d,
        ),
        Transform(
            from_version="0.9",
            to_version="0.10",
            description="",
            apply=lambda d: d,
        ),
    ]
    assert latest_registered_version(registry=synth) == "0.10"


def test_production_transform_applies_version_bump(tmp_path: Path):
    from stratum_mcp.migrate import TRANSFORMS, _dump_to_string, _load_yaml

    src = tmp_path / "x.yaml"
    src.write_text('version: "0.2"\n')
    y, doc = _load_yaml(src)
    transform = next(t for t in TRANSFORMS if t.from_version == "0.2")
    result = transform.apply(doc)
    assert _dump_to_string(y, result).strip().startswith('version: "0.3"')


# ---------- T7: argument parser ----------


def test_parse_positional_path():
    from stratum_mcp.migrate import _parse_migrate_args

    args = _parse_migrate_args(["flow.yaml"])
    assert args.path == Path("flow.yaml")
    assert args.to is None
    assert args.yes is False
    assert args.dry_run is False


def test_parse_all_flags():
    from stratum_mcp.migrate import _parse_migrate_args

    args = _parse_migrate_args(
        [
            "flow.yaml",
            "--to",
            "0.3",
            "--yes",
            "--output",
            "out.yaml",
            "--backup",
            "--force",
            "--dry-run",
        ]
    )
    assert args.path == Path("flow.yaml")
    assert args.to == "0.3"
    assert args.yes is True
    assert args.output == Path("out.yaml")
    assert args.backup is True
    assert args.force is True
    assert args.dry_run is True


def test_parse_short_yes_flag():
    from stratum_mcp.migrate import _parse_migrate_args

    args = _parse_migrate_args(["flow.yaml", "-y"])
    assert args.yes is True


def test_parse_interactive():
    from stratum_mcp.migrate import _parse_migrate_args

    args = _parse_migrate_args(["flow.yaml", "--interactive"])
    assert args.interactive is True


def test_parse_missing_path():
    from stratum_mcp.migrate import _parse_migrate_args

    with pytest.raises(ValueError):
        _parse_migrate_args([])


def test_parse_unknown_flag():
    from stratum_mcp.migrate import _parse_migrate_args

    with pytest.raises(ValueError):
        _parse_migrate_args(["f.yaml", "--nope"])


def test_parse_flag_missing_value():
    from stratum_mcp.migrate import _parse_migrate_args

    with pytest.raises(ValueError):
        _parse_migrate_args(["f.yaml", "--to"])

    with pytest.raises(ValueError):
        _parse_migrate_args(["f.yaml", "--output"])


def test_parse_yes_interactive_mutex():
    from stratum_mcp.migrate import _parse_migrate_args

    with pytest.raises(ValueError):
        _parse_migrate_args(["f.yaml", "--yes", "--interactive"])

    with pytest.raises(ValueError):
        _parse_migrate_args(["f.yaml", "--interactive", "-y"])


# ---------- T9: _cmd_migrate orchestration ----------

VALID_V02_SPEC = """\
# top comment
version: "0.2"
contracts:
  Out:
    v: {type: string}
functions:
  work:
    mode: infer
    intent: "Do it"
    input: {}
    output: Out
flows:
  main:
    input: {}
    output: Out
    steps:
      - id: s1
        function: work
        inputs: {}
"""

VALID_V03_SPEC = VALID_V02_SPEC.replace('version: "0.2"', 'version: "0.3"')


def _write(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content)
    return p


def _run_migrate(argv, stdin_text="", monkeypatch=None):
    """Run _cmd_migrate(argv). Return (exit_code, stdout, stderr, stdin_ref)."""
    import io

    from stratum_mcp import migrate

    fake_in = io.StringIO(stdin_text)
    fake_out = io.StringIO()
    fake_err = io.StringIO()
    assert monkeypatch is not None
    monkeypatch.setattr("sys.stdin", fake_in)
    monkeypatch.setattr("sys.stdout", fake_out)
    monkeypatch.setattr("sys.stderr", fake_err)
    with pytest.raises(SystemExit) as excinfo:
        migrate._cmd_migrate(argv)
    return excinfo.value.code, fake_out.getvalue(), fake_err.getvalue()


def test_golden_flow_v02_to_v03(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 0, err
    text = src.read_text()
    assert 'version: "0.3"' in text
    # Every other line should be unchanged from VALID_V02_SPEC.
    expected = VALID_V02_SPEC.replace('version: "0.2"', 'version: "0.3"')
    assert text == expected
    assert "# top comment" in text  # comment preserved


def test_preview_decline(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate(
        [str(src)], stdin_text="n\n", monkeypatch=monkeypatch
    )
    assert code == 2
    assert src.read_text() == VALID_V02_SPEC  # unchanged


def test_dry_run(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--dry-run"], monkeypatch=monkeypatch)
    assert code == 0
    assert '+version: "0.3"' in out
    assert '-version: "0.2"' in out
    assert src.read_text() == VALID_V02_SPEC  # unchanged


def test_malformed_source_refused(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", "version: [oops")
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "invalid YAML" in err or "error" in err.lower()


def test_unknown_version(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", 'version: "9.9"\n')
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 3
    assert '"9.9"' in err


def test_already_at_target(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V03_SPEC)
    code, out, err = _run_migrate([str(src)], monkeypatch=monkeypatch)
    assert code == 0
    assert "already at v0.3" in out
    assert src.read_text() == VALID_V03_SPEC


def test_to_pinning_uses_synthetic_registry(tmp_path: Path, monkeypatch):
    """--to 0.2 on a (synthetic) v0.1 spec stops at v0.2."""
    from stratum_mcp import migrate

    # Register a synthetic v0.1 -> v0.2 transform (version-bump only).
    synth = [
        migrate.Transform(
            from_version="0.1",
            to_version="0.2",
            description="synthetic for test",
            apply=lambda doc: migrate._set_version(doc, "0.2"),
        ),
    ]
    monkeypatch.setattr(migrate, "TRANSFORMS", synth)

    v01 = VALID_V02_SPEC.replace('version: "0.2"', 'version: "0.1"')
    src = _write(tmp_path, "flow.yaml", v01)
    code, out, err = _run_migrate(
        [str(src), "--to", "0.2", "--yes"], monkeypatch=monkeypatch
    )
    assert code == 0, err
    assert 'version: "0.2"' in src.read_text()


def test_output_diverts_write(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    out_path = tmp_path / "out.yaml"
    code, out, err = _run_migrate(
        [str(src), "--output", str(out_path), "--yes"], monkeypatch=monkeypatch
    )
    assert code == 0, err
    assert src.read_text() == VALID_V02_SPEC  # source unchanged
    assert 'version: "0.3"' in out_path.read_text()


def test_backup_writes_bak(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate(
        [str(src), "--backup", "--yes"], monkeypatch=monkeypatch
    )
    assert code == 0, err
    bak = tmp_path / "flow.yaml.bak"
    assert bak.exists()
    assert bak.read_text() == VALID_V02_SPEC
    assert 'version: "0.3"' in src.read_text()


def test_yes_interactive_mutex_exits_1(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate(
        [str(src), "--yes", "--interactive"], monkeypatch=monkeypatch
    )
    assert code == 1


def test_output_existing_no_force(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    existing = _write(tmp_path, "out.yaml", "pre-existing\n")
    code, out, err = _run_migrate(
        [str(src), "--output", str(existing), "--yes"],
        monkeypatch=monkeypatch,
    )
    assert code == 1
    assert "refusing to overwrite" in err
    assert existing.read_text() == "pre-existing\n"


def test_output_existing_with_force(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    existing = _write(tmp_path, "out.yaml", "pre-existing\n")
    code, out, err = _run_migrate(
        [str(src), "--output", str(existing), "--force", "--yes"],
        monkeypatch=monkeypatch,
    )
    assert code == 0, err
    assert 'version: "0.3"' in existing.read_text()


def test_comment_preservation_golden(tmp_path: Path, monkeypatch):
    content = "# please keep me\n" + VALID_V02_SPEC
    src = _write(tmp_path, "flow.yaml", content)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 0, err
    assert "# please keep me" in src.read_text()


def test_non_mapping_root_list(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", "- one\n- two\n")
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "mapping" in err.lower()


def test_non_mapping_root_scalar(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", "hello\n")
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1


def test_non_string_version_delegates_to_validator(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", "version: 3\ncontracts: {}\n")
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1  # controlled schema error, not AttributeError


def test_missing_file(tmp_path: Path, monkeypatch):
    code, out, err = _run_migrate(
        [str(tmp_path / "does_not_exist.yaml"), "--yes"], monkeypatch=monkeypatch
    )
    assert code == 1
    assert "cannot read" in err


# ---------- T10: CLI dispatch wiring ----------


def test_cli_dispatch_runs_migrate(tmp_path: Path, monkeypatch, capsys):
    """`stratum-mcp migrate <file> --dry-run` routes to _cmd_migrate."""
    import io

    from stratum_mcp.server import main

    src = tmp_path / "flow.yaml"
    src.write_text(VALID_V02_SPEC)

    monkeypatch.setattr(
        "sys.argv", ["stratum-mcp", "migrate", str(src), "--dry-run"]
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    with pytest.raises(SystemExit) as excinfo:
        main()
    assert excinfo.value.code == 0
    out = capsys.readouterr().out
    assert '+version: "0.3"' in out


# ---------- T11: help text ----------


def test_help_mentions_migrate(capsys):
    from stratum_mcp.server import _cmd_help

    _cmd_help()
    out = capsys.readouterr().out
    assert "migrate <file>" in out


# ---------- Regression: review findings ----------


def test_dry_run_ignores_output_collision(tmp_path: Path, monkeypatch):
    """--dry-run must never complain about --output existing; it doesn't write."""
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    existing = _write(tmp_path, "out.yaml", "preserve me\n")
    code, out, err = _run_migrate(
        [str(src), "--output", str(existing), "--dry-run"],
        monkeypatch=monkeypatch,
    )
    assert code == 0, err
    assert '+version: "0.3"' in out
    assert existing.read_text() == "preserve me\n"


def test_directory_input_reports_cannot_read(tmp_path: Path, monkeypatch):
    """A directory passed as the spec path is an I/O error, not 'invalid YAML'."""
    d = tmp_path / "a_dir"
    d.mkdir()
    code, out, err = _run_migrate([str(d), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "cannot read" in err
    assert "invalid YAML" not in err


def test_non_utf8_source_reports_cannot_read(tmp_path: Path, monkeypatch):
    src = tmp_path / "flow.yaml"
    src.write_bytes(b"\xff\xfe\x00\x00binary garbage\n")
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "cannot read" in err


def test_output_missing_parent_dir_exits_1(tmp_path: Path, monkeypatch):
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    missing = tmp_path / "nowhere" / "out.yaml"
    code, out, err = _run_migrate(
        [str(src), "--output", str(missing), "--yes"], monkeypatch=monkeypatch
    )
    assert code == 1
    assert "cannot write" in err
    assert not missing.exists()


def test_transform_runtime_failure_exits_1(tmp_path: Path, monkeypatch):
    """Replace the production transform with one that raises; verify exit 1 + message."""
    from stratum_mcp import migrate

    def _boom(doc):
        raise RuntimeError("synthetic boom")

    broken = [
        migrate.Transform(
            from_version="0.2",
            to_version="0.3",
            description="broken",
            apply=_boom,
        ),
    ]
    monkeypatch.setattr(migrate, "TRANSFORMS", broken)

    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "transform 0.2->0.3 failed" in err
    assert "synthetic boom" in err
    assert src.read_text() == VALID_V02_SPEC  # file untouched


def test_backup_copy_failure_exits_1(tmp_path: Path, monkeypatch):
    """Monkeypatch shutil.copyfile to fail; --backup should exit 1 with 'cannot write'."""
    from stratum_mcp import migrate

    def _fail(src, dst, *args, **kwargs):
        raise OSError("synthetic copy failure")

    monkeypatch.setattr(migrate.shutil, "copyfile", _fail)

    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate(
        [str(src), "--backup", "--yes"], monkeypatch=monkeypatch
    )
    assert code == 1
    assert "cannot write" in err
    assert src.read_text() == VALID_V02_SPEC  # unchanged, not partially written


def test_upgrade_detect_failure_exits_1(tmp_path: Path, monkeypatch):
    """An Upgrade.detect() that raises should be caught, exit 1, file unchanged."""
    from stratum_mcp import migrate

    def _boom_detect(doc):
        raise RuntimeError("detect exploded")

    bad_upgrade = migrate.Upgrade(
        id="boom-detect",
        description="broken detect",
        detect=_boom_detect,
        apply=lambda doc, match: doc,
    )
    synth = [
        migrate.Transform(
            from_version="0.2",
            to_version="0.3",
            description="bump",
            apply=lambda doc: migrate._set_version(doc, "0.3"),
            opportunistic=[bad_upgrade],
        ),
    ]
    monkeypatch.setattr(migrate, "TRANSFORMS", synth)

    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "transform 0.2->0.3 failed" in err
    assert "detect exploded" in err
    assert src.read_text() == VALID_V02_SPEC


VALID_V02_SPEC_FLAT_SEQ = """\
# flat-indent form (sequence=2, offset=0)
version: "0.2"
contracts:
  Out:
    v: {type: string}
functions:
  work:
    mode: infer
    intent: "Do it"
    input: {}
    output: Out
flows:
  main:
    input: {}
    output: Out
    steps:
    - id: s1
      function: work
      inputs: {}
"""


def test_indentation_preserved_nested_sequence_form(tmp_path: Path, monkeypatch):
    """Spec with 4/2 sequence indent stays 4/2 after migrate."""
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 0, err
    text = src.read_text()
    # Original had "      - id: s1" (dash at col 6). Should still have it.
    assert "      - id: s1" in text
    # Only the version line should have changed.
    expected = VALID_V02_SPEC.replace('version: "0.2"', 'version: "0.3"')
    assert text == expected


def test_indentation_preserved_flat_sequence_form(tmp_path: Path, monkeypatch):
    """Spec with 2/0 (dash aligned with parent) sequence indent stays that way."""
    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC_FLAT_SEQ)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 0, err
    text = src.read_text()
    # Original had "    - id: s1" (dash at col 4, same as 'steps:').
    assert "    - id: s1" in text
    assert "      - id: s1" not in text  # not re-indented to nested form
    expected = VALID_V02_SPEC_FLAT_SEQ.replace('version: "0.2"', 'version: "0.3"')
    assert text == expected


def test_detect_sequence_style_defaults():
    from stratum_mcp.migrate import _detect_sequence_style

    assert _detect_sequence_style("key: value\n") == (2, 0)
    assert _detect_sequence_style("") == (2, 0)


def test_detect_sequence_style_flat():
    from stratum_mcp.migrate import _detect_sequence_style

    raw = "parent:\n- a\n- b\n"
    assert _detect_sequence_style(raw) == (2, 0)


def test_detect_sequence_style_nested():
    from stratum_mcp.migrate import _detect_sequence_style

    raw = "outer:\n  parent:\n    - a\n    - b\n"
    # parent at col 2, dash at col 4, delta=2 → sequence=4, offset=2
    assert _detect_sequence_style(raw) == (4, 2)


def test_detect_mapping_indent_default():
    from stratum_mcp.migrate import _detect_mapping_indent

    assert _detect_mapping_indent("key: value\n") == 2
    assert _detect_mapping_indent("") == 2


def test_detect_mapping_indent_2_space():
    from stratum_mcp.migrate import _detect_mapping_indent

    assert _detect_mapping_indent("outer:\n  inner: 1\n") == 2


def test_detect_mapping_indent_4_space():
    from stratum_mcp.migrate import _detect_mapping_indent

    assert _detect_mapping_indent("outer:\n    inner: 1\n") == 4


def test_indentation_preserved_4_space_mapping(tmp_path: Path, monkeypatch):
    """Spec written with 4-space mapping indent stays 4-space after migrate."""
    spec = (
        '# 4-space mapping form\n'
        'version: "0.2"\n'
        'contracts:\n'
        '    Out:\n'
        '        v: {type: string}\n'
        'functions:\n'
        '    work:\n'
        '        mode: infer\n'
        '        intent: "Do it"\n'
        '        input: {}\n'
        '        output: Out\n'
        'flows:\n'
        '    main:\n'
        '        input: {}\n'
        '        output: Out\n'
        '        steps:\n'
        '            - id: s1\n'
        '              function: work\n'
        '              inputs: {}\n'
    )
    src = _write(tmp_path, "flow.yaml", spec)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 0, err
    text = src.read_text()
    expected = spec.replace('version: "0.2"', 'version: "0.3"')
    assert text == expected
    # Belt-and-suspenders: the inner mapping alignment must still be 4 spaces.
    assert "    Out:\n" in text
    assert "        v:" in text


def test_upgrade_apply_failure_exits_1(tmp_path: Path, monkeypatch):
    """An Upgrade.apply() that raises should be caught, exit 1, file unchanged."""
    from stratum_mcp import migrate

    def _boom_apply(doc, match):
        raise RuntimeError("apply exploded")

    bad_upgrade = migrate.Upgrade(
        id="boom-apply",
        description="broken apply",
        detect=lambda doc: [object()],  # one match so apply() gets called
        apply=_boom_apply,
    )
    synth = [
        migrate.Transform(
            from_version="0.2",
            to_version="0.3",
            description="bump",
            apply=lambda doc: migrate._set_version(doc, "0.3"),
            opportunistic=[bad_upgrade],
        ),
    ]
    monkeypatch.setattr(migrate, "TRANSFORMS", synth)

    src = _write(tmp_path, "flow.yaml", VALID_V02_SPEC)
    code, out, err = _run_migrate([str(src), "--yes"], monkeypatch=monkeypatch)
    assert code == 1
    assert "transform 0.2->0.3 failed" in err
    assert "apply exploded" in err
    assert src.read_text() == VALID_V02_SPEC
