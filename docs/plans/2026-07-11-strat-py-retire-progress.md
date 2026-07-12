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

**Owner directive OVERRIDE (2026-07-12): DON'T LOSE ANYTHING — no kills.** These tools were
deliberately designed and built in Python; every capability is preserved. This SUPERSEDES the
KILL/PARK table above:
- **KILL is removed from this retirement.** decompose / draft_pipeline / list_workflows are NOT
  killed. (decompose is anyway part of the STRAT-GOAL subsystem, not a stray tool.)
- **"Park" no longer means "maybe delete."** It means "port LATER, lower priority." The Python
  code for anything not yet ported STAYS LIVE until its TS port exists.
- **Port-before-delete is the hard rule.** Phase 5 deletes a Python tool ONLY once its TS
  equivalent is verified. Nothing breaks in the interim because Python remains the fallback.
- So every tool is **PORT** (now or queued) or **KEEP (already on TS)**. Full surface → TS.

### PORT-NOW vs PARK split (owner: "figure out what to park; do it in phases; UIs are planned")

Rule: **PORT-NOW** = has a live consumer today (blocks the active-surface cutover). **PARK** =
no live consumer yet / gated on a not-yet-built UI → DEFER the port, keep the Python tool LIVE
(never deleted until ported), port it in the phase where its consumer/UI lands. Nothing killed.

**PORT-NOW (active surface — the near-term retirement):**
- [x] commit / revert (shipped), flow_run_bg / flow_bg_poll / flow_cancel_bg (KEEP, done).
- [ ] compile_speckit — live consumer: stratum-speckit skill.
- [ ] distill — live consumer: distill skill.

**PARK (defer; Python stays live; port when the trigger arrives):**
- STRAT-GOAL subsystem (decompose, goal, goal_decide, goal_status, goal_archive) — big worker→
  judge capability, 0 live consumers today. Trigger: a real goal-loop consumer, or a dedicated
  GOAL-on-TS phase. Preserved + live meanwhile.
- iteration kernel (start/report/abort) — no live caller; TS auto-drives `iterate`. Trigger: a
  manual-loop consumer.
- skip_step — no live caller. Trigger: a consumer appears (thin, quick port).
- check_timeouts — no consumer + needs IR gate `timeout` + `dispatchedAt` (STRAT-TS-FLOWCTL
  remainder). Trigger: a gate-timeout consumer.
- transcript tools (read_centered, read_transcript_centered, blame_session) — session ergonomics,
  no consumer. Trigger: decide engine-vs-small-sibling-server, then port.
- **draft_pipeline — PARK until the PipelineEditor UI phase.** The UI is PLANNED (owner confirmed),
  built in a later phase; port draft_pipeline alongside it. Python stays live till then.
- STRAT-TS-JUDGE-TOOL (standalone judge tool) — the `judged:` backend ALREADY works on TS; the
  standalone tool has no consumer. Trigger: a caller needs the tool form; close the 2 deltas then.

**Consequence for Phase 5:** deletion is INCREMENTAL and phased — delete each Python tool only
once its TS port is verified. Near-term Python shrinks to the PARKED set (a demoted, dormant-but-
live legacy surface); full Python deletion is a long horizon tied to the UI/consumer phases.
"TS-only for the active surface" is the near-term goal; "zero Python" is the eventual one.

### Near-term execution queue (ordered)
1. [x] PORT commit/revert → TS (STRAT-TS-FLOWCTL checkpoint slice) — **SHIPPED 2026-07-12** (v0.2.109).
2. [x] PORT compile_speckit → TS — **SHIPPED 2026-07-12** (session 70422c49). Brief:
   `docs/features/STRAT-TS-SPECKIT/build-brief.md`. RE-PORT to TS v1 IR (Python emits old IR the
   TS engine can't run). `ts/src/speckit/compiler.ts` (pure: parser/dep-graph/criterion/step-id/
   collision ported byte-for-byte from `task_compiler.py`; emits `do:` steps, structured ensures,
   shared strict `TaskResult{done, tests_pass?, lint_clean?}`, flow output = last sorted task).
   Tool `stratum_compile_speckit` (server.ts dispatch + surface 4→5, ok/error), 38 compiler tests
   incl. validateSpec round-trip. Codex WROTE (sol/high), 2 review rounds → REVIEW CLEAN.
   - **R1 findings (both CONFIRMED, Opus-fixed):** (High) `${...}` in task text → un-plannable IR
     returned as ok (TS reads `${}` in `do` as a reference; NO literal escape). (Med) flow_name
     "entry" overwrote the entry sentinel. FIX: `compileSpeckit` now `validateSpec`s the built
     spec before returning (same gate `stratum_plan` uses → guarantees plannability) → throws
     `compile_error`; `buildSpec` guards reserved `flow_name "entry"`. R2 CLEAN.
   - **Follow-up filed — stratum#8:** engine-level escape for literal `${}` in interpolated fields
     (restores Python pass-through of shell/template task text). Own feature, lower priority.
   - Gates: tsc + erasableSyntaxOnly clean; full suite 561 pass / 1 skip / 0 fail.
3. [ ] PORT distill → TS.
4. [ ] Phase 0/1 (compose): collapse soak, flip monitor-seam, agent-authoring cutover.
5. [ ] Phase 4 sweep (active surface): .mcp.json → TS stdio; forge+compose default → ts; keep the
       Python server registered ONLY for the parked tools; D4 codex_models relocation;
       CLAUDE.md/skills → TS for ported tools; retire soak cron.
6. [ ] Short TS-only-active-surface real-usage window.
7. [ ] Phase 5 (incremental): delete the Python for each PORTED tool once verified; final PyPI
       handling deferred until the PARKED set is also ported in its later phases.

### Parked-ports backlog (later phases, nothing lost)
P1. GOAL subsystem → TS.  P2. iteration kernel + skip_step + check_timeouts (IR timeout work).
P3. transcript tools (engine vs sibling server).  P4. draft_pipeline (WITH PipelineEditor UI phase).
P5. STRAT-TS-JUDGE-TOOL standalone + deltas.

## Phase 0/1 (compose repo) — not started this session
## Phase 4 (sweep) / Phase 5 (remove) — not started
