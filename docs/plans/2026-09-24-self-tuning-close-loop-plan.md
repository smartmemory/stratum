# Self-Tuning: Verify Collection, Then Close the Lessons Loop — Plan

**Status:** IN_PROGRESS (Step 1) · **Created:** 2026-09-24 · **Owner:** stratum (compose touch points noted)
**Review:** Codex gpt-6-astra/medium — r1 NOT CLEAN (3H/4M, all upheld on spot-check), r2 REVIEW CLEAN.

**Progress (2026-09-24):** 1a/1b DONE → [collection report](2026-09-24-self-tuning-collection-report.md).
1c test isolation DONE: compose `798f1b7`, stratum `e643734` (stratum full suite 1802/1802, 0 real-store
writes). **Resume here:** (1) compose full suite once (`node --test` glob + `npm run test:ui`, stopped
by owner, not failed); (2) quarantine is NOT done — needs owner OK on the manifest; (3) 1d gate: owner
decisions on lesson set, trigger (report recommends `emitFlowTerminal` pre-early-return), which other
1a defects to fix (Claude cost presence, distill sources, fanout harvest, routing reported effort),
routing loop stays shadow.

## Related Documents

- [`STRAT-LEARN-INLINE-TS-1/design.md`](../features/STRAT-LEARN-INLINE-TS-1/design.md) — the automatic
  trigger (Step 2a implements it; Step 1 must first resolve the trigger-source conflict below)
- [`STRAT-TS-LEARN/design.md`](../features/STRAT-TS-LEARN/design.md) — harvest/classify/candidate/apply
  machinery (reused as-is)
- [`STRAT-ADMIT/design.md`](../features/STRAT-ADMIT/design.md) — admission critics (DESIGN only; v1 of
  this plan substitutes human approval, see Step 2b)
- [`STRAT-LEARN-COST-1`](../features/STRAT-LEARN-COST-1/design.md) — Claude `costUsd = 0` receipt gap
- compose [`COMP-MODEL-ROUTE/progress.md`](../../../compose/docs/features/COMP-MODEL-ROUTE/progress.md),
  [`COMP-MODEL-ROUTE-2`](../../../compose/docs/features/COMP-MODEL-ROUTE-2/design.md) — routing loop (gated, not built here)
- compose [`COMP-OUTCOME-ENUM-1`](../../../compose/docs/features/COMP-OUTCOME-ENUM-1/) — hand-fix of a lesson the
  harvester had already found; used in Step 1 as a staleness test case

## Why

Audit of 2026-09-24 (Codex astra read-only, key claims re-verified by the controller): every self-tuning
loop **records** but none **consumes**. Compose routing is locked to shadow with a pinned empty table
(`compose/lib/model-router.js:113-117`; ledger 24 rows, 0 `source=learned`). Stratum's lesson harvester
only runs from the CLI (sole importer `ts/src/cli/learn.ts`), applies only to `.stratum/learn/NOTES.md`
(`ts/src/learn/candidate.ts:58`), and nothing reads that file back. Flipping flags does not close any loop.

Scope decision: close the **lessons loop** first (smallest, has 3 real lessons already). The routing loop
stays in shadow unless Step 1's gate shows enough clean data (22 issuances today: 2 positive / 11
negative / 9 excluded, and the 2026-09-23 tier change makes older rows describe models no longer chosen).

---

## Step 1 — Analyze the results; make sure collection is good

Goal: every collector writes **real, attributable, uncontaminated** data, and we know what the
current data actually says. Nothing new is wired to decisions in this step.

Dispatch: Codex `gpt-6-astra/medium`, read-only for 1a–1b; workspace-write for 1c fixes. Controller
verifies each finding against disk before any fix is briefed.

### 1a. Collector audit (one row per collector: source, volume, contamination, defects)

- [ ] **Flow store** (`~/.stratum/ts/flows`, 1,487 runs): quantify test-fixture vs real runs
      (by workspaceRoot / tmp paths / flow names). Confirm the suspected cause: `StateStore` defaults to
      `homedir()/.stratum/ts/flows` (`ts/src/engine/state.ts:309`) and `ts/vitest.config.ts` sets no
      state-root override, so tests write into the store the harvester reads.
- [ ] **Routing ledger** (`compose/.compose/routing/ledger.jsonl`): explain why **every executed tier
      is null** (audit finding) — collection defect or by design in shadow? Confirm outcome labels
      (positive/negative/excluded) match the downstream-acceptance definition in the design.
