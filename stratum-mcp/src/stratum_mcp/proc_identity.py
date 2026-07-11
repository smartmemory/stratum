"""Process-identity primitives for T2-F5-RESUME live-process reparenting.

A reparentable child is identified across a server restart by (pid, start_time).
`pid` alone is unsafe — the OS reuses pids — so `proc_start_time` provides a
cheap identity token: a live pid whose start time no longer matches the persisted
one is a DIFFERENT process and must be treated as dead. Proven in the feasibility
spike (`docs/features/T2-F5-RESUME/spike/`).

Leaf module: imported by both `connectors/codex.py` (stamps the handle at spawn)
and `parallel_exec.py` (classifies interrupted tasks on restart). It must not
import either, to stay free of the connector/executor import cycle.
"""
from __future__ import annotations

import asyncio
import errno
import os
import signal
import subprocess
import sys
import time
from typing import Optional


def pid_alive(pid: int) -> bool:
    """True if a process with this pid currently exists. Signal 0 probes."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but owned by another user — still "alive" for our purposes.
        return True
    except OSError:
        return False


def proc_start_time(pid: int) -> Optional[str]:
    """A stable per-process start-time token, or None if unreadable.

    darwin: ``libproc.proc_pidinfo(PROC_PIDTBSDINFO)`` start timeval.
    Linux: field 22 (``starttime``, clock ticks since boot) from
    ``/proc/<pid>/stat`` — read directly to avoid a `ps` format dependency.
    """
    if pid <= 0:
        return None
    if sys.platform.startswith("linux"):
        try:
            with open(f"/proc/{pid}/stat", "r") as f:
                data = f.read()
        except (FileNotFoundError, ProcessLookupError, PermissionError, OSError):
            return None
        # comm (field 2) may contain spaces/parens; split on the last ')'.
        rparen = data.rfind(")")
        if rparen == -1:
            return None
        rest = data[rparen + 2:].split()
        # rest[0] is field 3 (state); starttime is field 22 → index 19.
        if len(rest) < 20:
            return None
        return rest[19] or None
    if sys.platform == "darwin":
        try:
            import ctypes

            class _ProcBsdInfo(ctypes.Structure):
                _fields_ = [
                    ("pbi_flags", ctypes.c_uint32),
                    ("pbi_status", ctypes.c_uint32),
                    ("pbi_xstatus", ctypes.c_uint32),
                    ("pbi_pid", ctypes.c_uint32),
                    ("pbi_ppid", ctypes.c_uint32),
                    ("pbi_uid", ctypes.c_uint32),
                    ("pbi_gid", ctypes.c_uint32),
                    ("pbi_ruid", ctypes.c_uint32),
                    ("pbi_rgid", ctypes.c_uint32),
                    ("pbi_svuid", ctypes.c_uint32),
                    ("pbi_svgid", ctypes.c_uint32),
                    ("rfu_1", ctypes.c_uint32),
                    ("pbi_comm", ctypes.c_char * 16),
                    ("pbi_name", ctypes.c_char * 32),
                    ("pbi_nfiles", ctypes.c_uint32),
                    ("pbi_pgid", ctypes.c_uint32),
                    ("pbi_pjobc", ctypes.c_uint32),
                    ("e_tdev", ctypes.c_uint32),
                    ("e_tpgid", ctypes.c_uint32),
                    ("pbi_nice", ctypes.c_int32),
                    ("pbi_start_tvsec", ctypes.c_uint64),
                    ("pbi_start_tvusec", ctypes.c_uint64),
                ]

            libproc = ctypes.CDLL("libproc.dylib")
            info = _ProcBsdInfo()
            ret = libproc.proc_pidinfo(
                ctypes.c_int(pid),
                ctypes.c_int(3),  # PROC_PIDTBSDINFO
                ctypes.c_uint64(0),
                ctypes.byref(info),
                ctypes.c_int(ctypes.sizeof(info)),
            )
            if ret == ctypes.sizeof(info) and info.pbi_start_tvsec:
                return f"{info.pbi_start_tvsec}.{info.pbi_start_tvusec}"
        except Exception:
            return None
        return None
    # other POSIX fallback
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    s = out.stdout.strip()
    return s or None


def _signal_identity_state(pid: int, expected_start_time: Optional[str]) -> str:
    """Classify whether ``pid`` is safe to signal as its own process group.

    This is deliberately stricter than the vanished predicate: a live process
    with an unreadable token is not safe to signal, even though we cannot tell
    whether it is the persisted identity.
    """
    if pid <= 0 or not pid_alive(pid):
        return "already_gone"
    if expected_start_time is None:
        return "identity_mismatch"

    current_start_time = proc_start_time(pid)
    if current_start_time is None:
        # A process can exit between the liveness probe and the token read.
        if not pid_alive(pid):
            return "already_gone"
        return "unverifiable_alive"
    if current_start_time != expected_start_time:
        # A process can exit between the liveness probe and the token read.
        if not pid_alive(pid):
            return "already_gone"
        return "identity_mismatch"

    try:
        if os.getpgid(pid) != pid:
            return "not_group_leader"
    except ProcessLookupError:
        return "already_gone"
    except OSError:
        # We cannot prove group containment, so fail closed without a kill.
        return "identity_mismatch"
    return "alive"


def _identity_vanish_state(pid: int, expected_start_time: Optional[str]) -> str:
    """Classify whether a persisted identity is gone, alive, or unverifiable.

    The target is vanished only when the pid is absent, or when a live pid has
    a *readable*, different start token (definite pid recycle).  A live pid
    whose token is unreadable remains unverifiable alive; unreadability is
    never evidence that the target vanished.
    """
    if pid <= 0 or not pid_alive(pid):
        return "vanished"

    current_start_time = proc_start_time(pid)
    # The pid may have exited while its token was being read.
    if not pid_alive(pid):
        return "vanished"
    if current_start_time is None:
        return "unverifiable_alive"
    if expected_start_time is not None and current_start_time != expected_start_time:
        return "vanished"
    return "alive"


async def _wait_for_identity_to_vanish(
    pid: int,
    expected_start_time: Optional[str],
    *,
    grace_s: float,
    poll_s: float,
) -> str:
    """Poll until identity is vanished, still alive, or unverifiable alive."""
    deadline = time.monotonic() + max(grace_s, 0.0)
    interval = max(poll_s, 0.001)
    while True:
        state = _identity_vanish_state(pid, expected_start_time)
        if state == "vanished":
            return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return state
        await asyncio.sleep(min(interval, remaining))


async def terminate_verified(
    pid: int,
    proc_start_time: Optional[str],
    *,
    grace_s: float = 5.0,
    poll_s: float = 0.05,
) -> dict:
    """Terminate a verified process group and wait for its identity to vanish.

    The caller's persisted ``(pid, proc_start_time)`` pair is a mandatory
    identity gate. The target must also be its own process-group leader; a
    non-leader is never passed to ``killpg``. A stale or unreadable token is
    fail-closed: no signal is sent. Once TERM has been sent to the verified
    process group, a recycled pid proves the original identity is gone just as
    an absent pid does.

    Identity is re-verified immediately before each signal. This minimizes the
    race window, but cannot eliminate the residual sub-microsecond pid-recycle
    race on platforms without pidfds. Linux ``pidfd_send_signal`` is the
    follow-up needed to close that race completely.
    """
    started = time.monotonic()

    def result(status: str, signaled: Optional[str]) -> dict:
        return {
            "status": status,
            "signaled": signaled,
            "waited_s": time.monotonic() - started,
        }

    state = _signal_identity_state(pid, proc_start_time)
    if state != "alive":
        return result(state, None)

    # This is the final operation before killpg: full identity and group-leader
    # verification, with no await or other syscall between it and killpg.
    state = _signal_identity_state(pid, proc_start_time)
    if state != "alive":
        return result(state, None)

    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return result("already_gone", None)
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return result("already_gone", None)
        return result("still_alive", None)

    vanish_state = await _wait_for_identity_to_vanish(
        pid, proc_start_time, grace_s=grace_s, poll_s=poll_s
    )
    if vanish_state == "vanished":
        return result("terminated", "TERM")
    if vanish_state == "unverifiable_alive":
        return result("unverifiable_alive", "TERM")

    # The identity is still live after the bounded TERM grace.  Recheck it
    # immediately before escalation; this is the final operation before
    # killpg, with no await or other syscall between it and killpg.
    state = _signal_identity_state(pid, proc_start_time)
    if state in {"already_gone", "identity_mismatch"}:
        return result("terminated", "TERM")
    if state != "alive":
        return result(state, None)

    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        return result("terminated", "TERM")
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return result("terminated", "TERM")
        return result("still_alive", "TERM")

    vanish_state = await _wait_for_identity_to_vanish(
        pid, proc_start_time, grace_s=grace_s, poll_s=poll_s
    )
    if vanish_state == "vanished":
        return result("killed", "KILL")
    if vanish_state == "unverifiable_alive":
        return result("unverifiable_alive", "KILL")
    return result("still_alive", "KILL")
