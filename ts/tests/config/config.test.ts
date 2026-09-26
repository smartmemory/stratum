import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadStratumConfig } from "../../src/config/index.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loadStratumConfig", () => {
  it("merges all five layers in order and reports the winning layer per key", async () => {
    const root = await temporaryRoot();
    const user = join(root, "user.toml");
    await writeFile(user, [
      "[sandbox]",
      'filesystemMode = "workspace-write"',
      "networkAccess = true",
      'writableRoots = ["/user"]',
      'approvalPolicy = "on-request"',
    ].join("\n"));
    await writeFile(join(root, "stratum.toml"), [
      "[sandbox]",
      "networkAccess = false",
      'writableRoots = ["/project"]',
    ].join("\n"));

    const projectWinner = loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: user },
    });
    expect(projectWinner.provenance("networkAccess")).toEqual({ layer: "project", source: join(root, "stratum.toml") });
    expect(projectWinner.provenance("writableRoots")).toEqual({ layer: "project", source: join(root, "stratum.toml") });

    const resolved = loadStratumConfig({
      projectRoot: root,
      dispatch: { writableRoots: ["/dispatch"], approvalPolicy: "untrusted" },
      env: {
        STRATUM_CONFIG_FILE: user,
        STRATUM_CODEX_NETWORK_ACCESS: "yes",
      },
    });

    expect(resolved.sandbox).toEqual({
      filesystemMode: "workspace-write",
      networkAccess: true,
      writableRoots: ["/dispatch"],
      approvalPolicy: "untrusted",
    });
    expect(resolved.provenance("filesystemMode")).toEqual({ layer: "user", source: user });
    expect(resolved.provenance("networkAccess")).toEqual({ layer: "env", source: "STRATUM_CODEX_NETWORK_ACCESS" });
    expect(resolved.provenance("writableRoots")).toEqual({ layer: "dispatch", source: "stratum_agent_run" });
    expect(resolved.provenance("approvalPolicy")).toEqual({ layer: "dispatch", source: "stratum_agent_run" });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.sandbox)).toBe(true);
    expect(Object.isFrozen(resolved.sandbox.writableRoots)).toBe(true);
  });

  it("uses safe built-in defaults when both files are absent", async () => {
    const root = await temporaryRoot();
    const resolved = loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml") },
    });
    expect(resolved.sandbox).toEqual({
      filesystemMode: "read-only",
      networkAccess: false,
      writableRoots: [],
      approvalPolicy: "never",
    });
    for (const key of ["filesystemMode", "networkAccess", "writableRoots", "approvalPolicy"] as const) {
      expect(resolved.provenance(key)).toEqual({ layer: "default", source: "built-in defaults" });
    }
  });

  it("rejects unknown keys with their path and source file", async () => {
    const root = await temporaryRoot();
    const project = join(root, "stratum.toml");
    // `[learn]` is a known table since STRAT-LEARN-DELIVER-1 (INLINE-TS-1 §A7).
    await writeFile(project, "[mystery.inline_patch]\nenabled = true\n");
    expect(() => loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml") },
    })).toThrow(`${project}: unknown config key \"mystery\"`);
  });

  it("rejects wrong-typed values with their key path and source file", async () => {
    const root = await temporaryRoot();
    const project = join(root, "stratum.toml");
    await writeFile(project, '[sandbox]\nnetworkAccess = "yes"\n');
    expect(() => loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml") },
    })).toThrow(`${project}: sandbox.networkAccess must be a boolean`);
  });

  it("wraps TOML syntax errors with the source file", async () => {
    const root = await temporaryRoot();
    const user = join(root, "user.toml");
    await writeFile(user, "[sandbox\n");
    expect(() => loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: user },
    })).toThrow(new RegExp(`${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: TOML parse error:`));
  });
});

