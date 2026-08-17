/**
 * Signed one-shot authorizations for the two privileged guard operations that a
 * reviewed descriptor cannot express: `guardOverride` (bypass predicates on one
 * edge) and `guardMigrate` (arbitrary policy change, the emergency path).
 *
 * Replaces `STRATUM_GUARD_OVERRIDE_TOKEN`, which was a shared secret compared
 * against the environment of whatever process happened to be running — so over
 * the CLI a caller set both sides of the comparison and they matched. Verified
 * empirically before removal: an honest transition was refused, and the same walk
 * with a self-invented token returned `deviation` and moved the state.
 *
 * The replacement is a signature over a payload the SERVER reconstructs, so
 * nothing about the authorization travels except the signature itself. Two
 * properties fall out of that:
 *
 * - **It cannot be forged**, because the signing key's passphrase lives only in
 *   the operator's head (see `contracts/guard-signers.allowed`).
 * - **It cannot be replayed**, because the payload includes the resource's
 *   current ledger head. An authorization is valid at exactly one point in that
 *   resource's history; once it is used, the head has moved and the same
 *   signature is dead. No clock, no nonce store, no expiry to tune.
 */

import { canonicalJson } from "./canonical.js";
import { OverrideUnavailable } from "./errors.js";
import { sshFingerprint, verifySshsig } from "./sshsig.js";
import { loadAllowedSigners } from "./trust.js";

/** One namespace per purpose, so an authorization for one can never act as another. */
export const AUTHORIZATION_NAMESPACES = {
  override: "stratum-guard-override",
  migrate: "stratum-guard-migrate",
} as const;

export type AuthorizationKind = keyof typeof AUTHORIZATION_NAMESPACES;

export type OverrideAuthorizationFields = {
  resource_id: string;
  from_state: string;
  to_state: string;
  rationale: string;
  ledger_head: string;
};

export type MigrateAuthorizationFields = {
  resource_id: string;
  policy_checksum: string;
  rationale: string;
  ledger_head: string;
};

export type AuthorizationFields = OverrideAuthorizationFields | MigrateAuthorizationFields;

/**
 * The exact bytes an operator signs. Canonical JSON so the operator's tooling
 * and the server agree byte-for-byte without either transporting the payload.
 */
export function authorizationPayload(kind: AuthorizationKind, fields: AuthorizationFields): string {
  return canonicalJson({ action: kind, ...fields });
}

export type AuthorizedBy = { principal: string; fingerprint: string };

/**
 * Verify `armored` authorizes exactly this operation on this resource at this
 * point in its history. Throws `OverrideUnavailable` on every failure — the same
 * slug the token check used, so callers and the error contract are unchanged.
 */
export function verifyAuthorization(
  kind: AuthorizationKind,
  fields: AuthorizationFields,
  armored: string,
): AuthorizedBy {
  if (!armored || !armored.trim()) {
    throw new OverrideUnavailable(
      `${kind} requires a signed authorization (see "stratum guard authorize")`,
    );
  }
  let signers;
  try {
    signers = loadAllowedSigners();
  } catch (error) {
    throw new OverrideUnavailable(error instanceof Error ? error.message : String(error));
  }
  const payload = Buffer.from(authorizationPayload(kind, fields), "utf8");
  let key: Buffer;
  try {
    key = verifySshsig(payload, armored, AUTHORIZATION_NAMESPACES[kind], signers.map((signer) => signer.publicKey));
  } catch (error) {
    // The payload is echoed back because the most common honest failure is a
    // stale ledger_head — the operator signed, the resource moved, and they need
    // to see what the server expected in order to re-sign.
    throw new OverrideUnavailable(
      `${kind} authorization rejected: ${error instanceof Error ? error.message : String(error)}; `
      + `expected a signature over ${authorizationPayload(kind, fields)}`,
    );
  }
  const fingerprint = sshFingerprint(key);
  const signer = signers.find((entry) => entry.fingerprint === fingerprint)!;
  return { principal: signer.principal, fingerprint };
}
