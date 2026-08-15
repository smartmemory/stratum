# STRAT-ADMIT — Design

**Pre-commit admission gate for skill-class assets.**

**Status:** DESIGN (2026-08-15) · **Owner:** stratum · **Kind:** design only, no implementation in this document

## Related Documents

- Guardrail source (this feature *is* guardrail 5): `../STRAT-DISTILL-APPLY/design.md` §"Apply-path guardrails", §"Pre-commit admission — rationale"
- Blocked-on-this: `../STRAT-TS-LEARN/design.md` §3.3 (skill-class targets excluded from v1), §5.1 (why memory-class does not need this)
- The loop that creates the contamination chain: `../STRAT-DISTILL/design.md` (Phase 2 "inventory existing assets, extend-not-duplicate")
- Deferred consumer: `../STRAT-DISTILL-AUTO/design.md` (auto-trigger composed with an apply path is gated on this)
- Roadmap row: `/Users/ruze/reg/my/forge/ROADMAP.md` → Standalone Tickets → STRAT-ADMIT

---

## 1. Problem

Guardrails 1–4 of the apply path all constrain **what a write may touch**: which scope, backed by what evidence, restorable how, within which path allowlist. None of them asks the only question that matters for a growing asset pool: **does admitting this asset make the pool better?**

For skill-class assets — `SKILL.md`, `agent/*.md`, `command/*.md`, anything read by an agent as instruction — that question cannot be deferred to post-hoc cleanup, because of a specific structural property of how the assets are produced.

### 1.1 The contamination chain

STRAT-DISTILL's synthesis phase inventories the existing asset pool before authoring a new asset, so that the new one extends rather than duplicates what is already there. That inventory step means:

```
asset A (defective) ──read as reference──► authoring of asset B
                                                   │
                                                   ├──► B inherits A's defect
                                                   │
                                                   └──read as reference──► authoring of asset C ...
```

Three consequences follow, and each one breaks a guardrail that looked sufficient:

1. **The defect outlives its source.** Reverting A by id (guardrail 3) removes A. It does not remove what B and C absorbed from A while A was live. Per-asset rollback recovers only a fraction of the damage.
2. **The damage is not visible at A's admission time.** A may be individually plausible and still be a bad reference. Nothing in a per-candidate check sees the descendants it will produce.
3. **Accumulation is not monotonic.** Past some pool size, adding assets makes the agent worse rather than better, so "recurred twice, not already covered" — STRAT-DISTILL v1's admission bar — is a *relevance* test being asked to do the job of a *quality* test.

This is the same loop shape in our system, not an analogy: the distiller reads the pool to produce the next asset. That is the precondition, and we meet it.

### 1.2 Evidential basis, and its limits

The mechanism above is argued in Shang et al., *"When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination in LLM Agents"* (arXiv:2608.05810, Aug 2026), which reports non-monotonic skill accumulation, cross-round inheritance of defects, and the near-irreversibility of post-hoc source removal, plus a three-critic pre-commit gate with subset-level selection.

**What this design takes from it:** the *mechanism* and the *shape* of the remedy (pre-commit, heterogeneous critics, subset-level selection).

**What it does not take:** the reported magnitudes. It is a single preprint, evaluated on Terminal-Bench 2 plus one transfer benchmark. Figures such as "72% pass@1" and "~5× smaller pool" are **indicative only** and must not appear as targets, thresholds, or acceptance criteria anywhere downstream of this document. Critic count and decomposition are our design decisions, argued below on our own constraints; the ablation result that the three critics are complementary and non-substitutable is treated as a reason to keep them separate, not as a proof.

If the mechanism is wrong, the cost of this gate is some rejected-but-fine candidates. If the mechanism is right and we skip the gate, the cost is a pool that degrades silently and cannot be cleaned up. That asymmetry, not the reported numbers, is the justification.

## 2. Design

### 2.1 Position in the pipeline

```
staged candidate ──► [ per-candidate critics ] ──► [ subset admission ] ──► guarded apply ──► pool
                            reject ──┘                    defer ──┘
                     ▲                                                              │
                     └──────────────── lineage recorded at apply ────────────────────┘
```

Admission runs **before** the guarded transition, not inside it. The guard primitive answers "is this write authorized and recorded"; admission answers "should this asset exist at all". Conflating them would make a rejection look like an authorization failure in the ledger, which is exactly the signal we want to keep distinct.

