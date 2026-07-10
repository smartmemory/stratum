from __future__ import annotations

import asyncio
import json
import shlex
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from stratum_mcp import server as server_mod
from stratum_mcp.connectors.codex import CodexConnector, T2F5_DONE_SENTINEL
from stratum_mcp.events import ConnectorEvent, INTERNAL_RESULT_KIND
from stratum_mcp.server import (
    _agent_run_dir,
    _bg_pid_alive,
    _cmd_watch,
    stratum_agent_poll,
    stratum_agent_run,
    stratum_cancel_agent_run,
)


def _fake_codex_argv(
    jsonl_records: list[dict],
    *,
    rc: int = 0,
    stderr: str = "",
    sleep_before_exit: float = 0.0,
) -> list[str]:
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


def _install_fake_codex(monkeypatch: pytest.MonkeyPatch, argv: list[str]) -> None:
    def _factory(agent_type, model_id, cwd, **kwargs):
        conn = CodexConnector(
            model_id=model_id or "gpt-5",
            cwd=cwd,
            read_jail=kwargs.get("read_jail"),
            stream_path=kwargs.get("stream_path"),
            stderr_path=kwargs.get("stderr_path"),
            sandbox_mode=kwargs.get("sandbox_mode", "read-only"),
        )
        _patch_codex_cmd(conn, argv)
        return conn

    monkeypatch.setattr(server_mod, "_make_agent_connector", _factory)


THREAD_STARTED = {"type": "thread.started", "thread_id": "t-1"}
AGENT_MSG = {"type": "item.completed", "item": {"type": "agent_message", "text": "done text"}}
TURN_DONE = {
    "type": "turn.completed",
    "usage": {"input_tokens": 3, "output_tokens": 4, "cached_input_tokens": 0},
}


