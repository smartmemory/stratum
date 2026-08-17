/**
 * Server-owned guard upgrade descriptors — the authorization primitive that
 * lets a pre-reviewed policy change be applied without the break-glass override
 * token. See `docs/features/STRAT-GUARD-DESCRIPTOR/design.md`.
 *
 * Authorization is a SIGNATURE, not a value in the environment. The descriptor
 * file must carry an sshsig (`ssh-keygen -Y sign`) from a key listed in the
 * in-source trust root `contracts/guard-signers.allowed`, under the namespace
 * `stratum-guard-descriptors`.
 *
 * Why a signature and not the digest pin this replaced: the threat model is an
 * agent with a shell and the operator's filesystem privileges. Such an agent can
 * set any environment variable, so an env-anchored digest is only as strong as
 * the process that reads it — over a CLI, the caller sets both the file and the
 * pin and they agree. It cannot, however, produce an Ed25519 signature without
 * the private key, whose passphrase lives only in the operator's head. The
 * remaining move is to edit the committed trust root, which is loud and shows up
 * in review rather than being invisible.
 *
 * The descriptor file's PATH still comes from the environment. Locating an
 * artifact is not authorizing it: point this anywhere, the signature still has
 * to verify.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { UpgradeDescriptorUnavailable } from "./errors.js";
import { SshsigError, parseAllowedSigners, sshFingerprint, verifySshsig, type AllowedSigner } from "./sshsig.js";
import type { EdgePredicates, GuardGraph } from "./store.js";

export const DESCRIPTOR_PATH_ENV = "STRATUM_GUARD_UPGRADE_DESCRIPTORS";
/** sshsig namespace for descriptor-file signatures; distinct per authorization purpose. */
export const DESCRIPTOR_NAMESPACE = "stratum-guard-descriptors";

// Resolved from the installed source tree, never from the environment. Same
// convention as the frozen MCP surface contract, so it works in both the dev
// tree (src/guard/) and the published tree (dist/guard/).
const DEFAULT_TRUST_ROOT = new URL("../../contracts/guard-signers.allowed", import.meta.url);
let trustRoot: URL | string = DEFAULT_TRUST_ROOT;

/** Isolated-test seam for the trust root. Deliberately NOT an environment variable. */
export function setGuardTrustRootForTests(path: string | null): () => void {
  const previous = trustRoot;
  trustRoot = path ?? DEFAULT_TRUST_ROOT;
  return () => { trustRoot = previous; };
}

