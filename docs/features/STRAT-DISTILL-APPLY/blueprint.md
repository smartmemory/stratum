# STRAT-DISTILL-APPLY — Blueprint

**Status:** BLUEPRINT (2026-09-23) · **Design:** [`design.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/design.md) (committed `fae3c76`) · **Next:** implement, slice by slice, via Codex

## Related Documents

- Design (the spec this grounds): [`design.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/design.md)
- Slice blueprints (each grounded in real code, one Codex `gpt-5.6-sol/high` dispatch per slice):
  - [`blueprint-s1.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/blueprint-s1.md) — agnostic apply core + memory adapter
  - [`blueprint-s2.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/blueprint-s2.md) — distill-2.1: `.claude/` paths, template v2, `sourceMode`, legacy rows
  - [`blueprint-s3.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/blueprint-s3.md) — asset adapter: critics, pool, locks, guard, provenance
  - [`blueprint-s4.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/blueprint-s4.md) — CLI verbs, golden flow, CHANGELOG, contract

**Precedence:** where a slice file and §1 below disagree, §1 wins. Where a slice file and
`design.md` disagree, the slice's `## Corrections` wins (each item verified against source).

## 0. Slice order and gates

| Slice | Depends on | Regression gate (must pass) |
|---|---|---|
| S1 | — | `tests/learn/apply.test.ts` **unmodified** (30 tests) **and** `npx tsc --noEmit` (Vitest does not type-check the typed `JournalEntry` literal — S1 correction #10) |
| S2 | — | all `tests/distill/*` with only re-key edits listed in S2 §E; no weakened assertion |
| S3 | S1, S2 | new `tests/distill/apply.test.ts`; memory reconcile matrix parameterized over both adapters, not copied |
| S4 | S3 | `tests/distill/cli.test.ts`, golden flow, `tests/mcp/distill-contract.test.ts`, `runner.test.ts` sentinel with `STRATUM_DISTILL_APPLY_ENABLED=1` |

S1 and S2 are independent and may be dispatched in parallel (disjoint files). Anchor audit at
blueprint time: 126 `file:line` references across the four slices resolve to existing lines;
S1's 30 split-table anchors and every high-stakes correction below were content-verified by the
controller with `sed -n`.

## 1. Controller rulings (override slice text)

1. **Shared path mechanics.** `realpathOrSelf` / `realpathThroughMissing` move to a new
   `ts/src/apply/paths.ts` imported by both adapters. This overrides S1 §A and S1 correction #1
   (which kept them memory-private). Path *policy* (`.stratum/learn` root, `.md` rule, `.claude/`
   dirs) stays adapter-owned. Reason: D7 requires the asset allowlist to use the same symlink
   defenses; private helpers would force S3 to copy them.
2. **`journalEntry` takes the admission.** The settled signature is
   `journalEntry(candidate: C, base: BaseJournalEntry<E>, admission: AdmissionResult): J`
   (S3 correction #12). `blueprint-s1.md` §B still shows the two-argument form — implement the
   three-argument form. The memory adapter ignores `admission`, so memory journal bytes are
   unchanged. Needed because D6's `poolDigestAtAdmission` cannot be recovered after prepare.
3. **`clusterId` keeps its explicit-field hash.** `sourceMode` enters identity only through
   `scope` → `authoringInputsDigest` → `revisionId`. Never replace the field list at
   `candidate.ts:64-65` with `scope` (S2 §A): the same workflow would get a different cluster id,
   asset name and install path depending on how its transcripts were selected.

## Corrections

Consolidated list of places `design.md` is wrong or under-specified against the real code.
Each is verified on disk; the slice that found it is cited. `design.md` is amended only for the
wrong lock anchor and a pointer here (minimal-edit rule); the rest are recorded here.

### Wrong anchors (controller-found)

- D7 cited `ts/src/learn/apply.ts:364` for the target lock. The call sites are `:368` (apply) and
  `:552` (revert). **Fixed in `design.md` line 151.**
- The exported, callback-shaped, one-resource-per-call `resourceLock` is
  `ts/src/guard/lock.ts:385-391`. (The session handoff note that fed the slice briefs said `:237`,
  a private `acquireInProcess`; the design itself never carried that anchor. Slice files S3 #2 and
  S4 #11 repeat the handoff's attribution to D7 — disregard that attribution, not the fix.)
- §0 `poolRead: false` is hard-coded at `candidate.ts:60`, not `:58`. (The claim itself holds:
  `:57` rejects `poolRead !== false` and any non-empty `poolSnapshot`.)

### Would have shipped a bug or a hole

- **Evidence re-harvest must disable the age window** (S3 #4). `loadSessions` defaults to
  `windowDays ?? 30` (`harvest.ts:17`, filter at `:31-32`). With the default, evidence older than
  30 days vanishes and apply fails closed for *age*, indistinguishable from tampering. Admission
  passes `{ windowDays: 0 }` (falsy at `:31`, so the filter is skipped).
- **Identity hashes are not an authenticity control** (S3 #13, S4 #12). `hash` is plain unkeyed
  SHA-256 of canonical JSON (`detector.ts:12`). Anyone who can write the sidecar can recompute a
  self-consistent `revisionId`, including relabelling `scope.sourceMode` to `workspace` and so
  bypassing D5a's `--trust-source` gate. `verifyCandidateIdentity` rebuilds from the row's own
  values (`candidate.ts:88-94`) and cannot catch it. The real gate is S3 §E: re-derive the
  workspace transcript directory independently before granting no-trust admission.
- **Full-step comparison is necessary, not belt-and-braces.** `occurrenceId`
  (`detector.ts:37-39`) binds `sourceKind, projectDir, sessionId, transcriptFile` and, per step,
  only `lineNo, blockIndex, lineDigest`. It does not bind `toolName`, `canonicalInput`,
  `toolUseId` or `cwd` (per step or per occurrence). D5's seven-field canonical comparison stands;
  S3 also compares occurrence-level `cwd` (S3 #5).

### Interface and type gaps in D1 (S1)

- `registerGuard` (`transition.ts:396-404`) takes `(resourceId, graph, edgePredicates, initial,
  terminal = [], stakes = {}, workspaceRoot = null, policyBundle?)`. D1's "predicates/terminals"
  names are wrong and three parameters are missing (S1 #2, S3 #16).
- `BaseJournalEntry` needs a verdict split as well as an evidence parameter: today's `verdicts`
  is memory-typed `Verdict[]` (`apply.ts:226`); the core broadens `critic` to `string`, the memory
  adapter narrows back (S1 #7). `journalEntry` must name `BaseJournalEntry<E>` (S1 #3).
- Public memory functions need same-signature wrappers, not literal re-exports, because the core
  forms take an adapter (S1 #4). Two refusal messages must survive: detailed at `apply.ts:355-357`,
  short at `:543` / `:604` (S1 #6).
- `PoolView` is undefined in D1; the memory path uses two reads (snapshot `:377`, pre-write CAS
  `:429`) that the core must keep distinct (S1 #5).
- `locks()` returns several names but `resourceLock` takes one: nest in adapter order, release in
  reverse (S1 #9). S1's `locks()` is synchronous, so S3 uses `realpathSync` for the pool key
  rather than widening the protocol (S3 #11).

### distill-2.1 (S2)

- Unsupported rows are discarded at `candidate.ts:110` (`:104` is the `parseRows` declaration).
- `scope` (`candidate.ts:12`) already records `workspaceRoot`, `transcriptProjectDir` and
  `observedCwds`; the missing fact is only the selection mode (S2 #8).
- `runner.ts:29` only validates option combinations. Projects-root is `:40`; the
  explicit-project / workspace split is the conditional at `:47` (S2 #7).
- `templateVersion` is a caller-supplied identity input (`candidate.ts:23,61,72`), not a renderer
  switch (S2 #6). The template currently emits `name:` for all kinds and a `$ARGUMENTS` sentence
  for commands; template v2 drops `name` for commands (D5, not D3 — S2 #5).
- `stratum distill list` belongs to S4, not S2 (S2 #2, S4 #2).

### Acceptance-criteria and surface fixes (S3, S4)

- **§4's concurrency test is not constructible as worded.** `selectedForm` feeds `clusterId`,
  which feeds `assetName` (`candidate.ts:64-68`), so identity-valid authoring cannot produce
  same-name/different-kind candidates. The test uses frozen real-shaped fixtures with a verifier
  stub and real critics, files, guards and locks; production identity checks are not weakened
  (S3 #15). The AC should read "two concurrent applies whose admitted assets collide by name".
- D7 ("`.claude` resolves inside the workspace") is weaker than §4 ("symlinked `.claude`
  refused"). S3 follows §4: a `.claude` that is itself a symlink is refused (S3 #10).
- The D3 marker is required unconditionally in v1 — there is no deterministic trigger-language
  classifier, and the template always emits the constant draft description (S3 #7).
- Size cap is bytes: `Buffer.byteLength(content, "utf8") > 16 * 1024` (S3 #8). Unreadable pool
  entries and non-`ENOENT` target reads fail closed (S3 #9).
- `applied: false` is a runtime literal, not a schema literal: `LEAF_TYPES`
  (`contracts.ts:47`) has no literal type. The schema leaf stays `"boolean"`, the description
  changes, `surface` stays `23` (S4 #8, #9).
- `learn.ts:175` omits `ReconcileReport.reverted`; the distill CLI prints all four counters
  (S4 #6). `distill.ts` keeps rejecting duplicate (`:12`) and unknown (`:16`) flags (S4 #5).
- Revert prints the constant `descendants: 0` and never scans for descendants — lineage is empty
  by construction (S3 #14, S4 #10).

## 2. Open items (not blocking implementation)

- `stratum/ts/src/judge/pricing.ts` / `judged.ts` have no `gpt-6-sol` / `gpt-6-luna` entries
  (released 2026-09-22). Unrelated to this feature; tracked in
  `~/.claude/rules/subagent-model-routing.md`.
- `.claude/commands/` is documented as legacy by Claude Code; folding distill's `command` kind
  into a skill is a follow-up (design §7 Q1/Q4). v1 keeps it.
