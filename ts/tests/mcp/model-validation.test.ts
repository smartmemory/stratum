import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createToolDispatcher } from "../../src/mcp/server.js";

it.each([false, true])("rejects bad agent at MCP before dispatch or registry writes (flow=%s)", async (flow) => {
  const root = await mkdtemp(join(tmpdir(), "stratum-invalid-agent-"));
  const runAgent = vi.fn();
  const dispatcher = createToolDispatcher({ runAgent, foregroundRegistryRoot: root });
  try {
    await expect(dispatcher.call("stratum_agent_run", {
      agent: "gemini", prompt: "p", cwd: root,
      ...(flow ? { cancellationId: randomUUID(), flow: { runId: "unused" } } : {}),
    })).rejects.toThrow('Unknown agent "gemini"; expected codex or claude');
    expect(runAgent).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
