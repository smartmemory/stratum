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

import asyncio
import contextlib
import hashlib
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Iterator, Mapping, Optional, Protocol, runtime_checkable

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

    STRAT-JUDGE-T3-READJAIL-CODEXNEST: this now reflects whichever
    :class:`JailDriver` is selectable (Docker today). It stays the single
    boolean ``verifier.py`` branches on — semantics for the verifier are
    unchanged; only the primitive behind it moved off the falsified
    `sandbox-exec`-wrapping. Honest by construction: False unless a driver
    whose `available()` is True (static capability + its own
    live-gate-verified flag) exists; callers then degrade to the
    in-process Claude cold-read and label it `claude_cold_fallback`.
    """
    return select_jail_driver() is not None


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


# ───────────────────────── STRAT-JUDGE-T3-READJAIL-CODEXNEST ─────────────────
# Non-nesting read-jail for the codex T3 adversary. The parent's live gate
# falsified wrapping `codex exec` in `sandbox-exec` (codex self-applies
# Seatbelt; Seatbelt can't nest). A container's filesystem namespace IS a
# non-nesting jail: the host repo / sibling turns.jsonl simply do not exist
# in the mount. codex runs `--dangerously-bypass-approvals-and-sandbox`
# inside because the *container* is the externally-enforced sandbox (the
# officially-sanctioned pattern), not a weakening.
#
# Two independent verification flags so one flag never conflates two
# primitives: `_CODEX_READJAIL_VERIFIED` (Seatbelt) stays permanently False
# (parent falsified it); `_DOCKER_READJAIL_VERIFIED` is flipped only by this
# feature's blocking live gate, observed passing for real on the host.
def _docker_readjail_verified() -> bool:
    """Host-scoped verification — NOT a global constant.

    The blocking live gate (test_judge_jail_docker.py) passed for real on
    **macOS/Darwin** 2026-05-18 (Docker 29.4.3, codex-cli 0.130.0): (A) a
    real `codex exec` gpt-5.4 turn through the REAL connector path read an
    unguessable planted token from the :ro-bound staged tree; (B) /bin/cat-
    grade proof the container namespace denies the sibling turns.jsonl and
    the host repo.

    Linux/CI is deliberately NOT auto-verified: codex self-sandboxes
    differently there and the same gate has not been run — that is the
    open STRAT-JUDGE-T3-READJAIL-LINUX follow-up. A hardcoded global True
    would silently take the jailed lane on an unverified host, exactly the
    overclaim the parent's lesson forbids. Until a host runs the gate it
    honestly degrades to `claude_cold_fallback`; a host that HAS run the
    gate can opt in explicitly via STRATUM_DOCKER_READJAIL_VERIFIED=1.
    """
    if os.environ.get("STRATUM_DOCKER_READJAIL_VERIFIED") == "1":
        return True
    return sys.platform == "darwin"

# Pin: the live host's codex-cli baseline. A bump changes the image tag and
# forces a rebuild.
_PINNED_CODEX_VERSION = "0.130.0"
_DOCKERFILE = Path(__file__).resolve().parent / "jail" / "Dockerfile"


class JailUnavailableError(RuntimeError):
    """Operational failure of a *selected* jail (image build/daemon/etc.).

    Raised by a driver so the connector lets it propagate; the verifier's
    existing post-launch handler labels it `codex_jailed_error` (NEVER
    silently downgraded to `claude_cold_fallback`). Pre-selection static
    absence is handled by `available()` returning False, not by this.
    """


@runtime_checkable
class JailDriver(Protocol):
    """A non-nesting read-jail for the codex adversary subprocess.

    `wrap_argv` takes the codex *sub-argv* (e.g. ``["exec","--json",...]``)
    — WITHOUT the ``"codex"`` program token; the driver supplies exactly
    one ``codex`` token itself (no double-token). It returns the full argv
    to spawn. `cleanup` tears the jail down after the child exits.
    """

    name: str

    def available(self) -> bool: ...

    def wrap_argv(
        self,
        codex_args: list[str],
        *,
        read_root: str,
        env: Optional[Mapping[str, str]] = None,
    ) -> list[str]: ...

    async def cleanup(self, proc) -> None: ...


async def _terminate_child(proc) -> None:
    """Terminate+await the confined child. Shared by every driver so the
    child is always dead before its jail artifacts are removed."""
    if proc is not None and proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, Exception):  # noqa: BLE001
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()


class SandboxExecJailDriver:
    """The retained Seatbelt path. PROVEN for ordinary processes
    (`/bin/cat`, see test_judge_readjail.py) but FALSIFIED for `codex
    exec` (nested Seatbelt EPERM). `available()` is gated on
    `_CODEX_READJAIL_VERIFIED` which stays False forever, so
    `select_jail_driver()` never returns this for codex. It exists so the
    Seatbelt regression anchor (the OS-enforcement `/bin/cat` proof)
    keeps a named, exercised subject — substrate, not an active jail.
    """

    name = "sandbox_exec"

    def __init__(self) -> None:
        self._profile: Optional[str] = None
        self._scratch: Optional[str] = None

    def available(self) -> bool:
        return _sandbox_exec_present() and _CODEX_READJAIL_VERIFIED

    def wrap_argv(
        self,
        codex_args: list[str],
        *,
        read_root: str,
        env: Optional[Mapping[str, str]] = None,
    ) -> list[str]:
        self._scratch = tempfile.mkdtemp(prefix="stratum-readjail-scratch-")
        fd, profile = tempfile.mkstemp(suffix=".sb", prefix="stratum-readjail-")
        with os.fdopen(fd, "w") as f:
            f.write(build_seatbelt_profile(read_root, self._scratch))
        self._profile = profile
        # `--ephemeral` is an `exec` subcommand flag — it MUST follow the
        # `exec` token (verbatim parent behaviour; do not change shape).
        if codex_args and codex_args[0] == "exec":
            jailed = [codex_args[0], "--ephemeral", *codex_args[1:]]
        else:
            jailed = ["--ephemeral", *codex_args]
        return ["sandbox-exec", "-f", profile, "codex", *jailed]

    async def cleanup(self, proc) -> None:
        # `sandbox-exec` reads the profile for the child's lifetime —
        # child must exit before the profile is unlinked.
        await _terminate_child(proc)
        if self._profile:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(self._profile)
            self._profile = None
        if self._scratch:
            shutil.rmtree(self._scratch, ignore_errors=True)
            self._scratch = None


def _docker_present() -> bool:
    return shutil.which("docker") is not None


def _image_tag() -> str:
    """Content-addressed tag: Dockerfile bytes + pinned codex version.
    A change to either rebuilds; otherwise it's a cache hit."""
    h = hashlib.sha256(
        _DOCKERFILE.read_bytes() + _PINNED_CODEX_VERSION.encode()
    ).hexdigest()[:12]
    return f"stratum-codexjail:{h}"


