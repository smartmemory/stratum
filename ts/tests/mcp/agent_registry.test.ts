import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { runAgent } from "../../src/connectors/runner.js";
import {
  reapFlowAgents,
  signalFlowAgents,
  type ForegroundRunMeta,
} from "../../src/connectors/foreground_registry.js";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { createToolDispatcher, type ToolDispatcher } from "../../src/mcp/server.js";

const roots: string[] = [];
const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)));
});

const simpleFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};

interface Harness {
  dispatcher: ToolDispatcher;
  engine: StratumEngine;
  registryRoot: string;
  stateRoot: string;
  runId: string;
  dispatchToken: string;
}

async function harness(agent?: typeof runAgent): Promise<Harness> {
  const stateRoot = await mkdtemp(join(tmpdir(), "stratum-fg-state-"));
  const registryRoot = await mkdtemp(join(tmpdir(), "stratum-fg-reg-"));
  roots.push(stateRoot, registryRoot);
  const engine = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
  const dispatcher = createToolDispatcher({
    engine,
    foregroundRegistryRoot: registryRoot,
    ...(agent !== undefined ? { runAgent: agent } : {}),
  });
  const planned = await dispatcher.call("stratum_plan", { spec: simpleFlow, input: { name: "Ada" } });
  const ready = planned.ready as Array<{ id: string; dispatchToken: string }>;
  return { dispatcher, engine, registryRoot, stateRoot, runId: planned.runId as string, dispatchToken: ready[0]!.dispatchToken };
}

function agentRequest(runId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "codex",
    prompt: "p",
    cwd: process.cwd(),
    cancellationId: randomUUID(),
    flow: { runId },
    ...extra,
  };
}

async function entries(registryRoot: string): Promise<ForegroundRunMeta[]> {
  const names = await readdir(registryRoot).catch(() => [] as string[]);
  const found: ForegroundRunMeta[] = [];
  for (const name of names) {
    const raw = await readFile(join(registryRoot, name, "meta.json"), "utf8").catch(() => undefined);
    if (raw !== undefined) found.push(JSON.parse(raw) as ForegroundRunMeta);
  }
  return found;
}

async function onlyEntry(registryRoot: string): Promise<ForegroundRunMeta> {
  const found = await entries(registryRoot);
  expect(found).toHaveLength(1);
  return found[0]!;
}

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

/**
 * A `runAgent` stand-in that spawns REAL detached group leaders and reports each pid through
 * `onSpawn`, exactly as the connectors do (S02-1). Everything the registry claims — the four
 * identity gates, the group kill, the reap — is meaningless against a fake pid, so this seam
 * spawns real processes and lets the abort signal tear them down.
 */
