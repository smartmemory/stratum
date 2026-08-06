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
STRAT-LEARN-INLINE-APPLY share them). Adopted from the prime-agent `/refine`
continual-harness constraint set (smart-memory-docs ideabox IDEA-1199); they turn
"is self-modification safe to enable" into four checkable gates:

- [ ] **Session/project-local scope by default** — an applied patch lands in project
  scope; promotion to global/user scope is a separate explicit authorized step
- [ ] **Small evidence-backed deltas only** — every applied patch carries the staged
  candidate's evidence (failed predicate / recurrence trace) in the ledger entry;
  no evidence, no apply
- [ ] **Snapshot + rollback by id** — before/after snapshot of every touched asset,
  persisted with the ledger entry; a revert tool restores by refinement/apply id
- [ ] **Immutable core** — the base spec, judge kernel, and guard config are never
  apply targets; applies only ever write skills / MEMORY / scaffolded assets
  (enforce as a path allowlist, not a convention)
