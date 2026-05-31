"""T2-F5-RESUME S1 — codex durable-stream mode.

Covers the connector half of live-process reparenting: a durable, detached
spawn that writes codex JSONL to a file it owns plus a completion sentinel, a
file tailer that feeds the same per-event emitter the PIPE path uses, the
process-group interrupt, and the "finally must not kill the detached child"
teardown contract.

Real `codex` is never invoked — `_build_codex_cmd` is monkeypatched to return a
small `sh` script that emits codex-shaped JSONL and exits with a chosen rc. The
durable wrapper wraps that exactly as it would wrap the real (possibly
jail-wrapped) codex argv.
"""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import signal
import time
from pathlib import Path

import pytest

from stratum_mcp.connectors.codex import (
    CodexConnector,
    T2F5_DONE_SENTINEL,
    _CODEX_ERROR_KIND,
    _emit_for_codex_event,
)
from stratum_mcp.events import INTERNAL_RESULT_KIND, ConnectorEvent


# --------------------------------------------------------------------------
# fake codex: an sh script emitting codex-shaped JSONL on stdout
# --------------------------------------------------------------------------

def _fake_codex_argv(jsonl_records: list[dict], *, rc: int = 0, stderr: str = "",
                     sleep_before_exit: float = 0.0) -> list[str]:
    parts: list[str] = []
    for rec in jsonl_records:
        line = json.dumps(rec)
        parts.append(f"printf '%s\\n' {shlex.quote(line)}")
    if stderr:
        parts.append(f"printf '%s' {shlex.quote(stderr)} 1>&2")
    if sleep_before_exit:
        parts.append(f"sleep {sleep_before_exit}")
    parts.append(f"exit {rc}")
    return ["sh", "-c", "; ".join(parts)]


def _patch_codex_cmd(conn: CodexConnector, argv: list[str]) -> None:
    conn._build_codex_cmd = lambda args, env=None: list(argv)  # type: ignore[assignment]


async def _collect(agen) -> list[ConnectorEvent]:
    out = []
    async for ev in agen:
        out.append(ev)
    return out


THREAD_STARTED = {"type": "thread.started", "thread_id": "t-1"}
AGENT_MSG = {"type": "item.completed",
             "item": {"type": "agent_message", "text": "the answer is 42"}}
TURN_DONE = {"type": "turn.completed",
             "usage": {"input_tokens": 11, "output_tokens": 7, "cached_input_tokens": 2}}


# --------------------------------------------------------------------------
# _emit_for_codex_event — stateless per-record mapping
# --------------------------------------------------------------------------

def test_emit_thread_started_maps_to_agent_started():
    evs = _emit_for_codex_event(THREAD_STARTED, model="gpt-5.4", prompt="hi there")
    assert len(evs) == 1
    assert evs[0].kind == "agent_started"
    assert evs[0].metadata["model"] == "gpt-5.4"
    assert evs[0].metadata["prompt_chars"] == len("hi there")


def test_emit_agent_message_maps_to_assistant_relay():
    evs = _emit_for_codex_event(AGENT_MSG, model="gpt-5.4", prompt="x")
    assert [e.kind for e in evs] == ["agent_relay"]
    assert evs[0].metadata == {"text": "the answer is 42", "role": "assistant"}


def test_emit_command_execution_maps_to_tool_use_summary():
    evs = _emit_for_codex_event(
        {"type": "item.completed",
         "item": {"type": "command_execution", "command": "ls -la",
                  "exit_code": 0, "duration_ms": 12}},
        model="m", prompt="p")
    assert evs[0].kind == "tool_use_summary"
    assert evs[0].metadata["tool"] == "bash"
    assert evs[0].metadata["ok"] is True


