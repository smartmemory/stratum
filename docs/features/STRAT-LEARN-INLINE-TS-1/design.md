# STRAT-LEARN-INLINE-TS-1 — Surface harvested lessons automatically (the trigger, not the machinery)

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-09-16 · **Amended:** 2026-09-25 (trigger moved off the judge path — see §Amendment)
**Supersedes-in-part:** [`STRAT-LEARN-INLINE`](../STRAT-LEARN-INLINE/report.md) (SHIPPED 2026-06-08, Python)

## Related Documents

- [`2026-09-24-self-tuning-close-loop-plan.md`](../../plans/2026-09-24-self-tuning-close-loop-plan.md)
  — Step 2a implements this feature; the plan's 1d gate outcome is the owner decision behind §Amendment.
- [`2026-09-24-self-tuning-collection-report.md`](../../plans/2026-09-24-self-tuning-collection-report.md)
  — §Trigger recommendation: the evidence for the persisted terminal trigger.
- [`STRAT-LEARN-DELIVER-1/design.md`](../STRAT-LEARN-DELIVER-1/design.md) — the downstream half:
  selection of approved lessons, injection into dispatch prompts, retirement. This feature stages;
  that one delivers.
- [`STRAT-TS-LEARN/design.md`](../STRAT-TS-LEARN/design.md) — harvest/classify/candidate/apply
  machinery, reused as-is.

- [`STRAT-LEARN-INLINE/report.md`](../STRAT-LEARN-INLINE/report.md) — the Python v1 that shipped and
  then silently stopped firing. Its design/blueprint/plan remain the specification of intent.
- [`STRAT-CONFIG-PREFS-1`](../STRAT-CONFIG-PREFS-1/design.md) — the config layer that surfaced this,
  and the layered home this feature's switch belongs in.
- `git show python-legacy:src/stratum/judge/inline_learn.py` — the retired harvester edge.

## The finding

`STRAT-LEARN-INLINE` shipped 2026-06-08 as a **default-OFF automatic edge on the judge path**. The
user enabled it 2026-06-11, recording the preference in `compose/stratum.toml` (deleted 2026-09-16,
compose `b34b188`) *"so working-style lessons get harvested automatically instead of requiring
manual correction."*

**The 2026-07 TS cutover ported the machinery but not the trigger.** `ts/src/learn/` has
`harvest.ts`, `classify.ts`, `candidate.ts`, `apply.ts`. The only importer outside `ts/src/learn/`
is `ts/src/cli/learn.ts` — `harvest()` became an operator-invoked sweep. Nothing on the judge path
calls it, so the feature reverted to exactly the manual mode the preference was set to escape.

## The measurement (2026-09-16) — the machinery works; nobody is listening

Run by hand over the real flow store (`~/.stratum/ts/flows`, 1350 flows):

```
608 failure records (0 runs skipped, 0 events dropped)
1190 clusters → 4 durable
  stratum: 1 actionable    compose: 2 actionable
```

The classifier is conservative by design (`classify.ts`: keys on the violated contract, never the
offending value; refuses mixed or unattributed provenance; `durable` needs ≥2 runs and ≥3
run-step pairs). 4 durable from 1190 is the filter working, not failing.

**Measurement caveat, recorded so it is not repeated:** candidates are filtered by
`cluster.scope.workspaceRoot !== root` (`cli/learn.ts:70`). Running from `stratum/ts` rather than
`stratum` reports `0 for this project` and looks like a dead feature. Always harvest from the repo
root.

### The lessons it found are real

```
build: recurring schema failure on outcome (stratum)
  steps blueprint, explore_design, plan, verification returned approved/done/pass/revised/success
  where the contract allows complete/failed/skipped — 14 times across 2 runs / 6 pairs.
  Every one recovered on retry, so each cost an extra agent dispatch and nothing surfaced it.

build: recurring schema failure on outcome (compose)
  steps docs, explore_design returned exists/short_circuited_existing_approved_design/success
  — 9 times across 8 runs / 9 pairs.

build: recurring schema failure on commit_hash (compose)
  steps docs, explore_design returned null where the contract allows string
  — 7 times across 6 runs / 7 pairs.
```

