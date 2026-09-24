import { isolatedStateRoot } from "../helpers/state-root.js";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile , readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { runAgent } from "../../src/connectors/runner.js";
import type { ForegroundRunMeta } from "../../src/connectors/foreground_registry.js";
import { StratumEngine } from "../../src/engine/engine.js";
import { acquireRunLock } from "../../src/engine/run_lock.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { assertShape, assertToolResponse, mcpSurface } from "../../src/mcp/contracts.js";
import { createMcpServer, createToolDispatcher, type McpDependencies, type ToolDispatcher } from "../../src/mcp/server.js";

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

/** An ENGINE-dispatch fanout: the connector call happens inside the engine, so a blocked
 *  connector leaves the run pinned and its driver lease held. */
const fanoutFlow = {
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

interface Harness {
  dispatcher: ToolDispatcher;
  engine: StratumEngine;
  store: StateStore;
  registryRoot: string;
  stateRoot: string;
  runId: string;
  dispatchToken: string;
}

async function harness(extra: Partial<McpDependencies> = {}): Promise<Harness> {
  const stateRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-state-"));
  const registryRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-reg-"));
  roots.push(stateRoot, registryRoot);
  const engine = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
  const dispatcher = createToolDispatcher({ engine, foregroundRegistryRoot: registryRoot, ...extra });
  const planned = await dispatcher.call("stratum_plan", { spec: simpleFlow, input: { name: "Ada" } });
  const ready = planned.ready as Array<{ id: string; dispatchToken: string }>;
  return {
    dispatcher, engine, store: new StateStore(stateRoot), registryRoot, stateRoot,
    runId: planned.runId as string, dispatchToken: ready[0]!.dispatchToken,
  };
}

/** A registry entry written by hand, so a sweep verdict can be forced without a live child. */
async function writeEntry(registryRoot: string, flowRunId: string, meta: Partial<ForegroundRunMeta> = {}): Promise<string> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  await mkdir(join(registryRoot, id), { recursive: true });
  const record: ForegroundRunMeta = {
    runId: id, foreground: true, state: "starting", agent: "codex", cancellationId: randomUUID(),
    serverPid: process.pid, flow: { runId: flowRunId }, cwd: process.cwd(),
    createdAt: new Date().toISOString(), groups: [], ...meta,
  } as ForegroundRunMeta;
  await writeFile(join(registryRoot, id, "meta.json"), JSON.stringify(record), "utf8");
  return id;
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

/** Spawns a REAL detached group leader and reports its pid through `onSpawn`, exactly as the
 *  connectors do. Everything the cancel claims is meaningless against a fake pid. */
function spawningAgent(path: string): typeof runAgent {
  return (async (run) => {
    const child = spawn(process.execPath, ["-e", writerScript(path)], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    strays.push(pid);
    child.unref();
    await waitForDescendant(path);
    run.onSpawn?.(pid);
    await new Promise<void>((resolve) => {
      if (run.signal === undefined) { resolve(); return; }
      if (run.signal.aborted) { resolve(); return; }
      run.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    if (run.signal?.aborted) throw new Error("cancelled");
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

async function onlyEntry(registryRoot: string): Promise<ForegroundRunMeta> {
  const names = await readdir(registryRoot).catch(() => [] as string[]);
  const found: ForegroundRunMeta[] = [];
  for (const name of names) {
    const raw = await readFile(join(registryRoot, name, "meta.json"), "utf8").catch(() => undefined);
    if (raw !== undefined) found.push(JSON.parse(raw) as ForegroundRunMeta);
  }
  expect(found).toHaveLength(1);
  return found[0]!;
}

function errorData(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(McpError);
  return (error as McpError).data as Record<string, unknown>;
}

/** A background flow parked in a blocking connector, then cancelled through the SAME dispatcher
 *  that drives it — a bg run is pinned, so a cross-process foreground cancel is refused. */
async function bgSubject(): Promise<{ dispatcher: ToolDispatcher; runId: string }> {
  const stateRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-bg-"));
  roots.push(stateRoot);
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const engine = new StratumEngine({
    stateRoot, evaluator: createEvaluator(),
    connector: async ({ prompt }) => { await blocked; return { output: { value: prompt } }; },
  });
  const dispatcher = createToolDispatcher({ engine });
  const started = await dispatcher.call("stratum_flow_run_bg", { spec: simpleFlow, input: { name: "Ada" } });
  const runId = started.runId as string;
  for (let tick = 0; tick < 200; tick += 1) {
    const polled = await dispatcher.call("stratum_flow_bg_poll", { runId, cursor: 0 });
    if ((polled.bg as { status: string }).status === "running") break;
    await delay(5);
  }
  const cancelled = await dispatcher.call("stratum_flow_cancel", { runId });
  expect(cancelled).toMatchObject({ status: "cancelled", flowSettled: true });
  release?.();
  return { dispatcher, runId };
}

const ZERO_AGENTS = { signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 };

describe("STRAT-FLOW-CANCEL-FG stratum_flow_cancel", () => {
  it("T-S03-1: cancels a running flow and returns a contract-valid acknowledgement", async () => {
    const subject = await harness();
    const payload = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    await assertToolResponse("stratum_flow_cancel", payload);
    expect(payload).toMatchObject({ status: "cancelled", flowSettled: true, acknowledged: true, agents: ZERO_AGENTS });
    // `settledByThisCall` is engine-internal and must never reach the wire.
    expect(payload.settledByThisCall).toBeUndefined();
    expect((await subject.store.load(subject.runId)).status).toBe("cancelled");
  });

  it("T-S03-2/T-S03-4b: an already-completed run is a success with no sweep", async () => {
    const subject = await harness();
    const done = await subject.dispatcher.call("stratum_step_done", {
      runId: subject.runId, stepId: "build", result: { output: { value: "v" } }, dispatchToken: subject.dispatchToken,
    });
    expect(done.status).toBe("completed");
    // A live registry entry would fail the sweep — it must never be looked at.
    await writeEntry(subject.registryRoot, subject.runId, { state: "starting" });

    const payload = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    await assertToolResponse("stratum_flow_cancel", payload);
    expect(payload).toMatchObject({
      status: "completed", flowSettled: false, acknowledged: false, reason: "already_completed", agents: ZERO_AGENTS,
    });
    expect((await subject.store.load(subject.runId)).status).toBe("completed");
  });

  it("T-S03-3: the same-process fast path aborts a live controller and its descendant stops writing", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fgc-writes-")), "writes");
    roots.push(path);
    const subject = await harness({ runAgent: spawningAgent(path) });
    const agentCall = subject.dispatcher.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), cancellationId: randomUUID(), flow: { runId: subject.runId, stepId: "build" },
    }).catch((error: unknown) => error);
    await waitForDescendant(path);
    await waitForRecordedGroup(subject.registryRoot, subject.runId);

    const payload = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    await assertToolResponse("stratum_flow_cancel", payload);
    expect(payload).toMatchObject({ status: "cancelled", flowSettled: true, acknowledged: true });
    expect(payload.agents).toMatchObject({ signalled: 1, reaped: 1, unreachable: 0, unresolved: 0, unsettled: 0 });
    expect(await agentCall).toBeInstanceOf(Error);
    // "Cancelled" means the descendant stopped writing, not that a promise rejected.
    const stopped = await readFile(path, "utf8");
    await delay(120);
    expect(await readFile(path, "utf8")).toBe(stopped);
  });

  it("T-S03-4: an unresolved teardown raises the declared envelope over a SETTLED run", async () => {
    const subject = await harness({ cancellationTimeoutMs: 60 });
    await writeEntry(subject.registryRoot, subject.runId, { state: "starting" });

    const failure = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId }).catch((error: unknown) => error);
    const data = errorData(failure);
    expect(data).toMatchObject({
      code: "CANCELLATION_TEARDOWN_TIMEOUT", runId: subject.runId, status: "cancelled", flowSettled: true,
    });
    expect(data.agents).toMatchObject({ unresolved: 1, unsettled: 1 });
    assertShape(data, (await mcpSurface()).errors.flow_cancel_unacknowledged!.data, "errors.flow_cancel_unacknowledged.data");
    // Settle-first (D4): the flow half succeeded even though the agent half did not.
    expect((await subject.store.load(subject.runId)).status).toBe("cancelled");
  });

  it("T-S03-4c: cancelling an already-cancelled run re-runs the sweep", async () => {
    const subject = await harness({ cancellationTimeoutMs: 60 });
    const first = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    expect(first).toMatchObject({ status: "cancelled", acknowledged: true });

    const entryId = await writeEntry(subject.registryRoot, subject.runId, { state: "starting" });
    const second = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId }).catch((error: unknown) => error);
    expect(errorData(second)).toMatchObject({ code: "CANCELLATION_TEARDOWN_TIMEOUT", status: "cancelled", flowSettled: true });

    const meta = JSON.parse(await readFile(join(subject.registryRoot, entryId, "meta.json"), "utf8")) as ForegroundRunMeta;
    await writeFile(join(subject.registryRoot, entryId, "meta.json"),
      JSON.stringify({ ...meta, state: "settled", settledAt: new Date().toISOString() }), "utf8");
    const third = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    await assertToolResponse("stratum_flow_cancel", third);
    expect(third).toMatchObject({ status: "cancelled", flowSettled: true, acknowledged: true, reason: "already_cancelled" });
    expect(third.agents).toMatchObject({ alreadySettled: 1, unsettled: 0 });
  });

  it("T-S03-4d: a held run lock surfaces as CANCELLATION_UNCONFIRMED with a holderPid", async () => {
    const subject = await harness();
    const previous = process.env.STRATUM_CANCEL_LOCK_WAIT_MS;
    process.env.STRATUM_CANCEL_LOCK_WAIT_MS = "60";
    const release = await acquireRunLock(subject.stateRoot, subject.runId);
    try {
      const failure = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId }).catch((error: unknown) => error);
      const data = errorData(failure);
      expect(data).toMatchObject({
        code: "CANCELLATION_UNCONFIRMED", runId: subject.runId, status: "running", flowSettled: false,
        reason: "run_lock_held", holderPid: process.pid, agents: ZERO_AGENTS,
      });
      assertShape(data, (await mcpSurface()).errors.flow_cancel_unacknowledged!.data, "errors.flow_cancel_unacknowledged.data");
      // Nothing was mutated: the run is still running.
      expect((await subject.store.load(subject.runId)).status).toBe("running");
    } finally {
      await release();
      if (previous === undefined) delete process.env.STRATUM_CANCEL_LOCK_WAIT_MS;
      else process.env.STRATUM_CANCEL_LOCK_WAIT_MS = previous;
    }
  });

  it("T-S03-4e: a refused cancel sweeps NOTHING — the run lock case leaves the agent alive", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fgc-alive-")), "writes");
    roots.push(path);
    const subject = await harness({ runAgent: spawningAgent(path) });
    const cancellationId = randomUUID();
    const agentCall = subject.dispatcher.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), cancellationId, flow: { runId: subject.runId },
    }).catch((error: unknown) => error);
    await waitForDescendant(path);
    await waitForRecordedGroup(subject.registryRoot, subject.runId);

    const previous = process.env.STRATUM_CANCEL_LOCK_WAIT_MS;
    process.env.STRATUM_CANCEL_LOCK_WAIT_MS = "60";
    const release = await acquireRunLock(subject.stateRoot, subject.runId);
    try {
      const failure = await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId }).catch((error: unknown) => error);
      expect(errorData(failure)).toMatchObject({
        code: "CANCELLATION_UNCONFIRMED", reason: "run_lock_held", flowSettled: false, agents: ZERO_AGENTS,
      });
      // Settle-first is absolute: the flow is still running, so its agent must still be running
      // too. A dead agent under a live flow is the hazard the ordering exists to prevent.
      expect((await subject.store.load(subject.runId)).status).toBe("running");
      const seen = await readFile(path, "utf8");
      await delay(120);
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(seen.length);
      expect((await onlyEntry(subject.registryRoot)).state).toBe("running");
    } finally {
      await release();
      if (previous === undefined) delete process.env.STRATUM_CANCEL_LOCK_WAIT_MS;
      else process.env.STRATUM_CANCEL_LOCK_WAIT_MS = previous;
      await subject.dispatcher.call("stratum_cancel_agent_run", { runId: cancellationId }).catch(() => undefined);
      await agentCall;
    }
  });

  it("T-S03-4f: a pinned run refuses a cross-process cancel and leaves its agent alive", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "stratum-fgc-pinned-")), "writes");
    const stateRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-pin-state-"));
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-pin-reg-"));
    roots.push(path, stateRoot, registryRoot);
    let connectorCalls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const engineA = new StratumEngine({
      stateRoot, evaluator: createEvaluator(),
      connector: async ({ prompt }) => { connectorCalls += 1; await blocked; return { output: { value: prompt } }; },
    });
    const dispatcherA = createToolDispatcher({ engine: engineA, foregroundRegistryRoot: registryRoot, runAgent: spawningAgent(path) });
    const planned = await dispatcherA.call("stratum_plan", { spec: fanoutFlow, input: { name: "Ada" } });
    const runId = planned.runId as string;
    await dispatcherA.call("stratum_step_done", {
      runId, stepId: "prep", result: { output: { items: ["a", "b"] } },
      dispatchToken: (planned.ready as Array<{ dispatchToken: string }>)[0]!.dispatchToken,
    });
    // The engine-dispatch fanout is inside the connector, so engine A holds the pin and the
    // driver lease for this run.
    for (let tick = 0; tick < 400 && connectorCalls === 0; tick += 1) await delay(5);
    expect(connectorCalls).toBe(1);

    const cancellationId = randomUUID();
    const agentCall = dispatcherA.call("stratum_agent_run", {
      agent: "codex", prompt: "p", cwd: process.cwd(), cancellationId, flow: { runId },
    }).catch((error: unknown) => error);
    try {
      await waitForDescendant(path);
      await waitForRecordedGroup(registryRoot, runId);

      const engineB = new StratumEngine({ stateRoot, evaluator: createEvaluator() });
      const dispatcherB = createToolDispatcher({ engine: engineB, foregroundRegistryRoot: registryRoot });
      const failure = await dispatcherB.call("stratum_flow_cancel", { runId }).catch((error: unknown) => error);
      expect(errorData(failure)).toMatchObject({
        code: "CANCELLATION_UNCONFIRMED", runId, reason: "engine_dispatch_active",
        holderPid: process.pid, status: "running", flowSettled: false, agents: ZERO_AGENTS,
      });
      expect((await new StateStore(stateRoot).load(runId)).status).toBe("running");
      const seen = await readFile(path, "utf8");
      await delay(120);
      expect((await readFile(path, "utf8")).length).toBeGreaterThan(seen.length);
    } finally {
      await dispatcherA.call("stratum_cancel_agent_run", { runId: cancellationId }).catch(() => undefined);
      release?.();
      await agentCall;
    }
  });

  it("T-S03-5: stratum_agent_run advertises `flow` on its published input schema", async () => {
    const server = await createMcpServer({ flowStateRoot: isolatedStateRoot() });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flow-cancel-test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = (await client.listTools()).tools;
      const agentRun = tools.find((tool) => tool.name === "stratum_agent_run");
      expect((agentRun!.inputSchema.properties as Record<string, unknown>).flow).toBeDefined();
      expect(tools.some((tool) => tool.name === "stratum_flow_cancel")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("T-S03-7: every declared `cancelled` variant is produced or refused by the REAL dispatcher", async () => {
    const subject = await harness();
    await subject.dispatcher.call("stratum_flow_cancel", { runId: subject.runId });
    const surface = await mcpSurface();
    // Every run-status tool that CAN emit a cancelled payload declares one. A declaration is a
    // promise about what the code emits — tests/mcp/p5.test.ts pins declared == emitted — so a
    // tool that refuses a cancelled run rather than returning one must NOT declare the variant.
    const declared = ["stratum_audit", "stratum_flow_poll", "stratum_flow_bg_poll"] as const;
    for (const tool of declared) {
      expect(surface.tools[tool]!.responses.cancelled, `${tool} declares cancelled`).toBeDefined();
    }
    for (const tool of ["stratum_plan", "stratum_resume", "stratum_step_done", "stratum_gate_resolve", "stratum_revert"] as const) {
      expect(surface.tools[tool]!.responses.cancelled, `${tool} must not declare cancelled`).toBeUndefined();
    }

    // Tools that CAN emit a cancelled payload: the dispatcher produces it, and the contract
    // accepts what the code actually emits (which is where R2-9 and R3-9 both hid).
    for (const tool of ["stratum_audit", "stratum_flow_poll"] as const) {
      const payload = await subject.dispatcher.call(tool, { runId: subject.runId, ...(tool === "stratum_audit" ? {} : { cursor: 0 }) });
      expect(payload.status, tool).toBe("cancelled");
      await assertToolResponse(tool, payload);
    }
    // `stratum_flow_bg_poll` needs a run with a background driver, so it gets its own subject:
    // a bg flow parked in a blocking connector, cancelled through the dispatcher that drives it.
    const bg = await bgSubject();
    const bgPayload = await bg.dispatcher.call("stratum_flow_bg_poll", { runId: bg.runId, cursor: 0 });
    expect(bgPayload.status).toBe("cancelled");
    await assertToolResponse("stratum_flow_bg_poll", bgPayload);
    // Tools that refuse a cancelled run rather than returning one — the refusal is the
    // behaviour under test, and it is why their declared variant is never exercised on the wire.
    await expect(subject.dispatcher.call("stratum_resume", { runId: subject.runId })).rejects.toThrow(/cancelled/);
    await expect(subject.dispatcher.call("stratum_step_done", {
      runId: subject.runId, stepId: "build", result: { output: { value: "v" } }, dispatchToken: subject.dispatchToken,
    })).rejects.toThrow(/cancelled/);
    await expect(subject.dispatcher.call("stratum_gate_resolve", {
      runId: subject.runId, stepId: "build", decision: "approve", gateToken: "t",
    })).rejects.toThrow(/cancelled/);
  });

  it("T-S03-9: both admission envelopes are declared and default-deny", async () => {
    const errors = (await mcpSurface()).errors;
    expect(() => assertShape({ code: "flow_not_running", runId: "r", status: "cancelled" },
      errors.flow_not_running!.data, "errors.flow_not_running.data")).not.toThrow();
    expect(() => assertShape({ code: "flow_not_running", runId: "r", undeclared: true },
      errors.flow_not_running!.data, "errors.flow_not_running.data")).toThrow(/undeclared/);
    expect(() => assertShape({ code: "flow_admission_failed", runId: "r" },
      errors.flow_admission_failed!.data, "errors.flow_admission_failed.data")).not.toThrow();
    expect(() => assertShape({ code: "flow_admission_failed", runId: "r", status: "running" },
      errors.flow_admission_failed!.data, "errors.flow_admission_failed.data")).toThrow(/undeclared/);
    // There is no `flow_cancelled` error envelope: S02 shipped both admission refusals as
    // `flow_not_running`, and the checkpoint refusal travels in commit/revert's own `error`
    // response variant, so nothing would ever raise it.
    expect(errors.flow_cancelled).toBeUndefined();
  });
});
