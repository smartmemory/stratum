import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as identity from "../../src/connectors/proc_identity.js";
import { runAgent } from "../../src/connectors/runner.js";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { createToolDispatcher, type McpDependencies } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(agent: NonNullable<McpDependencies["runAgent"]>) {
  const root = await mkdtemp(join(tmpdir(), "stratum-fast-exit-"));
  roots.push(root);
  const registryRoot = join(root, "registry");
  const engine = new StratumEngine({ stateRoot: join(root, "state"), evaluator: createEvaluator() });
  const dispatcher = createToolDispatcher({ engine, foregroundRegistryRoot: registryRoot, runAgent: agent });
  const planned = await dispatcher.call("stratum_plan", {
    spec: {
      version: 1, contracts: { Result: { value: "string" } },
      flows: { entry: "main", main: {
        input: {}, output: { from: "${build.output}", contract: "Result" },
        steps: [{ id: "build", do: "build", out: "Result" }],
      } },
    }, input: {},
  });
  return {
    call: () => dispatcher.call("stratum_agent_run", {
      agent: "codex", prompt: "test", cwd: root, model: "gpt-5.6-terra",
      cancellationId: randomUUID(), flow: { runId: planned.runId },
    }),
    meta: async () => {
      const entries = await readdir(registryRoot);
      expect(entries).toHaveLength(1);
      return JSON.parse(await readFile(join(registryRoot, entries[0]!, "meta.json"), "utf8"));
    },
  };
}

describe("STRAT-FLOW-CANCEL-FG fast exit registration", () => {
  for (const mode of ["native darwin", "probe after exit", "zombie window"] as const) {
    it.skipIf(mode === "native darwin" && process.platform !== "darwin")(
      `preserves the real immediate child's agent result through onSpawn (${mode})`, async () => {
        let child: ChildProcess | undefined;
        let exited: Promise<void> | undefined;
        const realStartTime = identity.procStartTime;
        if (mode !== "native darwin") {
          // Deterministically reproduce the slow libproc race on every platform, while
          // keeping the child, identity lookup and dispatcher registration link real.
          vi.spyOn(identity, "procStartTime").mockImplementation(async (pid) => {
            if (pid === child?.pid) await exited;
            return realStartTime(pid);
          });
        }
        const realKill = process.kill.bind(process);
        let pidChecks = 0;
        if (mode === "zombie window") {
          vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
            if (pid === child?.pid && signal === 0 && ++pidChecks === 1) return true;
            return realKill(pid, signal);
          });
        }
        const subject = await harness((options) => runAgent(options, {
          codexSpawn: (_command, _args, spawnOptions) => {
            const spawned = spawn("sh", ["-c", `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"fast result"}}'; exit 0`], spawnOptions);
            child = spawned;
            exited = new Promise<void>((resolve, reject) => {
              spawned.once("exit", () => resolve());
              spawned.once("error", reject);
            });
            return spawned;
          },
        }));
        await expect(subject.call()).resolves.toMatchObject({ status: "complete", text: "fast result" });
        expect(child?.exitCode).toBe(0);
        expect(await subject.meta()).toMatchObject({ state: "settled", groups: [] });
        if (mode === "zombie window") expect(pidChecks).toBeGreaterThanOrEqual(2);
      },
    );
  }

  it.each(["alive", "EPERM", "unknown"])("fails closed when identity is missing and the pid is %s", async (state) => {
    let pid: number | undefined;
    let signal: AbortSignal | undefined;
    const realStartTime = identity.procStartTime;
    vi.spyOn(identity, "procStartTime").mockImplementation((value) =>
      value === pid ? Promise.resolve(undefined) : realStartTime(value));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((value, kind) => {
      if (value === pid && kind === 0 && state !== "alive") {
        throw Object.assign(new Error("opaque probe"), { code: state === "EPERM" ? "EPERM" : "EIO" });
      }
      return realKill(value, kind);
    });
    const subject = await harness(async (options) => {
      pid = process.pid; // A real live pid; no identity means it must NEVER be signalled.
      signal = options.signal;
      options.onSpawn?.(pid);
      return { text: "done", usage: { tokens: 0 }, telemetry: { durationMs: 0, model: "fixture" } };
    });
    await expect(subject.call()).rejects.toMatchObject({
      code: "REGISTRY_WRITE_FAILED",
      message: "could not capture process start time; agent would be uncancellable",
    });
    expect(signal?.aborted).toBe(true);
  });
});
