/**
 * The verifier is a trust boundary, so it is tested against an artifact produced
 * by real `ssh-keygen -Y sign` (committed under tests/fixtures/sshsig), not only
 * against our own signer. If our reading of PROTOCOL.sshsig were wrong, the
 * golden case would fail even though the round-trip with the test signer passed.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SshsigError,
  parseAllowedSigners,
  parseSshsig,
  sshFingerprint,
  verifySshsig,
} from "../../src/guard/sshsig.js";
import { createTestSigner } from "../helpers/sshsig-sign.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/sshsig/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/sshsig/${name}`, import.meta.url));

const GOLDEN_NAMESPACE = "stratum-guard-descriptors";
// From `ssh-keygen -l` on the fixture key, i.e. computed by OpenSSH, not by us.
const GOLDEN_FINGERPRINT = "SHA256:6hTJam4FJgomHwXEOIbBJPDfMMjCafKP2UB9DX32FDI";

describe("sshsig golden vector (produced by real ssh-keygen)", () => {
  it("verifies OpenSSH's own signature and agrees with its fingerprint", () => {
    const signers = parseAllowedSigners(fixture("golden_allowed_signers"));
    expect(signers).toHaveLength(1);
    expect(signers[0]).toMatchObject({ principal: "golden-signer", fingerprint: GOLDEN_FINGERPRINT });

    const key = verifySshsig(
      fixtureBytes("golden_message.json"),
      fixture("golden_message.sig"),
      GOLDEN_NAMESPACE,
      signers.map((signer) => signer.publicKey),
    );
    expect(sshFingerprint(key)).toBe(GOLDEN_FINGERPRINT);
  });

  it("reads the sha512 hash algorithm ssh-keygen defaults to", () => {
    expect(parseSshsig(fixture("golden_message.sig"))).toMatchObject({
      namespace: GOLDEN_NAMESPACE,
      hashAlgorithm: "sha512",
    });
  });

  it("rejects the golden signature over different bytes", () => {
    const signers = parseAllowedSigners(fixture("golden_allowed_signers"));
    expect(() => verifySshsig(
      Buffer.from('{"version":1,"descriptors":["evil"]}\n'),
      fixture("golden_message.sig"),
      GOLDEN_NAMESPACE,
      signers.map((signer) => signer.publicKey),
    )).toThrow(/does not verify/);
  });
});

describe("verifySshsig", () => {
  const signer = createTestSigner();
  const message = Buffer.from("authorize this");
  const allowed = [parseAllowedSigners(`principal ${signer.publicKeyLine}`)[0]!.publicKey];

  it.each(["sha256", "sha512"] as const)("verifies a %s signature", (hash) => {
    const armored = signer.sign(message, "ns", hash);
    expect(sshFingerprint(verifySshsig(message, armored, "ns", allowed))).toMatch(/^SHA256:/);
  });

  it("refuses a signature made for a different namespace", () => {
    // The whole point of namespaces: an authorization for one purpose must never
    // be replayable as authorization for another.
    const armored = signer.sign(message, "stratum-guard-override");
    expect(() => verifySshsig(message, armored, "stratum-guard-descriptors", allowed))
      .toThrow(/namespace/);
  });

  it("refuses a valid signature from a key that is not an allowed signer", () => {
    const stranger = createTestSigner();
    expect(() => verifySshsig(message, stranger.sign(message, "ns"), "ns", allowed))
      .toThrow(/not an allowed signer/);
  });

  it.each([
    ["not armored at all", "just some text"],
    ["armor with non-base64 body", "-----BEGIN SSH SIGNATURE-----\n!!!!\n-----END SSH SIGNATURE-----"],
    ["armor with an empty body", "-----BEGIN SSH SIGNATURE-----\n\n-----END SSH SIGNATURE-----"],
  ])("refuses %s", (_label, armored) => {
    expect(() => verifySshsig(message, armored, "ns", allowed)).toThrow(SshsigError);
  });

  it("refuses a truncated signature blob rather than reading past the end", () => {
    const armored = signer.sign(message, "ns");
    const body = armored.split("\n").slice(1, -2).join("").slice(0, 40);
    expect(() => verifySshsig(message, `-----BEGIN SSH SIGNATURE-----\n${body}\n-----END SSH SIGNATURE-----`, "ns", allowed))
      .toThrow(SshsigError);
  });
});

describe("parseAllowedSigners", () => {
  const signer = createTestSigner();

  it("skips comments and blank lines and expands comma-separated principals", () => {
    const parsed = parseAllowedSigners(`# a comment\n\nalice,bob ${signer.publicKeyLine} optional comment\n`);
    expect(parsed.map((entry) => entry.principal)).toEqual(["alice", "bob"]);
    expect(new Set(parsed.map((entry) => entry.fingerprint)).size).toBe(1);
  });

  it("treats an empty trust root as no signers, not as a wildcard", () => {
    expect(parseAllowedSigners("# nothing here\n")).toEqual([]);
  });

  it.each([
    ["a truncated line", "alice ssh-ed25519"],
    ["a non-ed25519 key type", "alice ssh-rsa AAAAB3NzaC1yc2E="],
    ["an option list we would otherwise silently ignore", `alice namespaces="x" ${signer.publicKeyLine}`],
  ])("refuses %s", (_label, line) => {
    expect(() => parseAllowedSigners(line)).toThrow(SshsigError);
  });
});

/**
 * Every vector below was demonstrated against the first implementation by an
 * adversarial review pass. The governing invariant they all serve: **accept
 * nothing OpenSSH would reject.** A divergence is not merely cosmetic — it means
 * an operator auditing with `ssh-keygen -Y verify` reaches a different conclusion
 * than the code that actually authorizes the change.
 */
