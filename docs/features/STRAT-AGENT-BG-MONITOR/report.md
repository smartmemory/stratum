# STRAT-AGENT-BG-MONITOR — implementation report

**Status:** COMPLETE (2026-07-10). Shipped in the same session that filed it,
immediately after STRAT-AGENT-BG pushed.

## Related Documents
- `./design.md` — locked design + MUST checklist (all items satisfied)
- `../STRAT-AGENT-BG/report.md` — parent feature
- Forge-top `ROADMAP.md` — STRAT-AGENT-BG-MONITOR row (STRAT-AGENT-VIS section)

## What shipped

`stratum-mcp watch <run_id> --events [--kinds=k1,k2,...]` — curated JSONL mode
for the Monitor tool: one compact JSON object per line per meaningful event.

- Default kinds `assistant,tool,error`; opt-in `started,reasoning,usage`.
- Terminal events `done` / `died` always emitted regardless of `--kinds`
  (coverage rule); unknown run_id under `--events` emits an `error` event line
  on stdout before exit 2.
- Text fields tail-capped at 2,000 chars via the existing `_cap_text` marker.
- Default and `--json` watch modes byte-identical to before; exit-code
  contract unchanged (sentinel rc / 1 on death / 2 on usage).
- Monitor recipe added to `stratum_agent_run` / `stratum_agent_poll` tool
  descriptions and `_cmd_help()`.

Files: `stratum-mcp/src/stratum_mcp/server.py` (+163/-13),
`stratum-mcp/tests/test_agent_run_bg.py` (+162, 9 new tests), `CHANGELOG.md`.

## Process

Codex-implements pattern (gpt-5.6-terra/high, `write=True`) against the
design's MUST checklist; independent codex adversarial review returned
REVIEW CLEAN on the first pass. Full local suite: **1517 passed, 2 skipped**
(was 1508 — +9 new). Live E2E: real spark bg run watched with `--events`
produced exactly `assistant` / `tool` / `assistant` / `done` lines and the
watch exit code mirrored the agent rc.

## Environment fix discovered en route (not part of the diff)

The first implementation dispatch failed: codex CLI 0.144.0 (brew cask) routes
GPT-5.6-family shell execution through a companion `codex-code-mode-host`
binary the cask does not ship, so EVERY 5.6 command failed with "host is
missing" (spark/5.3 unaffected; probes confirmed model-specific). Fixed by
setting `code_mode_host = false` under `[features]` in `~/.codex/config.toml`
(commented inline; re-enable when an update ships the binary).
`CODEX_CODE_MODE_HOST_PATH` is the env override if a host binary is obtained.
