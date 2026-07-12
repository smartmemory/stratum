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

### REVISED cutover strategy (owner, 2026-07-12 later — SUPERSEDES the fallback/incremental model above)

- **Python does NOT survive. No runtime fallback, no translation adapter, no dual-producer
  scaffolding.** Port the PRODUCER (compose) to speak the TS interface NATIVELY — do not build
  a Python↔TS translation shim (that would carry a dead dialect forever = pointless indirection).
- **Migration-branch workflow, atomic merge:** FREEZE the current known-good state (compose +
  stratum-python working together) on `main` in BOTH repos. Do the ENTIRE migration on a
  coordinated migration branch (`ts-cutover`) in each repo: port compose execution to TS-native,
  delete the Python execution path, v0→v1 specs, shared state root, de-hardcode Python-store
  reads. Dogfood LOCALLY until thoroughly tested. Then **merge both branches at once** = one clean
  replacement/upgrade. `main` staying on working-python IS the fallback until merge day.
- So there is NO incremental flip on main and NO permanent fallback flag. The "short real-usage
  window" happens as local dogfooding IN the branch, before the atomic merge. Baseline freeze:
  compose main @ 869a55b, stratum main @ (this commit).

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
3. [→PARKED] PORT distill → TS — **RE-CLASSIFIED to the deferred transcript-substrate unit
   (owner decision, 2026-07-12, session 70422c49).** Scoping found distill is NOT engine/flow
   code — it's transcript mining (~620 LOC distill core: detector/synthesize/runner/candidate)
   that drags in `postmortem.loader` (CC-transcript reader iter_sessions/Session/Event) + a
   sidecar writer, ~1000 LOC closure, none engine-related; the live path is deterministic (the
   synthesize LLM override is unused). It sits on the SAME transcript substrate as the parked
   transcript tools (read_centered/read_transcript_centered/blame_session) whose engine-module-vs-
   small-sibling-server home is UNDECIDED. Owner: group distill + those transcript tools as ONE
   deferred unit, decide their home together, port together in that phase. Python distill stays
   LIVE (no loss, port-before-delete). Was queue item 3; now in the PARKED transcript-substrate
   group below. NEXT = Phase 0/1 compose cutover (the higher-leverage retirement step).
4. [ ] **Phase 0/1 (compose): compose→TS cutover ← NEXT.** GATED (owner, 2026-07-12): dogfood
   internally before ANY flip; **compose must remain compatible** — that's the flip precondition.
   **SEAM TOPOLOGY MAPPED (codex 9bdf47b186e5, sol/high, evidence-backed; Opus adjudicated —
   split-brain CONFIRMED). The monitor-seam flip is NOT a coherent standalone step:**
   - compose has TWO seams: (a) `server/stratum-client.js` = CLI query/gate/guard (monitor reads +
     human gate), engine-selectable via `stratumEngine`; (b) `lib/stratum-mcp-client.js` = MCP-
     stdio client for build EXECUTION (plan/step_done/gate_resolve/audit), directly spawns
     `stratum-mcp` (Python), **NOT engine-aware** (build.js:1117 connect({cwd}) only).
   - `stratumEngine="ts"` switches ONLY seam (a) + a startup bin probe. Execution stays Python.
     Stores are SEPARATE (Python `~/.stratum/flows/`, TS `~/.stratum/ts/flows/`), so flipping the
     monitor alone makes TS query an EMPTY store → **blinds the monitor.** The existing soak
     (`scripts/stratum-ts-soak.mjs`) already knew this: it keeps the workspace on Python and seeds
     a SYNTHETIC TS flow — so the soak NEVER tested compose-on-TS execution.
   - Pointing the exec client at the TS MCP bin is necessary but **NOT sufficient — the TS MCP
     contract is WIRE-INCOMPATIBLE** with what compose sends: compose sends {spec, flow, inputs},
     flow_id/step_id/outcome, expects Python dispatch statuses (execute_step/await_gate); TS wants
     {spec, input, workspaceRoot}, runId/stepId/decision, returns ready/running/completed. TS MCP
     also LACKS tools compose uses (parallel/iteration).
   - **Minimum coherent cutover (5 items):** (1) execution on TS MCP; (2) shared STRATUM_STATE_ROOT
     for MCP+CLI; (3) an engine-aware **contract adapter** (request-field + response-status +
     ready-step translation); (4) convert compose v0 pipeline specs → TS v1 (= the TS-2 agent-
     authoring cutover); (5) remove hard-coded Python-store reads (`lib/flow-state.js:27` gate-round,
     `lib/build.js:5219` abort cleanup). Guard stays Python-pinned = a runtime dep, NOT a flow-store
     split (guard root `~/.stratum/guards/` is separate; nothing joins guard+flow state).
   - **Two contract-decisions the harness must EXPOSE (not normalize):** (i) terminal divergence —
     Python DELETES completed-flow persistence (server.py:948/2610), TS PERSISTS completed runs
     (engine.ts:639); decide if the compat contract is "completed flow disappears" vs "stays
     queryable". (ii) pre-existing Python coherence risk — MCP caches live flows in `_flows` while
     the CLI gate command mutates a separate disk copy (server.py:942/2578/5020); test CLI-gate-
     mutation → MCP-resume/advance, a shared dir is NOT proof of live-process coherence.
   - **Harness (owner chose "I build it"):** per-engine ISOLATED state root, run the same golden
     fixture (plan→gate→approve AND →revise→complete→audit) natively on each engine, diff the
     projections compose consumes (query flows/flow/gates + gate approve/revise; through
     stratum-client.js → StratumSync.readFlows → StratumPanel fields). CANNOT drive compose's exec
     client against TS yet (contract gap = the adapter's job). So the harness proves MONITOR/
     PROJECTION parity + quantifies the adapter's gap list; it is a diagnostic, not a flip green-light.
5. [ ] Phase 4 sweep (active surface): .mcp.json → TS stdio; forge+compose default → ts; keep the
       Python server registered ONLY for the parked tools; D4 codex_models relocation;
       CLAUDE.md/skills → TS for ported tools; retire soak cron.
6. [ ] Short TS-only-active-surface real-usage window.
7. [ ] Phase 5 (incremental): delete the Python for each PORTED tool once verified; final PyPI
       handling deferred until the PARKED set is also ported in its later phases.

### Parked-ports backlog (later phases, nothing lost)
P1. GOAL subsystem → TS.  P2. iteration kernel + skip_step + check_timeouts (IR timeout work).
P3. **transcript-substrate unit** = transcript tools (read_centered/read_transcript_centered/
    blame_session) + **distill** (grouped 2026-07-12): first decide the family's home (TS engine
    module vs small sibling server), then port together. distill needs a CC-transcript loader +
    sidecar writer; deterministic live path.  P4. draft_pipeline (WITH PipelineEditor UI phase).