/** Signers permitted to authorize guard policy changes. */
export function loadAllowedSigners(): AllowedSigner[] {
  let contents: string;
  try {
    contents = readFileSync(trustRoot, "utf8");
  } catch {
    unavailable(`guard signer trust root is unreadable: ${String(trustRoot)}`);
  }
  let signers: AllowedSigner[];
  try {
    signers = parseAllowedSigners(contents);
  } catch (error) {
    unavailable(`guard signer trust root is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (signers.length === 0) {
    unavailable(
      `no allowed signers configured in ${String(trustRoot)} `
      + "(add the PUBLIC half of an operator signing key; there is no default trust)",
    );
  }
  return signers;
}

const DESCRIPTOR_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
const DESCRIPTOR_KEYS = new Set(["id", "rationale", "from_checksum", "to_policy"]);
const POLICY_KEYS = new Set(["graph", "edge_predicates", "terminal", "stakes"]);
const FILE_KEYS = new Set(["version", "descriptors"]);
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export type DescriptorPolicy = {
  graph: GuardGraph;
  edge_predicates: EdgePredicates;
  terminal: string[];
  stakes: Record<string, string>;
};

export type UpgradeDescriptor = {
  id: string;
  rationale: string;
  from_checksum: string;
  to_policy: DescriptorPolicy;
};

export type DescriptorFile = {
  path: string;
  digest: string;
  /** Who authorized this artifact — recorded in the guard ledger. */
  signedBy: { principal: string; fingerprint: string };
  descriptors: UpgradeDescriptor[];
};

/** Path of the detached signature for a descriptor file. */
export function signaturePathFor(descriptorPathValue: string): string {
  return `${descriptorPathValue}.sig`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(message: string): never {
  throw new UpgradeDescriptorUnavailable(message);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
  // Rejected, not ignored: a typo'd key in an authorization artifact must never
  // silently mean something other than what the reviewer read.
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) unavailable(`${where} has unknown key ${JSON.stringify(key)}`);
  }
}

function parsePolicy(value: unknown, where: string): DescriptorPolicy {
  if (!isRecord(value)) unavailable(`${where} must be an object`);
  assertOnlyKeys(value, POLICY_KEYS, where);
  for (const key of POLICY_KEYS) {
    if (!Object.hasOwn(value, key)) unavailable(`${where} is missing ${JSON.stringify(key)}`);
  }
  if (!isRecord(value.graph)) unavailable(`${where}.graph must be an object`);
  if (!isRecord(value.edge_predicates)) unavailable(`${where}.edge_predicates must be an object`);
  if (!Array.isArray(value.terminal)) unavailable(`${where}.terminal must be an array`);
  if (!isRecord(value.stakes)) unavailable(`${where}.stakes must be an object`);
  // Field-level shape (arrays of state names, predicate objects, string stakes)
  // is enforced by _validatePolicy at apply time — authorized is not the same
  // as well-formed, and that check is shared with register/migrate/upgrade.
  return {
    graph: value.graph as GuardGraph,
    edge_predicates: value.edge_predicates as EdgePredicates,
    terminal: value.terminal as string[],
    stakes: value.stakes as Record<string, string>,
  };
}

function parseDescriptor(value: unknown, index: number): UpgradeDescriptor {
  const where = `descriptors[${index}]`;
  if (!isRecord(value)) unavailable(`${where} must be an object`);
  assertOnlyKeys(value, DESCRIPTOR_KEYS, where);
  for (const key of DESCRIPTOR_KEYS) {
    if (!Object.hasOwn(value, key)) unavailable(`${where} is missing ${JSON.stringify(key)}`);
  }
  const { id, rationale, from_checksum: fromChecksum } = value;
  if (typeof id !== "string" || !DESCRIPTOR_ID_PATTERN.test(id)) {
    unavailable(`${where}.id must match [A-Za-z0-9_.-]+`);
  }
  if (typeof rationale !== "string" || !rationale.trim()) {
    // The ledger carries this, so the audit trail says why and not only what.
    unavailable(`${where}.rationale must be a non-empty string`);
  }
  if (typeof fromChecksum !== "string" || !CHECKSUM_PATTERN.test(fromChecksum)) {
    unavailable(`${where}.from_checksum must be a lowercase sha256 hex digest`);
  }
  return { id, rationale, from_checksum: fromChecksum, to_policy: parsePolicy(value.to_policy, `${where}.to_policy`) };
}

/** Digest of a descriptor file's exact bytes — what the env pin is compared against. */
export function descriptorFileDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptorPath(env: NodeJS.ProcessEnv): string {
  const path = env[DESCRIPTOR_PATH_ENV];
  if (!path) unavailable(`upgrade descriptors unavailable: ${DESCRIPTOR_PATH_ENV} not set in server env`);
  if (!isAbsolute(path)) unavailable(`${DESCRIPTOR_PATH_ENV} must be an absolute path`);
  return path;
}

function readDescriptorBytes(path: string): { bytes: Buffer; groupOrWorldWritable: boolean } {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    unavailable(`upgrade descriptor file is unreadable: ${JSON.stringify(path)}`);
  }
  if (!stats.isFile()) unavailable(`upgrade descriptor path is not a regular file: ${JSON.stringify(path)}`);
  try {
    return { bytes: readFileSync(path), groupOrWorldWritable: (stats.mode & 0o022) !== 0 };
  } catch {
    unavailable(`upgrade descriptor file is unreadable: ${JSON.stringify(path)}`);
  }
}

function parseDescriptorFile(bytes: Buffer): UpgradeDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    unavailable(`upgrade descriptor file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) unavailable("upgrade descriptor file must contain a JSON object");
  assertOnlyKeys(parsed, FILE_KEYS, "upgrade descriptor file");
  if (parsed.version !== 1) unavailable(`unsupported upgrade descriptor file version ${JSON.stringify(parsed.version)}`);
  if (!Array.isArray(parsed.descriptors)) unavailable("upgrade descriptor file requires a descriptors array");

  const descriptors = parsed.descriptors.map((entry, index) => parseDescriptor(entry, index));
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) unavailable(`duplicate upgrade descriptor id ${JSON.stringify(descriptor.id)}`);
    seen.add(descriptor.id);
  }
  return descriptors;
}

