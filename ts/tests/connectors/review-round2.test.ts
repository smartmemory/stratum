import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createForegroundRun,
  killAndReapGroup,
  reapFlowAgents,
  signalFlowAgents,
  type ForegroundRunMeta,
  type ProcessProbes,
} from "../../src/connectors/foreground_registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-r2-fg-"));
  roots.push(root);
  return root;
}

interface Recorded { pid: number; signal: NodeJS.Signals; at: number }

/** A probe bundle whose identity answer can CHANGE between two points in one call — the only
 *  way to reach the recycled-pid window the escalation gates exist to close. */
function probes(options: {
  expected: string;
  identityMatchesForFirst: number;
  kills: Recorded[];
}): Partial<ProcessProbes> {
  let identityCalls = 0;
  return {
    startTime: async (_pid) => {
      identityCalls += 1;
      return identityCalls <= options.identityMatchesForFirst ? options.expected : `${options.expected}-recycled`;
    },
    groupId: async (pid) => pid,
    groupState: () => "alive",
    kill: (pid, signal) => { options.kills.push({ pid, signal, at: Date.now() }); },
  };
}

describe("F5 — the SIGKILL gates are re-run after the group-leader probe, not before it", () => {
  it("does not escalate when the identity goes stale between the leader probe and the kill", async () => {
    const kills: Recorded[] = [];
    // Calls 1 and 2 are the SIGTERM's two identity checks; call 3 is the escalation's first.
    // Call 4 — the one immediately before the SIGKILL — is where the pid turns out to have been
    // reissued. Without that fourth check the SIGKILL lands on a stranger's process group.
    const outcome = await killAndReapGroup(999_001, {
      startTime: "boot-1",
      graceMs: 0,
      timeoutMs: 2_000,
      probes: probes({ expected: "boot-1", identityMatchesForFirst: 3, kills }),
    });
    expect(outcome).toBe("unreachable");
    expect(kills.map((record) => record.signal)).toEqual(["SIGTERM"]);
  });

  it("still escalates when the identity holds all the way to the signal", async () => {
    const kills: Recorded[] = [];
    const outcome = await killAndReapGroup(999_002, {
      startTime: "boot-1",
      graceMs: 0,
      timeoutMs: 300,
      probes: probes({ expected: "boot-1", identityMatchesForFirst: Number.MAX_SAFE_INTEGER, kills }),
    });
    expect(outcome).toBe("timeout");
    expect(kills.map((record) => record.signal)).toContain("SIGKILL");
  });
});

describe("F6 — no signal is sent after the caller's deadline", () => {
  it("gives up in the gates rather than SIGTERMing a group nobody is left to reap", async () => {
    const kills: Recorded[] = [];
    const started = Date.now();
    // The identity probe alone outlasts the whole budget. An unbounded probe would answer at
    // ~800ms and the SIGTERM would be sent then — long after the caller stopped waiting.
    const outcome = await killAndReapGroup(999_003, {
      startTime: "boot-1",
      graceMs: 0,
      timeoutMs: 200,
      probes: {
        startTime: async () => { await new Promise((resolve) => setTimeout(resolve, 800)); return "boot-1"; },
        groupId: async (pid) => pid,
        groupState: () => "alive",
        kill: (pid, signal) => { kills.push({ pid, signal, at: Date.now() }); },
      },
    });
    expect(outcome).toBe("timeout");
    expect(kills).toEqual([]);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("refuses a non-finite budget instead of deadlining on NaN", async () => {
    await expect(killAndReapGroup(999_004, { startTime: "boot-1", timeoutMs: Number.NaN }))
      .rejects.toThrow(/nonnegative finite number/);
    await expect(killAndReapGroup(999_005, { startTime: "boot-1", graceMs: Number.POSITIVE_INFINITY }))
      .rejects.toThrow(/nonnegative finite number/);
  });
});

describe("F7 — a group belonging to an entry that settled before we signalled it is not unreaped", () => {
  it("acknowledges a starting → settled entry whose group was never ours to tear down", async () => {
    const root = await tempRoot();
    const flowRunId = "flow-late-settle";
    const meta: Omit<ForegroundRunMeta, "runId"> = {
      foreground: true,
      state: "starting",
      agent: "codex",
      cancellationId: "11111111-1111-4111-8111-111111111111",
      serverPid: process.pid,
      serverProcStartTime: "boot-self",
      flow: { runId: flowRunId },
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      groups: [],
    };
    const id = await createForegroundRun(meta, { registryRoot: root });

    // Pass 1 sees `starting` with no groups, so the entry is NOT counted `alreadySettled`.
    const signalled = await signalFlowAgents(flowRunId, { registryRoot: root, timeoutMs: 500 });

    // The dispatcher then records its group AND unwinds before the reap pass arrives.
    await writeFile(join(root, id, "meta.json"), JSON.stringify({
      ...meta, runId: id, state: "settled", settledAt: new Date().toISOString(),
      groups: [{ childPid: 999_006, procStartTime: "boot-child" }],
    }), "utf8");

    const summary = await reapFlowAgents(flowRunId, signalled, { registryRoot: root, timeoutMs: 500 });
    // The sweep deliberately never signals that group and `entryResolved` deliberately ignores
    // it. Counting its absent outcome as `unreaped` contradicted both and turned a completed
    // teardown into a timeout.
    expect(summary.unreaped).toBe(0);
    expect(summary.signalled).toBe(0);
    expect(summary.unsettled).toBe(0);
    expect(summary.unresolved).toBe(0);
    expect(summary.unreachable).toBe(0);
  });
});