function spawningAgent(options: {
  path: string;
  spawns?: number;
  beforeSpawn?: () => Promise<void> | void;
  afterSpawn?: (pid: number) => Promise<void> | void;
  pid?: () => Promise<number>;
}): typeof runAgent {
  return (async (run) => {
    await options.beforeSpawn?.();
    const pids: number[] = [];
    for (let index = 0; index < (options.spawns ?? 1); index += 1) {
      let pid: number;
      if (options.pid) { pid = await options.pid(); }
      else {
        const child = spawn(process.execPath, ["-e", writerScript(options.path)], { detached: true, stdio: "ignore" });
        pid = child.pid!;
        strays.push(pid);
        child.unref();
        await waitForDescendant(options.path);
      }
      pids.push(pid);
      run.onSpawn?.(pid);
      await options.afterSpawn?.(pid);
    }
    const killAll = (): void => {
      for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
    };
    if (run.signal?.aborted) { killAll(); throw new Error("cancelled"); }
    await new Promise<void>((resolve) => {
      if (run.signal === undefined) { resolve(); return; }
      run.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    killAll();
    if (run.signal?.aborted) throw new Error("cancelled");
    return completeResult();
  }) as typeof runAgent;
}

function completeResult(): never {
  return { text: "done", usage: { tokens: 0 }, telemetry: { durationMs: 1, model: "fixture" } } as never;
}

function errorData(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data as Record<string, unknown>;
}

describe("STRAT-FLOW-CANCEL-FG agent-run admission", () => {
  it("T-S02-0: a cancelled flow refuses the run before anything is spawned", async () => {
    let spawned = false;
    const subject = await harness(spawningAgent({ path: "/dev/null", beforeSpawn: () => { spawned = true; } }));
    await subject.engine.flowCancel(subject.runId, "test");

    const failure = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId)).catch((error: unknown) => error);
    expect(errorData(failure)).toMatchObject({ code: "flow_not_running", runId: subject.runId });
    expect(spawned).toBe(false);
    expect((await onlyEntry(subject.registryRoot)).state).toBe("settled");
  });

  it("T-S02-0a2: admission fails closed on an unknown, corrupt or terminal run", async () => {
    let spawned = false;
    const subject = await harness(spawningAgent({ path: "/dev/null", beforeSpawn: () => { spawned = true; } }));

    const unknown = await subject.dispatcher.call("stratum_agent_run", agentRequest("run-does-not-exist")).catch((error: unknown) => error);
    expect(errorData(unknown)).toMatchObject({ code: "flow_not_running", runId: "run-does-not-exist" });

    await writeFile(join(subject.stateRoot, `${subject.runId}.json`), "{not json", "utf8");
    const corrupt = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId)).catch((error: unknown) => error);
    expect(errorData(corrupt)).toMatchObject({ code: "flow_admission_failed", runId: subject.runId });

    const terminal = await harness(spawningAgent({ path: "/dev/null", beforeSpawn: () => { spawned = true; } }));
    const done = await terminal.dispatcher.call("stratum_step_done", {
      runId: terminal.runId, stepId: "build", result: { output: { value: "v" } }, dispatchToken: terminal.dispatchToken,
    });
    expect(done.status).toBe("completed");
    const completed = await terminal.dispatcher.call("stratum_agent_run", agentRequest(terminal.runId)).catch((error: unknown) => error);
    expect(errorData(completed)).toMatchObject({ code: "flow_not_running", runId: terminal.runId });

    expect(spawned).toBe(false);
    for (const entry of [...await entries(subject.registryRoot), ...await entries(terminal.registryRoot)]) {
      expect(entry.state).toBe("settled");
    }
  });

  it("T-S02-7: flow without cancellationId is rejected, and so is flow with background", async () => {
    const subject = await harness(spawningAgent({ path: "/dev/null" }));
    const bare = await subject.dispatcher.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), flow: { runId: subject.runId },
    }).catch((error: unknown) => error);
    expect(errorData(bare)).toMatchObject({ code: "input_validation_failed" });
    expect((errorData(bare).errors as Array<{ path: string }>)[0]!.path).toBe("flow");

    const background = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId, { background: true }))
      .catch((error: unknown) => error);
    expect(errorData(background)).toMatchObject({ code: "input_validation_failed" });
    expect(await entries(subject.registryRoot)).toHaveLength(0);
  });

  it("T-S02-8: no flow field means no registry entry at all", async () => {
    const subject = await harness((async () => completeResult()) as never);
    await subject.dispatcher.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), cancellationId: randomUUID(),
    });
    expect(await entries(subject.registryRoot)).toHaveLength(0);
  });
});

