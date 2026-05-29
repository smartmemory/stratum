"""stratum-mcp doctor — install & environment diagnostics.

Surfaces the common first-run failure modes that otherwise present as an
opaque "installed but not found" or "No matching distribution found":

  * Python < 3.11. stratum-mcp declares ``requires-python = ">=3.11"``; on an
    older interpreter ``pip install stratum-mcp`` fails with no hint that the
    Python version is the cause.
  * stratum-mcp present in site-packages but no ``stratum-mcp`` console script
    on PATH — a pyenv-shim / PATH mismatch, or a vendored kernel build that
    declares no console script and shadows the published package.
  * The active ``python`` on PATH differing from the interpreter that owns the
    installed package, so ``pip install`` lands in a different environment.

Exposed as ``stratum-mcp doctor``. Exit code 0 = healthy, 1 = problems found.

See smartmemory/stratum#1.
"""
from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass, field

MIN_PYTHON: tuple[int, int] = (3, 11)

OK = "ok"
WARN = "warn"
FAIL = "fail"


@dataclass
class Check:
    """One diagnostic result."""

    name: str
    status: str  # OK | WARN | FAIL
    detail: str
    fix: str | None = None


@dataclass
class DoctorReport:
    checks: list[Check] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Healthy when no check failed. WARN does not fail the report."""
        return all(c.status != FAIL for c in self.checks)


@dataclass
class Probe:
    """Snapshot of the environment. Pure data so ``evaluate`` is testable."""

    python_version: tuple[int, int, int]
    executable: str
    which_stratum: str | None
    installed_version: str | None
    installed_location: str | None
    has_console_script: bool
    path_python: str | None


# ---------------------------------------------------------------------------
# gathering
# ---------------------------------------------------------------------------

def _installed_dist() -> tuple[str | None, str | None, bool]:
    """Return (version, location, has_stratum_mcp_console_script) for the
    installed ``stratum-mcp`` distribution, or (None, None, False) if absent."""
    from importlib import metadata

    try:
        dist = metadata.distribution("stratum-mcp")
    except metadata.PackageNotFoundError:
        return None, None, False

    version = dist.version
    try:
        location = str(dist.locate_file(""))
    except Exception:
        location = None

    has_script = any(
        ep.group == "console_scripts" and ep.name == "stratum-mcp"
        for ep in dist.entry_points
    )
    return version, location, has_script


def gather_probe() -> Probe:
    """Probe the live environment."""
    version, location, has_script = _installed_dist()
    return Probe(
        python_version=(
            sys.version_info.major,
            sys.version_info.minor,
            sys.version_info.micro,
        ),
        executable=sys.executable or "",
        which_stratum=shutil.which("stratum-mcp"),
        installed_version=version,
        installed_location=location,
        has_console_script=has_script,
        path_python=shutil.which("python") or shutil.which("python3"),
    )


# ---------------------------------------------------------------------------
# evaluation (pure)
# ---------------------------------------------------------------------------

def evaluate(probe: Probe) -> DoctorReport:
    """Turn a Probe into a DoctorReport. No I/O — pure and testable."""
    report = DoctorReport()
    min_str = ".".join(str(x) for x in MIN_PYTHON)

    # 1. Python version --------------------------------------------------
    pv = probe.python_version
    pv_str = ".".join(str(x) for x in pv)
    if pv[:2] >= MIN_PYTHON:
        report.checks.append(
            Check(
                "python-version",
                OK,
                f"Python {pv_str} (>= {min_str}) at {probe.executable}",
            )
        )
    else:
        report.checks.append(
            Check(
                "python-version",
                FAIL,
                f"Python {pv_str} at {probe.executable} — stratum-mcp requires >= {min_str}",
                fix=(
                    f"Install Python {min_str}+ and make it active, e.g. "
                    f"`pyenv install 3.11 && pyenv global 3.11`, then "
                    f"`pip install stratum-mcp`"
                ),
            )
        )

    # 2. Package installed ----------------------------------------------
    if probe.installed_version is None:
        report.checks.append(
            Check(
                "package-installed",
                FAIL,
                "stratum-mcp is not installed in the active environment",
                fix="`pip install stratum-mcp`  (requires Python >= 3.11)",
            )
        )
    else:
        loc = f" at {probe.installed_location}" if probe.installed_location else ""
        report.checks.append(
            Check(
                "package-installed",
                OK,
                f"stratum-mcp {probe.installed_version}{loc}",
            )
        )

    # 3. Binary on PATH -------------------------------------------------
    if probe.which_stratum:
        report.checks.append(
            Check(
                "binary-on-path",
                OK,
                f"stratum-mcp resolves to {probe.which_stratum}",
            )
        )
    elif probe.installed_version is None:
        report.checks.append(
            Check(
                "binary-on-path",
                FAIL,
                "no `stratum-mcp` binary on PATH (package not installed)",
                fix="`pip install stratum-mcp`",
            )
        )
    elif not probe.has_console_script:
        report.checks.append(
            Check(
                "binary-on-path",
                FAIL,
                (
                    f"stratum-mcp {probe.installed_version} is installed but declares "
                    f"no `stratum-mcp` console script — this is likely a vendored/kernel "
                    f"build shadowing the published package"
                ),
                fix=(
                    "Remove the shadow and reinstall the real package: "
                    "`pip uninstall -y stratum-mcp && pip install stratum-mcp`"
                ),
            )
        )
    else:
        report.checks.append(
            Check(
                "binary-on-path",
                FAIL,
                (
                    "stratum-mcp is installed but no `stratum-mcp` binary is on PATH "
                    "(PATH / pyenv-shim mismatch)"
                ),
                fix=(
                    "Symlink the console script onto PATH: "
                    "`ln -sf \"$(python -c 'import sys,os; "
                    "print(os.path.join(sys.prefix, \"bin\", \"stratum-mcp\"))')\" "
                    "~/.local/bin/stratum-mcp`"
                ),
            )
        )

    # 4. Interpreter mismatch (warn-only) -------------------------------
    if probe.path_python and probe.executable:
        if os.path.realpath(probe.path_python) != os.path.realpath(probe.executable):
            report.checks.append(
                Check(
                    "interpreter",
                    WARN,
                    (
                        f"`python` on PATH ({probe.path_python}) differs from the "
                        f"interpreter running doctor ({probe.executable}); a plain "
                        f"`pip install` may land in a different environment"
                    ),
                    fix=(
                        "Install into the interpreter that owns stratum-mcp: "
                        "`python3.11 -m pip install stratum-mcp` (or activate the venv first)"
                    ),
                )
            )

    return report


# ---------------------------------------------------------------------------
# rendering / CLI
# ---------------------------------------------------------------------------

_SYMBOL = {OK: "OK  ", WARN: "WARN", FAIL: "FAIL"}


def render(report: DoctorReport) -> str:
    lines = ["stratum-mcp doctor", "=" * 60]
    for c in report.checks:
        lines.append(f"[{_SYMBOL[c.status]}] {c.name}: {c.detail}")
        if c.fix and c.status != OK:
            lines.append(f"         fix: {c.fix}")
    lines.append("=" * 60)
    if report.ok:
        lines.append("All checks passed — stratum-mcp is healthy.")
    else:
        n = sum(1 for c in report.checks if c.status == FAIL)
        lines.append(f"{n} problem(s) found — see the fix lines above.")
    return "\n".join(lines)


def _cmd_doctor() -> None:
    report = evaluate(gather_probe())
    print(render(report))
    sys.exit(0 if report.ok else 1)
