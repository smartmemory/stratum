import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm , readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { runAgent } from "../../src/connectors/runner.js";
import type { ForegroundRunMeta } from "../../src/connectors/foreground_registry.js";
import { StratumEngine, type EngineConnector, type EngineResponse } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { assertToolResponse } from "../../src/mcp/contracts.js";
import { createToolDispatcher, type ToolDispatcher } from "../../src/mcp/server.js";

// Blueprint §6: the compose team-build abort in miniature, against the REAL engine over a temp
// state root with a REAL child process. This is the single test that would catch a regression
// in any of the three slices.

const roots: string[] = [];
const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)));
});

const contracts = {
  TaskGraph: { tasks: "string[]" },
  Result: { value: "string" },
  WaveDecision: { action: "string", tasks: "string[]" },
};

/** The consumer-fanout shape of carry-golden's astraFlow, trimmed to what the cancel needs. */
const astraFlow = {
  version: 1,
  contracts,
  flows: { entry: "main", main: {
    input: { goal: "string" },
    output: { from: "${assess.output}", contract: "WaveDecision" },
    max_rounds: 4,
    steps: [
      { id: "plan", do: "plan ${input.goal}", out: "TaskGraph" },
      { id: "execute", after: ["plan"], fanout: {
        over: "${plan.output.tasks}", dispatch: "consumer", concurrency: 2, isolation: "none",
        require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "Result" }],
      } },
      { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
      { id: "verify", after: ["execute_merge"], do: "verify", out: "Result" },
      { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
    ],
  } },
};

function writerScript(path: string): string {
  const child = `const fs = require('node:fs'); setInterval(()=>fs.appendFileSync(${JSON.stringify(path)}, 'child\\n'), 10)`;
  return `const {spawn}=require('node:child_process'); const fs=require('node:fs'); spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'}); setInterval(()=>fs.appendFileSync(${JSON.stringify(path)},'parent\\n'),10)`;
}

async function waitForDescendant(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await readFile(path, "utf8").catch(() => "")).includes("child")) return;
    await delay(10);
  }
  throw new Error("descendant writer never started");
}

/** A `runAgent` stand-in that spawns a REAL detached group leader with a grandchild and reports
 *  the pid through `onSpawn`, exactly as the connectors do (S02-1). Every claim the registry
 *  makes — the four identity gates, the group kill, the reap — is meaningless against a fake pid. */
