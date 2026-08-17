# STRAT-GUARD-UPGRADE — idempotent, non-emergency guard policy upgrade

**Status:** COMPLETE (shipped)
**Owner:** stratum
**Filed:** 2026-08-17
**Requested by:** compose `COMP-LIFECYCLE-BACKFILL` (design.md line 240) — the hard cross-repo blocker.

## Related Documents

- Upstream requirement: `/Users/ruze/reg/my/forge/compose/docs/features/COMP-LIFECYCLE-BACKFILL/design.md`
- Guard design of record: `docs/features/STRAT-TS-GUARD/design.md` (invariant 8 — override/migrate token gating)
- Original guard spec: `docs/features/STRAT-GUARD/design.md`

## Problem

`guardMigrate` (`ts/src/guard/transition.ts:565`) is the only way to change a
registered guard's policy, and it has two properties that make routine policy
evolution impossible:

1. **It is token-gated.** `_checkOverrideToken` requires
   `STRATUM_GUARD_OVERRIDE_TOKEN` in the server env — the same break-glass
   credential as `guardOverride`, which exists to bypass predicate evaluation
   entirely.
2. **It is not idempotent.** `graph_version` is incremented unconditionally
   (`:593`) and a `graph_version` ledger entry is appended even when the target
   policy is byte-identical to the one already stored.

Compose needs to add one node (`complete_backfilled`) and its inbound edges to
~350 already-registered feature guards, lazily, from the `_registered` cache
path on a cold server. Under today's API that means every cold-server touch of
every resource requires the emergency token and writes a ledger entry — so a
routine policy upgrade would depend on the emergency mechanism it is meant to
replace, and re-running the migration would inflate `graph_version` without
bound.

A routine policy upgrade is not an emergency deviation. Coupling them is the
defect.

## Decision 1 — a separate `guardUpgrade` path, not conditional gating inside `guardMigrate`

The obvious alternative was to make `override_token` optional on `guardMigrate`
and require it only when the diff is destructive. Rejected:

- **It turns the diff classifier into authentication code.** With one entry
  point, a classifier bug is not "a migration was wrongly rejected" — it is
  *unauthenticated predicate weakening* on a live guard, which is the exact
  failure STRAT-IMMUTABLE exists to prevent. A separate path makes the
  classifier a gate on a strictly weaker capability instead of an auth decision
  on a stronger one.
- **The contract cannot express "required sometimes."**
  `ts/contracts/mcp-surface.json` types `override_token` as `string`.
  Downgrading it to `override_token?` moves enforcement out of the contract and
  into a runtime branch, which is where the strict-contract discipline says it
  must not live.
- **Near-zero regression surface.** `guardMigrate`'s own logic is untouched and
  its tests are unmodified; the emergency path remains available for exactly the
  changes `guardUpgrade` refuses. The one behavioural change it does inherit is
  deliberate and shared: Decision 4's shape validation lives in
  `_validatePolicy`, so migrate (and register) now reject a malformed policy
  they previously accepted.

So: `guardUpgrade` is a **new, additive-only, token-free** path. It can only
ever produce a policy that is a superset of the one already stored.

## Decision 2 — the compatibility rule is additions-only, and it fails closed

Let `old` be the stored registry policy and `new` the submitted one. `new` is a
**compatible upgrade** if and only if all of the following hold:

1. **No node disappears.** Every key of `old.graph` is a key of `new.graph`.
2. **No edge disappears.** For every `from → to` in `old.graph`,
   `new.graph[from]` contains `to`. (Target-list *order* may differ; membership
   may not shrink.)
3. **Existing edges are untouched.** For every edge key present in
   `old.edge_predicates` **or** `old.stakes`, the corresponding value in `new`
   is byte-identical under `canonicalJson` — including "absent stays absent".
   Adding a predicate to an edge that already exists is a change to an existing
   edge and is refused, even though it is strictly strengthening.
