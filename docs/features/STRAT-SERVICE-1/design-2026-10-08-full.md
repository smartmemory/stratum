**SUPERSEDED (2026-10-12):** owner chose the shrunk design; see design.md.

# STRAT-SERVICE-1 — Stratum as an always-on durable workflow service (design)

**Status:** DESIGN (Phase 1, Compose build). Stops at the design gate. No blueprint, no code.
**Shape (owner pick, 2026-10-08, via sm-coord):** **"workflow service"**, which is shape B in
`SmartMemory/scratch/2026-10-08-token-burn/shapes.md`. Shape A ("tune today's shape") and shape C ("everything is a ring-1
pipeline step") were the alternatives. The owner's framing: "we did envision stratum as a dynamic compilation, and dynamic
workflows fits that." Recorded here per `~/.claude/rules/shape-before-mapping.md` step 5.
**Owner requirement:** every major decision lists pros and cons. Each decision below has a "Pros / Cons" block and a
recommendation. Open owner decisions are collected in §12.

## Related Documents

- Vision anchor: [VISION.md](../../VISION.md) §"The original idea", lines 14-18. A typed spec compiles to Stratum, and the server tracks state and checks postconditions.
- Absorbs: [STRAT-FLOW-DETACH](../STRAT-FLOW-DETACH/design.md). That design is gated on "a real consumer for full detachment" (its lines 3-8). This feature is that consumer. See §11.
- Builds on (shipped): [STRAT-TS-FLOW-BG](../STRAT-TS-FLOW-BG/), [-OWNERSHIP](../STRAT-TS-FLOW-BG-OWNERSHIP/), [-REHYDRATE](../STRAT-TS-FLOW-BG-REHYDRATE/), [-SUBGATE](../STRAT-TS-FLOW-BG-SUBGATE/), [STRAT-AGENT-BG](../STRAT-AGENT-BG/design.md), [STRAT-AGENT-BG-MONITOR](../STRAT-AGENT-BG-MONITOR/design.md), [STRAT-AGENT-BG-WRITE-1](../STRAT-AGENT-BG-WRITE-1/design.md), [STRAT-CONFIG-MODELS-1](../STRAT-CONFIG-MODELS-1/design.md), STRAT-AGENT-PEER-1 (peer sidecar).
- Python-era siblings (retired engine; the ideas carry over, the code does not): [STRAT-WORKFLOW-BG](../STRAT-WORKFLOW-BG/), [-BUDGET](../STRAT-WORKFLOW-BUDGET/), [-BUDGET-DOLLARS](../STRAT-WORKFLOW-BUDGET-DOLLARS/), [-RESUME](../STRAT-WORKFLOW-RESUME/), [-PIPELINE*](../STRAT-WORKFLOW-PIPELINE/), [-IMPERATIVE](../STRAT-WORKFLOW-IMPERATIVE/).
- Dependency: STRAT-CLAUDE-SANDBOX (PLANNED, `docs/plans/COMPOSE-ROADMAP.md`). It enforces a sandbox for Claude agent runs.
- Prior art outside Stratum: ring-1 pipeline `SmartMemory/smart-memory-docs/docs/features/FULL-ALIGN-1/ring1-plan/pipeline/design.md` (§5 shifts, §7 ledger, §8 landing) and `shift-protocol.md`.
- Interactive transport: `SmartMemory/scratch/2026-10-08-chat-split/herdr-adoption-plan.md` and `herdr/report.md` (owner adopted herdr for interactive sessions, 2026-10-08). See §8.4.
- Evidence: `SmartMemory/scratch/2026-10-08-token-burn/{shapes.md,attribute.py}`, `~/.claude/rules/usage-watch.md`, `SmartMemory/scratch/2026-10-08-flush-while-busy/facts.md`, `SmartMemory/scratch/2026-10-08-coord-handoffs/{detach-test/RESULTS.md,detach-build/}`.
- Inventory notes: `forge/scratch/2026-10-08-strat-service/inventory-ring1.md`. The Stratum and scripts inventories are folded into §2 below.
- Forward: blueprint.md (not started; Phase 4 after this gate).

---

## 1. Problem, in one paragraph

Today every unit of agent work runs as a child of an interactive Claude session. A Stratum MCP server is a stdio child of
its session (`ts/src/mcp/server.ts:664-669`). Claude background agent runs are `worker_threads` Workers inside that MCP
process (`ts/src/connectors/background.ts:10,496`). In-session subagents are children too. All of them die when the session
exits (facts.md caveat 2). So sessions are kept alive just to hold their children, agents wait on tests while their cache
expires, and long tasks grow one agent to 774K context. Measured on 2026-10-08 over 24 h: about $2,680 API-equivalent. Opus
was 90% of that and subagents 57%. There were 92 cache re-writes of 100K+ tokens after idle gaps, more than half of all calls
ran above 200K context, and fresh sessions resumed at 160-255K.

**The service changes three things.** First, the work lives in a process that no session owns. Second, it is cut into typed,
short, stateless tasks. Third, no LLM ever waits: software waits and wakes one session once.

## 2. Prior-art inventory (read from disk 2026-10-08)

### 2.1 What Stratum already has (TS engine, `stratum/ts/src`)

| Mechanism | Where | Survives session exit? |
|---|---|---|
| Durable per-run state: one JSON file per run, atomic temp-write + rename | `engine/state.ts:318-328`, root `~/.stratum/ts/flows` | Yes (file) |
| Whole-flow background driver (`flowRunBg` / `flowBgPoll` / `flowCancelBg`, `driveBg`) | `engine/engine.ts:615,1138,1153,1484` | Driver no (in-process); state yes |
| Rehydrate on server start: re-drives every `bgDriven` run still `running`, after claiming a driver lease | `engine.ts:667-735`, called from `serveStdio` `mcp/server.ts:666` | Yes, but only when some session next starts an MCP server. At-least-once: an in-flight step can run twice |
| Driver lease and run lock: pid + process start time, stale owner by identity, "never by age" | `engine/run_lock.ts:104,332,407-451` | Yes |
| Sole-mutator lockout and epoch-bound dispatch (stale results refused) | STRAT-TS-FLOW-BG-OWNERSHIP | n/a |
| Background Codex/Devin runs: detached `sh` wrapper, `child.unref()`, JSONL stream, done sentinel | `connectors/background.ts:253-294,380`; Devin watchdog (15 min stall, 4 h max) `connectors/devin-watchdog.ts:6-7` | **Yes** |
| Background Claude runs | `worker_threads` Worker, `background.ts:494-498` | **No.** Dies with the MCP process |
| Per-run budget ledger (`usd`, `tokens`, `dispatches`, `ms`), `budget_exhausted` status, catalog pricing | `engine/ledger.ts:3,21`, `ir/schema.ts:8`, `judge/pricing.ts:45` | Per run only. No cross-run admission |
| Per-run event list + cursor poll; `watch --events` CLI for Claude Code's Monitor tool | `engine.ts:1130`, `contracts/events.json`, `cli/stratum.ts:37` | File-tailing, yes |
| Peer sidecar: a non-Claude process appears in `ListAgents` and answers `notify_when_idle` | `connectors/peer-sidecar.ts:301,532`, `peer-registry.ts` | Per agent run |
| Spec validation at plan / `flowRunBg` time | `ir/validate.ts:348` | n/a |
| Model catalog as data (models, tiers, prices) | `config/models.default.toml` | n/a |

**Gaps that matter here:**
- (G1) There is no always-on host. Rehydrate runs only when a session happens to start an MCP server.
- (G2) Claude background runs die with the MCP process.
- (G3) Consumer fanout is refused in background flows (`engine.ts:625`, "consumer fanout dispatch is not supported for background flows").
- (G4) The IR has a per-step `agent` but no per-step `model`/`effort` (`ir/schema.ts:42,66`). Ring-1 cited this when it rejected "a Stratum flow per lane" (ring-1 design.md:383-388).
- (G5) Scheduling is per flow. There is no queue across flows, no admission control, and no concurrency caps.
- (G6) There are no heartbeats. Liveness is process identity only.
- (G7) Events cannot reach a session that did not start the run.

### 2.2 Ring-1 pipeline (SmartMemory FULL-ALIGN-1)

Built and run from 2026-10-01 to 10-03, frozen since (ledger seq 1538). What it proves on this machine:
- An append-only JSONL ledger under `flock` with a monotonic `_seq` and a pure `fold()` projection works at 1.5K rows (`pipeline.py:299-377,709-818`).
- `claim_seq` works as a fencing token: stale writers are refused (`pipeline.py:756,1215`).
- A ready-set pull with WIP caps per piece, lane and global (`pipeline.py:1033-1074`, design.md:513-523).
- A journaled compare-and-swap landing with crash recovery, crash-injected at every boundary (design.md §8, `pipeline.py:1935-2025`).

What it lacked:
- Claims have **no TTL, lease or heartbeat**. A dead worker needed a human `released`.
- "No messages" left shift agents with **no way to be woken**. A shift stalled 75 min, and the workaround was foreground polling loops (`shift-protocol.md:77-83`).
- The protocol grew to 725 lines of exceptions.

### 2.3 Session stopgaps (`~/.claude/scripts`, SmartMemory scratch)

| Stopgap | Status (2026-10-08) | Fate under the service |
|---|---|---|
| `jobs.py`: per-session JSONL job registry (`jobs.py:29,59-84`), kinds `agent\|stratum\|bash\|tab` | Live, manual | **Replaced** by the service ledger. Keep a read shim, because `iterm_sessions.py:20,747` imports it |
| `detach_job.py`: `Popen(start_new_session=True)`, sh exit-wrapper writing `<label>.exit`, `RUNNING/STALLED/DONE/FAILED/FAILED-SILENT` (`staging/detach_job.py:136-145,214`) | Staged, 22 tests, Codex NOT CLEAN (3 blocking), fix round running | **Absorbed.** It becomes the worker launcher inside the service (§5.2). Its 3 blocking findings are launcher requirements |
| `auto_flush.py` + `auto_flush_loop.sh` (iTerm tab loop; the launchd plist is booted out because launchd osascript hangs on Automation consent) | Live, busy-tab flush paused | Loop **replaced** by the service as supervisor. `auto_flush.py` becomes a **service subscriber** (floor, good moment, cap from events) that types through the transport interface: herdr for lanes, AppleScript for sm-chat (§8.4). The service never runs osascript |
| `iterm_sessions.py` (`scan`, `launch`, `clear-unflush`, `self-reset`) | Live | **Kept as a client.** It is the only code that drives tabs |
| `flush-while-busy/fix-r1` (new-session handoff, `retire`) | Staged, 139 tests, awaiting review | **Kept as a client.** The service supplies the "retiring session's jobs are done" event that today needs PAPERWORK DONE |
| `disk_watchdog.py` (launchd, every 10 min) | Live | **Orthogonal.** It becomes an event *producer* (§9) |
| `dialog_scan.py` | Live | **Replaced** by herdr `blocked` state events for herdr-hosted sessions (§8.4) |
| `usage_watch.py` | Does not exist (find over `~/.claude/scripts`, SM scratch) | **Built as a service consumer** (§9) |
| `hook/subagent_context_cap.py` (warn 250K, stop at 300K) | Built, not installed | **Reused** as the context-budget enforcer for Claude workers (§4.3) |

### 2.4 Comparison: proposal vs existing mechanism, per design question

| Design question | Existing mechanism | Proposal | Verdict |
|---|---|---|---|
| Who owns running work | Session process tree (MCP child, Worker threads, subagents) | launchd-supervised `stratum serve` daemon; workers are detached processes | New host, existing engine |
| Durable state | `StateStore` per run + ring-1 ledger (separate, SM-only) | `StateStore` per run (kept) + one service event ledger (ring-1 model) | Extend |
| Crash resume | `rehydrateBgFlows` at MCP start | Same code, run at daemon start + re-adopt live worker pids | Reuse, move |
| Long-running agents | Background Codex detached; Claude in Worker | All workers are detached processes from one launcher | Replace Worker path |
| Unit of work | General-purpose agent with a big brief | Typed task from a catalog (packet in, report out, fixed model, budgets) | New |
| Graph authoring | Session writes v1 IR, or ring-1 `graph.json` (planning-time) | Session writes a short work order; deterministic compiler emits v1 IR | New compiler, existing IR |
| Validation | `validateSpec` | `validateSpec` + type-checked edges + admission check at submit | Extend |
| Claim / lease | Run driver lease (pid+start); ring-1 claim without TTL | Task lease = worker pid+start + heartbeat TTL + `attempt` fencing | Extend |
| Waiting on tests | Agent waits (cache expires) or polls | `gate-run` task type is software; completion is an event | New |
| Notifying sessions | Peer idle notice for the dispatching session only; lost after /clear | Durable per-subscriber inbox + one batched wake | New |
| Spend control | Per-run budget | Per-lane token buckets + vendor bulkheads + global kill switch | New |
| Fix loops | Human notices | Circuit breaker on fix rounds per step | New |
| Landing | Ring-1 CAS journal (SM 2.0 only) | Same pattern as the `land` task's software half | Port the pattern |
| Usage/disk watch | `attribute.py` by hand; `disk_watchdog.py` | Consumers/producers on the event stream | Extend |
| Interactive session state | Screen scraping (`dialog_scan.py`, auto-flush idle guards, 5-min tab reads) | herdr state events through a swappable transport interface (§8.4) | Replace |
| When to reset context | Flush thresholds + good-moment heuristics (fix-r1 addendum 6) | Workers: task boundary is the reset (per-task budget). Thin clients: addendum 6 kept, service answers "settled?" and writes the pointer resume (§8.3) | Replace for workers, extend for sessions |
| Durable execution infra | None (Temporal/RabbitMQ "not now", owner) | File ledger + leases + checkpoints (§7) | Build small |

## 3. D1 — Process model

**Proposal.** One per-user daemon, `stratum serve`, runs from a launchd LaunchAgent (`ai.smartmemory.stratum-service`,
`KeepAlive`, `RunAtLoad`) in the user's GUI domain. It hosts the existing TS engine and owns:
- the event ledger and projections;
- the scheduler (admission and ready-set);
- the worker launcher;
- the watchdog;
- the notifier.

It listens on a unix socket (`~/.stratum/service/sock`, mode 0600) with a small JSON-RPC API.

The per-session `stratum-mcp` stdio server becomes a **thin client**. When the daemon is reachable it forwards the
existing 26 tools plus the new service tools (§8). Every worker is a **detached** process (own process group,
`start_new_session`, stdin `/dev/null`, log to file) launched by the daemon. Workers outlive the daemon too.

**What survives what:**

| Event | Workers | Ledger/state | Subscriptions/inbox | Effect |
|---|---|---|---|---|
| Session `/clear`, `/exit`, tab close, crash | Survive (not session children) | Survive | Survive (keyed by subscriber *name*, not pid) | New session with the same name reads its inbox |
| Daemon crash / `launchctl kickstart` | Survive (detached) | Survive (fsync'd ledger) | Survive | On start: fold ledger → re-adopt live pids (pid + start time) → mark dead ones `FAILED-SILENT` → retry policy |
| Laptop sleep | Paused | n/a | n/a | Watchdog subtracts the sleep gap before judging stalls (§10) |
| Reboot | Die | Survive | Survive | Tasks re-queued by retry policy; nothing re-runs that already checkpointed |

**Pros**
- Jobs survive any session event. That is the core ask, and it removes "keep a retiring tab alive to hold children".
- One process owns scheduling, so caps and breakers are global and consistent.
- launchd gives restart-on-crash for free. It is already used for `disk_watchdog.py` and SM services.
- No new infrastructure. Node + files, same TS engine.

**Cons**
- launchd jobs don't inherit the shell environment. PATH, the sing-box proxy (`:8118`, see the proxy reference memory),
  `CODEX_*` and any `~/.keys` exports must be set in the plist or a wrapper script. That is a known source of "works in
  a tab, fails in launchd".
- Whether `claude -p` launched from launchd can read its OAuth credentials (macOS keychain) is **unverified**. It is
  P0 probe 1. If it fails, the fallback host is an iTerm-resident tab (as auto-flush does today), which loses
  crash-restart.
- A single daemon is a single point of failure for *new* dispatch. Running workers are unaffected.
- A version split is possible: the daemon runs one stratum build while sessions' MCP clients run another. Mitigation: the
  API carries a protocol version, and the client refuses a mismatch with a "restart the service" message.

**Alternatives considered**

| Option | Pros | Cons |
|---|---|---|
| (a) launchd daemon (**recommended**) | Crash restart, no tab needed, survives logout of tabs | Env/keychain risk (probe), new install step |
| (b) iTerm-tab-resident loop (`stratum serve` in a named tab) | Same env as interactive sessions; proven pattern (auto-flush) | Dies if the tab closes. No restart. One more tab to babysit |
| (c) Stay per-session, just detach everything (shape A+) | Smallest change | No global scheduler, no always-on rehydrate, no event wake. Fixes G2 only |

**Fallback when the daemon is down:** the thin client refuses `submit`, saying "service down: `stratum service start`".
It keeps today's in-process behaviour for the legacy foreground tools (`plan`, `step_done`, foreground `agent_run`), so
interactive Stratum use never breaks. This is owner decision O5.

## 4. D2 — Task type catalog and packet/report contracts

### 4.1 The catalog is data

Task types live in a shipped data file, `ts/src/config/task-types.default.toml`, in the style of `models.default.toml`
(STRAT-CONFIG-MODELS-1: changing a type is a one-file edit). Each type declares:

```toml
[types.author-step]
runner     = "claude"            # claude | codex | software
model      = "opus"              # resolved through models.default.toml tiers
effort     = "high"
tools      = ["Read","Edit","Write","Bash","Grep","Glob"]   # allowlist passed to the runner
sandbox    = "workspace-write"   # cwd = task worktree
context_budget_tokens = 300000   # enforced (§4.3)
wall_clock_s          = 3600
max_tool_wait_s       = 240      # no single tool call waits longer (cache-life rule)
packet     = "contracts/tasks/author-step.packet.json"
report     = "contracts/tasks/author-step.report.json"
disallowed = ["Agent"]          # every Claude worker type: no nested subagents (usage-watch.md, 2026-10-08)
permissions = "pre-granted"     # a headless worker can never wait on a prompt nobody can answer
retry      = { max_attempts = 2, on = ["FAILED-SILENT","STALLED"] }
cache_ttl  = "5m"
```

### 4.2 Initial types

| Type | Runner / model | Packet (input) | Report (output) | Context budget | Notes |
|---|---|---|---|---|---|
| `author-step` | Claude Opus/high | goal, allowed files, base SHA, worktree, acceptance checks, prior report ref | diff ref, commit-ready flag, tests touched, open questions | 300K | Never starts from history |
| `fix-round` | Claude Opus/high | review verdict (upheld findings only) + diff ref + allowed files | same as author-step + findings addressed map | 200K | Breaker counts these (§6) |
| `gate-run` | **software** | command set (by name from the repo's gate registry), SHA tuple, temp-dir budget | pass/fail, failing tests, log ref, duration, disk used | n/a | No LLM. `--basetemp` under task scratch, deleted on exit (testing.md disk rule) |
| `review` | Codex sol/high, fresh session, read-only | diff ref + brief + contract refs | ReviewResult (`compose/contracts/review-result.json`) | Codex limits | Never the author's vendor (routing rule) |
| `adjudicate` | Claude Sonnet | ReviewResult + diff stat + gate report | per-finding upheld/rejected with evidence line | 100K | Escalates to `diagnose` on "unclear" |
| `land` | software CAS + Sonnet only for the commit message | evidence SHA tuple, target ref | landed SHA or refusal reason | 50K | Ring-1 §8 journal pattern |
| `doc-flip` | Claude Sonnet | file list + exact status edits | diff ref | 80K | |
| `diagnose` | Claude Opus/high, time-boxed | failure report + repro command + relevant refs | root cause, evidence (≥2 commands), proposed next work order | 300K, 45 min | Output can *propose* graph expansion (§5.3) |
| `decide` | **a session**, not a worker | the question + options + evidence refs | the answer | session's own | How a judgment returns to a thin client (§8) |

**Pros of typed tasks**
- They cap the failure modes measured on 2026-10-08: context growth (budget), idle cache loss (no waiting), and fix loops
  (breaker).
- They make cost predictable per type, so admission control can price a graph before running it.
- Packets and reports are files, so any worker can die without losing anything (stateless workers).
- Routing rules (Opus authors, Codex reviews, Sonnet lands) move from prose in rule files into data, where they are enforced.

**Cons**
- Some work does not fit a type. Owner asks, infra hotfixes and Maya were the shape-C misfits. Mitigation: a general
  `task` type with an explicit budget, and the session can always do ad-hoc work itself outside the service.
- Packet discipline is real work per lane: someone writes the adapter that produces the packet. shapes.md estimated
  this as the bottleneck.
- A rigid context budget can cut off a task one step from done. Mitigation: at 85% of budget the worker is told to write a
  `continue` report, and the service chains a fresh task of the same type from it (a continuation, not a failure).

### 4.3 How budgets are enforced (software, not prose)

- **Context:** Claude workers run with `--settings` carrying the PostToolUse hook from `hook/subagent_context_cap.py`,
  adapted to headless (warn at 85%, demand a continue report at 100%). Codex workers get budget by packet size plus
  wall clock. There is no Codex context hook, so this is weaker.
- **Turns:** `claude -p --max-turns` (the flag exists in CLI 2.1.293; `strings` match on the binary, semantics unverified).
- **Wall clock:** the launcher kills the process group at `wall_clock_s`.
- **No waiting:** a worker that needs a long command does not run it. It ends with a report requesting a `gate-run`
  child, and the follow-on task resumes from that report (§6.4 saga).

## 5. D3 — Dynamic compilation: who writes the graph, and how it is validated

### 5.1 The work order

A session does not write v1 IR. It writes a **work order**: a token-cheap, typed description in the few-hundred-token
budget VISION.md asks for.

```yaml
order: SM-SCAN-4.step-12
lane: sm-scanner
budget: { usd: 40, wall_h: 3 }
use: step-pipeline            # macro from the library
with:
  goal: "Add retry to the scanner fetch loop"
  repo: smart-memory-core
  allowed_files: [smartmemory/scanner/fetch.py, tests/scanner/test_fetch.py]
  gates: [unit:scanner, lint]
```

A **deterministic compiler** in the daemon expands macros into a v1 IR flow. Each node gets a task type, model and budget
from the catalog. Edges are typed by packet/report schemas. The macro library starts with:
- `step-pipeline`: author → gate-run(fast) → review → adjudicate → [fix-round → gate-run → review]×≤2 (breaker) → gate-run(heavy) → land.
- `investigate`: diagnose → decide.
- `docs`: doc-flip → review-lite.
- `fan-out`: one macro per item, joined.

### 5.2 Validation at submit (fail closed, before any spend)

1. Schema: the work order parses, and the macro and types exist in the catalog.
2. Structure: `validateSpec` on the compiled IR. The DAG is acyclic, apart from the bounded fix loop, which compiles to a counted retry.
3. Edge type-check: every consumer's required packet fields are produced by some ancestor's report schema, or are given in `with:`.
4. Models: every resolved model is dispatchable (catalog, minus `[retired]`).
5. Scope: allowed files exist in the repo at the base SHA. Worktree paths fall under the lane's root.
6. Admission (§6.3): the estimated cost (task-type priors × node count) fits the lane's bucket and the order's `budget`. Otherwise the order is `held`, not rejected.
7. Idempotency: an order id that was already accepted returns the existing graph (no double submit).

The compiled flow is persisted next to the order, so a run is auditable and replayable from what was actually run.

### 5.3 Dynamic growth

Graphs can grow, but **no LLM worker mutates a graph.** A `diagnose` or `author-step` report may include
`proposed_orders: [...]`. Those become `decide` events for the lane's session, or are auto-accepted when a
deterministic rule allows it (for example, "a `gate-run` request from inside an author-step is always accepted"). The
accepted order is compiled and validated like any other.

**Pros**
- It matches the vision exactly: the model authors a short typed spec, software compiles, validates and runs it, and
  postconditions are checked.
- It answers ring-1's rejection of "Stratum flow per lane" (design.md:383-388). Per-step model comes from task types (G4).
  Ready-set pull comes from the service scheduler across flows (G5). Gates that need approval become `decide` events,
  not session pumping.
- Validation before spend: a malformed graph costs zero tokens.
- Macros carry the house process (author → other-vendor review → adjudicate → land) as code, so it cannot be skipped.

**Cons**
- A compiler and a macro library are new code to build and maintain. Macros can ossify process the owner later wants to change.
- Edge type-checking needs packet/report schemas written per type, which is up-front work.
- Two layers (work order → IR) make debugging one level deeper. Mitigation: `stratum service explain <order>` prints the
  compiled graph with types, models and budgets.

**Alternatives**

| Option | Pros | Cons |
|---|---|---|
| (a) Session writes full v1 IR | No compiler | Thousands of tokens per graph; models, budgets and routing chosen ad hoc by the LLM; easy to skip review |
| (b) Work order + deterministic compiler + macros (**recommended**) | Short, validated, enforces process | New compiler |
| (c) Fixed workflow templates only, parameters only | Simplest | Not "dynamic compilation". Every new shape needs a template release |

## 6. D4 — Distributed-systems patterns

Owner prompt: "distributed systems patterns" (shapes.md table). Each pattern: adopt now, later, or not at all.

| Pattern | Our version | Adopt | Pros | Cons |
|---|---|---|---|---|
| **Work queue + competing consumers with leases** | The scheduler is the only consumer and launches a worker per task. Lease = worker pid + process start time (the `run_lock.ts` identity rule) + heartbeat TTL. Fencing token = `(task_id, attempt)`: a report from a stale attempt is refused (the epoch-bound pattern from STRAT-TS-FLOW-BG-OWNERSHIP) | Now | Dead workers free their task automatically, the gap ring-1 left. Fencing makes at-least-once safe | Single host, so the "competing" part is degenerate today. Leases earn their keep only after a crash or for multi-host later |
| **Event sourcing on the ledger** | `~/.stratum/service/ledger/events-YYYYMMDD.jsonl`, flock + fsync, monotonic `_seq`, pure `fold()` into projections (task state, lane spend, subscriber inboxes), snapshot every N events | Now | Replayable truth. No "what happened?" turns. Ring-1 proved it here at 1.5K rows. Projections are cheap to read for thin clients | Fold cost grows. Mitigation: snapshots plus daily segments. Schema evolution needs a `v` field and upcasters |
| **Durable steps / saga** | Every task completion is a checkpoint event with its report ref. Retries rerun only the failed task (no-redundant-rework). `land` has a compensating action (CAS reset, ring-1 §8) | Now | A crash or failure never discards siblings. Long work is a chain of fresh tasks | Compensation exists only for `land`. Other side effects (pushes, deploys) are excluded from task types by design |
| **Heartbeats + watchdog** | The worker wrapper touches `<task>/heartbeat` every 30 s (wrapper side, not model side) and records log growth. The watchdog runs in the daemon: no heartbeat for 3 min means the process is dead; no log growth for 15 min (the `DETACH_JOB_STALL_SECONDS` 900 default) means STALLED. Then kill the process group, then apply the retry policy | Now | Zero LLM turns for liveness. Replaces the 5-minute human/LLM polling rule for service jobs | A wrapper heartbeat proves the process is alive, not that it is making progress. Log growth is a proxy and can be gamed by a chatty loop. The circuit breaker covers loops |
| **Pub/sub instead of messages** | Subscribers are *names* (`sm-scanner`, `sm-coord`), not pids. Events go to a durable inbox projection. Wake policy per event class: `decision-needed`, `order-done`, `order-failed` wake; progress never wakes. A coalescing window (60 s default) batches wakes | Now | One wake per meaningful moment. A cleared or replaced session still collects, because the inbox is durable | The wake channel is a Claude Code integration point (§8.2), the most version-fragile part |
| **Admission control / token buckets** | A per-lane bucket in API-equivalent USD per hour (priced via the catalog), plus a daily cap. A global bucket over all lanes. Over budget means the order is held and the coordinator gets one event | Now | Spend cannot run away. That was the measured failure ($405 in one hour) | Prices are estimates. Subscription quota is not dollars. The bucket is an approximation of the scarce resource |
| **Circuit breaker on fix rounds** | Per step: more than 2 `fix-round`s, or the same finding family upheld twice, opens the breaker. The step goes to `diagnose` and a `decide` event | Now | Stops review/fix ping-pong, which in the 2026-10-08 data cost a fresh 260-480K Opus agent per round | It may stop a loop that would have converged on round 3. Mitigation: the decide event offers "one more round" |
| **Supervisor tree** | launchd supervises the daemon. The daemon supervises workers with a per-type restart policy (transient: retry; permanent: fail plus event). Interactive sessions are *observed*, not owned: herdr state events give blocked, stalled and lost signals (§8.4). Restart and flush stay with client tools through the transport | Now (daemon/worker levels); observation of sessions via herdr | Defined crash behaviour at each level. Sessions get watchdog coverage | The service does not restart sessions itself. That is a client action through the transport |
| **Bulkheads** | Concurrency caps per lane, per vendor (Codex quota is separate and scarce), per model (Opus share), and global. Ring-1's caps are the defaults: lane 3, global 12, author runs 10 | Now | One lane cannot starve others. Vendor caps protect the scarcer quota | Caps need tuning. Too low serializes work the owner wants parallel |
| **Idempotency keys** | Order id and `(task_id, attempt)`. Report writes are keyed by them | Now | Double submits and double reports are harmless | None worth noting |
| **Backpressure from resources** | A disk-watchdog event below 100 GB closes admission for `gate-run`. Usage events close an over-budget lane | Now | Encodes the 2026-10-08 disk outage lesson in software | Needs the watchdog as an event producer (small change) |
| **Outbox / exactly-once delivery** | Not adopted. Delivery is at-least-once from the inbox, deduplicated by `_seq` at the client | No | Simpler | A session might see an event twice. The client dedups |
| **Multi-host workers (e.g. Hetzner)** | Not now. The lease and fencing design does not preclude it | Later | Leases already in place | Needs a network transport and auth |

### 6.1 Why no Temporal or RabbitMQ (owner: "not now")

The ledger provides Temporal's core guarantees at this scale:
- a durable event history (fsync'd JSONL);
- activity retries with heartbeats (watchdog plus retry policy);
- deterministic replay (fold);
- durable timers (deadline events checked by the daemon's tick).

The queue is a projection, so no broker is needed.

The scale supports this: one host, one writer (the daemon), and hundreds of tasks a day. Ring-1 ran 1,538 events in
three days on flock. **Revisit if any of these hold:**
- workers run on more than one machine;
- more than one writer process is needed;
- sustained throughput passes about 10 events/s;
- the owner wants a hosted UI for workflow history.

**Pros:** zero new infrastructure. Debuggable with `jq`. Reuses patterns proven on this machine.
**Cons:** we own correctness of the leases and fold. Temporal's years of edge-case handling (timer skew, replay
nondeterminism) are not free. Mitigation: crash-injection tests at every boundary, as ring-1 did (`crash_at`, `pipeline.py:438`).

## 7. D5 — Cache economics per task type

Prices from `attribute.py` (Opus: input $5, cache read $0.50, cache write 1h $10 per MTok; the 5-min write is 1.25x
input, so $6.25). Every call re-reads the whole context at the cache-read price. A cache write after expiry re-writes the
whole context.

| Type | Typical context | Idle gaps by construction | TTL | Reason |
|---|---|---|---|---|
| author-step, fix-round, diagnose | 50-300K, growing | None: no tool call waits more than 4 min (`max_tool_wait_s`); long commands become `gate-run` children | **5m** | The cache never expires mid-task, and a 5m write (1.25x) is cheaper than 1h (2x) |
| adjudicate, doc-flip, land | <100K | None | 5m | Short |
| review (Codex) | ≤ Codex window | n/a | Codex-side (cached input $0.10 at 0.05x) | Separate pricing |
| gate-run | 0 | n/a | n/a | Software |
| Thin-client session (`decide`) | Kept ≤ ~60K by design | **Long** (wakes rarely) | Session default (1h) | Each wake re-reads the session context. Keeping the session small and wakes batched is the lever, not the TTL |

**The arithmetic that motivates the shape** (an estimate from the price table above, not a measurement). One Opus call at
600K context reads $0.30 of cache. At 150K it reads $0.075. A 200-call author run growing to 774K averages about 400K,
so about $40 in reads. The same work as three chained 300K-capped tasks averages about 150K, so about $15. Add the 92
measured post-idle re-writes of 100K+ tokens at $6.25/MTok and more. Those disappear when no worker idles.

**Pros:** the dominant waste classes (growth, idle re-writes, chatty wakes) are removed structurally, not by discipline.
**Cons:** chaining has a fixed cost. Each fresh task pays a startup load (system prompt plus tool schemas; claude
sessions measured about 80-100K). A task type with a tiny job may cost more as a fresh process than inline. Mitigation:
headless workers run with a minimal `--settings` and no MCP servers they don't need (see the ToolSearch/deferral
reference: an explicit tools list without deferral once inlined 511K tokens). Measure the startup load in P0 probe 4.

## 8. D6 — Sessions as thin clients

### 8.1 Service tools (MCP, forwarded to the daemon)

- `stratum_submit(order)` returns the order id, the compiled graph summary and the estimated cost, or `held` with a reason.
- `stratum_inbox(since_seq?)` returns events for this subscriber, already summarized (≤2K tokens per wake).
- `stratum_decide(event_id, answer)` resolves a `decide` event, which unblocks the graph.
- `stratum_order_status(order)` returns the projection: one line per task.
- `stratum_subscribe(name, classes)` is idempotent. It runs on session start and in `/unflush`.
- `stratum_service(cmd)` covers `freeze | unfreeze | explain | top`. `freeze` is the global kill switch: no new dispatch, running tasks finish.

A lane session's loop becomes: wake → `stratum_inbox` → decide or submit → end turn. Resume files shrink to pointers:
the lane name and open order ids. Everything else is in the projection, which serves the ≤20K "packets, not
transcripts" target in shapes.md.

### 8.2 The wake channel (the version-fragile part)

The inbox file is the truth. The wake is only a nudge. Two candidate channels:

| Channel | How | Pros | Cons |
|---|---|---|---|
| (a) Peer-socket push | The daemon registers as a peer (`kind: daemon`) and writes a `{"type":"user",...}` frame to the subscriber session's socket (wire facts: STRAT-AGENT-PEER-1 research, verified on Claude Code 2.1.272) | Wakes a fully idle session with no arming. Stratum already speaks this protocol (`peer-sidecar.ts`) | Undocumented wire protocol. Verified on 2.1.272, now 2.1.293: re-probe (P0 probe 2). Cross-mode sessions may hold messages for approval |
| (b) Monitor-tool tail | The session arms Claude Code's Monitor tool on `stratum service watch --subscriber <name>`, which prints one line per wake-class event | Documented harness surface. Same shape as STRAT-AGENT-BG-MONITOR | The session must re-arm it after every /clear or handoff. A Monitor is a session child that dies with the session (fine: the inbox persists) |

| (c) herdr typed prompt (added after the owner adopted herdr, §8.4) | The daemon runs `herdr agent prompt <pane> "<one-line wake>"` only when herdr reports `idle`/`done` | Tested in the spike (20/20 state, refuses with `agent_blocked` on a dialog). No arming. Works on a fully idle session | Interactive sessions only (herdr-hosted). Pre-1.0 dependency. Each wake is a user turn |

**Recommendation (revised for herdr):** (c) for herdr-hosted interactive sessions, (b) for sessions outside herdr
(sm-chat never needs service wakes), and (a) only as a last resort. All three are idempotent against the inbox (dedup
by `_seq`). This is owner decision O6.

### 8.3 D6b — Context resets at a "good moment" (owner input, 2026-10-08 ~11:45, via sm-coord)

**Principle (owner).** A context reset is cheap only at a good moment, meaning the live state not yet on disk is small.
Approved for today's tooling (`SmartMemory/scratch/2026-10-08-coord-handoffs/fix-r1-addendum-6.md`):
- resume = packet (pointers, about 30K target);
- flush floor = the session's startup context + 100K;
- between the floor and the 250K hard cap, flush only when the tab is idle, every child job is registered, and the ledger is fresh.

In the service, **a task boundary is that good moment by construction.** Each typed task ends by writing its report.
Software, not the worker, assembles the next packet. So for workers, "flush" becomes "exit, and start the next task from
the packet".

**(1) Does a per-task context budget replace flush thresholds for workers? Yes.**
- Workers never flush. They end at a task boundary, and the only in-task reset is the 85%-of-budget `continue` report (§4.2).
- That reset is a good moment by construction. A worker has no children, because long commands become separate
  `gate-run` tasks. Its work product is already on disk: the diff in its worktree, the report file.
- The budget per type stays the hard cap (300K for author-step). Addendum 6's floor idea becomes a *sizing* rule for
  task types rather than a trigger: a type whose typical run ends below `startup + 100K` is a candidate to merge with a
  neighbour, because the fresh-process startup cost dominates (§7 cons).

Pros:
- One mechanism (task end) replaces three heuristics (threshold, idle check, freshness check) for the bulk of the spend.
- The reset can never interrupt a half-written state, since the boundary is defined by the report contract.

Cons:
- A task that is legitimately large pays one or more continuation hops, each with a startup load.
- The 85% `continue` report is written by the model under budget pressure. A poor one costs a re-read. The packet
  completeness checks below are the mitigation.

**(2) What a packet must hold so the next task never re-asks or redoes work.** A packet is built by the compiler from the
ledger projection plus the previous task's report. It is never the previous worker's memory. Required sections:

| Section | Holds | Why it prevents re-ask/rework |
|---|---|---|
| Identity | order id, task id, attempt, fencing token, task type | Stale-attempt refusal; joins receipts |
| Goal + acceptance | goal and acceptance checks **verbatim** from the order (never re-summarized) | No drift across hops |
| Scope | allowed files, base SHA tuple, worktree path | No re-discovery of where to work |
| Inputs by reference | report, diff, verdict and log refs (paths + hashes), not pasted text | Small packet; the worker reads only what it needs |
| **Decided** | every owner ruling, `decide` answer and adjudication touching this order, with event ids | The "do not re-ask" list. A question whose id is here is answered |
| **Done** | checkpointed tasks with output refs and the input hash each was keyed by | The "do not redo" list. A gate on an unchanged (SHA tuple, gate) is served from the checkpoint, never re-run (no-redundant-rework) |
| Open | unanswered questions with their route (which `decide` event, which subscriber) | The worker reports a blocked state instead of guessing or re-asking |
| Constraints | model, tools, remaining budget (tokens, $, wall clock) | No surprise budget kills |
| Next action | one sentence from the previous report, validated against the type's report schema | Fast start |

Target size: ≤10K tokens of packet itself. Referenced files are read on demand, which keeps it well under the owner's
30K resume target.

**Falsifiers, measured per task type in the receipts (§9):**
- **Re-ask rate:** the share of tasks whose report raises an open question that is already answered in the ledger,
  matched by question or `decide` id, or by text similarity above a threshold when the worker did not cite an id.
- **Rework rate:** the share of tasks that redo checkpointed work. For software tasks the checkpoint cache makes this
  structurally zero. For LLM tasks, `adjudicate` flags findings that re-raise an already-adjudicated finding family, and
  a 5% sample audit (the ring-1 sample-rerun practice) checks author diffs against the Done list.
- **Target:** under 5% for each per task type. Above that, the packet schema for that type is wrong and gets fixed, not the prompt.

Pros:
- The packet is assembled deterministically from the ledger, so completeness does not depend on a model remembering to
  write things down.
- The falsifier is a number per type, checkable from the receipts.

Cons:
- The "Decided" list can grow on a long order. It is filtered to rulings that touch this task's scope and refs, and that
  filter can miss a relevant ruling.
- Text-similarity matching for re-asks is noisy. It is a measurement aid, not a gate.

**(3) How long-lived thin clients (coordinator, lanes) still flush, and what the service contributes.** Thin clients keep
addendum 6's rules (floor = startup + 100K, good moment between floor and 250K, hard cap at 250K). The service makes two of
the three good-moment conditions deterministic and shrinks the resume.

- **The service can answer "is all of this session's service-side state on disk?"** It can do this because every job a thin
  client dispatches through the service is a ledger entry, so an unregistered child is impossible for service work. A
  query `stratum service state <subscriber>` returns:
  - `inbox_cursor` vs latest `_seq` (all wakes handled?);
  - open orders and their next deadline;
  - unanswered `decide` events, which are on disk and so do not block a flush;
  - the time of the subscriber's last ledger write.

  `settled: true` means the inbox is drained and no submit is in flight. That replaces addendum 6's conditions (b) and (c)
  (jobs.py vs live rows, and the freshness timer) for service work.
- **What the service cannot see:** in-context judgment the session has not yet written down, and non-service children
  (an in-session subagent or Bash job). Condition (a), tab idle with an empty prompt, and the context-size measurement stay
  with `auto_flush.py`, which reads the status-line state files. So the flush decision stays in the iTerm-resident
  client, and the service supplies the facts.
- **A natural good moment is signalled.** When a subscriber drains its inbox and submits its decisions, the service emits
  `subscriber-settled`. If the next deadline is far off, it also emits `idle-expected`, which is the "flush before a long
  idle" trigger from session-management.md. `auto_flush.py` subscribes to both and flushes when the session is also above
  its floor.
- **Service-generated resume packet.** `stratum service resume-packet <subscriber>` writes the pointer part of the resume:
  subscriber name, open orders, inbox cursor, pending decisions with refs, and recent rulings. It takes about 5-10K. The
  session's `/flush` adds only its unrecorded judgment notes, so the total stays under the 30K target with less for the
  model to write.

Pros:
- It moves "is it safe to reset?" from heuristics to a query over the ledger.
- Thin clients get smaller resumes and fewer conditions to check.
- Flush-before-idle gets a real signal instead of a guess.

Cons:
- It only covers state that went through the service. A session that also runs in-session subagents or does ad-hoc
  work still depends on jobs.py and addendum 6's checks.
- It adds a second integration between the service and auto_flush, a client that already carries a lot of guards.

### 8.4 D6c — Interactive sessions on herdr (owner input, 2026-10-08, via sm-coord)

**Owner decision on record.** herdr is adopted as the transport for *interactive* sessions: the coordinator and the lanes.
sm-chat stays in plain iTerm. Workers become service-run headless jobs with no terminal, so they have no herdr involvement.
Plan: `SmartMemory/scratch/2026-10-08-chat-split/herdr-adoption-plan.md`.

Spike evidence (`herdr/report.md`, herdr 0.8.2, verdict PARTIAL):
- state detection was 20/20 correct across idle, working, blocked and done;
- a permission or question dialog is reported as `blocked` within 0.3 s;
- `pane read`, `pane run` and `agent prompt` work, and `agent prompt` rejects with `agent_blocked` when a dialog is open;
- `agent prompt --wait` returns on completion;
- panes are children of the herdr server, so they survive the client tab closing, and reattach works.

Known gaps:
- a bare `agent wait` after a non-waiting prompt returns a stale `done`;
- `--timeout` is in milliseconds;
- a Claude session with a background shell reports `done`, not working;
- untested: herdr server restart, 20+ agents, and `/clear` typing through herdr.

**What the service does with it:**

1. **herdr state is an event source for interactive sessions, replacing screen polling.** A `herdr-bridge` adapter in the
   daemon watches the agent states of named interactive sessions and appends `session-state` events (`idle`, `working`,
   `blocked`, `done`, `unknown`) to the ledger. Debounced transitions only, never per-poll rows. That gives interactive
   sessions the same heartbeat + watchdog treatment workers get:
   - `blocked` raises a `session-blocked` event to sm-coord. This replaces `dialog_scan.py`'s one-minute screen scrape,
     and the coordinator's rule that no tab may sit blocked on a prompt gets a sub-second signal.
   - `working` with no ledger, transcript or log growth for N minutes raises `session-stalled`.
   - `unknown`, or a missing pane, raises `session-lost`.
2. **The wake channel for interactive sessions becomes herdr typing.** The daemon delivers a wake by
   `herdr agent prompt <pane> "<one-line wake: N events, see stratum_inbox>"`, only when the state is `idle` or `done`.
   `agent_blocked` and `working` defer delivery to the next transition. The wake is a one-line pointer, and the inbox
   stays the truth (§8.2). This adds option (c) to §8.2 and changes the recommendation there.
3. **Auto-flush becomes a service subscriber.** Its decision inputs come from events:
   - **floor** = startup context + 100K, from status-line state files (still outside herdr and the service; the service
     ingests them as `context-size` events);
   - **good moment** = herdr `idle` + `subscriber-settled` (§8.3; the service knows every service job is registered);
   - **hard cap** = 250K.

   The flush, `/clear` and `/unflush` keystrokes go through the herdr transport. Placement: auto-flush runs as a client
   process subscribed to the service, not inside the daemon. That keeps the "service never types into terminals" line
   with one exception, herdr wake prompts in (2), which go through the same transport interface. This is owner decision
   O10.
4. **herdr sits behind a swappable transport interface.** herdr is pre-1.0, has a single maintainer and an AGPL licence
   (unverified per the spike). The interface is the set the adoption plan already names (`state`, `read`, `type`, `wait`),
   plus `prompt` (typed with a busy/blocked refusal) and `list`. There are three implementations:
   - `herdr`: primary for interactive sessions;
   - `applescript`: today's `iterm_sessions.py`, kept for sm-chat and as the fallback until every lane has run a week on herdr;
   - `null`: headless, for tests and for workers, which have no terminal.

   The daemon pins the herdr version and fails closed on a mismatch at startup (adoption plan step 2), and the bridge
   degrades to `session-state: unknown` rather than guessing. Swapping transports is a config change. No event or
   subscriber changes, because events carry transport-neutral states.

Pros:
- Sub-second, verified state for interactive sessions with zero LLM turns. It replaces three screen-scraping loops
  (dialog scan, auto-flush idle detection, the coordinator's 5-minute tab reads).
- The wake channel uses a tested typed-prompt path that refuses when the session is busy, instead of the undocumented
  peer wire protocol.
- Interactive sessions get supervision (blocked, stalled, lost) without the service owning tabs.
- The interface limits the blast radius if herdr stalls or changes. Only the adapter changes.

Cons:
- It adds a dependency on a pre-1.0, single-maintainer tool at the most visible point (owner-facing sessions).
  Mitigation: pinned version, fail-closed check, AppleScript fallback, a health re-check when the service lands
  (adoption plan).
- herdr's `done` misreport with a background shell running means "idle" is not proof of no in-session children.
  `subscriber-settled` must still check jobs.py for non-service children (§8.3 cons).
- Typed wakes are user turns in the session's transcript. Each costs a full context re-read, so batching (§6
  coalescing) matters more here.
- herdr server restart behaviour is untested. If panes die with the server, the server becomes a single point of failure
  for every interactive session. It goes into P0 probe 5.

## 9. D7 — Observability

The event stream is the single source. Consumers:
- **Usage watcher** (new, replaces the hand-run `attribute.py` for service tasks). Each `task-finished` event carries the
  worker's usage. For Claude that comes from the `stream-json` result: input, cache read, cache write, output, model. For
  Codex it comes from the rollout. The watcher keeps rolling 1h/24h spend per lane, model and type, and emits
  `budget-warn` events at the usage-watch.md thresholds. Spend in interactive sessions stays with `attribute.py`, since the
  service cannot see it.
- **Disk watcher.** `disk_watchdog.py` keeps its launchd job and also appends a `disk-low` event to the service ledger,
  which closes `gate-run` admission.
- **`stratum service top`.** A live CLI view of running tasks, leases, heartbeats, lane buckets and breaker states. It reads
  only projections.
- **Per-task receipt.** Each task records model, tokens, estimated $, duration, peak context, attempts and exit class in its
  `task-finished` event. Joining receipts to orders gives cost per order, which ring-1 had to join by hand (`pilot_metrics.py`).
- **Coordinator check-in** becomes one command, `stratum service top --json`, next to `df`.

**Pros:** no separate metrics stack. Everything is replayable. Usage control becomes software (deterministic-first).
**Cons:** interactive-session spend stays outside the stream. Usage numbers are API-equivalent estimates, not plan quota.

## 10. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Daemon crash mid-graph | launchd restart | Fold ledger → re-adopt live workers by pid + start time → dead without exit file = `FAILED-SILENT` → retry policy. At-least-once, made safe by `(task, attempt)` fencing |
| Worker hang | No heartbeat 3 min / no log growth 15 min | Kill process group → retry once → breaker/`diagnose` |
| Worker exits 0 after an API 400 (Codex CLI) | Exit wrapper + log grep (`invalid_request_error\|Traceback\|429`), the detach_job `FAILED-SILENT` rule | Classify as failed, never as success |
| Report missing or schema-invalid | Report validated against the type schema at completion | Task fails. One retry with the validation error in the packet |
| Double dispatch after crash | Fencing token | Stale attempt's report refused. `land` is CAS, so a double land is impossible |
| Ledger torn tail (crash during write) | Fold fails closed on a torn last row (ring-1 rule) | `stratum service repair` truncates the torn row after backing up. Never a silent skip |
| Disk full | Write error / `disk-low` event | Admission closes. The daemon stops writing new events and logs to stderr. The 2026-10-08 outage also corrupted `~/.claude/sessions/*.json`, so the notifier must tolerate missing peers |
| Vendor auth expired / quota exhausted | Classified exit (not-logged-in, quota strings) | Vendor breaker opens, `vendor-unavailable` event to sm-coord (Codex quota: flag the owner at once, per routing rule). No silent vendor swap |
| launchd env drift (PATH, proxy, keys) | P0 probe + startup self-check (`claude --version`, `codex --version`, proxy reachability) | Daemon refuses to dispatch and emits `service-unhealthy` |
| Laptop sleep makes heartbeats look stale | Watchdog compares wall-clock and monotonic gaps | Leases are extended by the sleep gap. No kill on wake |
| Event storm (many small tasks finish) | Coalescing window | One wake per subscriber per window |
| Wake lost (session busy, gone, or in another permission mode) | Inbox unread | The next wake or `/unflush` reads the inbox. sm-coord gets an `unread-decision` event after a deadline |
| Runaway spend | Lane/global buckets | Hold + event. `stratum service freeze` as the manual kill switch |
| Claude worker writes outside its worktree | Not prevented for Claude today (ring-1 shift-protocol: Claude bg runs are not OS-sandboxed) | Pilot uses Codex for sensitive packets, or gate on STRAT-CLAUDE-SANDBOX (O4). Post-task diff-scope check against `allowed_files` fails the task |
| Compiler bug produces a wrong graph | `explain` + submit-time validation | Orders are replayable. Fix the compiler and resubmit. Checkpointed tasks are reused when inputs match |
| Version skew (daemon vs MCP client) | Protocol version handshake | Client refuses with "restart service" |
| herdr version mismatch / herdr server down | Startup version pin check; bridge sees no server | Fail closed for herdr: sessions report `unknown`, wakes fall back to Monitor or inbox-on-next-turn, sm-coord gets `transport-degraded`. No guessing |
| herdr `done` while a background shell runs | Known misreport (spike) | `subscriber-settled` still checks jobs.py for non-service children before a flush |
| Detached Claude worker spawns its own subagent or stalls on a permission prompt (measured 2026-10-08, usage-watch.md: $53, 303K, no report) | Watchdog stall + no report | Prevented by the type defaults: `disallowedTools: ["Agent"]` and pre-granted permissions for every Claude worker type |

## 11. Migration in slices (each slice is useful alone)

| Slice | Delivers | Replaces | Size |
|---|---|---|---|
| **S0 P0 probes** (no product code) | 1: `claude -p` and `codex exec` from a launchd LaunchAgent (auth, proxy, PATH). 2: peer-socket user-frame wake into an idle 2.1.293 session, and Monitor-tail wake. 3: detached worker survives daemon kill and is re-adopted by pid + start time. 4: startup load of a minimal headless worker (tokens). 5: herdr server restart, whether hosted panes survive, and `/clear` + `/unflush` typing through herdr | — | ½ day |
| **S1 Host** | `stratum serve` under launchd, socket API, the MCP thin client forwarding existing tools, rehydrate at daemon start (G1). Claude background runs become detached processes (G2) | Worker-thread path; "keep the retiring tab alive" | 1-2 days |
| **S2 Ledger + inbox + wake** | Service event ledger, fold, subscriber inbox, `stratum_inbox` / `subscribe`, Monitor-tail wake (+ peer push) | `jobs.py` (shim kept); 5-min LLM polling of service jobs | 1-2 days |
| **S3 Workers** | Launcher (detach_job design + its 3 blocking fixes), heartbeat, watchdog, retry policy, report validation, task-type catalog with the 9 types, context-cap hook for headless | `detach_job.py` (staged) | 2 days |
| **S4 Compiler + control** | Work-order compiler, macro library (`step-pipeline`, `investigate`, `docs`, `fan-out`), per-step model in IR (G4), background fanout (G3), admission buckets, bulkheads, breaker, `freeze` | STRAT-FLOW-DETACH (absorbed) | 2-3 days |
| **S5 Live pilot, one lane** | One lane runs only through the service for 2 working days. Compare $/landed step, context p50/p95, idle re-writes and wakes per hour against the 2026-10-08 baseline (`attribute.py`) | — | 2 days elapsed |
| **S6 Broaden + retire stopgaps** | Remaining lanes. Usage watcher. Disk events. herdr bridge (state events, typed wakes) and auto-flush as a subscriber. Retire the worker-tab path and the worker-tab caps in session-management.md (adoption plan "when B lands") | `auto_flush_loop.sh` loop, `dialog_scan.py`, worker tabs | 2-3 days |

**Pilot lane (O3).** Recommended: a lane whose work is already step-shaped (author → review → gate → land) and not
security-sensitive, so Claude workers without an OS sandbox are acceptable for the pilot. Pass criteria:
- cost per landed step down at least 40% against baseline;
- no task above its context budget;
- zero post-idle re-writes in workers;
- zero lost jobs across at least one session handoff and one forced daemon restart;
- re-ask and rework rates under 5% per task type (§8.3).

**Absorb STRAT-FLOW-DETACH.** Its open question was "is there a real consumer for full detachment?" This feature is it.
Its remaining technical work (autonomous handling of handoff kinds; TS background fanout) lands in S4. On approval of this
design, STRAT-FLOW-DETACH gets `SUPERSEDED by STRAT-SERVICE-1` at its origin.

**Pros of this order:** S1 alone fixes the most expensive measured symptom: retiring tabs kept alive for their children,
the top 5 spenders in the 11:24 hour. Each slice can stop without stranding the previous one.
**Cons:** S1-S3 deliver infrastructure before the token savings of typed tasks (S4/S5) show up. The pilot is the first
real proof, about a week in.

## 12. Open owner decisions

| # | Decision | Recommendation | Why |
|---|---|---|---|
| O1 | Host: launchd daemon vs iTerm-tab-resident loop | launchd, if P0 probe 1 passes; tab otherwise | Crash restart; no tab to babysit |
| O2 | Graph authority: compile to Stratum IR on the TS engine vs a new ring-1-style scheduler | TS engine + service scheduler | Reuses rehydrate, leases, budget, ensure. Closes ring-1's three rejection reasons (§5.3) |
| O3 | Pilot lane | A step-shaped, non-security lane (sm-coord to name) | Clean measurement; acceptable sandbox risk |
| O4 | Claude workers before STRAT-CLAUDE-SANDBOX ships | Allowed in the pilot for non-sensitive packets, with the post-task diff-scope check; sensitive packets stay Codex | Today's Claude bg runs carry the same risk |
| O5 | Daemon down: thin client falls back to in-process legacy tools vs fails closed | Legacy tools fall back, `submit` fails closed | Interactive Stratum never breaks; the service is never silently bypassed |
| O6 | Wake channel | herdr typed prompt for herdr-hosted sessions; Monitor tail elsewhere; peer push last resort | Tested path that refuses when busy (§8.2, §8.4) |
| O10 | Where auto-flush runs once it is a service subscriber: separate client process (typing via the transport) vs inside the daemon | Separate client | Keeps the daemon from typing into sessions, apart from one-line wakes |
| O7 | Scope: one service for all of `~/reg` vs one per workspace | One per user, lanes namespaced by workspace | Global caps only work with one scheduler |
| O9 | Thin-client resume: service writes the pointer packet and `/flush` adds only judgment notes, vs `/flush` writes it all as today | Service-written pointers | Deterministic, smaller (~5-10K), cannot forget an open order |
| O8 | Spend unit for admission: API-equivalent USD vs plan-quota percent | USD now (computable from the catalog); quota percent when a reliable source exists | No machine-readable quota feed today (unverified) |

## 13. Non-goals

- No hosted UI. The compose cockpit can read projections later.
- No multi-host workers in v1.
- The service never runs osascript or drives iTerm tabs. Its only terminal action is a one-line herdr wake prompt through the transport interface (§8.4). Flush, clear and restart stay with client tools.
- It does not replace interactive sessions for judgment. `decide` stays with people and sessions.
- No pushes or deploys inside task types. Those stay coordinator or owner actions.
- No Temporal or RabbitMQ (§6.1).

## 14. Assumptions to prove (spikes as roadmap tasks)

1. `claude -p` works under launchd (keychain auth, proxy env). **Unverified**, P0-1.
2. Peer-socket push still wakes an idle session on Claude Code 2.1.293. Verified only on 2.1.272, P0-2.
3. A Monitor-tool line wakes an idle session and survives nothing beyond the session. Expected, P0-2.
4. Headless worker startup load with minimal settings is ≤ ~40K tokens. **Unverified**, P0-4.
5. `--max-turns` exists in 2.1.293 (`strings` on the binary matched). Its semantics in `-p` mode are unverified.
6. The `stream-json` result event carries per-call usage fields enough for receipts. Believed from detach_job's `is_error` parsing; field names unverified.
