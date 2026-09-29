import { catalog, testModels } from "../helpers/models.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { modelIdentity } from "../../src/connectors/base.js";
import { codexModelWithEffort, CodexConnector, defaultCodexModel } from "../../src/connectors/codex.js";
import { startBackgroundRun } from "../../src/connectors/background.js";
import { validateAgentSettings } from "../../src/connectors/runner.js";
import { baseModel, MODEL_PRICING } from "../../src/judge/pricing.js";

const accepted = ["test-codex-a", "test-codex-b", "test-codex-c"];
describe("dispatch model validation", () => {
  it("uses the catalog default", () => {
    vi.stubEnv("CODEX_MODEL", undefined);
    try { expect(defaultCodexModel()).toBe("test-codex-a/high"); }
    finally { vi.unstubAllEnvs(); }
  });
  it("preserves the environment override", () => {
    vi.stubEnv("CODEX_MODEL", "test-codex-b/low");
    try { expect(defaultCodexModel()).toBe("test-codex-b/low"); }
    finally { vi.unstubAllEnvs(); }
  });
  it("rejects unknown ids with the sorted accepted list", () => {
    expect(() => codexModelWithEffort("typo")).toThrow(`Unknown Codex model "typo"; accepted models: ${accepted.join(", ")}`);
  });
  it("rejects retired ids distinctly with the sorted accepted list", () => {
    expect(() => codexModelWithEffort(`${testModels.codexRetired}/low`)).toThrow(`Codex model "${testModels.codexRetired}" retired upstream 2026-09-16; accepted models: ${accepted.join(", ")}`);
  });
  it.each([`chatgpt/${testModels.codexRetired}`, `openai/${testModels.codexDefault}/high`])("explains bare ids for %s", (model) => {
    expect(() => codexModelWithEffort(model, "high")).toThrow("provider-prefixed ids are not supported; pass the bare model id");
  });
  it.each(accepted)("accepts priced active model %s", (model) => {
    expect(codexModelWithEffort(model)).toBe(model);
    expect(MODEL_PRICING[model]).toBeDefined();
  });
  it.each(["minimal", "low", "medium", "high", "xhigh"])("shares accepted effort %s", (effort) => {
    expect(codexModelWithEffort(`${testModels.codexDefault}/${effort}`)).toBe(`${testModels.codexDefault}/${effort}`);
    expect(() => validateAgentSettings({ agent: "codex", effort })).not.toThrow();
  });
  it.each(["max", "ultra"])("rejects unsupported effort %s", (effort) => {
    expect(() => codexModelWithEffort(testModels.codexDefault, effort)).toThrow("unsupported Codex reasoning effort");
    expect(() => codexModelWithEffort(`${testModels.codexDefault}/${effort}`)).toThrow();
    expect(() => validateAgentSettings({ agent: "codex", effort })).toThrow("unsupported Codex reasoning effort");
  });
  it.each([
    ["provider/model/high", { model: "provider/model", effort: "high" }],
    [`chatgpt/${testModels.codexRetired}`, { model: `chatgpt/${testModels.codexRetired}` }],
    [`${testModels.codexDefault}/minimal`, { model: testModels.codexDefault, effort: "minimal" }],
    [`${catalog.codex.default.model}/${catalog.codex.default.effort}`, { model: testModels.codexDefault, effort: "high" }],
    [`${testModels.codexDefault}/`, { model: `${testModels.codexDefault}/` }],
    [`${testModels.codexDefault}/ultra`, { model: `${testModels.codexDefault}/ultra` }],
  ])("shares parsing for %s", (input, expected) => {
    expect(modelIdentity(input)).toEqual(expected);
    expect(baseModel(input)).toBe(expected.model);
  });
  it("dispatches the dotted model id with a high effort suffix", () => {
    expect(codexModelWithEffort(`${catalog.codex.default.model}/${catalog.codex.default.effort}`)).toBe(`${catalog.codex.default.model}/${catalog.codex.default.effort}`);
  });
  it("validates CODEX_MODEL before SDK construction", () => {
    vi.stubEnv("CODEX_MODEL", "env-typo/high");
    const sdkFactory = vi.fn();
    try { expect(() => new CodexConnector({ sdkFactory })).toThrow('"env-typo"'); }
    finally { vi.unstubAllEnvs(); }
    expect(sdkFactory).not.toHaveBeenCalled();
  });
  it.each(["typo", testModels.codexRetired, `chatgpt/${testModels.codexDefault}`])("leaves no background files for rejected %s", async (model) => {
    const root = await mkdtemp(join(tmpdir(), "stratum-invalid-model-"));
    try {
      await expect(startBackgroundRun({ agent: "codex", model, prompt: "private", cwd: root, registryRoot: root, command: ["false"] })).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Inject synthetic bytes into the real singleton loader, preserving every adapter.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { fileURLToPath } = await import("node:url");
  const shipped = fileURLToPath(new URL("../../src/config/models.default.toml", import.meta.url));
  const fixture = fileURLToPath(new URL("../fixtures/models.synthetic.toml", import.meta.url));
  return { ...actual, readFileSync: new Proxy(actual.readFileSync, {
    apply(target, receiver, args) {
      if (args[0] === shipped) args[0] = fixture;
      return Reflect.apply(target, receiver, args);
    },
  }) };
});