4. **New edges may only terminate at new states.** For every `u → v` in
   `new.graph` that is not in `old.graph`, `v` must be a node that did not
   exist in `old` at all.
5. **`terminal` is frozen, in both directions.** `new.terminal` must equal
   `old.terminal` exactly — no addition, no removal (and, per Decision 4,
   duplicate entries are rejected outright, so set equality is exact equality).
   Additionally, no new edge may *leave* a terminal state: freezing membership
   stops a caller inventing a new way to be done, but `shipped → reopened` with
   a brand-new `reopened` would walk an already-complete resource back out of
   its terminal state, over an edge whose predicates the caller also chose.
   A terminal state has no outgoing edges by contract; growing one is a policy
   change either way.
6. **`initial` and `workspace_root` are not parameters** of `guardUpgrade` —
   they are read from the stored registry, so they cannot change.

Anything else — edge removal, predicate edit, stake change on an existing edge,
any change to `terminal`, any new edge entering or leaving a terminal state — is
refused with the new `incompatible_policy_upgrade`
error slug and a message naming the offending key, pointing the caller at
`guardMigrate` and the emergency token.

**Rule 4 is the one that makes "additive" mean "cannot weaken".** Adding edges
is not automatically harmless: an edge added *into an existing state* is a new
route to it, and a new route routes around the predicates on the old route. If
`draft → shipped` is gated on evidence, a token-free call that adds
`draft → rubber_stamp → shipped` has bypassed the gate without changing a single
existing edge. Restricting new edges to new targets keeps the reachability of
every pre-existing state exactly as registered, while still allowing a new
subgraph to be grafted on — which is all the requesting case needs.

The invariant it buys, stated precisely: every edge whose target is a
pre-existing state is an old edge, so by induction every walk that reaches a
pre-existing state uses only old edges from the old initial state. **The
reachability of every state that existed at registration is bit-for-bit what
was registered.** The price is that a grafted subgraph is a one-way exit — a
walk that steps into new states can never return to the old machine, since that
return hop would be a new edge into an old state. For the requesting case
(`complete_backfilled` is terminal) that is exactly right; a future upgrade that
needs a round trip belongs on `guardMigrate`.

Two more notes on why rules 3 and 5 are deliberately stricter than they need to
be:

- **Rule 3 refuses strengthening.** Building an ordering over "stronger" and
  "weaker" predicate sets means reasoning about evidence semantics, and a wrong
  ordering is a silent weakening. Byte-identity is trivially reviewable and
  fails closed. If a real need for edge strengthening appears, it can be added
  later against a concrete case.
- **Rule 5 freezes `terminal` outright**, and this is the rule that cost the
  feature its headline use case. See the next section.

**Callers submit the full target policy, not a delta.** Rule 2 enforces this
implicitly — a delta would be missing old edges and get refused.

## Decision 3 — `guardUpgrade` may not grant completability, which costs it the requesting use case

The first draft let `terminal` grow with new nodes, so that
`COMP-LIFECYCLE-BACKFILL` could graft its terminal `complete_backfilled` node
token-free. Adversarial review killed it, correctly.

Rule 4 stops a caller routing around an existing gate *into an existing state*.
It does nothing about a caller that declares its own success state instead:

```
registered:  draft → review → shipped        (every edge gated)
upgraded:    draft → rubber_stamp            (new state, new edge,
             terminal += rubber_stamp         predicates chosen by the caller)
```

No existing edge is touched, so the classifier passes it. An empty predicate
list evaluates as met (`evidence.ts` starts from `met = true`), so the new edge
is walkable immediately, token-free. Consumers read terminal membership as
completability, so the caller is now *complete* without satisfying any gate that
existed at registration. Tightening the predicates does not help: the caller
chooses those too.

The general shape of the safe version is a **server-owned upgrade descriptor** —
the target policy must match a checksum the server was configured with, not one
the caller supplies. That is real work and it re-introduces out-of-band
configuration, so it is not in this slice.

