# STRAT-SERVICE-1 — One queue over the shipped scripts (design, shrunk)

**Status:** DESIGN, rewritten 2026-10-12, revised twice the same day after Codex reviews r1 (14 findings) and r2 (8
leftovers, final plan round), all addressed: `forge/scratch/2026-10-12-strat-service-shrink/report.md` "Fix round 1" and
"Fix round 2". Stops at the design gate: no blueprint, no code.
**Shape (owner pick, 2026-10-12, "Shrink it"):** one queue/scheduler plus one ledger that ties the EXISTING scripts together
(global caps, typed task packets with budgets, dependency graphs), reusing what shipped since 2026-10-08 instead of replacing
it. It is not the always-on daemon of the 2026-10-08 draft. Recorded here per `~/.claude/rules/shape-before-mapping.md` step 5.
The full draft is kept as [design-2026-10-08-full.md](design-2026-10-08-full.md) (SUPERSEDED).

## Related Documents

- Supersedes: [design-2026-10-08-full.md](design-2026-10-08-full.md) (676-line daemon design, never reviewed or committed). Section numbers `old §N` below refer to it.
- Status / resume point: [status.md](status.md).
- Shipped prior art this design builds on (all read from disk 2026-10-12, cited by file:line in §2):
  `~/.claude/scripts/{jobs.py, detach_job.py, detach_claude.py, job_watch.py, wake_check.py, usage_watch.py, seat_relaunch.py, sm_status.py, owner_queue.py, disk_watchdog.py, costlib.py}`,
  `~/.claude/hooks/{work_model_gate.py, claude_shim.py, subagent_context_cap.py, precompact_resume.py, postcompact_resume.py}`,
  launchd `~/Library/LaunchAgents/ai.smartmemory.{wake-check, usage-watch, disk-watchdog, owner-queue-remind}.plist`.
- Rules that describe them: `~/.claude/rules/{job-monitoring, work-model, usage-watch, compaction, session-management, no-claude-coding, inefficiency-watch}.md`.
- Project-local prior art (2.0 build, SmartMemory): `scratch/2026-10-09-crank-week/queue/{queue.md, work/gen.py, work/stamp.py}`,
  `scratch/2026-10-10-2.0-build/{prep_unit.sh, land_runner.py, land_unit.sh, testsem.py, land-queue.txt}`.
- Not absorbed any more: [STRAT-FLOW-DETACH](../STRAT-FLOW-DETACH/design.md). The old draft claimed it (old §11). The shrunk design does not use the Stratum engine, so STRAT-FLOW-DETACH keeps its own gate.
- Evidence: `SmartMemory/scratch/2026-10-08-token-burn/attribute.py`, and read-only probes in
  `forge/scratch/2026-10-12-strat-service-shrink/probe/` (`entry_split.py`, `concurrency.py`, `durations.py`, `counts.py`,
  `job_cost_join.py`, `trader_origin.py`, `cap_env.py`, `cite_check.py`). Every number below names its probe and window.
- Forward: blueprint.md (not started).

---

## Owner decisions (2026-10-12)

- **Shape:** shrink, one queue over the shipped scripts (owner pick, replaces the 2026-10-08 full-daemon design).
- **O2 caps:** run the S2 shadow pilot for 2 days, then set numbers from its report. Placeholders until then: global 20,
  Opus 8, Codex 8. O2b: no for v1 (measure the uncounted share first, A8). O2c: Codex 90% hold, report-only during S2.
- **O4 unattended launches:** yes for both engines with today's flags, only for items a session queued as `auto` and only
  when the item's `cwd` is inside an allowlisted project root in `dispatch-kinds.json`. The sandboxed-Codex-review probe is
  separate and not a v1 blocker.
- **O1, O3, O5, O6:** coordinator applied the recommendations in §12 (launchd timer if A1 passes, else typed tick; 2.0 build
  units first; code in `~/.claude/scripts`; no cross-project fairness in v1). The owner may override.

## 1. Problem (2026-10-12 numbers)

**Rerun:** `python3 ~/reg/my/SmartMemory/scratch/2026-10-08-token-burn/attribute.py 24` (run 2026-10-12 ~13:00 local).
The brief quoted an earlier run of the same day: $3,128, 4,922 Opus calls over 200K. Figures move with the window.
Probe figures below are from the fix-round run; the final rerun before review drifted slightly (`counts.py 24`: 354
launches, 1,913/589 rows; `job_cost_join.py 24`: $1,214 matched, $981 unmatched, $959 stock-trader; `durations.py 7`:
Sonnet p50 10, Codex p90 24). Peaks were unchanged.

| Measure | Value | Command (window) |
|---|---|---|
| Claude spend, API-equivalent | **$3,173** (25,032 calls) | `attribute.py 24` (last 24 h) |
| Opus share | 72.3% ($2,294), 4,986 Opus calls with context > 200K | same |
| `main / sdk-cli` (headless runs) | **68.4%** ($2,170), 18,358 calls, 3,771 over 200K | same |
| `main / cli` (interactive tabs) | 30.1% ($955) | same |
| `subagent / cli` (in-session subagents) | 1.5% ($48) (was 57% on 2026-10-08, old §1) | same |
| Top interactive sessions | s2-coord $347, trader-main $314, sm-chat $231 | same |
| detach_job launches | 355 started in the last 24 h (Codex 224, Claude Opus 62, Claude Sonnet 69) | `probe/counts.py 24` (index `started_ts`) |
| Peak concurrency of detach_job work | **28** (Opus 13, Sonnet 17, Codex 11); upper bound, a job with no exit file counts as running | `probe/concurrency.py 7` (7 days) |
| `jobs.py add` rows with a `work_kind` tag | 44 of 1,912 all time; 16 of 592 in the last 24 h | `probe/counts.py 24` |
| `jobs.py` queue files | 0 | `probe/counts.py 24` |

**What `sdk-cli` is (measured).** `attribute.py` labels each transcript with its first `entrypoint` field
(`costlib.py:70-71`) and counts a call as a subagent only when its path has `/subagents/` (`costlib.py:137`). One detach_job
run was traced end to end (`U5.24-companion` → session `559ce9bf…` → 52 records, all `"entrypoint":"sdk-cli"`).
`probe/job_cost_join.py 24` then joined every Claude detach_job run's stream-log `session_id` to transcript cost: **$1,207
(55%) of the 24 h sdk-cli spend maps to detach_job runs** (135 sessions: Opus $920, Sonnet $287). The unmatched **$990**
(182 sessions) is almost all stock-trader (**$967**, 172 sessions, cwd `~/reg/my/stock/trader`, all starting with the same
`hard: rule matrix is the last money-safety gate…` brief on seats 2–4). Those sessions are in neither the detach index nor
`~/.stratum/ts/agent_runs` (`probe/trader_origin.py`), so **their launcher is unidentified (assumption A2)**.

**What changed since 2026-10-08.** The old problem (work dies with the session, subagents at 57%) is mostly solved:
long work now runs as detached jobs (`detach_job.py`), and the in-session subagent share is 1.5%. Today's problem is
different:

1. **Every dispatch is a coordinator turn.** No code launches a queued unit by itself. A grep for callers of
   `detach_job.py run` over `~/.claude/scripts`, the 2.0 build dir and the queue `work/` dir finds only detach_job itself.
   Each unit is `prep_unit.sh` + `detach_job.py run`, typed by s2-coord or trader-main. Those two sessions alone cost $661
   in 24 h (share spent on dispatching unverified, assumption A3).
2. **No global caps.** Caps exist per account (the 90% quota gate) and per test slot (2.0 `testsem.py`), but nothing
   bounds how many Opus, Sonnet or Codex jobs run at once across projects. The 7-day peak was 28 at once, 13 of them Opus.