def test_emit_turn_completed_maps_to_step_usage():
    evs = _emit_for_codex_event(TURN_DONE, model="gpt-5.4", prompt="p")
    assert evs[0].kind == "step_usage"
    assert evs[0].metadata["input_tokens"] == 11
    assert evs[0].metadata["output_tokens"] == 7
    assert evs[0].metadata["cache_read_input_tokens"] == 2


def test_emit_error_maps_to_internal_error_kind():
    evs = _emit_for_codex_event({"type": "error", "message": "boom"},
                                model="m", prompt="p")
    assert evs[0].kind == _CODEX_ERROR_KIND
    assert evs[0].metadata["message"] == "boom"


def test_emit_unknown_type_is_empty():
    assert _emit_for_codex_event({"type": "whatever"}, model="m", prompt="p") == []


# --------------------------------------------------------------------------
# _tail_stream — complete-line parsing, partial safety, sentinel stop
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tail_stream_parses_and_stops_at_sentinel(tmp_path):
    out = tmp_path / "s.jsonl"
    out.write_text(
        json.dumps(THREAD_STARTED) + "\n"
        + json.dumps(AGENT_MSG) + "\n"
        + json.dumps({T2F5_DONE_SENTINEL: 0}) + "\n"
    )
    conn = CodexConnector(stream_path=str(out))
    recs = []
    async for rec, off in conn._tail_stream(str(out), 0, is_alive=lambda: False):
        recs.append(rec)
    assert recs[0]["type"] == "thread.started"
    assert recs[-1] == {T2F5_DONE_SENTINEL: 0}


@pytest.mark.asyncio
async def test_tail_stream_carries_partial_trailing_line(tmp_path):
    out = tmp_path / "s.jsonl"
    # write a complete line plus a partial (no trailing newline)
    full = json.dumps(THREAD_STARTED)
    partial = json.dumps(AGENT_MSG)[:10]
    out.write_text(full + "\n" + partial)
    conn = CodexConnector(stream_path=str(out))

    seen = []

    async def _drive():
        async for rec, off in conn._tail_stream(str(out), 0,
                                                is_alive=lambda: True,
                                                poll_interval=0.02):
            seen.append(rec)
            if rec.get(T2F5_DONE_SENTINEL) is not None:
                return

    task = asyncio.ensure_future(_drive())
    await asyncio.sleep(0.1)
    # only the complete line parsed; the partial was NOT json.loads'd (no crash)
    assert seen == [THREAD_STARTED]
    # now complete the partial line and append the sentinel
    with open(out, "a") as f:
        f.write(json.dumps(AGENT_MSG)[10:] + "\n" + json.dumps({T2F5_DONE_SENTINEL: 0}) + "\n")
    await asyncio.wait_for(task, timeout=2)
    assert AGENT_MSG in seen
    assert {T2F5_DONE_SENTINEL: 0} in seen


# --------------------------------------------------------------------------
# durable spawn — sentinel rc, event stream, durable_spawned handle
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_durable_spawn_writes_sentinel_rc0_and_recovers_result(tmp_path):
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    _patch_codex_cmd(conn, _fake_codex_argv([THREAD_STARTED, AGENT_MSG, TURN_DONE], rc=0))
    evs = await _collect(conn.stream_events(prompt="solve it"))

    kinds = [e.kind for e in evs]
    assert kinds[0] == "durable_spawned"
    assert "agent_started" in kinds
    assert "agent_relay" in kinds
    result_evs = [e for e in evs if e.kind == INTERNAL_RESULT_KIND]
    assert result_evs and result_evs[-1].metadata["content"] == "the answer is 42"

    # the wrapper appended the durable completion sentinel
    last = [ln for ln in out.read_text().splitlines() if ln.strip()][-1]
    assert json.loads(last) == {T2F5_DONE_SENTINEL: 0}

    handle = next(e for e in evs if e.kind == "durable_spawned").metadata
    assert handle["stream_path"] == str(out)
    assert handle["child_pid"] > 0
    assert handle["proc_start_time"]  # non-empty identity token


