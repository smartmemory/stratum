# STRAT-TS-LEARN — Implementation Report (v1)

**Status:** SHIPPED (S1–S4) — 2026-08-15 · **Commits:** `1d2c559`, `3735483`, `69120e7`, `6bb0212`
**Design:** `design.md` · **Sibling design:** `../STRAT-ADMIT/design.md`

## Summary

Stratum can now learn across runs. It reads its own persisted run history, finds failures that recur, stages an evidence-backed note for each, and — behind an explicitly-enabled, default-OFF flag — applies that note through the guard ledger with a compare-and-swap revert.

`stratum learn harvest | list | apply | revert | reconcile`.

Against the live 492-run corpus it produces exactly one lesson, and it is the right one.

## What the corpus actually said

The design's largest result is a negative one, and it changed the implementation twice.

| Finding | Consequence |
|---|---|
| **0** `judged` events across 492 runs | The Python-era trigger has never fired. Harvest reads `result`-event failures + flow-level budget exhaustion instead: 332 records. |
| **155 of 174** step failures are one golden test rerun in 155 ephemeral temp workspaces | Attribution by `workspaceRoot` is not a refinement — without it the harvester's most confident output is its worst. A regression test asserts those 155 records yield **zero** durable candidates. |
| The one real lesson spans **4 steps but only 2 runs** | Recurrence must be measured as breadth (≥2 runs, ≥3 run/step pairs), not volume. Counting occurrences admits a single run's retry storm; counting runs rejects the only real lesson in the corpus. |
| Its 2 runs carry **different `revisionDigest`s** | Keying on the spec digest — the obvious fix for "generic step ids from unrelated specs must not merge" — splits the lesson in two. Keyed on a *contract fingerprint* (issue code + path + declared options) instead. |
| Its `received` values are `success`, `revised`, `done`, `pass`, `approved` | Keying on the rejected value splits the lesson five ways. Rejected values are evidence, never key material. |
| 2 records violate the enum **and** a type in one response | The clustering unit is an *issue*, not a failure. Whole-record fingerprinting split the lesson 12 + 2. |

The surviving lesson: in flow `build`, four steps returned `outcome` values outside the declared `complete|skipped|failed` enum, 14 times across 2 runs, **every one recovered on retry** — so it cost an extra agent dispatch each time and nothing ever surfaced it.

## Delivered

| Slice | Deliverable | Files |
|---|---|---|
| **S1** | Harvest reader over `StateStore`; both failure sources; fail-open with separate `skipped` / `droppedEvents` | `ts/src/learn/harvest.ts` |
| **S2** | Issue-level clustering, contract fingerprint, attributed two-level grouping, breadth thresholds | `ts/src/learn/classify.ts` |
| **S3** | `PatchCandidate` with rendered content and dual identity; append-only sidecar | `ts/src/learn/candidate.ts` |
| **S4** | Four admission critics; journalled apply with the ledger as commit point; CAS revert; reconciliation | `ts/src/learn/apply.ts` |
| CLI | `harvest \| list \| apply \| revert \| reconcile` (staging is opt-in via `--stage`) | `ts/src/cli/learn.ts` |

60 learn tests; full suite **807 passed, 1 skipped**; `tsc` clean. Fixtures are extracted from the real corpus (`ts/tests/fixtures/learn/flows/`), not hand-written.

## Guardrails, as built

- **G1 project scope** — `workspaceRoot` is the first component of every grouping key. Clusters are single-project by construction; unattributed records are segregated and never apply-eligible.
- **G2 evidence** — non-empty, resolvable, carried into the journal; run count re-derived from evidence at apply.
- **G3 snapshot + rollback** — compare-and-swap. Revert refuses on out-of-band edits and stacked applies, and restores non-existence when the apply created the file.
- **G4 immutable core** — path allowlist on the *real* path, including a check that the allowlist directory itself is inside the workspace.
- **G5 admission** — structural validity, behavioral harmlessness, semantic consistency, subset marginal gain. All four run for memory-class candidates.

## What v1 does NOT do

- **It does not fix the lesson it finds.** The fix target is a spec, and specs are immutable here. The deliverable is surfacing, and that is genuinely the thing that was missing — the failure recurred invisibly because nothing reported it.
- **No skill-, agent-, or command-class assets.** Blocked on `../STRAT-ADMIT/design.md`.
- **No LLM authoring.** Templated only; a template cannot over-generalize beyond its inputs.
- **No cross-project lessons.** Not representable in v1, deliberately, rather than promised and unimplemented.
- **No semantic conflict detection.** Subset admission catches same-subject overlap; two notes that conflict while naming different subjects are not caught. Specified in STRAT-ADMIT.

## Review trail, and the honest caveat

Five review rounds, all Codex `sol/xhigh`: three on the designs (6, 7, 6 findings), two on the implementation (11, 7). Every finding was adjudicated against evidence rather than accepted wholesale — one round-2 design suggestion (key on `specDigest`) was **rejected on data**, because the corpus showed it would split the only real cluster.

Two rounds were spent falsifying my own claims:

- The original argument that memory-class notes could skip admission for being "declarative" was wrong. This repository's own memory format carries `**How to apply:**` sections, so notes are instructions a future agent acts on.
- A recovery test I wrote **asserted the buggy behavior**: it constructed a ledger-committed apply and expected reconciliation to roll it back.

**The caveat worth carrying forward:** all 18 implementation findings landed in S4's crash-recovery protocol. S1–S3 drew zero across both rounds. Non-convergence localized to one slice is a statement about that slice, not about the reviewer. S4 is default-OFF, its protocol is correct as far as two adversarial rounds and 60 tests can show, and it has never run outside tests. Treat the read-only three quarters as solid and the apply path as unproven until it has been exercised on something that matters.

## Follow-ups

- `STRAT-ADMIT` — designed here, not implemented; hard precondition for skill-class applies.
- Contract-lineage identifier — the fingerprint is an equivalence class, not an identity; `mixed_provenance` bounds the blast radius without fixing it (design §3.2, open question 5).
- Recurrence constants (≥2 runs, ≥3 pairs) are fitted to a corpus with exactly one qualifying cluster.
- **Separate, not part of this feature:** compose `lib/build.js:4607-4614` returns `{commit, completionWarning}` where its `PhaseResult` contract declares `files_changed?`/`commit_hash?`. A real bug, exercised 155 times by one golden test — and this feature's first fixture in both directions.