- [ ] **Usage receipts** (285, all `pending` egress): classify Claude receipts into missing provider
      cost / explicit zero / positive reported cost (`claude.ts:178` assigns `raw.total_cost_usd`; `:71`
      is only initialization — positive reported receipts exist) / fixtures / pre-fix versions. Bound the
      COMP-MODEL-ROUTE-2 inflated-cost window from actual receipts and the relevant stratum revisions.
      Record, don't fix, unless trivially one-line.
- [ ] **Transcripts for distill**: stratum's default transcript dir has 0 files while compose's has 68 —
      confirm whether distill is pointed at the wrong directory for stratum.
- [ ] **Judge events**: confirm the store holds zero `judged` events and why.

### 1b. Re-harvest and read the lessons

- [ ] Run `stratum learn` harvest from each **repo root** (not `ts/` — see STRAT-LEARN-INLINE-TS-1
      caveat) on real-only data; list durable clusters with evidence counts and date ranges.
- [ ] **Staleness test:** the `outcome`-enum lessons were hand-fixed by COMP-OUTCOME-ENUM-1. Do they
      still recur after that fix date? If the harvester keeps surfacing a fixed lesson, record it — Step 2
      must handle retirement.
- [ ] **Resolve the trigger-source conflict:** STRAT-LEARN-INLINE-TS-1 says "judge-path `must-fix`
      verdicts trigger harvest", but the harvest source is `result`-event failures, not `judged` events
      (`STRAT-TS-LEARN/design.md:64`) and the store has zero judged events. Decide the real trigger
      (candidate: flow completion with ≥1 step failure) and amend that design before Step 2.

### 1c. Fix collection defects found in 1a

- [ ] Test isolation in **both repos**: an env var alone is insufficient — `StratumEngine` passes only
      `options.stateRoot` to `StateStore` (`engine/engine.ts:386`) and `StateStore` defaults to
      `homedir()` with no env override (`engine/state.ts:309`). Audit direct engine constructors,
      subprocess and MCP tests in stratum and compose; pass isolated roots explicitly. Regression test
      asserts the production store's **contents** (run-id set + hashes) are unchanged by a test run.
- [ ] Step 1b harvests from a **read-only filtered corpus** (real runs selected by manifest), not a
      mutated store, until classification is verified.
- [ ] Quarantine only after: an attributable fixture manifest (run id, reason, hash, restore path);
      ambiguous, resumable, and lease-owned/live runs (`engine/run_lock.ts:383-405`) excluded. Move to
      `~/.stratum/ts/flows.fixtures/`, never delete; restoration tested on one run first. Controller
      runs it, not Codex.
- [ ] Any other defect from 1a gets its own brief; one-line fixes allowed inline.

### 1d. Gate — report and decide (owner)

- [ ] Evidence report `docs/plans/2026-09-24-self-tuning-collection-report.md` (new): per-collector
      table, contamination numbers before/after, the lesson list, the trigger decision.
- [ ] Owner decision 1: confirm the lesson set and the Step 2 trigger.
- [ ] Owner decision 2: routing loop — stays shadow (default) or gets its own S2 plan, based on clean
      post-2026-09-23 row counts.

**Exit criteria:** real-only store, a named trigger, a lesson list the owner has read.

**Gate outcome (owner, 2026-09-25):**
- Quarantine: **move aside** with manifest (ambiguous/resumable/lock-owned excluded).
- Trigger: **any terminal run**, including recovered failures — hook `emitFlowTerminal()` before its
  `bundle_id === undefined` return (report §Trigger). STRAT-LEARN-INLINE-TS-1 design to be amended.
- Lesson set: the 3 durable lessons are all fixed by hand (compose `ed8e333`, stratum `2968930`) —
  they become **retirement fixtures** for 2d, not lessons to deliver.
- Additional 1c fixes, all four approved: fan-out failures into harvest; Claude missing-vs-zero cost;
  distill transcript source discovery; routing records reported/executed tier.
- Routing loop: **stays shadow**; no S2/S3 plan now.

**Quarantine DONE (2026-09-25):** 974 terminal fixture runs moved `~/.stratum/ts/flows/` →
`~/.stratum/ts/flows.fixtures/`, all hash-verified; live store 1,489 → 515 entries. Kept in place: 58 real
runs + 449 resumable/lock-protected fixtures (445 `gsd-stuck-resume` paused mid-gate) + 6 ambiguous.
Manifest, keep list and `restore.sh` (manifest SHA-256 `ffcc174d…`, pinned) at
`~/.stratum/ts/flows.fixtures.manifest-2026-09-25/`. restore.sh not executed. The 445 paused fixtures are
still in the harvest input — filter by manifest (`keep.jsonl` reason) until handled.

