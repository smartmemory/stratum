# STRAT-AGENT-BG-MONITOR — curated `watch --events` mode (design + implementation brief)

**Status:** COMPLETE (2026-07-10, see `./report.md`). Follow-up to STRAT-AGENT-BG ("option 3"
in that feature's follow-up list; forge-top ROADMAP STRAT-AGENT-VIS section).

## Related Documents
- `../STRAT-AGENT-BG/design.md` — parent feature (bg runs + watch CLI)
- `stratum-mcp/src/stratum_mcp/server.py` — `_cmd_watch` / `_cmd_watch_print_event`
- `stratum-mcp/src/stratum_mcp/connectors/codex.py` — `_emit_for_codex_event` (event source)
- Forge-top `ROADMAP.md` — STRAT-AGENT-BG-MONITOR row

## Problem

`stratum-mcp watch <run_id>` has two output modes today: default human text
(assistant lines + `[tool] summary`) and `--json` (raw JSONL firehose —
every codex record, including huge preamble/reasoning payloads). Claude Code's
Monitor tool consumes a command's stdout line-by-line and surfaces each line
as an inline session event WITHOUT a re-invocation gate — but neither mode
fits: default text is multi-line/unstructured, `--json` is the firehose.

This ticket adds the curated surface: `watch --events` emits exactly one
compact JSON line per *meaningful* event, filtered and line-buffered, so
`Monitor(command: "stratum-mcp watch <run_id> --events")` gives live
per-event interrupts. It complements (not replaces) the Bash-watcher bridge:
Bash `run_in_background` = task-list entry + completion wake; Monitor = live
per-event inline notifications.

## Locked design

### CLI surface

```
stratum-mcp watch <run_id> [--json | --events [--kinds=k1,k2,...]]
```

- `--events`: curated JSONL mode. stdout carries ONLY event lines (one
  compact `json.dumps(..., separators=(",", ":"))` object per line,
  `flush=True` per line). Diagnostics stay on stderr.
- `--events` and `--json` together → usage error, exit 2.
- `--kinds=` without `--events` → usage error, exit 2.
- `--kinds=a,b,c`: comma-separated filter over the non-terminal kinds below.
  Unknown kind name → usage error listing valid kinds, exit 2.
- Default kinds (no `--kinds`): `assistant,tool,error` — the ROADMAP-locked
  curated set. `started`, `reasoning`, `usage` are opt-in via `--kinds`.

### Event schema (one JSON object per line, `event` key first)

Mapped from `_emit_for_codex_event` output (reuse it — do NOT re-parse raw
codex records in the CLI):

| `event` | source ConnectorEvent | payload |
|---|---|---|
| `started` | `agent_started` | `{model, prompt_chars}` |
| `assistant` | `agent_relay` role=assistant | `{text}` |
| `reasoning` | `agent_relay` role=system | `{text}` |
| `tool` | `tool_use_summary` | `{tool, summary, ok, duration_ms}` — deliberately DROP the raw `input` detail block (curated, not firehose) |
| `usage` | `step_usage` | `{input_tokens, output_tokens, cache_read_input_tokens}` |
| `error` | `_codex_error` internal kind | `{message}` |
| `done` | T2F5 sentinel | `{rc}` — terminal |
| `died` | liveness backstop (pid identity check fails, no sentinel) | `{reason: "child_died_without_sentinel", stderr_tail}` — terminal |

- **Text caps:** `text` / `summary` / `message` / `stderr_tail` fields are
  tail-truncated at **2,000 chars** with a `[truncated, full stream at
  <stream_path>]` marker prepended — Monitor inline events must stay small;
  the full stream is on disk. (The 20k cap stays poll-only.)
- Because payloads are JSON-encoded, embedded newlines in assistant text
  never break the one-line-per-event invariant.

### Coverage rule (terminal states) — the load-bearing requirement

The `--kinds` filter applies ONLY to non-terminal kinds. **Every terminal
state emits its event line on stdout regardless of the filter:**

1. sentinel seen → emit `{"event":"done","rc":N}`, exit N.
2. child died without sentinel → emit `died` line on stdout (stderr keeps the
   existing human diagnostic too), exit 1.
3. unknown run_id under `--events` → emit
   `{"event":"error","message":"unknown run_id <id>"}` on stdout, exit 2
   (a Monitor consumer must never see silent stdout + nonzero exit).

Default-mode and `--json` behavior stay byte-identical to today.

### Implementation shape

- Extend `_cmd_watch` arg parsing (server.py:5366) with `--events` /
  `--kinds=`; represent mode as a simple string (`"text" | "json" | "events"`).
- New `_cmd_watch_print_event_line(ev, meta)` (or an `events` branch in
  `_cmd_watch_print_event`) doing the ConnectorEvent → event-line mapping +
  kind filter. Keep it synchronous stdlib code like the rest of the CLI.
- The `_codex_error` internal kind constant lives in `connectors/codex.py`
  (`_CODEX_ERROR_KIND`); import it rather than duplicating the literal.
- `_cmd_help()` watch line gains the new flags; keep it one line.

### MUST checklist (implementation gate)

- [ ] MUST: `--events` emits ONLY compact one-object-per-line JSON on stdout, flush per line
- [ ] MUST: default curated kinds are exactly `assistant,tool,error`
- [ ] MUST: `--kinds` filters non-terminal kinds; unknown kind → exit 2 with valid-kinds list on stderr
- [ ] MUST: `done` and `died` lines are ALWAYS emitted in `--events` mode, regardless of `--kinds`
- [ ] MUST: unknown run_id under `--events` emits an `error` event line on stdout before exit 2
- [ ] MUST: exit codes unchanged from existing watch (sentinel rc / 1 on death / 2 on usage)
- [ ] MUST: `--events --json` together and `--kinds` without `--events` → exit 2
- [ ] MUST: text fields tail-truncated at 2,000 chars with the `[truncated, full stream at <path>]` marker
- [ ] MUST: default and `--json` modes byte-identical to current behavior (existing tests untouched and green)
- [ ] MUST: reuse `_emit_for_codex_event`; no second codex-record parser
- [ ] MUST: tests added to `tests/test_agent_run_bg.py` (in-process `_cmd_watch` + capsys pattern) covering: default-kinds curation incl. multi-line assistant text staying one line; `--kinds` narrowing; died-with-filter still emits `died` (coverage rule); nonzero-rc `done` + exit code; flag-conflict and bad-kind usage errors; unknown-run error event; text cap truncation
- [ ] MUST: CHANGELOG.md `[Unreleased]` entry in the same change
- [ ] MUST: `stratum_agent_run` / `stratum_agent_poll` tool descriptions mention the Monitor recipe in ONE sentence: Bash run_in_background watch = task-list + completion wake; `Monitor(command: "stratum-mcp watch <run_id> --events")` = live per-event inline stream

## Out of scope
- Any change to `stratum_agent_poll`, the registry layout, or the sentinel.
- claude-type runs (STRAT-AGENT-BG-CLAUDE), budget debit (STRAT-AGENT-BG-BUDGET).
- A skill for the recipe — tool descriptions + this doc are the doc surface.
