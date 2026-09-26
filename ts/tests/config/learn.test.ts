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
const DEFAULT = { layer: "default", source: "built-in defaults" };

describe("[learn] switches", () => {
  it("default OFF with default provenance", () => {
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toEqual({
      deliver: false, inline: false, provenance: { deliver: DEFAULT, inline: DEFAULT }, diagnostics: [],
    });
  });

  it("resolves user < project < env per switch and reports each winning layer", async () => {
    await writeFile(userFile, "[learn]\ndeliver = true\ninline = true\n");
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toMatchObject({
      deliver: true, inline: true,
      provenance: { deliver: { layer: "user", source: userFile }, inline: { layer: "user", source: userFile } },
    });
    await writeFile(join(project, "stratum.toml"), "[learn]\ndeliver = false\n");
    expect(resolveLearnConfig({ projectRoot: project, env: env() })).toMatchObject({
      deliver: false, inline: true,
      provenance: { deliver: { layer: "project", source: join(project, "stratum.toml") }, inline: { layer: "user" } },
    });
    expect(resolveLearnConfig({ projectRoot: project, env: env({ STRATUM_LEARN_DELIVER: "on", STRATUM_LEARN_INLINE: "0" }) })).toMatchObject({
      deliver: true, inline: false,
      provenance: { deliver: { layer: "env", source: "STRATUM_LEARN_DELIVER" }, inline: { layer: "env", source: "STRATUM_LEARN_INLINE" } },
    });
  });

  it("without a project root, resolves user and env layers only", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn]\ninline = true\n");
    expect(resolveLearnConfig({ env: env() }).inline).toBe(false);
    expect(resolveLearnConfig({ env: env({ STRATUM_LEARN_INLINE: "1" }) }).inline).toBe(true);
  });

  it("an invalid value turns only that switch OFF, with a diagnostic", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn]\ndeliver = \"sometimes\"\ninline = true\n");
    const resolved = resolveLearnConfig({ projectRoot: project, env: env() });
    expect(resolved).toMatchObject({ deliver: false, inline: true });
    expect(resolved.diagnostics.join("\n")).toContain("learn.deliver");
    const bad = resolveLearnConfig({ projectRoot: project, env: env({ STRATUM_LEARN_INLINE: "maybe" }) });
    expect(bad.inline).toBe(false);
    expect(bad.diagnostics.join("\n")).toContain("STRATUM_LEARN_INLINE");
  });

  it("an unknown [learn] key or a TOML parse failure turns every switch OFF", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn]\ninline = true\ninline_patch = true\n");
    const unknown = resolveLearnConfig({ projectRoot: project, env: env() });
    expect(unknown).toMatchObject({ deliver: false, inline: false });
    expect(unknown.diagnostics.join("\n")).toContain("learn.inline_patch");
    await writeFile(join(project, "stratum.toml"), "[learn\n");
    const broken = resolveLearnConfig({ projectRoot: project, env: env({ STRATUM_LEARN_DELIVER: "" }) });
    expect(broken).toMatchObject({ deliver: false, inline: false });
    expect(broken.diagnostics.join("\n")).toContain("TOML");
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

  it("invalid TOML keeps failing the shared sandbox loader, as before this feature", async () => {
    await writeFile(join(project, "stratum.toml"), "[learn\n");
    expect(() => loadStratumConfig({ projectRoot: project, env: env() })).toThrow(/TOML parse error/);
  });
});
