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
