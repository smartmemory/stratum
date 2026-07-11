import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuardEngineOwned } from "../../src/guard/errors.js";
import {
  GUARDS_DIR,
  ResourceLockManager,
  readLedger,
  resourceDir,
  resourceHash,
  setGuardsDir,
  verifyChain,
} from "../../src/guard/store.js";
import { guardHistory, guardTransition, registerGuard, setGuardLockingForTests } from "../../src/guard/transition.js";

const execFileAsync = promisify(execFile);
const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, "../fixtures/guard-py-golden");
const pythonPackage = resolve(testDirectory, "../../../stratum-mcp");
const python = "/Users/ruze/miniconda3/bin/python";
const pythonResource = "acceptance:py-golden";
let resetLocking: (() => void) | undefined;

async function tempGuardsRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  setGuardsDir(root);
  return root;
}

beforeEach(() => {
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `acceptance-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
});

afterEach(async () => {
  resetLocking?.();
  resetLocking = undefined;
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("dedicated cross-engine guard acceptance", () => {
  it("loads and verifies the committed Python-written fixture, enforces handoff, then transitions under TS", async () => {
    const root = await tempGuardsRoot("stratum-guard-py-golden-");
    const copiedResourceDir = join(root, resourceHash(pythonResource));
    await mkdir(copiedResourceDir, { recursive: true });
    await cp(fixtureDirectory, copiedResourceDir, { recursive: true });

    const registry = guardHistory(pythonResource);
    const ledgerPath = join(copiedResourceDir, "ledger.jsonl");
    const ledgerBytes = await readFile(ledgerPath, "utf8");

    expect(verifyChain(ledgerPath)).toBe(true);
    expect(verifyChain(ledgerBytes)).toBe(true);
    expect(readLedger(pythonResource)).toHaveLength(2);
    expect(registry).toMatchObject({
      resource_id: pythonResource,
      current_state: "review",
      ledger: [
        expect.objectContaining({ outcome: "applied", verdict: expect.objectContaining({ budget_consumed: { dollars: 0, turns: 0, wall_clock_s: 0 } }) }),
        expect.objectContaining({ outcome: "refused" }),
      ],
    });

    await expect(guardTransition(pythonResource, "review", "done"))
      .rejects.toBeInstanceOf(GuardEngineOwned);
    expect(guardHistory(pythonResource).current_state).toBe("review");
    expect(readLedger(pythonResource)).toHaveLength(2);

    await writeFile(join(copiedResourceDir, "engine.json"), `${JSON.stringify({ owner: "ts", since: "2026-07-11T00:00:00Z" })}\n`, "utf8");
    await expect(guardTransition(pythonResource, "review", "done", { idempotencyKey: "ts-after-handoff-1" }))
      .resolves.toMatchObject({ status: "applied", current_state: "done", verdict: expect.any(Object) });
    expect(guardHistory(pythonResource)).toMatchObject({ current_state: "done" });
    expect(readLedger(pythonResource)).toHaveLength(3);
    expect(verifyChain(ledgerPath)).toBe(true);
  });

  it("writes a real TS transition whose stored verdict passes Python read_ledger and verify_chain", async () => {
    const root = await tempGuardsRoot("stratum-guard-ts-python-");
    const resourceId = "acceptance:ts-to-python";
    await registerGuard(resourceId, { draft: ["done"], done: [] }, {}, "draft", ["done"]);
    await expect(guardTransition(resourceId, "draft", "done", {
      artifacts: { commit_sha: "deadbeef" },
      modifiedFiles: ["server/lifecycle-guard.js"],
      idempotencyKey: "ts-real-transition-1",
      resolvedBy: "agent",
    })).resolves.toMatchObject({ status: "applied", current_state: "done", verdict: expect.any(Object) });

    const tsLedger = readLedger(resourceId);
    expect(tsLedger).toHaveLength(1);
    expect(tsLedger[0]?.verdict).toMatchObject({ budget_consumed: { dollars: 0, turns: 0, wall_clock_s: 0 } });
    expect(verifyChain(join(resourceDir(resourceId), "ledger.jsonl"))).toBe(true);

    const script = [
      "import sys",
      "from pathlib import Path",
      "import stratum_mcp.guard.store as s",
      "s.GUARDS_DIR = Path(sys.argv[1])",
      "entries = s.read_ledger(sys.argv[2])",
      "print(len(entries), s.verify_chain(entries), s.current_state_from_ledger(entries, 'draft'), entries[0].verdict['budget_consumed'])",
    ].join("; ");
    const result = await execFileAsync(python, ["-c", script, root, resourceId], { cwd: pythonPackage });

    expect(result.stdout.trim()).toBe("1 True done {'dollars': 0, 'turns': 0, 'wall_clock_s': 0}");
  });
});