3. **Several unit-state stores, all disconnected.** The `jobs.py` queue is the generic queue and is empty. The 2.0 build
   keeps its own queue in `queue.md` + `live.json` (stamp.py), and landing state in `land-runner-state.json`. stock-trader
   keeps its waves in scratch folders. Dependencies exist only in `queue.md`'s "depends on" column and are honoured only at
   landing (`land_runner.py:4-7`).
4. **Budgets are partly enforced and cost is partly blind.** Context is capped at 300K for headless Claude
   (`subagent_context_cap.py:31`, switched on by
   `CONTEXT_CAP_ENFORCE=1` at `detach_job.py:790`). Nothing enforces wall clock (detach_job reports
   STALLED after 15 min without log growth, `detach_job.py:67`, and does nothing else). Cost per work kind is blind twice
   over: few rows carry a `work_kind` tag (table above), and `usage_watch weekly` joins cost to jobs by transcript session
   name (`usage_watch.py:1052-1054`), which headless transcripts do not have.

**What the queue will NOT fix (honest line).**
- **Large-context interactive main loops.** `main / cli` is 30% of spend: s2-coord (1,209 of its 2,553 calls over 200K),
  trader-main and sm-chat. A queue removes some of their dispatch turns but does not shrink their context. That is
  compaction and handoff work (`compaction.md`, `session-management.md`).
- **The per-token cost of each job.** A queued Opus author run costs the same as a hand-dispatched one. The queue's cost
  levers are only (a) fewer coordinator turns, (b) caps on how many Opus jobs run at once, and (c) tags plus a session-id
  join that make per-kind cost measurable. Caps on Opus concurrency are an owner money decision (O2).
- **Launches outside detach_job.** Interactive tabs, in-session subagents, Stratum agent runs and the unidentified
  stock-trader launcher (≈$967/24 h) are not counted by the caps and not gated by the tick (§3.6, A2, A8).
- **Review/fix judgment.** Adjudicating a NOT CLEAN review and writing the fix brief stay with a session.

## 2. Prior-art table

One row per capability of the old draft (old §3–§10). "Keep" = new code in this design; "Reuse" = shipped code used
as-is or with a small adapter; "Drop" = not built.

| Old capability | Shipped coverage (file:line) | Gap left | Shrunk design |
|---|---|---|---|
| §3 Process model: work outlives sessions | `detach_job.py:1-6` (detached, own session, registered under the session NAME), `detach_job.py:740` `run()`, `detach_job.py:857-858` registers `jobs.py add --kind detached` | None for running work | **Reuse** detach_job as the only launcher |
| §3 Always-on daemon, crash restart, rehydrate | launchd timer pattern: `ai.smartmemory.wake-check` (StartInterval 900), `usage-watch` (300), `disk-watchdog` (600), `owner-queue-remind` (900) | Nothing dispatches on a timer | **Keep, shrunk:** a stateless `dispatch.py tick` on a launchd timer (same pattern), no daemon, no socket |
| §3 Thin MCP client, socket API, version handshake | — | Not needed: the queue is files and a CLI | **Drop** |
| §3 Second launcher path (`detach_claude.py`) | `detach_claude.py:24-25` Popen with `start_new_session`, no `jobs.py` registration (no `jobs` reference in the file) | Unregistered jobs have no collector | **Drop** from the queue path. The queue launches only through detach_job (S0 retires the rule text that recommends detach_claude) |
| §4 Task catalog: typed tasks, model per type | `jobs.py:51` KINDS (runtime), `jobs.py:53` WORK_KINDS `author, fix-round, review, diagnose, land, doc, spike, other`; `jobs.py:9-10` optional add tags `--work-kind --vendor --model --account --for` | Tags are optional and detach_job does not pass them (`detach_job.py:857-858` passes session, kind, id, report, collect, label) | **Keep, small:** a kinds data file keyed by the existing WORK_KINDS (§4). **Reuse** the jobs.py tags, forwarded by detach_job (S0) |
| §4.3 Context budget | `subagent_context_cap.py:31` defaults, thresholds from env `CONTEXT_CAP_WARN` and `CONTEXT_CAP_STOP` read together, falling back to both defaults unless `0 < warn < stop` (`subagent_context_cap.py:154-163`); `detach_job.py:790` sets `CONTEXT_CAP_ENFORCE=1` for Claude | Per-kind values never set | **Reuse:** the tick sets both thresholds per kind (§4) |
| §4.3 Wall-clock budget | `detach_job.py:67` STALL at 15 min without log growth (report only); `detach_job.py stop <label>` exists (`detach_job.py:1369-1370` parser) | No wall-clock kill | **Keep, small:** the tick's sweep stops managed jobs past their kind's wall budget (§3.2 step 4) |
| §4.3 `--max-turns` | — (the old draft left its semantics open, old §14.5) | Not needed: context and wall budgets cover runaway jobs | **Drop** |
| §4 No nested subagents, pre-granted permissions | Claude: `detach_job.py:536-537` `claude -p --dangerously-skip-permissions --disallowedTools=Agent --settings {"enableAllProjectMcpServers":true}`. Codex: `detach_job.py:544-545` `codex exec … --dangerously-bypass-approvals-and-sandbox` | Unattended use of both is a security decision (O4) | **Reuse** unchanged, behind O4 |
| §4 Opus only for named hard work; quota gate | `work_model_gate.py:1590` `judge(launches, now, source)` returns None (allow) or a reason, and logs the DENY itself; `work_model_gate.py:1091-1092` already models a typed `detach_job.py --engine claude` launch as `Launch(model, brief text, config_dir)`; `work_model_gate.py:83` a `Launch` without `config_dir` targets the *caller's* config dir | **Not applied to launchd:** `claude_shim.py:254` judges only when `CLAUDECODE` is set; quota covers Claude accounts only (`work_model_gate.py:1474`) | **Reuse** `judge()` on one resolved launch packet with an explicit `config_dir` (§3.5) |
| §5 Work order + compiler + macros | 2.0 build: `queue/work/gen.py` generates brief pairs and `queue.md` from `units.py`; `prep_unit.sh:2` instantiates a pair into a worktree | Generic projects have no generator | **Drop** the compiler. A "graph" is queue items with `after` edges (§3.3) |
| §5.2 Submit-time validation | `jobs.py:170` `check_token` (non-empty, not option-shaped), `jobs.py:529` `_queue_update` check-then-append under one lock, `jobs.py:561` duplicate id refused **per session** | No check of brief/report/cwd/deps/model; ids not unique across sessions | **Keep, small:** `queue add` validates the new fields and stores qualified references (§3.4) |
| §6 Leases, fencing, idempotency | `detach_job.py:577-583` refuses to launch over a live job with the same label; launch mark + window (`detach_job.py:28-36`); the detach index is global by label (`detach_job.py:182-183`), labels must match `LABEL_RE` (`detach_job.py:80`) | Queue ids are per session but labels are global | **Reuse,** with a namespaced label derived from the qualified id (§3.3) |
| §6 Event-sourced ledger | `jobs.py:2-5` append-only JSONL, latest event per id wins; queue in its own file (`jobs.py:27-32`) | — | **Reuse** jobs.py as the one ledger (§5) |
| §6 Heartbeats + watchdog | `job_watch.py:2` checks alive/progress/errors/disk; `detach_job.py:1160` `job_status` classifies `STARTING / RUNNING / STALLED / LINGERING / ABORTED / STOPPED / FAILED-SILENT / FAILED / DONE`. DONE needs a fresh report and no error lines; a result record only for real Claude jobs (`detach_job.py:1190`); a missing exit code is accepted (`detach_job.py:1217`) | DONE does not prove exit 0 | **Reuse** both. Dependencies need DONE **and** a recorded exit 0 (§3.2 step 5) |
| §6 Admission control | `work_model_gate.py:2-8` per-account 90% quota, `$120` blank-reading backstop; `usage_watch.py:659` `pick`, `usage_watch.py:43` HEADROOM_5H_MAX 95; `pick` may return Codex for overflow kinds (`usage_watch.py:703`) | No concurrency caps; nothing applies the gate outside sessions; no Codex quota hold | **Keep, small:** caps in the tick + the reused gate. `pick` is used only inside the item's vendor (§3.5) |
| §6 Circuit breaker on fix rounds | Rule only (`no-claude-coding.md` review-loop rule 3, max 3 review rounds) | Not enforced in software | **Keep, small:** the tick holds a 4th review for the same qualified unit (§3.4) |
| §6 Bulkheads per vendor | — | Codex projected 150% at reset (`usage-watch.log` 2026-10-12 10:17) | **Keep** as a per-vendor cap (O2) |
| §6 Backpressure from disk | `job_watch.py` `disk-low` below 100 GB; `disk_watchdog.py` (launchd 600 s) | Dispatch ignores disk | **Keep, tiny:** the tick admits nothing below 100 GB |
| §6 Priority | `jobs.py:604-614` `queue_items` sorts level first, then oldest, across all session files | — | **Reuse** as the ready-set order |
| §7 Cache economics per type | `usage-watch.md` flag 2 (subagent TTL env 1h) | A per-kind TTL would need a per-job harness setting; not pursued | **Drop** from v1 |
| §8 Wakes to sessions | `job_watch.py` EVENTs to the armed session; `wake_check.py:2-6` types one wake line into an idle tab with pending jobs and no armed watcher | — | **Reuse.** Every queue job registers under its item's session, so the existing EVENT/wake path reaches it |
| §8.2–8.4 Peer push, Monitor tail, herdr bridge | herdr installed, last herdr line in the coordination ledger is 2026-10-08; `wake_check.py` types into iTerm tabs | — | **Drop** |
| §8.3 Good-moment flush, resume packet | `precompact_resume.py:2` puts open jobs and open queue items into the compact summary; `postcompact_resume.py:2-3` writes the resume file | — | **Drop.** Queue items survive compaction through the PreCompact hook |
| §8.4 Auto-flush as subscriber | `ai.smartmemory.auto-flush.plist` exists but is not loaded (`launchctl print` → "Could not find service") | — | **Drop** (superseded by compaction) |
| §9 Usage watcher | `usage_watch.py:3-7` `snapshot / status / pick / weekly / probe`, launchd every 300 s; weekly cost joins on session name (`usage_watch.py:1052-1054`, `usage_watch.py:1057` `allocate_api`) | Per-kind cost blind (tags + join, §1 item 4) | **Reuse;** S0 adds tags and a session-id join |
| §9 `service top` | `sm_status.py:2-8` (open jobs with level, queued work, quota, disk + spend) | Shows no hold reasons | **Reuse;** S4 reads the tick's `last-tick.json` |
| §9 Per-unit timing stamps | 2.0 `stamp.py:10` (`ready_at`, `dispatched_at`, … in `live.json`), written by `stamp.py:208` `cmd_sync` via `stamp.py:56` `save` | 2.0 only; generic stamps undefined | **Reuse** for 2.0 unchanged; queue stamps defined per event in §5.3 |
| §10 Failure modes | Mostly handled by detach_job states, job_watch events and wake_check | Gaps only where the tick acts | **Keep** only the tick's own failure modes (§6) |
| (not in old draft) Test-slot semaphore | 2.0 `testsem.py:2-6` flock slots | — | **Reuse** unchanged, outside the queue |
| (not in old draft) Dependency-aware landing | 2.0 `land_runner.py:4-7` drains `land-queue.txt` once dependencies landed; `land_runner.py:181-196` parses `depends on`; `land_unit.sh:49` requires `VERDICT: CLEAN` | — | **Reuse** unchanged. The queue does not land |
| (not in old draft) Owner decisions | `owner_queue.py:2` append-only, latest wins, launchd reminder | — | **Reuse;** hold reasons that need the owner go there |

