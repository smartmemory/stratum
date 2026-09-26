import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SpecValidationError, StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import type { AuditEvent } from "../../src/engine/state.js";
import { assertEvent, assertShape, type Shape } from "../../src/mcp/contracts.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";
import { asUntypedCaller } from "../helpers/untyped_caller.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
// maxRetries: a just-terminalized run can still be flushing its final persist
// when the test ends; rm must tolerate that trailing write.
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function engine(connector?: EngineConnector): Promise<TokenEchoingEngine>;
async function engine(connector: EngineConnector | undefined, echoTokens: false): Promise<StratumEngine>;
async function engine(connector?: EngineConnector, echoTokens = true): Promise<TokenEchoingEngine | StratumEngine> {
  const root = await mkdtemp(join(tmpdir(), "stratum-p4-"));
  roots.push(root);
  const subject = new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), ...(connector ? { connector } : {}) });
  return echoTokens ? tokenEchoingEngine(subject) : subject;
}

const resultContract = { value: "string" };
const gateFlow = (route: "approve" | "revise" | "kill") => ({
  version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, max_rounds: 1,
    steps: [
      { id: "build", do: "build", out: "Result" },
      { id: "review", after: ["build"], gate: { on_approve: route === "approve" ? "finish" : null, on_revise: route === "revise" ? "build" : null, on_kill: route === "kill" ? null : "finish" } },
      { id: "finish", do: "finish", out: "Result" },
    ],
  } },
});

