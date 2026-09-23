import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { modelIdentity } from "../../src/connectors/base.js";
import { codexModelWithEffort, CodexConnector } from "../../src/connectors/codex.js";
import { startBackgroundRun } from "../../src/connectors/background.js";
import { validateAgentSettings } from "../../src/connectors/runner.js";
import { baseModel, MODEL_PRICING } from "../../src/judge/pricing.js";

const accepted = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol"];
describe("dispatch model validation", () => {
  it("rejects unknown ids with the sorted accepted list", () => {
    expect(() => codexModelWithEffort("typo")).toThrow(`Unknown Codex model "typo"; accepted models: ${accepted.join(", ")}`);
  });
  it("rejects retired ids distinctly", () => {
    expect(() => codexModelWithEffort("gpt-5.3-codex-spark/low")).toThrow('"gpt-5.3-codex-spark" retired upstream 2026-09-16');
  });
  it.each(["chatgpt/gpt-5.3-codex-spark", "openai/gpt-6-sol/high"])("explains bare ids for %s", (model) => {
    expect(() => codexModelWithEffort(model, "high")).toThrow("provider-prefixed ids are not supported; pass the bare model id");
  });
  it.each(accepted)("accepts priced active model %s", (model) => {
    expect(codexModelWithEffort(model)).toBe(model);
    expect(MODEL_PRICING[model]).toBeDefined();
  });
  it.each(["minimal", "low", "medium", "high", "xhigh"])("shares accepted effort %s", (effort) => {
    expect(codexModelWithEffort(`gpt-5.6-terra/${effort}`)).toBe(`gpt-5.6-terra/${effort}`);
    expect(() => validateAgentSettings({ agent: "codex", effort })).not.toThrow();
  });
  it.each(["max", "ultra"])("rejects unsupported effort %s", (effort) => {
    expect(() => codexModelWithEffort("gpt-5.6-terra", effort)).toThrow("unsupported Codex reasoning effort");
    expect(() => codexModelWithEffort(`gpt-5.6-terra/${effort}`)).toThrow();
    expect(() => validateAgentSettings({ agent: "codex", effort })).toThrow("unsupported Codex reasoning effort");
  });
  it.each([
    ["provider/model/high", { model: "provider/model", effort: "high" }],
    ["chatgpt/gpt-5.3-codex-spark", { model: "chatgpt/gpt-5.3-codex-spark" }],
    ["gpt-5.6-terra/minimal", { model: "gpt-5.6-terra", effort: "minimal" }],
    ["gpt-5.6-terra/", { model: "gpt-5.6-terra/" }],
    ["gpt-5.6-terra/ultra", { model: "gpt-5.6-terra/ultra" }],
  ])("shares parsing for %s", (input, expected) => {
    expect(modelIdentity(input)).toEqual(expected);
    expect(baseModel(input)).toBe(expected.model);
  });
  it("validates CODEX_MODEL before SDK construction", () => {
    vi.stubEnv("CODEX_MODEL", "env-typo/high");
    const sdkFactory = vi.fn();
    try { expect(() => new CodexConnector({ sdkFactory })).toThrow('"env-typo"'); }
    finally { vi.unstubAllEnvs(); }
    expect(sdkFactory).not.toHaveBeenCalled();
  });
  it.each(["typo", "gpt-5.3-codex-spark", "chatgpt/gpt-6-sol"])("leaves no background files for rejected %s", async (model) => {
    const root = await mkdtemp(join(tmpdir(), "stratum-invalid-model-"));
    try {
      await expect(startBackgroundRun({ agent: "codex", model, prompt: "private", cwd: root, registryRoot: root, command: ["false"] })).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
