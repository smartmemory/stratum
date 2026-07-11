# STRAT-PY-RETIRE — Full Python Engine Retirement

**Status:** PLANNED (epic) · **Filed:** 2026-07-11

## Related Documents

- Backward: [STRAT-TS-PORT design](../features/STRAT-TS-PORT/design.md) (the port this retires toward), [VISION.md](../VISION.md) (TS port = standalone engine)
- Backward: compose [COMP-STRATUM-TS design](../../../compose/docs/features/COMP-STRATUM-TS/design.md) (v1 monitor-seam cutover + soak, Phase 0 here)
- Sibling: COMP-STRATUM-TS-2 (compose ROADMAP Phase 7 — agent-authoring cutover, Phase 1 here)
- Issue: smartmemory/stratum#6 (TS bins fail on node ≥ 26)

## Why

The TS port exists so the Python engine can be retired. STRAT-TS-PORT is
COMPLETE and COMP-STRATUM-TS v1 is soaking, but those cover only the flow
kernel + monitor seam. This roadmap fills in everything from there to
deleting the Python engine from the repo and deprecating it on PyPI.

## Ground truth (measured 2026-07-11)

- **Tool surface gap:** Python MCP server exposes **38** `stratum_*` tools
  (+3 transcript tools: `read_centered`, `read_transcript_centered`,
  `blame_session`). TS server exposes **10**: plan, validate, step_done,
  resume, gate_resolve, audit, agent_run, agent_poll, cancel_agent_run,
  flow_poll.
- **Used-but-unported** (grep of compose server/ + lib/, 2026-07-11):
  parallel kernel (`parallel_start/advance/poll/done`), iteration kernel
  (`iteration_start/report/abort`), guard subsystem (5 tools; compose
  `lifecycle-guard.js` is ENABLED and `guard*` is pinned Python in
  `stratum-client.js`), flow-control leftovers (`skip_step`, `revert`,
  `commit`, `check_timeouts`), `stratum_judge` as a standalone tool (TS has
  the judged-predicate *backend* — `ts/src/judge/*` incl. codex-OAuth — but
  does not expose the tool).
- **Unused by compose code** (agent-session-only or dormant — disposition
  needed, not automatic ports): goal kernel (4), `distill`, `decompose`,
  `draft_pipeline`, `compile_speckit`, `flow_bg_*` (3), `list_workflows`,
  transcript tools (3).
- **Python consumers:** ~15 compose files reference `stratum-mcp`/
  `stratum_mcp`; forge and compose `.mcp.json` register the Python
  `stratum-mcp` bin as the in-session MCP server; forge cron
  `model-pricing-refresh.sh` rewrites `src/stratum/judge/codex_models.py`
  (canonical codex model allowlist lives Python-side); CLAUDE.md chain +
  skills reference the MCP tools by name.
- **State stores are separate** between engines; no migration tooling exists.

## Decisions

- **D1 — Drain-and-cutover, no state migration.** In-flight Python flows
  finish on Python; new flows start on TS. No store converter is built
  (precedent: COMP-STRATUM-TS v1 decision 3 — divergences are omitted,
  never fabricated).
- **D2 — Usage-driven parity.** Port only what is used in anger. Everything
  else gets an explicit port / park / kill disposition with usage evidence
  (transcripts, compose greps). Kills get `**KILLED (date):** reason`
  provenance at the tool's origin.
- **D3 (corrected 2026-07-11) — Bin naming + npm distribution.** The TS
  package ALREADY declares both `stratum` and `stratum-mcp` bins
  (`ts/package.json:7-10`) — but the package is `private: true`, so
  nothing is claimed publicly and there is no installable replacement to
  point the PyPI deprecation notice at. The real Phase 5 gate is
  **publication**: un-private + version + publish `@smartmemory/stratum`
  to npm (or record an explicit local-only stance and word the
  deprecation notice accordingly). Until cutover, TS is invoked via
  absolute path / `COMPOSE_STRATUM_TS_BIN` only — the collision is
  avoided by non-installation, not by deferred declaration.
