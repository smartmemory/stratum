# STRAT-GATE-WITNESS-1 — record the consumed gate token on `gate_resolved`

**Status:** PLANNED
**Filed:** 2026-09-17
**Origin:** compose `COMP-GATE-HEADLESS-1`, commit `bacab32` (arm 3)

## Related Documents

- compose `docs/features/COMP-GATE-HEADLESS-1/design.md` — the consumer that needs this
- compose `lib/build.js` — the four-arm adoption discriminator in `runBuild`'s `gateResolve` catch block; arm 3 is the hole this closes
- compose `lib/routing-gates.js:186-225` — `acknowledgeRoutingGate`, which already builds a `token-engine-witness` from routing carry provenance
- `docs/features/STRAT-REOPEN-FAILED-1/design.md` — the adjacent surface that was KILLED; this is not that, and does not reopen anything

## Problem

A Compose build resolves a gate by calling `gateResolve` over MCP. If that call reaches the
engine and the *response* is lost (dropped connection, killed client, an ack that throws after
the engine has already committed), Compose must decide whether the decision it sent is the one
the engine recorded.

The audit stream cannot answer that question. `gate_resolved` events carry only
`{ decision, target }` (`ts/src/engine/engine.ts:1342` and `:1354`). A client can find an event
at the expected ordinal position and read a decision off it, but nothing in the event ties that
decision to the client's own request. Position in a list is not identity: a concurrent or
out-of-band resolution produces an indistinguishable event.

Compose therefore has to choose between two bad options, and currently does both in different
scopes:

- Refuse to adopt, and lose completed paid work to an outcome of `unknown`. This is what
  `COMP-HOST-PORTABILITY-1` measured on host B, at $14.04 and 208,080 tokens for one run.
- Adopt on ordinal position, which can silently upgrade a lost response to an approval that
  was never ours.

Compose closed most of this with evidence-based arms, but one case has no evidence available at
all, and it is documented in `lib/build.js` as a scope exception rather than a proof:

> the wave-profile arm does not provide evidence: with no routing plane, consumed-token evidence
> is unavailable anywhere because the engine does not record it.

That sentence is the whole of this feature's justification. The engine is the only component
that can close it.

## What already works, and why it is not enough

Compose can build a `token-engine-witness` today (`lib/routing-gates.js:216`), but only by
reconstructing proof indirectly from routing **carry provenance**, which records the consumed
`gateToken` when a revise writes carry values (`ts/src/engine/engine.ts:1279`, the `provenance:
{ kind: "revise", ..., gateToken }` write in `resolveCarryOnRevise`).

That path has two hard limits, both structural:

1. **It only exists for `revise`.** Carry is written on revision. An `approve` or `kill`
   decision writes no carry and therefore leaves no token behind.
2. **It only exists when the routing plane is on.** A build with no routing ledger has no
   snapshot to read provenance from.

So the evidence exists today exactly where carry happens to leave it, which is an accident of
another feature rather than a property of gates.

## Proposal

Include the consumed gate token in the `gate_resolved` event detail.

```ts
this.event(run, "gate_resolved", stepId, { decision, target, gateToken });
```

Applied at both emission sites, `ts/src/engine/engine.ts:1342` (rounds-exhaustion terminal
path) and `:1354` (the ordinary path).

This is cheap and safe for three reasons, each checked against source rather than recalled:

- **The value is already in scope.** `gateToken` is a parameter of `gateResolveLocked`
  (`ts/src/engine/engine.ts`, signature `gateResolveLocked(runId, stepId, decision, gateToken?)`).
- **It is already validated before both emissions.** The method rejects the call unless
  `state.gateToken === gateToken`, so the value written is by construction the token the engine
  actually consumed, not a client assertion.
- **It is additive.** `delete state.gateToken` continues to happen immediately before the event,
  so the live token is still single-use. The event is a record of what was consumed, not a
  re-usable credential.

A client can then reconcile a lost response by matching the token it sent against the token on
the event. That is identity, not position, and it works for `approve`, `revise` and `kill`
alike, with or without a routing plane.

## Consumer change (compose, separate feature)

With this shipped, compose's arm 3 becomes redundant and should be replaced by a fourth
*evidence* arm: adopt when the authoritative `gate_resolved` event carries a `gateToken` equal to
the one the build sent. `test/build-wave-ship.test.js:103` then passes on proof rather than on a
scope exception, and `waveProfilesEnabled(pipelineProfiles)` can be deleted from that condition
for the third and final time.

**Do not delete that guard in compose before this ships.** It has already been removed twice as
"redundant" and both removals broke a safety invariant.

## Open questions

1. **Is `gateToken` sensitive?** It is single-use and deleted at resolution, so recording it
   should be inert, but the audit stream is surfaced to clients and written to disk. Confirm no
   consumer treats presence of a token in an event as authority to act.
2. **Do any consumers assert on the exact shape of `gate_resolved` detail?** An additive field
   is compatible for readers that destructure, and breaking for any that deep-equal the whole
   detail object. Sweep compose and the TS tests before changing the emission.
3. **Does the rounds-exhaustion path at `:1342` want the token too?** It terminalises the run, so
   no client will reconcile against it, but omitting it there makes the field conditionally
   present, which is a worse contract than always writing it.
4. **Version impact.** Additive event detail is a minor, not a major. Confirm whether the
   compose / compose-mcp version-sync rule forces matching minors.

## Non-goals

- Reopening or resuming terminally failed runs. That surface was designed, reviewed and KILLED
  (`docs/features/STRAT-REOPEN-FAILED-1/design.md`). This feature changes what is *recorded*
  about a resolution that already happened, and grants no new ability to re-drive one.
- Any change to gate token lifetime, single-use semantics, or validation.
- Any change to the routing carry provenance path, which stays as the richer witness for revise.

## Falsifier

Closed when `gate_resolved` events carry the consumed token. Check:

```sh
grep -n 'gate_resolved", stepId' /Users/ruze/reg/my/forge/stratum/ts/src/engine/engine.ts
```

Both emission sites should include `gateToken` in the detail object. While they show only
`{ decision, target }`, this feature is still open and compose's arm 3 must stay.
