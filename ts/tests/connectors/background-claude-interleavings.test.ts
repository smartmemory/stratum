// background-claude-interleavings.test.ts
// Tests that require vi.mock('node:worker_threads') to control the Worker constructor.
// Because vitest hoists vi.mock calls module-wide, this mock applies to every
// startClaudeBackgroundRun() call in this file. Do NOT set STRATUM_TEST_WORKER
// (any value) anywhere in this file — the env seam is for real-Worker test files
// (background-claude.test.ts and agent-run.test.ts); 7e prohibits it entirely.
import { EventEmitter } from "node:events";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worker as WorkerType } from "node:worker_threads";

// vi.mock is hoisted — the mocked Worker constructor is a class-level EventEmitter stub.
vi.mock("node:worker_threads", () => {
  const MockWorker = vi.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    (emitter as MockWorkerInstance).terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      // Default: emit exit(0) synchronously then resolve. Tests can override this.
      this.emit("exit", 0);
      return Promise.resolve(0);
    });
    (emitter as MockWorkerInstance).threadId = 1;
    return emitter;
  });
  return { Worker: MockWorker };
});

interface MockWorkerInstance extends EventEmitter {
  terminate: ReturnType<typeof vi.fn>;
  threadId: number;
}

import {
  T2F5_DONE_SENTINEL,
  cancelBackgroundRun,
  claudeWorkerRegistry,
  pollBackgroundRun,
  startBackgroundRun,
  type ClaudeRunMeta,
} from "../../src/connectors/background.js";

const roots: string[] = [];
afterEach(async () => {
  // Clear the registry between tests (the module-level map persists between tests in the same file)
  claudeWorkerRegistry.clear();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "stratum-claude-il-"));
  roots.push(path);
  return path;
}

async function startClaude(registryRoot: string): Promise<{ runId: string; streamPath: string; stderrPath: string }> {
  const started = await startBackgroundRun({
    agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
  });
  const streamPath = join(registryRoot, started.runId, "stream.jsonl");
  const stderrPath = `${streamPath}.err`;
  return { runId: started.runId, streamPath, stderrPath };
}

async function getLastWorker(): Promise<MockWorkerInstance> {
  const { Worker } = await import("node:worker_threads");
  const MockWorker = Worker as unknown as ReturnType<typeof vi.fn>;
  const calls = MockWorker.mock.results;
  const last = calls[calls.length - 1];
  if (!last || last.type !== "return") throw new Error("No mock Worker instance found");
  return last.value as MockWorkerInstance;
}

function sentinelCount(content: string): number {
  return content.split("\n").filter((line) => {
    if (!line.trim()) return false;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      return Object.hasOwn(obj, T2F5_DONE_SENTINEL);
    } catch { return false; }
  }).length;
}

async function streamSentinelCount(streamPath: string): Promise<number> {
  try {
    const content = await readFile(streamPath, "utf8");
    return sentinelCount(content);
  } catch { return 0; }
}

