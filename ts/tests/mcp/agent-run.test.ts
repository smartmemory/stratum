// ts/tests/mcp/agent-run.test.ts
// Public MCP-surface tests for stratum_agent_run using createMcpServer + InMemoryTransport.
// Same pattern as tests/mcp/p5.test.ts.
//
// SEAM: claude background tests use STRATUM_TEST_WORKER=1 env var (real Worker threads, no vi.mock).
// Do NOT vi.mock('node:worker_threads') in this file — that seam belongs in
// background-claude-interleavings.test.ts (Step 7e).
//
// All 9 test cases:
//   1. Codex workspace-write bg start via backgroundCommand stub
//   2. Codex bg poll to completion via MCP
//   3. Claude bg start via STRATUM_TEST_WORKER=1 — no pid in response
//   4. Claude bg meta.json has agent:"claude"
//   5. Claude bg poll returns complete (STRATUM_TEST_WORKER=1 writes sentinel immediately)
//   6. allowedTools:["Read"] forwarding to agentRun stub
//   7. mixed-type allowedTools:["Read",42] McpError rejection before agentRun is called
//   8. absent allowedTools does NOT produce allowedTools:[] in agentRun call (Array.isArray guard)
//   9. foreground claude allowlist: sdkOptions.tools=["Read"] end-to-end via claudeQuery boundary stub

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pollBackgroundRun, runAgent } from "../../src/connectors/index.js";
import type { AgentRunOptions } from "../../src/connectors/runner.js";
import { createMcpServer, type McpDependencies } from "../../src/mcp/server.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function connected(dependencies: McpDependencies) {
  const server = await createMcpServer(dependencies);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-run-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function response(result: unknown): Record<string, unknown> {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first?.text ?? "") as Record<string, unknown>;
}

/** Builds a shell command that writes JSONL records to stdout then exits. */
function fakeCodex(records: unknown[], options: { rc?: number; sleep?: number } = {}): string[] {
  const script = [
    ...records.map((record) => `printf '%s\\n' '${JSON.stringify(record).replaceAll("'", "'\\\\''")}'`),
    ...(options.sleep !== undefined ? [`sleep ${options.sleep}`] : []),
    `exit ${options.rc ?? 0}`,
  ].join("; ");
  return ["sh", "-c", script];
}

/**
 * Poll via MCP until the run reaches `target` status (or timeout).
 * Used for tests that need to wait for a background run to complete.
 */
