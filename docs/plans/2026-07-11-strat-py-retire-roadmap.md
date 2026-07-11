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
- **D3 — Bin naming.** The TS package's `stratum-mcp` bin-name collision
  resolves itself at Phase 5: TS claims the name only after the Python
  package is deprecated. Until then TS is invoked as `stratum` /
  `COMPOSE_STRATUM_TS_BIN` only.
- **D4 — Codex model allowlist relocation.** `codex_models.py` (default +
  allowlist, monthly refresh cron) must move to an engine-neutral home (a
  data file the TS judge backend and the cron both read) before Phase 5 can
  delete the Python tree.
- **D5 — Node ≥ 26 packaging fix (stratum#6) is a Phase 2 entry gate.**
  Wide cutover cannot ride on a node-22-pinned wrapper.

## Phases

### Phase 0 — Monitor-seam cutover (COMP-STRATUM-TS v1) — IN_PROGRESS, tracked in compose

- [ ] Soak: 7 consecutive PASS days of the daily cron (~2026-07-18)
- [ ] Flip `capabilities.stratumEngine: "ts"` in compose `.compose/compose.json`

### Phase 1 — Agent-authoring cutover (COMP-STRATUM-TS-2) — PLANNED, tracked in compose

- [ ] Agents author v1 specs against the TS stdio MCP server
- [ ] `compose init` registers the TS stdio server (confronts the
      `stratum-mcp` bin collision per D3)
- [ ] PyPI deprecation notes drafted (land at Phase 5)

### Phase 2 — TS parity for the used surface — PLANNED (stratum repo)

Entry gate: stratum#6 fixed (D5). Can start now; does not depend on Phase 0/1.

- **STRAT-TS-GUARD** — port the guard subsystem (`guard_register`,
  `guard_transition`, `guard_override`, `guard_history`, `guard_migrate`).
  Largest chunk: STRAT-GUARD was never in the TS port scope. Exit: compose
  `stratum-client.js` guard pin removed; `lifecycle-guard.js` green on TS.
  - [ ] 5 guard tools on the TS server, contract-identical to Python
  - [ ] compose guard* dispatches engine-selected (pin deleted)
  - [ ] guard golden flow passes on TS (register → transition → override → history)
- **STRAT-TS-PARALLEL** — port the parallel kernel
  (`parallel_start/advance/poll/done`); compose batch builds depend on it.
  - [ ] 4 tools contract-identical; compose batch-build golden flow on TS
- **STRAT-TS-ITER** — port the iteration kernel
  (`iteration_start/report/abort`).
  - [ ] 3 tools contract-identical; compose iteration-loop tests on TS
- **STRAT-TS-FLOWCTL** — port `skip_step`, `revert`, `commit`,
  `check_timeouts`.
  - [ ] 4 tools contract-identical, covered by TS contract tests
- **STRAT-TS-JUDGE-TOOL** — expose `stratum_judge` as a TS server tool over
  the existing judged-predicate backend.
  - [ ] Tool exposed; parity with Python T1+T2 behavior

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

- [ ] Final `stratum-mcp` PyPI release with deprecation notice (notes from
      Phase 1); Trusted Publisher config retired after
- [ ] Python suite (1517 passed / 2 skipped) frozen at the removal SHA —
      recorded here, then deleted with the tree
- [ ] `stratum-mcp/` package + `src/stratum/` Python tree removed from the
      repo (git history preserves them; no archive branch needed)
- [ ] TS package claims the `stratum-mcp` bin name (D3)
- [ ] CHANGELOG + README updated in the removal commit

## Sequencing

Phase 2 is parallel-safe with Phases 0–1 (different repo, additive). The
critical path is 0 → 1 → 4 → 5; guard (2) gates 4's "pin removed" item.
Phase 3 can run any time before 4.

## Open questions

- Does anything outside forge/compose consume the PyPI `stratum-mcp`
  package? Check download stats / known installs before Phase 5 wording.
- Transcript tools (`read_centered` etc.) are session-ergonomics, not
  engine — they may belong in a separate small server rather than the TS
  engine (Phase 3 decides).