async def _wait_for_poll(run_id: str, status: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await stratum_agent_poll(run_id=run_id, ctx=None)
        if last["status"] == status:
            return last
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out waiting for {status}; last={last}")


async def _wait_for_not_running(run_id: str, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = await stratum_agent_poll(run_id=run_id, ctx=None)
        if last["status"] != "running":
            return last
        await asyncio.sleep(0.05)
    raise AssertionError(f"timed out waiting for terminal poll; last={last}")


@pytest.fixture(autouse=True)
def _home_tmp(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("HOME", str(tmp_path))
    yield


@pytest.mark.asyncio
async def test_background_golden_flow_running_then_complete_with_meta(monkeypatch, tmp_path):
    _install_fake_codex(
        monkeypatch,
        _fake_codex_argv([THREAD_STARTED, AGENT_MSG, TURN_DONE], rc=0, sleep_before_exit=1.0),
    )

    started = await stratum_agent_run(
        prompt="solve",
        ctx=None,
        type="codex",
        cwd=str(tmp_path),
        background=True,
    )

    assert started["status"] == "bg_started"
    run_id = started["run_id"]
    stream_path = Path(started["stream_path"])
    assert len(run_id) == 12
    assert stream_path.exists()
    assert T2F5_DONE_SENTINEL not in stream_path.read_text(encoding="utf-8")

    running = await _wait_for_poll(run_id, "running")
    assert running["run_id"] == run_id
    assert running["stream_path"] == str(stream_path)

    complete = await _wait_for_poll(run_id, "complete")
    assert complete["text"] == "done text"
    assert complete["exit_code"] == 0
    assert complete["usage"]["tokens"] == 7

    meta = json.loads((_agent_run_dir(run_id) / "meta.json").read_text(encoding="utf-8"))
    assert meta["child_pid"] == started["pid"]
    assert meta["proc_start_time"]


@pytest.mark.asyncio
async def test_background_rc_nonzero_polls_error_with_stderr(monkeypatch, tmp_path):
    _install_fake_codex(
        monkeypatch,
        _fake_codex_argv([THREAD_STARTED], rc=4, stderr="auth failed"),
    )
    started = await stratum_agent_run(
        prompt="solve", ctx=None, type="codex", cwd=str(tmp_path), background=True
    )

    error = await _wait_for_poll(started["run_id"], "error")
    assert error["exit_code"] == 4
    assert "auth failed" in error["stderr_tail"]


@pytest.mark.asyncio
async def test_background_guards_and_unknown_poll(monkeypatch):
    with pytest.raises(ValueError, match="STRAT-AGENT-BG-CLAUDE"):
        await stratum_agent_run(prompt="p", ctx=None, type="claude", background=True)

    flow = SimpleNamespace(budget_state={"caps": {}, "consumed": {}}, terminal_status=None)
    server_mod._flows["budgeted-flow"] = flow
    try:
        with pytest.raises(ValueError, match="STRAT-AGENT-BG-BUDGET"):
            await stratum_agent_run(
                prompt="p",
                ctx=None,
                type="codex",
                background=True,
                correlation_id="budgeted-flow",
            )
    finally:
        server_mod._flows.pop("budgeted-flow", None)

    assert await stratum_agent_poll(run_id="missing", ctx=None) == {
        "status": "not_found",
        "run_id": "missing",
    }


@pytest.mark.asyncio
async def test_background_cancel_kills_process_group_and_polls_terminal(monkeypatch, tmp_path):
    _install_fake_codex(
        monkeypatch,
        _fake_codex_argv([THREAD_STARTED], rc=0, sleep_before_exit=30.0),
    )
    started = await stratum_agent_run(
        prompt="solve", ctx=None, type="codex", cwd=str(tmp_path), background=True
    )
    run_id = started["run_id"]
    assert (await _wait_for_poll(run_id, "running"))["status"] == "running"

    cancelled = await stratum_cancel_agent_run(correlation_id=run_id, ctx=None)
    assert cancelled == {"status": "cancelled", "run_id": run_id}

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        meta = json.loads((_agent_run_dir(run_id) / "meta.json").read_text(encoding="utf-8"))
        if not _bg_pid_alive(meta):
            break
        await asyncio.sleep(0.05)
    assert not _bg_pid_alive(meta)

    terminal = await _wait_for_not_running(run_id)
    assert terminal["status"] == "error"
    assert terminal.get("reason") == "child_died_without_sentinel"


def _write_registry_run(tmp_path: Path, run_id: str, records: list[dict], stderr: str = "") -> Path:
    run_dir = _agent_run_dir(run_id)
    run_dir.mkdir(parents=True)
    stream_path = run_dir / "stream.jsonl"
    stderr_path = run_dir / "stream.jsonl.err"
    stream_path.write_text(
        "".join(json.dumps(rec) + "\n" for rec in records),
        encoding="utf-8",
    )
    stderr_path.write_text(stderr, encoding="utf-8")
    (run_dir / "meta.json").write_text(
        json.dumps(
            {
                "run_id": run_id,
                "type": "codex",
                "model_id": "gpt-5",
                "cwd": str(tmp_path),
                "sandbox_mode": "read-only",
                "write": False,
                "prompt_chars": 1,
                "correlation_id": None,
                "created_at": "2026-07-10T00:00:00Z",
                "child_pid": 0,
                "proc_start_time": None,
                "stream_path": str(stream_path),
                "stderr_path": str(stderr_path),
                "schema": None,
            }
        ),
        encoding="utf-8",
    )
    return stream_path


def test_watch_cli_streams_text_and_exits_with_sentinel_rc(capsys, tmp_path):
    run_id = "ab12cd34ef56"
    _write_registry_run(
        tmp_path,
        run_id,
        [THREAD_STARTED, AGENT_MSG, {T2F5_DONE_SENTINEL: 7}],
    )

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id])

    assert ei.value.code == 7
    out = capsys.readouterr().out
    assert "done text" in out
    assert f"run {run_id} finished rc=7" in out


def test_watch_cli_missing_run_exits_2(capsys):
    with pytest.raises(SystemExit) as ei:
        _cmd_watch(["missing-run"])

    assert ei.value.code == 2
    assert "unknown run_id missing-run" in capsys.readouterr().err


@pytest.mark.asyncio
async def test_poll_caps_oversized_text_tail(tmp_path):
    run_id = "cafe12345678"
    huge = "a" * 25_000
    _write_registry_run(
        tmp_path,
        run_id,
        [
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": huge},
            },
            {T2F5_DONE_SENTINEL: 0},
        ],
    )

    result = await stratum_agent_poll(run_id=run_id, ctx=None)

    assert result["status"] == "complete"
    assert len(result["text"]) <= 20_000
    assert result["text"].startswith("[truncated, full stream at ")
    assert result["text"].endswith("a" * 100)


