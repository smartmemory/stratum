import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { applyCandidate } from "../../src/learn/apply.js";
import { appendCandidates, authorCandidate, type PatchCandidate } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvestStepId, LESSONS_HEADING } from "../../src/learn/deliver.js";
import { harvest } from "../../src/learn/harvest.js";
import { appendLifecycle } from "../../src/learn/lifecycle.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

// Real guard ledger + filesystem round trips; slow under machine load, not in logic.
vi.setConfig({ testTimeout: 20_000 });

const temporaries: string[] = [];
afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  vi.unstubAllEnvs();
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), "learn-deliver-"));
  temporaries.push(root);
  setGuardsDir(join(root, "guards"));
  const store = join(root, "flows");
  await mkdir(store);
  // Never the developer's real user config; the project layer is `root/stratum.toml`.
  vi.stubEnv("STRATUM_CONFIG_FILE", join(root, "no-user-config.toml"));
  vi.stubEnv("STRATUM_LEARN_DELIVER", "");
  return { root, store };
}

const deliverOn = () => vi.stubEnv("STRATUM_LEARN_DELIVER", "1");

type Surface = "ordinary" | "subflow" | "consumer" | "engine";

function spec(surface: Surface, options: { outcome?: string; attempts?: number } = {}) {
  const contracts = { Result: { outcome: options.outcome ?? "complete|failed" } };
  const attempts = options.attempts ?? 1;
  const fanout = (dispatch: "consumer" | "engine") => ({
    version: 1, contracts,
    flows: { entry: "main", main: { input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
      steps: [{ id: "fan", attempts, fanout: {
        over: "${input.items}", dispatch, concurrency: 1, isolation: "none", require: "all", merge: "sequential",
        steps: [{ do: "item ${item}", out: "Result", attempts }],
      } }] } },
  });
  if (surface === "consumer") return fanout("consumer");
  if (surface === "engine") return fanout("engine");
  if (surface === "subflow") {
    return { version: 1, contracts, flows: {
      entry: "main",
      main: { input: {}, output: { from: "${wrap.output}", contract: "Result" }, steps: [{ id: "wrap", run: "child", with: {} }] },
      child: { input: {}, output: { from: "${work.output}", contract: "Result" }, steps: [{ id: "work", do: "work it", out: "Result", attempts }] },
    } };
  }
  return { version: 1, contracts, flows: { entry: "main", main: { input: {}, output: { from: "${plan.output}", contract: "Result" },
    steps: [{ id: "plan", do: "plan it", out: "Result", attempts }] } } };
}

const INPUT = { ordinary: {}, subflow: {}, consumer: { items: ["a"] }, engine: { items: ["a"] } } as const;
const DISPATCH_ID = { ordinary: "plan", subflow: "wrap/work", consumer: "fan/0", engine: "fan/0" } as const;
const RAW_DO = { ordinary: "plan it", subflow: "work it", consumer: "item a", engine: "item a" } as const;
/** What the matcher computes for each surface — must equal what the harvester records. */
const MATCH_ID = {
  ordinary: harvestStepId("plan"), subflow: harvestStepId("work", "wrap"),
  consumer: harvestStepId("fan"), engine: harvestStepId("fan"),
} as const;

interface Subject {
  engine: ReturnType<typeof tokenEchoingEngine>;
  store: StateStore;
  prompts: string[];
}

function subject(storeRoot: string, reply: () => unknown): Subject {
  const prompts: string[] = [];
  const engine = tokenEchoingEngine(new StratumEngine({
    stateRoot: storeRoot, evaluator: createEvaluator(),
    connector: async ({ prompt }) => { prompts.push(prompt); return { output: reply() }; },
  }));
  return { engine, store: new StateStore(storeRoot), prompts };
}

/** Plan one run and drive it until `DISPATCH_ID` has been issued; returns the issued `do`. */
async function issue(s: Subject, surface: Surface, root: string, body = spec(surface)): Promise<{ runId: string; do: string; dispatchToken?: string }> {
  const planned = await s.engine.plan(body, INPUT[surface], { workspaceRoot: root });
  if (surface === "engine") {
    await expect.poll(() => s.prompts.length).toBeGreaterThan(0);
    // The engine drives the item to completion in the background; let it settle so the
    // run file is final before assertions and teardown.
    await expect.poll(async () => ["completed", "failed"].includes((await s.engine.audit(planned.runId)).status)).toBe(true);
    return { runId: planned.runId, do: s.prompts.at(-1)! };
  }
  if (planned.status !== "ready") throw new Error(`expected ready, got ${planned.status}`);
  const entry = planned.ready.find((ready) => ready.id === DISPATCH_ID[surface]);
  if (!entry) throw new Error(`no ${DISPATCH_ID[surface]} in ${JSON.stringify(planned.ready)}`);
  return { runId: planned.runId, do: entry.do, dispatchToken: entry.dispatchToken };
}

