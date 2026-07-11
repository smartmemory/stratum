import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARDS_DIR, ResourceLockManager, setGuardsDir } from "../../src/guard/store.js";
import { setGuardLockingForTests, type GuardJudge } from "../../src/guard/transition.js";
import { assertToolResponse, mcpSurface } from "../../src/mcp/contracts.js";
import { createToolDispatcher } from "../../src/mcp/server.js";

const originalGuardsDir = GUARDS_DIR;
const originalOverrideToken = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
const roots: string[] = [];
let resetLocking: (() => void) | undefined;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "stratum-guard-mcp-"));
  roots.push(root);
  setGuardsDir(root);
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "override-test-token";
});

afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  resetLocking?.();
  resetLocking = undefined;
  if (originalOverrideToken === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = originalOverrideToken;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function judge(holds: boolean): GuardJudge {
  return async (predicate) => ({ holds, reason: predicate.statement, stakes: predicate.stakes ?? "default", model: "guard-mcp-test", usage: { tokens: 0, usd: 0 } });
}

const policy = (resourceId: string) => ({
  resource_id: resourceId,
  graph: { draft: ["review"], review: ["shipped"], shipped: [] },
  edge_predicates: { "draft->review": [{ id: "judge", type: "judged", statement: "ready" }] },
  initial: "draft",
  terminal: ["shipped"],
});

describe.sequential("guard MCP boundary", () => {
  it("declares and dispatches all five Python-parity guard tools", async () => {
    const surface = await mcpSurface();
    expect(Object.keys(surface.tools)).toEqual(expect.arrayContaining([
      "stratum_guard_register", "stratum_guard_transition", "stratum_guard_override", "stratum_guard_migrate", "stratum_guard_history",
    ]));

    const subject = createToolDispatcher({ guardJudge: judge(true) });
    const registered = await subject.call("stratum_guard_register", policy("mcp"));
    expect(registered).toMatchObject({ guard_id: "mcp", status: "registered" });

    const transitioned = await subject.call("stratum_guard_transition", { resource_id: "mcp", from_state: "draft", to_state: "review", artifacts: {} });
    expect(transitioned).toMatchObject({ status: "applied", current_state: "review" });

    const migrated = await subject.call("stratum_guard_migrate", {
      resource_id: "mcp", new_graph: policy("mcp").graph, new_edge_predicates: policy("mcp").edge_predicates,
      override_token: "override-test-token", rationale: "update policy", new_terminal: ["shipped"], new_stakes: {},
    });
    expect(migrated).toMatchObject({ status: "migrated", graph_version: 2 });

    const overridden = await subject.call("stratum_guard_override", {
      resource_id: "mcp", from_state: "review", to_state: "shipped", override_token: "override-test-token", rationale: "human decision",
    });
    expect(overridden).toMatchObject({ status: "deviation", current_state: "shipped" });

    const history = await subject.call("stratum_guard_history", { resource_id: "mcp" });
    expect(history).toMatchObject({ resource_id: "mcp", current_state: "shipped", ledger: expect.any(Array) });
    expect(history).not.toHaveProperty("status");
    await assertToolResponse("stratum_guard_history", history);
  });

  it("preserves refusals and canonicalizes guard errors as normal MCP results", async () => {
    const refusing = createToolDispatcher({ guardJudge: judge(false) });
    await refusing.call("stratum_guard_register", policy("refused"));
    const refusal = await refusing.call("stratum_guard_transition", { resource_id: "refused", from_state: "draft", to_state: "review", artifacts: {} });
    expect(refusal).toMatchObject({ status: "refused", current_state: "draft" });

    const error = await refusing.call("stratum_guard_history", { resource_id: "missing" });
    expect(error).toMatchObject({ status: "error", error_type: "guard_not_found", message: expect.any(String) });
    await assertToolResponse("stratum_guard_history", error);
  });
});
