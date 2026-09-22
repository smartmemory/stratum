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
| 2 | STRAT-AGENT-PEER-1 | Register Codex background agent runs as Claude Code peer sessions so `stratum_agent_run(agent="codex", background=true)` shows in the parent session's ListAgents / /list-agents, flips busy→idle from the durable stream, and (Phase 2) serves the peer socket so the parent wakes on notify_idle instead of polling. Per-run detached sidecar owns the `~/.claude/sessions/<pid>.json` record, `.key` file and `/tmp/cc-socks/<pid>.sock`; version-allowlisted against the installed Claude Code, fails silent-but-logged on drift. Slice of forge STRAT-AGENT-VIS (filed 2026-09-09 in forge ROADMAP.md). | COMPLETE |
| 3 | STRAT-AGENT-PEER-2 | Register Claude background runs (worker threads inside the MCP server, `claude-bg-worker.ts`) as Claude Code peer sessions. Follow-up split out of STRAT-AGENT-PEER-1, whose per-run detached sidecar assumes a detached child process; claude bg runs live in-process and need their own owner decision (sidecar per worker, or one MCP-server row multiplexing runs). Also candidate home for a caller-supplied peer label (background runs cannot carry `flow`). | COMPLETE |

---

## Standalone Tickets — IN_PROGRESS

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | STRAT-LEARN-COST | Cost-aware learn loop: compose reports per-step usage (S0), stratum harvests + classifies cost waste (retry-waste/outlier/model-mismatch) into templated notes (S1/S2), and mirrors step_usage + cost_candidate events into SmartMemory via the policy outbox (S1b). Egress only — the learn author never reads SmartMemory. Extends STRAT-TS-LEARN. | COMPLETE |
| 2 | STRAT-USAGE-SPLIT | Input/output token split never reaches storage: connectors read it, collapse it into Budget.tokens, and compose files the aggregate as output_tokens. Populate the already-declared ReceiptRecord.split instead of widening BUDGET_KEYS. Unblocks STRAT-LEARN-COST §7 (cost classifier) and all context-cost measurement. | COMPLETE |
| 3 | STRAT-LEARN-COST-1 | Price-table freshness job (S4 transferred from COMP-COST-OWNER) + Claude connector stops emitting a labelled $0 when the SDK reported no cost | PLANNED |
| 4 | STRAT-AGENT-RUN-MODEL-VALIDATE | stratum_agent_run validates model/effort/agent against the runtime allowlist and fails fast naming valid values, instead of spending a dispatch to surface a vendor 400 | PLANNED |
| 5 | STRAT-STEPDONE-PROVENANCE-1 | Declare usdSource?/split? on stratum_step_done.request.result + replace legacy:&lt;seq&gt; placeholder with real dispatch ids on envelope settlement. Blocks compose COMP-COST-OWNER-1's exactly-once dispatch settlement. | COMPLETE |
| 6 | STRAT-USAGE-SPLIT-1 | A dispatch that fails before any usage event arrives records split {input:0, output:0} instead of no split, so compose files an unmeasured call as zero tokens (dispatch a31aac4a, 2026-09-19). Claude connector error path should omit split/usage when nothing was reported; compose consumer keeps null for unmeasured. | PLANNED |
| 7 | STRAT-DISTILL-APPLY | Graduate stratum_distill's reserved apply flag: write a staged skill-class AssetCandidate to the working tree through the memory-class apply machinery (admission critics, journal, guard-ledger commit, CAS revert, reconcile) generalized from ts/src/learn/apply.ts. Narrow v1: single asset, deterministic critics, default OFF. STRAT-ADMIT's LLM critics, batch admission and pool lock remain a follow-up. | IN_PROGRESS |

---

## Features — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| — | STRAT-AGENT-INTERP-TS | TS successor to STRAT-AGENT-INTERP, which shipped in the Python engine (4651933) and was retired at the TS cutover: the TS IR declares agent as a literal enum (ts/src/ir/schema.ts:41,65) and both step and fanout-stage dispatch emit it verbatim (engine.ts). Let a step's agent and a fanout stage's agent resolve from recorded flow state: `${input.executor}`, a router step's output, or per fanout item `${item.agent}`, validated to a known agent before dispatch. Stays in the data plane (recorded state only; replay identical). First consumer: cross-provider per-item routing in compose COMP-FABLE-ASTRA (one wave mixing claude and codex workers), which today needs two fanout stages. Not required for per-item TIER routing, which compose resolves itself from the recorded item (STRAT-LOOP-CARRY). Standalone Tickets M medium | PLANNED |
| — | STRAT-FLOW-CANCEL-FG | Foreground flow cancel addressable by flow id. Consumer fanout is rejected in background flows (engine.ts), so compose runs team builds as foreground flows; the only durable flow-cancel operation is flowCancelBg, and foreground agent cancellation needs the per-call cancellationId held by the MCP server that started the call (mcp/server.ts). A second process (compose build --abort opens a fresh client) therefore cannot cancel a running foreground build or its agents. Add a foreground cancel surface keyed by flow id: mark the run cancelling in the persisted record, propagate to in-flight agent runs through their recorded cancellation ids, refuse any consumer result or patch captured after the cancel mark, and settle the run as cancelled with an acknowledgement (0.4.0 acknowledged-cancellation semantics). Expose it on the CLI and MCP surface. First consumer: compose COMP-FABLE-ASTRA (D5) and the general compose build --abort defect. Standalone Tickets M high | COMPLETE |
| — | STRAT-LOOP-CARRY | Loop-carried flow value for revise loops. A fanout whose `over:` references a step downstream of it is a ROUTING_CYCLE (output references are dependency edges, ir/validate.ts), and a gate revise resets the target and every descendant, deleting their outputs (engine.ts resetFrom), so no preset can re-fan over a re-planned task list. Add a declared `carry:` block at flow level: each variable has an `initial` expression (materialised when its source step succeeds) and optional per-gate `on_revise` expressions. On a revise the engine evaluates the declared expression under the gate token BEFORE the reset, persists the new value with provenance (gate id, gate token, source epoch) in the run record, then resets; gates that declare nothing leave the value unchanged, so a merge retry re-fans over the same persisted list. `${wave}` is a flow-value reference, not a step reference, so it creates no dependency edge. Second, first-class requirement (not a nicety): expose the resolved fanout item on the consumer descriptor beside itemIndex, persisted with the run. Two compose consumers depend on it: files_owned enforcement at merge (COMP-FABLE-ASTRA D4) and per-item tier resolution (D6, Fable picks critical/standard/fast per task; the engine's agent field stays a per-stage literal, so provider does not vary per item). Resume, replay and audit read the value from the run record like any step input. First consumer: compose COMP-FABLE-ASTRA (D1). Reviewed shape: Codex sol/high 2026-09-09 confirmed evaluate-under-token, reset, persist-once preserves the existing invariants. Standalone Tickets M high | COMPLETE |

---

## STRAT-DISTILL: Skill Distillation — PLANNED

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | STRAT-DISTILL-TS-1 | STRAT-DISTILL (skill-candidate staging: detect recurring transcript workflows, stage draft SKILL.md/agent/command files) ported from the retired Python engine to ts/src/distill/. stratum_distill (MCP) + stratum distill extract\|top\|stats (CLI). Never auto-installs — staging only. | COMPLETE |