**1c data fixes (2026-09-25):** Claude missing-vs-zero cost + multi-source distill discovery `bd1041e`;
fan-out failures harvested, durability still per parent step `01c1545` + `67a9ea1`; routing executed
tier: compose labels known/unknown `a9d4695`, stratum Claude telemetry reports dispatched effort (this
commit). **Follow-up:** background Claude runs still drop effort (`connectors/background.ts:804` — owned
by the STRAT-AGENT-PEER-3 session at the time; not edited). **Step 1 COMPLETE.** Compose full suite on `798f1b7`: 7226 pass / 0 fail / 2 whole-file timeouts
under load (both pass standalone: build-wave-golden 16/16 in 322s, build-model-route-outcomes 34/34 in
380s); UI 624/624; 0 real-store writes.

---

## Step 2 — Wire it up and close the loop

Goal: a recurring failure produces a lesson **without anyone running a command**, the owner approves
it once, and the **next matching run's agent actually receives it** — and the failure stops recurring.

Dispatch: Codex `gpt-6-astra/medium`, workspace-write, one slice per brief. Each slice: brief →
implement → independent astra review → controller verify (targeted tests) → commit.

**Step 2 progress (2026-09-25):** design docs first, per owner. Doc A = STRAT-LEARN-INLINE-TS-1
§Amendment (trigger, staging, "show until acted on" surfacing) — astra r1 NOT CLEAN (12, all upheld;
surfacing redesigned), r2 NOT CLEAN (2 unresolved + 2 new, all fixed), **r3 REVIEW CLEAN**. Doc B = new
[`STRAT-LEARN-DELIVER-1/design.md`](../features/STRAT-LEARN-DELIVER-1/design.md) (guidance, selection,
matching, pin-at-issuance, lifecycle, retirement reviews, goldens; 6 implementation slices) — astra r1 NOT CLEAN (12; narrowed via trust model, lifecycle log, per-run
counting), r2 NOT CLEAN (1 unresolved + 2 new), r3 NOT CLEAN on one M (held predicate lost the
terminal-run requirement) — fixed by restoring that clause, not re-reviewed (review budget spent;
the clause restores r1-reviewed wording).
Designs committed `930a38e`. **DELIVER-1 slice 1 (guidance + template v2 identity) DONE `36c58d6`**
(review found ambiguous comma-join encoding → JSON element; 230/1-skip). **Slice 2 (lifecycle log +
canonical workspace + per-workspace lock) DONE** — review r1 3M (evidence roots not canonicalized,
submodules, inherited GIT_DIR), r2 2 new (unbounded git fan-out over ~450 temp roots, newline paths),
all fixed; 263/1-skip. **Slice 3 (selection, `activeLessons()` in `learn/select.ts`) DONE** — review
r1 2M: receipt throw aborted selection (fixed, per-entry catch); one-active-revision-per-cluster
rejected as intentional, documented in DELIVER-1 §D2; r2 REVIEW CLEAN; 290/1-skip. Owner 2026-09-25:
retire the 3 hand-fixed fixtures just before INLINE is enabled, not now. **Slice 4 (matching + pin +
render, D3/D4) implemented by Claude** (owner 2026-09-26: Codex credits exhausted; Claude implements in
worktree branch `strat-learn-deliver1-slice4`, Codex reviews after the credit window) — awaiting Codex
review. Round trip found a harvester gap: subflow failures are echoed onto the parent `run` step
(DELIVER-1 §D3 clarifications). **Owner 2026-09-26: do not push any of this to origin until the whole
Step 2 loop is done** (DELIVER-1 slices 1–6 and INLINE-TS-1); commits stay local until then. Grounding: astra read-only pass (session scratchpad `docB-ground.md`). Corrections to §2c found by
grounding: "committed" is a guard-ledger receipt class, not a journal state; the recovery fixer is not a
`buildStepPrompt()` call; no dispatched prompt is persisted today (DELIVER-1 D4 adds the pin).

### 2a. Automatic collection (STRAT-LEARN-INLINE-TS-1, amended by 1b)

- [ ] Trigger fires on the Step-1-chosen event, **after** the relevant events (including recovered
      failures) are persisted. Harvest reads the triggering engine's actual `StateStore.root` (custom
      `STRATUM_STATE_ROOT` via `mcp/server.ts:99` included); candidates are filtered and staged by the
      persisted run's `workspaceRoot`, never by cwd. If hooked on `emitFlowTerminal()`, the hook sits
      before its `bundle_id === undefined` early return (`engine.ts:3525-3526`). Tests: custom store,
      subdirectory and worktree execution.
- [ ] Switch resolves through the STRAT-CONFIG-PREFS-1 chain, reports its winning layer; default OFF;
      off-path byte-identical. Enabled for stratum + compose after verification.
