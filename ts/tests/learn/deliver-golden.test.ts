import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learnCommand } from "../../src/cli/learn.js";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { readJournal } from "../../src/learn/apply.js";
import { readCandidates, type PatchCandidate } from "../../src/learn/candidate.js";
import { LESSONS_HEADING } from "../../src/learn/deliver.js";
import { canonicalWorkspace } from "../../src/learn/workspace.js";

/**
 * DELIVER-1 D7 stratum golden: failures → automatic staging → CLI apply → the next run's
 * prompt carries the approved guidance and passes first time → retire → it fails again.
 * One connector policy for the whole test (r1 #12): a first attempt answers `done` unless its
 * prompt carries the guidance; retries and guided attempts answer `complete`. That proves the
 * mechanics, not that a real model follows the guidance (the live run's job).
 */

vi.setConfig({ testTimeout: 60_000 });

const temporaries: string[] = [];
afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const GUIDED = "must be exactly one of";

function spec(options: { flow?: string; outcome?: string; out?: string; stepId?: string } = {}) {
  const flow = options.flow ?? "build";
  const stepId = options.stepId ?? "plan";
  return {
    version: 1,
    contracts: { Result: { outcome: options.outcome ?? "complete|failed|skipped" }, Other: { value: "string" } },
    flows: { entry: flow, [flow]: { input: {}, output: { from: `\${${stepId}.output}`, contract: options.out ?? "Result" },
      steps: [{ id: stepId, do: `do ${stepId}`, out: options.out ?? "Result", attempts: 2 }] } },
  };
}

interface Golden {
  ws: string;
  store: string;
  engine: StratumEngine;
  prompts: Array<{ prompt: string; attempt: number }>;
  run: (body?: object) => Promise<{ runId: string; firstPrompt: string; firstAttemptFailed: boolean }>;
  cli: (args: string[]) => Promise<{ code: number; out: string }>;
}

async function golden(reply?: (request: { prompt: string; attempt: number }) => unknown): Promise<Golden> {
  const dir = await mkdtemp(join(tmpdir(), "learn-golden-"));
  temporaries.push(dir);
  setGuardsDir(join(dir, "guards"));
  const raw = join(dir, "ws");
  await mkdir(raw);
  execFileSync("git", ["-C", raw, "init", "-q"]);
  execFileSync("git", ["-C", raw, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const ws = await canonicalWorkspace(raw);
  const store = join(dir, "state", "flows");
  await mkdir(store, { recursive: true });
  vi.stubEnv("STRATUM_CONFIG_FILE", join(dir, "no-user-config.toml"));
  vi.stubEnv("STRATUM_LEARN_DELIVER", "");
  vi.stubEnv("STRATUM_LEARN_INLINE", "");
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "");
  await writeFile(join(ws, "stratum.toml"), "[learn]\ninline = true\n");
  const prompts: Golden["prompts"] = [];
  const policy = reply ?? (({ prompt, attempt }) => ({ outcome: attempt === 1 && !prompt.includes(GUIDED) ? "done" : "complete" }));
  const engine = new StratumEngine({
    stateRoot: store, evaluator: createEvaluator(),
    connector: async ({ prompt, attempt }) => { prompts.push({ prompt, attempt }); return { output: policy({ prompt, attempt }) }; },
  });
  const run: Golden["run"] = async (body = spec()) => {
    const before = prompts.length;
    const { runId } = await engine.flowRunBg(body, {}, { workspaceRoot: ws });
    await expect.poll(async () => ["completed", "failed"].includes((await engine.audit(runId)).status)).toBe(true);
    await engine.learnInlineIdle();
    const steps = (await engine.audit(runId)).steps;
    const step = Object.values(steps)[0]!;
    return { runId, firstPrompt: prompts[before]!.prompt, firstAttemptFailed: step.attempts[0]!.failure !== undefined };
  };
  const cli: Golden["cli"] = async (args) => {
    const writes: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    try { return { code: await learnCommand([...args, "--root", ws]), out: writes.join("") }; } finally { out.mockRestore(); err.mockRestore(); }
  };
  return { ws, store, engine, prompts, run, cli };
}

/** Steps 1–3: three recovered runs → staged automatically → applied through the CLI. */
async function trained(g: Golden, options: { apply?: boolean } = {}): Promise<{ lesson: PatchCandidate; applyId?: string }> {
  for (let i = 0; i < 3; i += 1) {
    const r = await g.run();
    expect(r.firstAttemptFailed).toBe(true);
    expect((await g.engine.audit(r.runId)).status).toBe("completed");
  }
  const staged = (await readCandidates(join(g.ws, ".stratum", "learn"))).filter((c) => c.rendered.guidance !== undefined);
  expect(staged.length).toBeGreaterThan(0);
  const lesson = staged.at(-1)!;
  if (options.apply === false) return { lesson };
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
  expect(await g.cli(["apply", lesson.revisionId])).toMatchObject({ code: 0 });
  vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "");
  const [entry] = await readJournal(g.ws);
  return { lesson, applyId: entry!.applyId };
}

const block = (guidance: string) => `\n\n${LESSONS_HEADING}\n- ${guidance}`;

