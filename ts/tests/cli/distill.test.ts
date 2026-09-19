import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../src/cli/stratum.js";
import { resolveDistillRequest } from "../../src/distill/runner.js";
import { corpus, row, scratch } from "../distill/fixtures.js";
afterEach(() => vi.restoreAllMocks());
async function invoke(args: string[]) {
  let stdout = "", stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  const code = await main(["distill", ...args]);
  vi.restoreAllMocks(); return { code, stdout, stderr };
}
it("routes extract/top/stats and emits one JSON document with resolved paths", async () => {
  const { root, project } = await corpus(); const flags = ["--root", root, "--project", project, "--json"];
  const top = await invoke(["top", ...flags, "--n", "1"]); expect(top.code).toBe(0); expect(JSON.parse(top.stdout).workflows).toHaveLength(1);
  const stats = await invoke(["stats", ...flags]); expect(JSON.parse(stats.stdout)).toMatchObject({ singletons: 2, sequences: 1, workspace_root: root, project_dirs: [project] });
  const extract = await invoke(["extract", ...flags]); expect(JSON.parse(extract.stdout)).toMatchObject({ written: 3, applied: false });
  expect(JSON.parse((await invoke(["extract", ...flags])).stdout).written).toBe(0);
});
it("all three --all commands use the same per-project grouping", async () => {
  const root = await scratch(), projects = join(root, "projects");
  for (const name of ["a", "b"]) { await mkdir(join(projects, name), { recursive: true }); for (const session of ["1", "2"]) await writeFile(join(projects, name, `${session}.jsonl`), row(["Read"])); }
  for (const action of ["top", "stats", "extract"]) {
    const result = await invoke([action, "--root", root, "--all", "--projects-root", projects, "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout).evaluated).toBe(2);
  }
});
it("Git root discovery matches root and nested ts invocations; explicit nested root wins", async () => {
  const repo = resolve(import.meta.dirname, "../../..");
  const atRoot = await resolveDistillRequest({ cwd: repo });
  const nested = await resolveDistillRequest({ cwd: join(repo, "ts") });
  expect(nested.workspaceRoot).toBe(atRoot.workspaceRoot); expect(nested.rootSource).toBe("git");
  expect((await resolveDistillRequest({ cwd: repo, workspaceRoot: join(repo, "ts") })).workspaceRoot).toBe(join(repo, "ts"));
});
it("valid empty scans exit zero and show paths in readable output", async () => {
  const root = await scratch(); const result = await invoke(["extract", "--root", root, "--project", join(root, "missing")]);
  expect(result.code).toBe(0); expect(result.stdout).toContain(`Workspace: ${root}`); expect(result.stdout).toContain("empty corpus");
});
it.each([["extract", "--apply"], ["extract", "--out", "/tmp/x"], ["top", "--n", "0"], ["stats", "--n", "1"], ["extract", "--min-count", "0"], ["extract", "--window-days", "-1"], ["extract", "--window-days", "1.5"], ["extract", "--root"], ["extract", "--json", "--json"], ["bad"]])("usage errors return 2: %j", async (...args) => {
  const result = await invoke(args); expect(result.code).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).toContain("stratum distill:");
});
it("operational errors return 1", async () => {
  const root = await scratch(); const file = join(root, "file"); await writeFile(file, "x");
  expect((await invoke(["extract", "--root", root, "--project", file])).code).toBe(1);
});
