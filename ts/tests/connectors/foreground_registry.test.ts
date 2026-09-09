import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentForegroundRoot,
  cancelFlowAgents,
  createForegroundRun,
  killAndReapGroup,
  reapFlowAgents,
  recordForegroundGroup,
  settleForegroundRun,
  signalFlowAgents,
  type ForegroundRunMeta,
} from "../../src/connectors/foreground_registry.js";
import { procStartTime } from "../../src/connectors/proc_identity.js";

const roots: string[] = [];
const strays: number[] = [];
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-fg-registry-"));
  roots.push(root);
  return root;
}

/** A detached group leader whose child also ignores SIGTERM — the same shape as
 *  tests/connectors/cancellation.test.ts:13-23, which is the only honest way to exercise the
 *  grace/escalate/reap ladder against a real process group. */
function writerScript(path: string, stubborn = true): string {
  const handler = stubborn ? "process.on('SIGTERM',()=>{});" : "";
  const child = `const fs = require('node:fs'); ${handler} setInterval(()=>fs.appendFileSync(${JSON.stringify(path)}, 'child\\n'), 10)`;
  return `const {spawn}=require('node:child_process'); const fs=require('node:fs'); ${handler} spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'}); setInterval(()=>fs.appendFileSync(${JSON.stringify(path)},'parent\\n'),10)`;
}

async function waitForDescendant(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readFile(path, "utf8").catch(() => "")).includes("child")) return;
    await delay(10);
  }
  throw new Error("descendant writer never started");
}

/** Spawns a real group-leading writer and returns its pid plus recorded start time. */
async function startGroup(root: string, stubborn = true): Promise<{ pid: number; startTime: string; path: string }> {
  const path = join(root, `writes-${Math.random().toString(16).slice(2)}`);
  const child = spawn(process.execPath, ["-e", writerScript(path, stubborn)], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  strays.push(pid);
  child.unref();
  await waitForDescendant(path);
  const startTime = await procStartTime(pid);
  expect(startTime).toBeDefined();
  return { pid, startTime: startTime!, path };
}

function baseMeta(flowRunId: string, overrides: Partial<ForegroundRunMeta> = {}): Omit<ForegroundRunMeta, "runId"> {
  return {
    foreground: true,
    state: "starting",
    agent: "codex",
    cancellationId: "11111111-1111-4111-8111-111111111111",
    serverPid: process.pid,
    flow: { runId: flowRunId },
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    groups: [],
    ...overrides,
  } as Omit<ForegroundRunMeta, "runId">;
}

/** A pid that is provably gone: spawned, exited, and reaped by this process. */
async function departedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await delay(20);
  return pid;
}

async function selfIdentity(): Promise<string> {
  const value = await procStartTime(process.pid);
  expect(value).toBeDefined();
  return value!;
}

async function readMeta(root: string, id: string): Promise<ForegroundRunMeta> {
  return JSON.parse(await readFile(join(root, id, "meta.json"), "utf8")) as ForegroundRunMeta;
}

async function writeMeta(root: string, id: string, meta: Omit<ForegroundRunMeta, "runId">): Promise<void> {
  await mkdir(join(root, id), { recursive: true, mode: 0o700 });
  await writeFile(join(root, id, "meta.json"), JSON.stringify({ ...meta, runId: id }, null, 2), { mode: 0o600 });
}