Rejection is not deletion. A rejected candidate stays staged with its verdicts attached, because the rejection reasons are themselves the highest-signal training data for the next iteration of the distiller.

### 2.2 The three critics

Each critic is independent, sees the candidate plus a different slice of context, and returns a verdict. They are separate because they intercept **disjoint classes of harm**: a candidate can be perfectly well-formed and behaviorally dangerous, or safe and well-formed while claiming evidence it does not have. A single merged critic reliably trades one for another.

Admission requires **all three** to pass. Any single reject blocks the write.

---

#### Critic 1 — Structural validity

*Is this a well-formed asset of its declared kind?*

| | |
|---|---|
| **Input** | The candidate's rendered asset content; its declared `asset_kind`; the format contract for that kind |
| **Output** | `{ passes, violations[], severity }` |
| **Method** | Deterministic where possible (frontmatter schema, required sections, name uniqueness against the pool, path shape, declared-tool validity), LLM only for "is the description a description" style checks |
| **Catches** | Malformed frontmatter, missing required fields, a name colliding with an existing asset, a skill declaring tools that do not exist, a command referencing an undefined argument |

**Worked reject.** A synthesized skill whose frontmatter `description` is `"Use this skill"` — schema-valid, non-empty, and useless. The routing layer selects skills by description; a description that does not describe makes the asset either never selected or selected for everything. Deterministic rule: description must name a trigger condition and a subject. Reject with `violations: ["description states no trigger condition"]`.

---

#### Critic 2 — Behavioral harmlessness

*If an agent follows this asset literally, what happens?*

| | |
|---|---|
| **Input** | The candidate content, read as instructions to be obeyed |
| **Output** | `{ passes, hazards[], severity }` |
| **Method** | LLM adversarial read, prompted to simulate literal compliance and to report the worst reachable outcome, plus deterministic scans for a hazard denylist (destructive shell forms, credential handling, network egress, history rewriting, guard/ledger paths) |
| **Catches** | Instructions that are damaging, irreversible, security-relevant, or that instruct the agent to bypass a control |

**Worked reject.** A skill distilled from a genuine recurring workflow — an agent repeatedly recovered from a dirty tree before retrying — that generalizes to `"if the working tree is dirty, run git checkout -- . and retry"`. Every observation supporting it is real; the evidence is sound; the generalization destroys uncommitted work. Structural validity passes, semantic consistency passes (it *is* what the traces show), and only an adversarial behavioral read catches it. This is the canonical case for keeping the critics separate.

A second class: any candidate instructing an agent to write to `docs/judgment/**`, guard registries, or a spec file. That is a control-bypass instruction regardless of intent, and the denylist catches it deterministically.

**This critic is not skill-only.** `../STRAT-TS-LEARN/design.md` §5.1 originally excluded memory-class candidates from admission on the grounds that notes are declarative. That was falsified: this repository's memory format carries explicit `**How to apply:**` sections, so notes are instructions a future agent reads and acts on, and the `git checkout -- .` example above passes both other critics. Memory-class applies therefore run this critic too. Memory may skip §2.3 subset admission and §2.4 lineage — argued there — but not this.

---

#### Critic 3 — Semantic consistency with claimed evidence

*Does the asset generalize what its evidence actually shows, and no more?*

| | |
|---|---|
| **Input** | The candidate content **and** the raw evidence records it cites |
| **Output** | `{ passes, overreach[], evidence_support, severity }` |
| **Method** | LLM comparison of claim scope against evidence scope, with deterministic pre-checks (evidence non-empty, records resolvable, recurrence count matches the cited records, attribution consistent) |
| **Catches** | Over-generalization beyond the observed conditions, evidence that does not support the claim, silently widened scope, stale evidence |

**Worked reject.** Evidence: 155 `ship_gsd` schema failures, all from one pipeline in one project. Candidate: `"agent steps should accept camelCase and snake_case output keys"` — a universal rule inferred from a single step in a single pipeline. The evidence is real and voluminous, and the volume is precisely what makes the overreach persuasive. Reject with `overreach: ["evidence spans 1 stepId in 1 workspaceRoot; claim is unscoped"]`; the correctly scoped version is admissible.