What ships instead is the strictly non-weakening subset: **`guardUpgrade` can
never change what "done" means.** Adding a state and an edge to it is allowed
because it grants nothing — the new state is not terminal, no consumer treats it
as complete, and rule 4 means a walk that enters it can never come back to the
old machine.

**Consequence for the requester, stated plainly:** `COMP-LIFECYCLE-BACKFILL`'s
`complete_backfilled` node is a completability grant and therefore still needs a
token-gated `guardMigrate`, once per resource. What this feature does buy it is
the other half of its complaint: the idempotent no-op means the lazy
per-resource check is free and token-free in the steady state, and a batch that
dies partway is safe to re-run. Whether that is enough, or whether the
server-owned descriptor gets built, is the requester's call.

## Decision 4 — `_validatePolicy` now checks the policy's SHAPE, not just its names

Found during adversarial review of this feature, but pre-existing and not
introduced by it: `_validatePolicy` never checked that an adjacency value is an
array. The MCP contract types `new_graph` as `"object"`, and the dispatch casts
it to `Record<string, string[]>` without proving it — so `{"draft": "shipped"}`
reached the store. A string survives every check the validator did make (it is
iterable, and its characters are valid state names), and once persisted, the
edge-legality test `(registry.graph[from] ?? []).includes(to)` becomes
`String.prototype.includes` — a **substring** test. A guard whose adjacency is
the string `"bxyz"` legalizes a transition to `"xyz"`, a state nobody declared
and no predicate guards.

`registerGuard` takes no token, so this was reachable without any credential.
The classifier inherits the same hazard from the other direction: it reads
`new Set(newGraph[from] ?? [])`, which over a string yields characters, giving
the classifier a different view of the policy than the engine will have.

Two fixes, because the shape check alone is not enough. `_validatePolicy` guards
the way **in**, but registries are long-lived and load through unchecked casts,
so one persisted before the check existed would keep the substring behaviour.
Edge legality itself therefore also fails closed: `_declaresEdge` requires an
actual array before testing membership, on all three call sites (transition
eval, transition commit, override).

On the way in, at the single shared chokepoint: `_validatePolicy` now rejects a non-array
adjacency or terminal list, a non-string state name inside either, a non-array
or non-object predicate list, and a non-string stake — so register, migrate and
upgrade are all covered by one check rather than three.

## Decision 5 — no-op semantics on checksum match

`guardChecksum(graph, edge_predicates, terminal, stakes)` is the identity of a
policy (`initial` and `workspace_root` are excluded by design). When the
submitted policy's checksum equals `registry.checksum`, `guardUpgrade`:

- returns `status: "unchanged"` with the current `checksum` and `graph_version`,
- **appends no ledger entry**,
- **does not bump `graph_version`**,
- and, being a `guardUpgrade` call at all, needs no token.

This is what makes compose's lazy migration safe to run on every cold-server
touch across hundreds of resources: the steady state costs one lock acquisition
and one checksum, and writes nothing.

Before the comparison, `guardUpgrade` recomputes the checksum of the *stored*
policy from the registry's own fields and raises `guard_tampered` on mismatch —
the same check `guardTransition` and the commit path already perform. Without
it, a tampered registry whose stored `checksum` happened to match the submitted
policy would return `unchanged` and silently bless the tampering.

On a compatible, non-identical policy `guardUpgrade` bumps `graph_version` by
exactly one and appends a ledger entry with `kind` and `outcome` of
`graph_version` — the **same kind `guardMigrate` already writes**, so no history
reader gains a case to handle. The two are distinguishable in the ledger by
`resolved_by`: `guardMigrate` writes `"human"` (a person held the token),
`guardUpgrade` writes `"agent"` (a program applied a routine upgrade).
`rationale` stays mandatory on both.

Ledger entries with `outcome: "graph_version"` do not move `current_state`
(`store.ts:440` advances only on `applied` and `deviation`), so an upgrade can
never disturb an in-flight walk.

