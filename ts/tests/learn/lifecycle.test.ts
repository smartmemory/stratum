import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import * as workspace from "../../src/learn/workspace.js";
import { canonicalWorkspace, withWorkspaceLock } from "../../src/learn/workspace.js";
import { appendCandidates, authorCandidate, readCandidates } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvest, type FailureRecord } from "../../src/learn/harvest.js";
import { appendLifecycle, readLifecycle, lessonLifecycle, isSuppressed, hasEvidenceAfterRetirement,
  REVIEW_KINDS, type LifecycleRow } from "../../src/learn/lifecycle.js";
import { learnCommand } from "../../src/cli/learn.js";

const exec = promisify(execFile);
const originalGuards = GUARDS_DIR;
const loader = fileURLToPath(new URL("../helpers/source-loader.mjs", import.meta.url));
const clusterId = "a".repeat(64);
let root: string;
let log: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "learn-lifecycle-")));
  setGuardsDir(join(root, "guards"));
  log = join(root, ".stratum", "learn", "lifecycle.jsonl");
});
afterEach(async () => {
  vi.restoreAllMocks();
  setGuardsDir(originalGuards);
  await rm(root, { recursive: true, force: true });
});
const input = (kind: LifecycleRow["kind"]): Omit<LifecycleRow, "at"> => ({ clusterId, kind, reason: "owner checked" });
async function repo() {
  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
}
async function candidate() {
  const { records } = await harvest(fileURLToPath(new URL("../fixtures/learn/flows", import.meta.url)));
  return authorCandidate(classify(records.map((r) => ({ ...r, workspaceRoot: root }))).find((c) => c.class === "durable")!);
}

it("canonicalizes a main checkout, subdirectory and linked worktree; preserves non-git and bare paths", async () => {
  await repo();
  const sub = join(root, "ts");
  const linked = join(root, "linked");
  await mkdir(sub);
  await exec("git", ["-C", root, "worktree", "add", "-b", "linked", linked]);
  for (const path of [root, sub, linked]) expect(await canonicalWorkspace(path)).toBe(root);
  const bare = join(root, "bare.git");
  await exec("git", ["init", "--bare", bare]);
  expect(await canonicalWorkspace(bare)).toBe(bare);
  const bareDotGit = join(root, "bare-parent", ".git");
  await exec("git", ["init", "--bare", bareDotGit]);
  expect(await canonicalWorkspace(bareDotGit)).toBe(bareDotGit);
  const nongit = await mkdtemp(join(tmpdir(), "learn-nongit-"));
  try { expect(await canonicalWorkspace(nongit)).toBe(nongit); }
  finally { await rm(nongit, { recursive: true, force: true }); }
});

it("preserves newlines in the main checkout path when resolving a linked worktree", async (context) => {
  const main = join(root, "main\ncheckout\n");
  try {
    await mkdir(main);
  } catch {
    context.skip();
    return;
  }
  await exec("git", ["init", main]);
  await exec("git", ["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"]);
  const linked = join(root, "linked");
  await exec("git", ["-C", main, "worktree", "add", "-b", "linked", linked]);
  expect(await canonicalWorkspace(main)).toBe(main);
  expect(await canonicalWorkspace(linked)).toBe(main);
});

// The bound lives in canonicalizeRecordRoots(), shared by CLI harvest and the INLINE-TS-1 pass;
// it is spied through its resolver parameter (an internal call cannot be spied via the export).
it("harvest root canonicalization resolves 50 distinct non-git roots once each with at most 8 concurrent calls", async () => {
  const flows = join(root, "flows");
  await mkdir(flows);
  const fixture = JSON.parse(await readFile(
    fileURLToPath(new URL("../fixtures/learn/flows/enum-2.json", import.meta.url)), "utf8"));
  const event = fixture.events.find((e: { detail?: { failure?: { reason?: string } } }) =>
    e.detail?.failure?.reason?.includes("invalid_enum_value"));
  const paths = Array.from({ length: 50 }, (_, i) => join(root, `nongit-${i}`));
  for (const [i, workspaceRoot] of paths.entries()) {
    await mkdir(workspaceRoot);
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const id = `run-${i}-${duplicate}`;
      await writeFile(join(flows, `${id}.json`), JSON.stringify({
        ...fixture, id, workspaceRoot, events: [event],
      }));
    }
  }
  let active = 0;
  let peak = 0;
  const calls = new Map<string, number>();
  const spy = async (path: string) => {
    calls.set(path, (calls.get(path) ?? 0) + 1);
    peak = Math.max(peak, ++active);
    try { return await workspace.canonicalWorkspace(path); }
    finally { active--; }
  };
  const { records } = await harvest(flows);
  expect(records).toHaveLength(100);
  await workspace.canonicalizeRecordRoots(records, spy);
  // The CLI path still harvests every record through the same helper.
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(await learnCommand(["harvest", "--flows", flows, "--root", root, "--json"])).toBe(0);
  expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join("")).records).toBe(100);
  expect(peak).toBeLessThanOrEqual(8);
  expect(peak).toBeGreaterThan(1);
  for (const path of paths) expect(calls.get(path)).toBe(1);
});

