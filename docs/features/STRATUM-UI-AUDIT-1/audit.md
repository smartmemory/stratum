# STRATUM-UI-AUDIT-1: what a cockpit can show of Stratum today, and the gaps

Read-only audit, Opus (`hard:`), 2026-10-29, for s1-chat (owner: "audit stratum and cadence UI or
plans and figure out the gaps. make them able to be integrated into compose UI"). Paths are relative
to `/Users/ruze/reg/my/forge` unless they start with `~`. Siblings, not repeated here:
[COMPOSE-UI-AUDIT-1](../../../../compose/docs/features/COMPOSE-UI-AUDIT-1/audit.md) (Compose
screens), COMPOSE-UI-STEAL-1 (Orca), [CADENCE-UI-AUDIT-1](
/Users/ruze/reg/my/SmartMemory/cadence/docs/features/CADENCE-UI-AUDIT-1/audit.md). Integration:
[COMPOSE-UI-INTEGRATION-1](../../../../compose/docs/features/COMPOSE-UI-INTEGRATION-1/design.md).

## In plain English

Stratum has no screen of its own, by design: "Humans consume audits and gates"
(`stratum/docs/VISION.md:48`). Everything it knows is in JSON files under `~/.stratum/` and behind
MCP tools that only an agent can call. Compose already reads a thin slice of it (the list of flows
and the gates waiting for a human) and has buttons to approve gates, but the one screen that used
that slice is not mounted anywhere. **So the data a cockpit needs mostly exists on disk; what is
missing is a read command for each piece, not new bookkeeping.** The `stratum/app` folder looks like
a Stratum UI but is an old copy of the Compose app.

## Where the data lives today (verified 2026-10-29)

| Data | Store (producer) | Readers today |
|---|---|---|
| Flow runs: spec, steps, events, receipts, spend | `~/.stratum/ts/flows/<id>.json`, 517 files (`stratum/ts/src/engine/state.ts:318`) | `stratum query flows\|flow\|gates` (`stratum/ts/src/cli/query_gate.ts:164-205`); MCP `stratum_flow_poll`, `stratum_audit` (`stratum/ts/src/mcp/server.ts:319-321`) |
| Agent runs (Codex, Claude, Devin) | `~/.stratum/ts/agent_runs/<id>/{meta,peer}.json, stream.jsonl`, 3,048 dirs (`stratum/ts/src/connectors/background.ts:155`) | MCP `stratum_agent_poll`; Claude Code peer list via `~/.claude/sessions/<pid>.json` (`stratum/ts/src/connectors/peer-registry.ts:52`, STRAT-AGENT-PEER-1 COMPLETE) |
| Foreground agent registry | `~/.stratum/ts/agent_fg/`, 75 entries (`stratum/ts/src/connectors/foreground_registry.ts:16`) | none outside the engine |
| Guards (resource state machines) | `~/.stratum/guards/<hash>/` (`stratum/ts/src/guard/store.ts:62,82`) | MCP `stratum_guard_history`; Compose `guardList/guardHistory` wrappers (`compose/server/stratum-client.js:436-446`), no UI caller |
| Session door (pick, admit, launch, status, fleet, hop, jobs, policy) | wraps smart-memory-ops scripts (`stratum/ts/src/session/backend.ts:45`, `scripts-backend.ts`) | CLI `stratum session <verb> --json` (`stratum/ts/src/cli/session.ts`); no MCP tool |

Flow file shape (sampled `5dc37b92...json`): top keys `spec, status, flowSpent, steps, events,
receipts`; step `{status, attempts, spent, output, ...}`; event types `planned, ready, result,
gate_waiting, gate_resolved, usage_debit`; receipt `{seq, stepId, amount, usdSource,
budgetVerdict, at, ...}`. Agent-run `meta.json`: `runId, agent, model, cwd, sandboxMode, peerLabel,
createdAt, childPid, streamPath`.

## Gap table

| Capability | Designed where | State | Evidence | What a cockpit needs | Size |
|---|---|---|---|---|---|
| Flow list | `query_gate.ts:164-166` (CLI contract `_schema_version: "1"`) | WORKS | `projectFlow` gives id, name, status, current step, step count, completed, round (`query_gate.ts:79-95`); Compose `GET /api/stratum/flows` (`compose/server/stratum-api.js:33`) | reuse as is | - |
| Spec/plan view | none for humans | PARTIAL | spec is stored whole in the flow file; `query flow` exposes only `ordered_steps {id, function, mode}` (`query_gate.ts:195-205`) | steps with intent, ensure expressions, retries, `depends_on` | S |
| Step progress with postconditions | engine records per-step status/attempts and `cert_violations` (`engine/state.ts:105`) | PARTIAL | only MCP `stratum_flow_poll` (cursor) returns events; no CLI/HTTP reader; `projectFlow` reduces steps to a count | per-step state, attempts, last ensure failure text, spend | M |
| Gates (Stratum flow gates) | `query gates` + `gate approve\|reject\|revise` with `gate_token` (`query_gate.ts:168-193`) | WORKS (server) / STUB (UI) | Compose routes `stratum-api.js:45-67`, mounted only when `capabilities.stratum` (`compose/server/vision-server.js:280-296`); the only UI consumer `src/components/StratumPanel.jsx` is imported nowhere (`grep -rn "import.*StratumPanel" compose/src` = 0) | mount the panel or fold gates into the attention queue | S |
| Flows bound to Compose items | `compose/server/stratum-sync.js:51,168` | PARTIAL | sync only follows flows whose id is on a Compose item (`stratumFlowId`); flows started from Claude sessions (`stratum_plan`) are never shown | list all flows, bind when a feature code is known | S |
| Audit trace | MCP `stratum_audit` (`server.ts:319`) | MISSING (UI) | no `stratum query audit`; Compose never calls it | trace per run: steps, attempts, verdicts, receipts | S |
| Spend per flow | `flowSpent`, `receipts[]` in the flow file; MCP `stratum_usage_report` | PARTIAL | no CLI reader; Compose budget UI is for its own builds | per-flow $ and tokens, budget verdicts | S |
| Agent runs (Codex review/build) | STRAT-AGENT-VIS (`ROADMAP.md:74`, PLANNED); PEER-1/2/3 COMPLETE | PARTIAL | visible in Claude Code's `/agents` via the peer file; Compose has no reader of `agent_runs` (`grep -rn agent_runs compose/server compose/src` = 0) | list: agent, model, label, started, alive, exit, last stream line; link to its flow/unit | M |
| Background flows | STRAT-TS-FLOW-BG, STRAT-WORKFLOW-BG | WORKS (MCP) / MISSING (UI) | `stratum_flow_run_bg`, `stratum_flow_bg_poll` in `server.ts:64-67` | same row as flows, with a "detached" mark | S |
| Guard state | STRAT-GUARD, STRAT-TS-GUARD | PARTIAL | Compose wraps list/history (`stratum-client.js:436-446`), no route in `stratum-api.js`, no UI | per resource: state, last transition, overrides | S |
| Session front door | `stratum/docs/features/SESSION-MGMT-1/plan.md` (owner pick shape C; Compose Sessions screen "a later layer", `:1-3`) | PARTIAL | U1, U2 merged (`git log`: `25ffb3b`, `c3c289e`); U3 MCP tools and U11-U15 have 0 commits; no `stratum_session` in `stratum/ts/src` | `stratum session fleet\|status --json` is the contracted fleet reader (`SESSION-MGMT-1/session-contract.json`) | M (U3) |
| Event push | none | MISSING | Stratum has no HTTP server and no event feed; readers poll files or spawn the CLI (`stratum-sync.js:11-12,101`) | one `stratum query events --since <cursor>` over all flows and agent runs | M |
| Stratum-native UI | STRAT-AGENT-VIS discussion only | MISSING (by design) | `stratum/app/package.json` is named `compose`, `stratum/app/docs/ROADMAP.md` is Compose's 2026-02-26 roadmap | none: Compose is the UI | - |

## Top 3 gaps

1. **No reader for step detail.** Postconditions, attempts, ensure failures and spend are on disk
   but only MCP agents can read them (`stratum_flow_poll`, `stratum_audit`). Fix: extend
   `stratum query` (the CLI Compose already spawns) with `flow <id> --detail`, `audit <id>` and
   `events --since`, same `_schema_version` discipline. (M)
2. **Agent runs are invisible to Compose.** 3,048 run dirs, Codex reviews among them, no
   `stratum query agent-runs`. The peer file serves Claude Code, not Compose. (M)
3. **The existing gate UI is not mounted, and only Compose-bound flows are followed.**
   `StratumPanel.jsx` is orphaned; the routes and approve/revise buttons work server side. (S)

## Notes (not units, FILING BAR)

- `stratum/app/` is a stale copy of the Compose app (package `compose`, Feb roadmap). Note only;
  retiring it is the stratum lead's call.
- SESSION-MGMT-1 U3 (MCP session tools) is the only door piece a cockpit could also use; the CLI
  `--json` verbs already serve a reader, so the cockpit does not wait on U3.

## ELI5 TLDR

Stratum is like a flight recorder with no screen: it writes down every step, check and approval,
but only robots can read the tapes. **Almost everything the cockpit would show already exists in
its files; it just needs three more "read this out" commands.** The one screen Compose built for it
is switched off. Decision for the owner: whether the cockpit only watches Stratum, or also lets you
approve its gates (the buttons already exist server side).