Note that recurrence *count* does not bound generalization *scope*. Conflating the two is the failure this critic exists for, and it is the specific reason recurrence-threshold admission is insufficient.

---

### 2.3 Subset-level admission

Per-candidate critics cannot see interaction. Three individually clean assets can still be a bad pool: two that overlap enough to make routing ambiguous, or one that contradicts another's guidance under conditions neither one mentions.

Admission therefore has a second tier, evaluated against the **current pool plus the already-admitted candidates of this batch**:

1. **Marginal contribution.** What does this asset add that the pool does not already cover? A candidate whose coverage is a near-subset of an existing asset is rejected as redundant *or* routed as an edit to that asset — never admitted alongside it. This is stronger than STRAT-DISTILL's extend-not-duplicate inventory check, which is per-candidate and advisory.
2. **Pairwise conflict.** Does this asset instruct something another asset forbids, or claim a trigger another asset also claims? Conflicts are surfaced with both sides, and are a **defer**, not a silent reject: the resolution is usually a human decision about which asset is right.
3. **Pool-size pressure.** Admission gets stricter as the pool grows, on the non-monotonicity argument in §1.1. The exact curve is an open question (§5); what is settled is that the bar is a function of pool state, not a constant.

Batch order must not decide outcomes: subset admission evaluates the batch as a set, and a deterministic tie-break (evidence strength, then candidate id) is required so that two runs over the same batch admit the same subset.

### 2.4 Lineage

Lineage is what makes rollback mean something. It is not reconstructible after the fact, which is why it must be captured — and captured **at the moment it exists**, which is authoring time, not apply time.

**Capture is three-phase, because the three facts are true at three different moments:**

1. **At authoring** the distiller records `pool_snapshot` — the id and content digest of every asset in its context — into the *staged candidate*. This is the only moment that set is known. Recording it at apply time would mean reconstructing it from a pool that has since moved, i.e. inventing it.
2. **At admission** each critic verdict is bound to the digests it judged: the candidate digest and the pool digest it evaluated against. A verdict that does not name what it looked at cannot be checked later, and cannot be invalidated when the pool moves.
3. **At apply**, under a **pool-scoped lock**, admission is revalidated: if the current pool digest differs from the one the verdicts were bound to, the verdicts are stale and admission re-runs before any write. Without the lock and the revalidation, subset-level admission is evaluated against a pool that can change before the write lands, and "this asset adds marginal value to the pool" is a claim about a pool that no longer exists.

**Revalidation is batch-scoped, not per-candidate — otherwise it reintroduces the order dependence §2.3 forbids.** A batch is admitted as a set against pool digest `P0`. Applying the first candidate moves the pool to `P1`, which staleness-checks every remaining verdict in that same batch; re-running admission candidate-by-candidate would then select a different subset depending on apply order, contradicting the deterministic-set requirement. So:

- the **batch** — not each candidate — is the unit of admission, revalidation, and apply;
- the pool-scoped lock is held across the whole batch, and pool digests advanced by this batch's own applies do not invalidate its verdicts (each apply's expected resulting digest is recorded at admission, so a self-caused change is distinguishable from a foreign one);
- a **foreign** change to the pool mid-batch aborts the remainder and re-admits the unapplied set as a new batch;
- **an immutable batch manifest is persisted before the first write**, without which recovery cannot see the remainder at all: candidates that were admitted but never reached the journal stage would simply vanish. The manifest records `batch_id`, ordered membership by `revision_id`, the admitting pool digest `P0`, the predicted post-apply digest chain, and the critic verdicts; every apply journal carries its `batch_id`;
- **partial batch recovery:** each apply is individually journaled and committed (`../STRAT-TS-LEARN/design.md` §3.5), so a crash mid-batch leaves a prefix applied and the remainder unapplied. Recovery reads the manifest, reconciles the prefix, then re-admits the manifest's unapplied remainder as a fresh batch against the pool as it now stands. A partially applied batch is never resumed on stale verdicts.

**Recorded per apply:**

| Field | Why |
|---|---|
| `apply_id` | Revert handle |
| `asset_path`, content digest before/after | Guardrail 3 |
| `evidence_ids[]` | Guardrail 2 |
| `pool_snapshot[]` — the id + digest of **every asset in the distiller's context when this candidate was authored**, copied from the staged candidate | The parent set. This is the edge that makes the chain traversable. |
| `critic_verdicts[]`, each bound to the candidate digest and pool digest it judged | Why it was admitted, and whether that judgement is still valid |
| `admission_tier` | Per-candidate pass vs. subset-admitted |
| `revalidated_at_apply` | Whether the pool moved between admission and apply, and what re-ran |

