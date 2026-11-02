/**
 * FORGE-ONTOLOGY-READY-1: the `src/ontology` seam resolves the project ontology pack, exports the pack's type and
 * relation names and one JSON Schema per type, matches the pack it resolves (drift check), and warns when the pack is
 * missing instead of passing silently.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as seam from "../src/ontology";
// @ts-expect-error -- plain ESM, Node only (kept byte-identical to forge/compose lib/ontology/resolve-pack.js)
import { resolveOntologyPack } from "../src/ontology/resolve-pack.mjs";

const TYPES = ["Project", "Group", "Module", "Repository", "Release", "Feature", "Unit", "Lane", "Seat", "Session",
  "Gate", "ProjectDecision", "Idea", "Commit", "Artifact"];
const quiet = () => { const seen: string[] = []; return { seen, warn: (m: string) => { seen.push(m); } }; };

describe("ontology seam", () => {
  it("exports the 15 pack types, 17 relations and one JSON Schema per type", () => {
    expect(seam.PACK_ID).toBe("project-ontology");
    expect([...seam.TYPE_NAMES]).toEqual(TYPES);
    expect(seam.RELATION_NAMES).toHaveLength(17);
    expect(Object.keys(seam.JSON_SCHEMAS)).toEqual(TYPES);
    expect(seam.JSON_SCHEMAS.Seat.required).toEqual(["id"]);
    expect(seam.JSON_SCHEMAS.Gate.required).toEqual(["id", "round"]);
  });

  it("the committed stub matches the pack this checkout resolves (drift check)", ({ skip }) => {
    const { seen, warn } = quiet();
    const found = resolveOntologyPack(process.env, { warn });
    if (!found) skip(`no pack on this machine: ${seen.join(" ")}`);
    expect(seam.PACK_SHA256, `pack changed (${found.source} ${found.packFile}): regenerate pack.generated with forge/compose lib/ontology/gen-stub.js`).toBe(found.sha256);
    expect([...seam.TYPE_NAMES]).toEqual(found.pack.types.map((t: { name: string }) => t.name));
    expect([...seam.RELATION_NAMES]).toEqual(found.pack.relations.map((r: { name: string }) => r.name));
  });

  it("PROJECT_ONTOLOGY_PACK=none forces absent with a WARNING", () => {
    const { seen, warn } = quiet();
    expect(resolveOntologyPack({ PROJECT_ONTOLOGY_PACK: "none" }, { warn })).toBeNull();
    expect(seen[0]).toMatch(/^WARNING: .*forced absent/);
  });

  it("no SmartMemory checkout above the start dir: null with a WARNING", () => {
    const dir = mkdtempSync(join(tmpdir(), "onto-seam-"));
    try {
      const { seen, warn } = quiet();
      expect(resolveOntologyPack({}, { start: dir, warn })).toBeNull();
      expect(seen[0]).toMatch(/^WARNING: project ontology pack not found/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("core's pack beats the draft; a generated/ dir with .d.ts marks it generated", () => {
    const root = mkdtempSync(join(tmpdir(), "onto-seam-"));
    try {
      const sm = join(root, "SmartMemory");
      const packDir = join(sm, "smart-memory-core", "smartmemory", "ontology", "packs", "project-ontology", "1.0.0");
      mkdirSync(join(sm, "contracts"), { recursive: true });
      writeFileSync(join(sm, "contracts", "project-ontology-bundle.v1.json"), '{"pack_id":"draft"}');
      const start = join(root, "forge", "app", "ui", "src", "ontology");
      mkdirSync(start, { recursive: true });
      expect(resolveOntologyPack({}, { start }).source).toBe("draft");
      mkdirSync(join(packDir, "generated"), { recursive: true });
      writeFileSync(join(packDir, "pack.json"), '{"pack_id":"core"}');
      expect(resolveOntologyPack({}, { start }).source).toBe("pack");
      writeFileSync(join(packDir, "generated", "project-ontology.d.ts"), "export {};");
      expect(resolveOntologyPack({}, { start }).source).toBe("generated");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
