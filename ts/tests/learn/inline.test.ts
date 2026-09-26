import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { readCandidates } from "../../src/learn/candidate.js";
import { inlineLogPath, LearnInline, type InlinePassRow } from "../../src/learn/inline.js";
import { appendLifecycle } from "../../src/learn/lifecycle.js";
import { canonicalWorkspace } from "../../src/learn/workspace.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

vi.setConfig({ testTimeout: 30_000 });

const temporaries: string[] = [];
afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of temporaries.splice(0)) {
    await chmod(join(dir, "ws", ".stratum", "learn"), 0o755).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  dir: string;
  ws: string;
  store: string;
  engine: ReturnType<typeof tokenEchoingEngine>;
  raw: StratumEngine;
}

async function harness(options: { inline?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "learn-inline-"));
  temporaries.push(dir);
  setGuardsDir(join(dir, "guards"));
  const ws = join(dir, "ws");
  const store = join(dir, "state", "flows");
  await mkdir(ws, { recursive: true });
  await mkdir(store, { recursive: true });
  vi.stubEnv("STRATUM_CONFIG_FILE", join(dir, "no-user-config.toml"));
  vi.stubEnv("STRATUM_LEARN_INLINE", "");
  if (options.inline) await enable(ws);
  const raw = new StratumEngine({ stateRoot: store, evaluator: createEvaluator() });
  return { dir, ws, store, raw, engine: tokenEchoingEngine(raw) };
}

const enable = (ws: string) => writeFile(join(ws, "stratum.toml"), "[learn]\ninline = true\n");

function flow(steps: unknown[], extra: Record<string, unknown> = {}, flows: Record<string, unknown> = {}) {
  const first = (steps[0] as { id: string }).id;
  return {
    version: 1, contracts: { Result: { outcome: "complete|failed" } },
    flows: { entry: "main", main: { input: {}, output: { from: `\${${first}.output}`, contract: "Result" }, steps, ...extra }, ...flows },
  };
}
const ONE_STEP = (attempts = 1) => flow([{ id: "plan", do: "plan", out: "Result", attempts }]);

/** `null` plans the run with no workspaceRoot at all. */
async function failRun(h: Harness, workspaceRoot: string | null = h.ws): Promise<string> {
  const planned = await h.engine.plan(ONE_STEP(), {}, workspaceRoot === null ? {} : { workspaceRoot });
  expect(await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "done" } })).toMatchObject({ status: "failed" });
  return planned.runId;
}

