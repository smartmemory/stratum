# STRAT-PY-SWEEP — Consumer cutover sweep (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 4

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 4; decisions D1, D3, D4)
- Upstream: Phase 2 port designs (STRAT-TS-GUARD etc.), STRAT-PY-TRIAGE
  design (disposition table gates entry)
- Downstream: STRAT-PY-REMOVE design (entry gate = this sweep + 2 weeks
  TS-only)
- compose: `docs/features/COMP-STRATUM-TS/design.md` (engine flag
  precedent), COMP-STRATUM-TS-2 (agent-side registration — Phase 1, must
  be done first)

## Problem

After Phases 1–3, the TS engine can serve every surviving consumer — but
the consumers still point at Python: two `.mcp.json` registrations, the
compose python dispatch branch, the forge workspace flag, one cron that
rewrites a Python source file, and instruction text (CLAUDE.md chain +
skills). Each must flip with a verification step and a config-level
rollback until removal day.

## Consumer inventory (measured 2026-07-11; re-verify at execution)

| # | Consumer | Cutover | Verify | Rollback |
|---|---|---|---|---|
| 1 | forge `.mcp.json` `stratum` server (`stratum-mcp` bin) | register TS stdio server (mechanism from COMP-STRATUM-TS-2) | session smoke: `stratum_plan` → `stratum_step_done` round-trip on TS | restore old entry |
| 2 | compose `.mcp.json` | same | same | same |
| 3 | forge workspace `.compose/compose.json` engine flag | `stratumEngine: "ts"` | monitor shows a real TS-store gate end to end | flip back |
| 4 | compose `stratum-client.js` guard pin | delete pin (needs STRAT-TS-GUARD) | compose lifecycle-guard suite green on TS | re-pin |
| 5 | compose default engine | default `"ts"`, python branch KEPT one release | full compose suite + soak-style probe | env override |
| 6 | `model-pricing-refresh.sh` cron → `src/stratum/judge/codex_models.py` | D4 relocation (below) | cron dry-run produces valid file; TS judge reads it | old path until removal |
| 7 | CLAUDE.md chain + skills tool references | sweep instruction text to TS-served names | grep: no reference to a python-only tool | git revert |
| 8 | soak cron `stratum-ts-soak.mjs` | retire (real traffic is the signal) | crontab entry removed | re-add |

Ordering: 1–2 first (they create real TS traffic), then 3, then 4–5, then
6–8. Item 5's python-branch deletion is the LAST code change, one release
after the default flip.

## D4 relocation design (codex model allowlist)

Today: `src/stratum/judge/codex_models.py` holds `DEFAULT_CODEX_MODEL` +
`CODEX_MODEL_IDS`; a monthly cron rewrites it; the Python MCP server
imports it (undeclared dep).

Target: **one JSON data file in the stratum repo** — `config/codex-models.json`
(new) — `{ "default": "...", "allowlist": [...], "updated": "YYYY-MM-DD" }`.

- TS judge backend reads it at spawn (with the existing `CODEX_MODEL` env
  override taking precedence — behavior preserved).
- The cron rewrites the JSON instead of the .py.
- `codex_models.py` becomes a 5-line shim reading the JSON (keeps Python
  green during overlap), deleted in Phase 5.

Rationale: data belongs in data files; the cron currently editing Python
source is the anomaly being retired, not a pattern to preserve.

## Files

| File | Action | Purpose |
|---|---|---|
| `config/codex-models.json` (new, stratum) | add | engine-neutral model allowlist |
| `ts/src/judge/*` (existing, stratum) | modify | read JSON config |
| `src/stratum/judge/codex_models.py` (existing) | modify | shim over JSON until Phase 5 |
| `forge/scripts/model-pricing-refresh.sh` (existing, forge — not git) | modify | rewrite JSON |
| forge + compose `.mcp.json` (existing) | modify | TS server registration |
| compose `server/stratum-client.js` (existing) | modify | guard unpin; later default flip; later branch deletion |
| CLAUDE.md chain / skills (existing, various) | modify | instruction sweep |

## Acceptance criteria

- [ ] Inventory re-verified at execution start (grep sweep; new consumers
      since 2026-07-11 added to the table)
- [ ] Each row cut over in order, with its Verify step recorded in this doc
- [ ] `config/codex-models.json` live; cron + TS judge verified against it;
      `CODEX_MODEL` env override still wins
- [ ] Two-week TS-only clock start date recorded (gates STRAT-PY-REMOVE)
- [ ] Zero Python `stratum-mcp` spawns observed during the clock (probe:
      grep compose logs / `ps` sampling note in this doc)

## Open questions

- Does the TS stdio server registration (COMP-STRATUM-TS-2) land a
  `compose init`-managed entry or a hand-edited `.mcp.json`? Whichever
  ships, rows 1–2 use that mechanism — not a third one.
