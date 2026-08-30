import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine, type EngineConnector, type JudgeRunner } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { LearnEgress, type LearnEgressFetch, type LearnEgressRuntimeOptions } from "../../src/learn/smartmemory_egress.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
const engines: StratumEngine[] = [];
const egresses: LearnEgress[] = [];

const enabledEnv: NodeJS.ProcessEnv = {
  STRATUM_LEARN_EGRESS: "1",
  SMARTMEMORY_API_URL: "https://memory.test/",
  SMARTMEMORY_API_KEY: "secret",
  SMARTMEMORY_WORKSPACE_ID: "workspace-1",
};

interface WireBody {
  memory_type: string;
  metadata: Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.closeLearnEgress()));
  await Promise.all(egresses.splice(0).map((egress) => egress.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

function linearSpec() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { name: "string" },
        output: { from: "${work.output}", contract: "Result" },
        steps: [{ id: "work", do: "work", out: "Result" }],
      },
    },
  };
}

function fanoutSpec() {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: {
      entry: "main",
      main: {
        input: { items: "string[]" },
        output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result" }],
        } }],
      },
    },
  };
}

async function subject(options: {
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: LearnEgressFetch;
  connector?: EngineConnector;
  judge?: JudgeRunner;
  runtime?: Omit<LearnEgressRuntimeOptions, "env" | "fetchImpl">;
} = {}): Promise<{ root: string; store: StateStore; engine: TokenEchoingEngine }> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "stratum-learn-egress-"));
  if (!roots.includes(root)) roots.push(root);
  const engine = new StratumEngine({
    stateRoot: root,
    evaluator: createEvaluator(),
    ...(options.connector ? { connector: options.connector } : {}),
    ...(options.judge ? { judge: options.judge } : {}),
    learnEgressOptions: {
      env: options.env ?? enabledEnv,
      fetchImpl: options.fetchImpl ?? (async () => new Response("{}", { status: 200 })),
      random: () => 0,
      ...options.runtime,
    },
  });
  engines.push(engine);
  return { root, store: new StateStore(root), engine: tokenEchoingEngine(engine) };
}

async function directEgress(
  store: StateStore,
  engine: StratumEngine,
  options: Omit<LearnEgressRuntimeOptions, "env"> & { env?: NodeJS.ProcessEnv } = {},
): Promise<LearnEgress> {
  const egress = new LearnEgress({
    store,
    withReceiptUpdate: (runId, update) => engine.withReceiptUpdate(runId, update),
    env: options.env ?? enabledEnv,
    ...options,
  });
  egresses.push(egress);
  return egress;
}

async function addReceipt(engine: StratumEngine, options: {
  dispatchId?: string;
  tokens?: number;
  ms?: number;
  model?: string;
} = {}): Promise<string> {
  const planned = await engine.plan(linearSpec(), { name: "Ada" }, { workspaceRoot: "/workspace/project" });
  await engine.usageReport(planned.runId, {
    dispatchId: options.dispatchId ?? "dispatch-1",
    stepId: "work",
    source: "client",
    usage: { tokens: options.tokens ?? 4, ms: options.ms ?? 7 },
    telemetry: { model: options.model ?? "model-x", durationMs: options.ms ?? 7 },
  });
  return planned.runId;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  problem: string,
): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(problem);
}

