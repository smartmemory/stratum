import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { GUARDS_DIR, loadRegistry, readLedger, setGuardsDir } from "../../src/guard/store.js";
import { guardTransition, payloadDigestForVersion, registerGuard } from "../../src/guard/transition.js";
import { applyCandidate, journalPath, ledgerReceipt, readJournal, reconcile, revertApply, type JournalEntry } from "../../src/learn/apply.js";
import { authorCandidate } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvest } from "../../src/learn/harvest.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "learn", "flows");
const temporaries: string[] = [];

afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  await Promise.all(temporaries.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("keeps prepared journal bytes and guard receipts compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "apply-compat-"));
  temporaries.push(root);
  setGuardsDir(join(root, "guards"));
  const { records } = await harvest(fixtures);
  const cluster = classify(records.map((record) => ({ ...record, workspaceRoot: root }))).find((item) => item.class === "durable")!;
  const candidate = authorCandidate(cluster);
  const result = await applyCandidate(candidate, { enabled: true });
  const [entry] = await readJournal(root);
  expect(entry).toBeDefined();
  const prepared = { ...entry!, state: "prepared" };
  delete prepared.ledgerRef;
  const keys = ["applyId", "state", "clusterId", "revisionId", "targetPath", "before", "beforeDigest", "after", "afterDigest", "existedBefore", "evidence", "verdicts", "at"];
  expect(Object.keys(prepared)).toEqual(keys);
  expect(await readFile(journalPath(root, result.applyId), "utf8")).toBe(JSON.stringify(entry, null, 2));
  const resource = `learn-apply-${result.applyId}`;
  const registry = loadRegistry(resource)!;
  expect(registry.graph).toEqual({ staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] });
  expect(registry.edge_predicates).toEqual({});
  expect(registry.initial).toBe("staged");
  expect(registry.terminal).toEqual(["aborted", "reverted"]);
  expect(registry.checksum).toBe("824c970f3b8dae588ebc01cbc468b366eeda24fb101fb800b8128203dbf896ae");
  const rows = readLedger(resource).map((row) => row.toDict());
  const preparedDigest = createHash("sha256").update(JSON.stringify(prepared)).digest("hex");
  expect(rows[0]?.payload_digest).toBe(payloadDigestForVersion("staged", "applying", { journal_digest: preparedDigest, revision_id: entry!.revisionId }, [], "agent", registry.checksum, 2));
  expect(rows[1]?.payload_digest).toBe(payloadDigestForVersion("applying", "applied", { after_digest: entry!.afterDigest }, [entry!.targetPath], "agent", registry.checksum, 2));
  expect(ledgerReceipt(entry!)).toEqual({ kind: "committed", state: "applied" });
  await revertApply(result.applyId, root, { enabled: true });
  const [reverted] = await readJournal(root);
  const finalRows = readLedger(resource).map((row) => row.toDict());
  expect(finalRows[2]?.payload_digest).toBe(payloadDigestForVersion("applied", "reverted", { reverted_to: reverted!.beforeDigest }, [reverted!.targetPath], "agent", registry.checksum, 2));
  expect(ledgerReceipt(reverted!)).toEqual({ kind: "committed", state: "reverted" });
});

it("re-derives fixed current-version apply and revert receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "apply-receipt-"));
  temporaries.push(root);
  setGuardsDir(join(root, "guards"));
  const resource = "learn-apply-baseline-v2";
  const targetPath = "/tmp/stratum-memory-compat/notes.md";
  const before = "before";
  const after = "after";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const entry: JournalEntry = {
    applyId: "baseline-v2",
    state: "applied",
    clusterId: "cluster",
    revisionId: "revision",
    targetPath,
    before,
    beforeDigest: digest(before),
    after,
    afterDigest: digest(after),
    existedBefore: true,
    evidence: [],
    verdicts: [],
    at: "2026-09-23T00:00:00.000Z",
  };
  await registerGuard(resource,
    { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] },
    {}, "staged", ["aborted", "reverted"],
  );
  await guardTransition(resource, "staged", "applying", {
    artifacts: { journal_digest: digest(JSON.stringify({ ...entry, state: "prepared" })), revision_id: entry.revisionId },
    idempotencyKey: "baseline-v2:applying",
  });
  await guardTransition(resource, "applying", "applied", {
    artifacts: { after_digest: entry.afterDigest },
    modifiedFiles: [targetPath],
    idempotencyKey: "baseline-v2:applied",
  });
  const applied = readLedger(resource)[1]!;
  expect(applied.payload_digest).toBe("fa98c7927776253fd288cd8a87a021bab2e1a733cf346e4ec39a7762c4abafea");
  expect(ledgerReceipt(entry)).toEqual({ kind: "committed", state: "applied" });
  await guardTransition(resource, "applied", "reverted", {
    artifacts: { reverted_to: entry.beforeDigest },
    modifiedFiles: [targetPath],
    idempotencyKey: "baseline-v2:reverted",
  });
  const reverted = readLedger(resource)[2]!;
  expect(reverted.payload_digest).toBe("1e336046878f736babe978573e44414e17757048538b7ba53894db9ab2ab9855");
  expect(ledgerReceipt({ ...entry, state: "reverted" })).toEqual({ kind: "committed", state: "reverted" });
});

it("preserves distinct disabled messages for apply and recovery", async () => {
  const previous = process.env.STRATUM_LEARN_APPLY_ENABLED;
  delete process.env.STRATUM_LEARN_APPLY_ENABLED;
  try {
    await expect(applyCandidate({} as Parameters<typeof applyCandidate>[0], {}))
      .rejects.toThrow("learn apply is disabled; enable it explicitly (STRATUM_LEARN_APPLY_ENABLED=1)");
    await expect(revertApply("absent", "/tmp", {})).rejects.toThrow("learn apply is disabled");
    await expect(reconcile("/tmp", {})).rejects.toThrow("learn apply is disabled");
  } finally {
    if (previous === undefined) delete process.env.STRATUM_LEARN_APPLY_ENABLED;
    else process.env.STRATUM_LEARN_APPLY_ENABLED = previous;
  }
});
