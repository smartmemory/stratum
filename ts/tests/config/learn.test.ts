import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStratumConfig } from "../../src/config/index.js";
import { resolveLearnConfig } from "../../src/config/learn.js";

let dir: string;
let project: string;
let userFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stratum-learn-config-"));
  project = join(dir, "project");
  userFile = join(dir, "user.toml");
  await mkdir(project);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ STRATUM_CONFIG_FILE: userFile, ...extra });

describe("[learn] deliver switch", () => {
  it("defaults OFF with default provenance", () => {
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toEqual({
      deliver: false, provenance: { layer: "default", source: "built-in defaults" }, diagnostics: [],
    });
  });

  it("resolves user < project < env and reports the winning layer", async () => {
    await writeFile(userFile, "[learn]\ndeliver = true\n");
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toMatchObject({
      deliver: true, provenance: { layer: "user", source: userFile },
    });
    await writeFile(join(project, "stratum.toml"), "[learn]\ndeliver = false\n");
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toMatchObject({
      deliver: false, provenance: { layer: "project", source: join(project, "stratum.toml") },
    });
    expect(resolveLearnConfig({ projectRoot: project, env: env({ STRATUM_LEARN_DELIVER: "on" }) })).toMatchObject({
      deliver: true, provenance: { layer: "env", source: "STRATUM_LEARN_DELIVER" },
    });
  });

  it("resolves an invalid value OFF with a diagnostic instead of throwing", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn]\ndeliver = \"sometimes\"\n");
    const resolved = resolveLearnConfig({ projectRoot: project, env: env() });
    expect(resolved.deliver).toBe(false);
    expect(resolved.diagnostics.join("\n")).toContain("learn.deliver");
    const bad = resolveLearnConfig({ projectRoot: project, env: env({ STRATUM_LEARN_DELIVER: "maybe" }) });
    expect(bad.deliver).toBe(false);
    expect(bad.diagnostics.join("\n")).toContain("STRATUM_LEARN_DELIVER");
  });

  it("resolves a TOML parse failure OFF with a diagnostic", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn\n");
    const resolved = resolveLearnConfig({ projectRoot: project, env: env() });
    expect(resolved.deliver).toBe(false);
    expect(resolved.diagnostics.join("\n")).toContain("TOML");
  });

  it("does not change sandbox resolution, and sandbox resolution ignores [learn] contents", async () => {
    const before = loadStratumConfig({ projectRoot: project, env: env() }).sandboxAudit();
    await writeFile(join(project, "stratum.toml"), "[learn]\ndeliver = \"not-a-bool\"\nunknown = 1\n");
    expect(loadStratumConfig({ projectRoot: project, env: env() }).sandboxAudit()).toEqual(before);
  });

  it("keeps rejecting unknown top-level tables in the shared loader", async () => {
    await writeFile(join(project, "stratum.toml"), "[mystery]\nx = 1\n");
    expect(() => loadStratumConfig({ projectRoot: project, env: env() })).toThrow(/mystery/);
  });
});
