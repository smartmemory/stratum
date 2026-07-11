"""Process-backed tests for verified process-group termination."""
from __future__ import annotations

import asyncio
import os
import signal
import sys

import pytest

import stratum_mcp.proc_identity as proc_identity
from stratum_mcp.proc_identity import (
    pid_alive,
    proc_start_time,
    terminate_verified,
)


pytestmark = pytest.mark.skipif(
    not hasattr(os, "killpg"), reason="process groups are unavailable on this platform"
)


async def _spawn(*args: str, session: bool = True, stdout=None):
    """Spawn a child, skipping rather than failing where sessions are unsupported."""
    try:
        return await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            *args,
            start_new_session=session,
            stdout=stdout,
        )
    except (NotImplementedError, OSError) as exc:
        if session:
            pytest.skip(f"cannot create a child session on this platform: {exc}")
        raise


def _identity(pid: int) -> str:
    token = proc_start_time(pid)
    if token is None:
        pytest.skip("process start-time identity token is unavailable on this platform")
    return token


async def _cleanup(proc, *, group_leader: bool) -> None:
    """Kill and reap a fixture child without ever targeting the test runner's group."""
    if proc.returncode is None:
        try:
            if group_leader:
                os.killpg(proc.pid, signal.SIGKILL)
            else:
                proc.kill()
        except (ProcessLookupError, OSError):
            pass
    await asyncio.wait_for(proc.wait(), timeout=2)


@pytest.mark.asyncio
async def test_terminate_verified_terminates_a_session_leader():
    proc = await _spawn("import time; time.sleep(60)")
    reaper = None
    try:
        token = _identity(proc.pid)
        reaper = asyncio.create_task(proc.wait())

        result = await terminate_verified(proc.pid, token, grace_s=0.5, poll_s=0.01)

        await asyncio.wait_for(reaper, timeout=2)
        assert result["status"] == "terminated"
        assert result["signaled"] == "TERM"
        assert proc.returncode is not None
        assert not pid_alive(proc.pid)
    finally:
        await _cleanup(proc, group_leader=True)


@pytest.mark.asyncio
async def test_terminate_verified_escalates_term_resistant_child_to_kill():
    proc = await _spawn(
        "import signal\n"
        "import time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "while True:\n"
        "    time.sleep(1)\n",
        stdout=asyncio.subprocess.PIPE,
    )
    reaper = None
    try:
        assert await asyncio.wait_for(proc.stdout.readline(), timeout=2) == b"ready\n"
        token = _identity(proc.pid)
        reaper = asyncio.create_task(proc.wait())

        result = await terminate_verified(proc.pid, token, grace_s=0.15, poll_s=0.01)

        await asyncio.wait_for(reaper, timeout=2)
        assert result["status"] == "killed"
        assert result["signaled"] == "KILL"
        assert proc.returncode is not None
        assert not pid_alive(proc.pid)
    finally:
        await _cleanup(proc, group_leader=True)


@pytest.mark.asyncio
async def test_terminate_verified_does_not_signal_identity_mismatch():
    proc = await _spawn("import time; time.sleep(60)")
    try:
        token = _identity(proc.pid)

        result = await terminate_verified(proc.pid, token + "-wrong")

        assert result["status"] == "identity_mismatch"
        assert result["signaled"] is None
        assert proc.returncode is None
        assert pid_alive(proc.pid)
        assert proc_start_time(proc.pid) == token
    finally:
        await _cleanup(proc, group_leader=True)


@pytest.mark.asyncio
async def test_terminate_verified_accepts_an_already_dead_pid():
    proc = await _spawn("pass")
    await asyncio.wait_for(proc.wait(), timeout=2)

    result = await terminate_verified(proc.pid, "no-longer-relevant")

    assert result["status"] == "already_gone"
    assert result["signaled"] is None


@pytest.mark.asyncio
async def test_terminate_verified_rejects_non_group_leader_without_signaling():
    proc = await _spawn("import time; time.sleep(60)", session=False)
    try:
        token = _identity(proc.pid)
        assert os.getpgid(proc.pid) != proc.pid
        signals = []

        def record_signal(pgid, sig):
            signals.append((pgid, sig))

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setattr(proc_identity.os, "killpg", record_signal)
            result = await terminate_verified(proc.pid, token)

        assert result["status"] == "not_group_leader"
        assert result["signaled"] is None
        assert signals == []
        assert proc.returncode is None
        assert pid_alive(proc.pid)
    finally:
        await _cleanup(proc, group_leader=False)


@pytest.mark.asyncio
async def test_terminate_verified_does_not_treat_unreadable_live_pid_as_vanished(
):
    """A live pid with an unreadable token is not proof the target vanished."""
    proc = await _spawn(
        "import signal\n"
        "import time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "while True:\n"
        "    time.sleep(1)\n",
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        assert await asyncio.wait_for(proc.stdout.readline(), timeout=2) == b"ready\n"
        token = _identity(proc.pid)
        assert os.getpgid(proc.pid) == proc.pid
        real_killpg = proc_identity.os.killpg
        real_start_time = proc_identity.proc_start_time
        kill_attempted = False

        def unreadable_after_kill(pid):
            if kill_attempted:
                return None
            return real_start_time(pid)

        def suppress_kill_for_live_fixture(pgid, sig):
            nonlocal kill_attempted
            if sig == signal.SIGKILL:
                kill_attempted = True
                return
            return real_killpg(pgid, sig)

        with pytest.MonkeyPatch.context() as scoped_monkeypatch:
            scoped_monkeypatch.setattr(
                proc_identity, "proc_start_time", unreadable_after_kill
            )
            scoped_monkeypatch.setattr(
                proc_identity.os, "killpg", suppress_kill_for_live_fixture
            )
            result = await terminate_verified(proc.pid, token, grace_s=0.05, poll_s=0.01)

        assert kill_attempted
        assert result["status"] == "unverifiable_alive"
        assert result["signaled"] == "KILL"
        assert proc.returncode is None
        assert pid_alive(proc.pid)
    finally:
        await _cleanup(proc, group_leader=True)


@pytest.mark.asyncio
async def test_terminate_verified_treats_definite_start_time_recycle_as_vanished():
    """A readable, different token is proof the persisted target is gone."""
    proc = await _spawn(
        "import signal\n"
        "import time\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "print('ready', flush=True)\n"
        "while True:\n"
        "    time.sleep(1)\n",
        stdout=asyncio.subprocess.PIPE,
    )
    try:
        assert await asyncio.wait_for(proc.stdout.readline(), timeout=2) == b"ready\n"
        token = _identity(proc.pid)
        assert os.getpgid(proc.pid) == proc.pid
        real_killpg = proc_identity.os.killpg
        term_sent = False

        def recycled_after_term(pid):
            if term_sent:
                return token + "-recycled"
            return proc_start_time(pid)

        def note_term(pgid, sig):
            nonlocal term_sent
            if sig == signal.SIGTERM:
                term_sent = True
            return real_killpg(pgid, sig)

        with pytest.MonkeyPatch.context() as monkeypatch:
            monkeypatch.setattr(proc_identity, "proc_start_time", recycled_after_term)
            monkeypatch.setattr(proc_identity.os, "killpg", note_term)
            result = await terminate_verified(proc.pid, token, grace_s=0.05, poll_s=0.01)

        assert term_sent
        assert result["status"] == "terminated"
        assert result["signaled"] == "TERM"
        assert proc.returncode is None
        assert pid_alive(proc.pid)
    finally:
        await _cleanup(proc, group_leader=True)
