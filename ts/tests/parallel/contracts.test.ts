import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ParallelTaskState, type PersistedRun, StateStore } from "../../src/engine/state.js";
import { assertToolResponse, mcpSurface } from "../../src/mcp/contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function task(taskId: string, overrides: Partial<ParallelTaskState> = {}): ParallelTaskState {
  return {
    taskId,
    state: "pending",
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    certViolations: null,
    worktreePath: null,
    diff: null,
    diffError: null,
    gateBounce: null,
    tokens: 0,
    elapsedS: 0,
    dollarsRecorded: 0,
    childPid: null,
    streamPath: null,
    stderrPath: null,
    procStartTime: null,
    streamOffset: 0,
    reparentable: false,
    dispatchDebited: false,
    ...overrides,
  };
}

describe("parallel MCP contracts", () => {
  it("selects status-less response variants by declared discriminator keys", async () => {
    const tool = "test_parallel_discriminator";
    const surface = await mcpSurface();
    surface.tools[tool] = {
      request: {},
      responses: {
        poll_success: { summary: "object", tasks: "object", outcome: "null" },
        bare_error: { error: "string" },
        error: { error_type: "string", message: "string" },
      },
      discriminator: { bare_error: "error", poll_success: "summary" },
    };

    try {
      await expect(assertToolResponse(tool, { summary: {}, tasks: {}, outcome: null })).resolves.toBeUndefined();
      await expect(assertToolResponse(tool, { error: "boom" })).resolves.toBeUndefined();
      await expect(assertToolResponse(tool, { status: "error", error_type: "failed", message: "boom" })).resolves.toBeUndefined();
      await expect(assertToolResponse(tool, { tasks: {} })).rejects.toThrow("undeclared status");
    } finally {
      delete surface.tools[tool];
    }
  });

  it("falls back to success when discriminator keys do not match and strips non-string status", async () => {
    const tool = "test_parallel_discriminator_success_fallback";
    const surface = await mcpSurface();
    surface.tools[tool] = {
      request: {},
      responses: {
        success: { value: "string" },
        bare_error: { error: "string" },
        error: { error_type: "string", message: "string" },
      },
      discriminator: { bare_error: "error", poll_success: "summary" },
    };

    try {
      await expect(assertToolResponse(tool, { value: "ok", status: null })).resolves.toBeUndefined();
    } finally {
      delete surface.tools[tool];
    }
  });

  it("round-trips persisted parallel state without losing task fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-parallel-state-"));
    roots.push(root);
    const run: PersistedRun = {
      id: "parallel-state",
      spec: {},
      input: {},
      flowName: "main",
      status: "running",
      flowSpent: {},
      steps: {},
      events: [],
      parallel: {
        stepId: "parallel-work",
        tasks: [
          task("first", {
            state: "complete",
            startedAt: 100,
            finishedAt: 120,
            result: { value: "done" },
            tokens: 14,
            elapsedS: 20,
            dollarsRecorded: 0.03,
          }),
          task("second", {
            state: "failed",
            error: "pre-merge check failed",
            gateBounce: {
              taskId: "second",
              reason: "gate_failed",
              files: ["ts/src/engine/state.ts"],
              command: "pnpm typecheck",
              exitCode: 1,
              excerpt: "type error",
            },
            childPid: 1234,
            streamPath: "/tmp/parallel.jsonl",
            stderrPath: "/tmp/parallel.stderr",
            procStartTime: "12345",
            streamOffset: 256,
            reparentable: true,
            dispatchDebited: true,
          }),
        ],
      },
    };

    const store = new StateStore(root);
    await store.save(run);
    await expect(store.load(run.id)).resolves.toEqual(run);
  });
});
