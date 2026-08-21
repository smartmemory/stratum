import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { bundleIdForRules } from "../../src/policy/bundle.js";
import type { EnforcementEvent, PolicyBundle, Rule, Source } from "../../src/policy/types.js";

const roots: string[] = [];
const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 204 }));
const originalEnv = {
  url: process.env.SMARTMEMORY_API_URL,
  key: process.env.SMARTMEMORY_API_KEY,
  workspace: process.env.SMARTMEMORY_WORKSPACE_ID,
};

const source: Source = {
  record_id: "decision-1",
  memory_type: "decision",
  version: 1,
  content_hash: "a".repeat(64),
  chain_hash: "b".repeat(64),
  workspace_id: "workspace-1",
};

function bundle(rules: Rule[]): PolicyBundle {
  return {
    bundle_id: bundleIdForRules(rules),
    workspace_id: "workspace-1",
    compiled_at: "2026-08-21T00:00:00.000Z",
    selector: { status: ["active"] },
    rules,
  };
}

async function engine(): Promise<{ subject: StratumEngine; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "stratum-policy-engine-"));
  roots.push(root);
  return { subject: new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }), root };
}

function postedEvents(): EnforcementEvent[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as EnforcementEvent);
}

beforeAll(() => {
  process.env.SMARTMEMORY_API_URL = "https://memory.example";
  process.env.SMARTMEMORY_API_KEY = "secret";
  process.env.SMARTMEMORY_WORKSPACE_ID = "workspace-1";
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  fetchMock.mockClear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (originalEnv.url === undefined) delete process.env.SMARTMEMORY_API_URL;
  else process.env.SMARTMEMORY_API_URL = originalEnv.url;
  if (originalEnv.key === undefined) delete process.env.SMARTMEMORY_API_KEY;
  else process.env.SMARTMEMORY_API_KEY = originalEnv.key;
  if (originalEnv.workspace === undefined) delete process.env.SMARTMEMORY_WORKSPACE_ID;
  else process.env.SMARTMEMORY_WORKSPACE_ID = originalEnv.workspace;
});