async function waitForBackground(
  client: Client,
  runId: string,
  target: string,
  maxTicks = 60,
): Promise<Record<string, unknown>> {
  for (let tick = 0; tick < maxTicks; tick++) {
    const polled = response(await client.callTool({ name: "stratum_agent_poll", arguments: { runId } }));
    if (polled.status === target) return polled;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Background run ${runId} did not reach "${target}" in ${maxTicks * 25}ms`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

// Preserve STRATUM_TEST_WORKER across tests — individual tests manage it.
let savedTestWorker: string | undefined;
beforeAll(() => { savedTestWorker = process.env.STRATUM_TEST_WORKER; });
afterAll(() => {
  if (savedTestWorker === undefined) delete process.env.STRATUM_TEST_WORKER;
  else process.env.STRATUM_TEST_WORKER = savedTestWorker;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("stratum_agent_run MCP surface — agent-run.test.ts (T7d)", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1 & 2: Codex workspace-write background via backgroundCommand stub
  // ──────────────────────────────────────────────────────────────────────────

  it("1. starts a codex workspace-write background run via MCP (backgroundCommand stub)", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-ar-codex-start-"));
    roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const pair = await connected({
      runAgent: (options: AgentRunOptions) =>
        runAgent({ ...options, registryRoot }, {
          backgroundCommand: fakeCodex(
            [
              { type: "item.completed", item: { type: "agent_message", text: "bg ok" } },
              { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
            ],
            { sleep: 0.05 },
          ),
        }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
    });
    try {
      const result = response(
        await pair.client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "codex", sandboxMode: "workspace-write", background: true, prompt: "p", cwd: root },
        }),
      );
      expect(result.status).toBe("bg_started");
      expect(typeof result.runId).toBe("string");
      expect((result.runId as string)).toMatch(/^[0-9a-f]{12}$/);
      expect(result).toHaveProperty("streamPath");
      // Codex path still returns pid (workspace-write enabled by D6 / guard removal)
      expect(typeof result.pid).toBe("number");
    } finally { await pair.close(); }
  });

  it("2. polls a codex background run to completion via MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-ar-codex-poll-"));
    roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const pair = await connected({
      runAgent: (options: AgentRunOptions) =>
        runAgent({ ...options, registryRoot }, {
          backgroundCommand: fakeCodex([
            { type: "item.completed", item: { type: "agent_message", text: "done" } },
            { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
          ]),
        }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
    });
    try {
      const started = response(
        await pair.client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "codex", sandboxMode: "workspace-write", background: true, prompt: "p", cwd: root },
        }),
      );
      expect(started.status).toBe("bg_started");
      const polled = await waitForBackground(pair.client, started.runId as string, "complete");
      expect(polled.status).toBe("complete");
    } finally { await pair.close(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3, 4, 5: Claude background via STRATUM_TEST_WORKER=1
  // ──────────────────────────────────────────────────────────────────────────

  it("3. starts a claude background run via MCP — no pid in response", async () => {
    process.env.STRATUM_TEST_WORKER = "1";
    const root = await mkdtemp(join(tmpdir(), "stratum-ar-claude-start-"));
    roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const pair = await connected({
      runAgent: (options: AgentRunOptions) => runAgent({ ...options, registryRoot }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
    });
    try {
      const result = response(
        await pair.client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "claude", background: true, prompt: "test", cwd: root },
        }),
      );
      expect(result.status).toBe("bg_started");
      expect((result.runId as string)).toMatch(/^[0-9a-f]{12}$/);
      expect(result).toHaveProperty("streamPath");
      // Claude path must NOT return pid (D4: claude bg exposes no OS pid)
      expect(result).not.toHaveProperty("pid");
    } finally {
      await pair.close();
      delete process.env.STRATUM_TEST_WORKER;
    }
  });

  it("4. claude background run writes meta.json with agent:claude", async () => {
    process.env.STRATUM_TEST_WORKER = "1";
    const root = await mkdtemp(join(tmpdir(), "stratum-ar-claude-meta-"));
    roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const pair = await connected({
      runAgent: (options: AgentRunOptions) => runAgent({ ...options, registryRoot }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
    });
    try {
      const result = response(
        await pair.client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "claude", background: true, prompt: "test", cwd: root },
        }),
      );
      const runId = result.runId as string;
      const meta = JSON.parse(
        await readFile(join(registryRoot, runId, "meta.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(meta.agent).toBe("claude");
      expect(meta.runId).toBe(runId);
    } finally {
      await pair.close();
      delete process.env.STRATUM_TEST_WORKER;
    }
  });

  it("5. polls a claude background run to complete via MCP (STRATUM_TEST_WORKER=1 writes sentinel immediately)", async () => {
    process.env.STRATUM_TEST_WORKER = "1";
    const root = await mkdtemp(join(tmpdir(), "stratum-ar-claude-poll-"));
    roots.push(root);
    const registryRoot = join(root, "agent_runs");
    const pair = await connected({
      runAgent: (options: AgentRunOptions) => runAgent({ ...options, registryRoot }),
      pollBackgroundRun: (runId) => pollBackgroundRun(runId, { registryRoot }),
    });
    try {
      const started = response(
        await pair.client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "claude", background: true, prompt: "test", cwd: root },
        }),
      );
      // STRATUM_TEST_WORKER=1 writes synthetic records + rc=0 sentinel quickly — do NOT
      // assert "running" here; there is no guaranteed in-flight window with this seam.
      const polled = await waitForBackground(pair.client, started.runId as string, "complete");
      expect(polled.status).toBe("complete");
    } finally {
      await pair.close();
      delete process.env.STRATUM_TEST_WORKER;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6, 7, 8: MCP forwarding and rejection (allowedTools)
  // ──────────────────────────────────────────────────────────────────────────

  it("6. allowedTools:['Read'] is forwarded to agentRun when provided", async () => {
    let capturedOptions: AgentRunOptions | undefined;
    const pair = await connected({
      runAgent: async (options: AgentRunOptions) => {
        capturedOptions = options;
        // Return a minimal ConnectorResult — handler wraps it as status:"complete"
        return { text: "stub", usage: { usd: 0, tokens: 0, ms: 0 }, telemetry: { durationMs: 0, model: "stub" } };
      },
    });
    try {
      await pair.client.callTool({
        name: "stratum_agent_run",
        arguments: { agent: "claude", allowedTools: ["Read"], background: false, prompt: "p", cwd: "/tmp" },
      });
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions!.allowedTools).toEqual(["Read"]);
    } finally { await pair.close(); }
  });

  it("7. mixed-type allowedTools:['Read',42] triggers McpError before agentRun is called", async () => {
    let agentRunCalled = false;
    const pair = await connected({
      runAgent: async (options: AgentRunOptions) => {
        agentRunCalled = true;
        return { text: "stub", usage: { usd: 0, tokens: 0, ms: 0 }, telemetry: { durationMs: 0, model: "stub" } };
      },
    });
    try {
      // assertToolRequest validates allowedTools[1]=42 is not a string → rejects as McpError
      // The agentRun stub must NOT have been called (contract rejects before handler body)
      await expect(
        pair.client.callTool({
          name: "stratum_agent_run",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          arguments: { agent: "claude", allowedTools: ["Read", 42 as any], background: false, prompt: "p", cwd: "/tmp" },
        }),
      ).rejects.toThrow(McpError);
      expect(agentRunCalled).toBe(false);
    } finally { await pair.close(); }
  });

  it("8. absent allowedTools does NOT produce allowedTools:[] in agentRun call (Array.isArray guard)", async () => {
    let capturedOptions: AgentRunOptions | undefined;
    const pair = await connected({
      runAgent: async (options: AgentRunOptions) => {
        capturedOptions = options;
        return { text: "stub", usage: { usd: 0, tokens: 0, ms: 0 }, telemetry: { durationMs: 0, model: "stub" } };
      },
    });
    try {
      await pair.client.callTool({
        name: "stratum_agent_run",
        arguments: { agent: "claude", background: false, prompt: "p", cwd: "/tmp" },
      });
      expect(capturedOptions).toBeDefined();
      // Array.isArray guard in server.ts: absent allowedTools → undefined (not [])
      expect(capturedOptions!).not.toHaveProperty("allowedTools");
    } finally { await pair.close(); }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 9: Foreground claude allowlist flow — sdkOptions.tools end-to-end
  // ──────────────────────────────────────────────────────────────────────────

  it("9. foreground claude allowedTools maps to sdkOptions.tools end-to-end (claudeQuery boundary stub)", async () => {
    let capturedSdkOptions: Record<string, unknown> | undefined;
    // Inject claudeQuery stub via the runAgent boundary — captures what ClaudeConnector passes to SDK
    const pair = await connected({
      runAgent: (options: AgentRunOptions) =>
        runAgent(options, {
          claudeQuery: async function* ({ options: sdkOpts }) {
            capturedSdkOptions = sdkOpts as Record<string, unknown>;
            // Yield nothing — ClaudeConnector returns empty text result
          },
        }),
    });
    try {
      await pair.client.callTool({
        name: "stratum_agent_run",
        arguments: { agent: "claude", allowedTools: ["Read"], background: false, prompt: "p", cwd: "/tmp" },
      });
      expect(capturedSdkOptions).toBeDefined();
      // D5: ClaudeConnector.allowedTools → sdkOptions.tools (availability, not auto-approve)
      expect(capturedSdkOptions!.tools).toEqual(["Read"]);
      // Must NOT be sdkOptions.allowedTools (that would be auto-approve, wrong semantic)
      expect(capturedSdkOptions!).not.toHaveProperty("allowedTools");
    } finally { await pair.close(); }
  });
});