async function waitForTerminal(engine: StratumEngine, store: StateStore, runId: string): Promise<void> {
  for (let tick = 0; tick < 400; tick += 1) {
    const poll = await engine.flowPoll(runId);
    if (poll.status !== "running") {
      for (let persistedTick = 0; persistedTick < 400; persistedTick += 1) {
        if ((await store.load(runId)).status !== "running") return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("terminal flow was not persisted");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("flow did not finish");
}

describe("LearnEgress", () => {
  it("uses the real engine seam: persists pending before fetch, then marks the receipt sent with the exact wire body", async () => {
    let store!: StateStore;
    let runId = "";
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const setup = await subject({
      fetchImpl: async (input, init = {}) => {
        const persisted = await store.load(runId);
        expect(persisted.receipts?.[0]?.egress).toBe("pending");
        calls.push({ input: String(input), init });
        return new Response(JSON.stringify({ id: "memory-1" }), { status: 200 });
      },
    });
    store = setup.store;
    runId = await addReceipt(setup.engine);
    const before = await store.load(runId);
    const receipt = before.receipts![0]!;

    await setup.engine.closeLearnEgress();

    expect((await store.load(runId)).receipts?.[0]).toMatchObject({ egress: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://memory.test/memory/add");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-Workspace-Id")).toBe("workspace-1");
    expect(headers.get("Content-Type")).toBe("application/json");
    const body = JSON.parse(String(calls[0]?.init.body)) as WireBody;
    {
      const audited = (await store.load(runId)).events.find((event) => event.type === "usage_debit")?.detail;
      expect(body.metadata.detail).toEqual(audited);
      expect(body.metadata.detail).toMatchObject({ attempt: 1, seq: 1, source: expect.any(String), model: expect.any(String) });
    }
    expect(body).toEqual({
      content: "main/work client (model-x): 4 tokens, 7 ms",
      memory_type: "stratum_usage_debit",
      metadata: {
        ...receipt,
        run_id: runId,
        workspace_root: "/workspace/project",
        flow_name: "main",
        spec_digest: before.revisionDigest,
        event_ordinal: receipt.seq,
        receipt_id: `${runId}:${receipt.seq}`,
        origin: "cli:stratum",
      },
      use_pipeline: false,
    });
  });

  it("drains legacy stepDone and judged receipts from the single persist trigger", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const ordinary = await subject({
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    const planned = await ordinary.engine.plan(linearSpec(), { name: "Ada" });
    await ordinary.engine.stepDone(planned.runId, "work", {
      output: { value: "done" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 3 },
    });

    const judged = await subject({
      judge: async () => ({ holds: true, reason: "sound", model: "judge", usage: { tokens: 5 } }),
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    const judgedSpec = linearSpec();
    judgedSpec.flows.main.steps[0] = {
      ...judgedSpec.flows.main.steps[0],
      ensure: [{ judged: { statement: "sound", stakes: "cheap" } }],
    } as typeof judgedSpec.flows.main.steps[0];
    const judgedPlan = await judged.engine.plan(judgedSpec, { name: "Ada" });
    await judged.engine.stepDone(judgedPlan.runId, "work", {
      output: { value: "done" }, telemetry: { model: "worker", durationMs: 1 },
    });

    await ordinary.engine.closeLearnEgress();
    await judged.engine.closeLearnEgress();
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.memory_type)).toEqual(["stratum_usage_debit", "stratum_usage_debit"]);
  });

  it("does not lose or regress a fanout receipt when a slow fetch overlaps the next connector debit", async () => {
    let releaseFirstFetch!: () => void;
    const firstFetch = new Promise<void>((resolve) => { releaseFirstFetch = resolve; });
    let fetches = 0;
    const bodies: WireBody[] = [];
    const setup = await subject({
      connector: async ({ prompt }) => ({
        output: { value: prompt }, usage: { tokens: 3 }, telemetry: { model: "fanout-worker", durationMs: 4 },
      }),
      fetchImpl: async (_input, init) => {
        fetches += 1;
        bodies.push(JSON.parse(String(init?.body)) as WireBody);
        if (fetches === 1) await firstFetch;
        return new Response("{}", { status: 200 });
      },
    });
    const planned = await setup.engine.plan(fanoutSpec(), { items: ["a", "b"] });

    await waitFor(async () => (await setup.store.load(planned.runId)).receipts?.length === 2, "fanout did not append the second receipt");
    expect((await setup.store.load(planned.runId)).receipts?.map((receipt) => receipt.egress)).toEqual(["pending", "pending"]);
    releaseFirstFetch();
    await waitForTerminal(setup.engine, setup.store, planned.runId);
    await setup.engine.closeLearnEgress();

    const persisted = await setup.store.load(planned.runId);
    expect(persisted.receipts).toHaveLength(2);
    expect(persisted.receipts?.map((receipt) => receipt.egress)).toEqual(["sent", "sent"]);
    expect(new Set(persisted.receipts?.map((receipt) => receipt.seq))).toEqual(new Set([1, 2]));
    expect(bodies[0]?.metadata.detail).toMatchObject({
      attempt: 1,
      item: { itemIndex: 0, stage: 0, generation: 1 },
    });
    expect(bodies[0]?.metadata.detail).toEqual(
      persisted.events.find((event) => event.type === "usage_debit" && (event.detail as { seq: number }).seq === 1)?.detail,
    );
  });

  it("dead-letters 422 and continues to the next receipt", async () => {
    const statuses = [422, 200];
    const setup = await subject({ fetchImpl: async () => new Response("{}", { status: statuses.shift() ?? 200 }) });
    const runId = await addReceipt(setup.engine, { dispatchId: "one" });
    await setup.engine.usageReport(runId, {
      dispatchId: "two", source: "client", usage: { tokens: 2 }, telemetry: { model: "m2", durationMs: 3 },
    });
    await setup.engine.closeLearnEgress();

    expect((await setup.store.load(runId)).receipts).toMatchObject([
      { dispatchId: "one", egress: "dead", egressStatus: 422 },
      { dispatchId: "two", egress: "sent" },
    ]);
    expect(statuses).toHaveLength(0);
  });

  it("keeps network failures pending", async () => {
    const warnings: string[] = [];
    let fetches = 0;
    const setup = await subject({
      fetchImpl: async () => { fetches += 1; throw new Error("socket closed"); },
      runtime: { warn: (warning) => warnings.push(warning) },
    });
    const runId = await addReceipt(setup.engine);
    await setup.engine.closeLearnEgress();

    expect(fetches).toBe(1);
    expect((await setup.store.load(runId)).receipts?.[0]?.egress).toBe("pending");
    expect(warnings).toContain(`SmartMemory egress stopped at ${runId}:1: socket closed`);
  });

  it("aborts a stalled request at exactly five seconds and leaves the receipt pending", async () => {
    let timeoutCallback: (() => void) | undefined;
    let timeoutMs: number | undefined;
    let aborted = false;
    const setup = await subject({
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
      runtime: {
        setTimeoutImpl: (callback, milliseconds) => {
          timeoutCallback = callback;
          timeoutMs = milliseconds;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeoutImpl: () => undefined,
        warn: () => undefined,
      },
    });
    const runId = await addReceipt(setup.engine);
    await waitFor(() => timeoutCallback !== undefined, "request timeout was not scheduled");

    expect(timeoutMs).toBe(5_000);
    timeoutCallback!();
    await setup.engine.closeLearnEgress();
    expect(aborted).toBe(true);
    expect((await setup.store.load(runId)).receipts?.[0]?.egress).toBe("pending");
  });

  it("keeps 503 backoff per run so run A never blocks run B", async () => {
    let now = 10_000;
    const attempts = new Map<string, number>();
    const setup = await subject({
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { metadata: { run_id: string } };
        const count = (attempts.get(body.metadata.run_id) ?? 0) + 1;
        attempts.set(body.metadata.run_id, count);
        return new Response("{}", { status: count === 1 && attempts.size === 1 ? 503 : 200 });
      },
      runtime: { now: () => now },
    });
    const runA = await addReceipt(setup.engine, { dispatchId: "run-a" });
    await waitFor(() => attempts.get(runA) === 1, "run A did not attempt delivery");
    const runB = await addReceipt(setup.engine, { dispatchId: "run-b" });
    await setup.engine.closeLearnEgress();

    expect((await setup.store.load(runA)).receipts?.[0]?.egress).toBe("pending");
    expect((await setup.store.load(runB)).receipts?.[0]?.egress).toBe("sent");
    await setup.engine.withReceiptUpdate(runA, () => undefined);
    await setup.engine.closeLearnEgress();
    expect(attempts.get(runA)).toBe(1);

    now += 1_001;
    await setup.engine.withReceiptUpdate(runA, () => undefined);
    await setup.engine.closeLearnEgress();
    expect(attempts.get(runA)).toBe(2);
    expect((await setup.store.load(runA)).receipts?.[0]?.egress).toBe("sent");
  });

  it.each([
    ["credentials are unset", {}],
    ["the explicit opt-in is absent", {
      SMARTMEMORY_API_URL: "https://memory.test",
      SMARTMEMORY_API_KEY: "secret",
      SMARTMEMORY_WORKSPACE_ID: "workspace-1",
    }],
    ["the kill switch is zero", {
      SMARTMEMORY_API_URL: "https://memory.test",
      SMARTMEMORY_API_KEY: "secret",
      SMARTMEMORY_WORKSPACE_ID: "workspace-1",
      STRATUM_LEARN_EGRESS: "0",
    }],
  ])("does not fetch or change state when %s", async (_label, env) => {
    let fetches = 0;
    const setup = await subject({
      env,
      fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
    });
    const runId = await addReceipt(setup.engine);
    await setup.engine.closeLearnEgress();
    expect(fetches).toBe(0);
    expect((await setup.store.load(runId)).receipts?.[0]?.egress).toBe("pending");
  });

  it("refuses to enable without a workspace id and warns once", async () => {
    const warn = vi.fn();
    const setup = await subject({
      env: {
        STRATUM_LEARN_EGRESS: "1",
        SMARTMEMORY_API_URL: "https://memory.test",
        SMARTMEMORY_API_KEY: "secret",
      },
      runtime: { warn },
    });
    const runId = await addReceipt(setup.engine);
    await setup.engine.withReceiptUpdate(runId, () => undefined);
    await setup.engine.closeLearnEgress();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SMARTMEMORY_WORKSPACE_ID is required"));
  });

  it("retryDead flips only dead rows to pending and drains them", async () => {
    const setup = await subject({ env: {} });
    const runId = await addReceipt(setup.engine);
    const statuses = [422, 200];
    const egress = await directEgress(setup.store, setup.engine, {
      fetchImpl: async () => new Response("{}", { status: statuses.shift()! }),
    });
    await egress.drainRun(runId);
    expect((await setup.store.load(runId)).receipts?.[0]).toMatchObject({ egress: "dead", egressStatus: 422 });

    expect(await egress.retryDead(runId)).toBe(1);
    expect((await setup.store.load(runId)).receipts?.[0]).toMatchObject({ egress: "sent" });
    expect((await setup.store.load(runId)).receipts?.[0]).not.toHaveProperty("egressStatus");
  });

  it("never creates or touches the policy outbox", async () => {
    const home = await mkdtemp(join(tmpdir(), "stratum-learn-egress-home-"));
    roots.push(home);
    const setup = await subject({
      env: { ...enabledEnv, HOME: home },
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    await addReceipt(setup.engine);
    await setup.engine.closeLearnEgress();
    await expect(access(join(home, ".stratum", "policy-outbox"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores and awaits startup reconciliation", async () => {
    const first = await subject({ env: {} });
    const runId = await addReceipt(first.engine);
    await first.engine.closeLearnEgress();
    let fetches = 0;
    const restarted = await subject({
      root: first.root,
      fetchImpl: async () => { fetches += 1; return new Response("{}", { status: 200 }); },
    });

    await restarted.engine.closeLearnEgress();
    expect(fetches).toBe(1);
    expect((await restarted.store.load(runId)).receipts?.[0]?.egress).toBe("sent");
  });

  it("reserves engine dispatch ids", async () => {
    const setup = await subject({ env: {} });
    const runId = await addReceipt(setup.engine);
    await expect(setup.engine.usageReport(runId, {
      dispatchId: "engine:spoof", source: "client", usage: { tokens: 1 },
    })).rejects.toThrow('dispatchId prefix "engine:" is reserved for engine-synthesized receipts');
  });

  it("mirrors a real revise with the complete step_reset detail", async () => {
    const bodies: WireBody[] = [];
    const setup = await subject({ env: {} });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: {
        entry: "main",
        main: {
          input: { name: "string" },
          output: { from: "${wrap.output}", contract: "Result" },
          max_rounds: 1,
          steps: [
            { id: "build", do: "build", out: "Result" },
            { id: "wrap", after: ["build"], run: "child", with: { name: "${input.name}" } },
            { id: "review", after: ["wrap"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
          ],
        },
        child: {
          input: { name: "string" },
          output: { from: "${work.output}", contract: "Result" },
          steps: [{ id: "work", do: "work", out: "Result" }],
        },
      },
    };
    const planned = await setup.engine.plan(spec, { name: "Ada" });
    await setup.engine.stepDone(planned.runId, "build", {
      output: { value: "draft" }, usage: { tokens: 3 }, telemetry: { model: "builder", durationMs: 4 },
    });
    await setup.engine.stepDone(planned.runId, "wrap/work", {
      output: { value: "checked" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 5 },
    });
    const beforeRevise = await setup.store.load(planned.runId);
    const gateToken = beforeRevise.steps.review?.gateToken;
    expect(gateToken).toEqual(expect.any(String));
    await setup.engine.gateResolve(planned.runId, "review", "revise", gateToken!);
    await setup.engine.usageReport(planned.runId, {
      dispatchId: "post-revise",
      stepId: "build",
      source: "client",
      usage: { tokens: 1 },
      telemetry: { model: "review-worker", durationMs: 2 },
    });
    const revised = await setup.store.load(planned.runId);
    const auditDetail = revised.events.find((event) => event.type === "step_reset")?.detail;

    const egress = await directEgress(setup.store, setup.engine, {
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as WireBody);
        return new Response("{}", { status: 200 });
      },
    });
    await egress.drainRun(planned.runId);

    const resetBody = bodies.find((body) => body.memory_type === "stratum_step_reset");
    const revisedStepBody = bodies.find((body) => body.metadata.dispatchId === "post-revise");
    expect(revisedStepBody?.metadata.detail).toMatchObject({ epoch: 1, attempt: 1 });
    expect(revisedStepBody?.metadata.detail).toEqual(
      revised.events.filter((event) => event.type === "usage_debit").at(-1)?.detail,
    );
    expect(resetBody?.metadata.detail).toEqual(auditDetail);
    expect(resetBody?.metadata.detail).toEqual({
      reason: "revise",
      reset: [
        { stepId: "build", fromEpoch: 0, toEpoch: 1 },
        { stepId: "wrap", fromEpoch: 0, toEpoch: 1 },
        { stepId: "review", fromEpoch: 0, toEpoch: 1 },
      ],
      subflowsDropped: ["wrap"],
    });
  });

  it("mirrors a real checkpoint revert with the complete checkpoint_reverted detail", async () => {
    const bodies: WireBody[] = [];
    const setup = await subject({ env: {} });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { name: "string" },
        output: { from: "${second.output}", contract: "Result" },
        steps: [
          { id: "first", do: "first", out: "Result" },
          { id: "second", after: ["first"], do: "second", out: "Result" },
        ],
      } },
    };
    const planned = await setup.engine.plan(spec, { name: "Ada" });
    await setup.engine.stepDone(planned.runId, "first", {
      output: { value: "first" }, usage: { tokens: 2 }, telemetry: { model: "worker", durationMs: 3 },
    });
    await setup.engine.commit(planned.runId, "cp");
    await setup.engine.usageReport(planned.runId, {
      dispatchId: "after-checkpoint", stepId: "first", source: "client", usage: { tokens: 5 },
    });
    await setup.engine.revert(planned.runId, "cp");
    const reverted = await setup.store.load(planned.runId);
    const auditDetail = reverted.events.find((event) => event.type === "checkpoint_reverted")?.detail;

    const egress = await directEgress(setup.store, setup.engine, {
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as WireBody);
        return new Response("{}", { status: 200 });
      },
    });
    await egress.drainRun(planned.runId);

    const revertBody = bodies.find((body) => body.memory_type === "stratum_checkpoint_reverted");
    expect(revertBody?.metadata.detail).toEqual(auditDetail);
    expect(revertBody?.metadata.detail).toEqual({
      label: "cp",
      receiptsAtRevert: 2,
      stepsRestored: ["first", "second"],
    });
  });

  it("verify probes each receipt exactly and reports missing, duplicates, and wrong-type rows separately", async () => {
    const setup = await subject({ env: {} });
    const runId = await addReceipt(setup.engine, { dispatchId: "verify-1" });
    await setup.engine.usageReport(runId, { dispatchId: "verify-2", source: "client", usage: { tokens: 2 } });
    await setup.engine.usageReport(runId, { dispatchId: "verify-3", source: "client", usage: { tokens: 3 } });
    const requests: Array<Record<string, unknown>> = [];
    const egress = await directEgress(setup.store, setup.engine, {
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string; memory_type: string; top_k: number };
        requests.push(body);
        const first = `${runId}:1`;
        const second = `${runId}:2`;
        const third = `${runId}:3`;
        const results = body.query === first && body.memory_type === "stratum_usage_debit"
          ? [
              { memory_type: "stratum_usage_debit", metadata: { receipt_id: first } },
              { item: { memory_type: "stratum_usage_debit", metadata: { receipt_id: first } } },
              { memory_type: "stratum_usage_debit", metadata: { receipt_id: "noise" } },
            ]
          : body.query === second && body.memory_type === "stratum_usage_debit"
            ? [{ context: { memory_type: "stratum_usage_debit", metadata: { receipt_id: second } } }]
            : body.query === third && body.memory_type === "stratum_step_reset"
              ? [{ memory_type: "stratum_step_reset", metadata: { receipt_id: third } }]
              : [];
        return new Response(JSON.stringify({ results }), { status: 200 });
      },
    });

    expect(await egress.verifyRun(runId)).toEqual({
      runId,
      receiptCount: 3,
      missingCount: 1,
      duplicateCount: 1,
      wrongTypeCount: 1,
      deadCount: 0,
    });
    expect(requests).toEqual([
      { query: `${runId}:1`, memory_type: "stratum_usage_debit", top_k: 20 },
      { query: `${runId}:2`, memory_type: "stratum_usage_debit", top_k: 20 },
      { query: `${runId}:3`, memory_type: "stratum_usage_debit", top_k: 20 },
      { query: `${runId}:3`, memory_type: "stratum_step_reset", top_k: 20 },
      { query: `${runId}:3`, memory_type: "stratum_checkpoint_reverted", top_k: 20 },
    ]);
  });

  it.skipIf(!(
    process.env.STRATUM_LEARN_EGRESS === "1"
    && process.env.SMARTMEMORY_API_URL
    && process.env.SMARTMEMORY_API_KEY
    && process.env.SMARTMEMORY_WORKSPACE_ID
  ))("golden: forced double-send reports exactly one duplicate for that receipt id", async () => {
    const setup = await subject({ env: process.env, fetchImpl: globalThis.fetch });
    const runId = await addReceipt(setup.engine, { dispatchId: `golden-${Date.now()}` });
    await setup.engine.closeLearnEgress();
    await setup.engine.withReceiptUpdate(runId, (run) => {
      const receipt = run.receipts?.[0];
      if (receipt === undefined) throw new Error("golden receipt missing");
      receipt.egress = "pending";
    });
    await setup.engine.closeLearnEgress();

    const verifier = await directEgress(setup.store, setup.engine, { env: process.env, fetchImpl: globalThis.fetch });
    expect(await verifier.verifyRun(runId)).toMatchObject({
      missingCount: 0,
      duplicateCount: 1,
      wrongTypeCount: 0,
      deadCount: 0,
    });
  });
});
