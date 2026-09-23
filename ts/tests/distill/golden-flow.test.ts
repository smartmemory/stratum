import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { distillCommand } from "../../src/cli/distill.js";
import { readCandidates, sidecarPath } from "../../src/distill/candidate.js";
import { readAssetJournal, type AssetJournalEntry } from "../../src/distill/apply.js";
import { digest } from "../../src/distill/harvest.js";
import { GUARDS_DIR, loadRegistry, readLedger, setGuardsDir } from "../../src/guard/store.js";
import { payloadDigestForVersion } from "../../src/guard/transition.js";
import { scratch } from "./fixtures.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setGuardsDir(GUARDS_DIR); });

// Capture only CLI I/O; the filesystem, identity, critics, locks and guard store are real.
async function run(args: string[]) {
  let stdout = "", stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => { stderr += String(chunk); return true; });
  try { return { args, code: await distillCommand(args), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}
function receipt(journal: AssetJournalEntry, reverted = false) {
  const resource = `distill-apply-${journal.applyId}`;
  const from = reverted ? "applied" : "applying", to = reverted ? "reverted" : "applied";
  const rows = readLedger(resource).filter(row => row.from_state === from && row.to_state === to);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.outcome).toBe("applied");
  // Ledger rows bind artifacts and modifiedFiles through their payload digest, not raw fields.
  const artifacts = reverted ? { reverted_to: journal.beforeDigest } : { after_digest: journal.afterDigest };
  const checksum = loadRegistry(resource)!.checksum;
  expect(row.payload_digest).toBe(payloadDigestForVersion(from, to, artifacts, [journal.targetPath], "agent", checksum, row.payload_digest_version));
  expect(row.payload_digest).not.toBe(payloadDigestForVersion(from, to, artifacts, [], "agent", checksum, row.payload_digest_version));
}
it("extracts, stages, lists, trusts, applies, reverts and reapplies a real draft with bound receipts; settled promotion reconciles silently", async () => {
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", ""); vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "");
  const root = await scratch(), project = join(root, "transcripts"), guardDir = join(root, ".stratum", "guard");
  await mkdir(project);
  for (const name of ["session-a.jsonl", "session-b.jsonl"]) {
    const bytes = await readFile(new URL(`../fixtures/distill/${name}`, import.meta.url), "utf8");
    await writeFile(join(project, name), bytes.replaceAll("__WORKSPACE_ROOT__", root));
  }
  await writeFile(join(root, "README.md"), "# Golden workspace\n");
  setGuardsDir(guardDir); vi.spyOn(process, "cwd").mockReturnValue(root);
  const help = await run(["--help"]);
  expect(help.code).toBe(0); expect(help.stderr).toBe("");
  const extract = await run(["extract", "--root", root, "--project", project, "--min-count", "2", "--window-days", "0"]);
  expect(extract.code).toBe(0); expect(extract.stderr).toBe(""); expect(extract.stdout).toContain('"applied": false');
  const stagedBytes = await readFile(sidecarPath(root), "utf8");
  const { candidates } = await readCandidates(root);
  const skills = candidates.filter(candidate => candidate.targetKind === "skill");
  expect(skills).toHaveLength(1);
  for (const candidate of candidates) await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readAssetJournal(root)).toEqual([]);
  const candidate = skills[0]!;
  expect(candidate.workflow).toEqual({ kind: "sequence", signature: JSON.stringify(["Read", "Edit"]), tools: ["Read", "Edit"] });
  expect(candidate.recurrence).toEqual({ records: 2, distinctSessions: 2 });
  expect(candidates).toHaveLength(3);
  expect(candidates.filter(row => row.targetKind === "command")).toHaveLength(2);
  const list = await run(["list"]);
  expect(list).toMatchObject({ code: 0, stderr: "", stdout: [...candidates].sort((a, b) => a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0)
    .map(row => `${row.revisionId.slice(0, 12)}  ${row.targetKind}  ${row.assetName}  distill-2.1\n`).join("") });
  vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
  const refused = await run(["apply", candidate.revisionId, "--root", root]);
  expect(refused).toMatchObject({ code: 1, stdout: "", stderr: "source mode explicit-project requires --trust-source\n" });
  await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readAssetJournal(root)).toEqual([]);
  await expect(readdir(join(root, ".stratum", "distill", "applies"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(guardDir)).rejects.toMatchObject({ code: "ENOENT" });
  const args = ["apply", candidate.revisionId, "--root", root, "--trust-source"];
  const applied = await run(args);
  expect(applied.code).toBe(0); expect(applied.stderr).toBe("");
  const id = /^applied ([0-9a-f]{32}) -> /.exec(applied.stdout)![1]!;
  expect(applied.stdout).toBe(`applied ${id} -> ${candidate.targetPath}\n`);
  expect(candidate.targetPath).toBe(join(root, ".claude", "skills", candidate.assetName, "SKILL.md"));
  expect(await readdir(join(root, ".claude"))).toEqual(["skills"]);
  expect(await readdir(join(root, ".claude", "skills"))).toEqual([candidate.assetName]);
  expect(await readdir(join(root, ".claude", "skills", candidate.assetName))).toEqual(["SKILL.md"]);
  expect(await readFile(candidate.targetPath)).toEqual(Buffer.from(candidate.rendered.content));
  expect(candidate.rendered.content).toContain("disable-model-invocation: true");
  expect(candidate.rendered.content).toContain("To promote this draft for automatic routing, remove `disable-model-invocation` only after supplying a trigger description.");
  const journal = JSON.parse(await readFile(join(root, ".stratum", "distill", "applies", `${id}.json`), "utf8")) as AssetJournalEntry;
  expect(journal).toMatchObject({ state: "applied", revisionId: candidate.revisionId, targetPath: candidate.targetPath,
    afterDigest: digest(candidate.rendered.content), existedBefore: false, lineage: { poolSnapshot: [] }, sourceMode: "explicit-project", sourceTrust: "operator-asserted" });
  expect(journal.ledgerRef).toBeTruthy();
  expect(journal.verdicts.map(v => [v.critic, v.passes])).toEqual(["structural-validity", "behavioral-harmlessness", "semantic-consistency", "subset-marginal-gain"].map(name => [name, true]));
  receipt(journal);
  const reverted = await run(["revert", id]);
  expect(reverted).toMatchObject({ code: 0, stderr: "", stdout: `reverted ${id}\ndescendants: 0\n` });
  await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readAssetJournal(root))[0]!.state).toBe("reverted"); receipt(journal, true);
  const reapplied = await run(args);
  expect(reapplied.code).toBe(0); expect(reapplied.stderr).toBe("");
  const newId = /^applied ([0-9a-f]{32}) -> /.exec(reapplied.stdout)![1]!;
  expect(newId).not.toBe(id); expect(reapplied.stdout).toBe(`applied ${newId} -> ${candidate.targetPath}\n`);
  const newJournal = (await readAssetJournal(root)).find(row => row.applyId === newId)!;
  expect(newJournal.state).toBe("applied"); receipt(newJournal);
  expect(await readFile(candidate.targetPath)).toEqual(Buffer.from(candidate.rendered.content));
  expect(await readFile(sidecarPath(root), "utf8")).toBe(stagedBytes);
  // Human promotion after a committed receipt is an ordinary edit, never divergence.
  const promoted = candidate.rendered.content.replace("disable-model-invocation: true\n", "");
  await writeFile(candidate.targetPath, promoted);
  const ledgerBefore = readLedger(`distill-apply-${newId}`).map(row => row.toDict());
  const reconcile = await run(["reconcile"]);
  expect(reconcile).toMatchObject({ code: 0, stderr: "", stdout: "completed 0, rolled back 0, reverted 0, diverged 0\n" });
  expect(await readFile(candidate.targetPath, "utf8")).toBe(promoted);
  expect((await readAssetJournal(root)).find(row => row.applyId === newId)).toEqual(newJournal);
  expect(readLedger(`distill-apply-${newId}`).map(row => row.toDict())).toEqual(ledgerBefore);
  expect(await readFile(join(root, "README.md"))).toEqual(Buffer.from("# Golden workspace\n"));
  console.info("CLI transcript", JSON.stringify([help, list, applied, reverted, reconcile], null, 2));
});
