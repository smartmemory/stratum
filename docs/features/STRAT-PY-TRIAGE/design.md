# STRAT-PY-TRIAGE — Disposition of the unported tool surface (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 3

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 3; decisions D2, D6)
- Siblings: STRAT-TS-GUARD / STRAT-TS-PARALLEL / STRAT-TS-ITER /
  STRAT-TS-FLOWCTL / STRAT-TS-JUDGE-TOOL designs (Phase 2 — the
  already-decided ports; this feature covers everything else)
- Downstream: STRAT-PY-SWEEP design (consumes the disposition table)

## Problem

15 Python MCP tools have no compose consumer. Porting all of them to TS is
waste; deleting all of them silently is data loss. Each needs an explicit,
evidence-based disposition before Phase 4 can sweep consumers and Phase 5
can delete the Python tree.

## Scope — the triage set

| Group | Tools | Prior (from memory/features) |
|---|---|---|
| Goal kernel | `stratum_goal`, `stratum_goal_status`, `stratum_goal_decide`, `stratum_goal_archive` | STRAT-GOAL loops via judge kernel; agent-session use only |
| Distill | `stratum_distill` | STRAT-DISTILL v1 shipped — transcript → staged-asset distiller |
| Authoring aids | `stratum_decompose`, `stratum_draft_pipeline`, `stratum_compile_speckit` | agent-session authoring helpers |
| Background flows | `stratum_flow_run_bg`, `stratum_flow_bg_poll`, `stratum_flow_cancel_bg` | STRAT-WORKFLOW-BG shipped; FANOUT-DYNAMIC deferred to TS |
| Workflow listing | `stratum_list_workflows` | pairs with the workflow epic |
| Transcript tools | `read_centered`, `read_transcript_centered`, `blame_session` | session ergonomics; used by stratum-learn-style flows |

Out of scope: everything compose consumes (Phase 2 ports, already decided)
and the flow kernel (already in TS).

## Design

### Evidence protocol (per tool, in order of authority)

1. **Session-transcript scan** — count real invocations across
   `~/.claude/projects/*/` transcripts for the last 60 days (the same
   corpus stratum-learn reads). A tool invoked in anger ≠ a tool listed in
   a skill file.
2. **Skill/docs references** — grep the CLAUDE.md chain, skills, and
   feature docs: does any *instruction* depend on the tool existing?
3. **Feature provenance** — the owning STRAT-* feature doc: was the tool a
   shipped deliverable with a recorded use case, or scaffolding?

### Decision rubric

| Evidence | Disposition |
|---|---|
| Invoked in anger recently AND workflow still current | **PORT** — file a `STRAT-TS-<name>` feature, sized from the Python LOC |
| Product value recorded but dormant | **PARK** — recorded entry condition ("revive when X"); Python code still deletes in Phase 5, the *feature* parks, not the code |
| No invocations, no instruction depends on it | **KILL** — `**KILLED (date): reason**` at the owning feature doc per provenance rules |

Two hard rules:
- A PARK is not a soft port: parked tools do NOT block Phase 5 deletion.
  Parking preserves the idea (design doc + entry condition), never the
  Python implementation — git history is the archive.
- Transcript tools are triaged as a *unit* and, if they survive, they move
  to a separate tiny server (session ergonomics is not engine surface —
  epic open question resolved here).

### Deliverable shape

A disposition table appended to THIS doc (tool, evidence summary with
counts, disposition, follow-up ref), plus:
- one filed feature per PORT survivor
- KILLED lines at owning feature docs for kills
- park records (entry conditions) for parks

## Files

| File | Action | Purpose |
|---|---|---|
| `docs/features/STRAT-PY-TRIAGE/design.md` (existing, this doc) | modify | disposition table appended |
| owning feature docs for kills (existing) | modify | KILLED provenance lines |
| `docs/features/STRAT-TS-<survivor>/` (new, per PORT) | add | filed port features |

## Acceptance criteria

- [ ] Transcript-scan evidence gathered for all 15 tools (counts recorded,
      corpus window stated)
- [ ] Every tool has a disposition row: PORT / PARK / KILL + evidence
- [ ] Every KILL has a KILLED provenance line at its owning feature doc
- [ ] Every PORT has a filed feature with LOC-based size estimate
- [ ] Every PARK has a recorded entry condition
- [ ] Transcript-tools unit decision recorded (engine vs separate server)
- [ ] STRAT-PY-SWEEP unblocked: no tool without a disposition

## Open questions

- None — the rubric is the design; outcomes are Phase 3 execution.