it("canonicalizes submodules and separate-git-dir checkouts and subdirectories", async () => {
  await repo();
  const source = join(root, "source");
  await exec("git", ["clone", root, source]);
  const submodule = join(root, "module");
  await exec("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", source, submodule]);
  const separate = join(root, "separate");
  await exec("git", ["init", "--separate-git-dir", join(root, "metadata"), separate]);
  for (const checkout of [submodule, separate]) {
    const sub = join(checkout, "nested");
    await mkdir(sub);
    expect(await canonicalWorkspace(checkout)).toBe(checkout);
    expect(await canonicalWorkspace(sub)).toBe(checkout);
  }
});

it("ignores inherited GIT_DIR without poisoning the non-git cache", async () => {
  const other = join(root, "other");
  await exec("git", ["init", other]);
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(other, ".git");
    expect(await canonicalWorkspace(root)).toBe(root);
    delete process.env.GIT_DIR;
    expect(await canonicalWorkspace(root)).toBe(root);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});

it("retries after git cannot be spawned", async () => {
  await repo();
  const sub = join(root, "nested");
  await mkdir(sub);
  const previous = process.env.PATH;
  try {
    process.env.PATH = join(root, "missing-bin");
    expect(await canonicalWorkspace(sub)).toBe(sub);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  expect(await canonicalWorkspace(sub)).toBe(root);
});

it("a timed-out git lookup returns the input path and is retried, not cached", async () => {
  await repo();
  const sub = join(root, "nested");
  await mkdir(sub);
  const bin = join(root, "fake-bin");
  await mkdir(bin);
  const marker = join(root, "fake-git-ran");
  await writeFile(join(bin, "git"), `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexec /bin/sleep 30\n`);
  await chmod(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = previous === undefined ? bin : `${bin}:${previous}`;
    // The fake git really ran (the marker proves it) and was killed by the timeout —
    // a killed child is not "not a git repository", so the result must NOT cache.
    expect(await canonicalWorkspace(sub, 50)).toBe(sub);
    await expect(stat(marker)).resolves.toBeDefined();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  expect(await canonicalWorkspace(sub)).toBe(root);
});

it.each(["ENOENT", "ENOTDIR"])("retries a missing workspace (%s) after creation without spawning git while absent", async (code) => {
  await repo();
  const parent = join(root, "missing-parent");
  if (code === "ENOTDIR") await writeFile(parent, "file");
  const sub = join(parent, "checkout");
  const bin = join(root, "fake-bin");
  await mkdir(bin);
  const marker = join(root, "git-count");
  await writeFile(marker, "");
  await writeFile(join(bin, "git"), `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`);
  await chmod(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = previous === undefined ? bin : `${bin}:${previous}`;
    expect(await canonicalWorkspace(sub)).toBe(sub);
    expect(await readFile(marker, "utf8")).toBe("");
    expect(await canonicalWorkspace(sub)).toBe(sub);
    expect(await readFile(marker, "utf8")).toBe("");
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  if (code === "ENOTDIR") await rm(parent);
  await mkdir(sub, { recursive: true });
  expect(await canonicalWorkspace(sub)).toBe(root);
});

it.each(["linked", "mixed"])("CLI harvest stages %s workspace evidence in the main checkout", async (layout) => {
  await repo();
  const linked = join(root, "linked");
  const sub = join(root, "nested");
  await mkdir(sub);
  await exec("git", ["-C", root, "worktree", "add", "-b", "linked", linked]);
  const flows = join(root, "flows");
  await mkdir(flows);
  const fixture = JSON.parse(await readFile(
    fileURLToPath(new URL("../fixtures/learn/flows/enum-2.json", import.meta.url)), "utf8"));
  const event = fixture.events.find((e: { detail?: { failure?: { reason?: string } } }) =>
    e.detail?.failure?.reason?.includes("invalid_enum_value"));
  const paths = layout === "linked" ? [linked, linked, linked] : [root, sub, linked];
  for (const [i, workspaceRoot] of paths.entries()) {
    await writeFile(join(flows, `run-${i}.json`), JSON.stringify({
      ...fixture, id: `run-${i}`, workspaceRoot, events: [event],
    }));
  }
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await learnCommand(["harvest", "--flows", flows, "--root", root, "--stage", "--json"])).toBe(0);
  expect(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join("")).staged).toBe(1);
  const rows = await readCandidates(join(root, ".stratum", "learn"));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.scope.workspaceRoot).toBe(root);
  expect(rows[0]!.recurrence.distinctRuns).toBe(3);
  await expect(readFile(join(linked, ".stratum", "learn", "candidates.jsonl"))).rejects.toThrow();
});