P5. STRAT-TS-JUDGE-TOOL standalone + deltas.

## MCP-surface design review — CLOSED 2026-07-12 (owner-interactive; details in memory `project_ts_cutover_branch`)

Decisions: engine surface stays lean/frozen. Parallel = **Option C**: consumer-dispatch as a
first-class TS fanout mode (`dispatch: engine|consumer`) — key insight: TS is ALREADY client-
executed per step (ready[]/stepDone), so fanout items surface in ready[], per-item stepDone,
retries via attempts/ensure, consumer-merge = gate-after-fanout, capture_diff leaves the engine.
iterate/judged stay engine-native (3 iteration_* + stratum_judge tools dropped). Goal = a SPEC
authored from primitives, not a tool. Transcript/distill: 4 Python tools + distill skill retire
at merge; successor = **stratum's OWN provenance verbs (3-5, capability-gated) delegating to
SmartMemory as invisible backend** (encapsulation; Temporal-Visibility model; engine kernel never
depends on it) — post-cutover surface bump w/ own design doc. SmartMemory MCP = direct memory
customers only; its ~93-tool surface needs a diet (SmartMemory roadmap). One-product adoption.

### Control-plane audit — CLOSED 2026-07-12 (nothing blocks cutover)

Coverage strong: start/bg-start/cancel-bg/gates/retry-redrive(attempts+on_fail+revise+commit/
revert)/pause-via-gates/resume all ✓; **budgets (usd/tokens/dispatches/ms) + guard policy ledger
are DISTINCTIVE control surface most engines lack** (positioning point). Three gaps, all
post-cutover follow-ups, none built now: (1) **terminate-any-run** — kill exists only at gates +
bg; a dead-client foreground run can't be explicitly abandoned (matters more since TS persists
runs); (2) **retention/GC** — TS keeps all runs forever, no cleanup policy (Python deleted
completed); (3) **durable timers/signals** — no "wait 2h"/"wait for external event" IR construct;
gates cover human decisions, client-executed steps cover foreground events by architecture; treat
like goal = declared future primitive, add when a consumer arrives (gate-timeout auto-kill stays
parked per field survey).

## STRAT-TS-FANOUT-CONSUMER design — LANDED 2026-07-12

`docs/features/STRAT-TS-FANOUT-CONSUMER/design.md` committed to ts-cutover. Codex-drafted
(run `3ec04d14a05b`, sol/high), owner-adjudicated faithful to the locked Option-C skeleton.
D1 `dispatch: engine|consumer` (engine=byte-for-byte default); D2 scoped item id
`<fanout>/<index>` + per-item epoch (engine-side, no wire field); D3 existing attempts/ensure
own retry; D4 `require` settles once all items terminal (no early-any); D5 merge = explicit
downstream gate (`gate_resolve` approve/revise/kill), diffs never enter the engine. MCP surface
delta = only `flow_bg_poll.ready` + `bg.status: awaiting_consumer` (surface bump → P4/P5 count
fixes). Grounding verified locally: fanout root-only (`engine.ts:1673/1678`), subflow scoped-id
precedent, `step_done.stepId`/`gate_resolve.decision` are `string`, compose parallel call sites.

Review round: codex sol/high pool hit usage-limit (reset 15:53) → ran spark/xhigh instead
(run `ae5f10e0851b`). All 7 findings were the design-gate category error (reviewed the design as
shipped code: "current code doesn't already do X" for each proposed change). One exposed a real
ambiguity (#6 epoch-not-on-wire) → added one sentence clarifying engine-side epoch enforcement
mirroring ordinary steps' `expectedEpoch`. No decision changed. Design is CLEAN.

Next: the wire port — rewrite `compose/lib/stratum-mcp-client.js` request/response to TS-native
(keep method names), port build.js simple path → green `test/ts-cutover-golden.test.js`. Then
fanout consumer mode, then pipeline v0→v1, GSD, dogfood, atomic merge.

## Phase 0/1 (compose repo) — not started this session
## Phase 4 (sweep) / Phase 5 (remove) — not started
