/**
 * Test-only sshsig signer. Produces the same armored artifact
 * `ssh-keygen -Y sign` produces, so the descriptor tests can build authorization
 * artifacts without shelling out to OpenSSH or committing a key.
 *
 * This is an independent implementation of the SIGNING side; the VERIFYING side
 * under test is exercised against a golden artifact from real `ssh-keygen` in
 * `tests/guard/sshsig.test.ts`, so a shared misunderstanding between this helper
 * and the verifier cannot pass unnoticed.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";

const MAGIC = Buffer.from("SSHSIG", "utf8");
const ED25519 = "ssh-ed25519";

function sshString(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export type TestSigner = {
  /** `ssh-ed25519 AAAA...` — the form an allowed_signers line carries. */
  publicKeyLine: string;
  sign(message: Buffer | string, namespace: string, hashAlgorithm?: "sha256" | "sha512"): string;
};

export function createTestSigner(): TestSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Raw 32 bytes are the tail of the Ed25519 SPKI DER encoding.
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKeyBlob = Buffer.concat([sshString(ED25519), sshString(raw)]);

  return {
    publicKeyLine: `${ED25519} ${publicKeyBlob.toString("base64")}`,
    sign(message, namespace, hashAlgorithm = "sha512") {
      const body = Buffer.isBuffer(message) ? message : Buffer.from(message, "utf8");
      const signedData = Buffer.concat([
        MAGIC,
        sshString(namespace),
        sshString(Buffer.alloc(0)),
        sshString(hashAlgorithm),
        sshString(createHash(hashAlgorithm).update(body).digest()),
      ]);
      const signature = cryptoSign(null, signedData, privateKey as KeyObject);
      const blob = Buffer.concat([
        MAGIC,
        (() => { const version = Buffer.alloc(4); version.writeUInt32BE(1, 0); return version; })(),
        sshString(publicKeyBlob),
        sshString(namespace),
        sshString(Buffer.alloc(0)),
        sshString(hashAlgorithm),
        sshString(Buffer.concat([sshString(ED25519), sshString(signature)])),
      ]);
      const wrapped = blob.toString("base64").replace(/(.{70})/g, "$1\n");
      return `-----BEGIN SSH SIGNATURE-----\n${wrapped}\n-----END SSH SIGNATURE-----\n`;
    },
  };
}