describe("STRAT-FLOW-CANCEL-FG foreground registry lifecycle", () => {
  it("T-S02-1: writes and stamps the meta through all three states", async () => {
    const root = await tempRoot();
    const id = await createForegroundRun(baseMeta("flow-1"), { registryRoot: root });
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(await readMeta(root, id)).toMatchObject({ runId: id, foreground: true, state: "starting", groups: [], flow: { runId: "flow-1" } });

    const group = await recordForegroundGroup(id, process.pid, { registryRoot: root });
    expect(group.childPid).toBe(process.pid);
    expect(group.procStartTime).toBeDefined();
    const running = await readMeta(root, id);
    expect(running.state).toBe("running");
    expect(running.groups).toHaveLength(1);
    expect(running.groups[0]!.procStartTime).toBe(group.procStartTime);

    await settleForegroundRun(id, { registryRoot: root });
    const settled = await readMeta(root, id);
    expect(settled.state).toBe("settled");
    expect(settled.settledAt).toEqual(expect.any(String));
  });

  it("T-S02-10: every function honours registryRoot, and STRATUM_AGENT_FG_ROOT is the fallback", async () => {
    const explicit = await tempRoot();
    const fallback = await tempRoot();
    const previous = process.env.STRATUM_AGENT_FG_ROOT;
    process.env.STRATUM_AGENT_FG_ROOT = fallback;
    try {
      expect(agentForegroundRoot()).not.toBe(fallback);
      const viaOption = await createForegroundRun(baseMeta("flow-opt"), { registryRoot: explicit });
      const viaEnv = await createForegroundRun(baseMeta("flow-env"));
      await recordForegroundGroup(viaEnv, process.pid);
      await settleForegroundRun(viaEnv);
      expect((await readMeta(fallback, viaEnv)).state).toBe("settled");
      expect((await readMeta(explicit, viaOption)).state).toBe("starting");
      // The sweep resolves the same way: an explicit root sees only its own entries.
      expect(await cancelFlowAgents("flow-env", { timeoutMs: 200, graceMs: 0, registryRoot: explicit }))
        .toMatchObject({ signalled: 0, alreadySettled: 0, unsettled: 0 });
      expect(await cancelFlowAgents("flow-env", { timeoutMs: 200, graceMs: 0 }))
        .toMatchObject({ alreadySettled: 1 });
    } finally {
      if (previous === undefined) delete process.env.STRATUM_AGENT_FG_ROOT;
      else process.env.STRATUM_AGENT_FG_ROOT = previous;
    }
  });
});

describe("STRAT-FLOW-CANCEL-FG cross-process kill", () => {
  it("T-S02-2: signals and reaps a real group recorded by another process", async () => {
    const root = await tempRoot();
    const { pid, startTime, path } = await startGroup(root, false);
    await writeMeta(root, "aaaaaaaaaaaa", baseMeta("flow-kill", { state: "running", groups: [{ childPid: pid, procStartTime: startTime }] }));

    const signalled = await signalFlowAgents("flow-kill", { registryRoot: root });
    const summary = await reapFlowAgents("flow-kill", signalled, { registryRoot: root, timeoutMs: 8000, graceMs: 50 });
    expect(summary).toMatchObject({ signalled: 1, reaped: 1, unreachable: 0, alreadySettled: 0, unresolved: 0 });

    const stopped = await readFile(path, "utf8");
    await delay(120);
    expect(await readFile(path, "utf8")).toBe(stopped);
  }, 20_000);

  it("T-S02-3: a stubborn group that outlives the deadline is not reported reaped", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, true);
    await writeMeta(root, "bbbbbbbbbbbb", baseMeta("flow-slow", { state: "running", groups: [{ childPid: pid, procStartTime: startTime }] }));

    const summary = await cancelFlowAgents("flow-slow", { registryRoot: root, timeoutMs: 300, graceMs: 10_000 });
    expect(summary.signalled).toBe(1);
    expect(summary.reaped).toBeLessThan(summary.signalled);
    expect(summary.unsettled).toBe(1);
  }, 20_000);

  it("T-S02-4: an identity mismatch is unreachable, not killed", async () => {
    const root = await tempRoot();
    const { pid, path } = await startGroup(root, false);
    await writeMeta(root, "cccccccccccc", baseMeta("flow-mismatch", { state: "running", groups: [{ childPid: pid, procStartTime: "0.0" }] }));

    const summary = await cancelFlowAgents("flow-mismatch", { registryRoot: root, timeoutMs: 300, graceMs: 0 });
    expect(summary).toMatchObject({ signalled: 0, reaped: 0, unreachable: 1 });
    // The four gates are load-bearing: the live process was never touched.
    const before = await readFile(path, "utf8");
    await delay(60);
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(before.length);
  }, 20_000);

  it("T-S02-4b: killAndReapGroup with no recorded identity signals nothing", async () => {
    const root = await tempRoot();
    const { pid, path } = await startGroup(root, false);
    expect(await killAndReapGroup(pid, { timeoutMs: 200, graceMs: 0 })).toBe("unreachable");
    const before = await readFile(path, "utf8");
    await delay(60);
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(before.length);
  }, 20_000);

  it("T-S02-5: a stamped record is skipped", async () => {
    const root = await tempRoot();
    await writeMeta(root, "dddddddddddd", baseMeta("flow-done", { state: "settled", settledAt: new Date().toISOString(), groups: [{ childPid: 1, procStartTime: "0.0" }] }));
    expect(await cancelFlowAgents("flow-done", { registryRoot: root, timeoutMs: 200, graceMs: 0 }))
      .toEqual({ signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 1, unresolved: 0, unsettled: 0 });
  });

  it("T-S02-6: a record for a different flow is not touched", async () => {
    const root = await tempRoot();
    const { pid, startTime, path } = await startGroup(root, false);
    await writeMeta(root, "eeeeeeeeeeee", baseMeta("flow-other", { state: "running", groups: [{ childPid: pid, procStartTime: startTime }] }));
    expect(await cancelFlowAgents("flow-target", { registryRoot: root, timeoutMs: 200, graceMs: 0 }))
      .toEqual({ signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 });
    const before = await readFile(path, "utf8");
    await delay(60);
    expect((await readFile(path, "utf8")).length).toBeGreaterThan(before.length);
  }, 20_000);
});

