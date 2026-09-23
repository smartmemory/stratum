import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as paths from "../../src/apply/paths.js";
import * as memory from "../../src/learn/apply.js";
import * as asset from "../../src/distill/apply.js";
import { authorCandidate } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvest } from "../../src/learn/harvest.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { assetFixture } from "../distill/apply-helpers.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  setGuardsDir(GUARDS_DIR);
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(kind: "memory" | "asset") {
  if (kind === "asset") {
    const { root, candidate } = await assetFixture();
    temporary.push(root);
    setGuardsDir(join(root, "guards"));
    return { root, apply: () => asset.applyAssetCandidate(candidate, { applyRoot: root, enabled: true, trustSource: true }),
      revert: (id: string) => asset.revertAssetApply(id, root, { enabled: true }),
      reconcile: () => asset.reconcileAssetApplies(root, { enabled: true }),
      read: () => asset.readAssetJournal(root), journal: (id: string) => join(root, ".stratum", "distill", "applies", `${id}.json`) };
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-recovery-")));
  temporary.push(root);
  setGuardsDir(join(root, "guards"));
  const { records } = await harvest(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/learn/flows"));
  const cluster = classify(records).find(item => item.class === "durable")!;
  const candidate = authorCandidate({ ...cluster, scope: { ...cluster.scope, workspaceRoot: root } });
  return { root, apply: () => memory.applyCandidate(candidate, { enabled: true }),
    revert: (id: string) => memory.revertApply(id, root, { enabled: true }),
    reconcile: () => memory.reconcile(root, { enabled: true }),
    read: () => memory.readJournal(root), journal: (id: string) => memory.journalPath(root, id) };
}

// Pause path resolution after the journal snapshot, before acquiring locks.
// Resolution still runs normally; files, locks, guards and adapters are real.
function pauseBeforeLocks() {
  let reached!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { resume = resolve; });
  const resolvePath = paths.realpathThroughMissing;
  vi.spyOn(paths, "realpathThroughMissing").mockImplementationOnce(async path => {
    const result = await resolvePath(path);
    reached();
    await released;
    return result;
  });
  return { ready, resume };
}

for (const kind of ["memory", "asset"] as const) describe(`${kind} recovery interleaving`, () => {
  it("reconcile discards its stale snapshot after revert and re-apply of the same revision", async () => {
    const f = await fixture(kind);
    const first = await f.apply();
    const pause = pauseBeforeLocks();
    const pending = f.reconcile();
    await pause.ready;
    try {
      await f.revert(first.applyId);
      const second = await f.apply();
      const entry = (await f.read()).find(e => e.applyId === second.applyId)!;
      pause.resume();
      expect(await pending).toEqual({ completed: 0, rolledBack: 0, reverted: 0, diverged: 0 });
      expect(await readFile(second.targetPath, "utf8")).toBe(entry.after);
      expect((await f.read()).find(e => e.applyId === second.applyId)!.state).toBe("applied");
    } finally { pause.resume(); await pending; }
  });

  it("revert checks the fresh state under lock and preserves a reinstallation", async () => {
    const f = await fixture(kind);
    const first = await f.apply();
    const pause = pauseBeforeLocks();
    const pending = f.revert(first.applyId).then(() => null, error => error as Error);
    await pause.ready;
    try {
      await f.revert(first.applyId);
      const second = await f.apply();
      const entry = (await f.read()).find(e => e.applyId === second.applyId)!;
      pause.resume();
      expect((await pending)?.message).toBe(`apply ${first.applyId} is reverted, not applied`);
      expect(await readFile(second.targetPath, "utf8")).toBe(entry.after);
      expect((await f.read()).find(e => e.applyId === second.applyId)!.state).toBe("applied");
    } finally { pause.resume(); await pending; }
  });

  it("an after-restore revert crash blocks apply until reconciliation", async () => {
    const f = await fixture(kind);
    const first = await f.apply();
    const entry = (await f.read())[0]!;
    await f.revert(first.applyId);
    // Reconstruct the crash boundary: committed revert and restored target,
    // but the final journal write did not persist.
    await writeFile(f.journal(first.applyId), JSON.stringify({ ...entry, state: "reverting" }, null, 2));
    await expect(readFile(first.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.apply()).rejects.toThrow(`target has an unreconciled apply (${first.applyId}); reconcile first`);
    expect(await f.reconcile()).toEqual({ completed: 0, rolledBack: 0, reverted: 1, diverged: 0 });
    const second = await f.apply();
    expect(await f.reconcile()).toEqual({ completed: 0, rolledBack: 0, reverted: 0, diverged: 0 });
    expect(await readFile(second.targetPath, "utf8")).toBe(entry.after);
    expect((await f.read()).find(e => e.applyId === second.applyId)!.state).toBe("applied");
  });
});

describe("asset recovery interleaving", () => {
  it("reports the reverted state before rejecting a symlink target", async () => {
    const f = await fixture("asset");
    const first = await f.apply();
    await f.revert(first.applyId);
    await symlink(join(f.root, "symlink-destination"), first.targetPath);

    await expect(f.revert(first.applyId)).rejects.toMatchObject({
      message: `apply ${first.applyId} is reverted, not applied`,
    });
  });
});