async function waitForTerminal(engine: StratumEngine, runId: string) {
  // Real git worktree creation/merge can exceed 500 ms under suite contention.
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const poll = await engine.flowPoll(runId, 0);
    if (poll.status !== "running") return poll;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fanout did not finish within 4 seconds: ${JSON.stringify(await engine.flowPoll(runId, 0))}`);
}

describe("P4 gates (E3)", () => {
  it("resolves approve, revise, and kill; revise restarts only through a bounded ancestor route", async () => {
    const approve = await engine();
    const planned = await approve.plan(gateFlow("approve"), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    expect((await approve.stepDone(planned.runId, "build", { output: { value: "built" } })).status).toBe("running");
    const afterApproval = await approve.gateResolve(planned.runId, "review", "approve");
    if (afterApproval.status !== "ready") throw new Error("expected finish ready");
    expect((await approve.stepDone(planned.runId, "finish", { output: { value: "done" } })).status).toBe("completed");

    const revise = await engine();
    const revising = await revise.plan(gateFlow("revise"), { name: "x" });
    if (revising.status !== "ready") throw new Error("expected build ready");
    await revise.stepDone(revising.runId, "build", { output: { value: "first" } });
    const redo = await revise.gateResolve(revising.runId, "review", "revise");
    expect(redo).toMatchObject({ status: "ready", ready: [{ id: "build" }] });
    if (redo.status !== "ready") throw new Error("expected rebuilt ready");
    await revise.stepDone(revising.runId, "build", { output: { value: "second" } });
    expect((await revise.gateResolve(revising.runId, "review", "revise"))).toMatchObject({ status: "failed", failure: { reason: "gate revision rounds exhausted" } });

    const kill = await engine();
    const killing = await kill.plan(gateFlow("kill"), { name: "x" });
    if (killing.status !== "ready") throw new Error("expected build ready");
    await kill.stepDone(killing.runId, "build", { output: { value: "built" } });
    expect((await kill.gateResolve(killing.runId, "review", "kill"))).toMatchObject({ status: "failed", failure: { reason: "gate review killed flow" } });
  });
});

describe("P4 revise reset through control edges", () => {
  it("clears descendants reached via gate routes and on_fail, not only data edges", async () => {
    const e = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${mid.output}", contract: "Result" }, max_rounds: 2,
        steps: [
          { id: "build", do: "build", out: "Result" },
          { id: "gate1", after: ["build"], gate: { on_approve: "mid", on_revise: null, on_kill: null } },
          { id: "mid", do: "mid", out: "Result" },
          { id: "gate2", after: ["mid"], gate: { on_approve: null, on_revise: "build", on_kill: null } },
        ],
      } },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    await e.stepDone(planned.runId, "build", { output: { value: "v1" } });
    await e.gateResolve(planned.runId, "gate1", "approve");
    await e.stepDone(planned.runId, "mid", { output: { value: "m1" } });
    // Revise at gate2 targets build; mid was activated via gate1's approve
    // route, so it and gate2 are control-edge descendants and must reset too.
    const redo = await e.gateResolve(planned.runId, "gate2", "revise");
    expect(redo).toMatchObject({ status: "ready", ready: [{ id: "build" }] });
    await e.stepDone(planned.runId, "build", { output: { value: "v2" } });
    await e.gateResolve(planned.runId, "gate1", "approve");
    await e.stepDone(planned.runId, "mid", { output: { value: "m2" } });
    const final = await e.gateResolve(planned.runId, "gate2", "approve");
    expect(final).toMatchObject({ status: "completed", output: { value: "m2" } });
  });
});

describe("P4 revise vs live fanout", () => {
  it("a revise invalidates a live fanout — stale workers never pollute the fresh epoch", async () => {
    const gates = new Map<string, () => void>();
    let blocking = true;
    const calls: string[] = [];
    const connector: EngineConnector = async ({ prompt }) => {
      calls.push(prompt);
      if (blocking && prompt.startsWith("run")) await new Promise<void>((resolve) => gates.set(prompt, resolve));
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract, Batch: { items: "string[]" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" }, max_rounds: 2,
        steps: [
          { id: "prep", do: "prep ${input.name}", out: "Batch" },
          { id: "g", after: ["prep"], gate: { on_approve: null, on_revise: "prep", on_kill: null } },
          { id: "fan", fanout: { over: "${prep.output.items}", concurrency: 2, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "run ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected prep ready");
    await e.stepDone(planned.runId, "prep", { output: { items: ["a", "b"] } });
    for (let tick = 0; tick < 100 && gates.size < 2; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gates.size).toBe(2); // both first-epoch items are mid-connector
    const redo = await e.gateResolve(planned.runId, "g", "revise");
    expect(redo).toMatchObject({ status: "ready", ready: [{ id: "prep" }] });
    blocking = false;
    for (const release of gates.values()) release(); // stale workers drain harmlessly
    await e.stepDone(planned.runId, "prep", { output: { items: ["c"] } });
    for (let tick = 0; tick < 100; tick += 1) {
      const audit = await e.audit(planned.runId);
      if (audit.steps.finish?.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await e.gateResolve(planned.runId, "g", "approve")).toMatchObject({ status: "completed" });
    const audit = await e.audit(planned.runId);
    // Only the fresh epoch's item is in the fanout output; the stale a/b
    // completions were abandoned after the reset.
    expect(audit.steps.fan?.output).toEqual([{ value: "run c" }]);
    expect(calls.filter((prompt) => prompt === "run c")).toHaveLength(1);
  });
});

describe("P4 gate max_rounds across upstream revisions", () => {
  it("keeps a gate's revision cap when an upstream gate resets its region", async () => {
    const e = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${mid.output}", contract: "Result" }, max_rounds: 5,
        steps: [
          { id: "build", do: "build", out: "Result" },
          { id: "gatea", after: ["build"], gate: { on_approve: "mid", on_revise: "build", on_kill: null } },
          { id: "mid", do: "mid", out: "Result" },
          { id: "gateb", after: ["mid"], gate: { on_approve: null, on_revise: "build", on_kill: null, max_rounds: 1 } },
        ],
      } },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    const round = async () => {
      await e.stepDone(planned.runId, "build", { output: { value: "v" } });
      await e.gateResolve(planned.runId, "gatea", "approve");
      await e.stepDone(planned.runId, "mid", { output: { value: "m" } });
    };
    await round();
    expect(await e.gateResolve(planned.runId, "gateb", "revise")).toMatchObject({ status: "ready" }); // gateb round 1/1
    await e.stepDone(planned.runId, "build", { output: { value: "v2" } });
    await e.gateResolve(planned.runId, "gatea", "revise"); // upstream reset must NOT clear gateb's counter
    await round();
    expect(await e.gateResolve(planned.runId, "gateb", "revise")).toMatchObject({
      status: "failed", failure: { reason: "gate revision rounds exhausted" },
    });
  });
});

describe("P4 fanout", () => {
  it("rejects an unknown gate decision instead of routing it to kill", async () => {
    const e = await engine();
    const planned = await e.plan(gateFlow("approve"), { name: "x" });
    if (planned.status !== "ready") throw new Error("expected build ready");
    await e.stepDone(planned.runId, "build", { output: { value: "built" } });
    await expect(e.gateResolve(planned.runId, "review", "oops" as never)).rejects.toThrow("invalid gate decision");
    // The gate is still resolvable correctly afterwards.
    expect((await e.gateResolve(planned.runId, "review", "approve")).status).toBe("ready");
  });

  it("does not block an independent stepDone behind an in-flight fanout", async () => {
    let releaseFanout: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { releaseFanout = resolve; });
    const connector: EngineConnector = async ({ prompt }) => {
      await blocked;
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "run ${item}", out: "Result" }] } },
          { id: "solo", do: "solo ${input.name}", out: "Result" },
          { id: "finish", after: ["fan", "solo"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a"], name: "done" });
    if (planned.status !== "ready") throw new Error("expected solo ready alongside the running fanout");
    expect(planned.ready.map((step) => step.id)).toEqual(["solo"]);
    // The fanout is awaiting its (blocked) connector — this stepDone must not
    // queue behind it on the run lock.
    expect((await e.stepDone(planned.runId, "solo", { output: { value: "s" } })).status).toBe("running");
    // The dispatched lifecycle event is durable BEFORE the connector returns:
    // a fresh engine reading only the persisted state must already see it. The item's
    // admission transaction is serialised against this stepDone by the run lock
    // (STRAT-FLOW-CANCEL-FG S01-9), so it may land just after it — but it must land while
    // the connector is still blocked, which is what `releaseFanout` below still proves.
    const observer = new StratumEngine({ stateRoot: (e as unknown as { store: { root: string } }).store.root, evaluator: createEvaluator(), connector });
    let observed = await observer.flowPoll(planned.runId, 0);
    for (let tick = 0; tick < 200 && !observed.events.some((event) => event.type === "fanout_item_dispatched"); tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observed = await observer.flowPoll(planned.runId, 0);
    }
    expect(observed.events.map((event) => event.type)).toContain("fanout_item_dispatched");
    releaseFanout();
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "completed", output: { value: "done" } });
  });

  it("keeps judged-ensure ledger debits visible per fanout item", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p4-fanout-judged-"));
    roots.push(root);
    const e = new StratumEngine({
      stateRoot: root, evaluator: createEvaluator(),
      connector: async ({ prompt }) => ({ output: { value: prompt } }),
      judge: async () => ({ holds: true, reason: "fine", stakes: "cheap", model: "fake-judge", usage: { tokens: 7, usd: 0.02 } }),
    });
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [
            { do: "check ${item}", out: "Result", ensure: [{ judged: { statement: "item output is sound", stakes: "cheap" } }] },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b"], name: "done" });
    await waitForTerminal(e, planned.runId);
    const events = (await e.audit(planned.runId)).events;
    const judgedDebits = events.filter((event) => event.type === "fanout_ledger_debit"
      && (event.detail as { source?: string }).source === "judged");
    expect(judgedDebits.map((event) => (event.detail as { itemIndex: number; amount: unknown }).itemIndex).sort()).toEqual([0, 1]);
    expect(judgedDebits[0]!.detail).toMatchObject({ amount: { tokens: 7, usd: 0.02 } });
    const judgedEvents = events.filter((event) => event.type === "judged");
    expect(judgedEvents.map((event) => (event.detail as { itemIndex?: number }).itemIndex).sort()).toEqual([0, 1]);
  });

  it("engine-dispatches staged items with a cap, one event spine, require semantics, and persisted polling", async () => {
    let active = 0;
    let peak = 0;
    const connector: EngineConnector = async ({ prompt }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return prompt.includes("bad") ? { failure: "bad item" } : { output: { value: prompt }, telemetry: { durationMs: 8, model: "fake" } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "none", require: "any", merge: "sequential", steps: [
            { do: "first ${item}", out: "Result", ensure: [{ expr: "result.value != ''" }] },
            { do: "second ${item}", out: "Result" },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "bad", "c"], name: "done" });
    expect(planned.status).toBe("running");
    const terminal = await waitForTerminal(e, planned.runId);
    expect(terminal).toMatchObject({ status: "completed", output: { value: "done" } });
    expect(peak).toBeLessThanOrEqual(2);
    const fresh = new StratumEngine({
      stateRoot: (e as unknown as { store: { root: string } }).store.root,
      evaluator: createEvaluator(),
      connector,
      // The process that planned this run is, in the fiction of this test, gone — and a same-
      // process fixture must now say so. A driver lease is reclaimed only from a provably DEAD
      // owner or by the token this engine itself holds (F1); "same pid and start time" is no
      // longer read as ownership, because every engine in one process satisfies it.
      lockOptions: { identity: async () => "dead" as const },
    });
    const poll = await fresh.flowPoll(planned.runId, 1);
    expect(poll.nextCursor).toBeGreaterThan(1);
    expect(poll.events.map((event) => event.type)).toEqual(expect.arrayContaining(["fanout_item_ready", "fanout_item_dispatched", "fanout_attempt_result", "fanout_ledger_debit"]));
    const audit = await e.audit(planned.runId);
    expect(audit.steps.fan?.output).toEqual([expect.any(Object), null, expect.any(Object)]);
  });

  it("terminalizes the run when a fanout dispatch reservation exhausts the flow budget", async () => {
    const e = await engine(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" }, budget: { dispatches: 2 },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "any", merge: "sequential", steps: [{ do: "run ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b", "c"], name: "done" });
    // Two items reserve within budget; the third reservation exhausts the flow
    // ledger — terminal for the run, never absorbed by a tolerant require.
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({
      status: "budget_exhausted", failure: { reason: "flow budget exhausted" },
    });
  });

  it("evaluates stage ensure expressions with their item and prev bindings", async () => {
    const e = await engine(async ({ prompt }) => ({ output: { value: prompt } }));
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "none", require: "all", merge: "sequential", steps: [
            { do: "${item}", out: "Result", ensure: [{ expr: "result.value == item" }] },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b"], name: "done" });
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "completed" });
  });

  it("resumes a persisted mid-fanout run without re-dispatching terminal items", async () => {
    const calls: string[] = [];
    let blockSecondItem = true;
    const connector: EngineConnector = async ({ prompt }) => {
      calls.push(prompt);
      if (prompt === "run b" && blockSecondItem) return new Promise(() => undefined); // simulated crash mid-item
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "run ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b"], name: "done" });
    // Wait until item a is persisted as succeeded and item b is mid-flight.
    for (let tick = 0; tick < 100; tick += 1) {
      if (calls.includes("run b")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    blockSecondItem = false;
    const fresh = new StratumEngine({
      stateRoot: (e as unknown as { store: { root: string } }).store.root,
      evaluator: createEvaluator(),
      connector,
      // The process that planned this run is, in the fiction of this test, gone — and a same-
      // process fixture must now say so. A driver lease is reclaimed only from a provably DEAD
      // owner or by the token this engine itself holds (F1); "same pid and start time" is no
      // longer read as ownership, because every engine in one process satisfies it.
      lockOptions: { identity: async () => "dead" as const },
    });
    await fresh.resume(planned.runId);
    expect(await waitForTerminal(fresh, planned.runId)).toMatchObject({ status: "completed", output: { value: "done" } });
    // Item a ran exactly once across both engine lifetimes.
    expect(calls.filter((prompt) => prompt === "run a")).toHaveLength(1);
  });

  it("tears down a persisted worktree before redispatching the item into a new one", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-redispatch-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);

    let oldWorktree = "";
    let markFirstDispatch!: () => void;
    const firstDispatched = new Promise<void>((resolve) => { markFirstDispatch = resolve; });
    const first = await engine(async ({ cwd }) => {
      oldWorktree = cwd!;
      markFirstDispatch();
      return new Promise(() => undefined); // simulated process exit mid-item
    });
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential", steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await first.plan(spec, { items: ["a"], name: "done" }, { workspaceRoot: repo });
    await firstDispatched;
    roots.push(oldWorktree);
    expect(await stat(oldWorktree)).toBeTruthy();

    let newWorktree = "";
    let markRedispatch!: () => void;
    const redispatched = new Promise<void>((resolve) => { markRedispatch = resolve; });
    let releaseRedispatch!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRedispatch = resolve; });
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      newWorktree = cwd!;
      await writeFile(join(newWorktree, "redispatched.txt"), `${prompt}\n`);
      markRedispatch();
      await blocked;
      return { output: { value: prompt } };
    };
    const stateRoot = (first as unknown as { store: { root: string } }).store.root;
    const fresh = new StratumEngine({ stateRoot, evaluator: createEvaluator(), connector,
      // The process that planned this run is, in the fiction of this test, gone — and a same-
      // process fixture must now say so. A driver lease is reclaimed only from a provably DEAD
      // owner or by the token this engine itself holds (F1); "same pid and start time" is no
      // longer read as ownership, because every engine in one process satisfies it.
      lockOptions: { identity: async () => "dead" as const },
    });
    let terminal: Awaited<ReturnType<typeof waitForTerminal>>;
    try {
      await fresh.resume(planned.runId);
      await redispatched;
      roots.push(newWorktree);

      expect(newWorktree).not.toBe(oldWorktree);
      await expect(stat(oldWorktree)).rejects.toThrow();
      expect(await stat(newWorktree)).toBeTruthy();
      expect((await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout).not.toContain(oldWorktree);
      expect((await execFileAsync("git", ["-C", newWorktree, "rev-parse", "--is-inside-work-tree"])).stdout.trim()).toBe("true");
    } finally {
      releaseRedispatch();
      terminal = await waitForTerminal(fresh, planned.runId);
    }

    expect(terminal).toMatchObject({ status: "completed", output: { value: "done" } });
    expect(await readFile(join(repo, "redispatched.txt"), "utf8")).toBe("write a\n");
  });

  it("leaves the parent workspace untouched when require fails under worktree isolation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-nomerge-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      if (prompt.includes("bad")) return { failure: "bad item" };
      await writeFile(join(cwd!, "ok.txt"), `${prompt}\n`);
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "worktree", require: "all", merge: "sequential", steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["ok", "bad"], name: "done" }, { workspaceRoot: repo });
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("fanout require all not met") } });
    // require is judged BEFORE merging — the successful item's patch must not land.
    await expect(readFile(join(repo, "ok.txt"), "utf8")).rejects.toThrow();
  });

  it("evaluates stage when-predicates against the item's worktree and merges staged changes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-when-jail-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      if (prompt.startsWith("first")) {
        // Written AND staged — the captured patch must not lose staged work.
        await writeFile(join(cwd!, "flag.txt"), "on\n");
        await execFileAsync("git", ["-C", cwd!, "add", "flag.txt"]);
      }
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential", steps: [
            { do: "first ${item}", out: "Result" },
            // Sees the file the FIRST stage wrote inside this item's worktree.
            { do: "second ${item}", out: "Result", when: "file_exists('flag.txt')" },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a"], name: "done" }, { workspaceRoot: repo });
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "completed" });
    const audit = await e.audit(planned.runId);
    // The final stage RAN (its when saw the worktree file), so its output wins.
    expect(audit.steps.fan?.output).toEqual([{ value: "second a" }]);
    expect(await readFile(join(repo, "flag.txt"), "utf8")).toBe("on\n");
  });

  it("jails stage file ensures to the item's worktree before merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-jail-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      await writeFile(join(cwd!, "made.txt"), `${prompt}\n`);
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential", steps: [
            { do: "write ${item}", out: "Result", ensure: [{ file_exists: "made.txt" }] },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a"], name: "done" }, { workspaceRoot: repo });
    // The ensure sees made.txt inside the worktree (it does not exist in the
    // parent workspace until merge) — then the merge lands it.
    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "completed" });
    expect(await readFile(join(repo, "made.txt"), "utf8")).toContain("write a");
  });

  it("creates, applies, and cleans up real local-git worktrees in sequential merge order", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-git-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      await writeFile(join(cwd!, `${prompt.slice(-1)}.txt`), `${prompt}\n`);
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "worktree", require: "all", merge: "sequential", pre_merge: ["test -f README"], steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b"], name: "done" }, { workspaceRoot: repo });
    await waitForTerminal(e, planned.runId);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toContain("write a");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toContain("write b");
    expect((await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it("retains all four worktrees until four parallel connector turns settle", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-four-live-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    const liveWorktrees: string[] = [];
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      liveWorktrees.push(cwd!);
      await writeFile(join(cwd!, `${prompt.slice(-1)}.txt`), `${prompt}\n`);
      if (liveWorktrees.length === 4) allStarted();
      await blocked;
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 4, isolation: "worktree", require: "all", merge: "sequential", steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b", "c", "d"], name: "done" }, { workspaceRoot: repo });

    await started;
    try {
      expect(new Set(liveWorktrees).size).toBe(4);
      for (const worktree of liveWorktrees) expect(await stat(worktree)).toBeTruthy();
      expect((await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(5);
    } finally {
      release();
    }

    expect(await waitForTerminal(e, planned.runId)).toMatchObject({ status: "completed" });
    expect((await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout.match(/^worktree /gm)).toHaveLength(1);
    for (const item of ["a", "b", "c", "d"]) expect(await readFile(join(repo, `${item}.txt`), "utf8")).toContain(`write ${item}`);
  });

  it("turns a sequential worktree merge conflict into a flow error", async () => {
    const repo = await mkdtemp(join(tmpdir(), "stratum-p4-conflict-"));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "shared.txt"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "shared.txt"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const connector: EngineConnector = async ({ prompt, cwd }) => {
      await writeFile(join(cwd!, "shared.txt"), `${prompt}\n`);
      return { output: { value: prompt } };
    };
    const e = await engine(connector);
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "worktree", require: "all", merge: "sequential", steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b"], name: "done" }, { workspaceRoot: repo });
    const terminal = await waitForTerminal(e, planned.runId);
    expect(terminal).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("fanout merge failed") } });
  });
});

describe("P4 bounded iterate", () => {
  it("restarts a task's iterate budget when a revise resets it", async () => {
    const e = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${work.output}", contract: "Result" }, max_rounds: 2,
        steps: [
          { id: "work", do: "work", out: "Result", iterate: { max: 2, until: "result.value == 'ok'" } },
          { id: "g", after: ["work"], gate: { on_approve: null, on_revise: "work", on_kill: null } },
        ],
      } },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected work ready");
    await e.stepDone(planned.runId, "work", { output: { value: "no" } }); // iterate 1/2
    await e.stepDone(planned.runId, "work", { output: { value: "ok" } });
    const redo = await e.gateResolve(planned.runId, "g", "revise");
    expect(redo).toMatchObject({ status: "ready", ready: [{ id: "work" }] });
    // A fresh region means a fresh iterate budget — this must re-dispatch,
    // not exhaust against the pre-revise counter.
    const again = await e.stepDone(planned.runId, "work", { output: { value: "no" } });
    expect(again).toMatchObject({ status: "ready", ready: [{ id: "work", previousFailure: { reason: expect.stringContaining("iterate until") } }] });
    await e.stepDone(planned.runId, "work", { output: { value: "ok" } });
    expect(await e.gateResolve(planned.runId, "g", "approve")).toMatchObject({ status: "completed", output: { value: "ok" } });
  });

  it("re-dispatches with feedback and routes max exhaustion through normal on_fail", async () => {
    const e = await engine();
    const spec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${fallback.output}", contract: "Result" },
        steps: [
          { id: "work", do: "work", out: "Result", iterate: { max: 2, until: "result.value == 'ok'" }, on_fail: "fallback" },
          { id: "fallback", do: "fallback", out: "Result" },
        ],
      } },
    };
    const planned = await e.plan(spec, { name: "x" });
    if (planned.status !== "ready") throw new Error("expected work ready");
    const again = await e.stepDone(planned.runId, "work", { output: { value: "no" } });
    expect(again).toMatchObject({ status: "ready", ready: [{ id: "work", previousFailure: { reason: expect.stringContaining("iterate until") } }] });
    const fallback = await e.stepDone(planned.runId, "work", { output: { value: "no" } });
    expect(fallback).toMatchObject({ status: "ready", ready: [{ id: "fallback" }] });
    if (fallback.status !== "ready") throw new Error("expected fallback ready");
    expect((await e.stepDone(planned.runId, "fallback", { output: { value: "fixed" } })).status).toBe("completed");
  });
});

describe("P4 fanout require semantics", () => {
  const requireSpec = (require: "all" | "any" | number) => ({
    version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
      input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
      steps: [
        { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "none", require, merge: "sequential", steps: [
          { do: "run ${item}", out: "Result" },
        ] } },
        { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
      ],
    } },
  });
  const partialConnector: EngineConnector = async ({ prompt }) =>
    prompt.includes("bad") ? { failure: "bad item" } : { output: { value: prompt } };

  it("fails the step when require all is not met — without re-dispatching the whole batch", async () => {
    const e = await engine(partialConnector);
    const planned = await e.plan(requireSpec("all"), { items: ["a", "bad"], name: "done" });
    const terminal = await waitForTerminal(e, planned.runId);
    expect(terminal).toMatchObject({ status: "failed", failure: { reason: expect.stringContaining("fanout require all not met (1/2 succeeded)") } });
    // `attempts` bounds per-item stage retries only: exactly one item wave —
    // an unmet require must never rebuild and redispatch the fanout.
    const events = (await e.audit(planned.runId)).events;
    expect(events.filter((event) => event.type === "fanout_item_ready")).toHaveLength(2);
  });

  it("treats a when-skipped final stage as a skipped item, never a success require can count", async () => {
    const echoConnector: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });
    const skipSpec = (require: "all" | "any") => ({
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "none", require, merge: "sequential", steps: [
            { do: "first ${item}", out: "Result" },
            { do: "final ${item}", out: "Result", when: "item != 'skiplast'" },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    });

    const strict = await engine(echoConnector);
    const strictRun = await strict.plan(skipSpec("all"), { items: ["ok", "skiplast"], name: "done" });
    expect(await waitForTerminal(strict, strictRun.runId)).toMatchObject({
      status: "failed", failure: { reason: expect.stringContaining("fanout require all not met (1/2 succeeded)") },
    });

    const tolerant = await engine(echoConnector);
    const tolerantRun = await tolerant.plan(skipSpec("any"), { items: ["ok", "skiplast"], name: "done" });
    expect(await waitForTerminal(tolerant, tolerantRun.runId)).toMatchObject({ status: "completed" });
    const audit = await tolerant.audit(tolerantRun.runId);
    // The skipped item is null in the output array — never its stage-one value.
    expect(audit.steps.fan?.output).toEqual([{ value: "final ok" }, null]);
    expect(audit.events.some((event) => event.type === "fanout_item_skipped")).toBe(true);
  });

  it("fails an unmet numeric threshold and passes a met one", async () => {
    const unmet = await engine(partialConnector);
    const unmetRun = await unmet.plan(requireSpec(2), { items: ["a", "bad", "bad2"], name: "done" });
    expect(await waitForTerminal(unmet, unmetRun.runId)).toMatchObject({
      status: "failed", failure: { reason: expect.stringContaining("fanout require 2 not met (1/3 succeeded)") },
    });

    const met = await engine(partialConnector);
    const metRun = await met.plan(requireSpec(2), { items: ["a", "b", "bad"], name: "done" });
    expect(await waitForTerminal(met, metRun.runId)).toMatchObject({ status: "completed", output: { value: "done" } });
  });
});

describe("P4 consumer-dispatched fanout", () => {
  it("caps scoped readiness and advances a self-contained multi-stage descriptor with fenced tokens", async () => {
    let connectorCalls = 0;
    const e = await engine(async () => { connectorCalls += 1; return { failure: "must not run" }; }, false);
    const spec = {
      version: 1,
      contracts: {
        Meta: { labels: "string[]", matrix: "integer[][]" },
        StageOne: { seed: "string", meta: "Meta", history: "Meta[]" },
        Result: { value: "string" },
      },
      flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 2, isolation: "none",
          require: "all", merge: "sequential", pre_merge: ["consumer-check"],
          steps: [
            { do: "seed ${item}", agent: "codex", out: "StageOne" },
            { do: "finish ${item} from ${prev}", out: "Result" },
          ],
        } }],
      } },
    };
    const planned = await e.plan(spec, { items: ["a", "b", "c"] }).catch((error: unknown) => {
      if (error instanceof SpecValidationError) throw new Error(JSON.stringify(error.errors));
      throw error;
    });
    if (planned.status !== "ready") throw new Error("expected consumer descriptors");
    expect(planned.ready.map((entry) => entry.id)).toEqual(["fan/0", "fan/1"]);
    const revisionDigest = (planned as unknown as { revisionDigest: string }).revisionDigest;
    const first = planned.ready[0] as unknown as Record<string, unknown>;
    expect(first).toMatchObject({
      id: "fan/0", do: "seed a", agent: "codex", attempt: 1, epoch: 0,
      flow: "main", step: "fan", stage: 0, isFinalStage: false, itemIndex: 0, generation: 1,
      contract: { root: "StageOne", contracts: {
        StageOne: { seed: "string", meta: "Meta", history: "Meta[]" },
        Meta: { labels: "string[]", matrix: "integer[][]" },
      } },
      contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy: { isolation: "none", merge: "sequential", pre_merge: ["consumer-check"] },
      revisionDigest,
    });
    const firstToken = first.dispatchToken as string;
    const resumed = await e.resume(planned.runId);
    if (resumed.status !== "ready") throw new Error("expected persisted consumer descriptors");
    expect(resumed.ready).toMatchObject([
      { id: "fan/0", dispatchToken: firstToken }, { id: "fan/1" },
    ]);
    await expect(asUntypedCaller(e).stepDone(planned.runId, "fan/0", { output: { seed: "a", meta: { labels: [], matrix: [] }, history: [] } }))
      .rejects.toThrow(/dispatchToken.*required/i);
    const next = await e.stepDone(
      planned.runId, "fan/0",
      { output: { seed: "a", meta: { labels: ["x"], matrix: [[1]] }, history: [] } },
      firstToken,
    );
    if (next.status !== "ready") throw new Error("expected next stage");
    const second = next.ready.find((entry) => entry.id === "fan/0") as unknown as Record<string, unknown>;
    expect(second).toMatchObject({ stage: 1, isFinalStage: true, do: "finish a from {\"seed\":\"a\",\"meta\":{\"labels\":[\"x\"],\"matrix\":[[1]]},\"history\":[]}", itemIndex: 0, generation: 1 });
    expect(second.dispatchToken).not.toBe(firstToken);
    await expect(e.stepDone(planned.runId, "fan/0", { output: { value: "stale" } }, firstToken)).rejects.toThrow(/stale/);
    const afterFirst = await e.stepDone(planned.runId, "fan/0", { output: { value: "A" } }, second.dispatchToken as string);
    expect(afterFirst.status).toBe("ready");
    if (afterFirst.status !== "ready") throw new Error("expected promoted consumer item");
    expect(afterFirst.ready).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fan/2", itemIndex: 2 })]));
    expect((await e.audit(planned.runId)).steps.fan?.fanout?.items[0]).toMatchObject({
      status: "succeeded", acceptedDispatchToken: second.dispatchToken,
    });
    expect(connectorCalls).toBe(0);
  });

  it("retries contract and ensure failures item-locally through the shared settlement path", async () => {
    const e = await engine();
    const spec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", attempts: 3, fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result", ensure: [{ expr: "result.value == 'ok'" }] }],
        } }],
      } },
    };
    const planned = await e.plan(spec, { items: ["a"] });
    if (planned.status !== "ready") throw new Error("expected consumer item");
    const first = planned.ready[0]!;
    expect(first as unknown as Record<string, unknown>).toMatchObject({ isFinalStage: true });
    const schemaRetry = await e.stepDone(planned.runId, "fan/0", { output: { nope: true } }, first.dispatchToken);
    if (schemaRetry.status !== "ready") throw new Error("expected contract retry");
    expect(schemaRetry.ready[0]).toMatchObject({ id: "fan/0", attempt: 2, previousFailure: { reason: expect.stringContaining("Unrecognized key") } });
    const ensureRetry = await e.stepDone(planned.runId, "fan/0", { output: { value: "bad" } }, schemaRetry.ready[0]!.dispatchToken);
    if (ensureRetry.status !== "ready") throw new Error("expected ensure retry");
    expect(ensureRetry.ready[0]).toMatchObject({ id: "fan/0", attempt: 3, previousFailure: { reason: expect.stringContaining("ensure") } });
    const completed = await e.stepDone(planned.runId, "fan/0", { output: { value: "ok" } }, ensureRetry.ready[0]!.dispatchToken);
    expect(completed).toMatchObject({ status: "completed", output: { value: "ok" } });
  });

  it("carries null contracts, preserves skipped positions, and handles empty all/any/N requirements", async () => {
    const noOut = await engine();
    const noOutSpec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "free ${item}" }] } },
          { id: "finish", after: ["fan"], set: { value: "'done'" }, out: "Result" },
        ],
      } },
    };
    const noOutPlan = await noOut.plan(noOutSpec, { items: ["a"] });
    if (noOutPlan.status !== "ready") throw new Error("expected contract-less descriptor");
    expect(noOutPlan.ready[0]).toMatchObject({ contract: null, contractDigest: null });
    const noOutDone = await noOut.stepDone(noOutPlan.runId, "fan/0", { output: { arbitrary: true } }, noOutPlan.ready[0]!.dispatchToken);
    expect(noOutDone).toMatchObject({ status: "completed", output: { value: "done" } });
    expect((await noOut.audit(noOutPlan.runId)).steps.fan?.output).toEqual([{ arbitrary: true }]);

    const ordered = await engine();
    const orderedSpec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 3, isolation: "none", require: 2, merge: "sequential",
          steps: [{ do: "fan ${item}", out: "Result", when: "item != 'skip'" }],
        } }],
      } },
    };
    const orderedPlan = await ordered.plan(orderedSpec, { items: ["a", "skip", "b"] });
    if (orderedPlan.status !== "ready") throw new Error("expected non-skipped items");
    expect(orderedPlan.ready.map((entry) => entry.id)).toEqual(["fan/0", "fan/2"]);
    const afterA = await ordered.stepDone(orderedPlan.runId, "fan/0", { output: { value: "A" } }, orderedPlan.ready[0]!.dispatchToken);
    if (afterA.status !== "ready") throw new Error("expected remaining item");
    const b = afterA.ready.find((entry) => entry.id === "fan/2")!;
    expect(await ordered.stepDone(orderedPlan.runId, "fan/2", { output: { value: "B" } }, b.dispatchToken)).toMatchObject({ status: "completed" });
    expect((await ordered.audit(orderedPlan.runId)).steps.fan?.output).toEqual([{ value: "A" }, null, { value: "B" }]);

    for (const [requirement, status] of [["all", "completed"], ["any", "failed"], [1, "failed"]] as const) {
      const empty = await engine();
      const emptySpec = {
        version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
          input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
          steps: [
            { id: "fan", fanout: { over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: requirement, merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
            { id: "finish", after: ["fan"], set: { value: "'empty'" }, out: "Result" },
          ],
        } },
      };
      expect((await empty.plan(emptySpec, { items: [] })).status).toBe(status);
    }
  });

  it("keeps checkpoint generations monotonic and guards a real consumer worktree lifecycle through its merge gate", async () => {
    // S3: RAW engine (echoTokens=false) — the stale-token assertion below is a
    // fencing check and must not run through the auto-echo adapter.
    const generation = await engine(undefined, false);
    const generationSpec = {
      version: 1, contracts: { Batch: { items: "string[]" }, Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [
          { id: "prep", do: "prep", out: "Batch" },
          { id: "fan", fanout: { over: "${prep.output.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }] } },
        ],
      } },
    };
    const prep = await generation.plan(generationSpec, { name: "x" });
    if (prep.status !== "ready") throw new Error("expected prep");
    await generation.commit(prep.runId, "before-fanout");
    const issued = await generation.stepDone(prep.runId, "prep", { output: { items: ["a"] } }, prep.ready[0]!.dispatchToken);
    if (issued.status !== "ready") throw new Error("expected first generation");
    const old = issued.ready[0] as unknown as { dispatchToken: string; generation: number };
    expect(old.generation).toBe(1);
    await generation.stepDone(prep.runId, "fan/0", { output: { value: "one" } }, old.dispatchToken);
    const reverted = await generation.revert(prep.runId, "before-fanout");
    if (reverted.status !== "ready") throw new Error("expected restored prep");
    const reissued = await generation.stepDone(prep.runId, "prep", { output: { items: ["b"] } }, reverted.ready[0]!.dispatchToken);
    if (reissued.status !== "ready") throw new Error("expected second generation");
    expect(reissued.ready[0]).toMatchObject({ id: "fan/0", generation: 2 });
    await expect(generation.stepDone(prep.runId, "fan/0", { output: { value: "stale" } }, old.dispatchToken)).rejects.toThrow(/stale/);

    const guarded = await engine();
    const guardedSpec = {
      version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential", pre_merge: ["consumer-only"], steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "merge", after: ["fan"], gate: { on_approve: null, on_revise: null, on_kill: null } },
        ],
      } },
    };
    const guardedPlan = await guarded.plan(guardedSpec, { items: ["a"] }, { workspaceRoot: "/path/engine-must-not-touch" });
    if (guardedPlan.status !== "ready") throw new Error("expected consumer worktree descriptor");
    await expect(guarded.commit(guardedPlan.runId, "blocked")).rejects.toThrow(/in-flight fanout/);
    await expect(guarded.revert(guardedPlan.runId, "missing")).rejects.toThrow(/in-flight fanout/);
    const waiting = await guarded.stepDone(guardedPlan.runId, "fan/0", { output: { value: "done" } }, guardedPlan.ready[0]!.dispatchToken);
    expect(waiting.status).toBe("running");
    await expect(guarded.commit(guardedPlan.runId, "blocked")).rejects.toThrow(/successor gate/);
    await expect(guarded.revert(guardedPlan.runId, "missing")).rejects.toThrow(/successor gate/);
    const audit = await guarded.audit(guardedPlan.runId);
    const gateToken = audit.steps.merge?.gateToken;
    expect(gateToken).toEqual(expect.any(String));
    expect(audit.events.map((event) => event.type)).not.toContain("fanout_item_dispatched");
    expect(audit.events.map((event) => event.type)).not.toContain("fanout_merge");
    for (const event of audit.events) await expect(assertEvent(event)).resolves.toBeUndefined();
    expect(await guarded.gateResolve(guardedPlan.runId, "merge", "approve", gateToken)).toMatchObject({ status: "completed" });
    expect(await guarded.commit(guardedPlan.runId, "released")).toMatchObject({ status: "committed" });
  });
});

describe("P4 frozen contracts", () => {
  function checkShape(value: unknown, shape: Shape, path: string): string[] {
    try { assertShape(value, shape, path); return []; }
    catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }

  async function initRepo(prefix: string): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), prefix));
    roots.push(repo);
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    return repo;
  }

  it("every emitted event and engine response validates against the frozen contract payload shapes", async () => {
    const eventsContract = JSON.parse(await readFile(new URL("../../contracts/events.json", import.meta.url), "utf8")) as { events: number; kinds: Record<string, Shape> };
    const surface = JSON.parse(await readFile(new URL("../../contracts/mcp-surface.json", import.meta.url), "utf8")) as { surface: number; tools: Record<string, { request: Shape; responses: Record<string, Shape> }> };
      expect(eventsContract.events).toBe(7);
      expect(surface.surface).toBe(25);
    expect(Object.keys(surface.tools)).toHaveLength(26);

    const allEvents: AuditEvent[] = [];
    const responses: { tool: "stratum_plan" | "stratum_step_done" | "stratum_usage_report" | "stratum_resume" | "stratum_gate_resolve"; value: Record<string, unknown> }[] = [];
    const polls: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];
    const runIds: { engine: StratumEngine; runId: string }[] = [];
    const collect = async (e: StratumEngine, runId: string) => runIds.push({ engine: e, runId });

    // Run A — gate approve + resume: planned/ready/result/gate_waiting/gate_resolved/resumed/completed.
    const a = await engine();
    const aPlanned = await a.plan(gateFlow("approve"), { name: "x" });
    responses.push({ tool: "stratum_plan", value: aPlanned as unknown as Record<string, unknown> });
    if (aPlanned.status !== "ready") throw new Error("expected build ready");
    responses.push({
      tool: "stratum_usage_report",
      value: await a.usageReport(aPlanned.runId, { dispatchId: "p4-receipt", source: "contract", usage: { tokens: 1 } }) as unknown as Record<string, unknown>,
    });
    responses.push({
      tool: "stratum_usage_report",
      value: await a.usageReport(aPlanned.runId, { dispatchId: "p4-receipt", source: "contract", usage: { tokens: 1 } }) as unknown as Record<string, unknown>,
    });
    responses.push({ tool: "stratum_step_done", value: await a.stepDone(aPlanned.runId, "build", {
      output: { value: "built" },
      sandboxAudit: {
        policy: { filesystemMode: "workspace-write", networkAccess: true, writableRoots: ["/cache"], approvalPolicy: "never" },
        provenance: {
          filesystemMode: { layer: "project", source: "/project/stratum.toml" },
          networkAccess: { layer: "user", source: "/user/config.toml" },
          writableRoots: { layer: "dispatch", source: "stratum_agent_run" },
          approvalPolicy: { layer: "default", source: "built-in defaults" },
        },
      },
    }) as unknown as Record<string, unknown> });
    polls.push(await a.flowPoll(aPlanned.runId, 0) as unknown as Record<string, unknown>); // running while waiting_gate
    audits.push(await a.audit(aPlanned.runId) as unknown as Record<string, unknown>);
    responses.push({ tool: "stratum_resume", value: await a.resume(aPlanned.runId) as unknown as Record<string, unknown> });
    responses.push({ tool: "stratum_gate_resolve", value: await a.gateResolve(aPlanned.runId, "review", "approve") as unknown as Record<string, unknown> });
    responses.push({ tool: "stratum_step_done", value: await a.stepDone(aPlanned.runId, "finish", { output: { value: "done" } }) as unknown as Record<string, unknown> });
    await collect(a, aPlanned.runId);

    // Run B — failure + on_fail routing to a failing fallback: result(failure)/routed/failed.
    const b = await engine();
    const bSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${fallback.output}", contract: "Result" },
        steps: [
          { id: "work", do: "work", out: "Result", attempts: 1, on_fail: "fallback" },
          { id: "fallback", do: "fallback", out: "Result", attempts: 1 },
        ],
      } },
    };
    const bPlanned = await b.plan(bSpec, { name: "x" });
    if (bPlanned.status !== "ready") throw new Error("expected work ready");
    await b.stepDone(bPlanned.runId, "work", { failure: "broken" });
    responses.push({ tool: "stratum_step_done", value: await b.stepDone(bPlanned.runId, "fallback", { failure: "also broken" }) as unknown as Record<string, unknown> });
    polls.push(await b.flowPoll(bPlanned.runId, 0) as unknown as Record<string, unknown>);
    audits.push(await b.audit(bPlanned.runId) as unknown as Record<string, unknown>);
    await collect(b, bPlanned.runId);

    // Run C — flow dispatch budget exhaustion: budget_exhausted.
    const c = await engine();
    const cSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${second.output}", contract: "Result" }, budget: { dispatches: 1 },
        steps: [
          { id: "first", do: "first", out: "Result" },
          { id: "second", after: ["first"], do: "second", out: "Result" },
        ],
      } },
    };
    const cPlanned = await c.plan(cSpec, { name: "x" });
    if (cPlanned.status !== "ready") throw new Error("expected first ready");
    responses.push({ tool: "stratum_step_done", value: await c.stepDone(cPlanned.runId, "first", { output: { value: "one" } }) as unknown as Record<string, unknown> });
    polls.push(await c.flowPoll(cPlanned.runId, 0) as unknown as Record<string, unknown>);
    audits.push(await c.audit(cPlanned.runId) as unknown as Record<string, unknown>);
    await collect(c, cPlanned.runId);

    // Run D — judged ensure + a when-skipped step: judged/skipped.
    const dRoot = await mkdtemp(join(tmpdir(), "stratum-p4-judged-"));
    roots.push(dRoot);
    const d = tokenEchoingEngine(new StratumEngine({
      stateRoot: dRoot, evaluator: createEvaluator(),
      judge: async () => ({ holds: true, reason: "looks right", stakes: "cheap", model: "fake-judge", usage: { tokens: 5, usd: 0.01 } }),
    }));
    const dSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { name: "string" }, output: { from: "${main.output}", contract: "Result" },
        steps: [
          { id: "main", do: "main", out: "Result", ensure: [{ judged: { statement: "output is sound", stakes: "cheap" } }] },
          { id: "extra", do: "extra", out: "Result", when: "input.name == 'never'" },
        ],
      } },
    };
    const dPlanned = await d.plan(dSpec, { name: "x" });
    if (dPlanned.status !== "ready") throw new Error("expected main ready");
    await d.stepDone(dPlanned.runId, "main", { output: { value: "judged ok" } });
    await collect(d, dPlanned.runId);

    // Run E — fanout with a failing item, a skipped stage, and success: full fanout family.
    const e = await engine(async ({ prompt }) =>
      prompt.includes("bad") ? { failure: "bad item" } : { output: { value: prompt } });
    const eSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 2, isolation: "none", require: "any", merge: "sequential", steps: [
            { do: "first ${item}", out: "Result" },
            { do: "second ${item}", out: "Result", when: "item != 'skiplater'" },
          ] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const ePlanned = await e.plan(eSpec, { items: ["a", "skiplater", "bad"], name: "done" });
    await waitForTerminal(e, ePlanned.runId);
    await collect(e, ePlanned.runId);

    // Run F — single-item worktree fanout: fanout_merge.
    const repo = await initRepo("stratum-p4-contract-git-");
    const f = await engine(async ({ prompt, cwd }) => {
      await writeFile(join(cwd!, "out.txt"), `${prompt}\n`);
      return { output: { value: prompt } };
    });
    const fSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]", name: "string" }, output: { from: "${finish.output}", contract: "Result" },
        steps: [
          { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation: "worktree", require: "all", merge: "sequential", steps: [{ do: "write ${item}", out: "Result" }] } },
          { id: "finish", after: ["fan"], set: { value: "input.name" }, out: "Result" },
        ],
      } },
    };
    const fPlanned = await f.plan(fSpec, { items: ["a"], name: "done" }, { workspaceRoot: repo });
    await waitForTerminal(f, fPlanned.runId);
    await collect(f, fPlanned.runId);

    // Run G — consumer fanout: its ready descriptor must match the frozen surface shape.
    const g = await engine();
    const gSpec = {
      version: 1, contracts: { Result: resultContract }, flows: { entry: "main", main: {
        input: { items: "string[]" }, output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [{ id: "fan", fanout: {
          over: "${input.items}", dispatch: "consumer", concurrency: 1, isolation: "none", require: "all", merge: "sequential",
          steps: [{ do: "consume ${item}", out: "Result" }],
        } }],
      } },
    };
    const gPlanned = await g.plan(gSpec, { items: ["a"] });
    responses.push({ tool: "stratum_plan", value: gPlanned as unknown as Record<string, unknown> });
    if (gPlanned.status !== "ready") throw new Error("expected consumer descriptor");
    responses.push({
      tool: "stratum_step_done",
      value: await g.stepDone(
        gPlanned.runId, "fan/0", { output: { value: "done" } }, gPlanned.ready[0]!.dispatchToken,
      ) as unknown as Record<string, unknown>,
    });
    await collect(g, gPlanned.runId);

    // Run H — carry: materialising an `initial` value emits carry_updated for real, so the
    // vocabulary assertion below sees a genuine emission rather than a declared-ahead literal.
    const h = await engine();
    const hSpec = {
      version: 1, contracts: { TaskGraph: { tasks: "string[]" } }, flows: { entry: "main", main: {
        input: { goal: "string" }, output: { from: "${plan.output}", contract: "TaskGraph" },
        carry: { wave: { initial: "${plan.output.tasks}" } },
        steps: [{ id: "plan", do: "plan ${input.goal}", out: "TaskGraph" }],
      } },
    };
    const hPlanned = await h.plan(hSpec, { goal: "g" });
    if (hPlanned.status !== "ready") throw new Error("expected plan to be ready");
    await h.stepDone(hPlanned.runId, "plan", { output: { tasks: ["t1"] } }, hPlanned.ready[0]!.dispatchToken);
    await collect(h, hPlanned.runId);

    for (const { engine: source, runId } of runIds) allEvents.push(...(await source.audit(runId)).events);

    // S02/S01 declare these kinds' exact strict shapes now, but the emitters ship in later
    // slices. Keep full-vocabulary coverage without pretending the current engine emitted them.
    const declaredAheadOfEmission: AuditEvent[] = [
      {
        at: "2026-08-30T00:00:00.000Z", type: "step_reset", stepId: "build",
        detail: { reason: "revise", reset: [{ stepId: "build", fromEpoch: 0, toEpoch: 1 }], subflowsDropped: [] },
      },
      {
        at: "2026-08-30T00:00:00.000Z", type: "checkpoint_reverted",
        detail: { label: "before", receiptsAtRevert: 1, stepsRestored: ["build"] },
      },
      {
        at: "2026-08-30T00:00:00.000Z", type: "flow_cancelled",
        detail: { by: "fg", reason: "abort", burned: { steps: ["work"], items: 0 } },
      },
    ];

    // Every emitted event validates against its frozen payload shape (default-deny).
    const observedKinds = new Set<string>();
    for (const event of allEvents) {
      observedKinds.add(event.type);
      const kindShape = eventsContract.kinds[event.type];
      expect(kindShape, `event kind ${event.type} missing from events.json`).toBeDefined();
      const shape = { at: "string", type: "string", ...(kindShape as Record<string, Shape>) };
      expect(checkShape(event, shape, event.type)).toEqual([]);
    }
    for (const event of declaredAheadOfEmission) {
      observedKinds.add(event.type);
      const kindShape = eventsContract.kinds[event.type];
      expect(kindShape, `event kind ${event.type} missing from events.json`).toBeDefined();
      const shape = { at: "string", type: "string", ...(kindShape as Record<string, Shape>) };
      expect(checkShape(event, shape, event.type)).toEqual([]);
    }
    // Full vocabulary coverage, both directions: nothing unexercised, nothing undeclared.
    expect([...observedKinds].sort()).toEqual(Object.keys(eventsContract.kinds).sort());

    // Every engine response validates against its tool's per-status response shape.
    const observedStatuses = new Set<string>();
    for (const { tool, value } of responses) {
      const status = value.status as string;
      observedStatuses.add(status);
      const declared = surface.tools[tool]?.responses[status];
      expect(declared, `${tool} response status ${status} missing from mcp-surface.json`).toBeDefined();
      const { status: _, ...rest } = value;
      expect(checkShape(rest, declared!, `${tool}:${status}`)).toEqual([]);
    }
    expect([...observedStatuses].sort()).toEqual(["budget_exhausted", "completed", "duplicate", "failed", "ok", "ready", "running"]);
    for (const poll of polls) {
      const declared = surface.tools.stratum_flow_poll?.responses[poll.status as string];
      expect(declared, `flow_poll status ${String(poll.status)} missing from contract`).toBeDefined();
      const { status: _, ...rest } = poll;
      expect(checkShape(rest, declared!, `stratum_flow_poll:${String(poll.status)}`)).toEqual([]);
    }
    for (const audit of audits) {
      const declared = surface.tools.stratum_audit?.responses[audit.status as string];
      expect(declared, `audit status ${String(audit.status)} missing from contract`).toBeDefined();
      const { status: _, ...rest } = audit;
      expect(checkShape(rest, declared!, `stratum_audit:${String(audit.status)}`)).toEqual([]);
    }

    // The background-agent tools are frozen to the P3 module's actual variants.
    expect(Object.keys(surface.tools.stratum_agent_poll?.responses ?? {}).sort()).toEqual(["complete", "error", "not_found", "running"]);
    expect(Object.keys(surface.tools.stratum_cancel_agent_run?.responses ?? {}).sort()).toEqual(["already_complete", "already_error", "cancelled", "not_found"]);
    expect(Object.keys(surface.tools.stratum_agent_run?.responses ?? {}).sort()).toEqual(["bg_started", "complete"]);
  });
});
