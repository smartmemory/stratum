import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer, type McpDependencies } from "../../src/mcp/server.js";

// STRAT-MCP-HEARTBEAT: while a tool call is executing, the server must emit
// periodic notifications/progress for requests that carry a progressToken, so
// clients using resetTimeoutOnProgress (compose's StratumMcpClient sets a
// 10-minute per-heartbeat timeout) survive agent runs longer than one timeout
// window. The python server streamed progress via ctx.report_progress; the TS
// port dropped it, so long synchronous stratum_agent_run calls died with MCP
// -32001 at exactly the client timeout.

async function connected(dependencies: McpDependencies) {
  const server = await createMcpServer(dependencies);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "heartbeat-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Wire-level observer: counts every notifications/progress frame the client
  // transport receives, independent of per-request onprogress routing.
  let progressFrames = 0;
  const original = clientTransport.onmessage;
  clientTransport.onmessage = (message, extra) => {
    if ((message as { method?: string }).method === "notifications/progress") progressFrames += 1;
    original?.(message, extra);
  };
  return {
    client,
    progressFrames: () => progressFrames,
    close: async () => { await client.close(); await server.close(); },
  };
}

const slowAgent = (delayMs: number): NonNullable<McpDependencies["runAgent"]> => async () => {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { text: "ok", usage: {}, telemetry: { durationMs: delayMs, model: "stub" } };
};

const streamingAgent: NonNullable<McpDependencies["runAgent"]> = async (options) => {
  const onEvent = (options as typeof options & {
    onEvent?: (event: { kind: string; metadata: Record<string, unknown> }) => Promise<void>;
  }).onEvent;
  await onEvent?.({ kind: "agent_started", metadata: { agent: "claude", model: "stub", prompt_chars: 6 } });
  await onEvent?.({ kind: "agent_relay", metadata: { text: "visible", role: "assistant" } });
  await onEvent?.({ kind: "step_usage", metadata: { input_tokens: 3, output_tokens: 4, model: "stub" } });
  return { text: "visible", usage: { tokens: 7 }, telemetry: { durationMs: 1, model: "stub" } };
};

function status(result: unknown): unknown {
  const first = (result as { content: Array<{ type: string; text?: string }> }).content[0];
  expect(first?.type).toBe("text");
  return (JSON.parse(first?.text ?? "{}") as Record<string, unknown>).status;
}

describe("progress heartbeats during tool calls", () => {
  it("forwards connector events as BuildStreamEvent JSON in progress messages", async () => {
    const pair = await connected({ runAgent: streamingAgent, heartbeatMs: 60_000 });
    try {
      const messages: string[] = [];
      const result = await pair.client.callTool(
        { name: "stratum_agent_run", arguments: { agent: "claude", prompt: "stream", cwd: process.cwd() } },
        undefined,
        {
          onprogress: (notification) => {
            if (typeof notification.message === "string") messages.push(notification.message);
          },
          resetTimeoutOnProgress: true,
          timeout: 60_000,
        },
      );
      expect(status(result)).toBe("complete");
      expect(messages).toHaveLength(3);
      const events = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
      expect(events.map((event) => event.kind)).toEqual(["agent_started", "agent_relay", "step_usage"]);
      expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
      for (const event of events) {
        expect(event).toEqual({
          schema_version: "0.2.7",
          flow_id: expect.any(String),
          step_id: "_agent_run",
          seq: expect.any(Number),
          ts: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          kind: expect.any(String),
          metadata: expect.any(Object),
          reply_required: false,
        });
        expect(event).not.toHaveProperty("task_id");
      }
      expect(new Set(events.map((event) => event.flow_id)).size).toBe(1);
      expect(events[1]?.metadata).toEqual({ text: "visible", role: "assistant" });
    } finally { await pair.close(); }
  });

  it("emits notifications/progress while stratum_agent_run executes when the request carries a progressToken", async () => {
    const pair = await connected({ runAgent: slowAgent(150), heartbeatMs: 25 });
    try {
      let ticks = 0;
      const result = await pair.client.callTool(
        { name: "stratum_agent_run", arguments: { agent: "claude", prompt: "slow", cwd: process.cwd() } },
        undefined,
        { onprogress: () => { ticks += 1; }, resetTimeoutOnProgress: true, timeout: 60_000 },
      );
      expect(status(result)).toBe("complete");
      expect(ticks).toBeGreaterThanOrEqual(2);
    } finally { await pair.close(); }
  });

  it("keeps resetting the client timeout across a run longer than one timeout window", async () => {
    // Client timeout 100ms < run 300ms: without heartbeats this rejects -32001.
    const pair = await connected({ runAgent: slowAgent(300), heartbeatMs: 25 });
    try {
      const result = await pair.client.callTool(
        { name: "stratum_agent_run", arguments: { agent: "claude", prompt: "slow", cwd: process.cwd() } },
        undefined,
        { onprogress: () => {}, resetTimeoutOnProgress: true, timeout: 100 },
      );
      expect(status(result)).toBe("complete");
    } finally { await pair.close(); }
  });

  it("emits no heartbeats for requests without a progressToken", async () => {
    const pair = await connected({ runAgent: slowAgent(80), heartbeatMs: 25 });
    try {
      // No onprogress → no progressToken in _meta; call must still complete.
      const result = await pair.client.callTool(
        { name: "stratum_agent_run", arguments: { agent: "claude", prompt: "slow", cwd: process.cwd() } },
      );
      expect(status(result)).toBe("complete");
      expect(pair.progressFrames()).toBe(0);
    } finally { await pair.close(); }
  });
});
