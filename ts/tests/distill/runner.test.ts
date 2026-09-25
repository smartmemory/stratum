import { mkdir, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as os from "node:os";
import { inspectWorkflows, resolveDistillRequest, runDistill } from "../../src/distill/runner.js";
import { sidecarPath } from "../../src/distill/candidate.js";
import { corpus, row, scratch } from "./fixtures.js";
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>() }));
beforeEach(async () => vi.stubEnv("HOME", await scratch()));
afterEach(() => vi.unstubAllEnvs());
it("persists workspace-derived source provenance", async () => {
  const root = await scratch(), home = await scratch();
  const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
  try {
    const project = join(home, ".claude", "projects", root.replace(/\//g, "-"));
    await mkdir(project, { recursive: true });
    for (const name of ["a", "b"]) await writeFile(join(project, `${name}.jsonl`), row(undefined, root));
    const request = await resolveDistillRequest({ workspaceRoot: root });
    expect(request).toMatchObject({ sourceMode: "workspace", projectDirs: [project] });
    const result = await runDistill(request, { write: false });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every(candidate => candidate.scope.sourceMode === "workspace")).toBe(true);
  } finally { homeSpy.mockRestore(); }
});
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
it("stages only the distill sidecar, even when apply is enabled", async () => {
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
  const { root, project } = await corpus();
  const sentinels = [".claude/skills/existing/SKILL.md", ".claude/agents/existing.md", ".claude/commands/existing.md", ".stratum/learn/candidates.jsonl", ".stratum/postmortem/distill_candidates.jsonl", ".stratum/guard/state", ".stratum/runs/state"];
  for (const path of sentinels) { const parts = path.split("/"); parts.pop(); await mkdir(join(root, ...parts), { recursive: true }); await writeFile(join(root, path), path); }
  const request = await resolveDistillRequest({ workspaceRoot: root, projectDir: project });
  expect(request.sourceMode).toBe("explicit-project");
  const first = await runDistill(request); expect(first).toMatchObject({ written: 3, applied: false });
  expect(first.candidates.every(candidate => candidate.scope.sourceMode === "explicit-project")).toBe(true);
  const second = await runDistill(request); expect(second).toMatchObject({ written: 0, evaluated: 3, reason: "already staged" }); expect(second.candidates).toEqual(first.candidates);
  for (const path of sentinels) expect(await readFile(join(root, path), "utf8")).toBe(path);
  expect((await readdir(join(root, ".stratum", "distill"))).sort()).toEqual(["candidates.jsonl"]);
  for (const candidate of first.candidates) await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sidecarPath(root), "utf8")).toContain("distill-2.1");
});
it("partitions --all by source and uses identical inspection/extract groups", async () => {
  const root = await scratch(), projects = join(root, "projects");
  for (const name of ["b", "a"]) { const p = join(projects, name); await mkdir(p, { recursive: true }); await writeFile(join(p, "one.jsonl"), row()); }
  let request = await resolveDistillRequest({ workspaceRoot: root, all: true, projectsRoot: projects });
  expect(request.sourceMode).toBe("projects-root");
  expect((await inspectWorkflows(request)).workflows).toEqual([]);
  for (const name of ["a", "b"]) await writeFile(join(projects, name, "two.jsonl"), row());
  request = await resolveDistillRequest({ workspaceRoot: root, all: true, projectsRoot: projects });
  const inspection = await inspectWorkflows(request); const result = await runDistill(request, { write: false });
  expect(inspection.workflows).toHaveLength(6);
  expect(result.candidates.map(c => c.scope.transcriptProjectDir)).toEqual(inspection.workflows.map(w => w.scope.transcriptProjectDir));
  expect(result.candidates.every(candidate => candidate.scope.sourceMode === "projects-root")).toBe(true);
});
it("canonicalizes roots, respects explicit nested root, and rejects invalid options", async () => {
  const root = await scratch(), nested = join(root, "nested"); await mkdir(nested);
  const alias = join(root, "alias"); await symlink(nested, alias);
  const workspace = await resolveDistillRequest({ workspaceRoot: alias });
  expect(workspace.workspaceRoot).toBe(nested);
  expect(workspace.sourceMode).toBe("workspace");
  expect(await resolveDistillRequest({ cwd: nested, projectDir: "missing" })).toMatchObject({ rootSource: "cwd", sourceMode: "explicit-project" });
  for (const options of [{ minCount: 0 }, { windowDays: -1 }, { all: true }, { projectsRoot: root }, { all: true, projectDir: root, projectsRoot: root }]) await expect(resolveDistillRequest({ workspaceRoot: root, ...options })).rejects.toMatchObject({ errorType: "invalid_options" });
});
it("source and staging failures never become empty success", async () => {
  const { root, project } = await corpus();
  const badSource = join(root, "file"); await writeFile(badSource, "not a directory");
  await expect(runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: badSource }))).rejects.toMatchObject({ errorType: "source_read_error" });
  await symlink(await scratch(), join(root, ".stratum"));
  await expect(runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: project }))).rejects.toMatchObject({ errorType: "staging_error" });
});

