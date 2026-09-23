import { chmod, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as candidates from "../../src/distill/candidate.js";
import { authorCandidate, targetPathFor, verifyCandidateIdentity, type AssetCandidate, type SourceMode } from "../../src/distill/candidate.js";
import { canonicalJson, workflowFromEvidence } from "../../src/distill/detector.js";
import { digest as sha } from "../../src/distill/harvest.js";
import { admitAsset, applyAssetCandidate, assertAssetAllowlisted, behavioralHarmlessness, buildAssetPool, readAssetJournal,
  reconcileAssetApplies, revertAssetApply, semanticConsistency, structuralValidity, subsetMarginalGain, ApplyRefused, type AssetPoolView } from "../../src/distill/apply.js";
import * as locks from "../../src/guard/lock.js";
import * as transitions from "../../src/guard/transition.js";
import { payloadDigestForVersion } from "../../src/guard/transition.js";
import { GUARDS_DIR, loadRegistry, readLedger, setGuardsDir } from "../../src/guard/store.js";
import { assetFixture, deepFreeze } from "./apply-helpers.js";

const cleanups: string[] = [];
beforeEach(() => { vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", ""); vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", ""); });
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setGuardsDir(GUARDS_DIR);
  await Promise.all(cleanups.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(mode: SourceMode = "explicit-project", kind: candidates.AssetKind = "skill", command?: string) {
  const f = await assetFixture(mode, kind, command); cleanups.push(f.root);
  if (mode === "workspace") cleanups.push(f.project);
  setGuardsDir(join(f.root, ".stratum", "guard")); return f;
}
const options = (root: string) => ({ applyRoot: root, enabled: true, trustSource: true });
async function put(path: string, bytes: string | Buffer) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function pool(root: string, target: string) { return (await buildAssetPool(root, target)).admissionInput as AssetPoolView; }

it("is default OFF even when STRATUM_LEARN_APPLY_ENABLED=1", async () => {
  const { root, candidate } = await fixture("workspace"); vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  await expect(applyAssetCandidate(candidate, { applyRoot: root })).rejects.toThrow("distill apply is disabled; enable it explicitly");
  await expect(revertAssetApply("absent", root, {})).rejects.toThrow("distill apply is disabled");
  await expect(reconcileAssetApplies(root, {})).rejects.toThrow("distill apply is disabled");
  expect(await readAssetJournal(root)).toEqual([]);
  await expect(readdir(join(root, ".claude"))).rejects.toThrow();
  await expect(readdir(join(root, ".stratum"))).rejects.toThrow();
});
it("uses STRATUM_DISTILL_APPLY_ENABLED independently of the learn flag", async () => {
  const { root, candidate } = await fixture("workspace"); vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
  await applyAssetCandidate(candidate, { applyRoot: root }); expect(await readFile(candidate.targetPath, "utf8")).toBe(candidate.rendered.content);
});
it.each(["inside", "outside"])("refuses a symlinked .claude directory pointing %s", async where => {
  const { root, candidate, project } = await fixture(); const dest = where === "inside" ? project : dirname(root);
  await symlink(dest, join(root, ".claude"));
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow(".claude must not be a symbolic link");
});
it("refuses a target outside .claude skills agents and commands", async () => {
  const { root, candidate } = await fixture();
  for (const path of ["docs/x.md", "ts/src/guard/x.md", ".claude/commands/nested/x.md", ".claude/skills/x/OTHER.md", ".claude/agents/Bad.md", ".claude/commands/x.txt"]) {
    await expect(assertAssetAllowlisted(root, join(root, path))).rejects.toThrow("outside the asset allowlist");
  }
  const malformed = { ...candidate, targetPath: join(root, "docs/x.md") };
  const real = candidates.verifyCandidateIdentity;
  vi.spyOn(candidates, "verifyCandidateIdentity").mockImplementation((value): value is AssetCandidate => value === malformed || real(value));
  await expect(applyAssetCandidate(malformed, options(root))).rejects.toThrow("outside the asset allowlist");
});
it.each(["skills", "agents", "commands"])("refuses a symlinked %s pool directory", async dir => {
  const { root, candidate, project } = await fixture(); await mkdir(join(root, ".claude")); await symlink(project, join(root, ".claude", dir));
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("symbolic link");
});
it("never overwrites an existing asset", async () => {
  const { root, candidate } = await fixture(); await put(candidate.targetPath, "sentinel\r\n");
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("create-only");
  expect(await readFile(candidate.targetPath, "utf8")).toBe("sentinel\r\n"); expect(await readAssetJournal(root)).toEqual([]);
});
it("accepts a missing asset directory as an empty deterministic pool", async () => {
  const { root, candidate } = await fixture(); const p = await pool(root, candidate.targetPath);
  expect(p.poolDigest).toBe(sha("[]")); expect(p.entries.size).toBe(0); expect(p.target).toEqual({ content: "", existed: false });
});

describe("structural-validity", () => {
  const cases: Array<[string, (c: AssetCandidate) => void, string]> = [
    ["refuses missing frontmatter", c => { c.rendered.content = "plain"; }, "rendered content has no YAML frontmatter"],
    ["refuses unparseable frontmatter", c => { c.rendered.content = '---\ndescription: broken\n---'; }, "rendered frontmatter is not parseable"],
    ["refuses an empty description", c => { c.rendered.content = c.rendered.content.replace(/description: .*/, 'description: " "'); }, "frontmatter description is empty"],
    ["enforces the D3 non-routing marker", c => { c.rendered.content = c.rendered.content.replace('disable-model-invocation: true', 'disable-model-invocation: false'); }, "frontmatter must set disable-model-invocation: true"],
    ["refuses subagent with the fixed finding", c => { c.targetKind = "subagent"; }, "subagent drafts have no non-delegation marker; not apply-eligible in v1"],
    ["refuses rendered content over 16 KB", c => { c.rendered.content += "界".repeat(5500); }, "rendered content exceeds 16 KB"],
    ["refuses non-create insertion", c => { Object.assign(c.rendered.insertion, { mode: "append" }); }, "asset insertion mode must be create"],
    ["refuses schemas other than distill-2.1", c => { Object.assign(c, { schemaVersion: "distill-2.0" }); }, "asset schema must be distill-2.1"],
    ["requires skill name to equal assetName", c => { c.rendered.content = c.rendered.content.replace(/name: .*/, 'name: "wrong"'); }, "skill frontmatter name must equal assetName"],
    ["requires skill name to equal parent directory", c => { c.targetPath = join(dirname(dirname(c.targetPath)), "wrong", "SKILL.md"); }, "skill assetName must equal target parent directory"],
    ["requires command frontmatter to omit name", c => { c.targetKind = "command"; }, "command frontmatter must omit name"],
    ["requires command filename to equal assetName", c => { c.targetKind = "command"; c.targetPath = join(dirname(c.targetPath), "wrong.md"); }, "command filename must equal assetName"],
  ];
  it.each(cases)("%s", async (_name, mutate, finding) => {
    const { candidate } = await fixture(); mutate(candidate); expect(structuralValidity(candidate).findings).toContain(finding);
  });
  it.each(['name: "a"\nname: "b"', 'description: |\n  multiline', 'description: {}', 'description: "bad', '', 'disable-model-invocation: yes'])("refuses malformed flat frontmatter %j", async body => {
    const { candidate } = await fixture(); candidate.rendered.content = `---\n${body}\n---`;
    expect(structuralValidity(candidate).findings).toContain("rendered frontmatter is not parseable");
  });
  it("accepts exactly 16384 UTF-8 bytes and valid command frontmatter", async () => {
    const { candidate } = await fixture("explicit-project", "command");
    candidate.rendered.content += "x".repeat(16384 - Buffer.byteLength(candidate.rendered.content));
    expect(structuralValidity(candidate).passes).toBe(true); candidate.rendered.content += "x";
    expect(structuralValidity(candidate).findings).toContain("rendered content exceeds 16 KB");
  });
});
it("behavioral-harmlessness reports the existing hazard finding unchanged", async () => {
  const { root, candidate } = await fixture("explicit-project", "skill", "git reset --hard");
  expect(verifyCandidateIdentity(candidate)).toBe(true);
  expect(behavioralHarmlessness(candidate).findings).toEqual(["discards committed work (git reset --hard)"]);
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("behavioral-harmlessness");
});
it("semantic-consistency accepts an unchanged full re-harvest even after 30 days", async () => {
  const { candidate, project } = await fixture();
  for (const file of await readdir(project)) await utimes(join(project, file), new Date(0), new Date(0));
  expect((await semanticConsistency(candidate)).passes).toBe(true);
});
it.each(["edited", "deleted", "moved"])("semantic-consistency fails closed when a cited transcript is %s", async change => {
  const { root, candidate, project } = await fixture(); const path = join(project, "one.jsonl");
  const bytes = await readFile(path, "utf8");
  if (change === "deleted") await rm(path); else await writeFile(path, change === "edited" ? bytes.replace("git status", "git diff") : "{}\n" + bytes);
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("semantic-consistency"); expect(await readAssetJournal(root)).toEqual([]);
});
it.each(["canonicalInput", "cwd", "toolName", "toolUseId"] as const)("semantic-consistency fails closed when only %s is changed in a rehashed row", async field => {
  const { root, candidate } = await fixture(); const evidence = structuredClone(candidate.evidence);
  for (const o of evidence) { for (const s of o.steps) s[field] = field === "toolName" ? "Read" : "forged"; if (field === "cwd") o.cwd = "forged"; }
  const forged = authorCandidate(workflowFromEvidence(evidence), "skill", { workspaceRoot: root, sourceMode: "explicit-project" });
  expect(forged.evidence.map(o => o.id)).toEqual(candidate.evidence.map(o => o.id)); expect(verifyCandidateIdentity(forged)).toBe(true);
  await expect(applyAssetCandidate(forged, options(root))).rejects.toThrow("normalized step does not match transcript");
});
it("semantic-consistency checks occurrence cwd, complete view, recurrence and source handles", async () => {
  const { candidate } = await fixture();
  for (const mutate of [
    (c: AssetCandidate) => { c.evidence[0]!.cwd = "forged"; },
    (c: AssetCandidate) => { c.sourceHandle.lineNo++; },
    (c: AssetCandidate) => { c.recurrence.records++; },
    (c: AssetCandidate) => { c.recurrence.distinctSessions++; },
    (c: AssetCandidate) => { c.scope.transcriptProjectDir += "/other"; },
    (c: AssetCandidate) => { c.evidence[0]!.steps.push(c.evidence[0]!.steps[0]!); },
    (c: AssetCandidate) => { c.evidence[0]!.steps[0]!.blockIndex++; },
    (c: AssetCandidate) => { c.evidence = []; },
  ]) { const changed = structuredClone(candidate); mutate(changed); expect((await semanticConsistency(changed)).passes).toBe(false); }
});
it("runs all four critics without short-circuiting", async () => {
  const { root, candidate } = await fixture(); candidate.rendered.content = "git reset --hard"; candidate.evidence = [];
  const admission = await admitAsset(candidate, await pool(root, candidate.targetPath));
  expect(admission.verdicts.map(v => v.critic)).toEqual(["structural-validity", "behavioral-harmlessness", "semantic-consistency", "subset-marginal-gain"]);
  expect(admission.verdicts.map(v => v.passes)).toEqual([false, false, false, true]);
});
it.each(["skill", "subagent", "command"] as const)("subset-marginal-gain refuses a name collision in %s", async kind => {
  const { root, candidate } = await fixture(); await put(targetPathFor(root, kind, candidate.assetName), "existing");
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("pool already contains asset name");
});
it("subset-marginal-gain reports every path for a duplicated name and retains every digest", async () => {
  const { root, candidate } = await fixture(); const paths = (["command", "skill", "subagent"] as const).map(k => targetPathFor(root, k, candidate.assetName));
  for (const [i, path] of paths.entries()) await put(path, i === 1 ? candidate.rendered.content : `bytes-${i}`);
  const p = await pool(root, candidate.targetPath);
  expect(p.entries.size).toBe(3); expect(p.byName.get(candidate.assetName)).toEqual(paths.sort());
  const findings = subsetMarginalGain(candidate, p).findings;
  expect(findings[0]).toBe(`pool already contains asset name ${JSON.stringify(candidate.assetName)} at ${paths.join(", ")}`);
  expect(findings[1]).toContain("identical content");
  const records = [...p.entries].map(([path, entry]) => ({ path, ...entry }));
  expect(p.poolDigest).toBe(sha(canonicalJson(records)));
  for (const path of paths) { const bytes = await readFile(path); await rm(path); await put(path, bytes); }
  expect((await pool(root, candidate.targetPath)).poolDigest).toBe(p.poolDigest);
});
it("subset-marginal-gain refuses an identical digest under a different name", async () => {
  const { root, candidate } = await fixture(); await put(targetPathFor(root, "command", "different"), candidate.rendered.content);
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("identical content");
});
it("subset-marginal-gain refuses an existing empty target", async () => {
  const { root, candidate } = await fixture(); await put(candidate.targetPath, "");
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("create-only"); expect(await readFile(candidate.targetPath, "utf8")).toBe("");
});
it.each(["symlink", "directory", "unreadable"])("fails closed on a %s discoverable pool entry", async shape => {
  const { root, candidate, project } = await fixture(); const path = targetPathFor(root, "command", "other");
  await mkdir(dirname(path), { recursive: true });
  if (shape === "symlink") await symlink(join(project, "absent"), path);
  else if (shape === "directory") await mkdir(path);
  else { await writeFile(path, "unreadable"); await chmod(path, 0); }
  try { await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow(); expect(await readAssetJournal(root)).toEqual([]); }
  finally { if (shape === "unreadable") await chmod(path, 0o600); }
});
it("fails closed on non-ENOENT target reads and invalid UTF-8", async () => {
  const { root, candidate } = await fixture(); await mkdir(candidate.targetPath, { recursive: true });
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow(); await rm(candidate.targetPath, { recursive: true });
  await put(candidate.targetPath, Buffer.from([0xff])); await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow();
});

it.each(["explicit-project", "projects-root"] as const)("refuses %s source without trustSource", async mode => {
  const { root, candidate } = await fixture(mode);
  await expect(applyAssetCandidate(candidate, { applyRoot: root, enabled: true })).rejects.toThrow(`source mode ${mode} requires --trust-source`);
  await expect(readdir(join(root, ".stratum"))).rejects.toThrow();
});
it("refuses a workspace sourceMode that does not match the derived transcript directory", async () => {
  const { root, workflow } = await fixture(); const candidate = authorCandidate(workflow, "skill", { workspaceRoot: root, sourceMode: "workspace" });
  expect(verifyCandidateIdentity(candidate)).toBe(true);
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("workspace source mode does not match");
});
it("refuses when candidate scope.workspaceRoot differs from applyRoot", async () => {
  const { root, candidate } = await fixture(); await expect(applyAssetCandidate(candidate, options(dirname(root)))).rejects.toThrow("candidate workspace root does not match apply root");
});
it("pins the real identity verifier and refuses edited staged bytes", async () => {
  const { root, candidate } = await fixture(); expect(verifyCandidateIdentity(candidate)).toBe(true); candidate.rendered.content += "edited";
  expect(verifyCandidateIdentity(candidate)).toBe(false); await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("candidate identity does not match");
});
it("refuses an identity-valid subagent with the named finding", async () => {
  const { root, candidate } = await fixture("explicit-project", "subagent");
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("subagent drafts have no non-delegation marker; not apply-eligible in v1");
});
it.each(["workspace", "explicit-project", "projects-root"] as const)("writes exact bytes, empty lineage, full guard and provenance receipts for %s", async mode => {
  const { root, candidate } = await fixture(mode); const register = vi.spyOn(transitions, "registerGuard");
  const result = await applyAssetCandidate(candidate, options(root)); const entry = (await readAssetJournal(root))[0]!;
  expect(await readFile(candidate.targetPath)).toEqual(Buffer.from(candidate.rendered.content)); expect(result.targetPath).toBe(candidate.targetPath);
  expect(entry.lineage).toEqual({ poolSnapshot: [], authoringInputsDigest: candidate.authoringInputsDigest, poolDigestAtAdmission: sha("[]") });
  expect(entry.sourceMode).toBe(mode); expect(entry.sourceTrust).toBe(mode === "workspace" ? undefined : "operator-asserted");
  const resource = `distill-apply-${result.applyId}`, registry = loadRegistry(resource)!;
  expect(register).toHaveBeenCalledWith(resource, { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] }, {}, "staged", ["aborted", "reverted"], {}, null, undefined);
  const prepared = { ...entry, state: "prepared" }; delete prepared.ledgerRef;
  const artifacts = { journal_digest: sha(JSON.stringify(prepared)), revision_id: candidate.revisionId,
    evidence_ids: sha(canonicalJson(candidate.evidence.map(o => o.id))), verdicts: sha(canonicalJson(entry.verdicts)), pool_digest: sha("[]"),
    pool_snapshot: sha("[]"), authoring_inputs_digest: candidate.authoringInputsDigest, pool_digest_at_admission: sha("[]"), source_mode: mode,
    ...(mode === "workspace" ? {} : { source_trust: "operator-asserted" }) };
  const ledger = readLedger(resource);
  expect(ledger[0]!.payload_digest).toBe(payloadDigestForVersion("staged", "applying", artifacts, [], "agent", registry.checksum, 2));
  expect(ledger[1]!.payload_digest).toBe(payloadDigestForVersion("applying", "applied", { after_digest: entry.afterDigest }, [candidate.targetPath], "agent", registry.checksum, 2));
});
it("acquires pool outside target and releases in reverse for apply, revert and reconcile", async () => {
  const { root, candidate } = await fixture(); const events: string[] = [], real = locks.resourceLock;
  vi.spyOn(locks, "resourceLock").mockImplementation((resource, action, opts) => real(resource, async handle => {
    events.push(`enter:${resource}`); try { return await action(handle); } finally { events.push(`exit:${resource}`); }
  }, opts));
  const expected = [`enter:distill-pool-${sha(root)}`, `enter:distill-target-${sha(candidate.targetPath)}`, `exit:distill-target-${sha(candidate.targetPath)}`, `exit:distill-pool-${sha(root)}`];
  const result = await applyAssetCandidate(candidate, options(root)); expect(events).toEqual(expected); events.length = 0;
  await reconcileAssetApplies(root, { enabled: true }); expect(events).toEqual(expected); events.length = 0;
  await revertAssetApply(result.applyId, root, { enabled: true }); expect(events).toEqual(expected);
  await expect(readFile(candidate.targetPath)).rejects.toThrow(); expect((await readAssetJournal(root))[0]!.state).toBe("reverted");
  expect(readLedger(`distill-apply-${result.applyId}`).at(-1)!.toDict().to_state).toBe("reverted");
  const again = await applyAssetCandidate(candidate, options(root)); expect(again.applyId).not.toBe(result.applyId);
});
it("revert refuses out-of-band edits", async () => {
  const { root, candidate } = await fixture(); const result = await applyAssetCandidate(candidate, options(root)); await writeFile(candidate.targetPath, "edited");
  await expect(revertAssetApply(result.applyId, root, { enabled: true })).rejects.toThrow("target has changed"); expect(await readFile(candidate.targetPath, "utf8")).toBe("edited");
});
it("two concurrent applies of same-named candidates to different kinds allow exactly one commit", async () => {
  const { root, candidate, workflow } = await fixture(); const skill = deepFreeze(candidate);
  const command = authorCandidate(workflow, "command", { workspaceRoot: root, sourceMode: "explicit-project" });
  command.assetName = skill.assetName; command.targetPath = targetPathFor(root, "command", skill.assetName); deepFreeze(command);
  const real = candidates.verifyCandidateIdentity;
  vi.spyOn(candidates, "verifyCandidateIdentity").mockImplementation((value): value is AssetCandidate => value === skill || value === command || real(value));
  const results = await Promise.allSettled([applyAssetCandidate(skill, options(root)), applyAssetCandidate(command, options(root))]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect(failure.reason).toBeInstanceOf(ApplyRefused); expect(failure.reason.message).toContain("pool already contains asset name");
  expect((await Promise.allSettled([readFile(skill.targetPath), readFile(command.targetPath)])).filter(r => r.status === "fulfilled")).toHaveLength(1);
  const journals = await readAssetJournal(root); expect(journals).toHaveLength(1); expect(journals[0]!.state).toBe("applied");
  const resources = await readdir(join(root, ".stratum", "guard"));
  const registered = await Promise.all(resources.map(async dir => {
    try { return JSON.parse(await readFile(join(root, ".stratum", "guard", dir, "registry.json"), "utf8")).resource_id as string; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }));
  expect(registered.filter(r => r.startsWith("distill-apply-"))).toHaveLength(1);
  expect(readLedger(`distill-apply-${journals[0]!.applyId}`).filter(r => r.toDict().to_state === "applied")).toHaveLength(1);
});
it("semantic-consistency refuses extra re-resolved locators between cited steps", async () => {
  const { root, project } = await fixture();
  for (const session of ["one", "two"]) await writeFile(join(project, `${session}.jsonl`), JSON.stringify({ type: "assistant", cwd: root,
    message: { content: ["Read", "Bash", "Write"].map((name, i) => ({ type: "tool_use", id: `${session}-${i}`, name, input: { path: "README.md" } })) } }) + "\n");
  const { loadSessions } = await import("../../src/distill/harvest.js");
  const { detect, occurrenceId } = await import("../../src/distill/detector.js");
  const sequence = detect((await loadSessions(project, { windowDays: 0 })).sessions).find(w => w.evidence[0]!.steps.length === 3)!;
  const evidence = sequence.evidence.map(o => { const changed = { ...o, steps: [o.steps[0]!, o.steps[2]!] }; return { ...changed, id: occurrenceId(changed) }; });
  const forged = authorCandidate(workflowFromEvidence(evidence), "skill", { workspaceRoot: root, sourceMode: "explicit-project" });
  expect(verifyCandidateIdentity(forged)).toBe(true);
  await expect(applyAssetCandidate(forged, options(root))).rejects.toThrow("cited line or block moved");
});
it("fails closed on non-ENOENT target reads during the final CAS", async () => {
  const { root, candidate } = await fixture(); const real = transitions.guardTransition;
  vi.spyOn(transitions, "guardTransition").mockImplementation(async (...args) => {
    const result = await real(...args);
    if (args[2] === "applying") await mkdir(candidate.targetPath, { recursive: true });
    return result;
  });
  await expect(applyAssetCandidate(candidate, options(root))).rejects.toThrow("invalid asset target");
  expect((await readAssetJournal(root))[0]!.state).toBe("applying");
  expect(readLedger(`distill-apply-${(await readAssetJournal(root))[0]!.applyId}`).some(row => row.toDict().to_state === "applied")).toBe(false);
  expect((await reconcileAssetApplies(root, { enabled: true })).diverged).toBe(1);
});
it("revert never scans the live pool for descendants", async () => {
  const { root, candidate } = await fixture(); const result = await applyAssetCandidate(candidate, options(root));
  const unrelated = targetPathFor(root, "command", "unreadable"); await put(unrelated, "unrelated"); await chmod(unrelated, 0);
  try { await revertAssetApply(result.applyId, root, { enabled: true }); }
  finally { await chmod(unrelated, 0o600); }
  await expect(readFile(candidate.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(unrelated, "utf8")).toBe("unrelated");
});
it("pool hashes raw bytes and ignores unrelated files", async () => {
  const { root, candidate } = await fixture(); const raw = Buffer.from([0xff, 13, 10]);
  const path = targetPathFor(root, "command", "raw"); await put(path, raw);
  await put(join(root, ".claude", "commands", "ignored.txt"), "unrelated");
  await put(join(root, ".claude", "skills", "ignored.txt"), "unrelated");
  const p = await pool(root, candidate.targetPath); expect(p.entries.size).toBe(1); expect(p.entries.get(path)!.contentDigest).toBe(sha(raw));
});
