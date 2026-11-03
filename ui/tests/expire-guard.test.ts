import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs server module, no declarations (same as server.test.ts)
import { disambiguate, expiryCandidates, summarize } from "../server/project.mjs";
import { persistedRun } from "./fixtures";

const DAY = 86400e3;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const oldRun = (id: string, overrides: Record<string, unknown> = {}) =>
  persistedRun({ id, steps: { approve: { status: "pending", attempts: [] } }, events: [{ at: ago(40 * DAY), type: "planned" }], ...overrides });

let dir: string;
let flows: string;
let dist: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "expire-guard-"));
  flows = join(dir, "flows");
  dist = join(dir, "dist");
  mkdirSync(flows);
  mkdirSync(join(dist, "engine"), { recursive: true });
  mkdirSync(join(dist, "eval"));
  // Fake engine: cancelFlow logs the id to cancelled.log. The StratumEngine constructor (built after selection, before
  // the first cancel) rewrites the run named in FLIP_RUN to awaiting a gate with a fresh event.
  writeFileSync(join(dist, "engine", "engine.js"), `import { readFileSync, writeFileSync } from "node:fs";
export class StratumEngine { constructor(o) { this.root = o.stateRoot; const f = process.env.FLIP_RUN;
  if (f) { const p = this.root + "/" + f + ".json"; const r = JSON.parse(readFileSync(p, "utf8"));
    r.steps = { approve: { status: "waiting_gate", attempts: [] } }; r.events.push({ at: new Date().toISOString(), type: "gate_waiting" });
    writeFileSync(p, JSON.stringify(r)); } } }\n`);
  writeFileSync(join(dist, "engine", "flow_cancel.js"), `import { appendFileSync } from "node:fs";
export async function cancelFlow(engine, id) { appendFileSync(engine.root + "/../cancelled.log", id + "\\n"); return { status: "cancelled" }; }\n`);
  writeFileSync(join(dist, "eval", "expr.js"), "export const createEvaluator = () => ({});\n");
  writeFileSync(join(dist, "engine", "evaluate.js"), "export const createEvaluateRunner = () => ({});\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(run: { id: string }) {
  writeFileSync(join(flows, `${run.id}.json`), JSON.stringify(run));
}
function expire(extra: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [join(__dirname, "..", "server", "expire.mjs"), "--flows-dir", flows, "--engine-dist", dist, ...extra], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env },
  });
  let log = "";
  try { log = readFileSync(join(dir, "cancelled.log"), "utf8"); } catch { /* nothing cancelled */ }
  return { status: res.status, out: res.stdout, err: res.stderr, cancelled: log.split("\n").filter(Boolean) };
}

describe("expire.mjs --days guard (M2)", () => {
  for (const bad of ["oops", "-3", "0", "0.5", "Infinity", ""]) {
    for (const mode of [[], ["--apply"]]) {
      it(`--days ${JSON.stringify(bad)}${mode.length ? " --apply" : " (dry)"} exits nonzero and selects nothing`, () => {
        put(oldRun("old-1"));
        const res = expire(["--days", bad, ...mode]);
        expect(res.status).not.toBe(0);
        expect(res.err).toContain("--days must be a number of at least 1");
        expect(res.out).toBe("");
        expect(res.cancelled).toEqual([]);
      });
    }
  }

  it("a valid --days still selects, and a fresh run is never a candidate", () => {
    put(oldRun("old-1"));
    put(oldRun("fresh-1", { events: [{ at: ago(1000), type: "planned" }] }));
    const res = expire(["--days", "30"]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.out.split("\n")[0]).toExpire).toBe(1);
  });

  it("expiryCandidates throws on a non-finite or non-positive afterMs, so NaN never means everything is old", () => {
    const runs = [oldRun("a"), persistedRun({ id: "fresh", steps: {}, events: [{ at: ago(1000), type: "planned" }] })];
    for (const bad of [NaN, -1, 0, Infinity, -Infinity]) expect(() => expiryCandidates(runs, Date.now(), bad)).toThrow(RangeError);
    expect(expiryCandidates(runs, Date.now(), 30 * DAY).map((c: { id: string }) => c.id)).toEqual(["a"]);
  });
});

describe("expire.mjs --apply rechecks right before the cancel (M1)", () => {
  it("cancels an eligible run", () => {
    put(oldRun("old-1"));
    const res = expire(["--apply"]);
    expect(res.status).toBe(0);
    expect(res.cancelled).toEqual(["old-1"]);
  });

  it("does not cancel a run that became awaiting a gate with a fresh event after it was selected", () => {
    put(oldRun("old-1"));
    put(oldRun("old-2"));
    const res = expire(["--apply"], { FLIP_RUN: "old-1" });
    expect(res.status).toBe(0);
    expect(res.cancelled).toEqual(["old-2"]);
    const last = JSON.parse(res.out.trim().split("\n").pop() as string);
    expect(last["skipped (changed since selection)"]).toBe(1);
    expect(last.cancelled).toBe(1);
    expect(readdirSync(flows).sort()).toEqual(["old-1.json", "old-2.json"]);
  });
});

describe("disambiguate last fallback (L1)", () => {
  it("ids sharing the first 8 characters get distinct labels", () => {
    const row = (id: string) => ({ ...summarize(persistedRun({ id })), id, label: "same", featureCode: null, startedAt: "2026-10-01T10:00:00Z" });
    const labels = disambiguate([row("12345678-a"), row("12345678-b")]).map((r: { label: string }) => r.label);
    expect(labels).toEqual(["same · 2026-10-01 · 10:00 · 12345678 · 12345678-a", "same · 2026-10-01 · 10:00 · 12345678 · 12345678-b"]);
    expect(new Set(labels).size).toBe(2);
  });
});
