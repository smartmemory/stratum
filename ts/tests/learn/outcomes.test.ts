import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { applyCandidate } from "../../src/learn/apply.js";
import { appendCandidates, authorCandidate, type PatchCandidate } from "../../src/learn/candidate.js";
import { classify } from "../../src/learn/classify.js";
import { harvest } from "../../src/learn/harvest.js";
import { appendLifecycle } from "../../src/learn/lifecycle.js";
import { lessonOutcomes, lessonReviews } from "../../src/learn/outcomes.js";
import { tokenEchoingEngine } from "../helpers/token_echoing_engine.js";

vi.setConfig({ testTimeout: 30_000 });

const temporaries: string[] = [];
afterEach(async () => {
  setGuardsDir(GUARDS_DIR);
  vi.unstubAllEnvs();
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

function spec(options: { attempts?: number; outcome?: string } = {}) {
  return {
    version: 1, contracts: { Result: { outcome: options.outcome ?? "complete|failed" } },
    flows: { entry: "main", main: { input: {}, output: { from: "${plan.output}", contract: "Result" }, max_rounds: 1,
      steps: [{ id: "plan", do: "plan it", out: "Result", attempts: options.attempts ?? 2 }] } },
  };
}
const FANOUT = {
  version: 1, contracts: { Result: { outcome: "complete|failed" } },
  flows: { entry: "main", main: { input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
    steps: [{ id: "fan", attempts: 2, fanout: { over: "${input.items}", dispatch: "consumer", concurrency: 2, isolation: "none",
      require: "all", merge: "sequential", steps: [{ do: "item ${item}", out: "Result", attempts: 2 }] } }] } },
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "learn-outcomes-"));
  temporaries.push(dir);
  setGuardsDir(join(dir, "guards"));
  const ws = join(dir, "ws");
  const store = join(dir, "flows");
  await mkdir(ws);
  await mkdir(store);
  vi.stubEnv("STRATUM_CONFIG_FILE", join(dir, "no-user-config.toml"));
  vi.stubEnv("STRATUM_LEARN_INLINE", "");
  vi.stubEnv("STRATUM_LEARN_DELIVER", "");
  const engine = tokenEchoingEngine(new StratumEngine({ stateRoot: store, evaluator: createEvaluator() }));
  // Evidence: fail the `plan` step and the `fan` items, then apply a lesson per step id.
  const evidence = await engine.plan(spec({ attempts: 1 }), {}, { workspaceRoot: ws });
  await engine.stepDone(evidence.runId, "plan", { output: { outcome: "done" } });
  const { records } = await harvest(store);
  const cluster = classify(records, { minRuns: 1, minPairs: 1 })
    .find((c) => c.class === "durable" && c.applyEligible && c.contract.code === "invalid_enum_value")!;
  const lesson = authorCandidate(cluster);
  await appendCandidates(ws, [lesson]);
  await applyCandidate(lesson, { enabled: true });
  vi.stubEnv("STRATUM_LEARN_DELIVER", "1");
  const offered = async (body: object = spec(), input: object = {}) => {
    const planned = await engine.plan(body, input, { workspaceRoot: ws });
    if (planned.status !== "ready") throw new Error(`expected ready, got ${planned.status}`);
    expect(planned.ready[0]!.do).toContain(lesson.rendered.guidance!);
    return planned;
  };
  return { dir, ws, store, engine, lesson, offered, evidenceRun: evidence.runId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const outcomeOf = async (s: Setup, runId: string) =>
  (await lessonOutcomes(s.store, s.ws)).filter((o) => o.runId === runId).map(({ stepId, outcome }) => ({ stepId, outcome }));

describe("lessonOutcomes (D6)", () => {
  it("held: a terminal run whose offered step then succeeded", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "complete" } });
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "held" }]);
    expect(await outcomeOf(s, s.evidenceRun)).toEqual([]);
  });

  it("not-holding: a failure in the lesson's cluster after the offer, even before the run is terminal", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    expect((await s.engine.audit(p.runId)).status).toBe("running");
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "not-holding" }]);
  });

  it("an unrelated failure after the offer is not the lesson failing", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "complete", extra: 1 } });
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "complete" } });
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "held" }]);
  });

  it("unknown: an offer cancelled before the step answered", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.flowCancel(p.runId, "stop");
    expect((await s.engine.audit(p.runId)).status).toBe("cancelled");
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "unknown" }]);
  });

  it("orders by event index: a failure sharing (or even preceding) the offer's timestamp at a later index is not-holding", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    const path = join(s.store, `${p.runId}.json`);
    const run = JSON.parse(await readFile(path, "utf8"));
    const offerAt = run.events.find((e: { type: string }) => e.type === "ready").at;
    const failure = run.events.find((e: { type: string; detail?: { failure?: unknown } }) => e.type === "result" && e.detail?.failure);
    for (const at of [offerAt, "2000-01-01T00:00:00.000Z"]) {
      failure.at = at;
      await writeFile(path, JSON.stringify(run));
      expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "not-holding" }]);
    }
  });

  it("unknown: a non-terminal fan-out with one successful item and one pending", async () => {
    const s = await setup();
    // The fan-out lesson: same contract, step id `fan`; the step-agnostic lesson matches it.
    const p = await s.offered(FANOUT, { items: ["a", "b"] });
    await s.engine.stepDone(p.runId, "fan/0", { output: { outcome: "complete" } }, p.ready[0]!.dispatchToken);
    expect((await s.engine.audit(p.runId)).status).toBe("running");
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "fan", outcome: "unknown" }]);
  });

  it("checkpoint-reset attempts count as nothing", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.commit(p.runId, "cp");
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "not-holding" }]);
    await s.engine.revert(p.runId, "cp");
    expect(await outcomeOf(s, p.runId)).toEqual([{ stepId: "plan", outcome: "unknown" }]);
  });
});