def _ensure_image() -> str:
    """Lazily build the vendored pinned image (once). Build failure is an
    operational failure of a *selected* jail → JailUnavailableError (NOT a
    silent fallback, NOT a public-image pull). Called at jail-spin time,
    never from `available()`."""
    tag = _image_tag()
    inspect = subprocess.run(
        ["docker", "image", "inspect", tag],
        capture_output=True,
    )
    if inspect.returncode == 0:
        return tag
    build = subprocess.run(
        ["docker", "build", "-t", tag, "-f", str(_DOCKERFILE),
         str(_DOCKERFILE.parent)],
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        raise JailUnavailableError(
            "codex jail image build failed (no fallback to a public image): "
            + (build.stderr or build.stdout)[-2000:]
        )
    return tag


def _rewrite_codex_args_for_container(codex_args: list[str]) -> list[str]:
    """Strip `--sandbox <mode>` — it conflicts with the
    `--dangerously-bypass-approvals-and-sandbox` the container path
    requires (the container IS the sandbox).

    `-C <cwd>` is LEFT AS-IS on purpose: the connector passes
    `cwd=staging_root` (the staged turn tree), which the driver mounts
    read-only at that exact absolute path inside the container. So the
    adversary's cwd *is* the evidence directory — repointing it at the
    empty work tmpfs made codex report "claim.txt not found" (live
    gate). codex only reads its cwd; its writes go to CODEX_HOME (the
    writable /work tmpfs), so a read-only cwd is fine."""
    out: list[str] = []
    i = 0
    while i < len(codex_args):
        a = codex_args[i]
        if a == "--sandbox" and i + 1 < len(codex_args):
            i += 2  # drop `--sandbox <mode>`
            continue
        out.append(a)
        i += 1
    return out


class DockerJailDriver:
    """Non-nesting read-jail: an ephemeral container whose only readable
    host path is the staged turn tree (a single `:ro` bind). codex runs
    `--dangerously-bypass-approvals-and-sandbox` because the container IS
    the externally-enforced sandbox. Fresh container per call → zero
    cross-predicate state bleed (the cold-read guarantee).
    """

    name = "docker"

    # Fixed in-container writable tmpfs. NOT a host path and NOT under
    # /tmp — codex refuses a CODEX_HOME under a temp dir ("Refusing to
    # create helper binaries under temporary dir"). The container is the
    # jail; this path is ephemeral per run (fresh tmpfs each `docker run`).
    _WORK = "/work"

    def __init__(self) -> None:
        self._scratch = None  # Docker needs no host scratch (tmpfs only)

    def available(self) -> bool:
        # STATIC capability only. Daemon/build/run failures are runtime
        # operational failures of a selected jail (→ JailUnavailableError
        # → verifier `codex_jailed_error`), never pre-launch absence.
        return _docker_present() and _docker_readjail_verified()

    @staticmethod
    def _auth_env(env: Optional[Mapping[str, str]]) -> dict[str, str]:
        """codex authenticates via OPENAI_API_KEY (and any CODEX_* knobs)
        injected as container env — never a `~/.codex` host mount (that
        would add a second readable host path and break the guarantee)."""
        src = dict(env or {})
        out: dict[str, str] = {}
        for k, v in src.items():
            if not v:
                continue
            if k == "OPENAI_API_KEY" or k.startswith("CODEX_"):
                out[k] = v
        return out

    def wrap_argv(
        self,
        codex_args: list[str],
        *,
        read_root: str,
        env: Optional[Mapping[str, str]] = None,
    ) -> list[str]:
        tag = _ensure_image()  # raises JailUnavailableError on build fail
        rr = os.path.realpath(str(read_root))
        work = self._WORK
        codex_home = f"{work}/.codex"
        inner = _rewrite_codex_args_for_container(codex_args)
        # Connector base args already carry `--skip-git-repo-check`; the
        # driver must NOT duplicate it (codex errors on repeats — live
        # gate). The container IS the sandbox → add only the bypass flag.
        # No `--ephemeral`: the per-run tmpfs CODEX_HOME already gives
        # ephemerality, and `--ephemeral` would ignore the auth.json the
        # in-container `codex login` writes there.
        extra = ["--dangerously-bypass-approvals-and-sandbox"]
        if inner and inner[0] == "exec":
            jailed = [inner[0], *extra, *inner[1:]]
        else:
            jailed = [*extra, *inner]
        # codex 0.130 has no usable OPENAI_API_KEY-env auto-auth and the
        # `--api-key` flag is removed; the supported non-interactive path
        # is `printenv OPENAI_API_KEY | codex login --with-api-key` which
        # writes auth.json into CODEX_HOME. Do that, THEN exec codex. The
        # login pipeline gets its own stdin (the printf); `exec codex …`
        # inherits the shell's stdin = the container stdin = the prompt
        # the connector pipes in via `docker run -i` (codex args end `-`).
        script = (
            f'set -e; mkdir -p {shlex.quote(codex_home)}; '
            f'printf %s "$OPENAI_API_KEY" | codex login --with-api-key '
            f'>/dev/null 2>&1; '
            f'exec codex {" ".join(shlex.quote(a) for a in jailed)}'
        )
        argv = [
            # `-i`: connector pipes the prompt to codex stdin (args end
            # `-`); without it docker does not forward stdin into the
            # container ("No prompt provided via stdin" — live gate).
            "docker", "run", "--rm", "-i", "--read-only",
            "--network", "bridge",
            "-v", f"{rr}:{rr}:ro",      # THE jail: only readable host path
            "--tmpfs", f"{work}:rw",    # writable work+CODEX_HOME, ephemeral
        ]
        for k, v in self._auth_env(env).items():
            argv += ["-e", f"{k}={v}"]
        argv += [
            "-e", f"HOME={work}",
            "-e", f"CODEX_HOME={codex_home}",
            "--memory", "512m", "--pids-limit", "256", "--cpus", "2",
            tag, "bash", "-lc", script,
        ]
        return argv

    async def cleanup(self, proc) -> None:
        await _terminate_child(proc)  # `--rm` self-removes the container
        if self._scratch:
            shutil.rmtree(self._scratch, ignore_errors=True)
            self._scratch = None


def select_jail_driver() -> Optional[JailDriver]:
    """The codex read-jail driver usable on this host, or None.

    Docker only in v1 (Apple-`container`/`bwrap` slot in here as future
    drivers). NEVER returns the Seatbelt driver for codex — it is the
    falsified/inert substrate. None ⇒ `read_jail_available()` False ⇒
    verifier honestly degrades to `claude_cold_fallback`.
    """
    docker = DockerJailDriver()
    if docker.available():
        return docker
    return None
