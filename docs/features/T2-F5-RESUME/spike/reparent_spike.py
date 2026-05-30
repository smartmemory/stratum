#!/usr/bin/env python3
"""T2-F5-RESUME spike — prove the live-reparent primitive (throwaway, not TDD'd).

Question: can a connector child survive the server's death and have a FRESH
process re-attach to its output and recover the complete result?

Today's connectors spawn children with `stdout=PIPE` (in-memory, owned by the
server) and no `start_new_session`, so a server restart orphans the child and
loses its output. This spike tests the proposed alternative primitive:

  1. spawn the child **detached** (`start_new_session=True`) so it survives the
     parent's death (reparented to init/launchd, own session);
  2. have the child write its stream to a **durable file** (it opens the file
     itself — NO pipe), with fsync, plus a final result sentinel;
  3. persist a **handle** {pid, output_path, token, start_time, next_offset};
  4. from a FRESH process, re-open the file at the persisted offset, tail it to
     completion (sentinel), using pid-liveness + a token + process-start-time as
     an **identity guard** against PID reuse.

The harness deliberately lets the spawner EXIT before the child finishes (the
realistic "server died mid-run" case) and asserts the resumer still recovers
every chunk written AFTER the spawner was gone.

Run:  python reparent_spike.py selftest [--kill9]
Modes (used internally): _child / spawn / resume
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

RESULT_SENTINEL = "__t2f5_result__"


# --------------------------------------------------------------------------
# child: simulates a streaming agent writing durably to a file, no pipe
# --------------------------------------------------------------------------

def _child(output_path: str, token: str, n_chunks: int, delay: float) -> None:
    # The child OPENS THE FILE ITSELF — there is no parent-owned pipe, so the
    # child keeps writing even after its parent dies.
    with open(output_path, "a", buffering=1) as f:
        for i in range(n_chunks):
            f.write(json.dumps({"type": "chunk", "i": i, "token": token}) + "\n")
            f.flush()
            os.fsync(f.fileno())
            time.sleep(delay)
        f.write(json.dumps({
            "type": RESULT_SENTINEL, "token": token,
            "result": {"chunks": n_chunks, "ok": True},
        }) + "\n")
        f.flush()
        os.fsync(f.fileno())


def _proc_start_time(pid: int) -> str | None:
    """A cheap process-identity token to defend against PID reuse: the child's
    start time as reported by `ps`. None if the pid is gone/unreadable."""
    try:
        out = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    s = out.stdout.strip()
    return s or None


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# --------------------------------------------------------------------------
# spawn: launch the detached child, persist the handle, then EXIT
# --------------------------------------------------------------------------

def spawn(workdir: str, n_chunks: int = 6, delay: float = 0.3) -> dict:
    wd = Path(workdir)
    wd.mkdir(parents=True, exist_ok=True)
    output_path = str(wd / "agent_output.jsonl")
    handle_path = str(wd / "handle.json")
    token = os.urandom(8).hex()
    # truncate any prior output
    open(output_path, "w").close()

    proc = subprocess.Popen(
        [sys.executable, __file__, "_child", output_path, token,
         str(n_chunks), str(delay)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,   # <-- the primitive under test: detached child
    )
    handle = {
        "pid": proc.pid,
        "output_path": output_path,
        "token": token,
        "start_time": _proc_start_time(proc.pid),
        "next_offset": 0,
        "n_chunks_expected": n_chunks,
    }
    Path(handle_path).write_text(json.dumps(handle, indent=2))
    # Detach from the child in THIS process's bookkeeping and return — the
    # spawner is about to exit (simulating the server dying mid-run).
    return handle


# --------------------------------------------------------------------------
# resume: a FRESH process re-attaches to the durable stream
# --------------------------------------------------------------------------

def resume(workdir: str, timeout: float = 30.0) -> dict:
    wd = Path(workdir)
    handle_path = wd / "handle.json"
    handle = json.loads(handle_path.read_text())
    pid = handle["pid"]
    output_path = handle["output_path"]
    token = handle["token"]
    expected_start = handle.get("start_time")

    # Identity guard against PID reuse: if the pid is alive but its start time
    # no longer matches, it's a DIFFERENT process — do not trust it.
    if _pid_alive(pid):
        now_start = _proc_start_time(pid)
        if expected_start is not None and now_start is not None and now_start != expected_start:
            return {"status": "pid_reused", "pid": pid}

    chunks: list[dict] = []
    result = None
    offset = handle.get("next_offset", 0)
    deadline = time.time() + timeout
    saw_after_parent_death = 0

    while time.time() < deadline:
        with open(output_path, "r") as f:
            f.seek(offset)
            new = f.read()
            offset = f.tell()
        if new:
            for line in new.splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if rec.get("token") != token:
                    return {"status": "token_mismatch", "line": rec}
                if rec.get("type") == RESULT_SENTINEL:
                    result = rec["result"]
                else:
                    chunks.append(rec)
            # persist progress so the resume is itself resumable
            handle["next_offset"] = offset
            handle_path.write_text(json.dumps(handle, indent=2))
        if result is not None:
            return {"status": "complete", "chunks": chunks, "result": result}
        alive = _pid_alive(pid)
        if not alive:
            # one more read to drain any final bytes, then decide
            with open(output_path, "r") as f:
                f.seek(offset)
                tail = f.read()
            for line in tail.splitlines():
                if not line.strip():
                    continue
                rec = json.loads(line)
                if rec.get("type") == RESULT_SENTINEL:
                    return {"status": "complete", "chunks": chunks, "result": rec["result"]}
                chunks.append(rec)
            return {"status": "child_died_incomplete", "chunks": chunks}
        time.sleep(0.1)
    return {"status": "timeout", "chunks": chunks}


# --------------------------------------------------------------------------
# selftest harness
# --------------------------------------------------------------------------

def selftest(kill9: bool) -> int:
    import tempfile
    workdir = tempfile.mkdtemp(prefix="t2f5_spike_")
    print(f"[spike] workdir={workdir}  kill9={kill9}")

    # Run spawn in a SUBPROCESS that we then kill, so the child's parent really
    # dies mid-run (the realistic 'server restart' scenario).
    spawner = subprocess.Popen(
        [sys.executable, __file__, "spawn", workdir],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    # wait for the handle to appear (spawn persisted it before returning)
    handle_path = Path(workdir) / "handle.json"
    for _ in range(100):
        if handle_path.exists():
            break
        time.sleep(0.05)
    handle = json.loads(handle_path.read_text())
    child_pid = handle["pid"]
    print(f"[spike] child pid={child_pid}, spawner pid={spawner.pid}")

    if kill9:
        # hard-kill the spawner mid-run (SIGKILL — no cleanup chance at all)
        time.sleep(0.4)  # let a couple chunks land first
        os.kill(spawner.pid, signal.SIGKILL)
        print("[spike] SIGKILLed the spawner mid-run")
    spawner.wait()
    spawner_dead_at = time.time()
    print(f"[spike] spawner exited (code={spawner.returncode}); child should still be running")

    # Prove the child keeps writing AFTER its parent is gone.
    out_path = Path(handle["output_path"])
    size_at_death = out_path.stat().st_size
    time.sleep(0.5)
    grew = out_path.stat().st_size > size_at_death
    child_still_alive = _pid_alive(child_pid)
    print(f"[spike] after spawner death: child_alive={child_still_alive}, "
          f"output grew={grew} ({size_at_death} -> {out_path.stat().st_size} bytes)")

    # FRESH process re-attaches and recovers the full result.
    res = resume(workdir)
    print(f"[spike] resume status={res['status']}")

    n_expected = handle["n_chunks_expected"]
    ok = (
        res["status"] == "complete"
        and res["result"] == {"chunks": n_expected, "ok": True}
        and len(res["chunks"]) == n_expected
        and grew                      # child wrote AFTER the parent died
        and not child_still_alive or res["status"] == "complete"
    )
    # tighten: the load-bearing claims
    claims = {
        "child_survived_parent_death": grew,
        "fresh_process_recovered_all_chunks": len(res.get("chunks", [])) == n_expected,
        "result_sentinel_recovered": res.get("result") == {"chunks": n_expected, "ok": True},
        "status_complete": res["status"] == "complete",
    }
    print("[spike] claims:")
    for k, v in claims.items():
        print(f"          {'PASS' if v else 'FAIL'}  {k}")
    passed = all(claims.values())
    print(f"[spike] === {'PASS' if passed else 'FAIL'} ===")
    return 0 if passed else 1


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "selftest"
    if mode == "_child":
        _child(sys.argv[2], sys.argv[3], int(sys.argv[4]), float(sys.argv[5]))
    elif mode == "spawn":
        spawn(sys.argv[2])
    elif mode == "resume":
        print(json.dumps(resume(sys.argv[2]), indent=2))
    elif mode == "selftest":
        sys.exit(selftest(kill9="--kill9" in sys.argv))
    else:
        print(f"unknown mode {mode!r}", file=sys.stderr)
        sys.exit(2)
