import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog, modelCatalog, loadModelCatalog } from "../../src/config/models.js";
import { CODEX_REASONING_EFFORTS } from "../../src/connectors/base.js";
import { DEVIN_DEFAULT_MODEL, resolveDevinModel } from "../../src/connectors/devin-model.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryCatalog(mutate: (models: any) => void): string {
  const root = mkdtempSync(join(tmpdir(), "stratum-model-catalog-"));
  roots.push(root);
  const models = parse(readFileSync(new URL("../fixtures/models.synthetic.toml", import.meta.url), "utf8"));
  mutate(models);
  const path = join(root, "models.toml");
  writeFileSync(path, stringify(models));
  return path;
}

describe("shipped model catalog contract (D1/D2/D5)", () => {
  it("keeps every tier key, validates provider membership, prices, efforts and Devin pairs", () => {
    const expectedKeys = ["budget", "coordinator", "critical", "fast", "standard"];
    expect(Object.keys(catalog.judge).sort()).toEqual(["cheap", "default", "paranoid"]);
    for (const provider of ["codex", "claude", "devin"] as const) {
      expect(Object.keys(catalog.tiers[provider]).sort()).toEqual(expectedKeys);
      const ids = provider === "claude" ? catalog.models.claude : Object.keys(catalog.pricing[provider]);
      const accepted = ids.filter(id => !catalog.retired[provider].includes(id));
      expect(accepted).toContain(catalog[provider].default.model);
      for (const entry of Object.values(catalog.tiers[provider])) {
        if (entry === "unavailable") continue;
        expect(accepted).toContain(entry.model);
        expect(provider === "codex" ? CODEX_REASONING_EFFORTS : ["low", "medium", "high", "xhigh", "max", "unavailable"]).toContain(entry.effort);
        expect(provider === "claude" ? ["adaptive", "off"] : ["unavailable"]).toContain(entry.mode);
        if (provider === "devin") expect(resolveDevinModel(entry.model, entry.effort)).toBe(entry.model);
      }
    }
    for (const provider of ["codex", "devin"] as const) {
      expect(Object.keys(catalog.pricing[provider]).length).toBeGreaterThan(0);
      for (const row of Object.values(catalog.pricing[provider])) {
        expect(Object.keys(row).sort()).toEqual(["cache_read", "input", "output"]);
        for (const value of Object.values(row)) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(resolveDevinModel(catalog.devin.default.model, catalog.devin.default.effort)).toBe(DEVIN_DEFAULT_MODEL);
    for (const entry of Object.values(catalog.judge)) {
      expect(Object.keys(catalog.pricing.codex).filter(id => !catalog.retired.codex.includes(id))).toContain(entry.model);
      expect(CODEX_REASONING_EFFORTS).toContain(entry.effort);
    }
  });

  it("deep freezes the singleton and hashes the exact file bytes", () => {
    function assertFrozen(value: unknown): void {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertFrozen(child);
    }
    assertFrozen(modelCatalog);
    expect(modelCatalog.catalogDigest).toBe(createHash("sha256").update(readFileSync(modelCatalog.path)).digest("hex"));
    expect(() => { (catalog.codex.default as any).effort = "low"; }).toThrow();
    const path = temporaryCatalog(() => {});
    const original = loadModelCatalog(path);
    assertFrozen(original);
    const edited = parse(readFileSync(path, "utf8")) as any;
    edited.tiers.codex.standard.effort = "low";
    writeFileSync(path, stringify(edited));
    expect(loadModelCatalog(path).catalogDigest).not.toBe(original.catalogDigest);
    expect(original.catalog.tiers.codex.standard).toMatchObject({ effort: "high" });
  });

  it("never makes Devin models Codex-dispatchable", () => {
    for (const model of Object.keys(catalog.pricing.devin)) {
      expect(Object.keys(catalog.pricing.codex)).not.toContain(model);
    }
  });
});

describe("load-time rejection", () => {
  it.each(["codex", "devin", "claude"] as const)("rejects unknown %s defaults and tiers with its accepted list", provider => {
    for (const target of ["default", "standard"]) {
      const path = temporaryCatalog(models => {
        (target === "default" ? models[provider].default : models.tiers[provider][target]).model = "unknown-model";
      });
      const fixture = loadModelCatalog(temporaryCatalog(() => {})).catalog;
      const accepted = (provider === "claude" ? [...fixture.models.claude] : Object.keys(fixture.pricing[provider]))
        .filter(id => !fixture.retired[provider].includes(id)).sort();
      expect(() => loadModelCatalog(path)).toThrow(`accepted models: ${accepted.join(", ")}`);
    }
  });

  it.each(["codex", "devin", "claude"] as const)("rejects retired %s selections", provider => {
    for (const target of ["default", "standard"]) {
      const path = temporaryCatalog(models => {
        const entry = target === "default" ? models[provider].default : models.tiers[provider][target];
        models.retired[provider].push(entry.model);
      });
      expect(() => loadModelCatalog(path)).toThrow(/unknown or retired model.*accepted models:/);
    }
  });

  it.each(["codex", "devin", "claude"] as const)("rejects invalid %s effort with accepted efforts", provider => {
    const path = temporaryCatalog(models => { models.tiers[provider].standard.effort = "ultra"; });
    expect(() => loadModelCatalog(path)).toThrow(/unsupported effort.*accepted efforts:/);
  });

  it("rejects a mismatched Devin model/effort pair at defaults and tiers", () => {
    for (const target of ["default", "standard"]) {
      const path = temporaryCatalog(models => {
        (target === "default" ? models.devin.default : models.tiers.devin.standard).effort = "medium";
      });
      expect(() => loadModelCatalog(path)).toThrow(/devin.*conflicts with model.*accepted models:/);
    }
  });

  it.each(["input", "output", "cache_read"])("rejects negative %s pricing", field => {
    const path = temporaryCatalog(models => { models.pricing.codex["test-codex-a"][field] = -1; });
    expect(() => loadModelCatalog(path)).toThrow("greater than or equal to 0");
  });

  it.each([Infinity, -Infinity, NaN])("rejects nonfinite price %s", value => {
    const path = temporaryCatalog(models => { models.pricing.codex["test-codex-a"].input = value; });
    expect(() => loadModelCatalog(path)).toThrow("Invalid model catalog");
  });

  it("rejects provider crossing, missing keys, malformed TOML and unsupported thinking", () => {
    expect(() => loadModelCatalog(temporaryCatalog(models => { models.codex.default.model = "test-devin-high"; }))).toThrow("accepted models:");
    expect(() => loadModelCatalog(temporaryCatalog(models => { delete models.tiers.codex.fast; }))).toThrow();
    expect(() => loadModelCatalog(temporaryCatalog(models => { models.tiers.codex.standard.mode = "adaptive"; }))).toThrow("unsupported thinking mode");
    const path = temporaryCatalog(() => {});
    writeFileSync(path, "[broken");
    expect(() => loadModelCatalog(path)).toThrow("Invalid model catalog");
  });

  it("rejects unknown/retired judge models and unsupported judge effort", () => {
    expect(() => loadModelCatalog(temporaryCatalog(models => { models.judge.cheap.model = "unknown-model"; }))).toThrow("accepted models:");
    expect(() => loadModelCatalog(temporaryCatalog(models => { models.judge.cheap.model = "test-codex-retired"; }))).toThrow("accepted models:");
    expect(() => loadModelCatalog(temporaryCatalog(models => { models.judge.cheap.effort = "ultra"; }))).toThrow("accepted efforts: low, medium, high");
  });
});

describe("stratum models --json golden shape", () => {
  it("prints the selected installation's full catalog, digest, file path and package version", () => {
    const cli = fileURLToPath(new URL("../../dist/cli/stratum.js", import.meta.url));
    const output = JSON.parse(execFileSync(process.execPath, [cli, "models", "--json"], { encoding: "utf8" }));
    const path = fileURLToPath(new URL("../../dist/config/models.default.toml", import.meta.url));
    const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    expect(output).toEqual({ catalog, catalogDigest: createHash("sha256").update(readFileSync(path)).digest("hex"), path, version });
    expect(Object.keys(output)).toEqual(["catalog", "catalogDigest", "path", "version"]);
    expect(readFileSync(path)).toEqual(readFileSync(modelCatalog.path));
  });
});