async function rows(h: Harness): Promise<InlinePassRow[]> {
  await h.raw.learnInlineIdle();
  try {
    return (await readFile(inlineLogPath(h.store), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as InlinePassRow);
  } catch { return []; }
}
const sidecar = (ws: string) => readCandidates(join(ws, ".stratum", "learn"));
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("INLINE-TS-1 terminal trigger", () => {
  it("OFF (the default): terminal runs write no diagnostic log and stage nothing", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await failRun(h);
    expect(await rows(h)).toEqual([]);
    expect(await exists(join(h.ws, ".stratum"))).toBe(false);
  });

  it("ON: repeated failures stage the durable lesson into the canonical sidecar, and never apply it", async () => {
    const h = await harness({ inline: true });
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await failRun(h));
    const log = await rows(h);
    expect(log.flatMap((row) => row.triggeredBy)).toEqual(runs);
    const staged = await sidecar(h.ws);
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((row) => row.scope.workspaceRoot === h.ws && row.contract.code === "invalid_enum_value")).toBe(true);
    expect(log.at(-1)!.enabled[h.ws]).toEqual({ layer: "project", source: join(h.ws, "stratum.toml") });
    expect(await exists(join(h.ws, ".stratum", "learn", "applies"))).toBe(false);
    expect(await exists(join(h.ws, ".stratum", "learn", "NOTES.md"))).toBe(false);
  });

  it("stages lessons from runs that COMPLETED after recovered failures (the waste case)", async () => {
    const h = await harness({ inline: true });
    for (let i = 0; i < 3; i += 1) {
      const planned = await h.engine.plan(ONE_STEP(2), {}, { workspaceRoot: h.ws });
      await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "done" } });
      expect(await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "complete" } })).toMatchObject({ status: "completed" });
    }
    await rows(h);
    expect((await sidecar(h.ws)).length).toBeGreaterThan(0);
  });

  const terminalPaths: Array<[string, (h: Harness) => Promise<string>, string]> = [
    ["ordinary completion", async (h) => {
      const p = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: h.ws });
      await h.engine.stepDone(p.runId, "plan", { output: { outcome: "complete" } });
      return p.runId;
    }, "completed"],
    ["failure", (h) => failRun(h), "failed"],
    ["budget exhaustion", async (h) => {
      const p = await h.engine.plan(flow([{ id: "a", do: "a", out: "Result" }, { id: "b", do: "b", out: "Result" }], { budget: { dispatches: 1 } }), {}, { workspaceRoot: h.ws });
      return p.runId;
    }, "budget_exhausted"],
    ["cancellation", async (h) => {
      const p = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: h.ws });
      await h.engine.flowCancel(p.runId, "stop");
      return p.runId;
    }, "cancelled"],
    ["terminal gate completion", async (h) => {
      const p = await h.engine.plan(flow([{ id: "plan", do: "plan", out: "Result" },
        { id: "ok", after: ["plan"], gate: { on_approve: null, on_revise: "plan", on_kill: null } }], { max_rounds: 1 }), {}, { workspaceRoot: h.ws });
      await h.engine.stepDone(p.runId, "plan", { output: { outcome: "complete" } });
      await h.engine.gateResolve(p.runId, "ok", "approve");
      return p.runId;
    }, "completed"],
  ];
  it.each(terminalPaths)("fires on %s", async (_name, drive, status) => {
    const h = await harness({ inline: true });
    const runId = await drive(h);
    expect((await h.engine.audit(runId)).status).toBe(status);
    expect((await rows(h)).flatMap((row) => row.triggeredBy)).toEqual([runId]);
  });

  it("does not fire for a gate-waiting run, subflow settlement, or a checkpoint revert", async () => {
    const h = await harness({ inline: true });
    const gated = await h.engine.plan(flow([{ id: "plan", do: "plan", out: "Result" },
      { id: "ok", after: ["plan"], gate: { on_approve: null, on_revise: "plan", on_kill: null } }], { max_rounds: 1 }), {}, { workspaceRoot: h.ws });
    await h.engine.stepDone(gated.runId, "plan", { output: { outcome: "complete" } });
    expect((await h.engine.audit(gated.runId)).status).toBe("running");
    expect(await rows(h)).toEqual([]);

    const nested = flow([{ id: "wrap", run: "child", with: {} }], {}, {
      child: { input: {}, output: { from: "${work.output}", contract: "Result" }, steps: [{ id: "work", do: "work", out: "Result" }] },
    });
    const sub = await h.engine.plan(nested, {}, { workspaceRoot: h.ws });
    await h.engine.stepDone(sub.runId, "wrap/work", { output: { outcome: "complete" } });
    expect((await h.engine.audit(sub.runId)).status).toBe("completed");
    expect((await rows(h)).flatMap((row) => row.triggeredBy)).toEqual([sub.runId]);

    const reverting = await h.engine.plan(flow([{ id: "a", do: "a", out: "Result" }, { id: "b", after: ["a"], do: "b", out: "Result" }]), {}, { workspaceRoot: h.ws });
    await h.engine.commit(reverting.runId, "cp");
    await h.engine.stepDone(reverting.runId, "a", { output: { outcome: "complete" } });
    await h.engine.stepDone(reverting.runId, "b", { output: { outcome: "complete" } });
    const before = (await rows(h)).length;
    await h.engine.revert(reverting.runId, "cp");
    expect((await rows(h)).length).toBe(before);
  });

  it("a run without workspaceRoot stages nothing and is logged as unattributed", async () => {
    const h = await harness();
    vi.stubEnv("STRATUM_LEARN_INLINE", "1");
    const runId = await failRun(h, null);
    const [row] = await rows(h);
    expect(row).toMatchObject({ triggeredBy: [runId], staged: {} });
    expect(row!.skippedUnattributed).toContain(runId);
  });

  it("reconciles every enabled workspace per pass: a trigger from B stages A's older evidence", async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await failRun(h);
    expect(await rows(h)).toEqual([]);
    await enable(h.ws);
    const other = join(h.dir, "other");
    await mkdir(other);
    await enable(other);
    const planned = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: other });
    await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "complete" } });
    const [row] = await rows(h);
    expect(row!.triggeredBy).toEqual([planned.runId]);
    expect(row!.staged[h.ws]!.length).toBeGreaterThan(0);
    expect((await sidecar(h.ws)).length).toBeGreaterThan(0);
  });

  it("never creates a workspace root that no longer exists", async () => {
    const h = await harness({ inline: true });
    const gone = join(h.dir, "gone");
    await mkdir(gone);
    await enable(gone);
    for (let i = 0; i < 3; i += 1) await failRun(h, gone);
    await rows(h);
    const before = (await rows(h)).length;
    await rm(gone, { recursive: true });
    await failRun(h);
    const log = await rows(h);
    expect(log.length).toBe(before + 1);
    expect(log.at(-1)!.roots).toContain(gone);
    expect(await exists(gone)).toBe(false);
  });

  it("coalesces concurrent triggers from two workspaces and stages both", async () => {
    const h = await harness();
    const other = join(h.dir, "other");
    await mkdir(other);
    await enable(h.ws);
    await enable(other);
    // Six runs' worth of real failure evidence in the store, three per workspace.
    const reason = JSON.stringify([{ code: "invalid_enum_value", path: ["outcome"], options: ["complete", "failed"], message: "Invalid enum value" }]);
    const runIds: string[] = [];
    for (const [i, workspaceRoot] of [h.ws, h.ws, h.ws, other, other, other].entries()) {
      const id = `run-${i}`;
      runIds.push(id);
      await writeFile(join(h.store, `${id}.json`), JSON.stringify({
        id, flowName: "main", workspaceRoot, status: "failed",
        events: [{ at: "2026-09-26T00:00:00.000Z", type: "result", stepId: "plan", detail: { attempt: 1, failure: { attempt: 1, reason } } }],
      }));
    }
    // Hold the first pass open until all six triggers are queued: the pass then drains
    // every one at once instead of running once per trigger.
    let holding = true;
    const inline = new LearnInline(h.store, { STRATUM_CONFIG_FILE: join(h.dir, "no-user-config.toml") }, async (queued) => {
      if (!holding) return;
      const deadline = Date.now() + 2_000;
      while (queued.length < runIds.length && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
      holding = false;
    });
    for (const [i, id] of runIds.entries()) inline.trigger({ id, workspaceRoot: i < 3 ? h.ws : other });
    await inline.idle();
    const log = (await readFile(inlineLogPath(h.store), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as InlinePassRow);
    expect(log.length).toBeLessThan(6);
    expect(Math.max(...log.map((row) => row.triggeredBy.length))).toBeGreaterThan(1);
    expect(new Set(log.flatMap((row) => row.triggeredBy))).toEqual(new Set(runIds));
    expect((await sidecar(h.ws)).length).toBeGreaterThan(0);
    expect((await sidecar(other)).length).toBeGreaterThan(0);
  });

  it("stages a build started from a subdirectory or a linked worktree into the main checkout", async () => {
    const h = await harness({ inline: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", h.ws, ...args], { stdio: "pipe", env: { ...process.env, GIT_DIR: undefined } as NodeJS.ProcessEnv });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const sub = join(h.ws, "sub");
    await mkdir(sub);
    const linked = join(h.dir, "linked");
    git("worktree", "add", "-q", linked);
    await failRun(h, sub);
    await failRun(h, linked);
    await failRun(h, h.ws);
    await rows(h);
    // git reports the main root by realpath (/private/var/... for a /var/... tmpdir).
    const main = await canonicalWorkspace(h.ws);
    const staged = await sidecar(main);
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((row) => row.scope.workspaceRoot === main)).toBe(true);
    expect(staged[0]!.evidence.length).toBe(3);
    expect(await exists(join(sub, ".stratum"))).toBe(false);
    expect(await exists(join(linked, ".stratum"))).toBe(false);
  });
});

describe("INLINE-TS-1 lifecycle suppression and fail-open", () => {
  it("a retired cluster with only older evidence is not staged; newer evidence stages it", async () => {
    const h = await harness({ inline: true });
    for (let i = 0; i < 3; i += 1) await failRun(h);
    await rows(h);
    const staged = await sidecar(h.ws);
    expect(staged.length).toBeGreaterThan(0);
    await rm(join(h.ws, ".stratum", "learn", "candidates.jsonl"));
    for (const clusterId of new Set(staged.map((row) => row.clusterId))) {
      await appendLifecycle(h.ws, { clusterId, kind: "retire", reason: "fixed by hand", fixRef: "abc1234" });
    }
    const planned = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: h.ws });
    await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "complete" } });
    const quiet = (await rows(h)).at(-1)!;
    expect(quiet.staged[h.ws]).toEqual([]);
    expect(new Set(quiet.suppressed[h.ws])).toEqual(new Set(staged.map((row) => row.clusterId)));
    expect(await sidecar(h.ws)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await failRun(h);
    const recurred = (await rows(h)).at(-1)!;
    expect(recurred.staged[h.ws]!.length).toBeGreaterThan(0);
  });

  it("an unreadable lifecycle log stages nothing and is logged", async () => {
    const h = await harness({ inline: true });
    await mkdir(join(h.ws, ".stratum", "learn", "lifecycle.jsonl"), { recursive: true });
    for (let i = 0; i < 3; i += 1) await failRun(h);
    const last = (await rows(h)).at(-1)!;
    expect(last.staged[h.ws]).toEqual([]);
    expect(last.problems.join("\n")).toMatch(/lifecycle|EISDIR/);
    expect(await sidecar(h.ws)).toEqual([]);
  });

  it("an invalid [learn] value resolves OFF: the flow response and persisted run are unchanged", async () => {
    const h = await harness();
    await writeFile(join(h.ws, "stratum.toml"), "[learn]\ninline = \"please\"\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const planned = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: h.ws });
    expect(await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "complete" } })).toMatchObject({ status: "completed" });
    expect(await rows(h)).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("trigger failed"));
  });

  it("a read-only sidecar directory never reaches the flow; the failure is logged", async () => {
    const h = await harness({ inline: true });
    const learn = join(h.ws, ".stratum", "learn");
    await mkdir(learn, { recursive: true });
    await chmod(learn, 0o555);
    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const planned = await h.engine.plan(ONE_STEP(), {}, { workspaceRoot: h.ws });
      statuses.push((await h.engine.stepDone(planned.runId, "plan", { output: { outcome: "done" } })).status);
    }
    expect(statuses).toEqual(["failed", "failed", "failed"]);
    const last = (await rows(h)).at(-1)!;
    expect(last.problems.join("\n")).toMatch(/EACCES|permission/i);
  });
});