it("shares candidate destination and locking across main and linked worktrees", async () => {
  await repo();
  const linked = join(root, "linked");
  await exec("git", ["-C", root, "worktree", "add", "-b", "linked", linked]);
  const row = await candidate();
  expect((await Promise.all([appendCandidates(root, [row]), appendCandidates(linked, [row])])).sort()).toEqual([0, 1]);
  expect(await readCandidates(join(root, ".stratum", "learn"))).toEqual([row]);
  await expect(readFile(join(linked, ".stratum", "learn", "candidates.jsonl"))).rejects.toThrow();
});

it("releases workspace locks after errors", async () => {
  await expect(withWorkspaceLock(root, () => { throw new Error("test"); })).rejects.toThrow("test");
  expect(await withWorkspaceLock(root, () => 42)).toBe(42);
});

it("deduplicates concurrent candidate writers and duplicate rows within a batch", async () => {
  const row = await candidate();
  expect((await Promise.all([appendCandidates(root, [row, row]), appendCandidates(root, [row])])).sort()).toEqual([0, 1]);
  expect(await readCandidates(join(root, ".stratum", "learn"))).toEqual([row]);
});

it("deduplicates across native Node processes with complete JSON lines", async () => {
  const row = await candidate();
  const payload = join(root, "input.json");
  await writeFile(payload, JSON.stringify(row));
  const module = fileURLToPath(new URL("../../src/learn/candidate.ts", import.meta.url));
  const script = `import { readFile } from 'node:fs/promises'; import { appendCandidates } from ${JSON.stringify(module)}; const row = JSON.parse(await readFile(process.argv[1], 'utf8')); await appendCandidates(process.argv[2], [row, { ...row, revisionId: process.argv[3] }]);`;
  await Promise.all(["unique-a", "unique-b"].map((id) => exec(process.execPath,
    ["--import", loader, "--input-type=module", "-e", script, payload, root, id],
    { env: { ...process.env, STRATUM_GUARDS_DIR: join(root, "guards") } })));
  const raw = await readFile(join(root, ".stratum", "learn", "candidates.jsonl"), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  const rows = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.revisionId)).size).toBe(3);
}, 20_000);

it("terminates torn candidate and lifecycle tails before appending", async () => {
  const dir = join(root, ".stratum", "learn");
  await mkdir(dir, { recursive: true });
  const row = await candidate();
  await writeFile(join(dir, "candidates.jsonl"), '{"partial":');
  await appendCandidates(root, [row]);
  expect(await readCandidates(dir)).toEqual([row]);
  await writeFile(log, '{"partial":');
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const written = await appendLifecycle(root, { ...input("retire"), withdrawn: true });
  expect(await readLifecycle(root)).toEqual({ rows: [written], skipped: 1 });
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("skipped 1"));
  expect(await readFile(log, "utf8")).toBe('{"partial":\n' + JSON.stringify(written) + '\n');
});

