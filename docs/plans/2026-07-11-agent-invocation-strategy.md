# Agent Invocation Strategy — background execution, controller ownership, and what stratum should stop building

**Status:** DECIDED (2026-07-11, session 6aebbe19 continuation) · **Owner decision, recorded verbatim below**

## Related Documents

- Backward: [STRAT-CODEX-WRITE-DURABLE design](../features/STRAT-CODEX-WRITE-DURABLE/design.md) (slice 3+4 output sits UNCOMMITTED in the tree — see Instructions §1)
- Backward: [STRAT-AGENT-BG design](../features/STRAT-AGENT-BG/design.md) (BG-CLAUDE follow-up re-scoped by D2 here)
- Backward: [STRAT-WORKFLOW-BG](../features/STRAT-WORKFLOW-BG/) (the server-driven flow driver D3 composes on)
- Backward: [2026-07-09 codex write-mode design](2026-07-09-codex-write-mode-design.md)
- Evidence: [research artifacts](2026-07-11-agent-invocation-research/) — CONSOLIDATED map (5 haiku web researchers), codex sol/high local-verification feedback
- Sibling: [STRAT-PY-RETIRE roadmap](2026-07-11-strat-py-retire-roadmap.md) Phase 2 keep+wire (D3 is the strongest WIRE candidate)
- Forward: STRAT-FLOW-DETACH (design doc to be written — see Instructions §2)

## Problem

The user's top-priority blocker: **Claude Code cannot run stratum in background
or subagent mode** — every long agent dispatch (`stratum_agent_run`) and every
stratum flow holds the interactive session hostage.

## Research method (repeatable)

1. Five parallel haiku subagents did web research, one per invocation surface,
   every claim URL-cited → consolidated into `2026-07-11-agent-invocation-research/CONSOLIDATED.md`.
2. Codex (gpt-5.6-sol/high) then verified the consolidation **locally** against
   this machine's binaries and corrected it → `codex-feedback.md`. Several haiku
   claims were hallucinated; several of the orchestrator's from-memory claims were
   wrong. Lesson (hard-learned this session): **never assert invocation-surface
   facts from memory; the surfaces are moving monthly.**

## The validated invocation matrix (as of 2026-07-11; codex 0.144.0, claude 2.1.207)

| Layer | Claude | Codex |
|---|---|---|
| Embeddable SDK (in-process; parent must live) | `claude-agent-sdk` — subprocess over bundled CLI | `@openai/codex-sdk` (TS → `codex exec` JSONL) · `openai-codex` (Py → pinned local **app-server** JSON-RPC; pulls `openai-codex-cli-bin`) |
| CLI, synchronous one-shot | `claude -p` (`--output-format`, `--json-schema`, `--bare` all real) | `codex exec` (`--json`, `--output-schema`, `-o`, `--ephemeral` all real; `resume` accepts `--output-schema`) |
| CLI/daemon, LOCAL background | **ergonomic**: `claude --bg` + `claude agents [--json]` + `attach/logs/stop/rm`, `daemon status`; sessions stay idle-attachable after completion | **raw**: `codex app-server` daemon (experimental JSON-RPC threads/turns). NO submit-and-poll CLI. `codex exec-server` is NOT this — it's a connection-scoped subprocess executor, dies with the client |
| Hosted CLOUD background | Routines (`/schedule`, API fire endpoint, GitHub triggers; claude.ai sub) | `codex cloud` (`exec/status/list/diff/apply` exist today; `wait/logs/output` do NOT) + `codex apply` |
| MCP facade (ours) | `stratum_agent_run(type=claude)` — sync only | `stratum_agent_run(type=codex)` — durable bg read-only shipped; write+bg = WRITE-DURABLE |
| Orchestrator-native (inside Claude Code only) | Task/Agent subagents, background Bash + wake notifications, Workflow, SendMessage | `codex:codex-rescue`, or background Bash `codex exec` |

Key structural facts:
- Both SDKs are **in-process**; durability lives at the session/server layer, never in the SDK.
- Claude sessions resume by id from `~/.claude/projects/<cwd-hash>/<session-id>.jsonl`; codex threads resume by threadId via app-server.
- `--bg` sessions are persistent-attachable (idle after completion), machine-local, lost on shutdown. Worktree isolation is a SEPARATE `--worktree` flag, not automatic.

## The forest (what the per-tree fixes all miss)

Every candidate fix (WRITE-DURABLE slice 3, a claude-bg adapter, an app-server
client) makes **one agent dispatch** non-blocking. None fixes the actual hostage:
**the stratum flow driver is the interactive session.** `stratum_plan` →
controller executes → `stratum_step_done` → repeat; with every agent run
backgrounded, the pipeline still cannot advance without the session pumping it.

Evidence from this very session: the orchestration that worked was
harness-native (background Bash `codex exec` + completion wake; 5 parallel
research subagents; SendMessage collection). Stratum was not in the loop.

Meanwhile vendors are commoditizing supervision (claude `--bg`/agents/Routines;
codex app-server/cloud). Stratum's moat per VISION.md is **invisible spec rails
— plan/verify/judge/guard — not process supervision.** All supervision code
should be treated as replaceable adapters.

## Decisions

