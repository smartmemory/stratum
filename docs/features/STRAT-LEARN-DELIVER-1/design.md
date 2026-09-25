# STRAT-LEARN-DELIVER-1 — Deliver approved lessons into the next matching dispatch

**Status:** PLANNED
**Priority:** MEDIUM
**Created:** 2026-09-25

## Related Documents

- [`2026-09-24-self-tuning-close-loop-plan.md`](../../plans/2026-09-24-self-tuning-close-loop-plan.md)
  — §2c (reading edge), §2d (retirement), §2e (golden). This doc is the "design section first" §2c asks for.
- [`STRAT-LEARN-INLINE-TS-1/design.md`](../STRAT-LEARN-INLINE-TS-1/design.md) — the upstream half:
  automatic staging and "show until acted on" surfacing. It reads this doc's §Lifecycle to suppress
  retired/dismissed clusters.
- [`STRAT-TS-LEARN/design.md`](../STRAT-TS-LEARN/design.md) — harvest/classify/candidate/apply
  machinery and the guard-ledger apply protocol this doc selects from.
- [`2026-09-24-self-tuning-collection-report.md`](../../plans/2026-09-24-self-tuning-collection-report.md)
  — the three durable lessons, now retirement fixtures.

Prior-art check (2026-09-25): `ls docs/features | grep -i learn` → STRAT-LEARN-COST(-1),
STRAT-LEARN-INLINE, STRAT-LEARN-INLINE-TS-1, STRAT-TS-LEARN. None reads an applied lesson back into
a prompt; the only reader of `ts/src/learn/` outside the module is `cli/learn.ts`. Compose's
`docs/context/*.md` insertion (`compose/lib/step-prompt.js:25-48`) is ambient, unscoped, and dropped
by the ambient-free re-render (`result-normalizer.js:420-441`), so it is not reused as the carrier.
Grounding for every claim below: Codex astra read-only pass, 2026-09-25, controller spot-checked.

## Problem

Approving a lesson today writes a note to `<workspace>/.stratum/learn/NOTES.md`
(`learn/candidate.ts:58`) and nothing reads it back. The owner can approve every lesson the
harvester finds and no agent will ever see one. This feature closes that edge: an approved lesson is
put into the prompt of the next dispatch it applies to, the delivery is recorded, and the owner is
told when a lesson looks unnecessary, stale or ineffective.

## Design

Revised after Codex review r1 (NOT CLEAN, 12 findings, all upheld on spot-check). The revision
narrows rather than hardens: it states a trust model (D0), drops checks the ledger cannot support,
moves the lifecycle off the guard ledger, restricts guidance to what a failure proves, and counts
lessons per run instead of per attempt.

### D0. Trust model

Everything under `<workspace>/.stratum/learn/` (sidecar, apply journal, lifecycle log, NOTES.md) is
written by the owner's own tools and is trusted at rest, exactly like the specs and NOTES.md
themselves. Anyone who can edit those files can edit the spec the agent follows. The checks below
defend against **staleness and accidents** — a reverted apply, a torn line, a stale sidecar row, a
contract that changed — not against a local adversary. The guard ledger stays the authority for
*whether an apply committed* (`learn/apply.ts:34-37`), because that is what it records; it is not
asked for things it does not store (r1 #1, #3: guard entries persist a payload digest only,
`guard/transition.ts:648`).

### D1. What gets delivered: agent guidance, approved as exact bytes

Today's `rendered.content` is a note for a human: it names the violated contract, counts
occurrences and ends "Fix target: the declared contract or the step instruction — a spec change"
(`candidate.ts:161-175`). An agent cannot act on that, and the plan's causality test (§2e) cannot
pass with it.