// STRAT-AGENT-DEVIN-1 D11 — the env layer and the full-access opt-in are
// agent-keyed, and devin's networkAccess/approvalPolicy are enforced, not
// resolved.
describe("loadStratumConfig agent=devin (D11)", () => {
  const isolated = (root: string) => ({ HOME: root, PATH: "/usr/bin:/bin", STRATUM_CONFIG_FILE: join(root, "missing-user.toml") });

  it("ignores every STRATUM_CODEX_* sandbox variable — even a malformed one", async () => {
    const root = await temporaryRoot();
    const resolved = loadStratumConfig({
      projectRoot: root,
      agent: "devin",
      env: {
        ...isolated(root),
        STRATUM_CODEX_SANDBOX_MODE: "danger-full-access",
        STRATUM_CODEX_NETWORK_ACCESS: "yes",
        STRATUM_CODEX_WRITABLE_ROOTS: '["/leak"]',
        STRATUM_CODEX_APPROVAL_POLICY: "untrusted",
      },
    });
    // Nothing escalated: filesystem/writableRoots resolve untouched, and the
    // two enforced axes report the enforced value rather than the codex env's.
    expect(resolved.sandbox.filesystemMode).toBe("read-only");
    expect(resolved.sandbox.writableRoots).toEqual([]);
    expect(resolved.provenance("filesystemMode")).toEqual({ layer: "default", source: "built-in defaults" });
    expect(resolved.provenance("networkAccess")).toEqual({ layer: "enforced", source: expect.stringContaining("devin:") });
    expect(resolved.provenance("approvalPolicy")).toEqual({ layer: "enforced", source: expect.stringContaining("devin:") });

    // For codex the same env is fatal — the layer is real, just not for devin.
    expect(() => loadStratumConfig({
      projectRoot: root,
      env: { ...isolated(root), STRATUM_CODEX_SANDBOX_MODE: "bogus" },
    })).toThrow("STRATUM_CODEX_SANDBOX_MODE");
    expect(() => loadStratumConfig({
      projectRoot: root,
      agent: "devin",
      env: { ...isolated(root), STRATUM_CODEX_SANDBOX_MODE: "bogus" },
    })).not.toThrow();
  });

  it("rejects explicit dispatch networkAccess:false and approvalPolicy, accepts resolved defaults", async () => {
    const root = await temporaryRoot();
    expect(() => loadStratumConfig({
      projectRoot: root, agent: "devin", env: isolated(root), dispatch: { networkAccess: false },
    })).toThrow("devin cannot run without network; networkAccess:false is not enforceable for devin");
    expect(() => loadStratumConfig({
      projectRoot: root, agent: "devin", env: isolated(root), dispatch: { approvalPolicy: "never" },
    })).toThrow("stratum_agent_run: approvalPolicy is not supported by devin");

    // Dispatch axes devin does support resolve normally and keep dispatch provenance.
    const resolved = loadStratumConfig({
      projectRoot: root, agent: "devin", env: isolated(root),
      dispatch: { filesystemMode: "workspace-write", writableRoots: ["/dispatch"], networkAccess: true },
    });
    expect(resolved.sandbox.filesystemMode).toBe("workspace-write");
    expect(resolved.sandbox.writableRoots).toEqual(["/dispatch"]);
    expect(resolved.provenance("filesystemMode")).toEqual({ layer: "dispatch", source: "stratum_agent_run" });
    // The enforced axes overwrite even an explicit-true dispatch value.
    expect(resolved.provenance("networkAccess")).toEqual({ layer: "enforced", source: expect.stringContaining("devin:") });
  });

  it("overrides file-set networkAccess:false / approvalPolicy instead of failing", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "stratum.toml"), [
      "[sandbox]",
      "networkAccess = false",
      'approvalPolicy = "on-request"',
      'filesystemMode = "workspace-write"',
      'writableRoots = ["/cache"]',
    ].join("\n"));
    const resolved = loadStratumConfig({ projectRoot: root, agent: "devin", env: isolated(root) });
    expect(resolved.sandbox).toEqual({
      filesystemMode: "workspace-write", networkAccess: true, writableRoots: ["/cache"], approvalPolicy: "never",
    });
    expect(resolved.provenance("filesystemMode")).toEqual({ layer: "project", source: join(root, "stratum.toml") });
    expect(resolved.provenance("writableRoots")).toEqual({ layer: "project", source: join(root, "stratum.toml") });
    expect(resolved.provenance("networkAccess").layer).toBe("enforced");
    expect(resolved.provenance("approvalPolicy").layer).toBe("enforced");
  });

  it("authorises danger-full-access via STRATUM_DEVIN_ALLOW_FULL_ACCESS, not the codex var", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "stratum.toml"), '[sandbox]\nfilesystemMode = "danger-full-access"\n');
    const denied = loadStratumConfig({
      projectRoot: root, agent: "devin",
      env: { ...isolated(root), STRATUM_CODEX_ALLOW_FULL_ACCESS: "1" },
    });
    expect(denied.sandboxAudit().fullAccessAuthorization).toBeUndefined();
    const allowed = loadStratumConfig({
      projectRoot: root, agent: "devin",
      env: { ...isolated(root), STRATUM_DEVIN_ALLOW_FULL_ACCESS: "yes" },
    });
    expect(allowed.sandboxAudit().fullAccessAuthorization).toEqual({
      layer: "env", source: "STRATUM_DEVIN_ALLOW_FULL_ACCESS",
    });
  });
});
