# STRAT-GUARD-AUTHZ — signed authorization, retiring the override token

**Status:** DESIGN → shipped in the same change
**Owner:** stratum
**Filed:** 2026-08-17
**Requested by:** owner ruling 2026-08-17, after `STRAT-GUARD-DESCRIPTOR` Decision 6 proved the token was never enforced on the surface its only consumer uses.

## Related Documents

- Immediate cause: `docs/features/STRAT-GUARD-DESCRIPTOR/design.md` Decision 6
- Sibling: `docs/features/STRAT-GUARD-UPGRADE/design.md` (the token-free, provably non-weakening path)
- Guard design of record: `docs/features/STRAT-TS-GUARD/design.md` (invariant 8, which this corrects)

## Problem

`STRATUM_GUARD_OVERRIDE_TOKEN` was a shared secret compared against the
environment of *whatever process is running*:

```ts
const expected = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
if (token !== expected) throw new OverrideUnavailable("override token mismatch");
```

Over the MCP server that environment belongs to the operator. Over the CLI it
belongs to the caller, who therefore sets both sides of the comparison. Verified
before removal, against a guard whose only predicate could never be satisfied:

```
guard transition                                    -> refused,   draft
STRATUM_GUARD_OVERRIDE_TOKEN=i-just-made-this-up
guard override  (token: i-just-made-this-up)        -> deviation, shipped
```

`STRAT-TS-GUARD` invariant 8 called the token "not agent-mintable". It was
mintable by anything with a shell, and the CLI is the only surface compose uses.
The same reasoning condemned the digest pin that `STRAT-GUARD-DESCRIPTOR`
shipped: any authorization anchored in the environment is only as strong as the
weakest process that reads it.

## Decision 1 — authorization is a signature, and the trust root is in the source

Both privileged paths now take a detached **sshsig** (`ssh-keygen -Y sign`)
instead of a token, verified against `contracts/guard-signers.allowed`, which is
read from the installed source tree and **never from an environment variable**.

The adversary's cheapest move stops being "set a variable" and becomes "forge
Ed25519" or "edit a committed file". The second is possible for anything with a
shell — that is the ceiling of every local mechanism — but it is `git status`
visible rather than invisible, and it defeats every check in the codebase equally
rather than defeating this one silently.

The signing key's passphrase exists only in the operator's head, and the key must
never be added to ssh-agent: anything that can reach the agent socket could
otherwise use it without knowing the passphrase. That is the actual anchor, and
it is the one thing on this machine an agent running as the operator does not
have.

There is no default trust. The trust root ships empty, and an empty or unreadable
one makes every signed path report itself unavailable rather than degrading.

## Decision 2 — verification is native, never a shell-out

`ts/src/guard/sshsig.ts` parses and verifies the sshsig format directly with
`node:crypto`. Calling `ssh-keygen -Y verify` would have re-opened the original
hole from a new angle: `ssh-keygen` resolves through `PATH`, and the adversary
controls `PATH`. **An authorization decision must not be delegated to a binary
the caller can shadow.**

Ed25519 only. Other key types, other signature types, and `allowed_signers`
option lists (`cert-authority`, `namespaces=`, `valid-before=`) are refused
rather than ignored — at a trust boundary, "something we did not think about"
must never mean "accepted", and silently dropping a restriction the author wrote
would make the file mean something other than it says.

The verifier is tested against an artifact produced by real `ssh-keygen`,
committed under `ts/tests/fixtures/sshsig/` with the private half discarded, so a
misreading of PROTOCOL.sshsig cannot hide behind a round-trip with our own test
signer. Our computed fingerprint matches `ssh-keygen -l` independently.

## Decision 3 — the signed payload is reconstructed, not transported

Nothing about an authorization travels except the signature. The server rebuilds
the exact canonical-JSON payload from the request it already has plus state it
reads itself:

| Operation | Signed payload |
|---|---|
| override | `{action:"override", resource_id, from_state, to_state, rationale, ledger_head}` |
| migrate | `{action:"migrate", resource_id, policy_checksum, rationale, ledger_head}` |

Consequences, all of which fall out rather than being separately enforced:

- **It cannot be redirected.** A signature naming one resource, edge, rationale
  or resulting policy will not verify against a payload describing another. For
  migrate the payload names the *resulting policy's checksum*, so an
  authorization cannot be spent on a different migration.
- **It cannot be replayed.** `ledger_head` is the resource's last ledger entry
  digest (`""` for an untouched resource), so an authorization is valid at exactly
  one point in that resource's history. Spending it moves the head and kills the
  signature. No clock, no nonce store, no expiry to tune.
- **It cannot cross purposes.** One sshsig namespace per operation
  (`stratum-guard-override`, `stratum-guard-migrate`,
  `stratum-guard-descriptors`), and the namespace is checked *before* the
  cryptographic verify.

The head is read **inside the resource lock**, so a concurrent mutation
invalidates the authorization rather than letting it apply to a history the
operator did not sign for.

## Decision 4 — the operator gets told exactly what to sign

`ledger_head` is unguessable-by-hand, so `stratum guard authorize` prints the
canonical payload, the namespace, and the `ssh-keygen` invocation. It is
read-only and grants nothing: a ledger head is not a secret, and the payload is
worthless without a signature. Rejections echo the expected payload back, because
the most common honest failure is a stale head — the operator signed, the
resource moved, and they need to see what the server expected in order to re-sign.

## Decision 5 — the ledger records who authorized, not merely that someone did

Every deviation and policy change now carries the signer's principal and key
fingerprint in its rationale, and the responses add `authorized_by`. This is the
point of the whole exercise: a `resolved_by: "human"` stamp that any process
could mint was worse than no stamp, because it made the audit trail lie.

## The honest ceiling

An agent with a shell and write access to `~/.stratum/guards/` can still edit
registry and ledger files directly. The guard is **tamper-evident, not
tamper-proof** — the policy checksum and hash-chained ledger make interference
detectable, not impossible. Signing closes the *sanctioned* path completely and
makes the audit trail truthful; it does not build a sandbox, and nothing local
can.

## Acceptance criteria

- [x] `STRATUM_GUARD_OVERRIDE_TOKEN` is gone from the source; `override_token` is
      rejected as an unknown argument
- [x] The recorded attack (self-invented token over the CLI) now fails
- [x] A self-signed authorization from an unenrolled key is refused
- [x] An authorization replayed after the ledger moves is refused
- [x] An authorization for a different resource / edge / rationale / resulting
      policy is refused
- [x] A signature made under another namespace is refused
- [x] Empty or missing trust root refuses rather than degrades
- [x] The happy path works end to end through the real CLI with a real
      `ssh-keygen` signature, and the ledger names the signer
