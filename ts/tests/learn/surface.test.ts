import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { learnCommand } from "../../src/cli/learn.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { applyCandidate, revertApply } from "../../src/learn/apply.js";
import { appendCandidates, authorCandidate, type PatchCandidate } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvest } from "../../src/learn/harvest.js";
import { appendLifecycle } from "../../src/learn/lifecycle.js";
import { unreviewedLessons } from "../../src/learn/unreviewed.js";

vi.setConfig({ testTimeout: 30_000 });

const temporaries: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  setGuardsDir(GUARDS_DIR);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "learn-surface-"));
  temporaries.push(dir);
  setGuardsDir(join(dir, "guards"));
  const ws = join(dir, "ws");
  const store = join(dir, "flows");
  await mkdir(ws);
  await mkdir(store);
  vi.stubEnv("STRATUM_CONFIG_FILE", join(dir, "no-user-config.toml"));
  vi.stubEnv("STRATUM_LEARN_INLINE", "");
  vi.stubEnv("STRATUM_LEARN_DELIVER", "");
  const server = await createMcpServer({ flowStateRoot: store });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "learn-surface", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text?: string }>; isError?: boolean };
    const body = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    if (result.isError || body.status === "error") throw new Error(`${name}: ${JSON.stringify(body)}`);
    return body;
  };
  return { dir, ws, store, call };
}

const SPEC = {
  version: 1, contracts: { Result: { outcome: "complete|failed" } },
  flows: { entry: "main", main: { input: {}, output: { from: "${plan.output}", contract: "Result" }, steps: [{ id: "plan", do: "plan it", out: "Result", attempts: 1 }] } },
};

type Setup = Awaited<ReturnType<typeof setup>>;

/** A failing run through MCP, harvested into one staged candidate for this workspace. */
async function stagedLesson(s: Setup): Promise<PatchCandidate> {
  const planned = await s.call("stratum_plan", { spec: SPEC, input: {}, workspaceRoot: s.ws });
  const token = (planned.ready as Array<{ dispatchToken: string }>)[0]!.dispatchToken;
  await s.call("stratum_step_done", { runId: planned.runId, stepId: "plan", dispatchToken: token, result: { output: { outcome: "done" } } });
  const { records } = await harvest(s.store);
  const cluster = classify(records, { minRuns: 1, minPairs: 1 }).find((c) => c.class === "durable" && c.applyEligible && c.contract.code === "invalid_enum_value")!;
  const candidate = authorCandidate(cluster);
  await appendCandidates(s.ws, [candidate]);
  return candidate;
}

describe("unreviewedLessons (INLINE-TS-1 §A5)", () => {
  it("shows a staged lesson until it is applied, dismissed or retired — recomputed every call", async () => {
    const s = await setup();
    const lesson = await stagedLesson(s);
    const listed = [{ clusterId: lesson.clusterId, revisionId: lesson.revisionId, claim: lesson.claim, guidance: lesson.rendered.guidance }];
    expect(await unreviewedLessons(s.ws)).toEqual(listed);
    const { applyId } = await applyCandidate(lesson, { enabled: true });
    expect(await unreviewedLessons(s.ws)).toEqual([]);
    await revertApply(applyId, s.ws, { enabled: true });
    expect(await unreviewedLessons(s.ws)).toEqual(listed);
    await appendLifecycle(s.ws, { clusterId: lesson.clusterId, kind: "dismiss", reason: "not useful" });
    expect(await unreviewedLessons(s.ws)).toEqual([]);
    await appendLifecycle(s.ws, { clusterId: lesson.clusterId, kind: "reactivate", reason: "reconsidered" });
    expect(await unreviewedLessons(s.ws)).toEqual(listed);
    await appendLifecycle(s.ws, { clusterId: lesson.clusterId, kind: "retire", reason: "fixed", fixRef: "abc1234" });
    expect(await unreviewedLessons(s.ws)).toEqual([]);
  });

  it("throws on an unreadable lifecycle log so callers choose to fail or omit", async () => {
    const s = await setup();
    await stagedLesson(s);
    await mkdir(join(s.ws, ".stratum", "learn", "lifecycle.jsonl"));
    await expect(unreviewedLessons(s.ws)).rejects.toThrow();
  });
});

describe("stratum learn list --unreviewed", () => {
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    try { return { code: await learnCommand(args), out: writes.join("") }; } finally { spy.mockRestore(); }
  }

  it("--if-enabled prints nothing while the switch is OFF, even with a populated sidecar", async () => {
    const s = await setup();
    await stagedLesson(s);
    expect(await run(["list", "--unreviewed", "--json", "--if-enabled", "--root", s.ws])).toEqual({ code: 0, out: "" });
  });

  it("answers without --if-enabled, and with it once the switch is on; reports the winning layer", async () => {
    const s = await setup();
    const lesson = await stagedLesson(s);
    const plain = await run(["list", "--unreviewed", "--root", s.ws]);
    expect(plain.out).toContain("inline: off (default)");
    expect(plain.out).toContain(lesson.revisionId.slice(0, 12));
    await writeFile(join(s.ws, "stratum.toml"), "[learn]\ninline = true\n");
    const json = await run(["list", "--unreviewed", "--json", "--if-enabled", "--root", s.ws]);
    expect(JSON.parse(json.out)).toEqual([expect.objectContaining({ revisionId: lesson.revisionId })]);
    expect((await run(["list", "--unreviewed", "--root", s.ws])).out).toContain(`inline: on (project: ${join(s.ws, "stratum.toml")})`);
  });
});

describe("MCP surface carries the new fields through the strict contracts", () => {
  it("stratum_audit includes learn_inline when on and unreviewed lessons exist; absent when off", async () => {
    const s = await setup();
    const lesson = await stagedLesson(s);
    const planned = await s.call("stratum_plan", { spec: SPEC, input: {}, workspaceRoot: s.ws });
    expect(await s.call("stratum_audit", { runId: planned.runId })).not.toHaveProperty("learn_inline");
    vi.stubEnv("STRATUM_LEARN_INLINE", "1");
    const audit = await s.call("stratum_audit", { runId: planned.runId });
    expect(audit.learn_inline).toEqual({ unreviewed: [
      { clusterId: lesson.clusterId, revisionId: lesson.revisionId, claim: lesson.claim, guidance: lesson.rendered.guidance },
    ] });
  });

  it("with delivery ON, the lesson-bearing ready event passes audit and flow_poll event contracts", async () => {
    const s = await setup();
    const lesson = await stagedLesson(s);
    await applyCandidate(lesson, { enabled: true });
    vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
    const planned = await s.call("stratum_plan", { spec: SPEC, input: {}, workspaceRoot: s.ws });
    expect((planned.ready as Array<{ do: string }>)[0]!.do).toContain(lesson.rendered.guidance!);
    const audit = await s.call("stratum_audit", { runId: planned.runId });
    const ready = (audit.events as Array<{ type: string; detail?: { lessons?: string[] } }>).filter((event) => event.type === "ready");
    expect(ready.at(-1)!.detail!.lessons).toEqual([lesson.revisionId]);
    await s.call("stratum_flow_poll", { runId: planned.runId, cursor: 0 });
  });
});
