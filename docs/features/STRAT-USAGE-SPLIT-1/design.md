# STRAT-USAGE-SPLIT-1: Design — no split on a dispatch that reported no usage


## Why

STRAT-USAGE-SPLIT deferred the build-stream-schema unmeasured-vs-zero criterion on the grounds that the case was only reachable from legacy envelopes. Closure verification on 2026-09-22 found it is still reachable on the live route: ts/src/connectors/claude.ts error path (around :229) attaches split: { input: 0, output: 0, cacheRead, cacheCreation } unconditionally, while the success path only carries values it has. A cancelled run's never-started step was ledgered as tokens_in 0 / tokens_out 0 / usd null, indistinguishable from a genuinely free call. Fix is small and connector-side (omit split and tokens when no usage event was received) plus keeping finiteOrNull semantics on the compose row. Separate ticket so the parent can close on its verified deliverable.

**Status:** PLANNED
**Date:** 2026-09-22

## Related Documents

- Parent: `../STRAT-USAGE-SPLIT/design.md`, closure evidence in `../STRAT-USAGE-SPLIT/progress.md` (2026-09-22 section)
- Connector: `ts/src/connectors/claude.ts` (error path near `:229`); consumer: `compose/lib/stratum-mcp-client.js` (`finiteOrNull(split.input)`)

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