- [ ] Fail-open: a harvest error can never fail the user's flow.
- [ ] Candidates are **staged only**; a staged durable lesson is announced to the human (flow result
      summary / `stratum learn list`) without them asking.

### 2b. Approval (human admission, v1)

- [ ] `stratum learn apply <revision_id>` stays the approval act; `STRATUM_LEARN_APPLY_ENABLED` is set
      for stratum + compose by the owner. STRAT-ADMIT's automated critics remain out of scope — the
      owner reading the lesson IS the behavioral-harmlessness check for v1 (per STRAT-TS-LEARN
      memory-class note: these notes are instructions, so nothing auto-applies).

### 2c. The reading edge (new — design section first, reviewed before code)

- [ ] **Selection contract.** Lessons are selected from the **canonical workspace's committed apply
      journal** (`apply/protocol.ts:25-39` records `revisionId`, state, snapshots), joined to the exact
      approved revision — never `latestPerCluster()` (`learn/candidate.ts:220`, newest *staged*, not
      approved) and never by parsing `NOTES.md` prose. Excluded: reverted, incomplete, retired. Content
      integrity checked against the journal digest. Notes located from the canonical workspace root,
      not the worktree cwd (`compose/lib/build.js:1762`). Behaviour defined for a lesson whose step
      contract changed since approval (suppress + flag for review).
- [ ] **Dispatch coverage matrix**, each row supported-or-excluded with a reason, and a prompt
      assertion test per supported row:
      stratum `readyStep()` (`engine.ts:2940`), `consumerDescriptor()` (`:2951`), engine-owned fanout
      render (`:2245`); compose `buildStepPrompt` ordinary dispatch (`build.js:5310`), worktree fanout
      (`:1763`), ambient-free budget re-render (`:1790`, `:5331`), recovery fixer (`:5240`); retries and
      subflows. Compose reuses its existing context-insertion machinery (`step-prompt.js:25,120`).
- [ ] Matching by workspace + `flowName` + `stepId`, with subflow/fanout identity defined; bounded size
      under a fixed heading. Recommended over promoting into CLAUDE.md/AGENTS.md (global, unscoped).
- [ ] Off when no lessons are selected: every prompt byte-identical.

### 2d. Retirement (review, not automatic removal)

- [ ] Clean runs *with the lesson injected* do not prove it is unnecessary. N clean matching executions
      (N from Step 1 data) raise a **retirement review** for the owner; removal requires evidence of a
      permanent fix (e.g. a contract/spec change — the COMP-OUTCOME-ENUM-1 case) or a controlled
      withdrawal check.
- [ ] Record actual matching executions and the injected revision ids per dispatch; skipped or
      unexecuted scopes don't count.
- [ ] Retirement and reactivation keyed by stable `cluster_id`: old evidence must not resurrect a
      retired lesson, and the existing-marker rejection (`learn/apply.ts:134-137`) must not block a
      legitimate re-approval. Reuse journal identities and guarded lifecycle patterns; whole-file
      `revertApply()` (`apply/protocol.ts:272-299`, refuses stacked changes) is NOT per-note retirement.

### 2e. Proof the loop is closed (golden flow, real engine, never mocked)

- [ ] Induce a recurring contract failure meeting `DEFAULT_THRESHOLDS` (≥2 runs **and ≥3 distinct
      run-step pairs**, `learn/classify.ts:30`) → lesson staged automatically → approval applied → next
      run's dispatched prompt contains the exact approved revision (assert on the recorded prompt).
- [ ] Causality: contract and task held constant; show failure **without** the lesson and success
      **with** it. Note that current notes describe a contract fix (`learn/candidate.ts:172-174`) — the
      rendered lesson must carry executable guidance for the agent, or this cannot pass.
- [ ] Negative cases: non-matching scope, unapproved revision, reverted revision, retired lesson — none
      injected.
- [ ] One live run on a real compose build = **delivery** evidence only, not proof of lasting prevention.
- [ ] CHANGELOG + STRAT-LEARN-INLINE-TS-1 status updated in the same commits; completion recorded via
      `record_completion`.

**Exit criteria:** the 2e golden flow passes, and one real lesson has been applied and observed in a
live prompt.

## Explicitly not in this plan

- Learned model routing (COMP-MODEL-ROUTE S2/S3) — gated by Step 1d.
- Scheduled distillation (STRAT-DISTILL-AUTO) and auto-installing skills.
- Retuning classifier thresholds (STRAT-LEARN-INLINE-TS-1 says they are calibrated; no evidence otherwise).
- STRAT-ADMIT automated critics.