describe.sequential("engine policy seam", () => {
  it("persists policy correlation, records ensure verdicts, and emits flow_terminal", async () => {
    const rule: Rule = {
      rule_id: "decision-1#0",
      source,
      bind: { kind: "ensure", step_selector: "finish" },
      predicate: { expr: "result.ok == true" },
      on_fail: "refuse",
    };
    const policyBundle = bundle([rule]);
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: {
        entry: "main",
        main: {
          input: {},
          output: { from: "${finish.output}", contract: "Result" },
          steps: [{ id: "finish", do: "finish", out: "Result" }],
        },
      },
    };
    const { subject, root } = await engine();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const planned = await subject.plan(spec, {}, { policyBundle });
    if (planned.status !== "ready") throw new Error("expected ready");
    const completed = await subject.stepDone(planned.runId, "finish", { output: { ok: true } }, planned.ready[0]!.dispatchToken);
    expect(completed.status).toBe("completed");
    const persisted = JSON.parse(await readFile(join(root, `${planned.runId}.json`), "utf8")) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      bundle_id: policyBundle.bundle_id,
      policy_rules_version: 2,
      policy_rules: { "main/finish": [{ ensure_index: 0, rule_id: "decision-1#0", source, step_selector: "finish", on_fail: "refuse" }] },
      policy_verdicts: [{ rule_id: "decision-1#0", source, met: true, predicate_type: "deterministic" }],
    });
    expect(info).toHaveBeenCalledWith(`policy bundle ${policyBundle.bundle_id}: 1 rules bound to 1 step-predicate pairs`);
    await vi.waitFor(() => expect(postedEvents()).toContainEqual(expect.objectContaining({
      event_id: `${planned.runId}:flow`,
      kind: "flow_terminal",
      outcome: "completed",
      rules_evaluated: [{ rule_id: "decision-1#0", source, met: true, predicate_type: "deterministic" }],
    })));
  });

  it("migrates an unambiguous pre-version step map on resume and attributes its verdict", async () => {
    const rule: Rule = {
      rule_id: "decision-legacy#0",
      source: { ...source, record_id: "decision-legacy" },
      bind: { kind: "ensure", step_selector: "finish" },
      predicate: { expr: "result.ok == true" },
      on_fail: "refuse",
    };
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: { entry: "main", main: {
        input: {}, output: { from: "${finish.output}", contract: "Result" },
        steps: [{ id: "finish", do: "finish", out: "Result" }],
      } },
    };
    const { subject, root } = await engine();
    const planned = await subject.plan(spec, {}, { policyBundle: bundle([rule]) });
    if (planned.status !== "ready") throw new Error("expected ready");
    const path = join(root, `${planned.runId}.json`);
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const scoped = legacy.policy_rules as Record<string, unknown>;
    legacy.policy_rules = { finish: scoped["main/finish"] };
    delete legacy.policy_rules_version;
    await writeFile(path, JSON.stringify(legacy), "utf8");

    const restarted = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const resumed = await restarted.resume(planned.runId);
    if (resumed.status !== "ready") throw new Error("expected resumed ready");
    await restarted.stepDone(planned.runId, "finish", { output: { ok: true } }, resumed.ready[0]!.dispatchToken);
    const migrated = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({
      policy_rules_version: 2,
      policy_rules: { "main/finish": [{ rule_id: "decision-legacy#0", ensure_index: 0 }] },
      policy_verdicts: [{ rule_id: "decision-legacy#0", met: true, predicate_type: "deterministic" }],
    });
  });

  it("refuses resume and revert when a pre-version step key is ambiguous across flows", async () => {
    const rule: Rule = {
      rule_id: "decision-ambiguous#0",
      source: { ...source, record_id: "decision-ambiguous" },
      bind: { kind: "ensure", step_selector: "finish" },
      predicate: { expr: "true" },
      on_fail: "refuse",
    };
    const step = { id: "finish", do: "finish", out: "Result" };
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: {
        entry: "main",
        main: { input: {}, output: { from: "${finish.output}", contract: "Result" }, steps: [step] },
        alternate: { input: {}, output: { from: "${finish.output}", contract: "Result" }, steps: [step] },
      },
    };
    const { subject, root } = await engine();
    const planned = await subject.plan(spec, {}, { policyBundle: bundle([rule]) });
    if (planned.status !== "ready") throw new Error("expected ready");
    await subject.commit(planned.runId, "before");
    const path = join(root, `${planned.runId}.json`);
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const scoped = legacy.policy_rules as Record<string, unknown>;
    legacy.policy_rules = { finish: scoped["main/finish"] };
    delete legacy.policy_rules_version;
    await writeFile(path, JSON.stringify(legacy), "utf8");

    const restarted = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const error = new RegExp(`${planned.runId}.*finish.*ambiguous.*re-plan required`);
    await expect(restarted.resume(planned.runId)).rejects.toThrow(error);
    await expect(restarted.revert(planned.runId, "before")).rejects.toThrow(error);
  });

  it("preserves current policy verdicts when reverting a checkpoint persisted before verdict snapshots", async () => {
    const rule: Rule = {
      rule_id: "decision-old-checkpoint#0",
      source: { ...source, record_id: "decision-old-checkpoint" },
      bind: { kind: "ensure", step_selector: "finish" },
      predicate: { expr: "result.ok == true" },
      on_fail: "refuse",
    };
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: { entry: "main", main: {
        input: {}, output: { from: "${finish.output}", contract: "Result" },
        steps: [{ id: "finish", do: "finish", out: "Result" }],
      } },
    };
    const { subject, root } = await engine();
    const planned = await subject.plan(spec, {}, { policyBundle: bundle([rule]) });
    if (planned.status !== "ready") throw new Error("expected ready");
    await subject.commit(planned.runId, "old");
    await subject.stepDone(planned.runId, "finish", { output: { ok: true } }, planned.ready[0]!.dispatchToken);
    const path = join(root, `${planned.runId}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      checkpoints: Array<{ snapshot: Record<string, unknown> }>;
      policy_verdicts: unknown[];
    };
    expect(persisted.policy_verdicts).toHaveLength(1);
    delete persisted.checkpoints[0]!.snapshot.policy_verdicts;
    await writeFile(path, JSON.stringify(persisted), "utf8");

    const restarted = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    await restarted.revert(planned.runId, "old");
    const restored = JSON.parse(await readFile(path, "utf8")) as { policy_verdicts: unknown[] };
    expect(restored.policy_verdicts).toEqual(persisted.policy_verdicts);
  });

  it("correlates same-id root and subflow ensures by scoped flow identity", async () => {
    const sourceA = { ...source, record_id: "decision-a" };
    const sourceB = { ...source, record_id: "decision-b", chain_hash: "c".repeat(64) };
    const rules: Rule[] = [
      { rule_id: "decision-a#0", source: sourceA, bind: { kind: "ensure", step_selector: "check" }, predicate: { expr: "true" }, on_fail: "refuse" },
      { rule_id: "decision-b#0", source: sourceB, bind: { kind: "ensure", step_selector: "check" }, predicate: { expr: "true" }, on_fail: "gate" },
    ];
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: {
        entry: "main",
        main: {
          input: {},
          output: { from: "${check.output}", contract: "Result" },
          steps: [
            { id: "check", do: "root check", out: "Result" },
            { id: "wrap", run: "child", with: {} },
          ],
        },
        child: {
          input: {},
          output: { from: "${check.output}", contract: "Result" },
          steps: [{ id: "check", do: "child check", out: "Result", ensure: [{ expr: "true" }] }],
        },
      },
    };
    const { subject, root } = await engine();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const planned = await subject.plan(spec, {}, { policyBundle: bundle(rules) });
    if (planned.status !== "ready") throw new Error("expected ready");
    const rootReady = planned.ready.find((ready) => ready.id === "check");
    const childReady = planned.ready.find((ready) => ready.id === "wrap/check");
    if (!rootReady || !childReady) throw new Error("missing scoped ready steps");
    await subject.stepDone(planned.runId, "check", { output: { ok: true } }, rootReady.dispatchToken);
    const completed = await subject.stepDone(planned.runId, "wrap/check", { output: { ok: true } }, childReady.dispatchToken);
    expect(completed.status).toBe("completed");
    const persisted = JSON.parse(await readFile(join(root, `${planned.runId}.json`), "utf8")) as {
      policy_rules: Record<string, Array<{ rule_id: string; ensure_index: number; on_fail: string }>>;
      policy_verdicts: Array<{ rule_id: string; source: Source }>;
    };
    expect(persisted.policy_rules).toMatchObject({
      "main/check": [
        { rule_id: "decision-a#0", ensure_index: 0, on_fail: "refuse" },
        { rule_id: "decision-b#0", ensure_index: 1, on_fail: "gate" },
      ],
      "child/check": [
        { rule_id: "decision-a#0", ensure_index: 1, on_fail: "refuse" },
        { rule_id: "decision-b#0", ensure_index: 2, on_fail: "gate" },
      ],
    });
    expect(persisted.policy_verdicts.map(({ rule_id, source: verdictSource }) => [rule_id, verdictSource.record_id]))
      .toEqual([
        ["decision-a#0", "decision-a"],
        ["decision-b#0", "decision-b"],
        ["decision-a#0", "decision-a"],
        ["decision-b#0", "decision-b"],
      ]);
  });

  it("emits a human gate_resolution with user_id", async () => {
    const policyBundle = bundle([]);
    const spec = {
      version: 1,
      contracts: { Result: { ok: "boolean" } },
      flows: {
        entry: "main",
        main: {
          input: {},
          output: { from: "${seed.output}", contract: "Result" },
          steps: [
            { id: "seed", set: { ok: "true" }, out: "Result" },
            { id: "review", after: ["seed"], gate: { on_approve: null, on_revise: null, on_kill: null } },
          ],
        },
      },
    };
    const { subject } = await engine();
    const planned = await subject.plan(spec, {}, { policyBundle });
    expect(planned.status).toBe("running");
    const token = (await subject.audit(planned.runId)).steps.review?.gateToken;
    if (token === undefined) throw new Error("missing gate token");
    await subject.gateResolve(planned.runId, "review", "approve", token, "user-7");
    await vi.waitFor(() => expect(postedEvents()).toContainEqual(expect.objectContaining({
      event_id: `${planned.runId}:gate:review:1`,
      kind: "gate_resolution",
      outcome: "approve",
      resolved_by: "human",
      resolved_by_user_id: "user-7",
      rules_evaluated: [],
    })));
  });
});