it("folds states, since, fixRef and review watermarks", async () => {
  expect(await readLifecycle(root)).toEqual({ rows: [], skipped: 0 });
  expect((await lessonLifecycle(root, clusterId)).state).toBe("active");
  const retired = await appendLifecycle(root, { ...input("retire"), fixRef: "abc123" });
  let state = await lessonLifecycle(root, clusterId);
  expect(state).toMatchObject({ state: "retired", since: retired.at, fixRef: "abc123" });
  for (const kind of REVIEW_KINDS) expect(state.watermarks[kind]).toBe(retired.at);
  // A backdated ack must not regress the watermark: file order still folds `since`,
  // but a watermark keeps the latest `at` it has seen.
  const ack: LifecycleRow = { ...input("ack"), at: "2001-01-01T00:00:00.000Z", ackKinds: ["not-holding"] };
  await writeFile(log, [retired, ack].map((r) => JSON.stringify(r)).join("\n") + "\n");
  state = await lessonLifecycle(root, clusterId);
  expect(state.since).toBe(retired.at);
  for (const kind of REVIEW_KINDS) expect(state.watermarks[kind]).toBe(retired.at);
  const all = await appendLifecycle(root, input("ack"));
  for (const kind of REVIEW_KINDS) expect((await lessonLifecycle(root, clusterId)).watermarks[kind]).toBe(all.at);
  await appendLifecycle(root, input("reactivate"));
  expect(await lessonLifecycle(root, clusterId)).not.toHaveProperty("fixRef");
  const dismissed = await appendLifecycle(root, input("dismiss"));
  state = await lessonLifecycle(root, clusterId);
  expect(state).toMatchObject({ state: "dismissed", since: dismissed.at });
  for (const kind of REVIEW_KINDS) expect(state.watermarks[kind]).toBe(dismissed.at);
  await appendLifecycle(root, input("reactivate"));
  expect((await lessonLifecycle(root, clusterId)).state).toBe("active");
  expect((await lessonLifecycle(root, "b".repeat(64))).since).toBeUndefined();
});

