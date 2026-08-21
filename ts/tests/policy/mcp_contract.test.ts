import { describe, expect, it } from "vitest";
import { assertToolRequest, assertToolResponse } from "../../src/mcp/contracts.js";

describe("policy MCP contract additions", () => {
  it("accepts policy_bundle, policy_step_selector, user_id, and run_id only on their declared requests", async () => {
    await expect(assertToolRequest("stratum_plan", { spec: {}, input: {}, policy_bundle: {}, policy_step_selector: "build-*" })).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_guard_register", {
      resource_id: "r", graph: {}, edge_predicates: {}, initial: "draft", policy_bundle: {},
    })).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_gate_resolve", {
      runId: "run", stepId: "gate", decision: "approve", gateToken: "token", user_id: "user-1",
    })).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_guard_override", {
      resource_id: "r", from_state: "a", to_state: "b", authorization: "sig", rationale: "why", user_id: "user-1", run_id: "run-1",
    })).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_guard_transition", {
      resource_id: "r", from_state: "a", to_state: "b", artifacts: {}, run_id: "run-1",
    })).resolves.toBeUndefined();
  });

  it("requires all three digests on transition and override success responses", async () => {
    const digests = { entry_digest: "a", prev_digest: "", payload_digest: "b" };
    await expect(assertToolResponse("stratum_guard_transition", {
      status: "applied", verdict: {}, ledger_ref: "a", current_state: "done", ...digests,
    })).resolves.toBeUndefined();
    await expect(assertToolResponse("stratum_guard_override", {
      status: "deviation", ledger_ref: "a", current_state: "done", rationale: "why", authorized_by: "operator", ...digests,
    })).resolves.toBeUndefined();
    await expect(assertToolResponse("stratum_guard_transition", {
      status: "applied", verdict: {}, ledger_ref: "a", current_state: "done",
    })).rejects.toThrow(/entry_digest/);
  });
});