@pytest.mark.asyncio
async def test_poll_and_cancel_reject_non_hex_run_ids(tmp_path):
    # Review finding (adversarial pass): a caller-supplied id must never
    # traverse outside the registry or reach the killpg path. Non-12-hex ids
    # are rejected at the single lookup chokepoint.
    evil = "../evilrun12"
    (tmp_path / ".stratum" / "evilrun12").mkdir(parents=True)
    (tmp_path / ".stratum" / "evilrun12" / "meta.json").write_text(
        json.dumps({"run_id": evil, "child_pid": 1}), encoding="utf-8"
    )
    assert (await stratum_agent_poll(run_id=evil, ctx=None))["status"] == "not_found"
    cancel = await stratum_cancel_agent_run(correlation_id=evil, ctx=None)
    assert cancel["status"] == "not_found"


@pytest.mark.asyncio
async def test_poll_rejects_meta_run_id_mismatch(tmp_path):
    run_id = "ab12cd34ef99"
    _write_registry_run(tmp_path, run_id, [THREAD_STARTED])
    meta_path = _agent_run_dir(run_id) / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["run_id"] = "000000000000"
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    assert (await stratum_agent_poll(run_id=run_id, ctx=None))["status"] == "not_found"


def test_watch_json_stdout_is_pure_jsonl(capsys, tmp_path):
    # --json contract: every stdout line parses as JSON, including at
    # completion (Monitor consumers are line-oriented).
    run_id = "ab12cd34ef57"
    _write_registry_run(
        tmp_path, run_id, [THREAD_STARTED, AGENT_MSG, {T2F5_DONE_SENTINEL: 3}]
    )

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--json"])

    assert ei.value.code == 3
    lines = [l for l in capsys.readouterr().out.splitlines() if l.strip()]
    assert lines, "expected JSONL output"
    for line in lines:
        json.loads(line)


def test_watch_events_default_kinds_are_curated_jsonl(capsys, tmp_path):
    run_id = "ab12cd34ef58"
    _write_registry_run(
        tmp_path,
        run_id,
        [
            THREAD_STARTED,
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "first\nsecond"},
            },
            {
                "type": "item.completed",
                "item": {"type": "reasoning", "text": "hidden reasoning"},
            },
            {
                "type": "item.completed",
                "item": {
                    "type": "command_execution",
                    "command": "echo curated",
                    "exit_code": 0,
                    "duration_ms": 12,
                },
            },
            TURN_DONE,
            {"type": "error", "message": "codex unhappy"},
            {T2F5_DONE_SENTINEL: 0},
        ],
    )

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--events"])

    assert ei.value.code == 0
    lines = [line for line in capsys.readouterr().out.splitlines() if line]
    events = [json.loads(line) for line in lines]
    assert [event["event"] for event in events] == ["assistant", "tool", "error", "done"]
    assert len(lines) == 4, "embedded assistant newlines must remain one JSONL line"
    assert events[0] == {"event": "assistant", "text": "first\nsecond"}
    assert events[1] == {
        "event": "tool",
        "tool": "bash",
        "summary": "echo curated",
        "ok": True,
        "duration_ms": 12,
    }
    assert "input" not in events[1]
    assert all(
        line == json.dumps(event, separators=(",", ":"))
        for line, event in zip(lines, events)
    )


