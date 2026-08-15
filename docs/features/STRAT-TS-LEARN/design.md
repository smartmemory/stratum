# STRAT-TS-LEARN — Design

**Status:** DESIGN (2026-08-15, revised after design gate round 1) · **Owner:** stratum
**Supersedes in practice:** the Python `STRAT-LEARN-INLINE` harvester (retired with the Python engine, 2026-07-18)

## Related Documents

- Predecessor (Python, retired): `../STRAT-LEARN-INLINE/design.md`, `../STRAT-LEARN-INLINE/report.md`
- Guardrail source: `../STRAT-DISTILL-APPLY/design.md` §"Apply-path guardrails" (gates 1–5)
- Skills-class admission gate: `../STRAT-ADMIT/design.md` — supplies the behavioral-harmlessness critic this design depends on (§5.1)
- Recurrence-triggered synthesis (deferred): `../STRAT-DISTILL/design.md`
- Roadmap row: `/Users/ruze/reg/my/forge/ROADMAP.md` → Standalone Tickets → STRAT-TS-LEARN
- Constraints: STRAT-IMMUTABLE (spec immutability), default-OFF gate discipline (STRAT-GUARD / COMP-MCP-ENFORCE precedent)

---

## 1. Problem

Stratum has no working self-improvement loop.

Within-step self-correction exists (a failed `ensure` retries the step). Across-run learning does not: when the same step fails the same way across many runs, nothing notices, nothing accumulates, nothing is proposed. `STRAT-LEARN-INLINE` v1 was built for exactly this, shipped a staging path in June 2026, was retired with the Python engine in July, and was never ported. Its apply half was never built in any engine, so even at peak the loop was open.

## 2. Corpus census, and what it actually shows

The obvious port target was the Python trigger: harvest from judge-kernel `must-fix` verdicts. Measured against the live corpus, **that trigger has never fired**.

Census of `~/.stratum/ts/flows`, 2026-08-15, the complete local persisted-run corpus:

| Signal | Count |
|---|---|
| Persisted runs | 492 |
| `judged` events (any) | **0** |
| `result` events carrying `detail.failure` | 174 |
| `budget_exhausted` events | 158 |
| Runs carrying `workspaceRoot` | 491 / 492 (99.8%) |

No spec that ran to persistence has ever used a `judged:` ensure predicate. A v1 hung off `judged` events would be live and permanently silent — the Python failure mode repeated.

### 2.1 The 155× cluster is test noise, and finding that out is the design's main result

The raw grouping by `(stepId, shape)` puts 155 of the 174 failures on one step, `ship_gsd`. Read naively that is a spectacular recurring production defect.

It is not. Grouped by `workspaceRoot`, those 155 failures are **155 distinct ephemeral directories** — `/var/folders/…/T/gsd-stuck-resume-<random>`, each appearing exactly once — produced by compose's own `test/gsd-stuck-resume-golden.test.js` running repeatedly. It is one test, not 155 incidents.

This is recorded prominently because it is the load-bearing lesson for the classifier: **an unattributed recurrence count is not evidence.** A design that staged the top cluster would have proposed a durable lesson derived entirely from a test fixture, with 155 supporting records and a confident count. Project attribution is not a refinement on grouping; it is the thing that separates signal from noise, and without it the harvester's most confident output is its worst.

