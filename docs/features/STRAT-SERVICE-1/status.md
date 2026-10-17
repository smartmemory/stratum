# STRAT-SERVICE-1 — status (resume point)

## Build status (2026-10-14)

Code lives in `~/.claude/scripts` (O5); build folder `forge/scratch/2026-10-12-strat-service-build/` (one subfolder per
slice, each with its install record and backups). Coordination ledger: `SmartMemory/scratch/2026-10-05-coordination/ledger.md`.

| Slice | State |
|---|---|
| S0, S1 (queue fields), S2a/S2b (dry-run tick + pilot report) | DONE, installed. Shadow pilot running since 2026-10-12 (LaunchAgent `ai.smartmemory.dispatch`, `tick --dry-run` every 300 s) |
| S3 (live writes: launch, adopt, resolve, budget stop) | Code INSTALLED 2026-10-13 (step 2); plist still dry-run. Live probe P1–P5 all PASS. Go-live (step 3, plist swap) waits for the pilot report and the O2 caps; owner 2026-10-14: "no rush to go live" |
| S3R (pilot report reads live/probe-live ticks) | DONE, installed 2026-10-13 |
| S3A (admit withdrawn at launch: producer + report reconcile) | DONE, installed 2026-10-14 (Codex r1 CLEAN; record `S3A/install-record.json`) |
| S4 (stamps + sm_status holds) | DONE, installed 2026-10-13 |
| DETACH-NAME-2 | DONE, stratum b7c5bd0 |

2026-10-15: pilot report FAIL (2 of 616 ticks hit the deadline, bar not lowered); owner set O2 caps (global 20, Opus 8,
Codex 8, Codex 90% hold live). Next: live dispatch tests green (S2B-TESTS-RED, s4-infra), TICK-DEADLINE-1, 2 clean pilot days, then
the owner's single go-live yes. Unit state: `forge/status/units.json`.

2026-10-15 18:15: TICK-DEADLINE-1 DONE, installed (dispatch.py 6b671b529660, dispatch_report.py 5a6849a6ca26; backups
`*.bak-20261015-td1`). 3 Codex reviews; r3's one finding was ruled the intended post-write breaker divergence and pinned by a test
(rule 4). Seven suites green in place. Record: `forge/scratch/2026-10-12-strat-service-build/TD1/README.md`. The 2 clean pilot
days run from 2026-10-15 18:09 (dry-run launchd job, new code). Then the owner's go-live yes.

2026-10-17 07:42: TICK-COST-1 DONE, installed (dispatch.py f46815645648, dispatch_report.py a4be88ef68d8; smart-memory-ops
`afee80b`, rollback = git `ed66af0`). The pilot after TD1 still failed (9-10 deadline ticks, ~11 s CPU per tick re-scanning
finished jobs' logs); a cross-tick dead-job status cache brings a warm tick to ~1.0-1.9 s CPU. Reviews r1/r2 NOT CLEAN (P2), closed
by the final Opus fix, no r3 (rule 8). Record: `smart-memory-ops/units/TICK-COST-1/README.md`. **The 2 clean pilot days restart
from 2026-10-17 07:42**, then the owner's go-live yes.

2026-10-17 14:5x: pilot clock BROKEN at 14:02. 5 deadline ticks (14:02-14:41) under 1-min load 125-142, each only 2-5 s CPU
(machine starvation, not tick cost; normal post-TC1 ticks ~2-3 s CPU). Owner ruling via s1-chat: keep the bar, a starved tick is not
clean; **the 2 clean pilot days restart from the first clean tick after the 1-min load is under 32**, then the owner's go-live yes.
REPORT-DEADLINE-GROUP + TC1-F1 landed (smart-memory-ops `6dd8abb`).

The sections below are the design-phase history (2026-10-08 to 10-12).

**2026-10-12: DESIGN rewritten as the shrunk shape, then revised after Codex review r1 (NOT CLEAN, 14 findings, all
addressed). Review round 2 (the last allowed for a plan) was NOT CLEAN with 8 leftovers; the author fixed all 8 and the
coordinator verifies them (no round 3). Uncommitted.** The owner reviewed the
2026-10-08 draft and chose "Shrink it": one queue/scheduler plus one ledger over the shipped scripts, not the always-on
daemon. Current design: [design.md](design.md). The old draft is kept as
[design-2026-10-08-full.md](design-2026-10-08-full.md), marked SUPERSEDED. Both files are uncommitted in the stratum repo.

## What changed (2026-10-12)
- Shape: the daemon, socket API, MCP thin client, Stratum-engine host, work-order compiler, pub/sub inbox, herdr bridge
  and flush integration are dropped. The spine is the existing `jobs.py` queue (extended with dispatch/kind/engine/
  `after` fields) plus a stateless `dispatch.py tick` on a launchd timer that launches only through `detach_job.py`.
- Prior-art table (design §2) maps every old capability to the shipped script that covers it, with file:line.
- Problem restated with 2026-10-12 numbers: $3,173/24 h, Opus 72%, headless `sdk-cli` 68%, in-session subagents 1.5%.
  It now says what the queue will not fix (large interactive main loops, per-job token cost).
- Owner decisions re-derived: O1–O6 (design §7). Six old ones dropped as moot, and old O8 is not reopened (quota % is
  already the admission unit).
- STRAT-FLOW-DETACH is no longer absorbed. It keeps its own gate.

## Done
- 2026-10-08: prior-art inventory and full draft (now `design-2026-10-08-full.md`).
- 2026-10-12: shrunk design.md, with read-only probes in `forge/scratch/2026-10-12-strat-service-shrink/probe/`. Report:
  `forge/scratch/2026-10-12-strat-service-shrink/report.md`.

## Not done (in order)
1. DONE 2026-10-12: Codex review round 2 (`review-r2.md`), leftovers fixed (report.md "Fix round 2"). Coordinator verification DONE 2026-10-12 (8/8, cite_check 91/0; log in the scratch README).
   Was: Codex review round 2 (fixes only) of design.md. Round 1: `forge/scratch/2026-10-12-strat-service-shrink/review-r1.md`;
   fixes: that folder's `report.md` "Fix round 1". No 3rd round on a plan (plan rule 5): narrow leftovers are fixed by the
   coordinator and logged.
2. DONE 2026-10-12: owner answered O2 (shadow 2 days, then numbers) and O4 (yes, auto items in allowlisted roots); O1/O3/O5/O6 applied by coordinator. See design.md "Owner decisions". Was: Owner answers O1 (timer vs by hand), O2 (concurrency caps, money; O2b caps beyond detach_job; O2c Codex 90% hold),
   O4 (unattended launches of BOTH engines with today's permission/sandbox-bypass flags, security). O3/O5/O6 carry
   recommendations the coordinator may apply.
3. Probe A1 (the tick itself from a one-shot LaunchAgent, per engine) runs inside S2. S3 needs A1 passed OR O1 = typed tick.
4. DONE 2026-10-12 (row 8, Standalone Tickets). Was: Roadmap entry PLANNED via compose `add_roadmap_entry` in the stratum workspace (`stratum/docs/plans/COMPOSE-ROADMAP.md`,
   phase "Standalone Tickets").
5. DONE 2026-10-12 (this commit). Was: Commit design.md, design-2026-10-08-full.md and status.md in stratum.
6. Blueprint for S0–S2 (the code home is `~/.claude/scripts` if O5 stands, so the blueprint lives here but the code does not).

The old step "Mark STRAT-FLOW-DETACH SUPERSEDED" is cancelled: the shrunk design does not absorb it.