- **D1 — Ship STRAT-CODEX-WRITE-DURABLE slices 3+4.** Confirmed by codex's own
  adjudication as the right substrate for unblocked local WRITE builds: lowest
  latency, operates on the dirty local workspace (cloud can't), only option with
  the required write-safety (launch gate on persisted `(pid, start-time, pgid)`,
  identity-checked cancel, kill-on-controller-loss). exec-server rejected
  (connection-scoped, no durability); cloud is the remote-isolation alternative,
  not a replacement. Understood as a **stopgap we own until codex app-server
  matures** — keep it NARROW v1, no expansion.
- **D2 — STRAT-AGENT-BG-CLAUDE re-scoped: thin adapter, maybe never.** The filed
  approach (server-side asyncio task + stream tee — a hand-rolled supervisor) is
  dead. If a claude background run is ever needed from stratum, it is an adapter
  over `claude --bg` + `claude agents --json` (+ `terminate_verified` for cancel)
  — glue, not a feature. Do not build until a real consumer exists; inside a
  Claude Code session the harness's own subagent/background tooling already
  covers the need.
- **D3 — The real feature is STRAT-FLOW-DETACH: detached stratum pipelines.**
  Compose the STRAT-WORKFLOW-BG server-driven flow driver with background agent
  dispatch (codex via WRITE-DURABLE, claude per D2 if ever) so an entire stratum
  pipeline runs detached while the interactive session polls or gets a wake.
  This is what "run stratum in background/subagent mode" actually names, and it
  is simultaneously the strongest Phase-2 "keep + WIRE" move (wires iteration/
  judge/gates INTO a live flow instead of porting tools nobody calls).
- **D4 — Posture: never hand-roll what a vendor runtime ships.** Before building
  any supervision/lifecycle machinery, check the current `claude`/`codex` CLI
  surface first (they change monthly), and prefer wrapping it.

## Instructions to Opus (next session — execute in this order)

### §1 — Land WRITE-DURABLE slices 3+4 (the tree already contains the build)

The killed background build left a complete, UNVERIFIED, UNREVIEWED
implementation uncommitted in the working tree (~438 insertions):
`stratum-mcp/src/stratum_mcp/connectors/codex.py` (existing),
`stratum-mcp/src/stratum_mcp/server.py` (existing),
`stratum-mcp/tests/test_agent_run_bg.py` (existing, +180 lines),
`stratum-mcp/tests/test_codex_write_mode.py` (existing),
plus both design docs. **Do not discard; do not blind-trust.** Run the proven
build-loop from step 3 (VERIFY) onward:

- [ ] Verify locally: `cd stratum-mcp && /Users/ruze/miniconda3/bin/pytest tests/ -q -p no:cacheprovider` — baseline 1533 passed / 2 skipped; new tests must add to it
- [ ] Check the diff against the brief at the scratchpad path in the killed task, or re-derive from design.md acceptance criteria (launch gate fail-closed; controller-loss kills writers; startup sweep; read-only survival untouched; ParallelExecutor stays read-only)
- [ ] REVIEW: codex read-only, server-default model, background=true; adjudicate with code evidence; fix via spark
- [ ] Commit (controller commits; never stage `.DS_Store` or the flush file), push (expect one trailing version-bump commit)

### §2 — Design STRAT-FLOW-DETACH (do not implement yet)

- [ ] Write `docs/features/STRAT-FLOW-DETACH/design.md` (new): STRAT-WORKFLOW-BG driver + background agent dispatch composition; session polls via `stratum_flow_bg_poll`/wake; HITL gates surface to the session (the driver must PAUSE on gates, not auto-approve — richer gate taxonomy is `idea_richer_gate_decisions`)
- [ ] **Design constraint (distributability door-keeper):** all run lifecycle —
      cancel, liveness, poll — routes through the connector interface, and the
      run handle is OPAQUE (connector-defined dict). PID/`terminate_verified`
      becomes the LOCAL connector's implementation detail, never the driver's or
      server's vocabulary (today's leak: server.py:775 calls
      `terminate_verified(pid,…)` directly, bypassing the connector; a remote
      run has no pid). Driver talks to state through the store seam, not raw
      `~/.stratum` paths. Rationale: the semantic layer (spec IR, contracts,
      content-addressed cache, certificates) is already location-independent;
      keeping the driver loop free of `kill -0 <pid>`-shaped assumptions leaves
      the architecture one-connector-away from remote execution (codex cloud
      `exec/status/diff/apply`, Routines) instead of one-rewrite-away. Build no
      distributed anything in v1.
- [ ] Decide budget attribution for detached runs (the STRAT-AGENT-BG-BUDGET gap blocks bg debits today — server.py:496)
- [ ] Gate the design through the standard codex review loop before any build
- [ ] Check entry dependencies: does v1 need TS-engine flows, or is the Python driver (already shipped) the v1 substrate? Recommendation: Python driver now (it exists), TS parity later via the retire roadmap

### §3 — Record the descope at origin

- [ ] `docs/features/STRAT-AGENT-BG/design.md` follow-ups: annotate STRAT-AGENT-BG-CLAUDE with the D2 re-scope (done in this commit — verify it survived)

### Landmines (verified this session — do not relearn)

- `stratum_agent_run` MCP calls with a `context` param hit a pydantic "prompt missing" error — put everything in `prompt`.
- Codex reads the CONSOLIDATED map fine from an absolute file path; hand file paths, not pasted walls.
- `claude --bg` conflicts with `-p`; prompt is positional. Result retrieval is via session transcript jsonl, NOT `claude logs` (TTY-rendered ANSI).
- `codex exec-server` ≠ `codex app-server`. Don't confuse them again.
- Full-suite pre-push: the tree must be verified BEFORE pushing anything — pre-push runs the suite and will fail on the unverified slice 3/4 code if §1 wasn't done first.

## Provenance

Owner directives this doc encodes: "biggest priority… claude code mcp not being
able to run stratum in background or subagent mode"; "kill it till we finalize.
don't throw anything away yet"; "get info from cheap agents… consolidate then
get codex feedback"; forest-not-trees confirmation and "update the plans and
docs accordingly with instructions to opus" (2026-07-11).