- **D4 — Codex model allowlist relocation.** `codex_models.py` (default +
  allowlist, monthly refresh cron) must move to an engine-neutral home (a
  data file the TS judge backend and the cron both read) before Phase 5 can
  delete the Python tree.
- **D5 — Node ≥ 26 packaging fix (stratum#6) is a Phase 2 entry gate.**
  Wide cutover cannot ride on a node-22-pinned wrapper.
- **D6 (revised 2026-07-11) — `stratum-py` retires WITH the engine.**
  Measured: of its 12,885 LOC, `judge/` (6,529) + `goal/` (2,352) are the
  implementation backbone of the Python MCP tools — `stratum-mcp` imports
  the judge kernel, postmortem, distill, inline_learn, goal
  orchestrator/worker, sandbox, and codex_models (all UNDECLARED deps).
  Their fate is already Phases 2–3: whatever tool ports to TS takes its
  kernel along; whatever is killed dies with it. Only the ~3,850-LOC
  decorator core (`@pipeline`/`@phase`/`stratum.run()`, pipeline_runner,
  hitl, budget) is a standalone authoring surface — and PyPI stats show no
  distinct audience (stratum-py and stratum-mcp downloads track each other
  ~1:1 daily/weekly/monthly = mirror/CI noise, not organic users). So no
  replacement authoring surface is built: YAML specs + MCP are the sole
  surface post-retirement. Phase 5 deprecates BOTH PyPI packages and
  deletes BOTH trees. In-code authoring returns later as filed follow-ups
  (STRAT-TS-AUTHOR / STRAT-PY-SDK below) — never retirement blockers.

## Phases

### Phase 0 — Monitor-seam cutover (COMP-STRATUM-TS v1) — IN_PROGRESS, tracked in compose

- [ ] Soak: 7 consecutive PASS days of the daily cron (~2026-07-18)
- [ ] Flip `capabilities.stratumEngine: "ts"` in compose `.compose/compose.json`

### Phase 1 — Agent-authoring cutover (COMP-STRATUM-TS-2) — PLANNED, tracked in compose

- [ ] Agents author v1 specs against the TS stdio MCP server
- [ ] `compose init` registers the TS stdio server (confronts the
      `stratum-mcp` bin collision per D3)
- [ ] PyPI deprecation notes drafted (land at Phase 5)

### Phase 2 — TS parity for the used surface — RE-SCOPED 2026-07-11 (stratum repo)

Entry gate: stratum#6 fixed (D5). Can start now; does not depend on Phase 0/1.

**RE-SCOPE NOTE (2026-07-11, session 6aebbe19).** Executing GUARD (done) then
PARALLEL surfaced that the original Phase-2 list conflated "a Python tool /
compose wrapper exists" with "the surface is live." A usage audit + a field
survey (deep-research, 26 sources, 23/25 claims verified — see memory
`project-strat-py-retire` and the survey report) corrected two things:

1. **Verify a real, non-redundant TS-engine caller before porting.** PARALLEL's
   consumer surface is architecturally dead-on-arrival on the TS engine (no
   `parallel_dispatch` step type by design; v1's parallel primitive is native
   `fanout`, reached by re-authoring). ITER/JUDGE/FLOWCTL have NO live caller in
   any consumer path (compose JS *or* agent skills) today.
2. **But the field validates these primitives as first-class — so KEEP + WIRE,
   don't kill.** iteration loops, LLM-as-judge, HITL gates, checkpoint, and
   parallel fan-out are all first-class in LangGraph / Temporal / OpenAI Agents
   SDK / Claude Code. Only `check_timeouts` (auto-kill an overdue human gate) has
   no field precedent → PARK. `skip_step` = thin keep.

- **STRAT-TS-GUARD** — ✅ **COMPLETE + PUSHED** (origin/main @ 25fb104, v0.2.97;
  7 slices, cross-engine byte-parity + Python↔TS mutual-exclusion proven).
  - [x] 5 guard tools on the TS server, contract-identical to Python
  - [x] guard golden flow passes on TS (register → transition → override → history)
  - [ ] compose guard* dispatches engine-selected (pin deleted) — deferred to
        STRAT-PY-SWEEP row 4 (compose `guardBin()` unpin)
- **STRAT-TS-PARALLEL** — ⏸️ **PAUSED after slices A+B** (committed+pushed @
  83e42c1). A = persisted parallel state + key-discriminated contract variants;
  B = non-pipeline evaluation core + certificate validator (reusable foundation).
  The 4-tool consumer-surface port is dead-on-arrival: v1's parallel primitive is
  native `fanout` (`migrate/check.ts:41`); compose must re-author `parallel_dispatch`
  → `fanout` to run on TS at all. See design.md PAUSE NOTE.
  - Real path (post TS-2): **STRAT-TS-PARALLEL-FANOUT** — fold STRAT-CERT-PAR
    certificates + slice-B require/bounce semantics into native fanout so a
    re-authored fanout is a full replacement. Pipeline mode → **STRAT-TS-PARALLEL-PIPELINE**.
- **STRAT-TS-ITER** — iteration kernel. **KEEP (field-validated first-class), but
  not a blind port.** No live caller today; the TS engine already auto-drives
  `iterate`. Real work = wire the manual loop into a real flow + decide auto vs
  manual need before porting the 3 tools. Reclassified PLANNED→NEEDS-WIRING.
  - [ ] Confirm a concrete consumer for the manual loop; port only if one exists
- **STRAT-TS-FLOWCTL** — split by the survey:
  - `commit` / `revert` — checkpoint is field-validated; KEEP. GAP: field prefers
    **non-destructive branching** over destructive revert → idea filed.
  - `skip_step` — thin dynamic-control affordance; KEEP if a consumer appears.
  - `check_timeouts` — ⛔ **PARK**: no field precedent for auto-killing an overdue
    human gate (Temporal pause/unpause analogue refuted 0-3).
- **STRAT-TS-JUDGE-TOOL** — **ABSORB, reaffirmed by the survey.** LLM-as-judge is
  first-class in the field, but the v1 engine expresses it via `judged:` ensures
  over the existing TS judge backend, not a standalone tool. Close the two deltas
  (budget-ledger wiring + evidence-bounding tests). GAP idea: richer gate-decision
  set (approve/edit/reject/respond) filed.
  - [ ] Design decision executed (absorb + deltas), capability-delta table recorded

### Phase 3 — Disposition of the remaining surface (STRAT-PY-TRIAGE) — PLANNED

For each tool with no compose consumer: port, park, or kill, with evidence.

- [ ] Usage audit (session transcripts + `rtk discover` history) for: goal
      kernel (4), `distill`, `decompose`, `draft_pipeline`,
      `compile_speckit`, `flow_bg_*` (3), `list_workflows`, transcript
      tools (3)
- [ ] Each tool has a recorded disposition; kills carry KILLED provenance
      at the owning feature doc
- [ ] Ported survivors covered by TS contract tests

### Phase 4 — Consumer cutover sweep (STRAT-PY-SWEEP) — PLANNED

Entry gate: Phases 0–3 complete.

- [ ] All `.mcp.json` registrations (forge, compose, any other workspace)
      point at the TS stdio server
- [ ] Forge workspace flips `stratumEngine: "ts"` (safe now: agent flows
      are TS, monitor sees the real store)
- [ ] compose default engine flips to `ts`; `python` dispatch branch
      removed from `stratum-client.js` after one release of overlap
- [ ] Codex model allowlist relocated per D4; `model-pricing-refresh.sh`
      cron updated and verified
- [ ] CLAUDE.md chain + skills reference only TS-served tools
- [ ] Soak cron (`stratum-ts-soak.mjs`) retired — real traffic is the signal now

### Phase 5 — Deprecate and remove (STRAT-PY-REMOVE) — PLANNED

Entry gate: Phase 4 complete + 2 weeks of TS-only operation with no
Python fallback used.

- [ ] Final `stratum-mcp` AND `stratum-py` PyPI releases with deprecation
      notices (notes from Phase 1); Trusted Publisher / token configs
      retired after
- [ ] `stratum-mcp` suite (1517 passed / 2 skipped) frozen at the removal
      SHA — recorded here, then deleted with the tree
- [ ] `stratum-mcp/` package AND `src/stratum/` (`stratum-py`) removed from
      the repo per D6 (git history preserves them; no archive branch
      needed)
- [ ] TS package claims the `stratum-mcp` bin name (D3)
- [ ] CHANGELOG + README updated in the removal commit

## Feature designs (all designed 2026-07-11)

- Phase 2: `docs/features/STRAT-TS-GUARD/design.md` ·
  `docs/features/STRAT-TS-PARALLEL/design.md` ·
  `docs/features/STRAT-TS-ITER/design.md` ·
  `docs/features/STRAT-TS-FLOWCTL/design.md` ·
  `docs/features/STRAT-TS-JUDGE-TOOL/design.md`
- Phase 3: `docs/features/STRAT-PY-TRIAGE/design.md`
- Phase 4: `docs/features/STRAT-PY-SWEEP/design.md`
- Phase 5: `docs/features/STRAT-PY-REMOVE/design.md`

## Follow-ups (filed 2026-07-11, PLANNED — post-retirement, not blockers)

Owner decision: retirement ships YAML-only; in-code authoring returns as
thin layers over the ONE TS core engine, both compiling to the same spec
IR the engine already executes.

- **STRAT-TS-AUTHOR** — programmatic pipeline-authoring API in TS
  (decorator-style definitions over `ts/src` core; MCP/CLI siblings, not
  parents). Rough size: 1–2 weeks. Entry gate: Phase 4 complete (one
  engine, stable IR).
- **STRAT-PY-SDK** — thin Python authoring package: decorator API that
  serializes to spec IR and drives the TS engine as a subprocess. Restores
  `@pipeline`/`@phase` ergonomics for Python users without resurrecting a
  Python engine. Rough size: 1–2 weeks. Entry gate: STRAT-TS-AUTHOR
  (IR-authoring seam proven once, then mirrored).
- **STRAT-TS-PARALLEL-FANOUT** — fold STRAT-CERT-PAR certificates + the
  STRAT-TS-PARALLEL slice-B require/bounce semantics into native `fanout` so a
  re-authored `parallel_dispatch` → `fanout` is a full replacement. Real path
  for the paused parallel port. Entry gate: TS-2 (compose re-authors to v1).
- **STRAT-TS-PARALLEL-PIPELINE** — pipeline-mode (`step_type: pipeline`)
  evaluation, only if a consumer ever needs it (none does today).
- **Gap ideas from the 2026-07-11 field survey** (filed in the ideabox):
  non-destructive branching over destructive `commit`/`revert`
  (`idea_nondestructive_branching`), and a richer gate-decision taxonomy
  approve/edit/reject/respond vs binary (`idea_richer_gate_decisions`).

## Sequencing

Phase 2 is parallel-safe with Phases 0–1 (different repo, additive). The
critical path is 0 → 1 → 4 → 5; guard (2) gates 4's "pin removed" item.
Phase 3 can run any time before 4.

## Open questions

- Does anything outside forge/compose consume the PyPI `stratum-mcp` or
  `stratum-py` packages? Recent stats (2026-07-11: ~2.2k and ~2.0k/month,
  moving ~1:1 = mirror noise) say no, but re-check before Phase 5 wording;
  a GitHub code search for `from stratum import` / `stratum_mcp` outside
  the org is cheap insurance.
- Transcript tools (`read_centered` etc.) are session-ergonomics, not
  engine — they may belong in a separate small server rather than the TS
  engine (Phase 3 decides).
