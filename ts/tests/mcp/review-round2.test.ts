import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_AGENTS } from "../../src/engine/flow_cancel.js";
import { createToolDispatcher, type McpDependencies } from "../../src/mcp/server.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

/** An engine whose `flowCancel` rejects with a teardown code cancelFlow does NOT normalise, so
 *  the error reaches the dispatcher carrying no `agents` summary at all — the one branch the
 *  fallback exists for. */
function refusingEngine(): NonNullable<McpDependencies["engine"]> {
  return {
    flowCancel: async () => {
      throw Object.assign(new Error("teardown never acknowledged"), { code: "CANCELLATION_TEARDOWN_TIMEOUT" });
    },
  } as unknown as NonNullable<McpDependencies["engine"]>;
}

describe("F8 — the flow_cancel_unacknowledged fallback summary matches the contract", () => {
  it("fills every declared counter, including gone and unreaped", async () => {
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-r2-mcp-"));
    roots.push(registryRoot);
    const dispatcher = createToolDispatcher({ engine: refusingEngine(), foregroundRegistryRoot: registryRoot });

    const failure = await dispatcher.call("stratum_flow_cancel", { runId: "run-fallback" })
      .catch((error: unknown) => error);

    // The hand-written six-field literal this replaced drifted from the contract the moment
    // `gone` and `unreaped` were added, so the shape check rejected the envelope and the caller
    // got an undeclared error instead of the declared one.
    expect(failure).toBeInstanceOf(McpError);
    const data = (failure as McpError).data as { code: string; agents: Record<string, number> };
    expect(data.code).toBe("CANCELLATION_TEARDOWN_TIMEOUT");
    expect(data.agents).toEqual(EMPTY_AGENTS);
    expect(Object.keys(data.agents).sort()).toEqual(Object.keys(EMPTY_AGENTS).sort());
  });
});
