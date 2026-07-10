# STRAT-AGENT-BG — Implementation Report

**Status:** COMPLETE (2026-07-10). Design: `./design.md`. Roadmap row:
forge-top `ROADMAP.md` (STRAT-AGENT-VIS section).

## What shipped

- `stratum_agent_run(background=True)` — codex-only detached launch via the
  T2-F5 durable-child machinery; returns `{status: "bg_started", run_id,
  stream_path, pid, watch_cmd}` immediately. Sync path byte-identical when
  False. Fail-loud guards: non-codex type → STRAT-AGENT-BG-CLAUDE error;
  budgeted-flow correlation_id → STRAT-AGENT-BG-BUDGET error.
- Registry `~/.stratum/agent_runs/<run_id>/` (stream.jsonl + `.in`/`.err`
  siblings + meta.json, atomic writes). run_id = uuid4 12-hex, validated at
  the single lookup chokepoint (`_load_agent_run_meta`).
- `stratum_agent_poll(run_id)` — restart-proof read-only status
  (running/complete/error/not_found), O(cap)-memory lazy stream scan,
  20k-char tail caps, usage tokens+dollars from the pricing table (meta
  persists the RESOLVED model id so default-model runs price correctly).
- `stratum_cancel_agent_run` extension — bg runs: pid + start-time identity
  check, group-leader check (`getpgid(pid) == pid`), then SIGTERM to the
  process group.
- `stratum-mcp watch <run_id> [--json]` CLI — line-buffered tailer; exits
  with the agent's rc; `--json` stdout is pure JSONL (Monitor-compatible);
  liveness backstop for a child that dies without a sentinel.
- `proc_identity.proc_start_time` (macOS): `ps` → native
  `libproc.proc_pidinfo(PROC_PIDTBSDINFO)`. Identity token format changed on
  macOS; persisted pre-upgrade reparent handles classify `failed` across the
  upgrade (safe degrade — `classify_interrupted_parallel_tasks` treats
  mismatch as pid-reuse, never mis-reparents).

## How it was built (dogfood)

Implemented by codex through `stratum_agent_run(type="codex", write=True)`
against this brief (the controller committed; codex sandboxes can't).
Model: the new `gpt-5.6-terra/high` default. Codex deviated from the brief
twice, both adjudicated and kept: (1) meta.json persists `schema` (needed for
restart-proof result parsing), (2) the proc_identity libproc rewrite
(motivated by its sandbox, kept on merit — no subprocess dependency; upgrade
caveat documented above).

Independent codex adversarial review (read-only) found 3 real defects, all
fixed by the controller with regression tests:
1. Registry path traversal → same-user killpg exposure via forged meta
   (High): fixed with 12-hex run_id validation + `meta.run_id` match +
   group-leader check before killpg.
2. Whole-stream in-memory scan despite the output cap (Medium): fixed with a
   lazy line iterator + rolling 2×cap text budget.
3. `watch --json` printed a non-JSON human summary at completion (Medium):
   fixed — sentinel record is the terminal event in json mode.

## Verification

- Targeted: 48 passed (`test_agent_run_bg.py` ×11 incl. 3 review-regression
  tests, plus streaming/write/durable suites).
- Full stratum-mcp suite: **1508 passed, 2 skipped** (codex's in-sandbox
  claim of 215 failures was its jail blocking `~/.stratum` writes — verified
  clean locally).
- Live golden flow (real codex child): `background=True` returned in ~1s →
  `stratum-mcp watch` run via Bash `run_in_background` appeared in Claude
  Code's task list below the statusline → streamed the agent's output →
  exited rc=0 and re-invoked the model automatically → poll returned
  `complete` with text + usage. Pricing verified: terra usage prices at
  table rates once meta carries the resolved model.

## Follow-ups (filed in forge-top ROADMAP)

STRAT-AGENT-BG-MONITOR (per-event Monitor streaming, option 3),
STRAT-AGENT-BG-CLAUDE, STRAT-AGENT-BG-BUDGET, STRAT-JUDGE-BG.
