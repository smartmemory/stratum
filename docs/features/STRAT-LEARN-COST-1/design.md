# <Feature Name>: Design


## Why

Two stratum-owned residues of compose's COMP-COST-OWNER, audited 2026-09-14 (compose docs/features/COMP-COST-OWNER/design.md, evidence/*). (a) S4 — a scheduled diff of the pinned MODEL_PRICING table (ts/src/judge/pricing.ts:27-33) against LiteLLM that opens an item on drift, never runs at runtime, and excludes gpt-5.3-codex-spark by name with the reason already documented at pricing.ts:20-24. Compose's design.md:556-560 transferred this to stratum; no stratum feature or commit delivered it (only publish.yml/test.yml exist; 00ff4db corrected the table by hand). (b) ts/src/connectors/claude.ts:71 initialises `let costUsd = 0` and :180-186 emits `step_usage` with `cost_usd: costUsd, usd_source: "reported"` — a labelled $0 whenever the SDK reported no cost, rationalised in-comment as "a 0 total means a genuinely free turn". That is the S2 defect class (unknown silently becomes free with provenance attached). It currently reaches only the streamed metadata channel, not compose's receipt path — compose relaxed its usageRecordFromRaw guard to cost >= 0 in 583b14f on that basis, so routing this event into receipts without fixing it would reintroduce a false labelled zero. Fix shape: cost stays null until a real number is reported; usd_source is stated only alongside a real number. Falsifiers: (a) a scheduled workflow under .github/workflows that diffs pricing.ts against LiteLLM exists; (b) claude.ts no longer initialises costUsd to 0 and the step_usage emit carries no usd_source when cost_usd is null.

**Status:** DESIGN
**Date:** <date>

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
