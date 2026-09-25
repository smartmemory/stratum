import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, copyFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GUARDS_DIR, computeEntryDigest, resourceDir, setGuardsDir } from "../../src/guard/store.js";
import { canonicalJson } from "../../src/guard/canonical.js";
import { harvest } from "../../src/learn/harvest.js";
import { classify } from "../../src/learn/classify.js";
import { appendCandidates, authorCandidate, computeRevisionId, sidecarPath, type PatchCandidate } from "../../src/learn/candidate.js";
import { applyCandidate, journalDir, journalPath, ledgerReceipt, readJournal, reconcile, revertApply, type JournalEntry } from "../../src/learn/apply.js";
import { appendLifecycle } from "../../src/learn/lifecycle.js";
import { activeLessons } from "../../src/learn/select.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "learn", "flows");
const temporaries: string[] = [];
const ON = { enabled: true };
afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  vi.restoreAllMocks();
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "learn-select-"));
  temporaries.push(root);
  setGuardsDir(join(root, "guards"));
  return root;
}
async function candidateIn(root: string, code = "invalid_enum_value", noteOnly = false): Promise<PatchCandidate> {
  const { records } = await harvest(FIXTURES);
  const cluster = classify(records.map((r) => ({ ...r, workspaceRoot: root })), { minRuns: 1, minPairs: 1 })
    .find((c) => c.class === "durable" && c.applyEligible && c.contract.code === code)!;
  expect(cluster).toBeDefined();
  return authorCandidate(noteOnly ? { ...cluster, contract: { ...cluster.contract, code: "unrecognized_keys" } } : cluster);
}
async function apply(root: string, candidate?: PatchCandidate) {
  candidate ??= await candidateIn(root);
  await appendCandidates(root, [candidate]);
  const result = await applyCandidate(candidate, ON);
  return { candidate, applyId: result.applyId };
}
async function editJournal(root: string, applyId: string, patch: Partial<JournalEntry>) {
  const path = journalPath(root, applyId);
  const entry = JSON.parse(await readFile(path, "utf8")) as JournalEntry;
  await writeFile(path, JSON.stringify({ ...entry, ...patch }));
}
const sidecar = (root: string) => sidecarPath(join(root, ".stratum", "learn"));