`pool_snapshot` is the load-bearing field. Without it there is no way, later, to ask "what did this asset help produce".

**Lineage-aware revert** of asset A must:

1. Restore A from its snapshot under **compare-and-swap**: the target's current digest must equal the digest this apply wrote. If it differs — an out-of-band edit, or a later apply stacked on A — revert refuses and reports the divergence rather than restoring over newer content. Blind restore-by-snapshot silently destroys whatever landed after the apply being reverted, which is a data-loss bug wearing the costume of a safety feature.
2. Traverse forward: find every applied asset whose `pool_snapshot` contained A at its authoring digest — A's descendants, transitively.
3. **Surface them, and offer a choice per descendant: revert it too, or re-gate it** (re-run admission with A removed from the pool). Neither auto-reverting descendants nor silently leaving them is acceptable: the first destroys work that may be independently good, the second is exactly the "post-hoc removal recovers a fraction" failure.
4. Record the traversal in the ledger, so a partial revert is itself auditable.

A revert that reports only the asset it removed is a **false green**, and this is the specific claim that demotes guardrail 3 from sufficient to necessary.

## 3. Non-goals

- Any runtime quality scoring of assets in use. Admission is pre-commit; observing an asset's live effect is a separate problem.
- Automatic resolution of pairwise conflicts. Conflicts defer to a human.
- Retroactive admission of the existing asset pool. Assets already in place are grandfathered; this gate governs new writes. (Retro-auditing the pool is a plausible follow-up and is not scoped here.)
- **Lineage** (§2.4) for memory-class targets, argued in `../STRAT-TS-LEARN/design.md` §5.1 with a named falsifier: if candidate authoring ever reads the memory pool, lineage applies to memory too. The critics (§2.2) and subset admission (§2.3) **do** apply to memory — notes are read together by a working agent even when they never influenced each other's authoring.
- Implementation. This document specifies the gate; slicing, file layout, and critic prompts belong to a blueprint.

## 4. Dependencies

- **Hard precondition for:** extending any apply path to skill-class assets (`STRAT-TS-LEARN` S4 extension, `STRAT-DISTILL-APPLY`, `STRAT-DISTILL-AUTO` composed with apply).
- **Requires:** a staged-candidate representation carrying resolvable evidence (STRAT-TS-LEARN S3 supplies this shape), and the guard ledger for the lineage fields (shipped).
- **Not required by:** STRAT-TS-LEARN v1, which is memory-class only. That is the whole reason v1 can ship first.

## 5. Open questions for the design gate

1. **Pool-size pressure curve.** Settled that the bar rises with pool size; unsettled what function, and measured against what. We have no local corpus of asset-pool degradation, so any curve is a guess until instrumented.
2. **Critic model routing and cost.** Three critics per candidate, at least two LLM-driven, is real spend on every admission. Which tier, and is critic 2 worth a stronger model than the other two?
3. **Failure mode of the critics themselves.** Fail-closed (block the write) is the safe default, but a flaky critic then silently stops all learning. Does a fail-closed admission need an escape hatch, and if so, what authorizes it?
4. **Is `pool_snapshot` the right granularity** — every asset in context, or only those the distiller demonstrably read? Every-asset is safe and over-broad, and makes descendant sets grow quickly.
5. **Does defer need a queue?** Pairwise conflicts defer to a human; without somewhere for them to sit, defer degenerates into reject.
6. **Lock granularity and contention.** §2.4 requires a pool-scoped lock spanning revalidation and write. Pool-wide is correct and coarse; whether a finer scope is safe depends on whether subset admission can be decomposed, which is unresolved.
7. **Write atomicity for asset applies.** The shipped guard primitive commits a ledger entry but performs no file write (`ts/src/guard/transition.ts:414`), so ledger and asset are two operations. `../STRAT-TS-LEARN/design.md` §3.5 specifies a prepare/write/commit journal with reconciliation for memory-class applies; skill-class applies need the same protocol, and whether they share one journal implementation is a blueprint question.
