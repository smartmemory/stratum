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
    await writeFile(project, "[learn.inline_patch]\nenabled = true\n");
    expect(() => loadStratumConfig({
      projectRoot: root,
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml") },
    })).toThrow(`${project}: unknown config key \"learn\"`);
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