describe("STRAT-FLOW-CANCEL-FG rescan accounting", () => {
  it("T-S02-0d: the rescan catches a starting → running transition", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, false);
    const departed = await departedPid();
    const id = await createForegroundRun(baseMeta("flow-late"), { registryRoot: root });
    // The sweep starts against an entry with NO pid: a registry read once, at the top, would
    // report it unresolved and move on while the agent it names is still spawning.
    const sweep = cancelFlowAgents("flow-late", { registryRoot: root, timeoutMs: 8000, graceMs: 50 });
    await delay(60);
    await writeMeta(root, id, baseMeta("flow-late", {
      state: "running",
      serverPid: departed,
      serverProcStartTime: "0.0",
      groups: [{ childPid: pid, procStartTime: startTime }],
    }));
    const summary = await sweep;
    expect(summary).toMatchObject({ signalled: 1, reaped: 1, unresolved: 0, unsettled: 0 });
  }, 20_000);

  it("T-S02-0e: a starting entry that never gets a pid is unresolved", async () => {
    const root = await tempRoot();
    await createForegroundRun(baseMeta("flow-stuck"), { registryRoot: root });
    const summary = await cancelFlowAgents("flow-stuck", { registryRoot: root, timeoutMs: 200, graceMs: 0 });
    expect(summary).toMatchObject({ unresolved: 1, unsettled: 1, signalled: 0 });
  });

  it("T-S02-0f: no double counting across at least three passes", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, true);
    await writeMeta(root, "ffffffffffff", baseMeta("flow-passes", { state: "running", groups: [{ childPid: pid, procStartTime: startTime }] }));
    const signalled = await signalFlowAgents("flow-passes", { registryRoot: root });
    // Force several passes: the group survives SIGTERM until the escalation fires.
    const summary = await reapFlowAgents("flow-passes", signalled, { registryRoot: root, timeoutMs: 8000, graceMs: 120 });
    expect(summary.signalled).toBe(1);
    expect(summary.reaped).toBe(1);
    expect(summary.unreachable).toBe(0);
  }, 20_000);

  it("T-S02-0g: ESRCH is reaped, a recycled pid is unreachable", async () => {
    const root = await tempRoot();
    const dying = await startGroup(root, false);
    const live = await startGroup(root, false);
    await writeMeta(root, "0000aaaa0000", baseMeta("flow-split", { state: "running", groups: [{ childPid: dying.pid, procStartTime: dying.startTime }] }));
    await writeMeta(root, "0000bbbb0000", baseMeta("flow-split", { state: "running", groups: [{ childPid: live.pid, procStartTime: "0.0" }] }));

    const summary = await cancelFlowAgents("flow-split", { registryRoot: root, timeoutMs: 8000, graceMs: 30 });
    expect(summary.reaped).toBe(1);
    expect(summary.unreachable).toBe(1);
    expect(summary.signalled).toBe(1);
  }, 20_000);

  it("T-S02-0h: a reaped-but-unsettled entry with a live owner does not settle", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, false);
    await writeMeta(root, "1111aaaa1111", baseMeta("flow-live-owner", {
      state: "running",
      serverPid: process.pid,
      serverProcStartTime: await selfIdentity(),
      groups: [{ childPid: pid, procStartTime: startTime }],
    }));
    const summary = await cancelFlowAgents("flow-live-owner", { registryRoot: root, timeoutMs: 3000, graceMs: 30 });
    expect(summary.reaped).toBe(1);
    expect(summary.unsettled).toBe(1);
    expect((await readMeta(root, "1111aaaa1111")).state).toBe("running");
  }, 20_000);

  it("T-S02-0i: the dead-owner exception settles when the owner is provably gone", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, false);
    const departed = await departedPid();
    await writeMeta(root, "2222aaaa2222", baseMeta("flow-dead-owner", {
      state: "running",
      serverPid: departed,
      serverProcStartTime: "0.0",
      groups: [{ childPid: pid, procStartTime: startTime }],
    }));
    const summary = await cancelFlowAgents("flow-dead-owner", { registryRoot: root, timeoutMs: 5000, graceMs: 30 });
    expect(summary).toMatchObject({ signalled: 1, reaped: 1, unsettled: 0, unresolved: 0 });
    expect((await readMeta(root, "2222aaaa2222")).state).toBe("settled");
  }, 20_000);

  it.each([["alive"], ["unknown"]] as const)(
    "T-S02-0i2: an owner probed %s never triggers the dead-owner exception",
    async (verdict) => {
      const root = await tempRoot();
      const { pid, startTime } = await startGroup(root, false);
      await writeMeta(root, "3333aaaa3333", baseMeta("flow-recycled", {
        state: "running",
        serverPid: 999_999,
        serverProcStartTime: "0.0",
        groups: [{ childPid: pid, procStartTime: startTime }],
      }));
      // R4-3: only a POSITIVE "dead" finding licenses reclaiming another process's record.
      // An EPERM probe reads as `unknown`, and reclaiming on it would stamp a live
      // dispatcher's entry settled the moment its owner ran as another user.
      const summary = await cancelFlowAgents("flow-recycled", {
        registryRoot: root, timeoutMs: 2000, graceMs: 30, identity: async () => verdict,
      });
      expect(summary.reaped).toBe(1);
      expect(summary.unsettled).toBe(1);
      expect((await readMeta(root, "3333aaaa3333")).state).toBe("running");
    },
    20_000,
  );

  it("T-S02-0i3: an entry without serverProcStartTime is never eligible for the exception", async () => {
    const root = await tempRoot();
    const { pid, startTime } = await startGroup(root, false);
    await writeMeta(root, "4444aaaa4444", baseMeta("flow-no-token", {
      state: "running",
      serverPid: 999_999,
      groups: [{ childPid: pid, procStartTime: startTime }],
    }));
    const summary = await cancelFlowAgents("flow-no-token", { registryRoot: root, timeoutMs: 2000, graceMs: 30 });
    expect(summary.unsettled).toBe(1);
    expect((await readMeta(root, "4444aaaa4444")).state).toBe("running");
  }, 20_000);

  it("T-S02-0j: a two-group entry settles only when both pids are resolved", async () => {
    const root = await tempRoot();
    const first = await startGroup(root, false);
    const second = await startGroup(root, true);
    const departed = await departedPid();
    await writeMeta(root, "5555aaaa5555", baseMeta("flow-two", {
      state: "running",
      serverPid: departed,
      serverProcStartTime: "0.0",
      groups: [
        { childPid: first.pid, procStartTime: first.startTime },
        { childPid: second.pid, procStartTime: second.startTime },
      ],
    }));
    // One sweep, carried across two reap phases. A deadline shorter than the stubborn child's
    // escalation: one pid resolves, one does not, so the entry must NOT be stamped settled.
    const signalled = await signalFlowAgents("flow-two", { registryRoot: root });
    const partial = await reapFlowAgents("flow-two", signalled, { registryRoot: root, timeoutMs: 250, graceMs: 10_000 });
    expect(partial.signalled).toBe(2);
    expect(partial.reaped).toBe(1);
    expect(partial.unsettled).toBe(1);
    expect((await readMeta(root, "5555aaaa5555")).state).toBe("running");

    const complete = await reapFlowAgents("flow-two", signalled, { registryRoot: root, timeoutMs: 8000, graceMs: 0 });
    expect(complete.reaped).toBe(2);
    expect(complete.unsettled).toBe(0);
    expect((await readMeta(root, "5555aaaa5555")).state).toBe("settled");
  }, 30_000);

  it("reports a write failure rather than swallowing it", async () => {
    const root = await tempRoot();
    const id = await createForegroundRun(baseMeta("flow-ro"), { registryRoot: root });
    await chmod(join(root, id), 0o500);
    try {
      await expect(recordForegroundGroup(id, process.pid, { registryRoot: root })).rejects.toThrow();
    } finally {
      await chmod(join(root, id), 0o700);
    }
  });
});
