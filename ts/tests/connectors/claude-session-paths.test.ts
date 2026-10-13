import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker as WorkerType } from "node:worker_threads";

const state = vi.hoisted(() => ({ workers: [] as WorkerType[] }));
// Existing interleaving tests intercept Worker construction. This interception
// starts a REAL worker with only the external SDK redirected to a fixture.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: import("node:worker_threads").WorkerOptions = {}) {
        super(filename, {
          ...options,
          execArgv: [...(options.execArgv ?? []), "--import", fileURLToPath(new URL("../helpers/claude-session-loader.mjs", import.meta.url))],
        });
        state.workers.push(this);
      }
    },
  };
});

import { runAgent } from "../../src/connectors/runner.js";
import { claudeWorkerRegistry, pollBackgroundRun } from "../../src/connectors/background.js";
import type { QueryFunction } from "../../src/connectors/claude.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "test_detach_name_2_paths-"));
  vi.stubEnv("DETACH_CLAUDE_INDEX_DIR", join(root, "index"));
  vi.stubEnv("STRATUM_TEST_WORKER", "");
});
afterEach(async () => {
  await Promise.all(state.workers.splice(0).map(worker => worker.terminate()));
  claudeWorkerRegistry.clear();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it.each([
  { name: "generated foreground", sessionId: undefined, indexLabel: undefined },
  { name: "caller foreground", sessionId: "01234567-89ab-4cde-8fab-0123456789ab", indexLabel: "stratum-custom" },
])("indexes $name through runAgent", async ({ sessionId, indexLabel }) => {
  const query: QueryFunction = async function* ({ options }) {
    const id = options?.sessionId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    if (sessionId !== undefined) expect(id).toBe(sessionId);
    const record = JSON.parse(await readFile(join(root, "index", `${id}.json`), "utf8"));
    expect(record.label).toBe(indexLabel ?? `stratum-claude-${id.slice(0, 8)}`);
    yield { type: "result", subtype: "success", result: "session indexed" };
  };
  await expect(runAgent({
    agent: "claude", cwd: root, prompt: "test",
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(indexLabel !== undefined ? { indexLabel } : {}),
  }, { claudeQuery: query })).resolves.toMatchObject({ text: "session indexed" });
});

it.each([
  { name: "generated background", sessionId: undefined, peerLabel: undefined, indexLabel: undefined },
  { name: "unlabeled background", sessionId: "01234567-89ab-4cde-8fab-0123456789ab", peerLabel: undefined, indexLabel: undefined },
  { name: "named background", sessionId: "01234567-89ab-4cde-8fab-0123456789ab", peerLabel: " Author Name ", indexLabel: undefined },
  { name: "caller background", sessionId: "01234567-89ab-4cde-8fab-0123456789ab", peerLabel: undefined, indexLabel: "stratum-custom-bg" },
])("passes the id and label through the real worker for $name", async ({ sessionId, peerLabel, indexLabel }) => {
  const started = await runAgent({
    agent: "claude", background: true, cwd: root, registryRoot: root,
    prompt: "test", model: "claude-test",
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(peerLabel !== undefined ? { peerLabel } : {}),
    ...(indexLabel !== undefined ? { indexLabel } : {}),
    env: { DETACH_CLAUDE_INDEX_DIR: join(root, "index"), STRATUM_PEER_REGISTER: "0" },
  });
  if (!("runId" in started)) throw new Error("expected a background run");
  const deadline = Date.now() + 5000;
  let polled;
  do {
    polled = await pollBackgroundRun(started.runId, { registryRoot: root });
    if (polled.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  expect(polled).toMatchObject({ status: "complete", text: "session indexed" });
  const captured = JSON.parse((await readFile(join(root, "sdk-options.jsonl"), "utf8")).trim());
  expect(captured.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (sessionId !== undefined) expect(captured.sessionId).toBe(sessionId);
  expect(captured.index).toMatchObject({
    session_id: captured.sessionId, run_id: started.runId, cwd: root, model: "claude-test", source: "stratum",
    label: indexLabel ?? (peerLabel !== undefined ? `stratum-claude-test-${started.runId}-author-name` : `stratum-${started.runId}`),
  });
  expect(captured.index).not.toHaveProperty("pid");
});
