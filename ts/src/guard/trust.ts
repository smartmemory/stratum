/**
 * The guard authorization trust root: which public keys may sign guard
 * authorization artifacts.
 *
 * Read from the installed source tree (`contracts/guard-signers.allowed`), never
 * from an environment variable. That is the whole point: an env var can be set
 * silently by whatever process happens to be running — and the adversary in this
 * threat model launches processes — while changing a committed file shows up in
 * `git status` and in review.
 *
 * There is no default trust. An empty or unreadable trust root makes every
 * signed path report itself unavailable rather than degrading to something
 * weaker.
 */

import { readFileSync } from "node:fs";
import { parseAllowedSigners, type AllowedSigner } from "./sshsig.js";

export type { AllowedSigner };

// Same resolution convention as the frozen MCP surface contract, so it works in
// both the dev tree (src/guard/) and the published tree (dist/guard/).
const DEFAULT_TRUST_ROOT = new URL("../../contracts/guard-signers.allowed", import.meta.url);
let trustRoot: URL | string = DEFAULT_TRUST_ROOT;

/** Isolated-test seam. Deliberately NOT an environment variable. */
export function setGuardTrustRootForTests(path: string | null): () => void {
  const previous = trustRoot;
  trustRoot = path ?? DEFAULT_TRUST_ROOT;
  return () => { trustRoot = previous; };
}

export function trustRootPath(): string {
  return String(trustRoot);
}

export class GuardTrustRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardTrustRootError";
  }
}

/**
 * Signers permitted to authorize guard policy changes. Throws
 * `GuardTrustRootError` on every failure — callers translate it into whichever
 * guard slug fits their surface, so this module stays free of guard error
 * vocabulary.
 */
export function loadAllowedSigners(): AllowedSigner[] {
  let contents: string;
  try {
    contents = readFileSync(trustRoot, "utf8");
  } catch {
    throw new GuardTrustRootError(`guard signer trust root is unreadable: ${trustRootPath()}`);
  }
  let signers: AllowedSigner[];
  try {
    signers = parseAllowedSigners(contents);
  } catch (error) {
    throw new GuardTrustRootError(`guard signer trust root is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signers.length === 0) {
    throw new GuardTrustRootError(
      `no allowed signers configured in ${trustRootPath()} `
      + "(add the PUBLIC half of an operator signing key; there is no default trust)",
    );
  }
  return signers;
}