it("discovers attributed root, descendant and ancestor sessions and deduplicates ids", async () => {
  const home = process.env.HOME!, parent = await scratch(), root = join(parent, "repo");
  await mkdir(join(root, "ts"), { recursive: true });
  const projects = join(home, ".claude", "projects");
  const source = (path: string) => join(projects, path.replace(/\//g, "-"));
  const put = async (path: string, id: string, content: string) => {
    await mkdir(source(path), { recursive: true });
    await writeFile(join(source(path), `${id}.jsonl`), content);
  };
  for (const path of [parent, root, join(root, "ts")]) {
    for (const id of ["a", "b"]) await put(path, `${path === parent ? "parent" : path === root ? "root" : "child"}-${id}`, row(undefined, root));
  }
  await put(parent, "root-a", row(undefined, root));
  await put(parent, "sibling", row(undefined, root + "-other"));
  await put(parent, "missing-cwd", row(undefined, null));
  await put(root, "wrong-root", row(undefined, parent));
  await put(root + "-other", "collision", row(undefined, root + "-other"));
  await put(join(parent, "unrelated"), "unrelated", row(undefined, root));
  // Attribution uses transcript metadata even when only user lines carry cwd.
  await put(parent, "metadata", JSON.stringify({ type: "user", cwd: join(root, "ts") }) + "\n" + row(undefined, null));
  // A session may enter the repo after starting in its parent.
  await put(parent, "entered", row(undefined, parent) + "\n" + row(undefined, join(root, "ts")));
  const result = await runDistill(await resolveDistillRequest({ workspaceRoot: root }), { write: false });
  expect(result.project_dirs).toEqual([source(parent), source(root), source(join(root, "ts"))].sort());
  expect(result.diagnostics.sessions).toBe(8);
  const evidence = result.candidates.flatMap(c => c.evidence);
  expect(new Set(evidence.map(e => e.sessionId))).toEqual(new Set(["parent-a", "parent-b", "root-a", "root-b", "child-a", "child-b", "metadata", "entered"]));
  expect(new Set(evidence.filter(e => e.sessionId === "root-a").map(e => e.projectDir)).size).toBe(1);
  const explicit = await runDistill(await resolveDistillRequest({ workspaceRoot: root, projectDir: source(parent) }), { write: false });
  expect(explicit.project_dirs).toEqual([source(parent)]);
  expect(explicit.diagnostics.sessions).toBe(7);
});
it("reports no sources when discovered sessions have no repo cwd", async () => {
  const parent = await scratch(), root = join(parent, "repo"); await mkdir(root);
  const project = join(process.env.HOME!, ".claude", "projects", parent.replace(/\//g, "-"));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "outside.jsonl"), row(undefined, parent));
  const result = await runDistill(await resolveDistillRequest({ workspaceRoot: root }), { write: false });
  expect(result).toMatchObject({ project_dirs: [], diagnostics: { sessions: 0 }, reason: "nothing to distill: empty corpus" });
});

it("does not count duplicate sessions as recurrence and preserves the time window", async () => {
  const parent = await scratch(), root = join(parent, "repo"); await mkdir(root);
  const projects = join(process.env.HOME!, ".claude", "projects");
  const sources = [root, parent, join(root, "ts")].map(path => join(projects, path.replace(/\//g, "-")));
  for (const source of sources) {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "same-id.jsonl"), row(undefined, root));
  }
  await writeFile(join(sources[0]!, "old.jsonl"), row(undefined, root));
  await utimes(join(sources[0]!, "old.jsonl"), new Date(0), new Date(0));
  const recent = await runDistill(await resolveDistillRequest({ workspaceRoot: root }), { write: false });
  expect(recent).toMatchObject({ project_dirs: [sources[0]], diagnostics: { sessions: 1 }, evaluated: 0, reason: "nothing to distill: no recurrence" });
  const allTime = await runDistill(await resolveDistillRequest({ workspaceRoot: root, windowDays: 0 }), { write: false });
  expect(allTime).toMatchObject({ project_dirs: [sources[0]], diagnostics: { sessions: 2 }, evaluated: 3 });
});
