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

import os
import subprocess
import sys
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

    darwin / BSD: ``ps -o lstart=`` (human start timestamp, stable per process).
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
    # darwin / other POSIX
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    s = out.stdout.strip()
    return s or None
