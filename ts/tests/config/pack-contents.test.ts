import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stratum-pack-models-"));
  roots.push(root);
  return root;
}

it("includes the shipped catalog in npm's packed file inventory", () => {
  const cache = temporaryRoot();
  // Build first. Suppress prepack here so this read-only inventory check cannot
  // clean dist underneath the CLI golden tests in another test worker.
  const inventory = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8",
  })) as Array<{ files: Array<{ path: string }> }>;
  expect(inventory).toHaveLength(1);
  expect(inventory[0]!.files.map(file => file.path)).toContain("dist/config/models.default.toml");
}, 30_000);

it.each(["missing source", "omitted copy"])("fails distribution preparation for a catalog %s", fault => {
  const root = temporaryRoot();
  const put = (path: string, contents: string) => {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  };
  put("package.json", '{"type":"module"}');
  for (const entry of ["connectors/codex-appserver-driver", "connectors/peer-sidecar", "cli/stratum", "mcp/main"]) {
    put(`dist/${entry}.js`, "#!/usr/bin/env -S node --experimental-strip-types\nexport {};\n");
  }
  for (const entry of ["mcp/contracts", "guard/trust"]) put(`dist/${entry}.js`, 'const path = "../../contracts/";');
  mkdirSync(join(root, "dist/config"), { recursive: true });
  let script = readFileSync(new URL("../../scripts/prepare-dist.mjs", import.meta.url), "utf8");
  if (fault === "omitted copy") {
    put("src/config/models.default.toml", "# synthetic catalog bytes\n");
    expect(script).toContain("await copyFile(sourceModels, distModels);");
    script = script.replace("await copyFile(sourceModels, distModels);", "// Fault injection: catalog copy omitted.");
  }
  put("scripts/prepare-dist.mjs", script);
  const result = spawnSync(process.execPath, [join(root, "scripts/prepare-dist.mjs")], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("ENOENT");
  expect(result.stderr).toContain("models.default.toml");
});