## 3. Shape

### 3.1 Spine, reuse, adapters, drops

- **Spine (new, small):** the `jobs.py` queue as the one queue and ledger, plus `dispatch.py tick`. The tick is a
  stateless pass on a launchd timer (or typed by hand, O1) that reads the queue, decides, and launches through detach_job.
- **Reused as-is:** `detach_job.py` (launcher, process truth, states, stop), `job_watch.py` (monitoring, auto-close of
  registry rows), `wake_check.py` (wakes), `usage_watch.py` (accounts, quota readings, `pick`, weekly cost),
  `work_model_gate.judge()` (quota + named-hard Opus), `subagent_context_cap.py` (context budget), the compaction hooks,
  `owner_queue.py`, `disk_watchdog.py`, and for the 2.0 build `prep_unit.sh`, `testsem.py`, `land_runner.py`.
- **Adapter work:** new optional fields on `jobs.py queue add` (§3.4); detach_job forwards kind/vendor/model/account tags
  to `jobs.py add`, and `usage_watch weekly` gains a session-id join (S0); a kinds data file (§4).
- **Dropped:** daemon, socket API, MCP thin client, Stratum engine as host, work-order compiler and macros, leases with
  heartbeats, pub/sub inbox, herdr bridge, flush integration, per-kind cache TTL, `--max-turns`, multi-host, retries.

### 3.2 One tick

`dispatch.py tick [--dry-run]`, launchd `ai.smartmemory.dispatch`, StartInterval 300 (O1). One tick at a time, under an
exclusive flock on its own lock file. **Recovery and budget enforcement run before, and never depend on, permission to
launch.** Steps, in this order:

1. **Read.** All queue items of every status from every session file, with diagnostics on: the CLI contract
   `jobs.py queue list --status all --json --diagnostics` (`jobs.py:742-745`, which switches `_DIAG` on at
   `jobs.py:760-762`; the library default is open items only, `jobs.py:604`, and diagnostics off, `jobs.py:79`). Then
   filter in the tick. Plus the detach index (every `<label>.json`, read through detach_job's own `job_status`,
   `detach_job.py:1160`). Read health per session file comes from the diagnostics (§3.4 "Read health").