(There is a genuine underlying defect — compose's `lib/build.js:4607-4614` returns `{commit, completionWarning}` where the step's `PhaseResult` contract declares `files_changed?`/`commit_hash?`, so the strict validator rejects it and the step retries. It is a real one-line-class bug in compose, it is filed separately, and it is emphatically *not* a 155× production waste. It is this feature's first fixture, in both directions: as a true defect, and as an example of a count that must not be trusted.)

### 2.2 The real durable signal

After attribution, one cluster survives as a genuine cross-run lesson:

| workspaceRoot | flow | stepId | received `outcome` | n |
|---|---|---|---|---|
| `…/forge/stratum` | `build` | `plan` | `success` | 6 |
| `…/forge/stratum` | `build` | `explore_design` | `success`, `revised` | 4 |
| `…/forge/stratum` | `build` | `blueprint` | `done` | 2 |
| `…/forge/stratum` | `build` | `verification` | `pass` | 2 |

Fourteen failures, **one project, one flow, four steps, one cause**: agents return the natural outcome vocabulary (`success`, `done`, `pass`, `revised`) while the contract enum is `complete|skipped|failed`.

This is the shape the feature exists to catch, and it is invisible to the obvious design in two independent ways: keyed by `(stepId, shape)` it fragments into 6/4/2/2 — at or below any sane threshold — and keyed without attribution it is buried under a test-fixture cluster twelve times its size.

**Design consequences.** The harvest source is `result`-event failures plus flow-level failure contexts in `StateStore` persisted runs, not `judged` events. Grouping is attributed and two-level. Neither is optional.

## 3. Architecture

```
~/.stratum/ts/flows/*.json          (already written by the engine, unchanged)
        │
        │  StateStore.list() / .load()          ← existing, exercised by 5 test files
        ▼
  S1 harvest ──► FailureRecord[]                 offline, read-only, fail-open
        ▼
  S2 classify ─► transient | step-local | durable, attributed two-level grouping
        ▼
  S3 author ───► PatchCandidate ──► .stratum/learn/candidates.jsonl
        ▼                                        (own schema, own file, idempotent)
  S4 apply ────► admission → journal → write → ledger commit ──► MEMORY-class only
                        │                        CAS revert by id
                        └── default OFF
```

Load-bearing properties:

1. **Zero engine change.** The reader consumes state the engine already persists. No new event type, no `JudgeResult` change, no judge-contract change, no hook. The off-path is untouched by construction, not merely byte-identical.
2. **Offline, not inline.** Harvest is a separate pass over completed runs. A harvest crash cannot fail a user's flow — a strict improvement on the Python design, which hung the harvest on the MCP consumer edge and had to be made fail-open by hand.
3. **Read-only until an explicit, guarded, default-OFF apply.** S1–S3 write nothing outside their own sidecar.
4. **Described intent, never a literal diff.** A stale literal diff applied later is a silent corruption; a stale described intent is visibly stale.

### 3.1 FailureRecord (S1)

```ts
interface FailureRecord {
  runId: string;
  flowName: string;
  stepId: string | null;      // null for flow-level failures (budget)
  specDigest?: string;        // PersistedRun.revisionDigest — identifies the contract that rejected
  attempt: number;
  reason: string;             // verbatim; never interpreted at this layer
  shape: FailureShape;        // "schema" | "ensure" | "gate" | "budget" | "other"
  workspaceRoot?: string;     // project attribution (§5 G1)
  at: string;
  recovered: boolean;         // a later attempt of the same stepId succeeded
}
```

**Two sources, not one.** Step-level failures are `result` events carrying `detail.failure`. Flow-level failures — budget exhaustion above all — never appear there: they are `budget_exhausted` events plus the run's top-level `failure` context (`{attempt, reason: "flow budget exhausted"}`, 158 runs). The reader consumes both, or `transient` has no members and the classifier has no negative class to be tested against.

`shape` is a cheap *structural* classification of the reason string (does it parse as a Zod issue array, does it start with `ensure`, is it a flow-level budget context). Semantics belong to S2, where they are testable against the real corpus.

`recovered` matters because a failure that self-heals on retry is invisible waste — the most valuable class to surface, and the one nothing currently reports.

The reader is fail-open per run: unreadable, truncated, or schema-drifted run files are skipped with a counter, never thrown. A corpus is not a contract.

### 3.2 Classification and grouping (S2)

| Class | Meaning | Corpus example | Action |
|---|---|---|---|
| `transient` | environment or budget; no durable lesson | the 158 `budget_exhausted` runs | drop |
| `step-local` | real, confined to one run's inputs | a one-off `invalid_type` | count, do not stage |
| `durable` | recurs across runs within a project | the 14 `outcome`-enum failures | stage a candidate |

**Normalization: the key is the violated contract, never the offending value.** Raw reason strings carry run-specific values and never group. But normalizing to "the failure" is also wrong, and the corpus shows exactly how. Across the 14 enum records, this is what varies and what does not:

| Field | Values across the cluster | In the key? |
|---|---|---|
| issue `code` | `invalid_enum_value` (all 14) | **yes** |
| issue `path` | `["outcome"]` (all 14) | **yes** |
| `options` (the declared enum) | `["complete","skipped","failed"]` (all 14) | **yes** |
| `received` | `success`, `revised`, `done`, `pass`, `approved` | **no** — evidence |
| `stepId` | 4 distinct | no (step-agnostic key) |
| `revisionDigest` | **2 distinct** | **no** — see below |

So the normalized detail is a **contract fingerprint**: `sha256(code, path, sorted expected/options)` for schema failures, with the analogous "what was violated" reduction for `ensure` and `gate` shapes. Rejected `received` values are aggregated onto the candidate as evidence, never keyed. Keying on `received` fragments the one real cluster into five.

**The unit of clustering is an issue, not a failure** (found during S2 implementation). A single failure can violate two unrelated constraints at once: two of the 14 records reject the `outcome` enum *and* a `commit_hash` type in the same response. Fingerprinting the whole failure makes those two records a different contract and splits the lesson 12 + 2. So each `FailureRecord` explodes into one `IssueUnit` per violated constraint, and a record is evidence for every lesson it actually evidences. Cluster evidence is deduped back to source records.

**Known residual risk: the fingerprint is an equivalence class, not an identity.** Two unrelated specs in the same project, sharing a flow name and declaring a structurally identical constraint, produce the same fingerprint and would pool their failures toward one threshold. There is no clean fix available from the persisted data — the only stable per-spec identifier is `revisionDigest`, and it changes on every edit (below), so it cannot serve as contract lineage. Rather than invent one, v1 **bounds the blast radius**: when a cluster's `specDigests` are disjoint *and* its `stepIds` are disjoint — the signature of two unrelated contracts merging rather than one contract observed across edits — the candidate is flagged `mixed_provenance`, reported as such, and is **not apply-eligible**. That is a mitigation, not a solution; a real contract-lineage identifier is open question 5.

**`specDigest` is carried and reported, never keyed.** The natural fix for "generic step ids from unrelated specs must not merge" is to put the spec digest in the key. Measured, that breaks the only real cluster in the corpus: its two runs have different `revisionDigest`s (`8fe2e116…`, `909f357f…`), because the spec was edited between them. A spec-digest key would split it into two single-run clusters, both failing the ≥2-runs bound. The contract fingerprint already does the job the spec digest was reached for — it identifies *the contract that was violated* rather than *the document it lived in* — and it survives ordinary spec edits, which is the point. Where `specDigest` varies within a cluster, that is recorded on the candidate and narrows its claimed scope.

**Grouping is attributed and two-level.** Both keys begin with `workspaceRoot`:

- **step-scoped** — `(workspaceRoot, flowName, stepId, shape, contract fingerprint)`; catches defects specific to one step.
- **step-agnostic** — `(workspaceRoot, flowName, shape, contract fingerprint)`; catches contract-level defects that no single step exhibits often enough. This is the key that recovers the 14× enum cluster. `flowName` is retained so that identically-named steps in unrelated flows cannot merge.

`flowName` and `specDigest` are carried so that generic step ids (`plan`, `verification`) from unrelated specs cannot be merged into a false lesson; where `specDigest` differs across a cluster, that fact is recorded on the candidate and narrows its claimed scope.

**The recurrence threshold is on breadth, not volume.** "Recurs at least N times" is ambiguous in exactly the way that matters, and the real corpus breaks both naive readings:

| Cluster | occurrences | distinct runs | distinct (run, step) pairs | should be |
|---|---|---|---|---|
| `outcome` enum | 14 | **2** | 6 | durable |
| `ship_gsd` test noise | 155 | 155 | 155 | **not** durable |
| one step retrying in one run | 6 | **1** | 1 | not durable |

Counting *occurrences* admits a single run's retry storm (6 from one step in one run). Counting *runs* rejects the one real cluster in the corpus, which lives in only 2 runs. Counting either without attribution admits 155 records of test noise.

A cluster is therefore `durable` when, **within one `workspaceRoot`**, it spans **≥ 2 distinct runs** and **≥ 3 distinct `(runId, stepId)` pairs**. The enum cluster passes at 2 runs / 6 pairs; a one-run retry storm fails on runs; the test-noise cluster is already excluded by attribution before this test is reached. Both bounds are configurable; the pair bound is what makes a repeated failure count as evidence rather than as one incident observed loudly.

**Unattributed records** (no `workspaceRoot`; 1 of 492) are harvested and counted but form their own segregated group, are never merged with attributed records, and are never apply-eligible. They can inform a human; they cannot authorize a write.

**Cross-project clusters do not exist in v1.** Every grouping key begins with `workspaceRoot`, so a cluster is single-project by construction and the candidate schema requires exactly one root. There is deliberately no cross-project aggregation: promising one while the representation cannot express it would be a contract the code could not keep. Cross-project lessons are open question 2.

### 3.3 Candidate authoring (S3)

```ts
interface PatchCandidate {
  cluster_id: string;            // sha256 of the grouping key — stable across re-harvests
  revision_id: string;           // content-addressed: sha256 of (cluster_id, template_version, rendered.content)
  mixed_provenance: boolean;     // disjoint specDigests AND disjoint stepIds — not apply-eligible
  schema_version: "learn-1.0";
  target_kind: "memory";         // v1 validates to memory only; skill/agent/command rejected at construction
  target_path: string;           // resolved, allowlist-checked at construction AND at apply
  scope: { workspaceRoot: string; flowName: string; stepIds: string[]; specDigests: string[] };
  claim: string;                 // one-line described intent
  rendered: {                    // the ACTUAL asset content — see below
    content: string;             // the note text that will be written
    template_id: string;         // which template produced it
    template_version: string;    // bump = new content for the same evidence
    insertion: { mode: "create" | "append-to-section"; section?: string };
  };
  evidence: FailureRecordRef[];  // non-empty; empty is a construction error
  observed_values: string[];     // aggregated `received` values etc. — evidence, never key material
  recurrence: { records: number; distinct_runs: number; distinct_pairs: number };
  grouping_key: "step-scoped" | "step-agnostic";
  requires_human_action: boolean;// true when the natural fix target is spec-class (§3.4)
  authored_at: string;
  authoring_inputs_digest: string; // §5.1 tripwire: what the author read, hashed
}
```

**Authoring is templated, not model-driven, in v1.** An LLM authoring mode is deliberately deferred: a template cannot over-generalize beyond its inputs — removing the largest source of the harm Critic 3 in `../STRAT-ADMIT/design.md` exists to catch — and it keeps candidate identity deterministic.

**The candidate carries rendered content, not just an intent.** A `claim` string alone is not enough for anything downstream: the behavioral-harmlessness critic (§5.1) has nothing to inspect if the asset text does not exist yet, and S4 has no source for the `after` bytes it must write and snapshot. So `rendered.content` is the actual note text, produced deterministically from `(template_id, template_version, grouping key, aggregated evidence)` — e.g.

> *In `build`, steps `explore_design`, `plan`, `blueprint`, `verification` returned `outcome` values outside the declared enum `complete|skipped|failed` (observed: `success`, `revised`, `done`, `pass`, `approved`) across 2 runs / 6 run-step pairs. The contract and the vocabulary agents actually use disagree.*

**Target selection and insertion are deterministic.** `target_path` is derived from `scope.workspaceRoot` by a fixed rule (the project's memory file under the allowlisted root), never chosen by a model. `insertion.mode` is `create` when the target does not exist, otherwise `append-to-section` under a fixed, named section reserved for harvested notes. The `after` bytes are therefore a pure function of `(before, rendered.content, insertion)` — which is what makes the apply journal's `after` digest computable at prepare time, and what makes a re-render at apply time verifiable rather than trusted.

Validation at construction: non-empty and resolvable evidence; `recurrence.records` equal to the cited record count; `distinct_runs` ≥ 2 and `distinct_pairs` ≥ 3; single `workspaceRoot`; allowlisted `target_path`; `target_kind === "memory"`; `rendered.content` non-empty and reproducible from the recorded template id/version. Any failure is an error, not a downgrade.

**Two ids, because one cannot do both jobs.** `cluster_id` is stable so a re-harvest recognizes the same lesson; `revision_id` is content-addressed so accumulating evidence or bumping a template produces a *new* immutable candidate rather than silently changing what an existing id denotes. The sidecar is append-only and idempotent on `revision_id`; `stratum learn list` resolves the latest revision per `cluster_id`. Apply always names a `revision_id`, so the bytes a candidate was admitted for are the bytes that get written.

The sidecar append is atomic, writes its own file with its own schema version, and never touches any pre-existing corpus file.

### 3.4 Target-class routing — and the honest limit of v1

| Target class | Example | v1 behavior |
|---|---|---|
| **spec-class** | "widen the `outcome` enum, or state the allowed values in the step instruction" | **Not appliable.** G4 puts specs on the immutable core. Staged with `requires_human_action: true`. |
| **memory-class** | "record that this project's `build` flow steps return non-enum outcome values" | Appliable, subject to §5. |
| **skill-class** | "patch the skill that authors these pipelines" | **Out of scope**, blocked on `../STRAT-ADMIT/design.md`. |

Stated plainly: **v1 does not fix the enum bug.** The natural fix is a spec edit, and v1 will never write a spec. What it does is convert a lesson that is currently invisible — fragmented across four steps, below threshold everywhere, buried under twelve times its volume in test noise — into one surfaced, attributed, evidence-carrying note. That is the whole reason it stayed invisible, and it is worth building. Claiming more would be false.

### 3.5 Apply and revert (S4)

Apply reuses the shipped `ts/src/guard` primitive for **authorization and tamper-evident history** (`registerGuard`, `guardTransition`, `appendLedger`, `guardHistory`). It does **not** assume that primitive can do more than it does.

Verified constraints on the existing primitive: `LedgerEntry` (`ts/src/guard/store.ts:153`) has no fields for evidence, snapshots, or candidate ids — `guardTransition` (`ts/src/guard/transition.ts:414`) hashes `artifacts` into `payload_digest` and commits registry + ledger, and **performs no file write**. Committing the ledger and writing the asset are therefore two operations, and a crash between them leaves either an "applied" entry with no change or an unledgered change.

**There is exactly one commit point, and it is the ledger.** The journal cannot be the recovery authority: it is a plain file this feature writes, so "journal says applied" is only ever a claim about what this feature intended. The guard ledger is hash-chained, verifiable (`verifyChain`, `ts/src/guard/store.ts:387`), and already the authorization record. Recovery therefore asks the ledger what happened and treats everything else as reconstructible state.

**Protocol:**

1. **Prepare.** Atomically write an apply-journal record (`.stratum/learn/applies/<apply_id>.json`) with state `prepared`: candidate id, target path, `before` content + digest, computed `after` content + digest (a pure function of before + rendered content + insertion, §3.3), evidence refs, admission verdicts.
2. **Transition to `applying`**, `artifacts` carrying the journal digest, so the ledger commits to one specific journal record and the link is verifiable in both directions.
3. **Write.** Atomic temp+rename of the target, only after confirming the on-disk digest still equals `before`.
4. **Commit — the ledger entry for `applying → applied`.** This append is the moment the apply becomes real. Everything before it is reversible; nothing after it changes the outcome.
5. **Finish.** Journal → `applied`. Bookkeeping only; its loss is not a correctness problem.

**Recovery** runs on any `learn` command and reconciles every journal that is not `applied`, plus — because step 5 can be lost — any `applied` journal whose ledger entry is missing. For each, the ledger is consulted for a committed `applied` transition naming that journal digest:

| Ledger says | Target digest | Action |
|---|---|---|
| committed | `after` | complete the journal; nothing else to do |
| committed | `before` | re-apply the write (the commit happened, the write did not survive) |
| committed | neither | **refuse**, report divergence — do not guess |
| not committed | `after` | roll back to `before`, then abort (below) |
| not committed | `before` | abort (below); nothing was written |
| not committed | neither | **refuse**, report divergence |

**Aborting must also terminate the guard, not just the journal.** Step 2 commits a `→ applying` transition to the ledger, and current state is derived from the ledger — so marking only the journal `aborted` leaves the guard resource permanently non-terminal and blocks every future apply to that target. Recovery therefore commits an **idempotent `applying → aborted`** transition (idempotent via `findByIdempotencyKey`, keyed on the apply id) before marking the journal. `aborted` is a terminal state in the resource's guard graph, registered alongside `applied`.

Two details of the shipped primitive that recovery must respect, rather than assume away: `guardTransition` **performs no file write** (`ts/src/guard/transition.ts:414`) — the asset write is ours to do and ours to reconcile — and the ledger is appended *before* the registry is persisted (`transition.ts:509`), so a crash can leave a valid ledger entry with a stale registry. Current state is therefore always derived from the ledger via `currentStateFromLedger` (`store.ts:437`), never read from the registry file. `findByIdempotencyKey` (`store.ts:427`) makes the transition itself replay-safe.

A journal in a non-terminal state blocks further applies to the same target until reconciled.

**Revert is compare-and-swap.** Revert of `apply_id` requires the target's current digest to equal that apply's recorded `after`. If it differs — an out-of-band edit, or a later apply stacked on top — revert **refuses** and reports the divergence; it never restores blindly over newer content. A stacked apply must be reverted in reverse order, or the conflict resolved explicitly. Tests cover out-of-band edit, stacked applies, and revert-after-revert.

**Default OFF** behind explicit config + env (`STRAT-GUARD` / `COMP-MCP-ENFORCE` precedent). With the flag off, `apply` refuses and no code path writes.

## 4. Non-goals

- Porting the postmortem corpus (~2,500 lines). Its own measured verdict was that the harness worked and the corpus was too sparse to calibrate anything (`n_scored=1`); the bottleneck was transcript volume, not code.
- Porting STRAT-DISTILL (new-asset synthesis). Blocked on STRAT-ADMIT by design.
- Applying skill-, agent-, or command-class assets. Same block.
- LLM-driven candidate authoring (§3.3).
- Editing specs, the judge kernel, or guard config, ever.
- Auto-triggering harvest. v1 is invoked explicitly.

## 5. Acceptance criteria — the five guardrails, with enforcement

- [ ] **G1 · Project-local scope by default.** Enforced by `workspaceRoot` as the *first* component of every grouping key (present on 491/492 runs). Clusters are single-project by construction; there is no cross-project representation in v1 (§3.2). Unattributed records form a segregated group that is never apply-eligible. **Test:** the 155-record `ship_gsd` set must produce zero durable candidates.
- [ ] **G2 · Small evidence-backed deltas only.** `evidence` non-empty and resolvable, `recurrence` equal to the cited record count, carried into the journal and the ledger `artifacts` digest. Construction with empty evidence is an error.
- [ ] **G3 · Snapshot + rollback by id.** Before/after content in the apply journal; revert by `apply_id` under compare-and-swap (§3.5). Necessary, **not sufficient** — see G5.
- [ ] **G4 · Immutable core.** Path allowlist, enforced at candidate construction **and** re-checked at apply against the resolved real path (symlink-resolved). Spec files, `ts/src/judge/**`, `ts/src/guard/**`, and guard registries are unreachable by construction.
- [ ] **G5 · Pre-commit admission.** Structural validity, semantic consistency, behavioral harmlessness, **and subset-level marginal-gain/conflict checks** run before the write (§5.1). Only lineage capture and lineage-aware revert are skipped for memory-class in v1. Full admission per `../STRAT-ADMIT/design.md` remains a hard precondition on ever extending apply to skill-class assets.

### 5.1 What memory-class may skip, and what it may not (revised)

`../STRAT-DISTILL-APPLY/design.md` requires this split be argued with evidence, not assumed. Round 1 of the design gate falsified the first version of this argument; this is the corrected one.

**The contamination mechanism** in Shang et al. is cross-round inheritance *through the authoring context*: a defective asset is read as reference material when the next asset is authored, so the flaw propagates and removing the source recovers little. The precondition is that the asset re-enters the decision context **of the author**.

**What memory-class may skip — lineage, and lineage only.** In v1 the author is a template (§3.3) whose only inputs are `FailureRecord`s derived from persisted runs. It does not read the memory pool, so the inheritance edge does not exist and there are no descendants to track. `authoring_inputs_digest` records what the author read, and an S3 test asserts the memory pool is not among its inputs.

An earlier version of this argument extended the same reasoning to subset-level admission. That was wrong, and the distinction matters: **the authoring edge and the reading edge are different edges.** Lineage exists because a defective asset is read *while authoring the next asset*; removing that edge removes lineage. Subset interaction exists because assets are read *together, later, by an agent doing work* — and memory notes are absolutely read together. Two notes can overlap enough to be redundant, or give conflicting guidance under conditions neither one mentions, without either having ever influenced the other's authoring. `../STRAT-ADMIT/design.md` §2.3 catches exactly that, and it applies to memory unchanged.

So memory-class admission runs: structural validity, semantic consistency, behavioral harmlessness, and subset-level marginal-gain and conflict checks against the existing notes. It skips lineage capture and lineage-aware revert.

**Falsifier and tripwire.** If any change makes memory content an input to candidate *authoring* — an LLM authoring mode that reads existing notes, a classifier that consults the pool — the edge exists, and full admission plus lineage becomes mandatory for memory. The boundary is authoring input versus write target: S4 necessarily *reads the target file* to snapshot it, and that is not the falsifier.

**What memory-class may NOT skip — behavioral harmlessness.** The first version of this design claimed memory is "declarative, not instructional" and skipped that critic. That is wrong, on this repository's own evidence: the memory format in use here has explicit `**How to apply:**` sections. These notes *are* instructions to a future agent, read as guidance and acted on. `../STRAT-ADMIT/design.md` §2.2 gives the canonical case — a note distilled from real, sound evidence that generalizes to "if the tree is dirty, discard changes and retry" passes structural validity and passes semantic consistency, and is caught only by an adversarial behavioral read. Reverting the note afterwards does not un-discard the work.

So memory-class apply runs the behavioral-harmlessness critic, including the deterministic hazard denylist (destructive shell forms, credential handling, control-bypass instructions targeting guard, ledger, or spec paths). Skills stay out of v1 because none of the *other* properties hold for them either, not because they are harder to implement.

## 6. Slice plan

| Slice | Deliverable | Files |
|---|---|---|
| **S1** | Harvest reader over `StateStore`, both failure sources, `FailureRecord`, fail-open | `ts/src/learn/harvest.ts` |
| **S2** | Classifier, normalization, attributed two-level grouping | `ts/src/learn/classify.ts` |
| **S3** | `PatchCandidate` schema + templated authoring + idempotent sidecar, `stratum learn harvest\|list` | `ts/src/learn/candidate.ts` |
| **S4** | Admission (3 critics), journal protocol, guarded apply, CAS revert, recovery, default OFF, `stratum learn apply\|revert` | `ts/src/learn/apply.ts`, `ts/src/learn/admit.ts` |

S1–S3 are read-only and shippable independently of S4; cut S4 and the feature still converts an invisible cross-step lesson into a surfaced, attributed note.

## 7. Test strategy

Golden flow, real backends, fixtures drawn from the actual persisted corpus rather than invented.

- **Golden flow:** harvest a fixture run directory → classify → author a candidate → admit → apply under the flag → verify file changed, journal terminal, ledger entry links the journal digest → revert by id → verify bytes restored and the revert recorded.
- **Classifier ground truth from the real corpus:**
  - a `budget_exhausted` run → `transient`;
  - a one-off `invalid_type` → `step-local`;
  - the 14 `outcome`-enum failures across 4 steps and 2 runs in one project → **one** step-agnostic `durable` candidate;
  - a single run retrying one step 6 times → `step-local`, never `durable` (fails the ≥2-runs bound).

  Fixtures for all of these are extracted from the real corpus into `ts/tests/fixtures/learn/flows/` (`enum-*.json`, `noise-*.json`, `budget-*.json`, plus `truncated.json` and `drifted.json`), not hand-written.
- **G1 noise regression (the §2.1 finding):** the 155 `ship_gsd` records across 155 ephemeral workspaces → **zero** durable candidates. An unattributed implementation passes every other test here and fails this one; that is the point of it.
- **Two-level grouping regression:** a single-level `(stepId, shape)` implementation must fail the 14× enum case.
- **Key-composition regressions**, each of which independently breaks the flagship cluster and so must be caught:
  - including `received` in the key → 5 clusters instead of 1;
  - including `revisionDigest` in the key → 2 single-run clusters, both failing the ≥2-runs bound;
  - dropping `flowName` from the step-agnostic key → identically-named steps in unrelated flows merge.
- **Determinism:** `rendered.content` and `id` are byte-identical across two harvests of the same fixture directory; `after` is reproducible from `(before, rendered.content, insertion)`.
- **Guardrail tests, one per gate:** records from two `workspaceRoot`s never merge into one cluster, and an unattributed record is never apply-eligible (G1); empty-evidence construction rejected (G2); CAS revert refuses on out-of-band edit and on stacked applies (G3); apply targeting a spec path, `ts/src/judge/**`, `ts/src/guard/**`, or a symlink escaping the allowlist is refused (G4); a candidate failing any of the three critics is refused pre-write (G5).
- **Crash recovery:** every row of the §3.5 reconciliation table, including the two `refuse` rows; an `applied` journal whose ledger entry is absent; a valid ledger entry with a stale registry (state derived from the ledger, not the registry file); a non-terminal journal blocking further applies to that target.
- **Default-OFF:** flag unset → apply refuses, nothing written.
- **Fail-open:** truncated and schema-drifted run files are skipped, counted, and do not throw.
- **§5.1 tripwire:** candidate authoring inputs do not include the memory pool.

## 8. Open questions for the gate

1. Recurrence bounds (≥2 runs, ≥3 run/step pairs) are derived from a corpus with exactly one qualifying cluster. The *shape* of the rule is well-grounded — three distinct failure modes in the data force it — but the constants are fitted to n=1 and should be revisited once more projects are harvested.
2. Should cross-project clusters be staged at all in v1, or suppressed until a project-scoping story exists?
3. Should `stratum learn harvest` write the sidecar by default, or require `--stage`?
4. Behavioral-harmlessness critic model routing and cost, given it now runs on every memory apply.
5. **A contract-lineage identifier.** The fingerprint is an equivalence class, not an identity (§3.2); `mixed_provenance` bounds the damage but does not fix it. A stable per-contract id that survives spec edits would, and nothing in the persisted run state currently supplies one.
