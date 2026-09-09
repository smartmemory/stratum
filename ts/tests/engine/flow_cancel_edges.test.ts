import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointOperationError, StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { procStartTime, processIdentity } from "../../src/connectors/proc_identity.js";
import { StateStore } from "../../src/engine/state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function subject(connector?: EngineConnector) {
  const stateRoot = await mkdtemp(join(tmpdir(), "stratum-flowcancel-edge-"));
  roots.push(stateRoot);
  return {
    engine: new StratumEngine({ stateRoot, evaluator: createEvaluator(), ...(connector ? { connector } : {}) }),
    root: stateRoot,
    store: new StateStore(stateRoot),
  };
}

const echo: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });

const taskFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${work.output}", contract: "Result" },
    steps: [{ id: "work", do: "work ${input.name}", out: "Result" }],
  } },
};

function tokenOf(response: { status: string; ready?: Array<{ dispatchToken: string }> }): string {
  if (response.status !== "ready" || !response.ready?.[0]) throw new Error("expected a ready dispatch token");
  return response.ready[0].dispatchToken;
}

/** A real child process, run to completion, so its pid+startTime name a provably dead owner —
 *  the same shape as `run_lock.test.ts`'s `deadIdentity`, but exercised through `flowCancel`
 *  itself rather than `acquireRunLock` directly. */
async function deadIdentity(): Promise<{ pid: number; startTime: string }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  const startTime = await procStartTime(pid);
  if (startTime === undefined) throw new Error("could not read the child's start time");
  await new Promise<void>((resolve) => { child.on("exit", () => resolve()); child.kill("SIGKILL"); });
  for (let tick = 0; tick < 200 && await processIdentity(pid, startTime) !== "dead"; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { pid, startTime };
}

describe("STRAT-FLOW-CANCEL-FG flowCancel edge cases", () => {
  it("a stale RUN LOCK (not a driver lease) left by a dead process is reclaimed and the cancel succeeds", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });

    // Write a `<runId>.lock` file by hand, naming a process that is now provably dead — the
    // shape a crashed engine would leave behind. This is the run's own lock file
    // (`run_lock.ts`'s `<runId>.lock`), NOT the driver lease (`<runId>.driver`, T-S01-D3):
    // no fanout ever pinned this run, so there is no lease to reclaim, only a lock.
    const dead = await deadIdentity();
    const lockFile = join(first.root, `${planned.runId}.lock`);
    await writeFile(lockFile, JSON.stringify({ pid: dead.pid, startTime: dead.startTime, token: "stale-lock", at: "now" }), "utf8");

    const otherEngine = new StratumEngine({ stateRoot: first.root, evaluator: createEvaluator(), connector: echo });

    const result = await otherEngine.flowCancel(planned.runId, "abort");
    expect(result).toMatchObject({ status: "cancelled", flowSettled: true, settledByThisCall: true });
    const persisted = await first.store.load(planned.runId);
    expect(persisted.status).toBe("cancelled");
    expect(persisted.events.filter((event) => event.type === "flow_cancelled")).toHaveLength(1);
  }, 15_000);

  it("commit+revert refused after cancel: the refused attempts leave the persisted run byte-identical", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    await first.engine.stepDone(planned.runId, "work", { output: { value: "v0" } }, tokenOf(planned));
    // Re-plan a fresh run so there is a checkpoint to attempt reverting TO, and a live carry/
    // steps shape worth proving untouched.
    const withCheckpoint = await first.engine.plan(taskFlow, { name: "Grace" });
    await first.engine.commit(withCheckpoint.runId, "before");
    await first.engine.flowCancel(withCheckpoint.runId, "abort");
    const settled = await first.store.load(withCheckpoint.runId);

    await expect(first.engine.commit(withCheckpoint.runId, "after")).rejects.toBeInstanceOf(CheckpointOperationError);
    expect(await first.store.load(withCheckpoint.runId)).toEqual(settled);

    await expect(first.engine.revert(withCheckpoint.runId, "before")).rejects.toBeInstanceOf(CheckpointOperationError);
    expect(await first.store.load(withCheckpoint.runId)).toEqual(settled);
    // The carry/steps shape genuinely survived both refused attempts, not just "some" field.
    expect((await first.store.load(withCheckpoint.runId)).steps).toEqual(settled.steps);
  });

  it("two truly concurrent cancels from two engines over the same root: one settles, one observes already_cancelled", async () => {
    const first = await subject(echo);
    const planned = await first.engine.plan(taskFlow, { name: "Ada" });
    const second = new StratumEngine({ stateRoot: first.root, evaluator: createEvaluator(), connector: echo });

    const [a, b] = await Promise.allSettled([
      first.engine.flowCancel(planned.runId, "abort"),
      second.flowCancel(planned.runId, "abort"),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    const results = [a, b].map((settlement) => (settlement as PromiseFulfilledResult<Awaited<ReturnType<typeof first.engine.flowCancel>>>).value);
    const settlers = results.filter((result) => result.settledByThisCall === true);
    const echoers = results.filter((result) => result.settledByThisCall === false);
    expect(settlers).toHaveLength(1);
    expect(echoers).toHaveLength(1);
    expect(echoers[0]).toMatchObject({ status: "cancelled", flowSettled: true, reason: "already_cancelled" });

    const persisted = await first.store.load(planned.runId);
    expect(persisted.status).toBe("cancelled");
    expect(persisted.events.filter((event) => event.type === "flow_cancelled")).toHaveLength(1);
  });
});
