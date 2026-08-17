# STRAT-GUARD-DESCRIPTOR — server-owned upgrade descriptors

**Status:** PARTIAL — the mechanism ships MCP-only. Its consumer cannot reach it over the CLI transport, and the recommended completion is signed descriptors (Decision 6).
**Owner:** stratum
**Filed:** 2026-08-17
**Requested by:** owner ruling 2026-08-17 ("the best solution not the easiest one"), after `STRAT-GUARD-UPGRADE` shipped the provably-safe subset and left the requesting use case still needing the break-glass token.

## Related Documents

- Predecessor: `docs/features/STRAT-GUARD-UPGRADE/design.md` (Decision 3 names this as the general safe form)
- Guard design of record: `docs/features/STRAT-TS-GUARD/design.md`
- Consumer: `/Users/ruze/reg/my/forge/compose/docs/features/COMP-LIFECYCLE-BACKFILL/design.md`

## Problem

`guardUpgrade` (shipped, `91a55ed`) is token-free because it is provably
non-weakening: additive-only, `terminal` frozen in both directions. That proof is
exactly what excludes the case that motivated it. Compose's
`complete_backfilled` node is a **completability grant** — a new terminal state —
and review demonstrated that any token-free path which can grant one hands the
caller a completion bypass: declare your own success state, reach it over a new
edge whose predicates you also chose (an empty predicate list evaluates as met),
and you are complete without satisfying a single gate that existed at
registration.

So the capability is genuinely privileged. The question is not *whether* it needs
authorization but *what shape* the authorization takes. Today the only shape is
`STRATUM_GUARD_OVERRIDE_TOKEN`, and it is a bad fit:

| | override token | what a routine policy upgrade needs |
|---|---|---|
| Scope | any policy change, on any resource, forever | one reviewed policy, on resources currently holding one known policy |
| Reviewability | none — the token says "a human was present", not "a human agreed to this" | the exact resulting policy, reviewable before it is authorized |
| Blast radius on leak | total | nil — the descriptor is not a secret and grants only what it spells out |
| Repeatability | each call is a fresh unconstrained act | the authorized change is fixed; applying it 350 times is one decision |

A descriptor is that shape: the *server* holds the policy change, a human
reviewed it before it was installed, and the caller may only ask for it **by
name**.

## Decision 1 — the descriptor carries the full target policy, not a transformation

The tempting form is a transformation: *"add node `complete_backfilled`, terminal,
reachable from any non-terminal phase, with these predicates."* One descriptor
would then cover every guard regardless of its current policy. Rejected:

- **A transformation must be interpreted, and interpretation is where the holes
  live.** `STRAT-GUARD-UPGRADE` shipped three separate classifier fixes in one
  session, each for an "obviously additive" change that turned out to weaken the
  policy. A descriptor that says *apply this exact policy* needs no reasoning at
  all: load, compare checksum, write. There is nothing to get wrong.
- **A human cannot review a transformation's effect.** Reviewing "add a terminal
  node to any policy" means reasoning about all 350 resulting policies.
  Reviewing a full target policy means reading one policy. The reviewable unit
  is the artifact that gets authorized.
- **Enumeration is feasible here, which removes the only real argument for
  transformations.** Compose's guard policies come from `buildPhaseGraph`, which
  is keyed on lifecycle *mode*, not on feature. A few distinct policies cover
  hundreds of resources (and only ~31 of ~350 are registered at all). One
  descriptor per distinct source policy is a short list, not a per-feature
  explosion.

And the descriptor is **bound to an exact `from_checksum`**. This is what stops a
descriptor authorized for one policy silently landing on a resource whose policy
is different — including a resource someone migrated in between. Authorization is
for a *transition between two named policies*, not for a destination in the
abstract. A mismatch is refused, loudly, with both checksums in the message.

## Decision 2 — the trust anchor: an env path plus a REQUIRED digest pin

Two environment variables, read from the **server process** environment exactly
as `STRATUM_GUARD_OVERRIDE_TOKEN` is:

```
STRATUM_GUARD_UPGRADE_DESCRIPTORS=/abs/path/to/guard-upgrades.json
STRATUM_GUARD_UPGRADE_DESCRIPTORS_SHA256=<sha256 of that file's bytes>
```

Both required. Neither is agent-mintable: an agent cannot alter the environment
of an already-running MCP server, and that is the same anchor the override token
already relies on.

**Why the pin is required and not optional.** The env var alone only names a
path. On a single-user development machine the agent under guard usually *can
write that path*, so an unpinned descriptor file authorizes nothing — the caller
would be reviewing its own homework. An optional pin would mean the default
deployment has the appearance of authorization and none of the substance, which
is worse than not having the feature: it converts "no capability" into "a
capability everyone believes is safe". With the pin required, the digest lives in
the server's environment, so changing what is authorized requires touching the
environment — a deliberate operator act, exactly like rotating the token. The
capability is therefore either real or absent, never theatre.

Additionally the file must not be group- or world-writable (`0o022`), the same
check `ssh` applies to a private key. Cheap, and it catches the common
misconfiguration where the digest is right but anyone on the box can race it.

**Honest limits of the anchor.** It is worth stating plainly what this does and
does not buy:

- It does **not** defend against an attacker who can set the server's
  environment or restart the server with their own values. Nothing short of a
  separate trust domain (a signing key held off-box, a remote authorization
  service) would, and the override token has exactly the same ceiling.
- It **does** defend against the realistic threat this whole subsystem exists
  for: an agent, running with the user's filesystem privileges, talking its way
  into a policy change nobody authorized. It cannot forge the digest, cannot
  edit the pinned file without detection, and cannot invent a descriptor.
- The trust boundary is **whoever controls the process environment**. Under the
  MCP server that is the operator who launched it. Under the **CLI** it is the
  caller, which is why there is deliberately no CLI apply action — see
  Decision 6.
- A descriptor file is **not a secret**. It can be committed, reviewed in a pull
  request, and diffed. That is a feature: unlike a token, the thing being
  authorized is legible.

## Decision 3 — file format

```json
{
  "version": 1,
  "descriptors": [
    {
      "id": "comp-lifecycle-backfill-build-mode",
      "rationale": "COMP-LIFECYCLE-BACKFILL: add the complete_backfilled terminal node to build-mode feature guards. Reviewed 2026-08-17.",
      "from_checksum": "32f2fd05...",
      "to_policy": {
        "graph": { "...": ["..."] },
        "edge_predicates": { "...": [] },
        "terminal": ["..."],
        "stakes": { "...": "paranoid" }
      }
    }
  ]
}
```

- `version` must be `1`. Unknown top-level or per-descriptor keys are **rejected**,
  not ignored — a typo'd key in an authorization artifact must never silently
  mean something other than what the reviewer read.
- `id` is unique within the file, `[A-Za-z0-9_.-]+`.
- `rationale` is mandatory and non-empty. It is what the ledger will carry, so
  the audit trail says *why* rather than only *what*.
- `to_policy` is the same four fields the policy checksum covers. `initial` and
  `workspace_root` are deliberately absent: they are read from the stored
  registry and cannot be changed by an upgrade of any kind.

The operator-facing `stratum guard descriptors` prints the parsed set **and the
file's computed sha256**, so installing or updating the pin is a copy-paste
rather than a shell incantation.

## Decision 4 — apply semantics

`guardApplyUpgrade(resourceId, descriptorId)`, in order:

1. Load and verify the descriptor file (env present, perms sane, digest matches
   the pin, schema strict). Any failure → `upgrade_descriptor_unavailable`.
2. Look up `descriptorId`. Unknown → `upgrade_descriptor_unavailable`.
3. Take the resource lock; assert TS engine ownership.
4. Load the registry; `guard_not_found` if absent.
5. **Tamper check** — recompute the stored policy's checksum from its own fields;
   mismatch → `guard_tampered`. This precedes every comparison, so a tampered
   registry can never be blessed by a no-op.