- `RenderedAsset` gains `guidance?: string` — one imperative sentence addressed to the agent.
- **Template v2 identity (r1 #2).** `revisionId` (`candidate.ts:101-116`) additionally binds
  `guidance` and the normalized **matching metadata**: `scope.flowName`, sorted `scope.stepIds`,
  `groupingKey`, and the issue (`contract.code`, `contract.path`, sorted `contract.expected`).
  `verifyIdentity()` recomputes all of it and also re-derives `clusterId` from the cluster key
  fields it now carries, so an edited sidecar row cannot pass as the approved revision with a
  different scope. `TEMPLATE_VERSION` → `"2"`. No sidecars exist on this machine (checked
  2026-09-25), so nothing is stranded.
- The NOTES.md note gains an `**Agent guidance:**` line: the owner approves the exact bytes that will
  be injected.
- `guidance` is derived **only from the violated contract, never from observed values or counts**, so
  it is stable while evidence grows. A growing cluster mints a new `revisionId` (the note's counts
  change) with the same `guidance`; the applied revision keeps being delivered, no re-approval.
- **Templates are limited to what the failure proves (r1 #4):**

  | Zod issue (from `ContractSummary`, `classify.ts:88-96`) | Guidance |
  |---|---|
  | `invalid_enum_value` — `expected` is the schema's own option list | "When `<path>` has a non-null value, it must be exactly one of: `<a>`, `<b>`, `<c>`." |
  | `invalid_type` — `expected` is the schema's type | "When `<path>` has a non-null value, it must be a `<type>`." |

  "When … has a non-null value" is deliberate (r2 #4). Optional contract fields compile as `.nullish()`
  (`ir/validate.ts:157`), accepting both omission and explicit null, and the issue does not say whether
  the field is optional. The sentence claims only the constraint on a non-null value, which holds for
  optional and required fields alike, and says nothing about whether null or omission is allowed. `unrecognized_keys` gets **no** guidance: its `expected` carries
  the rejected key names from the output (`classify.ts:89-93`), which is an observation, not a
  schema-declared rule.
- `ensure`, `gate`, `other` and `unrecognized_keys` lessons have no `guidance`. They can be staged,
  surfaced and approved as notes; they are never injected. `learn list` marks them "note only".

### D2. Selection: the active lessons for a workspace

`activeLessons(root)` (canonical root as INLINE-TS-1 §A3). Revision `R` of cluster `C` is active iff:

1. A journal row in `<root>/.stratum/learn/applies/` (`learn/apply.ts:216-225`) has `revisionId = R`,
   and `ledgerReceipt(entry)` classifies that apply as committed and not reverted
   (`apply/protocol.ts:239-259`). Journal states (`prepared | applying | applied | reverting |
   reverted | aborted`, `apply/protocol.ts:16`) are not trusted on their own; a crash-recovered apply
   whose journal is unfinished but whose ledger commit is complete counts as applied, because the
   ledger is what recovery consults (`apply/protocol.ts:334-365`).
2. `sha256(entry.after) === entry.afterDigest` (the receipt authenticates the digest, not the
   snapshot — r1 #1), and the sidecar row's `rendered.content` is a substring of `entry.after`.
   This compares against the apply's own snapshot, never the current NOTES.md, so a later stacked
   apply does not deactivate an older lesson.
3. The sidecar row with `revisionId = R` passes the v2 `verifyIdentity()` (D1).
4. `rendered.guidance` is present.
5. The lifecycle state of `C` is `active` (D5).

Never `latestPerCluster()` (`candidate.ts:220`: newest staged by file order, no approval check).
Any unreadable input makes that revision inactive and is logged: selection fails closed.

**At most one active revision per cluster (slice 3 narrowing).** If two revisions of one cluster both
pass 1–5 (e.g. NOTES.md was deleted out of band, so the existing-marker check let a second revision
apply without a revert), only the one whose apply journal `at` is newest is selected (ties: greatest
`applyId`); the other is reported as `superseded-revision`. Guidance is derived only from the contract
(D1), so both would inject the same sentence twice and spend two of D4's budget slots on one lesson.
Selection output is `{ lessons, diagnostics }`; diagnostics are D2's "logged".

### D3. Matching: which dispatch a lesson applies to

A lesson matches a dispatch when the canonical workspace and **root** `flowName` are equal and the
dispatch's **harvest step id** is in scope.

- **Harvest step id** is the id the harvester would stamp on a failure of that dispatch: root
  `run.flowName` (`harvest.ts:95-98`) plus `scopedId(scope, step.id)` for ordinary and subflow steps
  (`engine.ts:1884`), or the parent `step.id` for engine and consumer fan-out items (`engine.ts:2262`,
  `:2019`). One function, `harvestStepId()`, in `learn/`, used by both sides. A round-trip test fails
  a real step, harvests it, and asserts the harvested id equals the matcher's id — for ordinary,
  subflow, engine fan-out and consumer fan-out.
- **Step-scoped** clusters match `scope.stepIds`. **Step-agnostic** clusters also match any step in the
  same flow whose current output contract satisfies the compatibility predicate below.
- **Compatibility predicate (r1 #5)**, evaluated against the dispatch's current output contract.
  Contracts are flat field→type maps with `ref`s, parsed by `parseContracts()` (`ir/validate.ts:104`).
  Resolve the lesson's dotted `path` through refs. Then:
  - enum lesson: the node is `enum` with **exactly** the lesson's option set;
  - type lesson: the node's compiled type is **exactly** the lesson's `expected` type.

  Unresolvable path or any mismatch → the lesson is **suppressed** for that dispatch and a
  `contract-changed` review is raised (D6). A lesson about a contract that no longer holds must not
  tell an agent to obey it.
- **Budget.** At most 3 lessons and 1,200 characters of guidance per dispatch, ordered by
  `recurrence.records` descending, then `clusterId`. Overflow is recorded in the pin as suppressed.

### D4. Where lessons enter the prompt, and how delivery is recorded

**Pin at issuance, render from the pin.** Selection runs at the persisted transition that issues a
dispatch, and its result is persisted before any prompt leaves the engine. Rendering reads only the
pin, so the record matches the bytes sent even if the owner approves or retires something in between,
and `readyStep()` stays synchronous and pure.

| Surface | Selection + pin | Rendered by | Covered |
|---|---|---|---|
| Ordinary / subflow step | at the `ready` transition, `engine.ts:1881-1885`, before its `persist()` → `state.lessons` | `readyStep()` `:2940` appends to `do` | yes |
| Background ready-step | same pin | consumes `ReadyStep.do` (`:1442-1455`) | yes, via `readyStep()` |
| Consumer fan-out item | at `item.status = "ready"`, `:2015-2020`, before its `persist()` → `item.lessons` | `consumerDescriptor()` `:2951` appends to `do` | yes |
| Engine-owned fan-out (r1 #6) | inside the admission lock: select after `renderFanout()` (`:2245`) validates the template, record on `fanout_item_dispatched` (`:2262`), **append the block to `prompt`**, then `persist()` (`:2267`) and return it | the returned `prompt` | yes |
| Checkpoint restore (r1 #7) | restore is a **fresh issuance**: `rotateRestoredIssuances()` (`:3379`) re-selects and re-pins every restored ready step/item alongside the token rotation, discarding the restored pin | as above | yes |
| Retries | each re-issue re-selects and re-pins | as above | yes |
| Compose ordinary dispatch | — | `intent: readyStep.do` (`build.js:5085`) → `## Intent` (`step-prompt.js:70-72`) | yes, via stratum |
| Compose consumer/worktree fan-out | — | `intent: descriptor.do` (`build.js:1754`) | yes, via stratum |
| Compose ambient-free re-render | — | same `intent`; only `contextDir` is nulled (`build.js:1790`, `:5331`) | yes — why the carrier is `do` |
| Compose intercepted `ship` step (r1 #9) | stratum pins (it cannot see the interception) | none: Compose runs ship in-process (`build.js:5119`, `:5219`) | **offered, not delivered** |
| Compose scoped recovery fixer | — | fresh "Fix step…" prompt (`build.js:5240-5275`) | **excluded v1** |
| Compose review-gate fixer | — | separate prompt (`build.js:6259`) | **excluded v1** |
| Compose normalization repair | — | separate prompt via `stratum.agentRun()` (`result-normalizer.js:861-866`) | **excluded v1** |

Repair prompts are built from one specific failure; the lesson's job is to prevent that failure at
the main dispatch, where every covered row delivers it. If the live run shows recurrence reaching a
repair path, adding it is a Compose-only follow-up.

- **Offered vs delivered.** A pin records that stratum **offered** a lesson. Stratum cannot observe
  whether a consumer then used `do`. The `ship` row is the known case of offered-not-delivered.
  D6 counts offers, and the live acceptance criterion requires captured prompt bytes of a real agent
  dispatch, not a pin.
- **Block format**, appended to the rendered `do` after a blank line:

  ```
  ## Lessons from prior runs
  - <guidance 1>
  - <guidance 2>
  ```

- **Pin shape:** `lessons: [{ revisionId, clusterId, guidance }]`, optional
  `lessonsSuppressed: [{ revisionId, reason: "contract-changed" | "budget" }]`, on step/item state;
  the issuing event's `detail` carries `lessons: revisionIds` and the same suppressions. All omitted
  when empty.
- **Switch** `[learn] deliver` (env `STRATUM_LEARN_DELIVER`), resolved like INLINE-TS-1 §A7. Default
  OFF. **OFF:** no reads beyond the config read, no pin. **ON:** selection reads journal, ledger,
  sidecar and lifecycle (r1 #11); with no lesson selected, prompts, events and persisted runs are
  still byte-identical.
- `do` is not part of `contractDigest` (`engine.ts:2978`, a digest of the contract closure) or of the
  spec `revisionDigest`, so appending to it does not disturb consumer verification.

### D5. Lifecycle (the interface INLINE-TS-1 reads)

An append-only log, `<root>/.stratum/learn/lifecycle.jsonl`, written under the same workspace lock as
the sidecar (INLINE-TS-1 §A4, including torn-tail termination). Not a guard resource: the guard ledger
stores payload digests, not the `reason`/`fixRef` this needs (r1 #3). The lifecycle carries no
authorization weight (approval authority stays with apply + ledger), so D0's trust model covers it.

- **Row:** `{ clusterId, kind: "retire" | "dismiss" | "reactivate" | "ack", reason, at, fixRef?,
  withdrawn?, ackKinds? }`. `at` is the writer's ISO clock; rows are ordered by file position, which
  the lock serializes.
- **State** of a cluster = its latest `retire`/`dismiss`/`reactivate` row → `retired` / `dismissed` /
  `active`; no row → `active`. `ack` rows change no state.
- **Commands:**
  - `stratum learn retire <clusterId> --reason <text> (--fix-ref <sha> | --withdrawn)` — no longer
    needed. Needs a commit that fixed the cause, or the owner's statement that they checked it by
    withdrawal. Allowed on a never-applied cluster (the three hand-fixed fixtures were never applied).
  - `stratum learn dismiss <clusterId> --reason <text>` — the owner rejects a staged lesson.
  - `stratum learn reactivate <clusterId> --reason <text>`.
  - `stratum learn ack <clusterId> --reason <text> [--kind <review>]` — acknowledge a review without
    changing state (all kinds when `--kind` is omitted).
- **Reader:** `lessonLifecycle(root, clusterId)` → `{ state, since?, fixRef?, watermarks }`, where
  `since` is the latest state row's `at` and `watermarks[kind]` is the latest `at` of any row that
  acknowledges that review kind (every state row acknowledges all kinds). Throws on an unreadable log;
  callers fail closed — INLINE-TS-1 does not stage, D2 does not select. A torn or unparseable line is
  skipped and logged, like the sidecar.
- **Suppression rule (INLINE-TS-1 §A3):** a `retired` or `dismissed` cluster whose evidence
  (`FailureRecord.at`) is all `≤ since` is not staged. Newer evidence stages it and raises
  `recurred-after-retirement` (D6). Nothing auto-reactivates.
- **Retirement is not removal.** The note stays in NOTES.md as the human record. Whole-file
  `revertApply()` (`apply/protocol.ts:272-308`, refuses stacked changes) is not per-note retirement and
  is not used for it. Because the note stays, the existing-marker rejection (`learn/apply.ts:134-165`)
  keeps blocking a second apply of the same cluster: reactivation restores the still-applied revision
  instead of re-approving one. A full revert still allows re-apply (`tests/learn/apply.test.ts:391-400`).

### D6. Retirement reviews: counted per run, closed by watermarks

A clean run *with* the lesson does not prove the lesson is unnecessary; it may be why the run was
clean. So nothing is removed automatically; the loop raises **reviews** and the owner acts (D5).

**Counting is per run and per matched step, ordered by time (r1 #8)** — not per attempt. Attempt
numbers repeat across epochs and are cleared by revise (`engine.ts:2888`), and consumer readiness
events carry only `itemIndex` (`engine.ts:2019`), so an attempt-level join is not recoverable from
history. The run level is: `lessonOutcomes(storeRoot, root)` recomputes over the persisted flow store,
and for each run and each harvest step id that had lesson `R` offered (issuing events with
`lessons ∋ R`, D4):

- **Order is event position, not timestamp (r2 new-2).** Engine timestamps are millisecond ISO strings
  (`engine.ts:3711`), so an offer and a following failure can share one. "After the offer" means a
  higher index in `run.events` than the first issuing event carrying `R`. The extraction reuses the
  harvester's per-run extractor (INLINE-TS-1 §A2's `failureRecordsOf`), extended to carry each record's
  event index.
- **Held:** the run is **terminal** and, after the first offer, that step id has a **successful result** (a `result` event without
  `detail.failure`, or a successful fan-out attempt for that step) and no failure record in `R`'s
  cluster (same issue fingerprint, `classify.ts:99-101`).
- **Not holding:** at least one failure record in `R`'s cluster after the first offer.
- **Unknown:** an offer with no subsequent result for that step, such as a run cancelled before the
  step answered (r2 new-1; `cancelled` is terminal, `engine.ts:3486`), and any failure-free run that is
  not yet terminal (r3: fan-out success events are per item, `engine.ts:2451`, so other items may still
  fail). Unknown runs count toward no review; a matching failure makes a run not-holding immediately,
  terminal or not.

Reset attempts are removed from the persisted events by checkpoint restore, so they count as nothing.
Pins record offers (D4); the `ship` interception is the known offered-not-delivered case, noted in the
review text for any lesson scoped to an intercepted step.

| Review | Raised when (only evidence after the cluster's watermark for that kind, D5) |
|---|---|
| `retire-candidate` | ≥ `retireReviewAfter` (default 3) held runs, none not-holding |
| `not-holding` | any not-holding run — offered but not working |
| `contract-changed` | D3 suppressed the lesson for drift |
| `recurred-after-retirement` | D5 suppression rule saw newer evidence |

Reviews are recomputed on every surface and surfaced wherever INLINE-TS-1 §A5 surfaces unreviewed
lessons (`stratum_audit` `learn_inline.reviews`, `stratum learn list --reviews`, the Compose build
summary). **A review closes** when the owner writes any lifecycle row that acknowledges it (D5); it
**reopens** only on evidence newer than that watermark (r1 #10).

The default of 3 held runs is a starting guess, deliberately comparable to the promotion bar
(≥2 runs and ≥3 pairs, `classify.ts:30`). It is a config key; no delivery data exists yet, because
no lesson has ever been delivered.

### D7. Proof (plan §2e)

**Golden, stratum, real engine** (extends `tests/learn/harvest-fanout.test.ts`, which already runs
the real engine with a prompt-capturing connector). Isolated state and guard roots, one git workspace.
**Connector policy, fixed for the whole test (r1 #12):** on a first attempt, return
`outcome: "done"` unless the prompt contains the guidance; return `"complete"` on any retry or when
the guidance is present.

1. Three runs of one single-step flow against the enum `complete|failed|skipped`: each fails the first
   attempt and recovers on retry. That meets `DEFAULT_THRESHOLDS` (≥2 runs, ≥3 run-step pairs; three
   single-step runs is the minimum, since a pair is run plus parent step).
2. INLINE-TS-1 on: the lesson is staged with no command and appears in `learn_inline.unreviewed`.
3. `stratum learn apply <revisionId>` with `STRATUM_LEARN_APPLY_ENABLED`.
4. Run 4: the captured prompt bytes contain the applied revision's exact `guidance` under the heading,
   the pin carries that `revisionId`, and the step **passes on its first attempt**.
5. Control: retire the lesson, run 5 → no block and the **first attempt fails** again.

Causality is measured as first-attempt outcome under one unchanged connector policy. The connector is
scripted, so this proves the mechanics: the approved bytes reach the prompt, and an agent that follows
them stops failing. It does not prove a real model follows them; that is the live run's job, and the
report says so.

**Negative golden cases:** non-matching flow, non-matching step, staged-but-unapplied, reverted,
retired, dismissed, contract drifted (enum set changed; type changed), an edited sidecar row with a
changed scope (fails v2 identity), and a note-only lesson. None are injected.

**Compose golden:** extend `compose/test/ts-cutover-consumer-fanout-golden.test.js` (prompt-observing
connector) and `ts-cutover-build-golden.test.js`: guidance appears in the Compose-built prompt's
`## Intent` for an ordinary step, a consumer fan-out item and the ambient-free re-render.

**Live:** one real Compose build with one real applied lesson, on a non-intercepted step. The guidance
is visible in captured prompt bytes of a real agent dispatch (background `stream.jsonl.in`,
`connectors/background.ts:185-194`). Delivery evidence only.

## Acceptance criteria

- [ ] Schema-shape candidates for `invalid_enum_value` and `invalid_type` carry `guidance` from the D1
      templates, derived only from the contract; other shapes are note-only.
- [ ] Template v2 `revisionId` binds `guidance` and the matching metadata; `verifyIdentity()` rejects a
      sidecar row whose scope, grouping or issue was edited; `TEMPLATE_VERSION` is `"2"`; the NOTES.md
      note carries the guidance line.
- [ ] Evidence growth mints a new revision with identical `guidance`; the applied revision keeps being
      delivered.
- [ ] `activeLessons()` enforces D2 conditions 1–5, one test per condition, including a stacked apply
      (the older lesson stays active) and a crash-recovered apply (journal unfinished, ledger committed).
- [ ] `harvestStepId()` round-trips for ordinary, subflow, engine fan-out and consumer fan-out.
- [ ] Step-scoped and step-agnostic matching per D3; enum-set and type drift each suppress and raise
      `contract-changed`; an unresolvable path suppresses.
- [ ] Budget: 4 active matching lessons → 3 injected, 1 recorded as `budget` suppressed.
- [ ] Every "covered" D4 row has a prompt-assertion test, including engine fan-out (block present in the
      prompt the connector receives) and checkpoint restore (restored pin discarded, fresh selection).
- [ ] Pin at issuance: approving or retiring between issuance and render does not change the rendered
      prompt; the pin matches the bytes sent.
- [ ] OFF: no reads beyond config, and prompts, events and persisted runs byte-identical. ON with no
      selection: byte-identical outputs.
- [ ] Lifecycle log: retire (with `--fix-ref` or `--withdrawn`), dismiss, reactivate and ack rows, under
      the workspace lock; retire works on a never-applied cluster; an unreadable log fails closed in both
      staging and selection.
- [ ] Suppression: a retired cluster with only older evidence is not staged; newer evidence stages it and
      raises `recurred-after-retirement`.
- [ ] `lessonOutcomes()` classifies held / not-holding / unknown per run and step per D6, ordered by
      event index: a cancelled-before-result offer is unknown; a failure sharing the offer's timestamp
      but at a later index is not-holding; a non-terminal run with one successful and one pending fan-out
      item is unknown; checkpoint-reset attempts do not count.
- [ ] Reviews surface in audit, `learn list --reviews` and the Compose summary; each closes on an
      acknowledging lifecycle row and reopens only on newer evidence.
- [ ] D7 stratum golden (steps 1–5, first-attempt causality), negative cases, and Compose golden pass.
- [ ] The three hand-fixed clusters are retired with their fix refs (compose `ed8e333`, stratum
      `2968930`) before INLINE-TS-1 is enabled.
- [ ] One live Compose build shows an applied lesson in the captured prompt bytes of a real agent dispatch.
- [ ] CHANGELOG updated in the same commits; completion recorded via `record_completion`.

## Implementation slices (one Codex brief each)

1. **Guidance + identity** — D1 (`candidate.ts`, NOTES render, template v2). No behaviour change elsewhere.
2. **Lifecycle** — D5: lifecycle log under the workspace lock, CLI verbs, `lessonLifecycle()`,
   suppression reader. This must land before INLINE-TS-1 is enabled.
3. **Selection** — D2 `activeLessons()` with per-condition tests.
4. **Matching + pin + render** — D3 and D4 in the engine, `harvestStepId()` round-trip, off-path byte
   identity.
5. **Outcomes + reviews** — D6, surfaced through INLINE-TS-1's surfaces.
6. **Goldens** — D7 stratum and Compose; then the live run.

## Explicitly NOT in scope

- Injecting into the excluded Compose repair prompts (D4).
- Delivering non-schema lessons (no derivable guidance).
- Automatic withdrawal experiments to prove a lesson is unnecessary; `--withdrawn` records the owner's check.
- Promoting lessons into CLAUDE.md/AGENTS.md (global and unscoped).
- Template migrations for already-applied lessons (a future `TEMPLATE_VERSION` bump needs its own design).
- STRAT-ADMIT automated critics; the owner's approval is the v1 admission check.
