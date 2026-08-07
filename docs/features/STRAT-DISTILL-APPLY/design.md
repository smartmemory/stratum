# STRAT-DISTILL-APPLY — Design stub

**Status:** PLANNED (follow-up to STRAT-DISTILL v1, filed 2026-06-14). Pre-design.

**Problem:** STRAT-DISTILL v1 only *stages* asset candidates (described `SKILL.md` /
`agent/*.md` / `command/*.md` content in the sidecar + tool result). The
`stratum_distill` tool already accepts an `apply` flag but it is reserved/no-op —
v1 never writes the asset to the working tree (STRAT-IMMUTABLE / staged-not-applied).

**Scope:** graduate `apply=True` to actually scaffold the chosen asset file(s) from a
staged `AssetCandidate`, gated behind **STRAT-GUARD-style authorization** (not
agent-mintable): a guarded transition with a human/authorized-token approval and a
tamper-evident ledger entry, since this writes executable scaffold into the user's
config. Verify emitted paths (Glob) + referenced symbols (Grep) post-write, per the
MiMo distill Phase-6 discipline.

**Non-goals:** auto-applying without authorization; v1's staging behavior (unchanged
when `apply=False`).

**Dependencies:** STRAT-DISTILL v1 (shipped in the retired Python engine — see engine
note below), STRAT-GUARD (shipped — reuse the guarded-transition + ledger primitive).

## Engine note (2026-08-06)

STRAT-DISTILL v1 and the STRAT-LEARN-INLINE harvester shipped in the Python engine,
which was retired with STRAT-PY-RETIRE (2026-07-18). Neither exists in `ts/src`
(`grep -r distill ts/src` → 0 hits). Any apply path therefore has a **TS port of the
staging substrate as a precondition** — this stub's scope is unchanged, but it cannot
start until the harvester/distill staging layer exists in the TS engine. Python
reference implementation: `git show python-legacy:src/stratum/judge/inline_learn.py`
and `python-legacy:src/stratum/judge/postmortem/corpus.py`.

## Apply-path guardrails (adopted 2026-08-06, IDEA-1199)

Acceptance criteria for ANY self-modification apply path (this feature and
STRAT-LEARN-INLINE-APPLY share them). Gates 1-4 adopted from the prime-agent `/refine`
continual-harness constraint set (smart-memory-docs ideabox IDEA-1199); gate 5 added
2026-08-07 (see "Pre-commit admission" below). Together they turn "is self-modification
safe to enable" into five checkable gates:

- [ ] **Session/project-local scope by default** — an applied patch lands in project
  scope; promotion to global/user scope is a separate explicit authorized step
- [ ] **Small evidence-backed deltas only** — every applied patch carries the staged
  candidate's evidence (failed predicate / recurrence trace) in the ledger entry;
  no evidence, no apply
- [ ] **Snapshot + rollback by id** — before/after snapshot of every touched asset,
  persisted with the ledger entry; a revert tool restores by refinement/apply id.
  **Necessary but NOT sufficient** — see gate 5: per-asset rollback does not undo what
  descendants distilled from the asset while it was live
- [ ] **Immutable core** — the base spec, judge kernel, and guard config are never
  apply targets; applies only ever write skills / MEMORY / scaffolded assets
  (enforce as a path allowlist, not a convention)
- [ ] **Pre-commit admission gate + lineage-aware rollback** — no candidate reaches an
  applied asset pool on recurrence count alone. Two sub-criteria, both required:
  - [ ] **Admission is pre-commit, per-candidate AND subset-level.** Each candidate
    passes independent critics before it is written (structural validity of the emitted
    asset, behavioral harmlessness of what it instructs, semantic consistency with the
    evidence it claims to generalize). Beyond individual filtering, admission considers
    the candidate's *marginal* contribution to the existing pool — the existing
    extend-not-duplicate inventory check is per-candidate and does not cover pairwise or
    combinatorial interaction between individually-clean assets.
  - [ ] **Applies record lineage, and rollback walks it.** Every apply records which
    pool assets were in the distiller's context when the candidate was produced. Revert
    by id must surface (and offer to revert or re-gate) the descendants distilled while
    the reverted asset was live, not just the asset itself.

### Pre-commit admission — rationale (added 2026-08-07)

Source: *"When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination
in LLM Agents"* (Shang et al., arXiv:2608.05810, Aug 2026). Single-preprint, evaluated
on Terminal-Bench 2 plus one transfer benchmark — treat the **mechanism** as load-bearing
and the reported magnitudes (72% pass@1, ~5x smaller pool) as indicative only.

Three findings, and why each binds here:

1. **Skill accumulation is non-monotonic.** Past a critical pool size, newly distilled
   skills degrade agent performance rather than improving it; unconditional accumulation
   peaks and then gives back most of its gains. Gates 1-4 constrain *what a write may
   touch*; none of them ask whether admitting the asset makes the pool better. STRAT-DISTILL
   v1's bar (recurred >=2x with stable inputs, not already covered by an existing asset) is
   a relevance test, not a quality test.
2. **Contamination is cross-round and structurally irreversible.** A defective asset in
   the decision context becomes reference material when distilling later assets, so the
   flaw is inherited by descendants; post-hoc removal of the source recovers only a small
   fraction of the lost performance. **The precondition holds for us**: STRAT-DISTILL's
   Phase 2 is "inventory existing assets (extend-not-duplicate)" — the distiller reads the
   pool to produce the next asset. This is the same loop shape, not an analogy. It is also
   what demotes gate 3 from sufficient to necessary: rollback is per-asset by id with no
   lineage, which recovers exactly the small fraction the paper measures.
3. **Therefore admission must be pre-commit.** Their VaG gate composes three heterogeneous
   critics (structural validity / behavioral harmlessness / semantic consistency), reported
   as complementary and mutually non-substitutable in ablation, each intercepting a largely
   disjoint class of harmful skill, plus marginal-gain subset selection at the top tier to
   remove combinatorial contamination before skills reach the runtime context. Gate 5
   adopts the shape, not the implementation — critic count/decomposition is a design-gate
   question, not settled here.

Scope note: the contamination argument is strongest for assets that re-enter the
decision context and are read when authoring the next asset (`SKILL.md`, `agent/*.md`,
`command/*.md`). It is weaker for MEMORY patches, which are smaller and less often
reference material. Gate 5 still applies to both — a split, if justified, should be
argued at the design gate with evidence, not assumed.

**Related:** `../STRAT-DISTILL/design.md` (the inventory step that forms the chain),
`../STRAT-DISTILL-AUTO/design.md` (gate 5 is a hard precondition on composing an auto
trigger with an apply path — staging-only auto-run is unaffected),
`../STRAT-LEARN-INLINE/report.md` §7.