it("an out-of-order earlier ack does not regress the review watermark", async () => {
  await mkdir(join(root, ".stratum", "learn"), { recursive: true });
  const later: LifecycleRow = { ...input("ack"), at: "2026-06-01T00:00:00.000Z" };
  const earlier: LifecycleRow = { ...input("ack"), at: "2026-01-01T00:00:00.000Z" };
  await writeFile(log, [later, earlier].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const state = await lessonLifecycle(root, clusterId);
  for (const kind of REVIEW_KINDS) expect(state.watermarks[kind]).toBe(later.at);
});

it("rejects illegal edges atomically, including concurrent retire/dismiss", async () => {
  await expect(appendLifecycle(root, input("reactivate"))).rejects.toThrow("from active");
  const results = await Promise.allSettled([
    appendLifecycle(root, { ...input("retire"), withdrawn: true }), appendLifecycle(root, input("dismiss")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  for (const kind of ["retire", "dismiss"] as const) {
    await expect(appendLifecycle(root, { ...input(kind), ...(kind === "retire" ? { withdrawn: true as const } : {}) })).rejects.toThrow("cannot");
  }
  expect((await readLifecycle(root)).rows).toHaveLength(1);
});

it.each([
  { clusterId: "A".repeat(64) }, { clusterId: "bad" }, { reason: "  " }, { kind: "unknown" },
  { kind: ["ack"] }, { kind: "retire" }, { kind: "retire", fixRef: "" }, { kind: "retire", withdrawn: false },
  { kind: "retire", fixRef: "sha", withdrawn: true }, { ackKinds: ["not-holding"] },
  { kind: "ack", ackKinds: ["unknown"] }, { kind: "ack", ackKinds: "not-holding" },
  { fixRef: "sha" },
])("rejects invalid lifecycle input %j", async (change) => {
  await expect(appendLifecycle(root, { ...input("dismiss"), ...change } as Omit<LifecycleRow, "at">)).rejects.toThrow();
  expect(await readLifecycle(root)).toEqual({ rows: [], skipped: 0 });
});

it("reports all invalid lines and throws on unreadable logs", async () => {
  await mkdir(join(root, ".stratum", "learn"), { recursive: true });
  const row = { ...input("ack"), at: new Date().toISOString() };
  await writeFile(log, ["broken", JSON.stringify({ ...row, at: "bad" }), JSON.stringify({ ...row, reason: "" }), JSON.stringify(row)].join("\n") + "\n");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await readLifecycle(root)).toEqual({ rows: [row], skipped: 3 });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped 3"));
  await rm(log);
  await mkdir(log);
  await expect(readLifecycle(root)).rejects.toThrow();
  await expect(lessonLifecycle(root, clusterId)).rejects.toThrow();
  await expect(appendLifecycle(root, input("dismiss"))).rejects.toThrow();
});

it("suppresses only retired/dismissed evidence at or before since", async () => {
  const { at } = await appendLifecycle(root, { ...input("retire"), withdrawn: true });
  const lifecycle = await lessonLifecycle(root, clusterId);
  const evidence = (times: string[]): FailureRecord[] => times.map((at) => ({
    at, runId: "run", flowName: "build", stepId: "step", attempt: 1, reason: "failure", shape: "schema", recovered: false,
  }));
  const older = evidence(["2000-01-01T00:00:00.000Z", at]);
  const newer = [...older, ...evidence(["2099-01-01T00:00:00.000Z"])];
  for (const state of ["retired", "dismissed"] as const) {
    expect(isSuppressed({ ...lifecycle, state }, older)).toBe(true);
    expect(isSuppressed({ ...lifecycle, state }, newer)).toBe(false);
    expect(hasEvidenceAfterRetirement({ ...lifecycle, state }, newer)).toBe(true);
    expect(hasEvidenceAfterRetirement({ ...lifecycle, state }, older)).toBe(false);
  }
  expect(isSuppressed({ ...lifecycle, state: "active" }, older)).toBe(false);
  expect(hasEvidenceAfterRetirement({ ...lifecycle, state: "active" }, newer)).toBe(false);
});

it("CLI retires a never-staged cluster from a ts-like cwd into the main root", async () => {
  await repo();
  const sub = join(root, "ts"); await mkdir(sub);
  const module = fileURLToPath(new URL("../../src/cli/learn.ts", import.meta.url));
  const script = `import { learnCommand } from ${JSON.stringify(module)}; process.exitCode = await learnCommand(['retire', '${clusterId}', '--reason', 'owner fixed', '--fix-ref', 'abc123']);`;
  const result = await exec(process.execPath, ["--import", loader, "--input-type=module", "-e", script],
    { cwd: sub, env: { ...process.env, STRATUM_GUARDS_DIR: join(root, "guards") } });
  expect(JSON.parse(result.stdout)).toMatchObject({ clusterId, kind: "retire", fixRef: "abc123" });
  expect((await readLifecycle(root)).rows).toHaveLength(1);
  await expect(readFile(join(sub, ".stratum", "learn", "lifecycle.jsonl"))).rejects.toThrow();
});

it("CLI supports all verbs and returns exit 2 for invalid arguments and edges", async () => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const call = (args: string[]) => learnCommand([...args, "--root", root]);
  expect(await call(["retire", clusterId, "--reason", "checked", "--withdrawn"])).toBe(0);
  expect(await call(["dismiss", clusterId, "--reason", "checked"])).toBe(2);
  expect(err).toHaveBeenCalledWith(expect.stringContaining("from retired"));
  expect(await call(["reactivate", clusterId, "--reason", "needed"])).toBe(0);
  expect(await call(["dismiss", clusterId, "--reason", "rejected"])).toBe(0);
  expect(await call(["ack", clusterId, "--reason", "seen", "--kind", "not-holding"])).toBe(0);
  expect(JSON.parse(String(out.mock.calls.at(-1)![0])).ackKinds).toEqual(["not-holding"]);
  for (const args of [
    ["ack", clusterId, "--reason"], ["ack", clusterId, "--reason", "seen", "--kind", "unknown"],
    ["retire", clusterId, "--reason", "fixed", "--fix-ref", "sha", "--withdrawn"],
    ["dismiss", clusterId, "--reason", "seen", "--fix-ref", "sha"],
  ]) expect(await call(args)).toBe(2);
});
