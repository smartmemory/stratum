# STRAT-STEPDONE-PROVENANCE-1: usage provenance + real dispatch ids on stepDone settlement — Design

**Status:** DESIGN
**Date:** 2026-09-19

## Related Documents

- Blocks: compose `COMP-COST-OWNER-1` (`docs/features/COMP-COST-OWNER-1/design.md` in the
  `compose` repo) — its "next attempt" cannot ship without this.
- Parent problem: compose `COMP-COST-OWNER` (`docs/features/COMP-COST-OWNER/design.md`,
  `evidence/step-envelope-usage-2026-09-14.md`).
- Sibling ticket on this side, **not the same scope**: `STRAT-LEARN-COST-1` (price-table
  freshness job + Claude connector's false labelled-$0). That ticket was incorrectly cited by
  compose's design.md as covering this work — it does not. This ticket is the correction.

---

## Problem

Compose wants every ordinary dispatch to settle with stratum exactly once: via an acknowledged
usage receipt (`stratum_usage_report`) OR a usage-bearing `stepDone` envelope, never both,
never neither. Two gaps in stratum's engine/contract make that unachievable from compose's side
alone, traced 2026-09-14 and confirmed still present 2026-09-19:

1. **No room for provenance on stepDone.** `stratum_step_done.request.result` (contract surface
   20, `ts/contracts/mcp-surface.json`) declares exactly four keys: `output?`, `failure?`,
   `usage?`, `telemetry?`. There is no `usdSource` (where the cost number came from) and no
   `split` (input/output token breakdown) — both already exist elsewhere in the same surface
   (agent_run responses, usage_report receipts), so compose's first attempt assumed they existed
   on stepDone too and shipped an envelope fallback that sent them. The contract validator
   (`contracts.ts:123`) throws `<path>.<key> is undeclared` and rejected it, failing 10 real
   real-engine golden tests. A narrower, mocked test run had stayed green and hid this.

2. **No real dispatch id on envelope settlement.** `engine.ts:2763` stamps every envelope
   settlement with a synthesized `legacy:${seq}` id, not the dispatch's real id. Compose cannot
   tell "this stepDone envelope" and "this usage receipt" are reporting the *same* dispatch, so
   it cannot deduplicate — which is the direct cause of two double-debit defects astra found in
   compose's reverted first attempt (retry-spool double-debit, lost-ack-write double-debit).

## Goal

Give compose the two contract-level primitives its exactly-once settlement invariant needs.
This ticket does NOT implement compose's settlement logic (receipt vs. envelope exclusivity,
acknowledgement, retry) — that stays entirely on the compose side
(`COMP-COST-OWNER-1`, scoped narrowly to `lib/build.js`'s receipt region + `lib/new.js`).

In scope:
- Declare `usdSource?: string` and `split?: object` on `stratum_step_done.request.result` in
  the MCP contract, and thread them through `engine.stepDone` (which already reads them
  internally per compose's design doc — only the contract gate was missing).
- Replace the `legacy:${seq}` placeholder with the dispatch's real id when an envelope settles,
  so a receipt and an envelope for the same dispatch carry the same id and can be matched.

Out of scope:
- Any settlement/dedup logic itself — that's compose's, once it has real ids to key on.
- `STRAT-LEARN-COST-1`'s actual scope (price-table freshness, Claude connector false-$0 fix) —
  unrelated, do not conflate.

## Decision 1: Additive contract bump, no breaking change

Both new fields are optional (`usdSource?`, `split?`), and the dispatch id change replaces an
internally-synthesized placeholder with a real value of the same type — no existing caller of
`stratum_step_done` breaks. Ship as a surface bump (next surface number after 20), same pattern
as prior additive bumps.

## Falsifiers

- `ts/contracts/mcp-surface.json`'s `stratum_step_done.request.result` declares `usdSource?`
  and `split?`.
- `engine.ts` no longer assigns `legacy:${seq}` to an envelope settlement when a real dispatch
  id is available; a receipt and an envelope for the same dispatch carry matching ids.
- Compose's real-engine golden tests (the ones that caught the original contract refusal) pass
  with an envelope that sets `usdSource`/`split`.

## Files

| File | Action | Purpose |
|------|--------|---------|
| `ts/contracts/mcp-surface.json` | modify | declare `usdSource?`, `split?` on stepDone result |
| `ts/src/engine/contracts.ts` (or wherever the surface number is bumped) | modify | surface version bump |
| `ts/src/engine/engine.ts` (~2763, ~888) | modify | real dispatch id on envelope settlement instead of `legacy:${seq}` |
| `ts/src/mcp/*` (stepDone handler) | modify | thread `usdSource`/`split` through to the engine call already reading them |
| stratum test suite | modify | contract + engine coverage for both changes |

## Open Questions

- Exact surface number for this bump — assign at implementation time (next after the current
  released surface).
- Whether the "real dispatch id" is already available at the envelope-settlement call site or
  needs to be threaded in from further up the call stack — implementation detail, not a design
  blocker.
