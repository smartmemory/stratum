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
| 4 | compose `stratum-client.js` guard pin | run `stratum-mcp guard handoff` per existing resource (ownership marker, see STRAT-TS-GUARD Decision 3), then delete pin | compose lifecycle-guard suite green on TS; Python mutation refused with `guard_engine_owned` | re-pin (handoff is one-way; rollback = TS keeps serving) |
| 5 | compose default engine | default `"ts"`, python branch KEPT one release | full compose suite + soak-style probe | env override |
| 5b | compose `lib/stratum-mcp-client.js` — compose's OWN MCP client, spawns the `stratum-mcp` bin directly (`:4`, `:126`) and is instantiated by the production build path (`build.js:1118`); a THIRD seam missed until review round 3 | engine-selected spawn: TS stdio server bin (`ts/src/mcp/bin.mjs`) vs python, same flag as row 5 | batch-build golden flow spawns ZERO python processes (PATH-shim intercept, see acceptance) | flag flip |
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

Target: **one JSON data file INSIDE the npm package root** —
`ts/config/codex-models.json` (new; round-2 correction: a repo-root
`config/` would never ship in the published tarball, so global installs
would silently fall back forever) — `{ "default": "...", "allowlist":
[...], "stakes": {"cheap": "...", "default": "...", "paranoid": "..."},
"updated": "YYYY-MM-DD" }`, listed in the package `files`. The loader
resolves package-relative, overridable via `STRATUM_MODEL_CONFIG` (path)
for external installs whose config the forge cron does not manage; the
cron rewrites the source-checkout file (which IS the file our installs
use, since they run from the checkout).

Corrected by review (2026-07-11, CONFIRMED): the TS side has TWO separate
model seams today, and neither reads any config file —

- **Connector default**: `ts/src/connectors/codex.ts:22-24` reads
  `CODEX_MODEL` env with a hard-coded fallback. The JSON's `default`
  becomes that fallback (env still wins — precedence preserved).
- **Per-stakes judge routing**: `judged.ts:16-20` and
  `codex_judged.ts:32-43` use hard-coded `STAKES_MODEL` maps. The
  JSON's `stakes` object becomes the source, hard-coded map demoted to
  fallback-when-file-absent.

So D4 ships a small loader (`ts/src/judge/model_config.ts` (new), read
once, validated, cached) consumed by both seams, plus tests for: file
present, file absent (fallbacks), env override wins, malformed file
fails loud. The cron rewrites the JSON instead of the .py;
`codex_models.py` becomes a shim reading the JSON (keeps Python green
during overlap), deleted in Phase 5.

Rationale: data belongs in data files; the cron currently editing Python
source is the anomaly being retired, not a pattern to preserve.

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/config/codex-models.json` (new, stratum) | add | engine-neutral model allowlist + stakes routing (in package `files`) |
| `ts/src/judge/model_config.ts` (new, stratum) | add | loader (validated, cached, fail-loud) |
| `ts/src/judge/judged.ts`, `codex_judged.ts`, `ts/src/connectors/codex.ts` (existing) | modify | consume loader; hard-coded maps demoted to fallback |
| `src/stratum/judge/codex_models.py` (existing) | modify | shim over JSON until Phase 5 |
| `forge/scripts/model-pricing-refresh.sh` (existing, forge — not git) | modify | rewrite JSON |
| forge + compose `.mcp.json` (existing) | modify | TS server registration |
| compose `server/stratum-client.js` (existing) | modify | guard unpin; later default flip; later branch deletion |
| compose `lib/stratum-mcp-client.js` (existing) | modify | engine-selected MCP-server spawn (row 5b) |
| CLAUDE.md chain / skills (existing, various) | modify | instruction sweep |

## Acceptance criteria

- [ ] Inventory re-verified at execution start (grep sweep; new consumers
      since 2026-07-11 added to the table)
- [ ] Each row cut over in order, with its Verify step recorded in this doc
- [ ] `ts/config/codex-models.json` live governing BOTH seams (connector
      default + per-stakes judge routing); in package `files`;
      `STRATUM_MODEL_CONFIG` path override; loader tests: present /
      absent-fallback / env-override-wins / malformed-fails-loud; cron
      verified against the JSON
- [ ] Two-week TS-only clock start date recorded (gates STRAT-PY-REMOVE)
- [ ] Zero Python `stratum-mcp` spawns during the clock, proven by an
      INTERCEPTING seam, not sampling (round-4 finding: `ps` sampling
      misses short-lived children): a `stratum-mcp` PATH shim ahead of
      the real bin that logs AND fails every invocation during the
      golden flows and the two-week window; shim log empty at clock end,
      recorded here

## Open questions

- Does the TS stdio server registration (COMP-STRATUM-TS-2) land a
  `compose init`-managed entry or a hand-edited `.mcp.json`? Whichever
  ships, rows 1–2 use that mechanism — not a third one.
