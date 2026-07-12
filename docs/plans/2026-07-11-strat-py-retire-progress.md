# STRAT-PY-RETIRE — execution ledger

Companion to `2026-07-11-strat-py-retire-roadmap.md`. Records what has actually been
done as the epic is driven, so a fresh session resumes losslessly. Newest at top of
each phase. Absolute SHAs / versions only.

## Owner directive (2026-07-12, session 70422c49)

- **Soak collapsed.** No other users besides the owner → the calendar soak (Phase 0's
  "7 PASS days ~07-18") is dropped. Cutover proceeds as soon as the work is done.
- **Deletion sequencing: cut over now, delete after a SHORT real-usage window.** Drive
  Phases 0–4 to make TS the sole engine (forge + compose), operate TS-only for real,
  THEN Phase 5 deletes Python. Deletion gated on "TS actually ran as the only engine and
  held," not a calendar. Keep the Python fallback until then (we found engine races in the
  flow-bg work on 2026-07-12, so do not discard the fallback the same stretch we cut over).

## Status snapshot (2026-07-12)

- stratum @ origin/main; TS v0.2.106 (STRAT-TS-FLOW-BG epic COMPLETE this session).
- Critical path to TS-only: 0 → 1 → 4 → 5; Phase 2 (guard done) + Phase 3 feed Phase 4.

## Phase 2 — TS parity (stratum repo)

- **stratum#6 (node ≥26 bin fix) — ✅ DONE + VERIFIED (2026-07-12).** Code fix already
  landed @ 494fa60 (`extraNodeFlags()` in `ts/src/cli/node-flags.mjs` gates
  `--experimental-transform-types` via `process.allowedNodeEnvironmentFlags`; erasable-only
  syntax means type *stripping*, default-on in node ≥24, suffices). Verified on homebrew
  **node 26.0.0**: CLI bin `--help` exits 0; MCP bin answers `initialize` with a valid
  JSON-RPC reply (serverInfo stratum-mcp). D5 Phase-2 entry gate CLEARED.
  - **Residual (non-blocking follow-up):** both bins emit `DEP0205` — `module.register()`
    is deprecated for `module.registerHooks()` (in `ts/src/cli/bootstrap.mjs`). Warning
    only today; a future node major may remove it. Track + fix before it becomes the next
    "#6". Node-22 pin wrapper (`~/bin/stratum-ts`) can be dropped once callers move.
- **STRAT-TS-GUARD — ✅ COMPLETE + PUSHED** (origin/main @ 25fb104, v0.2.97). 5 guard
  tools, cross-engine byte-parity + Python↔TS mutual-exclusion proven. Residual: compose
  `guardBin()` unpin → STRAT-PY-SWEEP row 4 (Phase 4).
- STRAT-TS-PARALLEL — ⏸️ PAUSED (dead-on-arrival; real path = STRAT-TS-PARALLEL-FANOUT post TS-2).
- STRAT-TS-ITER — NEEDS-WIRING (no live caller; engine auto-drives iterate). Confirm a
  consumer before porting the 3 tools.
- STRAT-TS-FLOWCTL — commit/revert KEEP, skip_step thin-KEEP, check_timeouts PARK.
- STRAT-TS-JUDGE-TOOL — ABSORB (judged: ensures over TS judge backend) + 2 deltas
  (budget-ledger wiring, evidence-bounding tests).

## Phase 2/3 usage audit — DONE 2026-07-12 (codex terra/high + Opus verification)

Evidence-backed dispositions (verified: KILL candidates have 0 non-doc/non-test refs;
"adapter-only" = a method on compose `lib/stratum-mcp-client.js` with NO caller of that
method anywhere — the wrapper existing ≠ the surface being live).

| tool(s) | live consumer | disposition | evidence |
|---|---|---|---|
| flow_run_bg / flow_bg_poll / flow_cancel_bg | already on TS | **KEEP (done)** | server.ts:24,76-78; mcp-surface v3 |
| compile_speckit | agent skill | **PORT or retire-with-skill** | stratum-speckit/SKILL.md:213,235 |
| distill | agent skill | **PORT or retire-with-skill** | distill/SKILL.md:20-23 |
| commit / revert | speckit skill (recovery) | **PORT or retire-with-skill** | stratum-speckit/SKILL.md:280 (adapter methods themselves uncalled) |
| skip_step | adapter-only, no caller | **thin KEEP or PARK** | client.js:307 only |
| iteration_start/report/abort | adapter-only, no caller | **NEEDS-WIRING / PARK** | client.js:330,344,359 only; engine auto-drives iterate |
| check_timeouts | none | **PARK** | 0 refs; no field precedent (roadmap) |
| goal / goal_decide / goal_status / goal_archive | none | **PARK** | 0 refs; dormant kernel |
| decompose | none | **KILL** | 0 non-doc/non-test refs |
| draft_pipeline | none | **KILL** | only a doc audit table |
| list_workflows | none | **KILL** | 0 refs |
| read_centered / read_transcript_centered / blame_session | none | **PARK (maybe separate small server)** | 0 refs; session-ergonomics, not engine |

**Owner decision RESOLVED (2026-07-12): KEEP the distill + speckit skills → PORT the 4 tools
to TS** (compile_speckit, distill, commit, revert). So Phase 2/3 disposition is final:
- **PORT to TS:** compile_speckit, distill, commit, revert (each a design→brief→codex-build→
  review-loop feature; commit/revert = STRAT-TS-FLOWCTL checkpoint slice, most foundational →
  do first; compile_speckit + distill are whole compilers/kernels → larger).
- **KILL (provenance in STRAT-PY-TRIAGE design.md):** decompose, draft_pipeline, list_workflows.
- **PARK (filed, no action):** goal kernel (4), iteration_* (3), skip_step, check_timeouts,
  transcript tools (3).
- **KEEP (done):** flow_run_bg / flow_bg_poll / flow_cancel_bg (already on TS).

### Remaining execution queue (ordered)
1. [x] PORT commit/revert → TS (STRAT-TS-FLOWCTL checkpoint slice) — **SHIPPED 2026-07-12**.
       Durable ordered `PersistedRun.checkpoints[]`, compile-time manifest coverage, bg + fanout
       quiescence guards, terminal-run recovery + post-completion revert (Python parity), MCP v4.
       2 codex review rounds, 5 findings fixed (see build-brief Review outcomes). See build commit.
2. [ ] PORT compile_speckit → TS.
3. [ ] PORT distill → TS.
4. [ ] Record KILL provenance (3 tools) + PARK filings in STRAT-PY-TRIAGE.
5. [ ] Phase 0/1 (compose): collapse soak, flip monitor-seam, agent-authoring cutover.
6. [ ] Phase 4 sweep: .mcp.json → TS stdio; forge+compose default → ts; drop python branch;
       D4 codex_models relocation; CLAUDE.md/skills → TS tools; retire soak cron.
7. [ ] Short TS-only real-usage window.
8. [ ] Phase 5: final PyPI deprecations, delete both Python trees, TS claims stratum-mcp bin.

## Phase 0/1 (compose repo) — not started this session
## Phase 4 (sweep) / Phase 5 (remove) — not started
