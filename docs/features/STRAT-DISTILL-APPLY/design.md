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

**Dependencies:** STRAT-DISTILL v1 (shipped), STRAT-GUARD (shipped — reuse the guarded
-transition + ledger primitive).
