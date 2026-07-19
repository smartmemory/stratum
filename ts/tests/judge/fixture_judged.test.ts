import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { createFixtureJudge } from "../../src/judge/fixture_judged.js";
import { createToolDispatcher, judgeBackend } from "../../src/mcp/server.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("fixture judged backend", () => {
  it("selects fixture only in tests and fails loudly in production", () => {
    expect(judgeBackend({ STRATUM_JUDGE_BACKEND: "fixture", NODE_ENV: "test" })).toBe("fixture");
    expect(() => judgeBackend({ STRATUM_JUDGE_BACKEND: "fixture", NODE_ENV: "production" }))
      .toThrow('STRATUM_JUDGE_BACKEND="fixture" is only allowed when NODE_ENV="test"');
    expect(() => judgeBackend({ STRATUM_JUDGE_BACKEND: "fixture" }))
      .toThrow('STRATUM_JUDGE_BACKEND="fixture" is only allowed when NODE_ENV="test"');
  });

  it("passes a keyed judged ensure, debits its real usage shape, and emits its audit event", async () => {
    const root = await testRoot();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("STRATUM_STATE_ROOT", root);
    vi.stubEnv("STRATUM_JUDGE_BACKEND", "fixture");
    vi.stubEnv("STRATUM_JUDGE_FIXTURE", JSON.stringify({
      "output is real": {
        holds: true,
        reason: "fixture verified the output",
        model: "fixture/keyed",
        usage: { tokens: 7, usd: 0.001 },
      },
    }));
    const dispatcher = createToolDispatcher();
    const spec = flow([
      { id: "finish", do: "work", out: "Result", attempts: 1, ensure: [{ judged: { statement: "output is real", stakes: "cheap" } }] },
    ], "${finish.output}");

    const planned = await dispatcher.call("stratum_plan", { spec, input: { name: "x" } });
    const completed = await dispatcher.call("stratum_step_done", {
      runId: planned.runId,
      stepId: "finish",
      dispatchToken: readyToken(planned),
      result: { output: { value: "real" } },
    });

    expect(completed).toMatchObject({ status: "completed", ledger: { spent: { tokens: 7, usd: 0.001 } } });
    const audit = await dispatcher.call("stratum_audit", { runId: planned.runId });
    expect(audit.flowSpent).toMatchObject({ tokens: 7, usd: 0.001 });
    expect((audit.events as Array<Record<string, unknown>>).find((event) => event.type === "judged")).toMatchObject({
      stepId: "finish",
      detail: {
        statement: "output is real",
        holds: true,
        reason: "fixture verified the output",
        stakes: "cheap",
        model: "fixture/keyed",
        usage: { tokens: 7, usd: 0.001 },
      },
    });
  });

  it("consumes scripted verdicts in order and routes an exhausted judged failure", async () => {
    const root = await testRoot();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("STRATUM_STATE_ROOT", root);
    vi.stubEnv("STRATUM_JUDGE_BACKEND", "fixture");
    vi.stubEnv("STRATUM_JUDGE_FIXTURE", JSON.stringify([
      { holds: false, reason: "first scripted rejection", model: "fixture/sequence", usage: { tokens: 2, usd: 0 } },
      { holds: false, reason: "second scripted rejection", model: "fixture/sequence", usage: { tokens: 3, usd: 0 } },
    ]));
    const dispatcher = createToolDispatcher();
    const spec = flow([
      {
        id: "primary", do: "primary", out: "Result", attempts: 2, on_fail: "fallback",
        ensure: [{ judged: { statement: "primary is acceptable", stakes: "default" } }],
      },
      { id: "fallback", do: "fallback", out: "Result" },
    ], "${fallback.output}");

    const planned = await dispatcher.call("stratum_plan", { spec, input: { name: "x" } });
    const retry = await dispatcher.call("stratum_step_done", {
      runId: planned.runId, stepId: "primary", dispatchToken: readyToken(planned), result: { output: { value: "first" } },
    });
    expect(retry).toMatchObject({
      status: "ready",
      ready: [{ id: "primary", attempt: 2, previousFailure: { reason: expect.stringContaining("first scripted rejection") } }],
    });
    const routed = await dispatcher.call("stratum_step_done", {
      runId: planned.runId, stepId: "primary", dispatchToken: readyToken(retry), result: { output: { value: "second" } },
    });
    expect(routed).toMatchObject({
      status: "ready",
      ready: [{ id: "fallback", previousFailure: { reason: expect.stringContaining("second scripted rejection") } }],
      ledger: { spent: { tokens: 5 } },
    });
    const completed = await dispatcher.call("stratum_step_done", {
      runId: planned.runId, stepId: "fallback", dispatchToken: readyToken(routed), result: { output: { value: "recovered" } },
    });
    expect(completed).toMatchObject({ status: "completed", output: { value: "recovered" } });

    const audit = await dispatcher.call("stratum_audit", { runId: planned.runId });
    const events = audit.events as Array<Record<string, unknown>>;
    expect(events.filter((event) => event.type === "judged").map((event) => (event.detail as { reason: string }).reason))
      .toEqual(["first scripted rejection", "second scripted rejection"]);
    expect(events.find((event) => event.type === "routed")).toMatchObject({
      stepId: "primary", detail: { target: "fallback", failure: { reason: expect.stringContaining("second scripted rejection") } },
    });
  });

  it("throws when no keyed or scripted verdict remains", async () => {
    const keyed = createFixtureJudge({ NODE_ENV: "test", STRATUM_JUDGE_FIXTURE: "{}" });
    await expect(keyed({ statement: "unmapped statement", stakes: "cheap" }, { result: {}, input: {} }))
      .rejects.toThrow('no fixture verdict for "unmapped statement"');

    const scripted = createFixtureJudge({
      NODE_ENV: "test",
      STRATUM_JUDGE_FIXTURE: JSON.stringify([{ holds: true, reason: "only verdict" }]),
    });
    await expect(scripted({ statement: "first" }, { result: {}, input: {} })).resolves.toEqual({
      holds: true, reason: "only verdict", stakes: "default", model: "fixture", usage: { tokens: 1, usd: 0 },
    });
    await expect(scripted({ statement: "second" }, { result: {}, input: {} }))
      .rejects.toThrow('no fixture verdict for "second"');
  });

  it("emits judged audits and judged ledger debits for every fanout item", async () => {
    const root = await testRoot();
    const env = {
      NODE_ENV: "test",
      STRATUM_JUDGE_BACKEND: "fixture",
      STRATUM_JUDGE_FIXTURE: JSON.stringify({
        "item output is sound": { holds: true, reason: "fixture accepted item", usage: { tokens: 4, usd: 0 } },
      }),
    };
    expect(judgeBackend(env)).toBe("fixture");
    const engine = new StratumEngine({
      stateRoot: root,
      evaluator: createEvaluator(),
      connector: async ({ prompt }) => ({ output: { value: prompt } }),
      judge: createFixtureJudge(env),
    });
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" },
        output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: {
            over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
            steps: [{ do: "check ${item}", out: "Result", ensure: [{ judged: { statement: "item output is sound", stakes: "cheap" } }] }],
          } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };

    const planned = await engine.plan(spec, { items: ["a", "b"], name: "done" });
    await waitForTerminal(engine, planned.runId);
    const audit = await engine.audit(planned.runId);
    expect(audit.flowSpent.tokens).toBe(8);
    const judged = audit.events.filter((event) => event.type === "judged");
    expect(judged.map((event) => (event.detail as { itemIndex: number }).itemIndex).sort()).toEqual([0, 1]);
    const debits = audit.events.filter((event) => event.type === "fanout_ledger_debit"
      && (event.detail as { source?: string }).source === "judged");
    expect(debits.map((event) => (event.detail as { itemIndex: number }).itemIndex).sort()).toEqual([0, 1]);
    expect(debits[0]!.detail).toMatchObject({ amount: { tokens: 4, usd: 0 }, source: "judged" });
  });
});

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-fixture-judge-"));
  roots.push(root);
  return root;
}

function flow(steps: unknown[], from: string): Record<string, unknown> {
  return {
    version: 1,
    contracts: { Result: { value: "string" } },
    flows: { entry: "main", main: { input: { name: "string" }, output: { from, contract: "Result" }, steps } },
  };
}

function readyToken(response: Record<string, unknown>): string {
  const token = (response.ready as Array<Record<string, unknown>> | undefined)?.[0]?.dispatchToken;
  if (typeof token !== "string") throw new Error("expected ready dispatch token");
  return token;
}

async function waitForTerminal(engine: StratumEngine, runId: string): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) {
    if ((await engine.flowPoll(runId, 0)).status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fanout did not finish");
}