function spawningAgent(path: string): typeof runAgent {
  return (async (run) => {
    const child = spawn(process.execPath, ["-e", writerScript(path)], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    strays.push(pid);
    child.unref();
    await waitForDescendant(path);
    run.onSpawn?.(pid);
    // Settle on EITHER a local abort or the child's own death: a real connector notices its
    // process group being torn down from another process and fails the run. Waiting only on
    // the abort signal would model an agent that survives its own child.
    let exited = false;
    await new Promise<void>((resolve) => {
      child.once("exit", () => { exited = true; resolve(); });
      if (run.signal === undefined) return;
      if (run.signal.aborted) { resolve(); return; }
      run.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    if (run.signal?.aborted || exited) throw new Error("cancelled");
    return { text: "done", usage: { tokens: 0 }, telemetry: { durationMs: 1, model: "fixture" } } as never;
  }) as typeof runAgent;
}

/** Blueprint §6.1 step 2: wait until the registry entry provably CARRIES its group. Cancelling
 *  before the pid is stamped is a legitimate but different scenario — the post-stamp admission
 *  check tears the group down instead of the sweep — and it is not what these cases assert. */
async function waitForRecordedGroup(registryRoot: string, flowRunId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    for (const name of await readdir(registryRoot).catch(() => [] as string[])) {
      const raw = await readFile(join(registryRoot, name, "meta.json"), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      const meta = JSON.parse(raw) as ForegroundRunMeta;
      if (meta.flow.runId === flowRunId && meta.state === "running" && meta.groups.length > 0) return;
    }
    await delay(10);
  }
  throw new Error("no foreground registry entry ever recorded a group");
}

function engineOver(stateRoot: string, connector?: EngineConnector): StratumEngine {
  return new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...(connector !== undefined ? { connector } : {}) });
}

function dispatcherOver(engine: StratumEngine, registryRoot: string, agent?: typeof runAgent): ToolDispatcher {
  return createToolDispatcher({ engine, foregroundRegistryRoot: registryRoot, ...(agent !== undefined ? { runAgent: agent } : {}) });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe("STRAT-FLOW-CANCEL-FG golden flow (blueprint §6)", () => {
  it("cancels a live consumer-fanout run from a SECOND process, reaps its agent, and refuses every late write", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "stratum-cancel-golden-"));
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-cancel-golden-reg-"));
    const writes = join(await mkdtemp(join(tmpdir(), "stratum-cancel-golden-w-")), "writes");
    roots.push(stateRoot, registryRoot, writes);
    const store = new StateStore(stateRoot);

    // 1. Plan and fan out through dispatcher A, then CLAIM one consumer item without settling it.
    const engineA = engineOver(stateRoot);
    const dispatcherA = dispatcherOver(engineA, registryRoot, spawningAgent(writes));
    const start = await dispatcherA.call("stratum_plan", { spec: astraFlow, input: { goal: "g" } });
    const runId = start.runId as string;
    const planToken = (start.ready as Array<{ id: string; dispatchToken: string }>)[0]!.dispatchToken;
    // A checkpoint taken BEFORE the cancel, so the revert refusal has a real label to aim at.
    // It has to precede the fanout: a checkpoint is refused while a fanout is in flight.
    await engineA.commit(runId, "before");
    const fanned = await dispatcherA.call("stratum_step_done", {
      runId, stepId: "plan", result: { output: { tasks: ["t1", "t2"] } }, dispatchToken: planToken,
    });
    const descriptors = (fanned.ready as Array<{ id: string; dispatchToken: string }>).filter((entry) => entry.id.startsWith("execute/"));
    expect(descriptors).toHaveLength(2);
    const claimed = descriptors[0]!;


    // 2. A real agent, registered against the flow, with a provably live grandchild.
    const agentCall = dispatcherA.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), cancellationId: randomUUID(),
      flow: { runId, stepId: "execute", itemIndex: 0 },
    }).catch((error: unknown) => error);
    await waitForDescendant(writes);
    await waitForRecordedGroup(registryRoot, runId);

    // 3. Cancel from a SECOND dispatcher over the same state and registry roots. Dispatcher B
    //    holds an empty foreground map, so the same-process fast path is a no-op and the
    //    cross-process registry path does all the work — the topology of `compose build --abort`.
    const engineB = engineOver(stateRoot);
    const dispatcherB = dispatcherOver(engineB, registryRoot);
    const payload = await dispatcherB.call("stratum_flow_cancel", { runId });

    // 1. The run is settled durably, with NO fabricated failure (D3, C15).
    const cancelled = await store.load(runId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failure).toBeUndefined();
    // 1b. No lock is left behind — a leaked lock wedges the run for the whole lock timeout.
    expect(await exists(join(stateRoot, `${runId}.lock`))).toBe(false);

    // 3. The event landed, naming the foreground surface and the burned issuances.
    const lastEvent = cancelled.events.at(-1)!;
    expect(lastEvent.type).toBe("flow_cancelled");
    expect(lastEvent.detail).toMatchObject({ by: "fg" });
    expect((lastEvent.detail as { burned: { items: number } }).burned.items).toBeGreaterThanOrEqual(1);

    // 4. A late consumer result is refused, and no dispatch token is accepted.
    await expect(engineA.stepDone(runId, claimed.id, { output: { value: "late" } }, claimed.dispatchToken))
      .rejects.toThrow(/cancelled/);
    expect((await store.load(runId)).steps.execute?.fanout?.items[0]?.acceptedDispatchToken).toBeUndefined();

    // 5. The merge gate is refused. 6. Resume is refused.
    await expect(engineA.gateResolve(runId, "execute_merge", "approve", "any-token")).rejects.toThrow(/cancelled/);
    await expect(engineA.resume(runId)).rejects.toThrow(/cancelled/);

    // 7. Revert and commit are both refused (R2-10).
    await expect(engineA.revert(runId, "before")).rejects.toThrow(/cancel/i);
    await expect(engineA.commit(runId, "after")).rejects.toThrow(/cancel/i);

    // 8. The child group is reaped. "Cancelled" means STOPPED WRITING, not "the promise rejected".
    expect(await agentCall).toBeInstanceOf(Error);
    const stopped = await readFile(writes, "utf8");
    await delay(120);
    expect(await readFile(writes, "utf8")).toBe(stopped);

    // 9. The acknowledgement is contract-shaped and positive on both facts.
    await assertToolResponse("stratum_flow_cancel", payload);
    expect(payload).toMatchObject({ runId, status: "cancelled", flowSettled: true, acknowledged: true });
    expect(payload.agents).toEqual({ signalled: 1, reaped: 1, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 });

    // 10. Engine A observes the cancel without being told, and the poll is contract-valid —
    //     which is what the status-enum extension of §2.7 exists for.
    const polled = await dispatcherA.call("stratum_flow_poll", { runId, cursor: 0 });
    expect(polled.status).toBe("cancelled");
    await assertToolResponse("stratum_flow_poll", polled);
  }, 30_000);

  it("§6.2: a PINNED engine-dispatch fanout refuses a cross-process cancel and abandons its in-flight item", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "stratum-cancel-pinned-"));
    roots.push(stateRoot);
    const store = new StateStore(stateRoot);
    let connectorCalls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const connector: EngineConnector = async ({ prompt }) => {
      connectorCalls += 1;
      await blocked;
      return { output: { value: prompt } };
    };
    const spec = {
      version: 1,
      contracts: { Result: { value: "string" }, Batch: { items: "string[]" } },
      flows: { entry: "main", main: {
        input: { name: "string" },
        output: { from: "${fan.output[0]}", contract: "Result" },
        steps: [
          { id: "prep", do: "prep", out: "Batch" },
          { id: "fan", after: ["prep"], fanout: {
            over: "${prep.output.items}", concurrency: 1, isolation: "none",
            require: "all", merge: "sequential", steps: [{ do: "fan ${item}", out: "Result" }],
          } },
        ],
      } },
    };

    const engineA = engineOver(stateRoot, connector);
    const planned = await engineA.plan(spec, { name: "Ada" }) as EngineResponse & { runId: string; ready: Array<{ dispatchToken: string }> };
    await engineA.stepDone(planned.runId, "prep", { output: { items: ["a", "b"] } }, planned.ready[0]!.dispatchToken);
    // Wait for the fanout to hold a pin: the connector is inside the first item.
    for (let tick = 0; tick < 400 && connectorCalls === 0; tick += 1) await delay(5);
    expect(connectorCalls).toBe(1);

    try {
      // A second process cannot cancel a run another process is driving: it owns the in-memory
      // copy, and racing it is exactly what the driver lease exists to refuse.
      const engineB = engineOver(stateRoot, connector);
      const refused = await engineB.flowCancel(planned.runId).catch((error: unknown) => error) as Error & { code?: string; reason?: string; holderPid?: number };
      expect(refused).toBeInstanceOf(Error);
      expect(refused.code).toBe("CANCELLATION_UNCONFIRMED");
      expect(refused.reason).toBe("engine_dispatch_active");
      expect(refused.holderPid).toBe(process.pid);
      expect((await store.load(planned.runId)).status).toBe("running");

      // The cancel must come from the process that drives it.
      const settled = await engineA.flowCancel(planned.runId, "abort");
      expect(settled).toMatchObject({ status: "cancelled", flowSettled: true, settledByThisCall: true });
    } finally {
      release?.();
    }

    await delay(60);
    const cancelled = await store.load(planned.runId);
    expect(cancelled.status).toBe("cancelled");
    // No second item was dispatched, and the released item is ABANDONED — not accepted, not
    // recorded as an attempt, no output and no patch (R2-2).
    expect(connectorCalls).toBe(1);
    const items = cancelled.steps.fan?.fanout?.items ?? [];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.acceptedDispatchToken).toBeUndefined();
      expect(item.output).toBeUndefined();
      expect(item.patch).toBeUndefined();
    }
    expect(await exists(join(stateRoot, `${planned.runId}.lock`))).toBe(false);
  }, 30_000);
});
