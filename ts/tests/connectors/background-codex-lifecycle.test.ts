import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn((...args: unknown[]) => {
      const child = Reflect.apply(original.spawn, original, args) as ChildProcess;
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      const streamPath = options?.env?.T2F5_OUT;
      if (options?.env?.STRATUM_TEST_FAIL_META === "1" && streamPath) {
        chmodSync(dirname(streamPath), 0o500);
      }
      return child;
    }),
  };
});

import { startBackgroundRun } from "../../src/connectors/background.js";
import { CODEX_SANDBOX_PREAMBLE } from "../../src/connectors/codex.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Codex background start lifecycle", () => {
  it.each(["exec", "app-server"])("meta.json write failure kills the detached %s process group (no uncontrollable orphan)", async strategy => {
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-codex-lifecycle-"));
    roots.push(registryRoot);
    const mockedSpawn = vi.mocked(spawn);
    let child: ChildProcess | undefined;
    let runDir: string | undefined;

    try {
      await expect(startBackgroundRun({
        agent: "codex",
        prompt: "test",
        cwd: registryRoot,
        registryRoot,
        ...(strategy === "exec" ? { command: ["sh", "-c", "sleep 30"] } : {}),
        env: { ...process.env, STRATUM_TEST_FAIL_META: "1", STRATUM_CODEX_BG_STRATEGY: strategy, ...(strategy === "app-server" ? {PATH:"/no-codex"} : {}) },
      })).rejects.toThrow();

      const last = mockedSpawn.mock.results[mockedSpawn.mock.results.length - 1];
      child = last?.value;
      expect(child?.pid).toBeTypeOf("number");
      if (child?.pid === undefined) throw new Error("mocked spawn did not expose a pid");
      const streamPath = mockedSpawn.mock.calls.at(-1)?.[2]?.env?.T2F5_OUT;
      if (!streamPath) throw new Error("mocked spawn did not receive T2F5_OUT");
      runDir = dirname(streamPath);

      await vi.waitFor(() => expect(processGroupIsAlive(child!.pid!)).toBe(false), { timeout: 2_000 });
    } finally {
      if (runDir) chmodSync(runDir, 0o700);
      if (child?.pid !== undefined && processGroupIsAlive(child.pid)) {
        process.kill(-child.pid, "SIGKILL");
      }
    }
  });

  it("frames the background prompt file with the sandbox preamble", async () => {
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-codex-preamble-"));
    roots.push(registryRoot);

    const { streamPath, pid } = await startBackgroundRun({
      agent: "codex",
      prompt: "do the task",
      cwd: registryRoot,
      registryRoot,
      command: ["sh", "-c", "true"],
      env: { ...process.env },
    });

    try {
      const input = await readFile(`${streamPath}.in`, "utf8");
      expect(input).toBe(`${CODEX_SANDBOX_PREAMBLE}\n\ndo the task`);
    } finally {
      if (pid !== undefined && processGroupIsAlive(pid)) process.kill(-pid, "SIGKILL");
    }
  });
});