describe("DELIVER-1 D7 stratum golden", () => {
  it("failures → auto-staged → applied → delivered and passes first time → retired → fails again", async () => {
    const g = await golden();
    // Steps 1–2: nothing is run by hand; the lesson is staged and surfaced as unreviewed.
    for (let i = 0; i < 3; i += 1) expect((await g.run()).firstAttemptFailed).toBe(true);
    const staged = (await readCandidates(join(g.ws, ".stratum", "learn"))).filter((c) => c.rendered.guidance !== undefined);
    expect(staged.length).toBeGreaterThan(0);
    const lesson = staged.at(-1)!;
    const probe = await g.engine.flowRunBg(spec({ flow: "probe" }), {}, { workspaceRoot: g.ws });
    await expect.poll(async () => (await g.engine.audit(probe.runId)).status).not.toBe("running");
    expect((await g.engine.audit(probe.runId)).learn_inline?.unreviewed?.map((u) => u.clusterId)).toContain(lesson.clusterId);

    // Step 3: the owner applies it through the CLI.
    vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
    expect(await g.cli(["apply", lesson.revisionId])).toMatchObject({ code: 0 });
    vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "");

    // Step 4: delivery on; the prompt bytes carry the exact approved guidance and the step passes first time.
    vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
    const guided = await g.run();
    expect(guided.firstPrompt).toBe("do plan" + block(lesson.rendered.guidance!));
    expect(guided.firstAttemptFailed).toBe(false);
    const pinned = (await g.engine.audit(guided.runId)).steps.plan!;
    expect(pinned.lessons).toEqual([{ revisionId: lesson.revisionId, clusterId: lesson.clusterId, guidance: lesson.rendered.guidance }]);
    expect(pinned.attempts).toHaveLength(1);

    // Step 5: control — retire it; the block is gone and the first attempt fails again.
    expect(await g.cli(["retire", lesson.clusterId, "--reason", "golden control", "--withdrawn"])).toMatchObject({ code: 0 });
    const control = await g.run();
    expect(control.firstPrompt).toBe("do plan");
    expect(control.firstAttemptFailed).toBe(true);
  });
});

describe("DELIVER-1 D7 negative golden cases: none are injected", () => {
  const notInjected = (prompt: string) => expect(prompt).not.toContain(LESSONS_HEADING);

  it.each([
    ["a non-matching flow", spec({ flow: "other" })],
    ["a non-matching step (its contract lacks the field)", spec({ stepId: "summarize", out: "Other" })],
    ["a drifted enum set", spec({ outcome: "complete|failed|skipped|partial" })],
    ["a drifted type", spec({ outcome: "string" })],
  ])("%s", async (_name, body) => {
    const g = await golden();
    await trained(g);
    vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
    notInjected((await g.run(body)).firstPrompt);
  });

  it.each([
    ["staged but never applied", async (_g: Golden, _l: PatchCandidate, _a?: string) => {}, false],
    ["reverted", async (g: Golden, _l: PatchCandidate, applyId?: string) => {
      vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
      expect(await g.cli(["revert", applyId!])).toMatchObject({ code: 0 });
    }, true],
    ["retired", async (g: Golden, l: PatchCandidate) => { expect(await g.cli(["retire", l.clusterId, "--reason", "r", "--withdrawn"])).toMatchObject({ code: 0 }); }, true],
    ["dismissed", async (g: Golden, l: PatchCandidate) => { expect(await g.cli(["dismiss", l.clusterId, "--reason", "r"])).toMatchObject({ code: 0 }); }, true],
    ["an edited sidecar row with a changed scope (fails v2 identity)", async (g: Golden, l: PatchCandidate) => {
      const path = join(g.ws, ".stratum", "learn", "candidates.jsonl");
      const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as PatchCandidate);
      const edited = rows.map((row) => row.revisionId === l.revisionId ? { ...row, scope: { ...row.scope, stepIds: [...row.scope.stepIds, "elsewhere"] } } : row);
      await writeFile(path, edited.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }, true],
  ] as const)("%s", async (_name, mutate, apply) => {
    const g = await golden();
    const { lesson, applyId } = await trained(g, { apply });
    await mutate(g, lesson, applyId);
    vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
    const r = await g.run();
    notInjected(r.firstPrompt);
    expect(r.firstAttemptFailed).toBe(true);
  });

  it("a note-only lesson (no derivable guidance) is never injected", async () => {
    // First attempts add an undeclared key: an unrecognized_keys cluster, which has no guidance.
    const g = await golden(({ attempt }) => attempt === 1 ? { outcome: "complete", extra: true } : { outcome: "complete" });
    for (let i = 0; i < 3; i += 1) expect((await g.run()).firstAttemptFailed).toBe(true);
    const staged = await readCandidates(join(g.ws, ".stratum", "learn"));
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((c) => c.rendered.guidance === undefined)).toBe(true);
    vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "1");
    for (const candidate of staged) await g.cli(["apply", candidate.revisionId]);
    vi.stubEnv("STRATUM_LEARN_APPLY_ENABLED", "");
    vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
    notInjected((await g.run()).firstPrompt);
  });
});
