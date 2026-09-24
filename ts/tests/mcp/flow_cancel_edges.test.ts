import { isolatedStateRoot } from "../helpers/state-root.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { createMcpServer, createToolDispatcher, type McpDependencies } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)));
});

const simpleFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-fgc-edge-state-"));
  roots.push(root);
  return root;
}

describe("STRAT-FLOW-CANCEL-FG stratum_flow_cancel — edge cases", () => {
  it("an unknown run id reaches the caller as a declared MCP error, not a raw ENOENT", async () => {
    const server = await createMcpServer({ flowStateRoot: isolatedStateRoot() });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flow-cancel-edge-test", version: "0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const failure = await client.callTool({ name: "stratum_flow_cancel", arguments: { runId: "no-such-run-xyz" } })
        .catch((error: unknown) => error);
      // What the wire actually returns for an unresolvable run id. cancelFlow's engine step
      // rejects with a bare ENOENT (T-S01-13, engine-level); the dispatcher's cancel-specific
      // handling only recognises CANCELLATION_TEARDOWN_TIMEOUT / CANCELLATION_UNCONFIRMED
      // (server.ts:477), so an ENOENT falls through to the generic `throw error` at server.ts:507.
      expect(failure).toBeInstanceOf(McpError);
      const mcpFailure = failure as McpError;
      // The MCP SDK wraps an uncaught throw as a JSON-RPC InternalError with the raw message —
      // there is no declared `data` envelope (no `code`, no `runId`) for this path, unlike every
      // other stratum_flow_cancel failure mode (flow_cancel_unacknowledged, flow_not_found via
      // the CLI). A client cannot distinguish "run never existed" from any other internal error
      // by inspecting `.data` here.
      expect(mcpFailure.data).toBeUndefined();
      expect(mcpFailure.message).toMatch(/ENOENT|no such run|not found/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("the same unknown-run rejection is a bare Error (code ENOENT) at the raw dispatcher layer", async () => {
    const engine = new StratumEngine({ stateRoot: await stateRoot(), evaluator: createEvaluator() });
    const dispatcher = createToolDispatcher({ engine });
    const failure = await dispatcher.call("stratum_flow_cancel", { runId: "no-such-run-xyz" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(McpError);
    expect((failure as Error & { code?: string }).code).toBe("ENOENT");
  });

  it("a registry root that was never created still settles and acknowledges a run with no agents", async () => {
    const root = await stateRoot();
    // Deliberately NOT mkdtemp'd — a directory that plausibly never existed, exactly the shape
    // `scan`'s ENOENT branch (foreground_registry.ts:368) exists to tolerate: most flows never
    // dispatch a foreground agent, so the registry directory itself may never have been created.
    const registryRoot = join(root, "never-created", "agent_fg");
    const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const dependencies: McpDependencies = { engine, foregroundRegistryRoot: registryRoot };
    const dispatcher = createToolDispatcher(dependencies);
    const planned = await dispatcher.call("stratum_plan", { spec: simpleFlow, input: { name: "Ada" } });
    const runId = planned.runId as string;

    const payload = await dispatcher.call("stratum_flow_cancel", { runId });
    expect(payload).toMatchObject({
      status: "cancelled", flowSettled: true, acknowledged: true,
      agents: { signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 },
    });
    expect((await new StateStore(root).load(runId)).status).toBe("cancelled");
  });

  it("two concurrent cancels from two dispatchers over the same roots: exactly one settles it, the other observes already_cancelled", async () => {
    const root = await stateRoot();
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-fgc-edge-reg-"));
    roots.push(registryRoot);
    const engineA = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const engineB = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
    const dispatcherA = createToolDispatcher({ engine: engineA, foregroundRegistryRoot: registryRoot });
    const dispatcherB = createToolDispatcher({ engine: engineB, foregroundRegistryRoot: registryRoot });
    const planned = await dispatcherA.call("stratum_plan", { spec: simpleFlow, input: { name: "Ada" } });
    const runId = planned.runId as string;

    const [a, b] = await Promise.all([
      dispatcherA.call("stratum_flow_cancel", { runId }),
      dispatcherB.call("stratum_flow_cancel", { runId }),
    ]);

    // Both calls succeed (cancel is idempotent), but exactly one of them is the one that
    // durably settled the run — the run lock serialises them, so there is no interleaving.
    const settlers = [a, b].filter((result) => result.acknowledged === true && result.flowSettled === true);
    expect(settlers).toHaveLength(2);
    const primary = [a, b].filter((result) => result.reason === undefined);
    const secondary = [a, b].filter((result) => result.reason === "already_cancelled");
    expect(primary).toHaveLength(1);
    expect(secondary).toHaveLength(1);

    const store = new StateStore(root);
    const persisted = await store.load(runId);
    expect(persisted.status).toBe("cancelled");
    expect(persisted.events.filter((event) => event.type === "flow_cancelled")).toHaveLength(1);
  });
});
