# STRAT-GUARD-DESCRIPTOR — server-owned upgrade descriptors

**Status:** COMPLETE — signed descriptors shipped; the env digest pin they replaced is gone. Consumer wiring (compose) and the same treatment for `guardOverride`/`guardMigrate` are tracked separately.
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

## Decision 2 — the trust anchor: a signature, not a value in the environment

**Superseded the digest pin, 2026-08-17, same day.** The pin was the right idea
against the wrong adversary. Its reasoning was "an agent cannot alter the
environment of an already-running server" — true, but the guard is also reachable
from processes the agent launches itself, and there the agent supplies the
environment. Decision 6 records the proof. An env-anchored digest is only as
strong as the weakest process that reads it.

A signature has no such dependence. Authorization is now:

- the descriptor file carries a detached **sshsig** (`ssh-keygen -Y sign`) at
  `<path>.sig`, under the namespace `stratum-guard-descriptors`;
- the signing key must appear in **`contracts/guard-signers.allowed`**, read from
  the installed source tree — never from an environment variable;
- the private half lives wherever the operator keeps it, protected by a
  passphrase that exists only in the operator's head, and is **never added to
  ssh-agent** (an agent that can reach the agent socket can use the key without
  knowing the passphrase).

The descriptor file's *path* still comes from
`STRATUM_GUARD_UPGRADE_DESCRIPTORS`. Locating an artifact is not authorizing it:
point it anywhere, the signature still has to verify.

**What the adversary must now do.** Not "set two variables" — forge Ed25519
(infeasible), or edit `contracts/guard-signers.allowed` in the checked-out source.
The second is possible for anything with a shell, but it is a categorically
different act: it shows up in `git status` and in review, rather than leaving no
trace at all. That is the honest ceiling of any local mechanism, and it applies
equally to every check in the codebase rather than to this one specifically.

**Verification is native, not a shell-out.** `ts/src/guard/sshsig.ts` parses and
verifies the sshsig format directly with `node:crypto`. Calling
`ssh-keygen -Y verify` would have re-introduced the same class of hole from a new
angle: `ssh-keygen` is resolved through `PATH`, and the adversary controls `PATH`.
An authorization decision must not be delegated to a binary the caller can
shadow. Ed25519 only; other key types are refused rather than ignored.

The verifier is tested against a signature produced by real `ssh-keygen`
(committed under `ts/tests/fixtures/sshsig/`), so a misreading of
PROTOCOL.sshsig cannot hide behind a round-trip with our own test signer.

**There is no default trust.** `contracts/guard-signers.allowed` ships empty, and
an empty or missing trust root makes the signed paths report themselves
unavailable rather than degrading to something weaker.

Two defence-in-depth checks remain, no longer load-bearing: the descriptor file
must not be group- or world-writable, and `initial`/`workspace_root` are still
read from the stored registry rather than the artifact.

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
- **(b) Signed descriptors — CHOSEN and implemented (see Decision 2).**
  Authorization is a signature the calling process cannot produce, verified
  against a trust root checked into stratum's source. Transport-independent, so
  it does not matter which surface a consumer uses.

(b) shipped. It also means the CLI restriction in this decision is no longer what
holds the property together — a CLI caller can point the path anywhere it likes
and still cannot produce a signature. The privileged apply nonetheless stays
MCP-only for now: the narrower surface costs nothing, and re-opening it should be
a deliberate act with its own review rather than a side effect of this change.

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
- [ ] Unsigned descriptor file → `upgrade_descriptor_unavailable`
- [ ] Signature over different bytes → refused
- [ ] Valid signature from a key nobody enrolled → refused
- [ ] Signature made under another namespace → refused
- [ ] Empty or missing trust root → refused (no default trust)
- [ ] Verifier agrees with real `ssh-keygen` on a committed golden artifact
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