describe("STRAT-FLOW-CANCEL-FG registry lifecycle through the dispatcher", () => {
  it("T-S02-1: writes starting, stamps running with a real identity, and settles", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fg-writes-")), "writes");
    roots.push(join(path, ".."));
    const subject = await harness(spawningAgent({ path }));
    const call = subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId, { model: "gpt-5.6-terra" }));

    await waitForDescendant(path);
    await delay(80);
    const running = await onlyEntry(subject.registryRoot);
    expect(running).toMatchObject({
      foreground: true,
      state: "running",
      agent: "codex",
      model: "gpt-5.6-terra",
      serverPid: process.pid,
      flow: { runId: subject.runId },
    });
    expect(running.groups).toHaveLength(1);
    expect(running.groups[0]!.procStartTime).toEqual(expect.any(String));
    if (process.platform === "darwin") expect(running.groups[0]!.procStartTime).toMatch(/^\d+\.\d+$/);
    expect(running.serverProcStartTime).toEqual(expect.any(String));

    await subject.dispatcher.call("stratum_cancel_agent_run", { runId: String(running.cancellationId) });
    await call.catch(() => undefined);
    const settled = await onlyEntry(subject.registryRoot);
    expect(settled.state).toBe("settled");
    expect(settled.settledAt).toEqual(expect.any(String));
  }, 30_000);

  it("T-S02-9: two spawns record two groups", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fg-writes2-")), "writes");
    roots.push(join(path, ".."));
    const subject = await harness(spawningAgent({ path, spawns: 2 }));
    const call = subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId));
    await waitForDescendant(path);
    for (let tick = 0; tick < 200; tick += 1) {
      const found = await entries(subject.registryRoot);
      if (found[0]?.groups.length === 2) break;
      await delay(20);
    }
    const running = await onlyEntry(subject.registryRoot);
    expect(running.groups).toHaveLength(2);
    expect(new Set(running.groups.map((group) => group.childPid)).size).toBe(2);

    const summary = await reapFlowAgents(subject.runId, await signalFlowAgents(subject.runId, { registryRoot: subject.registryRoot }), {
      registryRoot: subject.registryRoot, timeoutMs: 8000, graceMs: 0,
    });
    expect(summary.signalled).toBe(2);
    await subject.dispatcher.call("stratum_cancel_agent_run", { runId: String(running.cancellationId) }).catch(() => undefined);
    await call.catch(() => undefined);
  }, 30_000);

  it("T-S02-2: a second dispatcher's sweep kills the group over the same roots", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fg-writes3-")), "writes");
    roots.push(join(path, ".."));
    const subject = await harness(spawningAgent({ path }));
    const call = subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId));
    await waitForDescendant(path);
    await delay(80);

    // Standing in for the second process: it knows only the registry root and the flow id.
    const summary = await reapFlowAgents(subject.runId, await signalFlowAgents(subject.runId, { registryRoot: subject.registryRoot }), {
      registryRoot: subject.registryRoot, timeoutMs: 10_000, graceMs: 50,
    });
    expect(summary).toMatchObject({ signalled: 1, reaped: 1, unreachable: 0, unresolved: 0 });

    const stopped = await readFile(path, "utf8");
    await delay(150);
    expect(await readFile(path, "utf8")).toBe(stopped);
    const entry = await onlyEntry(subject.registryRoot);
    await subject.dispatcher.call("stratum_cancel_agent_run", { runId: String(entry.cancellationId) }).catch(() => undefined);
    await call.catch(() => undefined);
  }, 30_000);
});

describe("STRAT-FLOW-CANCEL-FG registration failures are never swallowed", () => {
  it("T-S02-0b/T-S02-0a3: a cancel landing between spawn and stamp kills the group and fails the call", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fg-writes4-")), "writes");
    roots.push(join(path, ".."));
    let engineRef: StratumEngine | undefined;
    let cancelledRunId: string | undefined;
    const subject = await harness(spawningAgent({
      path,
      // The cancel lands after the pid exists but before the post-stamp admission check runs.
      afterSpawn: async () => { await engineRef!.flowCancel(cancelledRunId!, "raced"); },
    }));
    engineRef = subject.engine;
    cancelledRunId = subject.runId;

    const failure = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId)).catch((error: unknown) => error);
    expect(errorData(failure)).toMatchObject({ code: "flow_not_running", runId: subject.runId });

    const entry = await onlyEntry(subject.registryRoot);
    expect(entry.state).toBe("settled");
    expect(entry.groups).toHaveLength(1);
    // The group was killed with its RECORDED identity (R3-8), not merely abandoned.
    const stopped = await readFile(path, "utf8");
    await delay(150);
    expect(await readFile(path, "utf8")).toBe(stopped);
  }, 30_000);

  it("T-S02-0c: a group-write failure aborts the run, kills the child and fails the call", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fg-writes5-")), "writes");
    roots.push(join(path, ".."));
    const subject = await harness(spawningAgent({
      path,
      // Fault-inject the meta rewrite: the run directory is read-only by the time onSpawn fires.
      beforeSpawn: async () => {
        const [name] = await readdir(subject.registryRoot);
        await chmod(join(subject.registryRoot, name!), 0o500);
      },
    }));
    const failure = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const [name] = await readdir(subject.registryRoot);
    await chmod(join(subject.registryRoot, name!), 0o700);

    // The controller was aborted, so the connector's own teardown reached the group even
    // though no identity was ever recorded for it (invariant 15b).
    const stopped = await readFile(path, "utf8");
    await delay(150);
    expect(await readFile(path, "utf8")).toBe(stopped);
  }, 30_000);

  it("T-S02-0c2: a missing procStartTime is a registration failure, not a degraded success", async () => {
    const subject = await harness(spawningAgent({
      path: "/dev/null",
      // A pid that has already exited has no readable start time — the same observable
      // condition as darwin's libproc failing closed (proc_identity.ts:50-58).
      pid: async () => {
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
        const pid = child.pid!;
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        await delay(20);
        return pid;
      },
    }));
    const failure = await subject.dispatcher.call("stratum_agent_run", agentRequest(subject.runId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/start time|cancelled/i);
    expect((await onlyEntry(subject.registryRoot)).state).toBe("settled");
  }, 30_000);
});