describe("poll while running (vi.mock Worker)", () => {
  it("returns running when worker is registered and no sentinel present", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    // Don't emit exit — worker is still running in registry
    // The default terminate() would emit exit, so override it to do nothing here
    worker.terminate = vi.fn().mockResolvedValue(0);

    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("running");
    // Cleanup: emit exit to trigger registry cleanup
    worker.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

describe("cancel in-flight (vi.mock Worker)", () => {
  it("terminate() emits exit(130) synchronously; cancel owns rc=130 and returns cancelled", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    // Override terminate to emit exit(130) synchronously, then resolve
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      this.emit("exit", 130);
      return Promise.resolve(130);
    });

    const cancelResult = await cancelBackgroundRun(runId, { registryRoot });
    expect(cancelResult.status).toBe("cancelled");
    // Verify sentinel in stream.jsonl has exitCode 130
    expect(await streamSentinelCount(streamPath)).toBe(1);
    const content = await readFile(streamPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    const sentinel = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .find((obj) => obj !== null && Object.hasOwn(obj, T2F5_DONE_SENTINEL));
    expect(sentinel?.[T2F5_DONE_SENTINEL]).toBe(130);
    // Subsequent poll should return error (rc=130)
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("error");
    // Registry entry should be deleted
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });
});

describe("D9 callback-order interleaving tests", () => {
  it("exit handler suppressed when cancelling=true: no sentinel written by exit handler", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Set cancelling=true directly (bypassing terminate)
    entry.cancelling = true;
    // Emit exit(1) — should be suppressed by cancelling guard
    entry.worker.emit("exit", 1);
    // Give microtasks a chance to settle
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No sentinel should have been written
    expect(await streamSentinelCount(streamPath)).toBe(0);

    // Cleanup: manually claim finalization to delete registry entry
    void entry.worker.emit("exit", 0);
    claudeWorkerRegistry.delete(runId);
  });

  it("error handler suppressed when cancelling=true: no sentinel written by error handler", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Set cancelling=true directly
    entry.cancelling = true;
    // Emit error — should be suppressed
    entry.worker.emit("error", new Error("late error"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No sentinel from error handler
    expect(await streamSentinelCount(streamPath)).toBe(0);
    claudeWorkerRegistry.delete(runId);
  });

  it("single registry deletion via finalizationClaim.finally: delete called exactly once", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    const deleteSpy = vi.spyOn(claudeWorkerRegistry, "delete");

    // Trigger normal exit (no cancelling)
    entry.worker.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // delete should have been called exactly once
    const deleteCalls = deleteSpy.mock.calls.filter((args) => args[0] === runId);
    expect(deleteCalls.length).toBe(1);
    deleteSpy.mockRestore();
  });
});

describe("D13 sentinel serialization", () => {
  it("error + exit both fire: exactly ONE sentinel in stream", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Emit error then exit — error handler should claim finalizationClaim first
    entry.worker.emit("error", new Error("oops"));
    entry.worker.emit("exit", 1);
    // Wait for I/O to settle
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await streamSentinelCount(streamPath)).toBe(1);
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });

  it("finalizationClaim is non-null synchronously after error event fires", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Before error: finalizationClaim is null
    expect(entry.finalizationClaim).toBeNull();
    // Emit error — synchronously sets finalizationClaim
    entry.worker.emit("error", new Error("sync check"));
    // Immediately after emit (synchronous): finalizationClaim should be non-null
    expect(entry.finalizationClaim).not.toBeNull();
    // Wait for I/O to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("two concurrent cancel calls: exactly one rc=130 sentinel, both calls resolve", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    let terminateCalled = 0;
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      terminateCalled++;
      if (terminateCalled === 1) {
        this.emit("exit", 130);
      }
      return Promise.resolve(130);
    });

    const [r1, r2] = await Promise.all([
      cancelBackgroundRun(runId, { registryRoot }),
      cancelBackgroundRun(runId, { registryRoot }),
    ]);
    // Both resolve without throwing
    expect(typeof r1.status).toBe("string");
    expect(typeof r2.status).toBe("string");
    // Exactly one sentinel
    expect(await streamSentinelCount(streamPath)).toBe(1);
  });
});

describe("D14 cancel-joins-error-claim race", () => {
  it("cancel joins error handler's claim: returns already_error, poll returns error", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Override worker terminate to do nothing (worker already dead from error)
    const worker = await getLastWorker();
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      // Worker is already dead — don't emit exit again
      return Promise.resolve(0);
    });

    // Emit error event (error handler claims finalizationClaim)
    entry.worker.emit("error", new Error("worker error"));
    // finalizationClaim is now non-null synchronously
    expect(entry.finalizationClaim).not.toBeNull();

    // Now call cancelBackgroundRun — it should detect finalizationClaim !== null
    // and join it, then return already_error
    const cancelResult = await cancelBackgroundRun(runId, { registryRoot });
    expect(cancelResult.status).toBe("already_error");

    // Wait for sentinel to be written
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Subsequent poll returns error (not cancelled)
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("error");
    // No double sentinel
    expect(await streamSentinelCount(streamPath)).toBe(1);
  });

  it("cancel that owns rc=130 (finalizationClaim was null): returns cancelled", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    // Terminate emits exit(130) synchronously
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      this.emit("exit", 130);
      return Promise.resolve(130);
    });

    // No prior error/exit — finalizationClaim should be null
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry?.finalizationClaim).toBeNull();

    const cancelResult = await cancelBackgroundRun(runId, { registryRoot });
    expect(cancelResult.status).toBe("cancelled");
    // Subsequent poll returns error
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("error");
    // Exactly one sentinel
    expect(await streamSentinelCount(streamPath)).toBe(1);
  });

  it("concurrent second cancel joins first cancel's claim: returns already_error, no double sentinel", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    let terminateCalls = 0;
    const worker = await getLastWorker();
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      terminateCalls++;
      if (terminateCalls === 1) {
        this.emit("exit", 130);
      }
      return Promise.resolve(130);
    });

    const [r1, r2] = await Promise.all([
      cancelBackgroundRun(runId, { registryRoot }),
      cancelBackgroundRun(runId, { registryRoot }),
    ]);

    // D14 exact split: the owner of the rc=130 finalization reports 'cancelled';
    // the joiner must await, rescan, and report the committed record ('already_error').
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["already_error", "cancelled"]);
    // No double sentinel
    expect(await streamSentinelCount(streamPath)).toBe(1);
    // Registry should be cleared
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });
});