6. If `checksum(to_policy) === registry.checksum` → **`unchanged`**. No ledger
   entry, no version bump. This is what makes a 350-resource batch re-runnable
   after a partial failure, and it deliberately comes *before* the
   `from_checksum` check so that a resource already at the destination is a
   success, not a mismatch.
7. Require `registry.checksum === descriptor.from_checksum`. Otherwise
   → `upgrade_descriptor_mismatch`, naming both checksums.
8. `_validatePolicy(to_policy, registry.initial, …, registry.workspace_root)` —
   the descriptor is authorized, not trusted to be well-formed.
9. Refuse to strand the walk: `current_state` must be a node in the new graph or
   in its terminal set → `invalid_state_name`.
10. Apply exactly, bump `graph_version` by one, append a `graph_version` ledger
    entry with `resolved_by: "human"` (a human authorized this change) and a
    rationale that names the descriptor id, the descriptor file digest, and the
    descriptor's own rationale.

No additive-only classifier runs. That is the point: this path can do what
`guardUpgrade` refuses — grant a terminal state, remove an edge, retighten
predicates — because a human read the exact resulting policy and installed it.

## Decision 5 — three capabilities, increasing power

| | authorization | can it weaken policy? | intended use |
|---|---|---|---|
| `guardUpgrade` | none needed | **no** — additive-only, `terminal` frozen both ways | routine grafts; the free idempotent steady-state check |
| `guardApplyUpgrade` | a named, digest-pinned, human-reviewed descriptor | yes, but only into one exact reviewed policy | fleet policy evolution, including completability grants |
| `guardMigrate` | `STRATUM_GUARD_OVERRIDE_TOKEN` | yes, arbitrarily | genuine emergencies, one-off surgery |

All three keep the same properties: per-resource `flock`, append-only ledger,
`current_state` never stranded, `graph_version` monotonic, and an idempotent
no-op on an already-matching policy.

`guardMigrate` is deliberately not retired. Emergencies are real, and a mechanism
that requires a reviewed artifact cannot be the thing you reach for when the
reviewed artifact is what is broken.

## Decision 6 — the privileged apply is MCP-only, and the CLI seam is broken today

Adversarial review found that exposing `apply-upgrade` on the CLI destroys the
entire property this feature exists to provide. A CLI process inherits the
*caller's* environment, so a caller can:

1. write its own descriptor file, `0600`, containing the victim resource's
   current checksum and any target policy it likes,
2. compute that file's sha256,
3. run the CLI with both variables pointing at its own file and its own digest.

The verifier then compares an attacker-chosen file against an attacker-chosen
pin, accepts, and writes an unreviewed policy — and stamps the ledger
`resolved_by: "human"`, actively falsifying the audit trail. Calling the CLI a
"trusted seam" does not preserve the property: a shell-capable caller reaches it
directly, and an MCP caller bridges to it through `stratum_agent_run`.

So there is **no CLI apply action**. The privileged operation exists only on the
MCP surface, executing inside the already-running server that owns the pinned
environment. The read-only `stratum guard descriptors` inspection stays: it
grants nothing.

### The same hole already exists for the override token, and it is worse

This is not a property of descriptors. `_checkOverrideToken`
(`transition.ts:560`) compares the caller-supplied token against
`process.env.STRATUM_GUARD_OVERRIDE_TOKEN` **in whatever process is running**, so
over the CLI a caller sets both sides and they match. Verified empirically
2026-08-17 against a guard whose only predicate could never be satisfied:

```
$ ... guard transition                    -> refused, current_state draft
$ STRATUM_GUARD_OVERRIDE_TOKEN=i-just-made-this-up \
  ... guard override  (token: i-just-made-this-up)
                                          -> deviation, current_state shipped
```