async function persisted(s: Subject, runId: string): Promise<PersistedRun> {
  return s.store.load(runId);
}

function pinnedState(run: PersistedRun, surface: Surface) {
  if (surface === "ordinary") return run.steps.plan!;
  if (surface === "subflow") return run.steps.wrap!.sub!.steps.work!;
  return run.steps.fan!.fanout!.items[0]!;
}

const ISSUING_EVENT = { ordinary: "ready", subflow: "ready", consumer: "fanout_item_ready", engine: "fanout_item_dispatched" } as const;
function issuingEvents(run: PersistedRun, surface: Surface) {
  return run.events.filter((event) => event.type === ISSUING_EVENT[surface]
    && (surface === "subflow" ? event.stepId === "wrap/work" : true));
}

/**
 * Fail a real dispatch on the enum contract, harvest it, and apply the resulting lesson —
 * the full round trip whose step id the matcher must reproduce.
 */
async function learnFrom(surface: Surface, root: string, store: string): Promise<PatchCandidate> {
  const s = subject(store, () => ({ outcome: "done" }));
  const { runId, dispatchToken } = await issue(s, surface, root);
  if (surface !== "engine") await s.engine.stepDone(runId, DISPATCH_ID[surface], { output: { outcome: "done" } }, dispatchToken);
  await expect.poll(async () => (await s.engine.audit(runId)).status).toBe("failed");
  const { records } = await harvest(store);
  const failures = records.filter((record) => record.reason.includes("invalid_enum_value"));
  // harvestStepId round trip: the dispatch's own failure is harvested under exactly the id
  // the matcher computes. A subflow failure is ALSO echoed onto the parent `run` step by
  // failParentRunStep (a harvester precision gap, recorded as a follow-up); that echo is
  // never a dispatch, so it is the only other id allowed.
  expect(failures.map((record) => record.stepId)).toContain(MATCH_ID[surface]);
  const allowed: (string | null)[] = surface === "subflow" ? [MATCH_ID[surface], "wrap"] : [MATCH_ID[surface]];
  for (const record of failures) expect(allowed).toContain(record.stepId);
  const cluster = classify(records, { minRuns: 1, minPairs: 1 })
    .find((c) => c.class === "durable" && c.applyEligible && c.contract.code === "invalid_enum_value"
      && c.scope.stepIds.includes(MATCH_ID[surface]))!;
  expect(cluster).toBeDefined();
  const candidate = authorCandidate(cluster);
  expect(candidate.rendered.guidance).toBeDefined();
  await appendCandidates(root, [candidate]);
  await applyCandidate(candidate, { enabled: true });
  return candidate;
}

const block = (guidance: string) => `\n\n${LESSONS_HEADING}\n- ${guidance}`;

