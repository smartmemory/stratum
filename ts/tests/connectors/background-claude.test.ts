// background-claude.test.ts
// Real-Worker tests for claude background runs. Uses STRATUM_TEST_WORKER env-gated
// stub to avoid real SDK calls. Do NOT call vi.mock('node:worker_threads') in this
// file — the vi.mock seam belongs in background-claude-interleavings.test.ts (Step 7e).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import {
  T2F5_DONE_SENTINEL,
  cancelBackgroundRun,
  claudeWorkerRegistry,
  pollBackgroundRun,
  startBackgroundRun,
  type BackgroundRunMeta,
  type ClaudeRunMeta,
} from "../../src/connectors/background.js";

// Set STRATUM_TEST_WORKER=1 for all tests in this file so the worker skips the
// real SDK call and writes a synthetic response immediately.
const savedTestWorker = process.env.STRATUM_TEST_WORKER;
beforeAll(() => { process.env.STRATUM_TEST_WORKER = "1"; });
afterAll(() => {
  if (savedTestWorker === undefined) {
    delete process.env.STRATUM_TEST_WORKER;
  } else {
    process.env.STRATUM_TEST_WORKER = savedTestWorker;
  }
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "stratum-claude-bg-"));
  roots.push(path);
  return path;
}

async function waitFor(runId: string, registryRoot: string, status: string, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let last: Awaited<ReturnType<typeof pollBackgroundRun>> | undefined;
  while (Date.now() < deadline) {
    last = await pollBackgroundRun(runId, { registryRoot });
    if (last.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${status}: ${JSON.stringify(last)}`);
}

describe("claude background run — real Worker (STRATUM_TEST_WORKER=1)", () => {
  it("claude background start writes meta.json with agent:claude and no pid in response", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    expect(started.status).toBe("bg_started");
    expect(started.runId).toMatch(/^[0-9a-f]{12}$/);
    expect(started).not.toHaveProperty("pid");
    const meta = JSON.parse(await readFile(join(registryRoot, started.runId, "meta.json"), "utf8")) as BackgroundRunMeta;
    expect(meta.agent).toBe("claude");
  });

  it("loadMeta accepts agent:claude meta files", async () => {
    const registryRoot = await root();
    // Create a fake ClaudeRunMeta via startBackgroundRun, then verify poll works
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    // Poll should return running or complete (not not_found)
    const result = await pollBackgroundRun(started.runId, { registryRoot });
    expect(result.status).not.toBe("not_found");
  });

  it("loadMeta rejects unknown agent values in meta.json", async () => {
    const registryRoot = await root();
    const runId = "aabbccdd1122";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    await writeFile(streamPath, "", "utf8");
    await writeFile(`${streamPath}.err`, "", "utf8");
    const badMeta = { runId, agent: "gemini", model: "g1", cwd: registryRoot, sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-01-01T00:00:00Z", streamPath, stderrPath: `${streamPath}.err` };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(badMeta), "utf8");
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("not_found");
  });

  it("rejects sandboxMode:read-only for claude background runs", async () => {
    const registryRoot = await root();
    await expect(startBackgroundRun({
      agent: "claude", sandboxMode: "read-only", prompt: "p", cwd: registryRoot, registryRoot,
    })).rejects.toThrow("sandboxMode='read-only' are not supported");
  });

  it("sandboxMode:workspace-write explicit succeeds and meta has correct sandboxMode", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", sandboxMode: "workspace-write", prompt: "test", cwd: registryRoot, registryRoot,
    });
    expect(started.status).toBe("bg_started");
    const meta = JSON.parse(await readFile(join(registryRoot, started.runId, "meta.json"), "utf8")) as ClaudeRunMeta;
    expect(meta.sandboxMode).toBe("workspace-write");
  });

  it("sandboxMode omitted defaults to workspace-write in meta.json", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    const meta = JSON.parse(await readFile(join(registryRoot, started.runId, "meta.json"), "utf8")) as ClaudeRunMeta;
    expect(meta.sandboxMode).toBe("workspace-write");
  });

  it("rejects unknown agent values (D11 discriminant validation)", async () => {
    const registryRoot = await root();
    await expect(startBackgroundRun({ agent: "gemini" as "claude", prompt: "p", cwd: registryRoot, registryRoot }))
      .rejects.toThrow("Unknown agent");
    await expect(startBackgroundRun({ agent: "codex", sandboxMode: "locked" as "read-only", prompt: "p", cwd: registryRoot, registryRoot }))
      .rejects.toThrow("Unknown sandboxMode");
  });

  it("poll after completion returns complete with text and usage", async () => {
    const registryRoot = await root();
    const runId = "aabbcc112233";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    const stderrPath = `${streamPath}.err`;
    // Write a synthetic stream with text + sentinel
    const records = [
      { type: "item.completed", item: { type: "agent_message", text: "done text" } },
      { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } },
      { [T2F5_DONE_SENTINEL]: 0 },
    ];
    await writeFile(streamPath, records.map((r) => JSON.stringify(r) + "\n").join(""), "utf8");
    await writeFile(stderrPath, "", "utf8");
    const meta: ClaudeRunMeta = {
      runId, agent: "claude", model: "claude-sonnet-4-6", cwd: registryRoot,
      sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-07-18T00:00:00Z",
      streamPath, stderrPath,
    };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.text).toBe("done text");
    expect(result.usage).toMatchObject({ tokens: 7 });
  });

  it("poll after error returns error status", async () => {
    const registryRoot = await root();
    const runId = "aabbcc112244";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    const stderrPath = `${streamPath}.err`;
    await writeFile(streamPath, JSON.stringify({ [T2F5_DONE_SENTINEL]: 1 }) + "\n", "utf8");
    await writeFile(stderrPath, "some error", "utf8");
    const meta: ClaudeRunMeta = {
      runId, agent: "claude", model: "claude-sonnet-4-6", cwd: registryRoot,
      sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-07-18T00:00:00Z",
      streamPath, stderrPath,
    };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("error");
  });

  it("poll after MCP server restart (no registry entry, no sentinel) returns child_died_without_sentinel", async () => {
    const registryRoot = await root();
    const runId = "aabbcc112255";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    const stderrPath = `${streamPath}.err`;
    // No sentinel — simulate restart scenario (worker not in registry)
    await writeFile(streamPath, "", "utf8");
    await writeFile(stderrPath, "", "utf8");
    const meta: ClaudeRunMeta = {
      runId, agent: "claude", model: "claude-sonnet-4-6", cwd: registryRoot,
      sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-07-18T00:00:00Z",
      streamPath, stderrPath,
    };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    // Worker not in claudeWorkerRegistry (simulates server restart)
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.reason).toBe("child_died_without_sentinel");
  });

  it("cancel after already complete returns already_complete", async () => {
    const registryRoot = await root();
    const runId = "aabbcc112266";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    const stderrPath = `${streamPath}.err`;
    await writeFile(streamPath, JSON.stringify({ [T2F5_DONE_SENTINEL]: 0 }) + "\n", "utf8");
    await writeFile(stderrPath, "", "utf8");
    const meta: ClaudeRunMeta = {
      runId, agent: "claude", model: "claude-sonnet-4-6", cwd: registryRoot,
      sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-07-18T00:00:00Z",
      streamPath, stderrPath,
    };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    const result = await cancelBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("already_complete");
  });

  it("cancel with no registry entry (simulating server restart) returns not_found", async () => {
    const registryRoot = await root();
    const runId = "aabbcc112277";
    const runDir = join(registryRoot, runId);
    await mkdir(runDir, { recursive: true });
    const streamPath = join(runDir, "stream.jsonl");
    const stderrPath = `${streamPath}.err`;
    // No sentinel — worker not running
    await writeFile(streamPath, "", "utf8");
    await writeFile(stderrPath, "", "utf8");
    const meta: ClaudeRunMeta = {
      runId, agent: "claude", model: "claude-sonnet-4-6", cwd: registryRoot,
      sandboxMode: "workspace-write", promptChars: 1, createdAt: "2026-07-18T00:00:00Z",
      streamPath, stderrPath,
    };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
    // Worker not in registry (server restart simulation)
    const result = await cancelBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("not_found");
  });

  it("worker wins the race: sentinel already present returns already_complete without cancel/poll disagreement", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    // Worker writes sentinel immediately (STRATUM_TEST_WORKER=1). Wait for it.
    await waitFor(started.runId, registryRoot, "complete", 5_000);
    // Now sentinel is present. Cancel should see it.
    const cancelResult = await cancelBackgroundRun(started.runId, { registryRoot });
    expect(cancelResult.status).toBe("already_complete");
    // Subsequent poll also returns complete
    const pollResult = await pollBackgroundRun(started.runId, { registryRoot });
    expect(pollResult.status).toBe("complete");
  });
});

describe("claude background run — stderr plumbing (STRATUM_TEST_WORKER=fail)", () => {
  // Temporarily override STRATUM_TEST_WORKER to 'fail' for these tests
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.STRATUM_TEST_WORKER;
    process.env.STRATUM_TEST_WORKER = "fail";
  });
  afterAll(() => {
    if (savedEnv === undefined) {
      delete process.env.STRATUM_TEST_WORKER;
    } else {
      process.env.STRATUM_TEST_WORKER = savedEnv;
    }
  });

  it("worker fail mode writes error to .err file and poll returns error status", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    // Wait for worker to fail and write sentinel
    await waitFor(started.runId, registryRoot, "error", 5_000);
    // .err file should be non-empty (worker's catch block writes to stderrPath)
    const stderrPath = join(registryRoot, started.runId, "stream.jsonl.err");
    const stderrContent = await readFile(stderrPath, "utf8");
    expect(stderrContent.trim()).not.toBe("");
    // Poll returns error with rc=1 sentinel
    const result = await pollBackgroundRun(started.runId, { registryRoot });
    expect(result.status).toBe("error");
  });
});

describe("claude background run — stream failure containment (STRATUM_TEST_WORKER=stream-error)", () => {
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.STRATUM_TEST_WORKER;
    process.env.STRATUM_TEST_WORKER = "stream-error";
  });
  afterAll(() => {
    if (savedEnv === undefined) {
      delete process.env.STRATUM_TEST_WORKER;
    } else {
      process.env.STRATUM_TEST_WORKER = savedEnv;
    }
  });

  it("a destroyed stream mid-run is absorbed by the worker's stream 'error' listener (no worker crash), one sentinel, stderr content", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
    });
    // Pin the listener itself: without it the destroy error is an UNCAUGHT worker
    // exception — the parent's 'error' handler fires and its finalizer writes the
    // destroy message into the STREAM. With the listener, the worker survives to
    // its catch path (stderr only) and the parent error handler never runs.
    const entry = claudeWorkerRegistry.get(started.runId);
    const parentErrorSpy = vi.fn();
    entry?.worker.on("error", parentErrorSpy);
    await waitFor(started.runId, registryRoot, "error", 5_000);
    const streamPath = join(registryRoot, started.runId, "stream.jsonl");
    const content = await readFile(streamPath, "utf8");
    const sentinels = content.split("\n").filter((l) => l.includes(T2F5_DONE_SENTINEL));
    expect(sentinels).toHaveLength(1);
    expect(content).not.toContain("simulated stream failure"); // no parent-authored error record
    expect(parentErrorSpy).not.toHaveBeenCalled();
    const stderrPath = `${streamPath}.err`;
    const stderrContent = await readFile(stderrPath, "utf8");
    expect(stderrContent.trim()).not.toBe("");
    const result = await pollBackgroundRun(started.runId, { registryRoot });
    expect(result.status).toBe("error");
  });
});


it("does not recreate removed terminal streams when worker finalization arrives late", async () => {
  const registryRoot = await root();
  const started = await startBackgroundRun({ agent: "claude", prompt: "test", cwd: registryRoot, registryRoot });
  const entry = claudeWorkerRegistry.get(started.runId)!;
  const workerExited = new Promise<void>((resolve) => entry.worker.once("exit", () => resolve()));
  await waitFor(started.runId, registryRoot, "complete", 5_000);
  const runDir = join(registryRoot, started.runId);
  await rm(join(runDir, "stream.jsonl"), { force: true });
  await workerExited;
  await entry.finalizationClaim;
  await expect(readFile(join(runDir, "stream.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
});
