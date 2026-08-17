/**
 * Native verification of OpenSSH `ssh-keygen -Y sign` signatures (the "sshsig"
 * format, PROTOCOL.sshsig).
 *
 * Deliberately NOT a shell-out to `ssh-keygen -Y verify`. The threat model here
 * is an agent with a shell on this machine, and such an agent can put its own
 * `ssh-keygen` earlier on `PATH` and have it exit 0. An authorization decision
 * must not be delegated to a PATH-resolved binary.
 *
 * Ed25519 only. Other key types are refused rather than ignored: this file is a
 * trust boundary, and "algorithm we did not think about" must never mean
 * "accepted".
 */

import { createPublicKey, createHash, verify as cryptoVerify } from "node:crypto";

const MAGIC = Buffer.from("SSHSIG", "utf8");
const SIG_VERSION = 1;
const ED25519 = "ssh-ed25519";
const ARMOR_BEGIN = "-----BEGIN SSH SIGNATURE-----";
const ARMOR_END = "-----END SSH SIGNATURE-----";
// Ed25519 SPKI prefix: SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HASHES = new Map([["sha256", "sha256"], ["sha512", "sha512"]]);

export class SshsigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshsigError";
  }
}

/** Sequential reader for SSH wire format; throws rather than reading past the end. */
class Reader {
  #buffer: Buffer;
  #offset = 0;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }

  bytes(count: number): Buffer {
    if (count < 0 || this.#offset + count > this.#buffer.length) {
      throw new SshsigError("truncated sshsig structure");
    }
    const slice = this.#buffer.subarray(this.#offset, this.#offset + count);
    this.#offset += count;
    return slice;
  }

  uint32(): number {
    return this.bytes(4).readUInt32BE(0);
  }

  /** An SSH `string`: uint32 length followed by that many bytes. */
  string(): Buffer {
    return this.bytes(this.uint32());
  }

  text(): string {
    return this.string().toString("utf8");
  }

  get done(): boolean {
    return this.#offset === this.#buffer.length;
  }
}

