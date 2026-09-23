import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { distillCommand } from "../../src/cli/distill.js";
import * as candidates from "../../src/distill/candidate.js";
import * as apply from "../../src/distill/apply.js";
import { assetFixture } from "./apply-helpers.js";
import { scratch } from "./fixtures.js";

const HELP = `Usage:
  stratum distill extract [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill top [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--n <n>] [--json]
  stratum distill stats [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill list
  stratum distill apply <revision-id> [--root <dir>] [--trust-source]
  stratum distill revert <apply-id>
  stratum distill reconcile

Asset apply is disabled unless STRATUM_DISTILL_APPLY_ENABLED=1.
--trust-source is required for explicit-project and projects-root revisions.
Agent harnesses can deny Bash(stratum distill apply*) in Claude Code settings.
`;
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function run(args: string[]) {
  let stdout = "", stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  try { return { code: await distillCommand(args), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
it("documents exact grammar and operator gate in help", async () => {
  expect(await run(["--help"])).toEqual({ code: 0, stdout: HELP, stderr: "" });
});
const invalid: Array<[string[], string]> = [
  ...[["apply"], ["apply", "A"], ["apply", "a".repeat(65)], ["apply", "a", "b"], ["apply", ""]].map(args => [args, "expected one lowercase hexadecimal revision selector (1–64 characters)"] as [string[], string]),
  ...[["revert"], ["revert", "a"], ["revert", "A".repeat(32)], ["revert", "a".repeat(33)], ["revert", "a".repeat(32), "b"]].map(args => [args, "expected one 32-character lowercase hexadecimal apply id"] as [string[], string]),
  [["apply", "a", "--root"], "missing option value"], [["apply", "a", "--root", ""], "missing option value"],
  [["apply", "a", "--root", "--trust-source"], "missing option value"],
  [["apply", "a", "--root", ".", "--root", "."], "duplicate option"],
  [["apply", "a", "--trust-source", "--trust-source"], "duplicate option"],
  ...["--root=.", "--", "--json", "--unknown"].map(flag => [["apply", "a", flag], "unsupported option"] as [string[], string]),
  ...["list", "revert", "reconcile"].flatMap(action => ["--root", "--trust-source", "--json"].map(flag => [[action, flag], "unsupported option"] as [string[], string])),
  [["list", "a"], "unexpected positional argument"], [["reconcile", "a"], "unexpected positional argument"],
];
it.each(invalid)("rejects syntax %j before sidecar or adapter access", async (args, message) => {
  const spies = [vi.spyOn(candidates, "readCandidates"), vi.spyOn(apply, "applyAssetCandidate"), vi.spyOn(apply, "revertAssetApply"), vi.spyOn(apply, "reconcileAssetApplies")];
  expect(await run(args)).toEqual({ code: 2, stdout: "", stderr: `stratum distill: ${message}\n${HELP}` });
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
it("reports missing, non-directory and unreadable roots as operational errors", async () => {
  const root = await scratch(), file = join(root, "file"), denied = join(root, "denied");
  await writeFile(file, "x"); await mkdir(denied); await chmod(denied, 0);
  try {
    for (const path of [join(root, "missing"), file, denied]) {
      const result = await run(["apply", "a", "--root", path]);
      expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain("Usage:");
    }
  } finally { await chmod(denied, 0o700); }
});
it("preserves extraction duplicate and unknown option errors", async () => {
  for (const action of ["extract", "top", "stats"]) {
    expect(await run([action, "--json", "--json"])).toEqual({ code: 2, stdout: "", stderr: "stratum distill: duplicate option\n" });
    expect(await run([action, "--unknown"])).toEqual({ code: 2, stdout: "", stderr: "stratum distill: unsupported option\n" });
  }
});
async function staged() {
  const f = await assetFixture(); roots.push(f.root);
  await candidates.appendCandidates(f.root, [f.candidate]);
  vi.spyOn(process, "cwd").mockReturnValue(f.root);
  return f;
}
it("lists sorted modern and projected legacy rows without rewriting the sidecar", async () => {
  const { root, candidate } = await staged();
  const legacy = { schemaVersion: "distill-2.0", revisionId: "0".repeat(64), clusterId: "b".repeat(64), targetKind: "command", assetName: "old-draft" };
  const bytes = `${JSON.stringify(candidate)}\n${JSON.stringify(legacy)}\ninvalid\n{"schemaVersion":"future"}\n`;
  await writeFile(candidates.sidecarPath(root), bytes);
  const reader = vi.spyOn(candidates, "readCandidates");
  expect(await run(["list"])).toEqual({ code: 0, stdout: `000000000000  command  old-draft  legacy (distill-2.0; re-run extract)\n${candidate.revisionId.slice(0, 12)}  skill  ${candidate.assetName}  distill-2.1\n`, stderr: "" });
  expect(reader).toHaveBeenCalledExactlyOnceWith(root);
  expect(await readFile(candidates.sidecarPath(root), "utf8")).toBe(bytes);
});
it("lists no retained rows and surfaces sidecar read failures", async () => {
  const root = await scratch(); vi.spyOn(process, "cwd").mockReturnValue(root);
  expect(await run(["list"])).toEqual({ code: 0, stdout: "no staged candidates (run: stratum distill extract)\n", stderr: "" });
  await mkdir(join(root, ".stratum", "distill"), { recursive: true });
  await writeFile(candidates.sidecarPath(root), 'bad\n{"schemaVersion":"future"}\n');
  expect((await run(["list"])).code).toBe(0);
  await chmod(candidates.sidecarPath(root), 0);
  try { const result = await run(["list"]); expect(result.code).toBe(1); expect(result.stderr).toContain("EACCES"); }
  finally { await chmod(candidates.sidecarPath(root), 0o600); }
});
it("refuses missing, ambiguous modern/legacy and legacy-only selectors with exact output", async () => {
  const { root, candidate } = await staged();
  const adapter = vi.spyOn(apply, "applyAssetCandidate");
  const legacyId = candidate.revisionId.slice(0, 1) + "f".repeat(63);
  const legacy = { schemaVersion: "distill-2.0", revisionId: legacyId, clusterId: "b".repeat(64), targetKind: "skill", assetName: "old" };
  await writeFile(candidates.sidecarPath(root), [candidate, legacy].map(row => JSON.stringify(row)).join("\n") + "\n");
  const missing = candidate.revisionId[0] === "0" ? "1" : "0";
  expect(await run(["apply", missing])).toEqual({ code: 1, stdout: "", stderr: `no staged revision matching ${missing}\n` });
  expect(await run(["apply", candidate.revisionId[0]!])).toEqual({ code: 2, stdout: "", stderr: `ambiguous revision ${candidate.revisionId[0]} matches 2 candidates: ${[candidate.revisionId, legacyId].sort().map(id => id.slice(0, 12)).join(", ")}\n` });
  expect(await run(["apply", legacyId])).toEqual({ code: 1, stdout: "", stderr: `revision ${legacyId} is schema distill-2.0; not apply-eligible, re-run extract\n` });
  expect(adapter).not.toHaveBeenCalled();
});
it.each([false, true])("passes unique prefixes, canonical roots and trustSource=%s to S3 without enabling it", async trust => {
  const { root, candidate } = await staged(); const alias = join(await scratch(), "alias"); await symlink(root, alias);
  const result = { applyId: "a".repeat(32), targetPath: candidate.targetPath, ledgerRef: "receipt" };
  const adapter = vi.spyOn(apply, "applyAssetCandidate").mockResolvedValue(result);
  const reader = vi.spyOn(candidates, "readCandidates");
  const args = trust ? ["apply", "--root", alias, "--trust-source", candidate.revisionId.slice(0, 12)] : ["apply", candidate.revisionId, "--root", alias];
  expect(await run(args)).toEqual({ code: 0, stdout: `applied ${result.applyId} -> ${candidate.targetPath}\n`, stderr: "" });
  expect(adapter).toHaveBeenCalledExactlyOnceWith(candidate, { applyRoot: root, ...(trust ? { trustSource: true } : {}) });
  expect(reader).toHaveBeenCalledExactlyOnceWith(root);
});
it("leaves default OFF and source refusals to the real S3 wrapper", async () => {
  const { root, candidate } = await staged(); vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", ""); vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  expect(await run(["apply", candidate.revisionId, "--trust-source"])).toEqual({ code: 1, stdout: "", stderr: "distill apply is disabled; enable it explicitly (STRATUM_DISTILL_APPLY_ENABLED=1)\n" });
  vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
  expect(await run(["apply", candidate.revisionId])).toEqual({ code: 1, stdout: "", stderr: "source mode explicit-project requires --trust-source\n" });
  expect(await apply.readAssetJournal(root)).toEqual([]);
  await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("reverts by full id with constant descendants and no sidecar read", async () => {
  const root = await scratch(); vi.spyOn(process, "cwd").mockReturnValue(root);
  const reader = vi.spyOn(candidates, "readCandidates"), adapter = vi.spyOn(apply, "revertAssetApply").mockResolvedValue();
  const id = "b".repeat(32);
  expect(await run(["revert", id])).toEqual({ code: 0, stdout: `reverted ${id}\ndescendants: 0\n`, stderr: "" });
  expect(adapter).toHaveBeenCalledExactlyOnceWith(id, root, {}); expect(reader).not.toHaveBeenCalled();
});
it.each([0, 2])("prints all reconcile counters with diverged=%s", async diverged => {
  const root = await scratch(); vi.spyOn(process, "cwd").mockReturnValue(root);
  const reader = vi.spyOn(candidates, "readCandidates");
  const adapter = vi.spyOn(apply, "reconcileAssetApplies").mockResolvedValue({ completed: 1, rolledBack: 2, reverted: 3, diverged });
  expect(await run(["reconcile"])).toEqual({ code: diverged ? 1 : 0, stdout: `completed 1, rolled back 2, reverted 3, diverged ${diverged}\n`, stderr: "" });
  expect(adapter).toHaveBeenCalledExactlyOnceWith(root, {}); expect(reader).not.toHaveBeenCalled();
});
it("preserves bare operational errors from each mutation wrapper", async () => {
  const { candidate } = await staged();
  vi.spyOn(apply, "applyAssetCandidate").mockRejectedValue(new Error("apply refusal"));
  vi.spyOn(apply, "revertAssetApply").mockRejectedValue(new Error("revert refusal"));
  vi.spyOn(apply, "reconcileAssetApplies").mockRejectedValue(new Error("reconcile refusal"));
  for (const [action, id] of [["apply", candidate.revisionId], ["revert", "a".repeat(32)], ["reconcile"]]) {
    expect(await run(id ? [action!, id] : [action!])).toEqual({ code: 1, stdout: "", stderr: `${action} refusal\n` });
  }
});