describe("DELIVER-1 D3/D4 engine delivery", () => {
  it.each(["ordinary", "subflow", "consumer", "engine"] as const)(
    "%s: the harvested lesson is pinned at issuance and rendered into the dispatched prompt",
    async (surface) => {
      const { root, store } = await workspace();
      const lesson = await learnFrom(surface, root, store);
      deliverOn();
      const s = subject(store, () => ({ outcome: "complete" }));
      const issued = await issue(s, surface, root);
      expect(issued.do).toBe(RAW_DO[surface] + block(lesson.rendered.guidance!));
      const run = await persisted(s, issued.runId);
      expect(pinnedState(run, surface).lessons).toEqual([
        { revisionId: lesson.revisionId, clusterId: lesson.clusterId, guidance: lesson.rendered.guidance },
      ]);
      expect(issuingEvents(run, surface)[0]!.detail).toMatchObject({ lessons: [lesson.revisionId] });
    },
  );

  it("background ready-step: the connector receives the pinned block in its prompt", async () => {
    const { root, store } = await workspace();
    const lesson = await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const { runId } = await s.engine.flowRunBg(spec("ordinary"), {}, { workspaceRoot: root });
    await expect.poll(async () => (await s.engine.audit(runId)).status).toBe("completed");
    expect(s.prompts).toEqual(["plan it" + block(lesson.rendered.guidance!)]);
  });

  it("OFF (the default): nothing is pinned, rendered or recorded even with an applied lesson", async () => {
    const { root, store } = await workspace();
    await learnFrom("ordinary", root, store);
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root);
    expect(issued.do).toBe("plan it");
    const raw = await readFile(join(store, `${issued.runId}.json`), "utf8");
    expect(raw).not.toContain("lessons");
  });

  it("ON with no selection: persisted run is identical in shape to OFF", async () => {
    const { root, store } = await workspace();
    const normalize = (raw: string) => raw
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<at>")
      .replace(/"runId":"[^"]*"|"id":"[^"]*"/g, "<id>");
    const s = subject(store, () => ({ outcome: "complete" }));
    const off = await issue(s, "ordinary", root);
    deliverOn();
    const on = await issue(s, "ordinary", root);
    expect(on.do).toBe(off.do);
    const offRaw = normalize(await readFile(join(store, `${off.runId}.json`), "utf8"));
    const onRaw = normalize(await readFile(join(store, `${on.runId}.json`), "utf8"));
    expect(onRaw).toBe(offRaw);
  });

  it("an invalid [learn] value resolves OFF and never fails the flow", async () => {
    const { root, store } = await workspace();
    await learnFrom("ordinary", root, store);
    await writeFile(join(root, "stratum.toml"), "[learn]\ndeliver = \"yes please\"\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root);
    expect(issued.do).toBe("plan it");
    expect(warn.mock.calls.flat().join("\n")).toContain("learn.deliver");
    warn.mockRestore();
  });

  it("pin at issuance: retiring the lesson after issuance does not change the rendered prompt", async () => {
    const { root, store } = await workspace();
    const lesson = await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root);
    await appendLifecycle(root, { clusterId: lesson.clusterId, kind: "retire", reason: "fixed", withdrawn: true });
    const resumed = await s.engine.resume(issued.runId);
    if (resumed.status !== "ready") throw new Error("expected ready");
    expect(resumed.ready[0]!.do).toBe(issued.do);
    expect(resumed.ready[0]!.do).toContain(lesson.rendered.guidance!);
  });

  it("a retry re-selects: a lesson retired before the re-issue is not delivered again", async () => {
    const { root, store } = await workspace();
    const lesson = await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root, spec("ordinary", { attempts: 2 }));
    expect(issued.do).toContain(lesson.rendered.guidance!);
    await appendLifecycle(root, { clusterId: lesson.clusterId, kind: "retire", reason: "fixed", withdrawn: true });
    const retry = await s.engine.stepDone(issued.runId, "plan", { output: { outcome: "done" } });
    if (retry.status !== "ready") throw new Error(`expected a retry, got ${retry.status}`);
    expect(retry.ready[0]!.do).toBe("plan it");
    const run = await persisted(s, issued.runId);
    expect(run.steps.plan!.lessons).toBeUndefined();
    expect(issuingEvents(run, "ordinary").map((event) => (event.detail as { lessons?: string[] }).lessons))
      .toEqual([[lesson.revisionId], undefined]);
  });

  it("checkpoint restore is a fresh issuance: the restored pin is discarded and re-selected", async () => {
    const { root, store } = await workspace();
    const lesson = await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root);
    await s.engine.commit(issued.runId, "cp");
    await appendLifecycle(root, { clusterId: lesson.clusterId, kind: "retire", reason: "fixed", withdrawn: true });
    const reverted = await s.engine.revert(issued.runId, "cp");
    expect(reverted).toMatchObject({ status: "ready", ready: [{ id: "plan", do: "plan it" }] });
    expect((await persisted(s, issued.runId)).steps.plan!.lessons).toBeUndefined();
    // And the other direction: a lesson reactivated before restore is pinned by it.
    await s.engine.commit(issued.runId, "cp2");
    await appendLifecycle(root, { clusterId: lesson.clusterId, kind: "reactivate", reason: "back" });
    const again = await s.engine.revert(issued.runId, "cp2");
    expect(again).toMatchObject({ status: "ready", ready: [{ id: "plan", do: "plan it" + block(lesson.rendered.guidance!) }] });
  });

  it("contract drift suppresses the lesson and records contract-changed on the pin and event", async () => {
    const { root, store } = await workspace();
    const lesson = await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const issued = await issue(s, "ordinary", root, spec("ordinary", { outcome: "complete|failed|skipped" }));
    expect(issued.do).toBe("plan it");
    const run = await persisted(s, issued.runId);
    const suppressed = [{ revisionId: lesson.revisionId, reason: "contract-changed" }];
    expect(run.steps.plan).toMatchObject({ lessonsSuppressed: suppressed });
    expect(run.steps.plan!.lessons).toBeUndefined();
    expect(issuingEvents(run, "ordinary")[0]!.detail).toEqual({ attempt: 1, lessonsSuppressed: suppressed });
  });

  it("a run without workspaceRoot is never delivered to", async () => {
    const { root, store } = await workspace();
    await learnFrom("ordinary", root, store);
    deliverOn();
    const s = subject(store, () => ({ outcome: "complete" }));
    const planned = await s.engine.plan(spec("ordinary"), {});
    if (planned.status !== "ready") throw new Error("expected ready");
    expect(planned.ready[0]!.do).toBe("plan it");
  });
});