def test_watch_events_kinds_narrows_non_terminal_events(capsys, tmp_path):
    run_id = "ab12cd34ef59"
    _write_registry_run(
        tmp_path,
        run_id,
        [THREAD_STARTED, AGENT_MSG, TURN_DONE, {T2F5_DONE_SENTINEL: 0}],
    )

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--events", "--kinds=usage"])

    assert ei.value.code == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]
    assert events == [
        {
            "event": "usage",
            "input_tokens": 3,
            "output_tokens": 4,
            "cache_read_input_tokens": 0,
        },
        {"event": "done", "rc": 0},
    ]


def test_watch_events_died_ignores_kinds_filter(capsys, tmp_path):
    run_id = "ab12cd34ef60"
    _write_registry_run(tmp_path, run_id, [AGENT_MSG], stderr="child stderr")

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--events", "--kinds=usage"])

    assert ei.value.code == 1
    captured = capsys.readouterr()
    assert [json.loads(line) for line in captured.out.splitlines() if line] == [
        {
            "event": "died",
            "reason": "child_died_without_sentinel",
            "stderr_tail": "child stderr",
        }
    ]
    assert "died without completion sentinel" in captured.err


def test_watch_events_done_preserves_nonzero_sentinel_rc(capsys, tmp_path):
    run_id = "ab12cd34ef61"
    _write_registry_run(tmp_path, run_id, [{T2F5_DONE_SENTINEL: 7}])

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--events", "--kinds=usage"])

    assert ei.value.code == 7
    assert [json.loads(line) for line in capsys.readouterr().out.splitlines() if line] == [
        {"event": "done", "rc": 7}
    ]


@pytest.mark.parametrize(
    ("argv", "stderr_fragment"),
    [
        (["ab12cd34ef62", "--events", "--json"], "Usage:"),
        (["ab12cd34ef62", "--kinds=assistant"], "Usage:"),
        (["ab12cd34ef62", "--events", "--kinds=bogus"], "valid kinds:"),
    ],
)
def test_watch_events_rejects_conflicting_or_unknown_flags(capsys, argv, stderr_fragment):
    with pytest.raises(SystemExit) as ei:
        _cmd_watch(argv)

    assert ei.value.code == 2
    assert stderr_fragment in capsys.readouterr().err


def test_watch_events_unknown_run_emits_error_event_before_exit(capsys):
    with pytest.raises(SystemExit) as ei:
        _cmd_watch(["ab12cd34ef63", "--events"])

    assert ei.value.code == 2
    captured = capsys.readouterr()
    assert [json.loads(line) for line in captured.out.splitlines() if line] == [
        {"event": "error", "message": "unknown run_id ab12cd34ef63"}
    ]
    assert "unknown run_id ab12cd34ef63" in captured.err


def test_watch_events_caps_text_fields_at_2000_chars(capsys, tmp_path):
    run_id = "ab12cd34ef64"
    _write_registry_run(
        tmp_path,
        run_id,
        [
            {
                "type": "item.completed",
                "item": {"type": "agent_message", "text": "a" * 3_000},
            },
            {T2F5_DONE_SENTINEL: 0},
        ],
    )

    with pytest.raises(SystemExit) as ei:
        _cmd_watch([run_id, "--events"])

    assert ei.value.code == 0
    assistant = json.loads(capsys.readouterr().out.splitlines()[0])
    assert assistant["event"] == "assistant"
    assert len(assistant["text"]) == 2_000
    assert assistant["text"].startswith("[truncated, full stream at ")
    assert assistant["text"].endswith("a" * 100)


@pytest.mark.asyncio
async def test_background_false_keeps_sync_path(monkeypatch):
    class _FakeConnector:
        async def stream_events(self, prompt, **kwargs):
            yield ConnectorEvent(
                kind=INTERNAL_RESULT_KIND,
                metadata={"content": "sync ok"},
            )

        async def run(self, prompt, **kwargs):
            if False:
                yield {}

    monkeypatch.setattr(server_mod, "_make_agent_connector", lambda *a, **k: _FakeConnector())

    result = await stratum_agent_run(prompt="p", ctx=None, type="codex")

    assert result["text"] == "sync ok"
    assert "run_id" not in result