`STRAT-TS-GUARD` design invariant 8 says override and migrate are token-gated and
the token is "not agent-mintable". That is true on the MCP surface and **false on
the CLI surface** — which is the only surface compose uses
(`compose/server/stratum-client.js`: "the ONLY module in compose that spawns
Stratum CLI processes"). Tracked separately; it is a defect in the existing
system, not in this feature.

### Consequence, stated plainly

Compose cannot use this feature over its current transport — and **could not have
used the override-token fallback either**, because that fallback was never
actually authorized. Closing this properly needs one of:

- **(a) A trusted transport.** Compose calls stratum over MCP for privileged
  guard operations instead of spawning the CLI. The environment then belongs to a
  server the agent did not launch.
- **(b) Signed descriptors.** Authorization stops being "a value in the
  environment" and becomes "a signature this process cannot produce": descriptors
  signed with a key held off-box, verified against a public key checked into
  stratum's source. A caller must then either forge Ed25519 or edit stratum's
  committed source — the latter is possible with a shell, but it is loud,
  `git status`-visible, and defeats every check in the codebase equally rather
  than defeating this one silently. The same treatment retroactively fixes the
  override token.

(b) is the stronger answer and the one this design recommends, because it does
not depend on which transport a consumer happens to use.

### The honest ceiling

An agent with a shell and write access to `~/.stratum/guards/` can edit registry
and ledger files directly. The guard is **tamper-evident, not tamper-proof**: the
policy checksum and the hash-chained ledger make interference detectable, they do
not make it impossible. That is the real security property, and it is worth
protecting precisely because it is modest — which is why a mechanism that writes a
false `resolved_by: "human"` into the chain would be worse than no mechanism.

## What COMP-LIFECYCLE-BACKFILL must now do

**Nothing yet.** Decision 6 blocks it: compose reaches stratum's guard by
spawning the CLI, and the privileged apply is not on the CLI. The sequence once a
trusted path exists is unchanged, and the first two steps are useful work that can
happen now regardless of which path is chosen:

1. **Generate the descriptor file.** Compose owns `buildPhaseGraph`, so it can
   enumerate the distinct current policies among registered guards and emit
   `{from_checksum, to_policy}` for each — `to_policy` being that policy plus the
   `complete_backfilled` node, its inbound edges from every non-terminal phase,
   their predicates, and `complete_backfilled` in `terminal`. Commit the file: it
   is reviewable, not secret.
2. **Have a human review it.** This is the authorization act, and it is one act
   for the whole fleet rather than one per resource.
3. **Install and call it** — over MCP (option a) or with signature verification
   (option b), per the owner's decision.
4. Already-upgraded resources answer `unchanged` for free; a partial batch is
   safe to re-run.

None of this touches the three Compose-side reworks still queued before implement
(`phaseOrder` is not a valid temporal insertion order, cross-mutation recovery
between the guard and vision-state, reader changes).

## Acceptance criteria

- [ ] Env unset → `upgrade_descriptor_unavailable`
- [ ] Path set but pin unset → `upgrade_descriptor_unavailable`
- [ ] Pin set but wrong → `upgrade_descriptor_unavailable`
- [ ] Group- or world-writable descriptor file → `upgrade_descriptor_unavailable`
- [ ] Malformed file, unknown key, duplicate id, blank rationale → `upgrade_descriptor_unavailable`
- [ ] Unknown descriptor id → `upgrade_descriptor_unavailable`
- [ ] `from_checksum` mismatch → `upgrade_descriptor_mismatch`, both checksums in the message
- [ ] Happy path applies the exact policy, `graph_version` +1, ledger entry names the descriptor
- [ ] Re-application → `unchanged`, ledger length and `graph_version` untouched
- [ ] A descriptor CAN grant a terminal state (what `guardUpgrade` refuses)
- [ ] A descriptor cannot strand `current_state` → `invalid_state_name`
- [ ] Tampered registry → `guard_tampered`, including on the no-op path
- [ ] Python-owned resource → `guard_engine_owned`
- [ ] `guardUpgrade` and `guardMigrate` behaviour unchanged (their tests pass unmodified)