2. **Reconcile** every `auto` and `shadow` item that has a stored label. Exactly one branch applies, tested in this
   order; the first that matches wins:
   1. **No index entry.** Open item → not launched yet, goes on to readiness. Started item → hold its dependents
      `dependency-unproven`.
   2. **Index entry unreadable** (a `<label>.json` that detach_job's loader skips, `detach_job.py:198-204`) → hold the
      item and its dependents `index-unreadable`; the entry counts as unknown inventory (§3.6).
   3. **Ownership check fails** (§3.3) → `label-collision`. The entry is never adopted, never stopped, never counted as
      the item's job and never satisfies a dependency. It still counts in the inventory if live.
   4. **Owned, launch aborted or never committed:** state `ABORTED`, which detach_job gives both to an aborted launch and
      to a `starting` meta whose wrapper is gone (`detach_job.py:1201-1206`) → open item: hold `launch-aborted` (a person
      drops or re-adds it, the tick never retries); started item: dependents held with the state.
   5. **Owned, launch in progress:** state `STARTING` with a live wrapper (`detach_job.py:1186`) → no action this tick.
   6. **Owned, any other state** (`RUNNING`, `STALLED`, `LINGERING`, `DONE`, `FAILED*`, `STOPPED`) → open item: adopt
      with `jobs.py queue start <qid> --session <s> --job-id <label>` (the crash or `queue start`-warning case,
      `detach_job.py:720-737`); started item: nothing. Never relaunch.
3. **Budget sweep**, only over **owned** jobs (branches 5 and 6, open or started), in state `STARTING`, `RUNNING`, `STALLED`
   or `LINGERING`: past the kind's wall budget, measured from the meta `started_ts` → stop. `LINGERING` is logged, never
   stopped (detach_job asks for a person, `detach_job.py:1194`). `STARTING` older than 10 min is logged. The sweep runs
   even when caps, quota or disk would admit nothing. job_watch reports each stop's exit to the owning session as usual.
   **Every state-changing action on an existing job (adopt/`queue start`, stop, counting it as a dependency's DONE) is
   gated on the same ownership check, made in this tick.** A stop also carries the owned job's launch mark:
   `detach_job.py stop <label> --expect-mark <mark>`, a small S3 adapter that refuses inside detach_job's label lock
   (`detach_job.py:1332-1334`) when the indexed job's mark differs, so a job relaunched under the label between check
   and stop is never killed.
4. **Inventory** (§3.6): count live detach_job work by engine and model.
5. **Ready.** An `auto` item is ready when every `after` reference is satisfied: the referenced item is `started`, its
   `job_id` has an **owned** index entry (§3.3) in state `DONE`, **and** that job's exit record is `0`. `DONE` with no exit record holds
   `missing-exit-evidence` (DONE accepts a missing exit, `detach_job.py:1217`; requiring exit 0 means a dependent never
   starts on a job whose wrapper died before writing its exit). `FAILED*`, `STOPPED`, `ABORTED` or `LINGERING` → hold with
   that state. A dependency in a session file with read problems, or one that cannot be found → hold
   `dependency-unreadable` / `dependency-missing`. Holds never fail or drop an item.
6. **Admission**, ready items in `queue_items` order (P0 first, then oldest), each:
   1. **Rules:** brief, report directory and cwd exist; brief text unchanged since `queue add` (sha256 stored at add); for
      `review` items, not the 4th review of its unit, counted with this tick's reservations (§3.4 Review rounds).
   2. **Disk:** free space ≥ 100 GB, else hold all (`disk-low`).
   3. **Caps (O2):** global, per engine, per model, against the inventory plus this tick's admissions.
   4. **Gate:** resolve the launch packet and judge it (§3.5). Deny → hold with the gate's reason.
   5. **Persist the account:** `jobs.py queue resolve <qid> --session <s> --account <id>` (new S1 op, jobs.py the writer,
      allowed only while the item is open, latest record wins), so recovery can check the job ran on that account. The
      tick issues it only for an item that took reconcile branch 1 this tick (no index entry for its label), so it never
      rewrites the account of a job that may already be running.
   6. **Launch:** `detach_job.py run` with exactly the packet's values (§3.5). detach_job runs `queue start` itself.
   7. **Reserve:** add the launch to this tick's cap counts and, for a review, to its unit's round count, before the
      next candidate is considered. A dry-run or shadow evaluation reserves the same way.
7. **Log.** One line per decision to `~/.claude/logs/dispatch.log`, plus an overwrite of
   `~/.claude/session-state/dispatch/last-tick.json` (hold reasons, for sm_status). Neither is read by the next tick.

`--dry-run` runs steps 1–7 but replaces every write (`queue start`, `stop`, `run`) with a `would-…` log line. `shadow`
items (§3.4) are always evaluated as dry-run, even by a live tick.

Every launch goes through `detach_job.py run`, which starts the job in its own process session (`detach_job.py:1-6`). That
holds whether launchd or a person runs the tick (O1 fallback), so no queued job is ever a child of a session. The tick
writes no queue or registry row directly: every write goes through `jobs.py` (CLI) or `detach_job.py` (launch, stop).

### 3.3 Identity: qualified ids, labels, adoption, units

Every identity that crosses a boundary has a namespace, a mapping and a validation point.

| Identity | Form | Mapping | Validated at |
|---|---|---|---|
| Queue item | `<session>/<qid>` (qref). `qid` unique per session (`jobs.py:561`), session = the queue file name | — | `queue add` (existing `check_token`, plus: session passes detach_job's session rule, `detach_job.py:171-175`) |
| Detach label | `q<h10>-<readable>`, where `h10` = first 10 hex of sha256(qref) and `<readable>` = qref with every character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 40 characters. At most 52 characters | One label per qref, a pure function of it. No attempt suffix: the tick never retries, and a retry is a new item with a new qid | Computed and checked against `LABEL_RE` (`detach_job.py:80`) at `queue add`, then **stored in the add record** (jobs.py is the writer). The tick uses the stored value and holds `label-mismatch` if recomputing differs |
| Dependency | `after` = list of qrefs. A bare `qid` is accepted on input and stored as `<own session>/<qid>` | qref → that item's `job_id` (its label) → index entry | `queue add`: each qref exists, is not a `review` item (DONE is not CLEAN, so nothing may start "after" a review), no self edge, no cycle across all queue files |
| Unit | `<namespace>/<unit>`; a bare unit is stored as `<own session>/<unit>` | groups review rounds across sessions | `queue add`: required for `auto`/`shadow` `review` items |

**Ownership check** (step 2, and again before every action in step 3 and every dependency read in step 5). Every
field detach_job records in a job's meta at launch (`detach_job.py:841-851`) is classified, so none is skipped silently:

| Meta field | Role | Rule |
|---|---|---|
| `label`, `session`, `engine`, `model`, `effort`, `cwd`, `brief`, `report` | launch identity | must equal the item's stored value (paths resolved) |
| `config_dir` (Claude, today), `account` + `account_home` (both engines, added in S0) | launch identity | must equal the item's resolved account (`queue resolve`) and that account's home. A queue launch always postdates S0 (S3 needs S0), so a meta without `account` fails |
| `override` | test marker | must be false: a job run under `DETACH_JOB_ENGINE_OVERRIDE` is a test job, never adopted |
| `started_ts`, `launch_window` | launch instance | `started_ts` must be ≥ the item's `add` ts; otherwise per-launch by construction |
| `mark`, `pid`, `pgid`, `sid`, `log`, `exit_file`, `meta`, `state`, `started`, `schema` | launch instance | differ per launch by construction; `mark` is kept for the guarded stop (step 3) |
| `cmd`, `collect` | derived | `cmd` is built from engine/model/effort/brief, `collect` defaults from label and report; checking the inputs covers them |

Any identity mismatch is `label-collision`.

**Existing ids keep working.** `manual` items (the default) are never adopted, never launched by the tick and never
counted for review rounds; their ids, CLI and `detach_job --queue-id` use are unchanged. Only `auto`/`shadow` items get
stored labels, and an `after` may point at a manual item only if that item was started with a detach label as `job_id`
(else `dependency-unproven`).

### 3.4 Queue item fields and validation (adapter work in `jobs.py`)

Existing: `id, session, priority, title, brief, waiting_on, note, status, job_id` (`jobs.py:27-32`). New, all optional so
today's items and callers are unchanged:

| Field | Meaning | Validated at `queue add` |
|---|---|---|
| `dispatch` | `manual` (default), `auto` (the tick launches it) or `shadow` (the tick evaluates it, a person launches it, §9 S2) | enum |
| `kind` | one of WORK_KINDS (`jobs.py:53`) | enum; required for auto/shadow; **`land` refused** for auto/shadow |
| `engine`, `model`, `effort` | as `detach_job.py run` | engine in detach_job ENGINES (`detach_job.py:81`); required for auto/shadow |
| `report`, `cwd` | absolute paths | absolute; parent dir / dir exists; required for auto/shadow |
| `brief_sha256` | hash of the brief text at add | computed by jobs.py, never given |
| `label` | §3.3 | computed by jobs.py, never given |
| `after` | qrefs | §3.3 |
| `unit` | qualified unit | §3.3; required for auto/shadow `review` |
| `account` | pin to an account id from `usage-watch.accounts.json` (`usage_watch.py:71` `load_accounts`) | known id whose vendor equals `engine`; for Codex, only an account whose home is the default `~/.codex` until A10 passes (§3.5) |
| `resolved_account` | the account the tick chose, written by `queue resolve` just before launch | written only by jobs.py, only while open |

**Review rounds.** Per qualified unit, the tick counts the rounds already used: `review` items (auto or shadow, any
session) with that unit that are `started` **or** have an owned index entry (a launch whose `queue start` failed still
used a round). Items dropped before any launch do not count. During admission the tick keeps this count per unit and
adds each review it admits (or would admit, in dry-run and shadow) before looking at the next candidate, so two open
reviews of one unit cannot both be judged round 3. A review that would be round 4 is held (`no-claude-coding.md` rule
3). Reviews launched by hand without a queue item are invisible to the count; that is a stated limit, not a guarantee.

**Read health.** Diagnostics from step 1 are attributed to their session file. Items in a file with any diagnostic are
held `session-file-unreadable`; dependents in other sessions that reference such an item are held
`dependency-unreadable`. Items in healthy files with healthy dependencies proceed.

### 3.5 The resolved launch packet (what is judged is what is launched)

For each admitted candidate the tick builds one packet and uses it for both the gate and the launch:

| Packet field | Source |
|---|---|
| `engine`, `model`, `effort`, `kind` | the item (`effort` defaults from the kind file) |
| `account`, `account_home` | the item's `account` if set, else `usage_watch.pick(kind, …)` (`usage_watch.py:659`). **If pick's choice is a different vendor from the item's engine** (review routing, or Codex overflow at `usage_watch.py:703`), hold `pick-vendor-mismatch`; the tick never switches an item's engine. `account_home` is the account entry's `config_dir`, resolved: Claude's `CLAUDE_CONFIG_DIR`, or the Codex home (`usage-watch.accounts.json:2`) |
| `brief_path`, `brief_text` | the item's brief, read once; its sha256 must equal `brief_sha256` |
| `report`, `cwd`, `label`, `session`, `queue_id` | the item |
| `env` | Claude: `CLAUDE_CONFIG_DIR=<account_home>` and `CONTEXT_CAP_WARN`/`CONTEXT_CAP_STOP` from the kind (§4). Codex: `CODEX_HOME=<account_home>` |

**Gate (Claude).** `judge([Launch("detach_job.py --engine claude", [model], brief_text, need_model=True,
config_dir=<packet account_home>)], now, "dispatch-tick")`: the same constructor the hook uses for a typed `detach_job.py`
command (`work_model_gate.py:1091-1092`), with `config_dir` explicit so it never defaults to the tick's own
(`work_model_gate.py:83`). `None` → admit. A string → hold with that reason (judge logs the DENY itself,
`work_model_gate.py:1612`). An exception, or no answer within 30 s → hold `gate-error`, logged. A launchd process does
not have `CLAUDECODE` set, so `claude_shim.py:254` will not judge again: on this path the tick's call is the only gate,
which is why A5 must prove it.
**Gate (Codex).** `judge()` covers Claude accounts only (`work_model_gate.py:1474`), and no rule caps Codex quota today.
A Codex item passes the per-engine cap (O2) and, if the owner says yes in O2, a 90% hold on the Codex reading
(`usage_watch.py:321` `read_codex`).
**Binding a Codex job to its account.** The Codex command has no account flag (`detach_job.py:544-545`) and inherits the
launcher's environment (`detach_job.py:788`). codex-cli 0.159.0 does read a `CODEX_HOME` variable: `strings "$(realpath
"$(command -v codex)")" | grep CODEX_HOME` shows "failed to resolve CODEX_HOME" and "`$CODEX_HOME/config.toml` (normally
`~/.codex/config.toml`)". That proves the variable exists and defaults to `~/.codex`. It does not prove that `codex exec`
takes its login from it and writes its sessions under it, which is what account binding needs (A10, unverified). So in
v1: the tick always sets `CODEX_HOME` explicitly to the selected account's resolved home, never inherits one, and
**holds `codex-account-unbound` any Codex item whose selected account's home is not the default `~/.codex`**. Today the
accounts file has one Codex account, `~/.codex` (`usage-watch.accounts.json:2` documents `config_dir` as the Codex home),
so nothing is held now. S0 records `account` and `account_home` in the meta for both engines, and the ownership check
compares them.
**Launch.** `detach_job.py run --session <session> --label <label> --engine <engine> --model <model> [--effort <effort>]
--brief <brief_path> --report <report> --cwd <cwd> --priority <item priority> --queue-id <qid> --work-kind <kind>`
(`--work-kind` is S0) with the packet's env. Immediately before the call the tick re-hashes the brief; a change holds
`brief-changed`. The remaining window is the milliseconds between that hash and detach_job's own read, accepted and noted.

**Env contract of the tick process.** The coupled variables travel together or not at all:
- **Paths:** `CLAUDE_JOBS_DIR` (the jobs.py registry and queue, `jobs.py:683`), `DETACH_JOB_INDEX_DIR`
  (`detach_job.py:179`), and `USAGE_WATCH_ACCOUNTS` / `USAGE_WATCH_STATE_DIR` (`usage_watch.py:72`,
  `usage_watch.py:543`) are either all unset (production defaults) or all set to one test root. The tick refuses to start
  when only some are set, so a test tick can never read a test queue and launch into the production index.
- **Gate switches:** five kill switches that `judge()` honours: `WORK_MODEL_QUOTA_GATE`, its deprecated alias
  `WORK_MODEL_SPEND_GATE`, `WORK_MODEL_CEILING_GATE`, `WORK_MODEL_RESERVE_GATE` and `WORK_MODEL_OPUS_GATE`
  (`work_model_gate.py:1834-1860` as of 2026-10-14; the tick's list is `dispatch.py:71` `GATE_SWITCHES`). The plist never
  sets them. If one is set to `0` in the tick's env, the tick admits no Claude item and logs `gate-switch-off` with the
  switch names (`dispatch.py:1378-1380`): an owner override belongs in a session, not in a timer. (Amended 2026-10-14 at
  S2 close: the 2026-10-12 text named three switches.)
- **Launch env, per engine:** Claude gets `CLAUDE_CONFIG_DIR` (the packet's account home) and the
  `CONTEXT_CAP_WARN`/`CONTEXT_CAP_STOP` pair (§4); `CONTEXT_CAP_ENFORCE` is left to detach_job (`detach_job.py:790`).
  Codex gets `CODEX_HOME` (the packet's account home). Each launch removes the other engine's account variable and any
  inherited value before setting its own. `CLAUDECODE` is never set by the tick.

### 3.6 What the caps count

The caps govern **admissions by the tick**, counted against **all observed detach_job work**: every index entry whose
state is `STARTING`, `RUNNING`, `STALLED` or `LINGERING` (`detach_job.py:1186-1194`), queue-launched or not, by engine and
model from its meta. detach_job's loader skips an index file it cannot read (`detach_job.py:198-204`), so the tick lists
the index directory itself and counts each skipped file, and each readable entry whose state cannot be computed, as
**unknown**. Each unknown job reserves one slot in **every** dimension: the global cap, every engine cap and every
model cap (and every account cap, if O2 adds one). Eight known Opus jobs plus one unknown therefore fill an Opus cap of 8.
If the index directory itself cannot be listed, the tick admits nothing and stops nothing that tick, and logs why. Work launched outside detach_job (interactive tabs, in-session subagents, Stratum agent runs, the
unidentified stock-trader launcher) is **not counted and not gated**. A8 measures that share. A hard global cap across all
launch paths would need shared admission inside the shim and the hook; that scope is the owner's (O2b), not v1.

### 3.7 Dependency graph example

One 2.0 unit, enqueued by s2-coord after `prep_unit.sh`:

```
jobs.py queue add --session s2-coord --id U5.9-a --priority P2 --title "U5.9 author" --dispatch auto \
    --kind author --engine claude --model sonnet --brief .../u-U5.9/U5.9.md --report .../REPORT-U5.9.md \
    --cwd .../wt-U5.9 --unit sm2/U5.9
jobs.py queue add --session s2-coord --id U5.9-r1 --priority P2 --title "U5.9 review r1" --dispatch auto \
    --kind review --engine codex --model gpt-6.1-sol --effort high --brief .../u-U5.9/U5.9.review.md \
    --report .../u-U5.9/review-r1.md --cwd .../wt-U5.9 --unit sm2/U5.9 --after U5.9-a
```

`--after U5.9-a` is stored as `s2-coord/U5.9-a`. The review starts once the author job is DONE with exit 0. The graph
ends at the review: nothing may depend on a review item (§3.3), so a NOT CLEAN verdict cannot start anything. The review
job's exit reaches s2-coord through job_watch, and the coordinator adjudicates and enqueues the fix and the next review.
CLEAN → the coordinator appends the unit to `land-queue.txt`, and land_runner lands it. Cross-unit "landed" dependencies
stay with land_runner (`land_runner.py:181-196`).

## 4. Task kinds and budgets

A data file beside the script, `~/.claude/scripts/dispatch-kinds.json`: one entry per existing WORK_KIND. Changing a
default is a one-file edit. An item may override `model`/`effort`, but not the budgets. Default wall budgets are about
2x the measured p90 duration (`probe/durations.py 7`: Opus p50 17 / p90 81 min, Sonnet 9 / 62, Codex 10 / 23).

The context hook reads warn and stop **as a pair**: if `0 < warn < stop` does not hold, it silently uses its defaults
250K/300K (`subagent_context_cap.py:154-163`). `probe/cap_env.py` (runs the hook's own `thresholds()` with a fake HOME):
`{STOP: 150000}` alone → (250000, 300000), the 150K budget lost; `{WARN: 120000, STOP: 150000}` → (120000, 150000). So
the tick always passes **both** variables, and `CONTEXT_CAP_ENFORCE=1` is set by detach_job for Claude
(`detach_job.py:790`). The kinds file is checked at every tick start: any Claude kind without `0 < warn < stop` is a
config error, and the tick admits nothing (sweeps still run).

| Kind | Default engine / model | Context warn / stop (Claude) | Wall budget | Notes |
|---|---|---|---|---|
| author | claude / sonnet | 250K / 300K | 120 min (Opus 180) | Opus needs `hard:` in the brief (gate) |
| fix-round | claude / sonnet | 250K / 300K | 120 min (Opus 180) | Same |
| review | codex / gpt-6.1-sol, high | n/a | 60 min | Never the author's vendor (rule; not enforced here) |
| diagnose | claude / opus | 250K / 300K | 180 min | Always needs `hard:` |
| doc | claude / sonnet | 120K / 150K | 60 min | |
| spike | claude / sonnet | 250K / 300K | 120 min | |
| other | claude / sonnet | 250K / 300K | 120 min | |
| land | refused for auto/shadow at `queue add` | — | — | land_runner owns landing |

Budgets enforced in software: context (hook via env), wall clock (tick sweep), Opus marker and Claude quota (gate),
concurrency (tick caps). Not enforced: dollars per job (report-only via `usage_watch weekly`, consistent with
`work-model.md` item 7, "$ is report-only" when quota readings are valid).

## 5. Ledger: one home, one writer per piece of state

### 5.1 Writers

| State | File | Only writer | Readers |
|---|---|---|---|
| Queue items (incl. new fields, `start`/`drop`) | `~/.claude/session-state/jobs/queue/<session>.jsonl` | `jobs.py` (`_queue_update`, one lock, `jobs.py:529`) | tick (CLI read), sm_status, precompact hook |
| Job registry rows (add/done) | `~/.claude/session-state/jobs/<session>.jsonl` | `jobs.py` (`add` called by detach_job; `done` called by job_watch auto-close or by hand, `jobs.py:414`) | job_watch, wake_check, usage_watch, sm_status |
| Process truth, job state | detach index `~/.claude/session-state/detached/<label>.json` + per-job meta/exit (`detach_job.py:13-16`) | `detach_job.py` | tick, job_watch, usage_watch |
| Watch offsets and pending events | `~/.claude/session-state/job-watch/` | `job_watch.py` | sm_status, wake_check (lock probe) |
| Tick decisions | `~/.claude/logs/dispatch.log`, `session-state/dispatch/last-tick.json` | `dispatch.py` | sm_status, people. **Never read back by the tick** |
| 2.0 unit stamps | `queue/work/live.json` | `stamp.py` (unchanged; `stamp.py:208` `cmd_sync` writes it) | gen.py, people |
| 2.0 landing | `land-runner-state.json` | `land_runner.py` | stamp.py sync, people |

No new ledger file is created. The tick keeps no state between runs: holds, readiness and inventory are recomputed every
tick from the queue, the index and the exit records.

### 5.2 How rows migrate

Nothing migrates in bulk. The registry and queue formats stay as they are. New queue fields are extra keys on the `add`
record. Today's validator checks only the fields it names (`_queue_problem`, `jobs.py:464-484`), so an extra key does not
get a record refused. The fold, however, copies a fixed key list (`jobs.py:506-510`), so S1 extends the fold. Until then,
readers see the new rows as plain manual items, which the tick ignores. Items already in flight keep their manual
dispatch. A project moves to the queue by enqueuing its next units as `shadow` (S2) and later `auto` (S3).

### 5.3 Stamps: one named event each, no second store

| Stamp | The event it measures | Source (read-only) |
|---|---|---|
| `queued_at` | the item was written to the queue | queue `add` record ts (jobs.py) |
| `ready_at` | the last dependency finished, i.e. the item could have started | max(`queued_at`, each dependency's `finished_at`). Derived, never written. Not the queue add time when dependencies were still running |
| `dispatched_at` | the process was launched | the job's meta `started_ts` (detach_job); queue `start` ts as a fallback |
| `finished_at` | the job's process exited | the exit file's mtime (the same dead time job_watch uses, `job_watch.py:15`) |
| `collected_at` | the owning session's watcher delivered the exit and the registry row closed | registry `done` ts (`job_watch.py:13-14`). It measures collection delay, not completion |

Wait = `dispatched_at − ready_at`; collection lag = `collected_at − finished_at`. **`live.json` keeps its existing
semantics and writer:** stamp.py stays its only writer, and its `ready_at` (dependencies landed, `stamp.py:195-204`) is
a different event from the queue's `ready_at` above. Per-unit rule: a unit dispatched by hand keeps today's stamp.py path;
a unit dispatched through the queue gets its stamps from `dispatch.py stamps <qref>` (S2, read-only), and S4 lets
`stamp.py sync` copy those into `live.json` with `stamp_source: queue`. The S3 pilot reads `dispatch.py stamps`, which
ships in S2, before it.

## 6. Failure modes (only where the tick acts)

| Failure | Detection | Response |
|---|---|---|
| Two ticks at once (manual + launchd) | tick flock | Second exits 0 with a log line |
| Crash between launch and `queue start`, or `queue start` fails (detach_job warns only, `detach_job.py:733`) | Step 2: open item whose label has an owned index entry (branch 6) | Adopt (`queue start`), never relaunch. Runs before any admission check, so a full cap or closed quota cannot block it. The job is already in the sweep (step 3) and the inventory (step 4) |
| Label held by another job | Step 2 ownership check fails (branch 3) | Hold `label-collision`; never adopt, never stop, never use as a dependency's DONE, never launch. Counted in the inventory if live |
| Job relaunched under the label between check and stop | `detach_job.py stop --expect-mark` (S3) compares the mark under the label lock | Stop refused, logged; next tick re-checks ownership |
| Unreadable index entry or directory | Step 2 branch 2; §3.6 | Item and dependents held; the entry reserves a slot in every cap dimension; an unlistable directory admits and stops nothing |
| Launch aborted before the engine started | Index state `ABORTED` | Hold `launch-aborted`; a person re-adds it. No retry |
| Missing exit evidence on a dependency | DONE with no exit record | Hold dependents `missing-exit-evidence` |
| launchd env drift (PATH, proxy, keychain/OAuth) | Each tick: `claude --version` / `codex --version` prove only that the binary is on PATH. Authenticated execution is proved by A1 once, then watched by the engine breaker below | Binary missing → admit nothing for that engine |
| Engine breaker trips | Derived every tick, never stored: the 2 most recently finished detach jobs of one engine, of **any** origin (queue or hand-launched, ordered by `started_ts`), both ended `ABORTED`/`FAILED*` within 5 min of their start | Hold that engine's items (`engine-breaker`), log, and `owner_queue.py add` once (owner_queue dedupe unverified; the tick first lists open items for the same id) |
| Engine breaker recovery | **Evidence:** a newer detach job of that engine, started after the second failure, that ends DONE with exit 0 and a report. It is written by detach_job (meta and exit file), the existing writer; the tick only reads it, so the breaker clears itself on the next tick | **Who:** the coordinator, after the alert, fixes the cause (e.g. logs the seat in again) and runs the recovery probe by hand: `dispatch.py probe-engine <engine>` prints a `detach_job.py run` command for a fixed one-line probe brief with the A1 pass criteria, and the coordinator runs it from its own session, so the shim gates it and it registers under that session. Any ordinary hand launch that succeeds also clears it. The coordinator then closes the alert with `owner_queue.py close` (`owner_queue.py:339`); the tick never closes it |
| Gate exception or timeout | `judge()` raises, or no answer in 30 s | Hold `gate-error`, logged; other items continue |
| Dependency failed | Index state of the dependency | Item held with the state as reason. The coordinator already got the dependency's EVENT |
| Over wall budget | Step 3 sweep | `detach_job.py stop`; job_watch reports the exit |
| Quota gate denies every account | `judge()` | Hold all Claude items; no wake (the usage-watch alerts already fire) |
| Disk < 100 GB | `shutil.disk_usage` | Admit nothing; sweeps still run; job_watch and disk_watchdog already alert |
| Queue file torn or unreadable | CLI diagnostics (step 1) | That file's items held; cross-session dependents held; healthy items proceed (§3.4 Read health) |
| Kinds file invalid (e.g. warn ≥ stop) | Tick-start check | Admit nothing, log; sweeps still run |
| Kill switch | `DISPATCH_TICK=0` env in the plist, or `launchctl bootout` | Tick exits 0 at once, logged. Off means off: sweeps stop too |

## 7. Open owner decisions

Re-derived from old O1–O10. Owner calls are written as open decisions; none is decided here.

| # | Decision | Plain-English recommendation |
|---|---|---|
| O1 (was O1) | Where the tick runs: a launchd timer every 5 min, or the coordinator typing `dispatch.py tick` on its check-ins | **launchd timer, if probe A1 passes.** Same pattern as wake-check and usage-watch, and it takes dispatch turns off the coordinator. If A1 fails, the coordinator types the tick: still one command instead of one dispatch per unit, and then the shim also judges each Claude launch, because the tick runs inside a session |
| O2 (was O8, reframed) | **Concurrency caps (money):** how many jobs at once in total, per engine and per model. (O2b) whether caps must also cover launches outside detach_job. (O2c) whether Codex items get the same 90% quota hold as Claude | **Run the shadow pilot (S2) for 2 days, read what it would have held, then pick numbers.** Measured 7-day peak: 28 total, 13 Opus, 17 Sonnet, 11 Codex (upper bounds). Placeholder until then: global 20, Opus 8, Codex 8. The Opus cap is the only real spend lever here. O2b: **no for v1**, measure the uncounted share first (A8). O2c: **yes, report-only during S2**, since Codex is the scarce quota (`no-claude-coding.md` 2026-10-08 amendment) |
| O3 (was O3) | Which work goes through the queue first | **The 2.0 build's remaining units.** They already have brief pairs, worktrees from `prep_unit.sh`, a machine-readable verdict line and land_runner. stock-trader waves second |
| O4 (was O4, widened to both engines) | **Security:** may a timer start jobs with nobody watching each launch, using today's flags? Claude: `--dangerously-skip-permissions` (no tool prompts), `--settings {"enableAllProjectMcpServers":true}` (every MCP server in the cwd's `.mcp.json` is approved), `--disallowedTools=Agent` (a restriction), env `CONTEXT_CAP_ENFORCE=1`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (skip-permissions and settings at `detach_job.py:536-537`, env at `detach_job.py:790-793`). Codex: `--dangerously-bypass-approvals-and-sandbox` (no approvals and **no sandbox**: full filesystem and network, `detach_job.py:544-545`) | **Automatic launches of either engine stay off until this is answered** (S3 needs it). Recommendation: yes for both, only for items a session queued as `auto`, and only when the item's `cwd` is inside an allowlisted project root in `dispatch-kinds.json`. The queue `add` becomes the "look" a person used to give each launch. A stricter option is to run Codex reviews sandboxed (they only write a report), but that changes detach_job and is unverified to work; worth a separate probe, not a v1 blocker |
| O5 (new) | Code home: `~/.claude/scripts/dispatch.py` beside jobs.py, or the stratum repo | **`~/.claude/scripts`.** Every dependency lives there, stdlib Python, existing tests dir. The stratum feature folder stays the design home. Not money or security: the coordinator may decide unless the owner objects |
| O6 (new) | Fairness across projects when caps bind (trader vs SmartMemory) | **None in v1: priority level, then oldest first** (`jobs.py:604-614`). Revisit only if the shadow data shows one project starving |

Dropped as moot: **O2 old** (Stratum engine vs ring-1 scheduler: neither; the owner chose scripts), **O5 old** (daemon-down
fallback: no daemon; a missed tick only delays dispatch), **O6 old** (wake channel: reuse job_watch + wake_check), **O7 old**
(one service per user: jobs.py is already global across projects, so it is one queue), **O9 old** (service-written resume
packet: the precompact hook already includes queue items), **O10 old** (auto-flush placement: compaction replaced flush).
**O8 old** is not reopened: quota % is the admission unit, and $ is report-only (`work-model.md` item 7, owner 2026-10-09).

## 8. Assumptions to prove

| # | Assumption | Status | Probe and pass criteria |
|---|---|---|---|
| A1 | The tick's launches work from launchd: binary on PATH **and** authenticated execution, for each engine | **Unverified.** No shipped launchd job runs claude or codex (`usage_watch probe` is CLI-invoked, `usage_watch.py:1411`; the usage-watch plist runs `snapshot` only) | In S2, a one-shot LaunchAgent (RunAtLoad, no interval) runs **the tick itself** live on one test item per engine (`dispatch.py tick --only <qref>`), on seat2. Claude pass: detach state DONE, exit 0, report written, a transcript with `entrypoint: sdk-cli` under `~/.claude-seat2/projects/`. Codex pass: DONE, exit 0, report written, no `invalid_request_error` in the log. `--version` alone is not a pass. Remove the plist afterwards. If A1 fails, O1 falls back to the typed tick, and S3 can still run |
| A2 | Who launches the 45% of sdk-cli spend that is not detach_job | **Measured share, launcher unverified.** $990/24 h unmatched, $967 of it stock-trader (`probe/job_cost_join.py 24`); not in the detach index or Stratum agent runs (`probe/trader_origin.py`) | Read the first `operation` records and parent process of a live stock-trader headless session (`ps -o ppid,command`), or ask trader-main which script it uses. Pass = the launcher is named |
| A3 | Coordinator dispatch turns are a material cost (the queue's main saving) | **Unverified** | Through `costlib.iter_calls`, sum s2-coord and trader-main calls whose tool input contains `detach_job.py run` or `prep_unit.sh` over 24 h |
| A4 | Peak concurrency numbers in O2 | Measured, upper bound | `probe/concurrency.py 7` |
| A5 | `judge()` on the §3.5 packet, with `CLAUDECODE` unset, gives the hook's decision for the packet's target seat | **Believed** (the hook builds the same `Launch` for a typed detach_job command, `work_model_gate.py:1091-1092`) | S1/S2 tests, all with `CLAUDECODE` unset and a fixture usage reading: (a) a Sonnet packet for a seat whose 5h reading is ≥ 90% and not reset is denied, while the same packet for an open seat is allowed; (b) an Opus packet whose brief lacks `hard:` is denied by the Opus gate; (c) each packet gives the same decision as the hook on the equivalent typed `detach_job.py run` command; (d) `judge()` raising gives `gate-error` and no launch |
| A6 | New queue keys do not get existing rows refused | Verified by reading: `_queue_problem` checks named fields only (`jobs.py:464-484`); the fold drops unknown keys (`jobs.py:506-510`) | S1 test: a row with new keys folds as a manual item under the old fold and as an auto item under the new one |
| A7 | Wall budgets at about 2x p90 kill few legitimate jobs | Derived from `probe/durations.py 7` | S2 shadow pilot logs would-stop events before stops are enabled |
| A8 | Most concurrent work is visible to the caps (detach_job) | **Unverified** | During S2, each tick also counts `claude -p` and `codex exec` processes (`ps`) and logs counted vs uncounted. Report the uncounted share for O2b |
| A9 | The session-id join prices detach jobs by kind | Join shown to work in aggregate (`probe/job_cost_join.py 24`) | S0 acceptance on one real tagged job (§9) |
| A10 | `codex exec` with `CODEX_HOME=<dir>` takes its login from `<dir>` and writes its sessions under `<dir>/sessions` | **Unverified.** The variable exists in codex-cli 0.159.0 with default `~/.codex` (binary strings, §3.5) | (a) `CODEX_HOME=~/.codex codex exec` on a one-line prompt writes a new session file under `~/.codex/sessions`; (b) the same with `CODEX_HOME=<empty scratch dir>` fails with a login error and writes nothing under `~/.codex`. Delete the scratch dir after. Until both pass, Codex items whose account home is not `~/.codex` are held (`codex-account-unbound`) |

## 9. Migration slices (smallest first, each useful alone)

| Slice | Delivers | Useful alone because | Size |
|---|---|---|---|
| **S0 Tags + cost join** | `detach_job.py run --work-kind <kind>`; detach_job forwards `--work-kind`, `--vendor <engine>`, `--model <model>` and `--account <id>` to `jobs.py add`, with the account **resolved per engine**: Claude from `CLAUDE_CONFIG_DIR` (default `~/.claude`), Codex from `CODEX_HOME` (default `~/.codex`), each matched against the accounts-file rows of that vendor (`usage-watch.accounts.json:2`); no match → `--account unknown`, never a guess. Today the meta records `config_dir` for Claude only (`detach_job.py:848-851`); S0 records `account` and `account_home` for both engines (used by the ownership check, §3.3). `usage_watch weekly` joins a detach job's stream-log init `session_id` to costlib's session id, in addition to the session-name join. The `usage-watch.md` line that says "launch with `detach_claude.py`" points at detach_job. **Acceptance:** one real tagged detach job's joined cost equals its transcript's costlib total within 1%, and the weekly table shows it under its kind, model and account. Codex jobs get the same tags; per-kind Codex pricing is not claimed by S0 | `usage_watch weekly` can price work kinds for the 55% of headless spend that runs through detach_job | ½–1 day |
| **S1 Queue fields + validation** | §3.3–3.4 fields on `jobs.py queue add`: qualified `after` and `unit`, stored `label` and `brief_sha256`, `land` refused, review `unit` required, the `queue resolve --account` op (open items only); fold extended; `queue list --json` shows them; A5 (a–d) and A6 tests | Coordinators can write the whole graph once, validated, instead of remembering the next step | 1 day |
| **S2 Tick dry-run + shadow pilot + stamps** | `dispatch.py tick --dry-run` on launchd; `dispatch.py cmd <qref>` prints the exact `detach_job.py run` command for a shadow item (the §3.5 packet); `dispatch.py stamps <qref>` (§5.3); A1 probe; A8 counts. **Workload:** coordinators enqueue their real next units as `shadow` items and launch them by hand with the printed command, which carries `--queue-id`, so real starts, dependencies and running jobs exist. **Acceptance:** 2 working days; at least 15 shadow items from at least 2 sessions; every tick logs would-admit / would-hold (with reason) / would-stop; a report table with the peak inventory per engine/model, would-holds by reason, would-stops by kind, and median `dispatched_at − ready_at` (time a person took vs a 5-min tick) | Gives O2 its numbers and A7/A8 their data with no automatic launch. `dispatch.py cmd` and `stamps` are useful by hand even if S3 never ships | 1–1½ days + 2 days pilot |
| **S3 Tick, live** | Admission + launch enabled for `auto` items, plus `detach_job.py stop --expect-mark` (§3.2 step 3). Requires: O2 and O4 answered, and **either** A1 passed (launchd tick) **or** O1 = typed tick. Pilot on the 2.0 build (O3) for 2 working days | Removes dispatch turns; enforces caps and wall budgets | 1 day + 2 days pilot |
| **S4 Read-side polish** | sm_status panel for holds (reads `last-tick.json`); `stamp.py sync` copies queue stamps into `live.json` with `stamp_source: queue` (§5.3) | One place to see why work is waiting | ½ day |

**Pilot pass criteria (S3):** zero double launches; zero adopted-wrong-job (every adoption passed §3.3); zero queue-launched
jobs missing a registry row; every held item has a logged reason; s2-coord dispatch turns down (A3 metric) with no rise
in median `dispatched_at − ready_at` against the S2 baseline.

## 10. Non-goals

- No daemon, socket, MCP thin client or Stratum engine host. No new ledger file.
- No auto-adjudication, fix-brief writing or retries of failed or aborted jobs: judgment stays with sessions.
- No landing, pushing or deploying from the queue (land_runner and people keep those).
- No new wake channel, herdr bridge or flush integration.
- No per-job dollar enforcement. Quota % stays the admission unit.
- No gating or counting of launches outside detach_job in v1 (O2b).
- No multi-host workers. No Temporal or RabbitMQ.
- STRAT-FLOW-DETACH is not absorbed and not edited by this feature.
