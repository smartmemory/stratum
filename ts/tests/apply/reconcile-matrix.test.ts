import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BaseJournalEntry, JournalState, ReconcileReport } from "../../src/apply/protocol.js";
import { readJournal, reconcile } from "../../src/learn/apply.js";
import { readAssetJournal, reconcileAssetApplies, type AssetJournalEntry } from "../../src/distill/apply.js";
import { digest as sha } from "../../src/distill/harvest.js";
import { GUARDS_DIR, resourceDir, setGuardsDir } from "../../src/guard/store.js";
import { guardTransition, registerGuard } from "../../src/guard/transition.js";

interface Harness {
  kind: "memory" | "asset";
  target(root: string): string;
  journal(root: string, id: string): string;
  resource(id: string): string;
  read(root: string): Promise<BaseJournalEntry<unknown>[]>;
  reconcile(root: string): Promise<ReconcileReport>;
}
const harnesses: Harness[] = [
  { kind: "memory", target: root => join(root, ".stratum", "learn", "notes.md"),
    journal: (root, id) => join(root, ".stratum", "learn", "applies", `${id}.json`), resource: id => `learn-apply-${id}`,
    read: readJournal, reconcile: root => reconcile(root, { enabled: true }) },
  { kind: "asset", target: root => join(root, ".claude", "skills", "matrix", "SKILL.md"),
    journal: (root, id) => join(root, ".stratum", "distill", "applies", `${id}.json`), resource: id => `distill-apply-${id}`,
    read: readAssetJournal, reconcile: root => reconcileAssetApplies(root, { enabled: true }) },
];
type Receipt = "absent" | "applied" | "reverted" | "truncated";
type Target = "before" | "after" | "third";
interface Scenario { state: JournalState; receipt: Receipt; target: Target; counter: keyof ReconcileReport | "none"; finalState: JournalState; finalTarget: Target }
const scenarios: Scenario[] = [];
for (const state of ["prepared", "applying"] as const) for (const target of ["before", "after", "third"] as const) {
  scenarios.push({ state, receipt: "absent", target, counter: target === "third" ? "diverged" : "rolledBack", finalState: target === "third" ? state : "aborted", finalTarget: target === "third" ? "third" : "before" });
}
for (const target of ["before", "after", "third"] as const) scenarios.push({ state: "applying", receipt: "applied", target, counter: target === "third" ? "diverged" : "completed", finalState: target === "third" ? "applying" : "applied", finalTarget: target === "third" ? "third" : "after" });
for (const state of ["reverting", "applied"] as const) scenarios.push({ state, receipt: "absent", target: "after", counter: "completed", finalState: "applied", finalTarget: "after" });
for (const state of ["prepared", "applying", "applied", "reverting"] as const) for (const target of ["before", "after", "third"] as const) {
  scenarios.push({ state, receipt: "reverted", target, counter: target === "third" ? "diverged" : "reverted", finalState: target === "third" ? state : "reverted", finalTarget: target === "third" ? "third" : "before" });
}
scenarios.push({ state: "applied", receipt: "applied", target: "after", counter: "none", finalState: "applied", finalTarget: "after" });
scenarios.push({ state: "applied", receipt: "applied", target: "third", counter: "none", finalState: "applied", finalTarget: "third" });
scenarios.push({ state: "applying", receipt: "truncated", target: "after", counter: "diverged", finalState: "applying", finalTarget: "after" });
const temporary: string[] = [];
afterEach(async () => { setGuardsDir(GUARDS_DIR); await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function put(path: string, bytes: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
async function setup(h: Harness, scenario: Scenario, existed: boolean, before = existed ? "before\r\nexact\n" : "", after = "after\n") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reconcile-matrix-"))); temporary.push(root); setGuardsDir(join(root, ".stratum", "guard"));
  const base: BaseJournalEntry<unknown> = { applyId: "matrix", state: scenario.state, clusterId: "cluster", revisionId: "revision", targetPath: h.target(root),
    before, beforeDigest: sha(before), after, afterDigest: sha(after),
    existedBefore: existed, evidence: [], verdicts: [], at: "2026-09-23T00:00:00.000Z" };
  const entry = h.kind === "asset" ? { ...base, kind: "asset", lineage: { poolSnapshot: [], authoringInputsDigest: sha("inputs"), poolDigestAtAdmission: sha("[]") }, sourceMode: "workspace" } as AssetJournalEntry : base;
  const resource = h.resource(entry.applyId);
  await registerGuard(resource, { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] }, {}, "staged", ["aborted", "reverted"], {}, null, undefined);
  if (scenario.state !== "prepared" || scenario.receipt !== "absent") await guardTransition(resource, "staged", "applying", { artifacts: {}, idempotencyKey: "applying" });
  if (scenario.receipt !== "absent") await guardTransition(resource, "applying", "applied", { artifacts: { after_digest: entry.afterDigest }, modifiedFiles: [entry.targetPath], idempotencyKey: "applied" });
  if (scenario.receipt === "reverted") await guardTransition(resource, "applied", "reverted", { artifacts: { reverted_to: entry.beforeDigest }, modifiedFiles: [entry.targetPath], idempotencyKey: "reverted" });
  if (scenario.receipt === "truncated") {
    const path = join(resourceDir(resource), "ledger.jsonl"); await writeFile(path, await readFile(path, "utf8") + '{"truncated":');
  }
  await put(h.journal(root, entry.applyId), JSON.stringify(entry));
  if (scenario.target !== "before" || existed) await put(entry.targetPath, scenario.target === "before" ? entry.before : scenario.target === "after" ? entry.after : "third");
  return { root, entry };
}
function runReconcileMatrix(h: Harness) {
  describe(`${h.kind} shared reconcile matrix`, () => {
    for (const existed of [false, true]) for (const s of scenarios) {
      it(`${s.state} / ${s.receipt} receipt / ${s.target} target / existed=${existed} -> ${s.counter}`, async () => {
        const { root, entry } = await setup(h, s, existed);
        const report = { completed: 0, rolledBack: 0, reverted: 0, diverged: 0 }; if (s.counter !== "none") report[s.counter] = 1;
        expect(await h.reconcile(root)).toEqual(report);
        expect((await h.read(root))[0]!.state).toBe(s.finalState);
        if (s.finalTarget === "before" && !existed) await expect(readFile(entry.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        else expect(await readFile(entry.targetPath, "utf8")).toBe(s.finalTarget === "before" ? entry.before : s.finalTarget === "after" ? entry.after : "third");
      });
    }
    for (const existedBefore of [false, true]) for (const existsNow of [false, true]) {
      it(`committed apply with empty before: existed=${existedBefore}, current=${existsNow}`, async () => {
        const s: Scenario = { state: "applying", receipt: "applied", target: "before", counter: "completed", finalState: "applied", finalTarget: "after" };
        const { root, entry } = await setup(h, s, existedBefore, "");
        if (existsNow) await put(entry.targetPath, "");
        else await rm(entry.targetPath, { force: true });
        const matches = existedBefore === existsNow;
        expect(await h.reconcile(root)).toEqual({ completed: matches ? 1 : 0, rolledBack: 0, reverted: 0, diverged: matches ? 0 : 1 });
        expect((await h.read(root))[0]!.state).toBe(matches ? "applied" : "applying");
        if (matches || existsNow) expect(await readFile(entry.targetPath, "utf8")).toBe(matches ? entry.after : "");
        else await expect(readFile(entry.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
    for (const receipt of ["absent", "applied", "reverted"] as const) {
      it(`${receipt} receipt never mistakes a missing target for empty installed bytes`, async () => {
        const s: Scenario = { state: "applying", receipt, target: "after", counter: "diverged", finalState: "applying", finalTarget: "third" };
        const { root, entry } = await setup(h, s, true, "original", "");
        await rm(entry.targetPath);
        expect(await h.reconcile(root)).toEqual({ completed: 0, rolledBack: 0, reverted: 0, diverged: 1 });
        expect((await h.read(root))[0]!.state).toBe("applying");
        await expect(readFile(entry.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
    for (const state of ["applied", "reverting"] as const) {
      it(`${state} without a receipt requires an existing after target`, async () => {
        const s: Scenario = { state, receipt: "absent", target: "after", counter: "diverged", finalState: state, finalTarget: "third" };
        const { root, entry } = await setup(h, s, true, "original", "");
        await rm(entry.targetPath);
        expect(await h.reconcile(root)).toEqual({ completed: 0, rolledBack: 0, reverted: 0, diverged: 1 });
        expect((await h.read(root))[0]!.state).toBe(state);
        await expect(readFile(entry.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
    for (const existedBefore of [false, true]) {
      it(`uncommitted empty before requires matching existence: existed=${existedBefore}`, async () => {
        const s: Scenario = { state: "applying", receipt: "absent", target: "before", counter: "diverged", finalState: "applying", finalTarget: "third" };
        const { root, entry } = await setup(h, s, existedBefore, "");
        if (existedBefore) await rm(entry.targetPath);
        else await put(entry.targetPath, "");
        expect(await h.reconcile(root)).toEqual({ completed: 0, rolledBack: 0, reverted: 0, diverged: 1 });
        expect((await h.read(root))[0]!.state).toBe("applying");
        if (existedBefore) await expect(readFile(entry.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        else expect(await readFile(entry.targetPath, "utf8")).toBe("");
      });
    }
    it("allowlist revalidation failure diverges without mutation", async () => {
      const s: Scenario = { state: "applying", receipt: "absent", target: "after", counter: "diverged", finalState: "applying", finalTarget: "after" };
      const { root, entry } = await setup(h, s, false);
      const path = join(root, "outside.md"); await put(path, "outside"); entry.targetPath = path;
      const bytes = JSON.stringify(entry); await writeFile(h.journal(root, entry.applyId), bytes);
      expect((await h.reconcile(root)).diverged).toBe(1); expect(await readFile(path, "utf8")).toBe("outside");
      expect(await readFile(h.journal(root, entry.applyId), "utf8")).toBe(bytes);
    });
  });
}
harnesses.forEach(runReconcileMatrix);
