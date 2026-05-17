"""OS-level filesystem read-jail for confining a Codex subprocess.

STRAT-JUDGE-T3-READJAIL. Pure, no judge imports — reusable by any Codex
caller that wants a hard cold-read boundary. macOS `sandbox-exec` (Seatbelt)
only in v1; Linux `bwrap` is a tracked follow-up (STRAT-JUDGE-T3-READJAIL-LINUX),
callers degrade when `read_jail_available()` is False.

The guarantee this provides and the residual it does NOT close are stated
in docs/features/STRAT-JUDGE-T3-READJAIL/design.md — do not round "deny
everything except the staged tree + codex's own runtime" up to "confined".
"""

from __future__ import annotations

import contextlib
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Iterator

# Read-allow roots the confined process needs just to start, dynamically
# link, authenticate Codex, and reach the model API over TLS. Verified in
# Phase 1: a deny-default profile without these makes the binary fail to
# exec / SIGABRT. Each is a *blast-radius* allowance, not the evidence jail.
_SYSTEM_READ_SUBPATHS = (
    "/usr/lib",
    "/usr/bin",
    "/bin",
    "/sbin",
    "/usr/sbin",
    "/System",
    "/Library/Apple",
    "/opt/homebrew",  # brew-installed codex + node runtime
    "/usr/share",
    "/private/var/db/timezone",
    "/private/etc/ssl",  # TLS to the model API
    "/private/var/run",
)
_SYSTEM_READ_LITERALS = (
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/dtracehelper",
    "/dev/tty",
)


# STRAT-JUDGE-T3-READJAIL — empirical finding (live gate, 2026-05-18).
#
# `sandbox-exec` DOES enforce a real read-jail for ordinary processes
# (proved with /bin/cat in test_judge_readjail.py). But the required
# live gate — a real `codex exec` under the generated deny-default
# profile — FAILED: codex exec EPERMs at startup regardless of every
# file-read allowance (staged tree, ~/.codex, parent chain, system),
# every non-file allowance (process*/mach*/ipc*), and codex's own
# `--dangerously-bypass-approvals-and-sandbox`. `codex --version` runs
# jailed; `codex exec` does not. Strong inference: codex exec
# self-applies Apple Seatbelt, and Seatbelt cannot be nested
# (`sandbox_apply: Operation not permitted` — verified in Phase 1).
#
# Per the design's blocking-gate contract we MUST NOT report a usable
# codex read-jail we cannot actually enforce. Until a non-nesting
# primitive lands (container/VM, or codex's own sandbox-as-jail —
# tracked as STRAT-JUDGE-T3-READJAIL-CODEXNEST), this returns False:
# paranoid T3 honestly degrades to the in-process Claude cold-read
# (reasoning-isolation + buffered-flush ordering; residual stated).
#
# The connector/profile machinery is retained intact as the verified
# substrate a future non-nesting fix builds on; flip this probe only
# when a real `codex exec` is verified to run jailed by the live gate.
_CODEX_READJAIL_VERIFIED = False


def _sandbox_exec_present() -> bool:
    """macOS + `sandbox-exec` on PATH. Internal: necessary but NOT
    sufficient for a codex read-jail (see module note)."""
    return sys.platform == "darwin" and shutil.which("sandbox-exec") is not None


def read_jail_available() -> bool:
    """True iff a real, *verified-working* OS read-jail for the codex
    adversary subprocess is usable on this host.

    Honest by construction: today this is always False because the live
    gate empirically falsified `codex exec` under `sandbox-exec` (nested
    Seatbelt EPERM). Callers degrade to the in-process Claude cold-read
    T3 and label it `claude_cold_fallback` — never `codex_jailed`.
    """
    return _CODEX_READJAIL_VERIFIED and _sandbox_exec_present()


def build_seatbelt_profile(allow_root: str | os.PathLike, scratch: str | os.PathLike) -> str:
    """Render a Seatbelt `.sb` profile: deny-by-default, read only the
    real-resolved staged turn tree (+ codex's own runtime), write only
    scratch.

    Paths are run through ``os.path.realpath`` here so the
    ``/tmp``→``/private/tmp`` (and ``~`` firmlink) canonicalization footgun
    is closed at generation time, not left to the caller.
    """
    allow_real = os.path.realpath(str(allow_root))
    scratch_real = os.path.realpath(str(scratch))
    codex_home = os.path.realpath(os.path.expanduser("~/.codex"))

    sys_subpaths = "\n".join(
        f'  (subpath "{p}")' for p in _SYSTEM_READ_SUBPATHS
    )
    sys_literals = "\n".join(
        f'  (literal "{p}")' for p in _SYSTEM_READ_LITERALS
    )
    return f"""(version 1)
(deny default)
(import "system.sb")
(allow process-exec*)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow network-outbound)
(allow network-bind (local ip))
(allow system-socket)
(allow file-read-metadata)
(allow file-read*
{sys_subpaths}
{sys_literals}
  (subpath "{codex_home}"))
;; THE READ-JAIL: the staged turn tree is the only evidence the adversary
;; may read. Sibling turns.jsonl, other flows/turns, the repo, and the
;; rest of $HOME are denied by the absence of any matching allow rule.
(allow file-read* (subpath "{allow_real}"))
(allow file-write* file-read* (subpath "{scratch_real}"))
"""


@contextlib.contextmanager
def materialize_profile(
    allow_root: str | os.PathLike, scratch: str | os.PathLike
) -> Iterator[str]:
    """Write the profile to a temp `.sb` and yield its path.

    Unlinks on exit on every path (success, exception, cancellation).
    The CALLER is responsible for ensuring the confined child has exited
    before the context closes — `sandbox-exec` reads the profile for the
    lifetime of the process it wraps.
    """
    fd, path = tempfile.mkstemp(suffix=".sb", prefix="stratum-readjail-")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(build_seatbelt_profile(allow_root, scratch))
        yield path
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)