**The third one is the proof of cost.** That is the same defect the CHANGELOG records being fixed by
hand on 2026-09-15 ("the canonical case is an agent reporting that it made no commit as
`commit_hash: null`", flow `00540397-0bec-4aa5-b6d5-2eb5634f7201`). The harvester had seven
attributed occurrences of it. No human ran the command, so the bug was found the expensive way,
months later, from a single failing run.

**This is not a yield problem. It is a delivery problem.** The lessons exist and are good; the only
thing missing is that something has to *say* them without being asked.

## Scope

Restore the automatic surfacing. Reuse `ts/src/learn/` as-is — this is wiring, gating and delivery,
not a reimplementation of the classifier.

- ~~Re-establish the harvester edge on the judge path.~~ **KILLED (2026-09-25):** the judge path is
  the wrong trigger — see §Amendment A1. Guard transitions stay excluded (a lifecycle gate is not a
  dev-work diagnosis); the new trigger excludes them structurally.
- Express the switch through the STRAT-CONFIG-PREFS-1 chain, not a new bare env var. It is that
  layer's second citizen and a natural test of it.
- Default OFF, matching Python v1. Candidates are staged and described, never applied.
- **Harvest from the workspace root, not the cwd**, or the scope filter silently yields nothing.

## Amendment (2026-09-25) — trigger on persisted terminal runs

Owner decision at the self-tuning plan's 1d gate: **trigger = any terminal run, including recovered
failures.** This section replaces the judge-path trigger. Everything above it stays as the record of
why the feature exists. Revised after Codex review r1 (NOT CLEAN, 12 findings, all upheld): the
surfacing model changed from "announce once" to "show until acted on" (§A5), which removed the
cross-process pending/ack machinery r1 showed the first version would have needed.

### A1. Why the judge path was wrong

- The harvester does not read judge verdicts. It reads `result` events carrying
  `detail.failure`, `budget_exhausted` events, and (since `01c1545`/`67a9ea1`) fan-out attempt
  failures — `ts/src/learn/harvest.ts:104-172`. A judge-path trigger fires on a signal the harvester
  never consumes.
- The live store holds **zero `judged` events** (collection report C5). A judge-path trigger would
  never fire.
- All 14 stratum failure records in the durable `outcome` cluster **recovered on retry**. A trigger
  on terminal *failure* would miss the whole waste story the feature exists to surface.

### A2. The hook

The first statement of `StratumEngine.emitFlowTerminal()` (`ts/src/engine/engine.ts:3525`),
**before** its `if (run.bundle_id === undefined) return;` (`:3526`). That early return exists for
policy events and must not gate learning — most runs carry no bundle.

Every terminal path persists before it calls the hook, and `persist()` awaits an atomic
write-and-rename (`engine.ts:3613-3624`, `state.ts:313-319`), so the hook always sees committed state:

| Terminal path | persist → hook |
|---|---|
| Terminal gate completion | `engine.ts:1408 → :1409` |
| Ordinary completion | `:1630 → :1631` |
| Budget exhaustion | `:3470 → :3471` |
| Cancellation | `:3489 → :3490` |
| Failure | `:3502 → :3503` |

Rules:

- **Fires on** `completed`, `failed`, `cancelled`, `budget_exhausted`, on every terminal run — no
  clean-run short circuit (r1 #8: a shortcut assumes a prior successful sweep that nothing
  guarantees; historical evidence would sit unprocessed behind clean runs). Paused and gate-waiting
  runs are not terminal and do not fire. Subflows settle into their parent run and do not fire
  separately — one trigger per top-level run.
- **Excluded, by design:** checkpoint revert onto a terminal state (`revert()` persists then
  `reAdvanceLocked()` returns early for non-running runs, `engine.ts:1011`, `:1421`). A revert can
  only restore or remove events, never add failure evidence, and because every trigger harvests the
  whole store, the next trigger reconciles it. Guard transitions never reach `emitFlowTerminal()`.
  A test pins each exclusion.
- **Off means off.** With the switch off the hook returns after the config read and does no other
  I/O; engine responses, persisted runs and audit output are byte-identical to today.
- **Not on the response path.** The hook enqueues and returns; `emitFlowTerminal()` stays
  synchronous and `return this.response(run)` is unchanged. Precedent for fire-and-forget
  post-persist work: `triggerLearnEgress` (`:3541`, scheduled from `persist()` at `:3617`).
- **No shutdown drain.** Every pass reconciles every enabled workspace in the store (§A3), not only
  the roots that triggered it, so a pass lost to process exit is redone by the next trigger from
  *any* workspace (r2 #10). A crash mid-append can leave an unterminated last line; `appendCandidates()`
  terminates it under the lock before writing (§A4), so the next write is never glued onto a
  fragment. Tests await a `learnInlineIdle()` promise instead of a drain.

### A3. What it reads, where it writes

- **Reads `this.store.root`** — the triggering engine's actual store. That covers `options.stateRoot`
  and `STRATUM_STATE_ROOT` (`mcp/server.ts:99`). It never re-derives `homedir()/.stratum/ts/flows`
  the way the CLI does (`cli/learn.ts:61`).
- **Canonical workspace (r1 #3).** Compose passes `opts.cwd ?? process.cwd()` as `workspaceRoot`
  (`compose/lib/build.js:3570`, `:958`), the engine only `path.resolve()`s it (`engine.ts:590`), and
  clustering keys on the exact string (`classify.ts:153`). A build started from a subdirectory or a
  linked worktree would therefore split its evidence from the main checkout's. Observed 2026-09-25:
  the 64 real runs in the store all carry repo roots and zero worktree paths, but nothing enforces
  that. So one function, `canonicalWorkspace(path)`, resolves: git common dir → its main worktree
  root; not a git repo → the path unchanged. Cached per input path. Applied **everywhere a root is
  compared or used**: to each `FailureRecord.workspaceRoot` before `classify()` (records are data;
  `harvest.ts`/`classify.ts` stay unchanged), to the trigger root, to the config project layer, to
  the sidecar location, and to the CLI's `rootOf()` — which also retires the `stratum/ts` vs
  `stratum` measurement caveat above.
- A run with no `workspaceRoot` stages nothing and is recorded in the diagnostic log (§A5).
- **Stages for every enabled workspace, every pass.** A pass harvests the whole store, then for each
  distinct canonical `scope.workspaceRoot` among the durable clusters: resolves the switch for that
  root (§A7) and, if on and the root is an existing directory (never created), stages its clusters.
  The triggering root has no special status — the trigger is only the signal that the store changed.
  This makes each pass a full reconcile and is what makes the no-drain rule sound. Staged clusters
  must be `durable` and `applyEligible`, into the existing sidecar
  `<canonical root>/.stratum/learn/candidates.jsonl` via `appendCandidates()`. It never applies;
  `STRATUM_LEARN_APPLY_ENABLED` still governs that. Note `.stratum/` is gitignored
  (`stratum/.gitignore:24`): sidecars are per-machine.
- **Lifecycle suppression.** Before staging, each cluster is checked against the lesson lifecycle
  defined in [STRAT-LEARN-DELIVER-1 §Lifecycle](../STRAT-LEARN-DELIVER-1/design.md). A cluster whose
  lifecycle state is `retired` or `dismissed` and whose evidence all predates that transition is not
  staged. If the lifecycle cannot be read, the cluster is not staged and the error is logged (fail
  closed on *announcing*, which is the safe direction; the evidence stays in the store).

### A4. Coalescing, concurrency, cost, fail-open

- **Coalesce per engine (r1 #2).** A trigger schedules a pass if none is running, or sets a dirty
  bit if one is. A dirty bit now loses nothing: every pass stages for every enabled root found in
  the store (§A3), so triggers that arrive mid-pass need exactly one follow-up pass, whatever their
  workspaces. The triggering run ids are kept only for the diagnostic row.
- **One lock per destination workspace, for every writer (r1 #7).** The guard lock primitive
  `resourceLock()` (`guard/lock.ts:385`, in-process and cross-process with pid/start-time stale
  reclaim), keyed `learn-workspace-<sha256(canonical root)>` — the same primitive learn apply already
  uses for its target lock (`learn/apply.ts:362`). *(Corrected 2026-09-25 from the run lock's `link()`
  primitive, which is keyed by run id; implemented in DELIVER-1 slice 2 as `withWorkspaceLock`.)* It
  guards read-dedupe-append in `appendCandidates()` itself, so the CLI's `--stage` path
  (`cli/learn.ts:78`) and every engine,
  whatever store it reads, serialize on the same file. Under the lock, before appending, a non-empty
  sidecar that does not end in `\n` gets one appended (r2 new-1): the torn fragment stays unreadable
  and skipped (`candidate.ts:196-203`), and the new rows stay intact.
- **Revisions are not lessons.** `revisionId` binds `rendered.content`, which embeds recurrence
  counts (`candidate.ts:95-116`), so a cluster gaining evidence mints a new revision of the same
  `clusterId`. That is correct history (approval binds exact bytes); what the human sees is grouped
  by `clusterId` (§A5), so a growing cluster is one lesson, not many.
- **Cost.** Each pass harvests the whole store (515 files / 8.8 MB on 2026-09-25), off the response
  path, at most one pass in flight per engine. The implementation report records measured wall
  time; incremental harvest is out of scope unless that measurement says otherwise.
- **Fail-open.** Any error — config, read, classify, lock timeout, write, logging itself — is caught
  and never reaches the flow. `harvest()` currently maps any directory-read error to an empty corpus
  (`harvest.ts:60`); the trigger path distinguishes `ENOENT` (empty) from other errors (logged as
  `error`). Tests use real failure modes (unreadable store dir, held lock, read-only sidecar dir),
  not only a throwing stub, and assert the flow response and persisted run are unchanged.

### A5. Surfacing: show until acted on

A staged lesson is **unreviewed** until the owner applies it, dismisses it, or retires it
(STRAT-LEARN-DELIVER-1 §Lifecycle). Surfacing is recomputed from persisted state every time, never
remembered as "already announced" — so a missed or late surface (r1 #4, #6) cannot lose a lesson;
it simply shows up at the next one.

- **`unreviewedLessons(root)`** (new, in `learn/`): latest revision per `clusterId` in the sidecar,
  minus clusters with a committed apply or a `retired`/`dismissed` lifecycle state. Pure read.
- **`stratum learn list --unreviewed [--json] [--if-enabled]`** exposes it. `--if-enabled` prints
  nothing when the switch resolves OFF for that root; asking without the flag always answers.
- **`stratum_audit`** gains an optional `learn_inline: { unreviewed: [{ clusterId, revisionId,
  claim, guidance }] }` for a run whose canonical workspace has unreviewed lessons, when the switch
  is on. `AuditTrail` (`engine.ts:276`) and the MCP projection `auditResponse()` (`mcp/server.ts:652`,
  which rebuilds the object field by field) both forward it; absent when off or empty, so off-path
  output is byte-identical. No waiting on in-flight harvests — a lesson staged a moment later is
  shown next time.
- **Compose (r1 #5).** Compose's build end does not call `stratum_audit` when the completion
  envelope carries a trace (`compose/lib/build.js:6863-6878`), so it cannot rely on the audit
  field. One compose slice runs `stratum learn list --unreviewed --if-enabled --json --root <build cwd>` through
  the existing stratum bin resolution at every build exit (completed, failed, killed) and prints the
  lessons in the build summary. The test drives a real build to each exit and asserts the printed
  output, and asserts nothing is printed with the switch OFF and a populated sidecar (r2 new-2).
- **Diagnostic log (r1 #9)** at the store level, `<dirname(store.root)>/learn-inline/triggers.jsonl`
  (not under a workspace, so unattributed runs and lock failures have a sink): one row per pass,
  `{ at, storeRoot, roots, records, clusters, durable, staged: { [root]: revisionIds },
  skippedUnattributed: runIds, error? }`. Written fail-open; a failed log write goes to
  `console.warn` and nothing else. Diagnostics only — no surface reads it.

### A6. Enabling order — historical lessons must not come back as new

The three durable clusters in today's store (plan 1d) are **already fixed by hand** (compose
`ed8e333`, stratum `2968930`), but their evidence is still in the store. The first enabled pass in
stratum or compose would stage them as unreviewed lessons.

This feature ships **default OFF**. The owner enables it for stratum and compose only after the
DELIVER-1 lifecycle slice is live and those three clusters have `retired` transitions with fix refs
(`stratum learn retire <clusterId> --fix-ref <sha>`), verified by a dry-run pass staging none of
them. The suppression rule and its reader are DELIVER-1's (§A3 above); this feature adds no second
lifecycle.

### A7. The switch

- `[learn] inline = true|false` in `stratum.toml`, env `STRATUM_LEARN_INLINE`, project layer = the
  canonical workspace of the triggering run. Default OFF.
- **Error isolation (r1 #11).** The shared loader rejects unknown top-level tables
  (`config/index.ts:149`) and throws on malformed content, and sandbox resolution runs before every
  Codex dispatch (`connectors/runner.ts:87`). So: the top-level allowlist gains `learn`; sandbox
  resolution ignores the table's contents entirely (its output and provenance are unchanged); a
  separate `resolveLearnConfig()` reads `[learn]`, and an invalid `[learn]` value resolves to OFF with
  a logged diagnostic — it can neither fail a dispatch nor fail the flow.
- **Scope of that guarantee (r2 #11).** It covers invalid `[learn]` *values* in syntactically valid
  TOML. A file that is not valid TOML already fails the shared loader, and with it sandbox resolution,
  before this feature exists (`config/index.ts:143`, `connectors/runner.ts:87`). That behaviour is
  unchanged; sandbox policy is never defaulted on a parse failure. `resolveLearnConfig()` on a parse
  failure resolves OFF and logs, so the terminal hook itself still cannot throw.
- The winning layer is reported in the diagnostic log row and by `stratum learn list` (which prints
  `inline: on|off (<layer>)`). There is no `stratum config` command today (`ts/src/cli/` has none);
  sandbox provenance surfaces only through `sandboxAudit()` (`config/index.ts:77`), so this reuses the
  same `ConfigProvenance` type rather than adding a command.

### A8. Implementation notes (2026-09-26, stratum side)

Built by Claude in the DELIVER-1 slice-4 worktree branch while Codex credits were exhausted; Codex
review pending. `learn/inline.ts` (pass + `LearnInline` coalescer), `learn/unreviewed.ts`,
`config/learn.ts` (`inline` beside `deliver`), CLI `learn list --unreviewed`, audit + MCP projection.
Tests: `tests/learn/inline.test.ts`, `tests/learn/surface.test.ts`, `tests/config/learn.test.ts`.

- **Which switch gates the trigger.** §A2 "off means off" is resolved against the *triggering run's*
  canonical workspace (project layer) plus user and env. A run with no `workspaceRoot` resolves user
  and env only; if that is on, the pass runs and logs the run under `skippedUnattributed`. Each root in
  the pass is then resolved on its own (§A3).
- **Switch validity.** An invalid `inline` value turns only `inline` off; an unknown `[learn]` key, a
  non-table `[learn]` or a TOML parse error in a layer turns every `[learn]` switch off. All are
  diagnostics (`problems` in the pass row, `console.warn` elsewhere); none throws.
- **Diagnostic row** gains `enabled` (winning layer per enabled root, §A7), `suppressed` (cluster ids
  held back by retire/dismiss) and `problems` (per-root/per-cluster errors the pass carried on past).
- **Contracts.** The strict MCP validator rejects undeclared keys, so `stratum_audit.learn_inline`
  needed a surface bump (24 → 25). The same check exposed a DELIVER-1 slice-4 defect: its `lessons` /
  `lessonsSuppressed` event detail fields were undeclared, so with delivery ON `stratum_audit` and
  `stratum_flow_poll` failed over MCP (events 5 → 6 fixes it; `tests/learn/surface.test.ts` fails
  without it).
- **Compose slice** built on compose branch `comp-learn-summary` (`lib/learn-summary.js`, called after
  build.js's terminal status block for completed/failed/killed, skipped for aborted). It also prints
  DELIVER-1 D6 reviews. Needs a stratum release with these flags first: an older CLI ignores
  `--unreviewed/--if-enabled` and would list raw candidate rows.

## Acceptance criteria

- [ ] ~~Judge-path `must-fix` verdicts trigger harvest+classify automatically when enabled.~~
      **KILLED (2026-09-25):** replaced by the persisted terminal trigger (§Amendment A2).
- [ ] With the switch on, every terminal status (`completed`, `failed`, `cancelled`,
      `budget_exhausted`) triggers a pass, from the start of `emitFlowTerminal()`, including runs with
      no `bundle_id`. One test per terminal path in the §A2 table.
- [ ] A run that **completed after recovered failures** results in staging (the waste case).
- [ ] Paused/gate-waiting runs, subflow settlement, checkpoint revert and guard transitions do not
      trigger (one test each).
- [ ] Harvest reads `this.store.root`: tests with a custom `stateRoot` and with
      `STRATUM_STATE_ROOT` stage from the custom store and never touch the default one.
- [ ] Canonical workspace: builds launched from a subdirectory and from a linked worktree cluster
      with main-checkout evidence and stage into the main checkout's sidecar; the CLI from `ts/`
      reports the same candidates as from the repo root; a non-git root is used unchanged.
- [ ] A run without `workspaceRoot` stages nothing and appears in the diagnostic log.
- [ ] Coalescing: runs from two workspaces arriving during one pass are both staged by the follow-up pass.
- [ ] Reconcile: a pass killed before staging workspace A, followed by a trigger from workspace B only,
      stages A's clusters (A enabled). A root that is not an existing directory is never created.
- [ ] Torn tail: a sidecar ending in a partial line gets a readable new candidate on the next append.
- [ ] Locking: CLI `--stage` and an engine pass racing on one workspace, and two engines on
      different stores targeting one workspace, produce no duplicate `revisionId` rows.
- [ ] Fail-open with real failure modes (unreadable store, held lock, read-only sidecar dir,
      invalid `[learn]` value in valid TOML): flow response and persisted run unchanged; sandbox
      resolution unchanged. Invalid TOML keeps today's behaviour (shared loader fails) — test pins it.
- [ ] Switch resolves through the STRAT-CONFIG-PREFS-1 chain and reports its winning layer. Default
      OFF; off-path responses, persisted runs and audit output byte-identical.
- [ ] Candidates are staged only, never auto-applied; `STRATUM_LEARN_APPLY_ENABLED` still governs apply.
- [ ] Surfacing is state-derived: an unreviewed lesson appears in `stratum_audit` (through the MCP
      projection) and in the compose build summary on completed, failed and killed builds, on every
      build until the owner applies, dismisses or retires it, and never after; nothing is surfaced
      automatically when the switch is OFF for that root.
- [ ] Retired/dismissed clusters with only older evidence are not staged; an unreadable lifecycle
      stages nothing and logs.
- [ ] Not enabled for stratum/compose until the three hand-fixed clusters are retired and a dry run
      stages none of them (§A6).
- [ ] A durable lesson reaches a human without anyone running a command.

## Explicitly NOT in scope

- Retuning the classifier thresholds. The measurement says they are calibrated correctly; changing
  them without evidence would trade real lessons for noise.
- Auto-applying candidates. That stays behind `STRATUM_LEARN_APPLY_ENABLED`.
- Reviving the Python `postmortem/` CLI surface.

## Immediate follow-up, independent of this feature

The `outcome` enum mismatch is actionable now and costs an agent dispatch every time it fires:
steps return `approved`/`done`/`pass`/`revised`/`success`/`exists` against a contract allowing only
`complete`/`failed`/`skipped`. Either widen the contract or fix the step instructions. File
separately — it should not wait on the trigger.

**DONE (2026-09-25):** all three durable lessons were fixed by hand (compose `ed8e333`, stratum
`2968930`). They are now the retirement fixtures for §Amendment A6.

## Origin

Found 2026-09-16 while resolving the `compose/stratum.toml` fossil during STRAT-CONFIG-PREFS-1.
The file was about to be deleted as configuring a nonexistent feature; checking `ts/src/learn/`
first showed the feature half-exists. A first pass then measured zero yield and nearly killed it —
that zero was an artifact of harvesting from `ts/` instead of the repo root. Running it correctly
produced three real lessons, one of which had been silently predicting a bug that was later fixed
by hand.