// A step `ship` (the one Compose intercepts) under a wider `Wide` contract on a
// different field (`verdict`, not `outcome`), so the ship lesson and the plan lesson
// never hold on each other's steps and their notes carry different subjects —
// subset-marginal-gain refuses a second note about `main/outcome`.
const SHIP = {
  version: 1, contracts: { Wide: { verdict: "complete|failed|done" } },
  flows: { entry: "main", main: { input: {}, output: { from: "${ship.output}", contract: "Wide" },
    steps: [{ id: "ship", do: "ship it", out: "Wide", attempts: 2 }] } },
};

async function shipLesson(s: Setup): Promise<PatchCandidate> {
  const evidence = await s.engine.plan(SHIP, {}, { workspaceRoot: s.ws });
  await s.engine.stepDone(evidence.runId, "ship", { output: { verdict: "bad" } });
  const { records } = await harvest(s.store);
  const cluster = classify(records, { minRuns: 1, minPairs: 1 })
    .find((c) => c.class === "durable" && c.applyEligible && c.scope.stepIds.includes("ship"))!;
  const lesson = authorCandidate(cluster);
  await appendCandidates(s.ws, [lesson]);
  await applyCandidate(lesson, { enabled: true });
  return lesson;
}

const shipOffered = async (s: Setup, ship: PatchCandidate) => {
  const planned = await s.engine.plan(SHIP, {}, { workspaceRoot: s.ws });
  if (planned.status !== "ready") throw new Error(`expected ready, got ${planned.status}`);
  expect(planned.ready[0]!.do).toContain(ship.rendered.guidance!);
  return planned;
};