@pytest.mark.asyncio
async def test_durable_spawn_rc_nonzero_no_result_fails_from_stderr(tmp_path):
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    _patch_codex_cmd(conn, _fake_codex_argv([THREAD_STARTED], rc=3,
                                            stderr="auth failed: not logged in"))
    with pytest.raises(RuntimeError, match="auth failed"):
        await _collect(conn.stream_events(prompt="p"))
    # sentinel still written with the real rc
    last = [ln for ln in out.read_text().splitlines() if ln.strip()][-1]
    assert json.loads(last) == {T2F5_DONE_SENTINEL: 3}


@pytest.mark.asyncio
async def test_durable_error_event_recorded_then_fails_after_sentinel(tmp_path):
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    # error event arrives mid-stream, THEN the process still exits 0 + sentinel
    _patch_codex_cmd(conn, _fake_codex_argv(
        [THREAD_STARTED, {"type": "error", "message": "model refused"}, TURN_DONE],
        rc=0))
    with pytest.raises(RuntimeError, match="model refused"):
        await _collect(conn.stream_events(prompt="p"))
    # tail reached the sentinel (did not bail on the error event)
    last = [ln for ln in out.read_text().splitlines() if ln.strip()][-1]
    assert json.loads(last) == {T2F5_DONE_SENTINEL: 0}


# --------------------------------------------------------------------------
# jailed-codex durable composition (Codex review #3)
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_durable_composes_with_jail_wrapped_argv(tmp_path):
    """When _build_codex_cmd returns a jail-wrapped argv, the T2F5 wrapper sits
    OUTSIDE it and still recovers the result from $T2F5_OUT."""
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    inner = _fake_codex_argv([THREAD_STARTED, AGENT_MSG, TURN_DONE], rc=0)
    # emulate DockerJailDriver.wrap_argv: a bash -lc 'exec "$@"' shell around codex
    jail_wrapped = ["bash", "-lc", 'exec "$@"', "bash", *inner]
    _patch_codex_cmd(conn, jail_wrapped)
    evs = await _collect(conn.stream_events(prompt="p"))
    result_evs = [e for e in evs if e.kind == INTERNAL_RESULT_KIND]
    assert result_evs and result_evs[-1].metadata["content"] == "the answer is 42"
    last = [ln for ln in out.read_text().splitlines() if ln.strip()][-1]
    assert json.loads(last) == {T2F5_DONE_SENTINEL: 0}


# --------------------------------------------------------------------------
# interrupt (killpg) + finally-no-kill teardown contract
# --------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_durable_interrupt_killpgs_the_group(tmp_path):
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    _patch_codex_cmd(conn, _fake_codex_argv([THREAD_STARTED], rc=0, sleep_before_exit=30))

    agen = conn.stream_events(prompt="p")
    first = await agen.__anext__()
    assert first.kind == "durable_spawned"
    pid = first.metadata["child_pid"]
    assert _alive(pid)
    conn.interrupt()
    # group killed → child gone shortly
    await _await_dead(pid)
    assert not _alive(pid)
    await agen.aclose()


@pytest.mark.asyncio
async def test_durable_finally_does_not_kill_detached_child(tmp_path):
    out = tmp_path / "task.jsonl"
    conn = CodexConnector(stream_path=str(out), stderr_path=str(tmp_path / "task.err"))
    _patch_codex_cmd(conn, _fake_codex_argv([THREAD_STARTED], rc=0, sleep_before_exit=30))

    agen = conn.stream_events(prompt="p")
    first = await agen.__anext__()
    pid = first.metadata["child_pid"]
    assert _alive(pid)
    # closing the generator (shutdown/cancel) must NOT kill the detached child
    await agen.aclose()
    await asyncio.sleep(0.2)
    assert _alive(pid), "durable child must survive connector teardown"
    # cleanup
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def _await_dead(pid: int, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return
        await asyncio.sleep(0.05)