function sshString(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Parse an `ssh-ed25519 AAAA...` public key blob into its raw 32 bytes. */
export function parseEd25519PublicKeyBlob(blob: Buffer): Buffer {
  const reader = new Reader(blob);
  const type = reader.text();
  if (type !== ED25519) throw new SshsigError(`unsupported public key type ${JSON.stringify(type)} (expected ${ED25519})`);
  const raw = reader.string();
  if (raw.length !== 32) throw new SshsigError("ed25519 public key must be 32 bytes");
  if (!reader.done) throw new SshsigError("trailing bytes in public key blob");
  return Buffer.from(raw);
}

function ed25519KeyObject(raw: Buffer) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export type SshsigSignature = {
  /** Raw 32-byte Ed25519 public key that produced the signature. */
  publicKey: Buffer;
  namespace: string;
  hashAlgorithm: string;
  signature: Buffer;
};

/** Decode the armored `-----BEGIN SSH SIGNATURE-----` envelope and its inner blob. */
export function parseSshsig(armored: string): SshsigSignature {
  const begin = armored.indexOf(ARMOR_BEGIN);
  const end = armored.indexOf(ARMOR_END);
  if (begin === -1 || end === -1 || end < begin) throw new SshsigError("not an armored SSH signature");
  const base64 = armored.slice(begin + ARMOR_BEGIN.length, end).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new SshsigError("signature armor is not valid base64");
  const blob = Buffer.from(base64, "base64");

  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new SshsigError("missing SSHSIG preamble");
  const reader = new Reader(blob.subarray(MAGIC.length));
  const version = reader.uint32();
  if (version !== SIG_VERSION) throw new SshsigError(`unsupported sshsig version ${version}`);
  const publicKey = parseEd25519PublicKeyBlob(reader.string());
  const namespace = reader.text();
  const reserved = reader.string();
  if (reserved.length !== 0) throw new SshsigError("sshsig reserved field must be empty");
  const hashAlgorithm = reader.text();
  const signatureBlob = new Reader(reader.string());
  const signatureType = signatureBlob.text();
  if (signatureType !== ED25519) throw new SshsigError(`unsupported signature type ${JSON.stringify(signatureType)}`);
  const signature = Buffer.from(signatureBlob.string());
  if (!signatureBlob.done) throw new SshsigError("trailing bytes in signature blob");
  if (!reader.done) throw new SshsigError("trailing bytes in sshsig structure");

  return { publicKey, namespace, hashAlgorithm, signature };
}

/**
 * Verify `armored` over `message` for `namespace`, accepting only keys in
 * `allowedKeys` (raw 32-byte Ed25519). Returns the accepted key on success and
 * throws on every other outcome — there is no falsy "not verified" return value
 * a caller could forget to check.
 */
export function verifySshsig(
  message: Buffer,
  armored: string,
  namespace: string,
  allowedKeys: Iterable<Buffer>,
): Buffer {
  const parsed = parseSshsig(armored);
  // Namespace is checked BEFORE the cryptographic verify so a signature made for
  // one purpose can never be replayed as authorization for another.
  if (parsed.namespace !== namespace) {
    throw new SshsigError(`signature namespace ${JSON.stringify(parsed.namespace)} does not match ${JSON.stringify(namespace)}`);
  }
  const hash = HASHES.get(parsed.hashAlgorithm);
  if (!hash) throw new SshsigError(`unsupported sshsig hash algorithm ${JSON.stringify(parsed.hashAlgorithm)}`);
  const trusted = [...allowedKeys].some((key) => key.length === parsed.publicKey.length && key.equals(parsed.publicKey));
  if (!trusted) {
    throw new SshsigError(`signature key ${sshFingerprint(parsed.publicKey)} is not an allowed signer`);
  }

  // PROTOCOL.sshsig: the signed blob is the preamble, namespace, reserved, hash
  // name, and the HASH of the message — not the message itself.
  const signedData = Buffer.concat([
    MAGIC,
    sshString(namespace),
    sshString(Buffer.alloc(0)),
    sshString(parsed.hashAlgorithm),
    sshString(createHash(hash).update(message).digest()),
  ]);
  if (!cryptoVerify(null, signedData, ed25519KeyObject(parsed.publicKey), parsed.signature)) {
    throw new SshsigError("signature does not verify");
  }
  return parsed.publicKey;
}

/** `SHA256:...` fingerprint, matching `ssh-keygen -l` output. */
export function sshFingerprint(rawPublicKey: Buffer): string {
  const blob = Buffer.concat([sshString(ED25519), sshString(rawPublicKey)]);
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export type AllowedSigner = { principal: string; publicKey: Buffer; fingerprint: string };

/**
 * Parse an OpenSSH `allowed_signers` file. Deliberately a strict subset: a line
 * is `<principal[,principal…]> ssh-ed25519 <base64> [comment]`. Option lists
 * (`cert-authority`, `namespaces=…`, `valid-before=…`) are REFUSED rather than
 * skipped, because silently ignoring a restriction the author wrote would make
 * the file mean something other than it says.
 */
export function parseAllowedSigners(contents: string): AllowedSigner[] {
  const signers: AllowedSigner[] = [];
  const lines = contents.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 3) throw new SshsigError(`allowed_signers line ${index + 1}: expected "<principals> ssh-ed25519 <base64>"`);
    const [principals, keyType, base64] = fields as [string, string, string];
    if (keyType !== ED25519) {
      throw new SshsigError(`allowed_signers line ${index + 1}: unsupported key type ${JSON.stringify(keyType)} (only ${ED25519})`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new SshsigError(`allowed_signers line ${index + 1}: key is not valid base64 (option lists are not supported)`);
    }
    const publicKey = parseEd25519PublicKeyBlob(Buffer.from(base64, "base64"));
    for (const principal of principals.split(",")) {
      if (!principal) throw new SshsigError(`allowed_signers line ${index + 1}: empty principal`);
      signers.push({ principal, publicKey, fingerprint: sshFingerprint(publicKey) });
    }
  }
  return signers;
}