describe("activeLessons", () => {
  it("selects an applied lesson with its candidate, apply id and journal timestamp", async () => {
    const root = await workspace();
    const { candidate, applyId } = await apply(root);
    const entry = (await readJournal(root))[0]!;
    expect(await activeLessons(root)).toEqual({ lessons: [{ candidate, applyId, appliedAt: entry.at }], diagnostics: [] });
  });

  it("C1 excludes a reverted apply", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    await revertApply(applyId, root, ON);
    expect((await activeLessons(root)).lessons).toEqual([]);
  });

  it("C1 ignores a journal claiming applied without a ledger commit", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    const entry = (await readJournal(root))[0]!;
    await rm(journalPath(root, applyId));
    await writeFile(journalPath(root, "uncommitted"), JSON.stringify({ ...entry, applyId: "uncommitted", state: "applied" }));
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "receipt-not-applied" }] });
  });

  it("C1 selects a crash-recovered ledger commit even before reconcile finishes the journal", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    for (const state of ["applying", "prepared"] as const) {
      await editJournal(root, applyId, { state });
      expect((await activeLessons(root)).lessons.map((l) => l.applyId)).toEqual([applyId]);
    }
    await reconcile(root, ON);
    expect((await activeLessons(root)).lessons.map((l) => l.applyId)).toEqual([applyId]);
  });

  it("C2 rejects an edited snapshot with a mismatching digest", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    await editJournal(root, applyId, { after: "edited" });
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "snapshot-digest-mismatch", applyId }] });
  });

  it("C2 requires the valid sidecar content to occur in the apply snapshot", async () => {
    const root = await workspace();
    const { candidate, applyId } = await apply(root);
    const other = { ...candidate, rendered: { ...candidate.rendered, content: "different approved bytes" } };
    other.revisionId = computeRevisionId(other);
    await appendCandidates(root, [other]);
    // D0: simulate accidental journal revision drift; the receipt binds the snapshot digest.
    await editJournal(root, applyId, { revisionId: other.revisionId });
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "snapshot-content-missing" }] });
  });

  it("C2 keeps both stacked lessons despite later changes to NOTES.md", async () => {
    const root = await workspace();
    const a = await apply(root);
    const b = await apply(root, await candidateIn(root, "invalid_type"));
    await editJournal(root, a.applyId, { at: "2026-01-02T00:00:00.000Z" });
    await editJournal(root, b.applyId, { at: "2026-01-01T00:00:00.000Z" });
    expect((await activeLessons(root)).lessons.map((l) => l.applyId)).toEqual([b.applyId, a.applyId]);
    expect(new Set((await activeLessons(root)).lessons.map((l) => l.applyId))).toEqual(new Set([a.applyId, b.applyId]));
    await writeFile(a.candidate.targetPath, "unrelated current contents");
    expect((await activeLessons(root)).lessons).toHaveLength(2);
  });

  it("C3 excludes a missing sidecar row", async () => {
    const root = await workspace();
    await apply(root);
    await rm(sidecar(root));
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "candidate-missing" }] });
  });

  it("C3 rejects sidecar identity drift with a diagnostic", async () => {
    const root = await workspace();
    const { candidate } = await apply(root);
    candidate.scope.stepIds = ["edited"];
    await writeFile(sidecar(root), JSON.stringify(candidate) + "\n");
    const result = await activeLessons(root);
    expect(result.lessons).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ reason: "candidate-identity-invalid", revisionId: candidate.revisionId }));
  });

  it("C3 requires the journal and verified sidecar cluster ids to agree", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    await editJournal(root, applyId, { clusterId: "0".repeat(64) });
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "candidate-cluster-mismatch" }] });
  });

  it("C4 excludes an applied note-only lesson", async () => {
    const root = await workspace();
    const candidate = await candidateIn(root, "invalid_enum_value", true);
    expect(candidate.rendered.guidance).toBeUndefined();
    await apply(root, candidate);
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "guidance-missing" }] });
  });

  it("C5 excludes retired clusters", async () => {
    const root = await workspace();
    const { candidate } = await apply(root);
    await appendLifecycle(root, { clusterId: candidate.clusterId, kind: "retire", reason: "fixed", withdrawn: true });
    expect((await activeLessons(root)).lessons).toEqual([]);
  });

  it("C4 excludes empty guidance even when its identity was approved", async () => {
    const root = await workspace();
    const candidate = await candidateIn(root);
    candidate.rendered.guidance = "";
    candidate.revisionId = computeRevisionId(candidate);
    await apply(root, candidate);
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "guidance-missing" }] });
  });

  it("C5 excludes dismissed clusters", async () => {
    const root = await workspace();
    const { candidate } = await apply(root);
    await appendLifecycle(root, { clusterId: candidate.clusterId, kind: "dismiss", reason: "unneeded" });
    expect((await activeLessons(root)).lessons).toEqual([]);
  });

  it("C5 restores a reactivated cluster", async () => {
    const root = await workspace();
    const { candidate, applyId } = await apply(root);
    await appendLifecycle(root, { clusterId: candidate.clusterId, kind: "retire", reason: "fixed", withdrawn: true });
    await appendLifecycle(root, { clusterId: candidate.clusterId, kind: "reactivate", reason: "needed" });
    expect((await activeLessons(root)).lessons.map((l) => l.applyId)).toEqual([applyId]);
  });

  it("C5 fails closed with a diagnostic when lifecycle.jsonl is a directory", async () => {
    const root = await workspace();
    await apply(root);
    await mkdir(join(root, ".stratum", "learn", "lifecycle.jsonl"));
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "lifecycle-unreadable" }] });
  });

  it("reports corrupt journal files and still selects healthy lessons", async () => {
    const root = await workspace();
    await apply(root);
    await writeFile(join(journalDir(root), "bad.json"), "{");
    const result = await activeLessons(root);
    expect(result.lessons).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ reason: "journal-invalid", detail: expect.stringContaining("bad.json") }]);
  });

  it("reports torn sidecar lines and still selects healthy lessons", async () => {
    const root = await workspace();
    await apply(root);
    await appendFile(sidecar(root), "{");
    const result = await activeLessons(root);
    expect(result.lessons).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ reason: "sidecar-invalid", detail: expect.stringContaining("candidates.jsonl:2") }]);
  });

  it("reports malformed JSON values without throwing or hiding valid rows", async () => {
    const root = await workspace();
    await apply(root);
    await writeFile(join(journalDir(root), "null.json"), "null");
    await appendFile(sidecar(root), 'null\n{"revisionId":"broken"}\n');
    const result = await activeLessons(root);
    expect(result.lessons).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.reason)).toEqual([
      "journal-invalid", "sidecar-invalid", "candidate-identity-invalid",
    ]);
  });

  it("returns no lessons or diagnostics when .stratum does not exist", async () => {
    const root = await workspace();
    expect(await activeLessons(root)).toEqual({ lessons: [], diagnostics: [] });
    expect(await readdir(root)).toEqual([]);
  });

  it("canonicalizes a git subdirectory to the repository root", async () => {
    const root = await workspace();
    execFileSync("git", ["init", "--quiet", root]);
    const subdir = join(root, "nested");
    await mkdir(subdir);
    await apply(root);
    expect(await activeLessons(subdir)).toEqual(await activeLessons(root));
    expect((await activeLessons(subdir)).lessons).toHaveLength(1);
  });

  it("reports unreadable journal and sidecar inputs rather than treating them as absent", async () => {
    const root = await workspace();
    await apply(root);
    await rm(journalDir(root), { recursive: true });
    await writeFile(journalDir(root), "not a directory");
    await rm(sidecar(root));
    await mkdir(sidecar(root));
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [
      { reason: "journal-unreadable" }, { reason: "sidecar-unreadable" },
    ] });
  });

  it("reports an unreadable ledger and excludes its revision", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    await appendFile(join(resourceDir("learn-apply-" + applyId), "ledger.jsonl"), "{\n");
    expect(await activeLessons(root)).toMatchObject({ lessons: [], diagnostics: [{ reason: "receipt-unreadable" }] });
  });

  it("reports a thrown receipt error and still selects a healthy lesson", async () => {
    const root = await workspace();
    const a = await apply(root);
    const b = await apply(root, await candidateIn(root, "invalid_type"));
    expect(a.candidate.clusterId).not.toBe(b.candidate.clusterId);
    const entries = (await readJournal(root)).sort((a, b) => a.applyId.localeCompare(b.applyId));
    const [broken, healthy] = entries;
    const registryPath = join(resourceDir("learn-apply-" + broken!.applyId), "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    await writeFile(registryPath, JSON.stringify({ ...registry, checksum: 1.5 }));
    const error = new TypeError("canonicalJson only accepts safe integer numbers");
    expect(() => ledgerReceipt(broken!)).toThrow(error);
    const result = await activeLessons(root);
    expect(result.lessons.map((lesson) => lesson.applyId)).toEqual([healthy!.applyId]);
    expect(result.diagnostics).toEqual([{
      reason: "receipt-unreadable", applyId: broken!.applyId,
      revisionId: broken!.revisionId, clusterId: broken!.clusterId, detail: error.message,
    }]);
  });

  it("collects corrupt lifecycle line diagnostics without printing", async () => {
    const root = await workspace();
    await apply(root);
    await writeFile(join(root, ".stratum", "learn", "lifecycle.jsonl"), "{\n");
    const warn = vi.spyOn(console, "warn");
    const result = await activeLessons(root);
    expect(result.lessons).toHaveLength(1); // D5 skips torn lines.
    expect(result.diagnostics).toMatchObject([{ reason: "lifecycle-invalid" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("selects legacy committed receipts without printing compatibility notices", async () => {
    const root = await workspace();
    const { applyId } = await apply(root);
    const entry = (await readJournal(root))[0]!;
    const core = {
      ts_ms: 1, from_state: "applying", to_state: "applied", outcome: "applied",
      kind: "transition", resolved_by: "agent", idempotency_key: `${applyId}:applied`,
      payload_digest: createHash("sha256").update(canonicalJson({
        from_state: "applying", to_state: "applied", artifacts: { after_digest: entry.afterDigest },
        modified_files: [entry.targetPath], resolved_by: "agent",
      })).digest("hex"),
      rationale: null, verdict: { met: true }, prev_digest: "",
    };
    const ledger = join(resourceDir("learn-apply-" + applyId), "ledger.jsonl");
    const bytes = canonicalJson({ ...core, entry_digest: computeEntryDigest(core, "") }) + "\n";
    await writeFile(ledger, bytes);
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const log = vi.spyOn(console, "log");
    expect((await activeLessons(root)).lessons.map((l) => l.applyId)).toEqual([applyId]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(await readFile(ledger, "utf8")).toBe(bytes);
  });

  it("deduplicates revisions and selects the newest active revision per cluster with stable ties", async () => {
    const root = await workspace();
    const a = await apply(root);
    // Simulate multiple historically committed snapshots without changing the ledger.
    await rm(a.candidate.targetPath);
    const bCandidate = { ...a.candidate, scope: { ...a.candidate.scope, stepIds: [...a.candidate.scope.stepIds, "extra"] } };
    bCandidate.revisionId = computeRevisionId(bCandidate);
    const b = await apply(root, bCandidate);
    await copyFile(journalPath(root, a.applyId), join(journalDir(root), "duplicate.json"));
    await editJournal(root, a.applyId, { at: "2026-01-01T00:00:00.000Z" });
    await copyFile(journalPath(root, a.applyId), join(journalDir(root), "duplicate.json"));
    await editJournal(root, b.applyId, { at: "2026-01-02T00:00:00.000Z" });
    let result = await activeLessons(root);
    expect(result.lessons.map((l) => l.applyId)).toEqual([b.applyId]);
    expect(result.diagnostics).toMatchObject([{ reason: "superseded-revision", applyId: a.applyId }]);
    await editJournal(root, b.applyId, { at: "2026-01-01T00:00:00.000Z" });
    result = await activeLessons(root);
    expect(result.lessons.map((l) => l.applyId)).toEqual([[a.applyId, b.applyId].sort().at(-1)]);
    expect(result.diagnostics).toHaveLength(1);
  });
});
