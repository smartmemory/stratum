# stratum Roadmap

**Project:** stratum — compose-managed feature track ONLY. The canonical stratum roadmap lives in the forge-top ROADMAP.md and GitHub issues (stratum ROADMAP.md was retired in 0f3c711 — do not resurrect it). This file is generated from docs/features/*/feature.json by compose.
**Last updated:** 2026-07-18

---

<!-- preserved-section: roadmap-conventions -->
## Roadmap Conventions

- **Status:** `PLANNED` | `IN_PROGRESS` | `PARTIAL` | `COMPLETE` | `SUPERSEDED` | `PARKED`
- **Phases** are sequential. **Half-phases** (e.g. 1.5) are parallel tracks that surface between sequential phases.
- Items are numbered sequentially across all phases — never reuse a number.
- Cross-reference stable IDs (e.g. `FEAT-1`, `Phase 2`) not section headings.

<!-- /preserved-section -->

---

## Phase 1: Foundation — PLANNED

Bootstrap: establish the core structure and first working milestone.

| # | Item | Status |
|---|------|--------|
| 1 | Project setup — repo, dependencies, CI | PLANNED |
| 2 | Core domain model — data structures, storage | PLANNED |
| 3 | First working end-to-end flow | PLANNED |

---

## Phase 2: [Next Phase Name] — PLANNED

[Brief description of what this phase delivers and why it comes next.]

| # | Item | Status |
|---|------|--------|
| 4 | [Item description] | PLANNED |
| 5 | [Item description] | PLANNED |

---

<!-- preserved-section: dogfooding-milestones -->
## Dogfooding Milestones

| Milestone | Description | Status |
|-----------|-------------|--------|
| D0: Bootstrap | Manual, out-of-band. | PLANNED |
| D1: [First self-use milestone] | [Description] | PLANNED |
| D2: [Second self-use milestone] | [Description] | PLANNED |

<!-- /preserved-section -->

---

## STRAT-AGENT: Agent Surface — COMPLETE

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | STRAT-AGENT-BG-WRITE-1 | Workspace-write background agent mode (run/poll/cancel) + claude tool allowlists on the agent surface. Closes the two E3-probed capability gaps (gh #18): (1) bg agent runs are codex-only + read-only-only (background.ts:65/:68) and sync agent_run returns no runId so in-flight write items cannot be interrupted — GSD worktree consumer items fail post-hoc on timeout but the agent keeps mutating the worktree; (2) claude-family tool allowlists cannot be carried over the wire (availability restriction, not permission auto-approve), forcing compose's local-claude-connector workaround. Ask: agent_run background mode for workspace-write runs with runId + event streaming + death-confirmed cancellation, and tool allowlist/denylist params for claude agents. Compose-side wiring is a follow-on slice in the compose repo. | COMPLETE |

---

## Standalone Tickets — IN_PROGRESS

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | STRAT-LEARN-COST | Cost-aware learn loop: compose reports per-step usage (S0), stratum harvests + classifies cost waste (retry-waste/outlier/model-mismatch) into templated notes (S1/S2), and mirrors step_usage + cost_candidate events into SmartMemory via the policy outbox (S1b). Egress only — the learn author never reads SmartMemory. Extends STRAT-TS-LEARN. | COMPLETE |