/**
 * Read, authenticate and parse the configured descriptor file. Every failure is
 * `upgrade_descriptor_unavailable`: from the caller's side "not configured",
 * "tampered" and "malformed" are the same answer — you do not have this
 * capability — and collapsing them avoids turning the error into an oracle.
 */
export function loadDescriptorFile(env: NodeJS.ProcessEnv = process.env): DescriptorFile {
  const path = descriptorPath(env);
  const signers = loadAllowedSigners();
  const { bytes, groupOrWorldWritable } = readDescriptorBytes(path);
  // Defence in depth now rather than load-bearing: the signature already covers
  // the content, so tampering is detected regardless. A world-writable
  // authorization artifact is still a smell worth refusing.
  if (groupOrWorldWritable) {
    unavailable(`upgrade descriptor file must not be group- or world-writable: ${JSON.stringify(path)}`);
  }

  const signaturePath = signaturePathFor(path);
  let armored: string;
  try {
    armored = readFileSync(signaturePath, "utf8");
  } catch {
    unavailable(
      `upgrade descriptor file is not signed: expected ${JSON.stringify(signaturePath)} `
      + `(sign it with: ssh-keygen -Y sign -f <key> -n ${DESCRIPTOR_NAMESPACE} ${path})`,
    );
  }
  let signerKey: Buffer;
  try {
    signerKey = verifySshsig(bytes, armored, DESCRIPTOR_NAMESPACE, signers.map((signer) => signer.publicKey));
  } catch (error) {
    unavailable(
      `upgrade descriptor signature rejected: ${error instanceof SshsigError ? error.message : String(error)}`,
    );
  }
  const fingerprint = sshFingerprint(signerKey);
  const signer = signers.find((entry) => entry.fingerprint === fingerprint)!;

  return {
    path,
    digest: descriptorFileDigest(bytes),
    signedBy: { principal: signer.principal, fingerprint },
    descriptors: parseDescriptorFile(bytes),
  };
}

/**
 * Operator-facing inspection. Reports what is installed and whether it verifies,
 * without being able to grant anything: it reads the same trust root the apply
 * path does and reports failures as text rather than treating them as success.
 */
export function inspectDescriptorFile(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  sha256: string;
  group_or_world_writable: boolean;
  signature_path: string;
  signature: string;
  allowed_signers: Array<{ principal: string; fingerprint: string }>;
  descriptors: Array<{ id: string; rationale: string; from_checksum: string }>;
} {
  const path = descriptorPath(env);
  const { bytes, groupOrWorldWritable } = readDescriptorBytes(path);
  const signaturePath = signaturePathFor(path);

  let signers: AllowedSigner[] = [];
  let signature: string;
  try {
    signers = loadAllowedSigners();
    const armored = readFileSync(signaturePath, "utf8");
    const key = verifySshsig(bytes, armored, DESCRIPTOR_NAMESPACE, signers.map((entry) => entry.publicKey));
    const fingerprint = sshFingerprint(key);
    signature = `verified: signed by ${signers.find((entry) => entry.fingerprint === fingerprint)!.principal} (${fingerprint})`;
  } catch (error) {
    signature = `NOT VERIFIED: ${error instanceof Error ? error.message : String(error)}`;
  }

  return {
    path,
    sha256: descriptorFileDigest(bytes),
    group_or_world_writable: groupOrWorldWritable,
    signature_path: signaturePath,
    signature,
    allowed_signers: signers.map(({ principal, fingerprint }) => ({ principal, fingerprint })),
    descriptors: parseDescriptorFile(bytes).map(({ id, rationale, from_checksum: fromChecksum }) => ({
      id, rationale, from_checksum: fromChecksum,
    })),
  };
}

/** Resolve one descriptor by id, or refuse. */
export function findDescriptor(file: DescriptorFile, descriptorId: string): UpgradeDescriptor {
  const descriptor = file.descriptors.find((entry) => entry.id === descriptorId);
  if (!descriptor) unavailable(`no upgrade descriptor ${JSON.stringify(descriptorId)} in ${JSON.stringify(file.path)}`);
  return descriptor;
}
