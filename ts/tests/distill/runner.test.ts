import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectWorkflows, resolveDistillRequest, runDistill } from "../../src/distill/runner.js";
import { sidecarPath } from "../../src/distill/candidate.js";
import { corpus, row, scratch } from "./fixtures.js";
afterEach(() => vi.unstubAllEnvs());
it("empty, no-recurrence and preview scans create nothing", async () => {
  const root = await scratch(); const source = join(root, "missing");
  expect(await runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: source }))).toMatchObject({ evaluated: 0, written: 0, applied: false, reason: "nothing to distill: empty corpus", project_dirs: [source] });
  expect(await readdir(root)).toEqual([]);
  await mkdir(source); await writeFile(join(source, "a.jsonl"), row(["Read", "Read"]));
  expect((await runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: source }))).reason).toContain("no recurrence");
  const fixture = await corpus();
  const result = await runDistill(await resolveDistillRequest({ workspaceRoot: fixture.root, projectDir: fixture.project }), { write: false });
  expect(result).toMatchObject({ written: 0, evaluated: 3, reason: "preview" });
  expect(await readdir(fixture.root)).toEqual(["transcripts"]);
});
it("stages only the distill sidecar, even when learning apply is enabled", async () => {
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  const { root, project } = await corpus();
  const sentinels = ["skills/existing/SKILL.md", "agents/existing.md", "commands/existing.md", ".stratum/learn/candidates.jsonl", ".stratum/postmortem/distill_candidates.jsonl", ".stratum/guard/state", ".stratum/runs/state"];
  for (const path of sentinels) { const parts = path.split("/"); parts.pop(); await mkdir(join(root, ...parts), { recursive: true }); await writeFile(join(root, path), path); }
  const request = await resolveDistillRequest({ workspaceRoot: root, projectDir: project });
  const first = await runDistill(request); expect(first).toMatchObject({ written: 3, applied: false });
  const second = await runDistill(request); expect(second).toMatchObject({ written: 0, evaluated: 3, reason: "already staged" }); expect(second.candidates).toEqual(first.candidates);
  for (const path of sentinels) expect(await readFile(join(root, path), "utf8")).toBe(path);
  expect((await readdir(join(root, ".stratum", "distill"))).sort()).toEqual(["candidates.jsonl"]);
  for (const candidate of first.candidates) await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sidecarPath(root), "utf8")).toContain("distill-2.0");
});
it("partitions --all by source and uses identical inspection/extract groups", async () => {
  const root = await scratch(), projects = join(root, "projects");
  for (const name of ["b", "a"]) { const p = join(projects, name); await mkdir(p, { recursive: true }); await writeFile(join(p, "one.jsonl"), row()); }
  let request = await resolveDistillRequest({ workspaceRoot: root, all: true, projectsRoot: projects });
  expect((await inspectWorkflows(request)).workflows).toEqual([]);
  for (const name of ["a", "b"]) await writeFile(join(projects, name, "two.jsonl"), row());
  request = await resolveDistillRequest({ workspaceRoot: root, all: true, projectsRoot: projects });
  const inspection = await inspectWorkflows(request); const result = await runDistill(request, { write: false });
  expect(inspection.workflows).toHaveLength(6);
  expect(result.candidates.map(c => c.scope.transcriptProjectDir)).toEqual(inspection.workflows.map(w => w.scope.transcriptProjectDir));
});
it("canonicalizes roots, respects explicit nested root, and rejects invalid options", async () => {
  const root = await scratch(), nested = join(root, "nested"); await mkdir(nested);
  const alias = join(root, "alias"); await symlink(nested, alias);
  expect((await resolveDistillRequest({ workspaceRoot: alias })).workspaceRoot).toBe(nested);
  expect((await resolveDistillRequest({ cwd: nested, projectDir: "missing" })).rootSource).toBe("cwd");
  for (const options of [{ minCount: 0 }, { windowDays: -1 }, { all: true }, { projectsRoot: root }, { all: true, projectDir: root, projectsRoot: root }]) await expect(resolveDistillRequest({ workspaceRoot: root, ...options })).rejects.toMatchObject({ errorType: "invalid_options" });
});
it("source and staging failures never become empty success", async () => {
  const { root, project } = await corpus();
  const badSource = join(root, "file"); await writeFile(badSource, "not a directory");
  await expect(runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: badSource }))).rejects.toMatchObject({ errorType: "source_read_error" });
  await symlink(await scratch(), join(root, ".stratum"));
  await expect(runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: project }))).rejects.toMatchObject({ errorType: "staging_error" });
});
