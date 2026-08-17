import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTHORIZATION_NAMESPACES, authorizationPayload } from "../../src/guard/authorization.js";
import { guardChecksum } from "../../src/guard/fingerprint.js";
import { GUARDS_DIR, ResourceLockManager, setGuardsDir } from "../../src/guard/store.js";
import { _ledgerHead, setGuardLockingForTests, type GuardJudge } from "../../src/guard/transition.js";
import { setGuardTrustRootForTests } from "../../src/guard/trust.js";
import { createTestSigner, type TestSigner } from "../helpers/sshsig-sign.js";
import { assertToolResponse, mcpSurface } from "../../src/mcp/contracts.js";
import { createToolDispatcher } from "../../src/mcp/server.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
let resetLocking: (() => void) | undefined;
let resetTrustRoot: (() => void) | undefined;
let operator: TestSigner;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "stratum-guard-mcp-"));
  roots.push(root);
  setGuardsDir(root);
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
  operator = createTestSigner();
  const trustRoot = join(root, "guard-signers.allowed");
  await writeFile(trustRoot, `operator ${operator.publicKeyLine}\n`, "utf8");
  resetTrustRoot = setGuardTrustRootForTests(trustRoot);
});

afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  resetLocking?.();
  resetLocking = undefined;
  resetTrustRoot?.();
  resetTrustRoot = undefined;
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
  it("declares and dispatches every guard tool", async () => {
    const surface = await mcpSurface();
    expect(Object.keys(surface.tools)).toEqual(expect.arrayContaining([
      "stratum_guard_register", "stratum_guard_transition", "stratum_guard_override", "stratum_guard_migrate", "stratum_guard_upgrade", "stratum_guard_history",
    ]));

    const subject = createToolDispatcher({ guardJudge: judge(true) });
    const registered = await subject.call("stratum_guard_register", policy("mcp"));
    expect(registered).toMatchObject({ guard_id: "mcp", status: "registered" });

    const transitioned = await subject.call("stratum_guard_transition", { resource_id: "mcp", from_state: "draft", to_state: "review", artifacts: {} });
    expect(transitioned).toMatchObject({ status: "applied", current_state: "review" });

    const migrated = await subject.call("stratum_guard_migrate", {
      resource_id: "mcp", new_graph: policy("mcp").graph, new_edge_predicates: policy("mcp").edge_predicates,
      authorization: operator.sign(authorizationPayload("migrate", {
        resource_id: "mcp",
        policy_checksum: guardChecksum(policy("mcp").graph, policy("mcp").edge_predicates, ["shipped"], {}),
        rationale: "update policy",
        ledger_head: _ledgerHead("mcp"),
      }), AUTHORIZATION_NAMESPACES.migrate),
      rationale: "update policy", new_terminal: ["shipped"], new_stakes: {},
    });
    expect(migrated).toMatchObject({ status: "migrated", graph_version: 2 });

    // STRAT-GUARD-UPGRADE: the routine path carries no override_token at all.
    const unchanged = await subject.call("stratum_guard_upgrade", {
      resource_id: "mcp", new_graph: policy("mcp").graph, new_edge_predicates: policy("mcp").edge_predicates,
      rationale: "lazy re-apply", new_terminal: ["shipped"], new_stakes: {},
    });
    expect(unchanged).toMatchObject({ status: "unchanged", graph_version: 2 });

    const upgraded = await subject.call("stratum_guard_upgrade", {
      resource_id: "mcp",
      new_graph: { ...policy("mcp").graph, draft: ["review", "audited"], audited: [] },
      new_edge_predicates: policy("mcp").edge_predicates,
      rationale: "graft audited", new_terminal: ["shipped"], new_stakes: {},
    });
    expect(upgraded).toMatchObject({ status: "migrated", graph_version: 3 });

    const overridden = await subject.call("stratum_guard_override", {
      resource_id: "mcp", from_state: "review", to_state: "shipped", rationale: "human decision",
      authorization: operator.sign(authorizationPayload("override", {
        resource_id: "mcp", from_state: "review", to_state: "shipped", rationale: "human decision", ledger_head: _ledgerHead("mcp"),
      }), AUTHORIZATION_NAMESPACES.override),
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