## Decision 6 — no batch tool

`guardUpgrade` is a per-resource primitive. Compose's migration is lazy and
caller-side, driven off its own `_registered` cache; a stratum-side
batch-over-N tool would duplicate that loop and own failure semantics it cannot
see. Not built.

## Answers to COMP-LIFECYCLE-BACKFILL open question 4

> *What does `stratum guard migrate` actually guarantee — does it preserve the
> existing ledger, and can it fail partway across many resources?*

- **The ledger is preserved.** Both `guardMigrate` and `guardUpgrade` are
  append-only over `ledger.jsonl`; neither rewrites or truncates prior entries.
  A policy change appends one `graph_version` entry and rewrites only
  `registry.json`. The hash chain is continuous across the upgrade.
- **`current_state` survives.** It is derived from the ledger, and
  `graph_version` entries do not advance it. Under the additive-only rule the
  current state's node always exists in the new graph, so an upgrade cannot
  strand an in-flight walk. (The explicit stranding check `guardMigrate`
  performs is retained anyway, as defence in depth.)
- **There is no cross-resource transaction.** Each call takes that resource's
  own `flock`, so it is atomic *per resource* and nothing more. A batch of 350
  can fail at resource 200, leaving 199 upgraded and 151 not.
- **That partial failure is benign here, because of Decision 5.** Re-running the
  batch returns `unchanged` for the 199 already done and does real work only for
  the remainder. Idempotency is what makes the missing cross-resource
  transaction a non-issue — which is why the no-op is a requirement of the
  feature and not a nicety.

## Surface

| Surface | Change |
|---|---|
| `ts/src/guard/errors.ts` | new slug `incompatible_policy_upgrade` + `IncompatiblePolicyUpgrade` class |
| `ts/src/guard/transition.ts` | new `guardUpgrade` + exported `_upgradeIncompatibilities` classifier; `guardMigrate` untouched |
| `ts/contracts/mcp-surface.json` | new `stratum_guard_upgrade` tool — request has **no** `override_token`; response variants `migrated` and `unchanged` |
| `ts/src/mcp/server.ts` | `ToolName` union + dispatch case (guard errors already envelope via the `stratum_guard_` prefix branch) |
| `ts/src/cli/guard.ts` | `upgrade` action + dispatch |
| `ts/tests/guard/transition.test.ts` | classifier + idempotency tests |
| `ts/tests/guard/canonical.test.ts` | `GUARD_ERROR_TYPES` assertion |
| `ts/tests/guard/mcp.test.ts` | tool-list assertion + call test |

## Acceptance criteria

- [ ] `guardUpgrade` requires no `STRATUM_GUARD_OVERRIDE_TOKEN`
- [ ] Identical policy → `status: "unchanged"`, ledger length unchanged, `graph_version` unchanged
- [ ] Compatible policy → `status: "migrated"`, `graph_version` +1 exactly; a second identical call → `unchanged`
- [ ] Edge removal refused with `incompatible_policy_upgrade`
- [ ] Predicate edit on an existing edge refused
- [ ] Stake change on an existing edge refused
- [ ] A new edge into a pre-existing state refused (gate-routing bypass)
- [ ] Terminal shrink refused
- [ ] A NEW terminal state refused (completability grant)
- [ ] A new edge OUT of a terminal state refused (terminal egress)
- [ ] A duplicated terminal entry refused
- [ ] Existing node flipped terminal refused
- [ ] Tampered stored registry → `guard_tampered`, on the no-op path too
- [ ] A string adjacency (`{"a": "bxyz"}`) refused at register AND upgrade
- [ ] A registry that already holds a string adjacency fails closed at transition
- [ ] Unknown resource → `guard_engine_owned` (ownership is asserted before the registry loads, at parity with `guardMigrate`); python-owned resource → `guard_engine_owned`
- [ ] `guardMigrate`'s own logic untouched and its existing tests pass unmodified (it does inherit the shared shape validation from Decision 4)