describe("worker error containment (D9)", () => {
  it("worker emits error: no uncaught exception; poll returns error", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;

    // Emit error — the error handler on the worker should absorb it
    entry.worker.emit("error", new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Poll returns error (sentinel was written)
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("error");
  });

  it("registry entry deleted after worker error", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return;

    entry.worker.emit("error", new Error("boom"));
    // Wait for .finally() to run
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });
});

describe("registry cleanup (D10)", () => {
  it("registry entry deleted after normal completion (exit handler fires)", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return;

    // Emit exit(0) — triggers exit handler → claimFinalization → writeSentinelIfAbsent
    entry.worker.emit("exit", 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });

  it("registry entry deleted after cancel", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    worker.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
      this.emit("exit", 130);
      return Promise.resolve(130);
    });

    await cancelBackgroundRun(runId, { registryRoot });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });

  it("registry entry deleted after worker error", async () => {
    const registryRoot = await root();
    const { runId } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    if (!entry) return;

    entry.worker.emit("error", new Error("test error"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });
});

// Merge-gate hardening round: deterministic interleavings the earlier tests could
// pass without exercising (worker rc=0 landing after cancel's initial scan; a join
// against a still-pending claim; MCP-wire tool filters reaching workerData).
describe("cancel/finalization interleavings (merge-gate round)", () => {
  it("worker commits rc=0 AFTER cancel's initial scan: cancel returns already_complete, poll agrees", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const worker = await getLastWorker();
    // terminate() simulates the worker winning the race: its final rc=0 sentinel
    // lands between cancel's initial scan (which saw no sentinel) and the
    // post-terminate rescan.
    worker.terminate = vi.fn().mockImplementation(async function (this: MockWorkerInstance) {
      const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }) + "\n"
        + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n"
        + JSON.stringify({ [T2F5_DONE_SENTINEL]: 0 }) + "\n";
      await writeFile(streamPath, line, { flag: "a", encoding: "utf8" });
      return 0;
    });
    const cancelResult = await cancelBackgroundRun(runId, { registryRoot });
    expect(cancelResult.status).toBe("already_complete");
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("complete");
    const content = await readFile(streamPath, "utf8");
    expect(sentinelCount(content)).toBe(1);
    expect(claudeWorkerRegistry.has(runId)).toBe(false);
  });

  it("cancel joining a STILL-PENDING claim awaits it and reports the committed record (D14 join branch)", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;
    // Manufacture an in-flight finalization claim we control: cancel's claim check
    // is guaranteed to see it non-null (join branch, deterministically), and the
    // claim only resolves after we commit the error record.
    let release!: () => void;
    entry.finalizationClaim = new Promise<void>((resolve) => { release = resolve; });
    const cancelPromise = cancelBackgroundRun(runId, { registryRoot });
    // Let cancel pass its initial scan (stream is empty) and reach the join await.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const line = JSON.stringify({ type: "error", message: "in-flight error" }) + "\n"
      + JSON.stringify({ [T2F5_DONE_SENTINEL]: 1 }) + "\n";
    await writeFile(streamPath, line, { flag: "a", encoding: "utf8" });
    release();
    const cancelResult = await cancelPromise;
    expect(cancelResult.status).toBe("already_error");
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("error");
    const content = await readFile(streamPath, "utf8");
    expect(sentinelCount(content)).toBe(1);
  });

  it("allowedTools/disallowedTools from the request reach the Worker's workerData connectorOptions", async () => {
    const registryRoot = await root();
    await startBackgroundRun({
      agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
      allowedTools: ["Read", "Grep"], disallowedTools: ["Write"],
    } as Parameters<typeof startBackgroundRun>[0]);
    const { Worker } = await import("node:worker_threads");
    const MockWorker = Worker as unknown as ReturnType<typeof vi.fn>;
    const lastCall = MockWorker.mock.calls[MockWorker.mock.calls.length - 1] as unknown[];
    const workerOptions = lastCall[1] as { workerData: { connectorOptions: Record<string, unknown> } };
    // Pins MCP wire → startBackgroundRun → workerData; workerData → SDK `tools`
    // mapping is pinned by the foreground ClaudeConnector tools test (same code path).
    expect(workerOptions.workerData.connectorOptions.allowedTools).toEqual(["Read", "Grep"]);
    expect(workerOptions.workerData.connectorOptions.disallowedTools).toEqual(["Write"]);
  });

  it("a worker error AFTER a committed rc=0 must not flip completion (error finalizer defers to the worker's record)", async () => {
    const registryRoot = await root();
    const { runId, streamPath } = await startClaude(registryRoot);
    const entry = claudeWorkerRegistry.get(runId);
    expect(entry).toBeDefined();
    if (!entry) return;
    // Worker committed its success record...
    const okLines = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\n"
      + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\n"
      + JSON.stringify({ [T2F5_DONE_SENTINEL]: 0 }) + "\n";
    await writeFile(streamPath, okLines, { flag: "a", encoding: "utf8" });
    // ...then a late error (e.g. stream close failure) reaches the parent handler.
    entry.worker.emit("error", new Error("late stream close failure"));
    // Wait for the claim to settle (registry deletion is its .finally()).
    await vi.waitFor(() => expect(claudeWorkerRegistry.has(runId)).toBe(false), { timeout: 2_000 });
    // Without the rescan-and-defer fix the handler appends rc=1 and, since
    // scanStream takes the LAST sentinel, completion flips to error.
    const content = await readFile(streamPath, "utf8");
    expect(sentinelCount(content)).toBe(1);
    const pollResult = await pollBackgroundRun(runId, { registryRoot });
    expect(pollResult.status).toBe("complete");
  });

  it("meta.json write failure terminates the just-started worker and clears the registry (no uncontrollable orphan)", async () => {
    const registryRoot = await root();
    const { Worker } = await import("node:worker_threads");
    const MockWorker = Worker as unknown as ReturnType<typeof vi.fn>;
    let runDir: string | undefined;
    // At Worker-construction time (which precedes the meta.json write), make the
    // run directory read-only so atomicWriteJson deterministically fails.
    MockWorker.mockImplementationOnce((_url: unknown, opts: { workerData: { streamPath: string } }) => {
      const emitter = new EventEmitter() as MockWorkerInstance;
      emitter.terminate = vi.fn().mockImplementation(function (this: MockWorkerInstance) {
        this.emit("exit", 130);
        return Promise.resolve(130);
      });
      emitter.threadId = 99;
      runDir = dirname(opts.workerData.streamPath);
      chmodSync(runDir, 0o555);
      return emitter;
    });
    try {
      await expect(startBackgroundRun({
        agent: "claude", prompt: "test", cwd: registryRoot, registryRoot,
      })).rejects.toThrow();
    } finally {
      if (runDir) chmodSync(runDir, 0o755); // let afterEach rm succeed
    }
    const last = MockWorker.mock.results[MockWorker.mock.results.length - 1];
    const worker = last?.value as MockWorkerInstance;
    expect(worker.terminate).toHaveBeenCalled();
    expect(claudeWorkerRegistry.size).toBe(0);
  });
});
