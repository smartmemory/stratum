/**
 * Server-owned guard upgrade descriptors — the authorization primitive that
 * lets a pre-reviewed policy change be applied without the break-glass override
 * token. See `docs/features/STRAT-GUARD-DESCRIPTOR/design.md`.
 *
 * The whole security property rests on two server-environment variables that an
 * agent cannot alter (the same anchor `STRATUM_GUARD_OVERRIDE_TOKEN` uses): the
 * descriptor file's path, and a REQUIRED sha256 pin of its bytes. The pin is
 * required rather than optional because the file usually sits somewhere the
 * agent under guard can write, so an unpinned file authorizes nothing while
 * looking like it authorizes something.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { UpgradeDescriptorUnavailable } from "./errors.js";
import type { EdgePredicates, GuardGraph } from "./store.js";

export const DESCRIPTOR_PATH_ENV = "STRATUM_GUARD_UPGRADE_DESCRIPTORS";
export const DESCRIPTOR_PIN_ENV = "STRATUM_GUARD_UPGRADE_DESCRIPTORS_SHA256";

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
  descriptors: UpgradeDescriptor[];
};

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
  const pin = env[DESCRIPTOR_PIN_ENV];
  if (!pin) {
    unavailable(
      `upgrade descriptors unavailable: ${DESCRIPTOR_PIN_ENV} not set in server env `
      + `(required — an unpinned descriptor file authorizes nothing; run "stratum guard descriptors" to compute it)`,
    );
  }
  if (!CHECKSUM_PATTERN.test(pin)) unavailable(`${DESCRIPTOR_PIN_ENV} must be a lowercase sha256 hex digest`);

  const { bytes, groupOrWorldWritable } = readDescriptorBytes(path);
  // Same rule ssh applies to a private key: a correct digest is worthless if
  // anyone on the box can race the file between verification and the next read.
  if (groupOrWorldWritable) {
    unavailable(`upgrade descriptor file must not be group- or world-writable: ${JSON.stringify(path)}`);
  }
  const digest = descriptorFileDigest(bytes);
  if (digest !== pin) {
    unavailable(`upgrade descriptor file digest ${digest} does not match the pinned ${DESCRIPTOR_PIN_ENV}`);
  }
  return { path, digest, descriptors: parseDescriptorFile(bytes) };
}

/**
 * Operator-facing inspection. Reports the digest even when the pin is absent or
 * wrong, because the operator needs it in order to SET the pin the first time —
 * `loadDescriptorFile` cannot answer that question by construction. Read-only,
 * never consulted by the apply path, and it grants nothing: it prints a digest
 * of a file the operator already chose to point at.
 */
export function inspectDescriptorFile(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  sha256: string;
  group_or_world_writable: boolean;
  pinned: boolean;
  pin_matches: boolean;
  descriptors: Array<{ id: string; rationale: string; from_checksum: string }>;
} {
  const path = descriptorPath(env);
  const { bytes, groupOrWorldWritable } = readDescriptorBytes(path);
  const digest = descriptorFileDigest(bytes);
  const pin = env[DESCRIPTOR_PIN_ENV];
  return {
    path,
    sha256: digest,
    group_or_world_writable: groupOrWorldWritable,
    pinned: Boolean(pin),
    pin_matches: pin === digest,
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