describe("lessonReviews (D6)", () => {
  const kinds = async (s: Setup, retireReviewAfter = 3) =>
    (await lessonReviews(s.store, s.ws, { retireReviewAfter })).map((r) => r.kind).sort();

  async function heldRun(s: Setup) {
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "complete" } });
  }

  it("retire-candidate after N held runs; an ack closes it; newer held runs reopen it", async () => {
    const s = await setup();
    await heldRun(s);
    await heldRun(s);
    expect(await kinds(s)).toEqual([]);
    await heldRun(s);
    const [review] = await lessonReviews(s.store, s.ws, { retireReviewAfter: 3 });
    expect(review).toMatchObject({ kind: "retire-candidate", clusterId: s.lesson.clusterId, revisionId: s.lesson.revisionId });
    expect(review!.runs).toHaveLength(3);
    await tick();
    await appendLifecycle(s.ws, { clusterId: s.lesson.clusterId, kind: "ack", reason: "keep it", ackKinds: ["retire-candidate"] });
    expect(await kinds(s)).toEqual([]);
    await tick();
    for (let i = 0; i < 3; i += 1) await heldRun(s);
    expect(await kinds(s)).toEqual(["retire-candidate"]);
  });

  it("not-holding is raised on one failing run and blocks retire-candidate until acknowledged", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i += 1) await heldRun(s);
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    expect(await kinds(s)).toEqual(["not-holding"]);
    await tick();
    await appendLifecycle(s.ws, { clusterId: s.lesson.clusterId, kind: "ack", reason: "looked", ackKinds: ["not-holding"] });
    expect(await kinds(s)).toEqual([]);
  });

  it.each(["not-holding", "retire-candidate"] as const)("a retry failure after a %s ack reopens or blocks the review", async (kind) => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    expect(await kinds(s)).toEqual(["not-holding"]);
    await tick();
    const ack = await appendLifecycle(s.ws, {
      clusterId: s.lesson.clusterId, kind: "ack", reason: "looked", ackKinds: [kind],
    });
    const [firstFailure] = (await lessonOutcomes(s.store, s.ws)).filter((o) => o.runId === p.runId);
    expect(firstFailure!.at <= ack.at).toBe(true);
    if (kind === "not-holding") expect(await kinds(s)).toEqual([]);
    await tick();
    if (kind === "retire-candidate") {
      for (let i = 0; i < 3; i += 1) await heldRun(s);
      expect(await kinds(s)).toEqual(["not-holding", "retire-candidate"]);
    }
    // Cross the millisecond watermark before the retry stamps its failure event.
    do { await tick(); } while (Date.now() <= Date.parse(ack.at));
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    const [outcome] = (await lessonOutcomes(s.store, s.ws)).filter((o) => o.runId === p.runId);
    expect(outcome?.outcome).toBe("not-holding");
    expect(outcome!.at > ack.at).toBe(true);
    expect(await kinds(s)).toEqual(["not-holding"]);
  });

  it("skips non-object store JSON without losing valid outcomes or reviews", async () => {
    const s = await setup();
    const p = await s.offered();
    await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    const outcomes = await lessonOutcomes(s.store, s.ws);
    const reviews = await lessonReviews(s.store, s.ws, { retireReviewAfter: 3 });
    expect(reviews).toHaveLength(1);
    for (const [i, value] of [null, false, 42, "text", []].entries()) {
      await writeFile(join(s.store, `invalid-${i}.json`), JSON.stringify(value));
    }
    expect(await lessonOutcomes(s.store, s.ws)).toEqual(outcomes);
    expect(await lessonReviews(s.store, s.ws, { retireReviewAfter: 3 })).toEqual(reviews);
  });

  it("contract-changed is raised from a D3 suppression and closes on ack", async () => {
    const s = await setup();
    const drifted = await s.engine.plan(spec({ outcome: "complete|failed|skipped" }), {}, { workspaceRoot: s.ws });
    if (drifted.status !== "ready") throw new Error("expected ready");
    expect(drifted.ready[0]!.do).toBe("plan it");
    expect(await kinds(s)).toEqual(["contract-changed"]);
    await tick();
    await appendLifecycle(s.ws, { clusterId: s.lesson.clusterId, kind: "ack", reason: "spec widened on purpose" });
    expect(await kinds(s)).toEqual([]);
  });

  it("recurred-after-retirement: a retired cluster that fails again, closed by ack, reopened by newer evidence", async () => {
    const s = await setup();
    await tick();
    await appendLifecycle(s.ws, { clusterId: s.lesson.clusterId, kind: "retire", reason: "fixed", fixRef: "abc1234" });
    expect(await kinds(s)).toEqual([]);
    await tick();
    vi.stubEnv("STRATUM_LEARN_DELIVER", "");
    const fail = async () => {
      const p = await s.engine.plan(spec({ attempts: 1 }), {}, { workspaceRoot: s.ws });
      await s.engine.stepDone(p.runId, "plan", { output: { outcome: "done" } });
    };
    await fail();
    expect(await kinds(s)).toEqual(["recurred-after-retirement"]);
    await tick();
    await appendLifecycle(s.ws, { clusterId: s.lesson.clusterId, kind: "ack", reason: "tracking", ackKinds: ["recurred-after-retirement"] });
    expect(await kinds(s)).toEqual([]);
    await tick();
    await fail();
    expect(await kinds(s)).toEqual(["recurred-after-retirement"]);
  });

  it("uses the configured threshold", async () => {
    const s = await setup();
    await heldRun(s);
    expect(await kinds(s, 1)).toEqual(["retire-candidate"]);
  });

  it("caveats a not-holding review whose contributing offers went to the intercepted step", async () => {
    const s = await setup();
    const ship = await shipLesson(s);
    const planned = await s.engine.plan({
      version: 1,
      contracts: { Result: { outcome: "complete|failed" }, Wide: { verdict: "complete|failed|done" } },
      flows: { entry: "main", main: { input: {}, output: { from: "${plan.output}", contract: "Result" }, max_rounds: 1,
        steps: [
          { id: "plan", do: "plan it", out: "Result", attempts: 2 },
          { id: "ship", do: "ship it", out: "Wide", attempts: 2 },
        ] } },
    }, {}, { workspaceRoot: s.ws });
    if (planned.status !== "ready") throw new Error(`expected ready, got ${planned.status}`);
    expect(planned.ready.find((r) => r.id === "ship")!.do).toContain(ship.rendered.guidance!);
    await s.engine.stepDone(planned.runId, "plan", { output: { outcome: "done" } });
    await s.engine.stepDone(planned.runId, "ship", { output: { verdict: "bad" } });
    const reviews = await lessonReviews(s.store, s.ws, { retireReviewAfter: 3 });
    const shipReview = reviews.find((r) => r.clusterId === ship.clusterId);
    const planReview = reviews.find((r) => r.clusterId === s.lesson.clusterId);
    expect(shipReview?.kind).toBe("not-holding");
    expect(shipReview?.detail).toContain(`(offered to step "ship", which Compose runs in-process: offered, not delivered)`);
    expect(planReview?.kind).toBe("not-holding");
    expect(planReview?.detail).not.toContain("offered, not delivered");
  });

  it("caveats a retire-candidate review whose contributing offers went to the intercepted step", async () => {
    const s = await setup();
    const ship = await shipLesson(s);
    for (let i = 0; i < 3; i += 1) {
      const p = await shipOffered(s, ship);
      await s.engine.stepDone(p.runId, "ship", { output: { verdict: "done" } });
      await heldRun(s);
    }
    const reviews = await lessonReviews(s.store, s.ws, { retireReviewAfter: 3 });
    const shipReview = reviews.find((r) => r.clusterId === ship.clusterId);
    const planReview = reviews.find((r) => r.clusterId === s.lesson.clusterId);
    expect(shipReview?.kind).toBe("retire-candidate");
    expect(shipReview?.detail).toContain(`(offered to step "ship", which Compose runs in-process: offered, not delivered)`);
    expect(planReview?.kind).toBe("retire-candidate");
    expect(planReview?.detail).not.toContain("offered, not delivered");
  });
});