describe("hardening vectors from adversarial review", () => {
  const goldenKeys = () => parseAllowedSigners(fixture("golden_allowed_signers")).map((signer) => signer.publicKey);
  const goldenMessage = () => fixtureBytes("golden_message.json");
  const goldenSig = () => fixture("golden_message.sig");

  it("refuses a small-order public key, which would verify ANY message with no private key", () => {
    // The identity point with R=identity, S=0 is a universal forgery. Both the
    // first implementation and OpenSSH 10.3 accepted it; rejected here at
    // enrolment, where a key becomes trusted.
    const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
    const sshString = (value: Buffer | string): Buffer => {
      const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length, 0);
      return Buffer.concat([header, body]);
    };
    const version = Buffer.alloc(4);
    version.writeUInt32BE(1, 0);
    const blob = Buffer.concat([
      Buffer.from("SSHSIG"), version,
      sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(identity)])),
      sshString("ns"), sshString(Buffer.alloc(0)), sshString("sha512"),
      sshString(Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.concat([identity, Buffer.alloc(32)]))])),
    ]);
    const armored = `-----BEGIN SSH SIGNATURE-----\n${blob.toString("base64")}\n-----END SSH SIGNATURE-----\n`;
    expect(() => verifySshsig(Buffer.from("anything at all"), armored, "ns", [identity])).toThrow(/small order/);
    // And such a key can never get onto the trust root in the first place.
    expect(() => parseAllowedSigners(`attacker ssh-ed25519 ${Buffer.concat([
      Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), identity,
    ]).toString("base64")}`)).toThrow(/small order/);
  });

  it.each([
    ["junk before the armor header", (sig: string) => `junk\n${sig}`],
    ["no newline after the armor header", (sig: string) => sig.replace("-----\n", "-----")],
    ["redundant base64 padding", (sig: string) => sig.replace("-----END", "==\n-----END")],
    ["trailing content after the footer", (sig: string) => `${sig}trailing`],
  ])("refuses armor with %s, which OpenSSH also rejects", (_label, mutate) => {
    expect(() => verifySshsig(goldenMessage(), mutate(goldenSig()), "stratum-guard-descriptors", goldenKeys()))
      .toThrow(SshsigError);
  });

  it("refuses an empty namespace, which the protocol requires to be non-empty", () => {
    expect(() => verifySshsig(goldenMessage(), goldenSig(), "", goldenKeys())).toThrow(/namespace is required/);
  });

  it("refuses non-ASCII inside the signed object rather than normalising it", () => {
    // Decoding with U+FFFD replacement let two distinct wire encodings compare
    // equal here while OpenSSH rejected one of them.
    const signer = createTestSigner();
    const allowed = parseAllowedSigners(`p ${signer.publicKeyLine}`).map((entry) => entry.publicKey);
    const armored = signer.sign(Buffer.from("m"), "\uFFFD");
    expect(() => verifySshsig(Buffer.from("m"), armored, "\uFFFD", allowed)).toThrow(/printable ASCII/);
  });

  it.each([
    ["a UTF-8 BOM before the principal", (line: string) => `\uFEFF${line}`],
    ["a non-breaking space as a field separator", (line: string) => line.replace(" ", "\u00a0")],
  ])("refuses an allowed_signers line with %s, which OpenSSH would not match", (_label, mutate) => {
    const line = fixture("golden_allowed_signers").trim();
    expect(() => parseAllowedSigners(mutate(line))).toThrow(/printable ASCII/);
  });

  it("refuses a non-canonically encoded key, which OpenSSH calls an invalid key", () => {
    const fields = fixture("golden_allowed_signers").trim().split(" ");
    const mutated = [fields[0], fields[1], `${fields[2]}==`, ...fields.slice(3)].join(" ");
    expect(() => parseAllowedSigners(mutated)).toThrow(/canonically encoded/);
  });

  it("pins the ed25519 signature length", () => {
    const signer = createTestSigner();
    const allowed = parseAllowedSigners(`p ${signer.publicKeyLine}`).map((entry) => entry.publicKey);
    const armored = signer.sign(Buffer.from("m"), "ns");
    const body = armored.split("\n").slice(1, -2).join("");
    const blob = Buffer.from(body, "base64");
    // Truncate the trailing signature bytes; the declared length no longer fits.
    const truncated = blob.subarray(0, blob.length - 1);
    const rewrapped = `-----BEGIN SSH SIGNATURE-----\n${truncated.toString("base64")}\n-----END SSH SIGNATURE-----\n`;
    expect(() => verifySshsig(Buffer.from("m"), rewrapped, "ns", allowed)).toThrow(SshsigError);
  });
});
