import { describe, expect, it } from "vitest";
import { assertEvent, assertToolRequest, eventContract, mcpSurface, assertShape, type Shape } from "../../src/mcp/contracts.js";

describe("tagged frozen-contract shape grammar", () => {
  it("rejects non-arrays for $array", () => {
    expect(() => assertShape("not-an-array", { $array: "string" }, "payload.items"))
      .toThrow("payload.items must be an array");
  });

  it("checks every $array element and includes its index in the path", () => {
    expect(() => assertShape(["ok", 7], { $array: "string" }, "payload.items"))
      .toThrow("payload.items[1] must be string");
  });

  it("accepts an empty $array", () => {
    expect(() => assertShape([], { $array: { id: "string" } }, "payload.items"))
      .not.toThrow();
  });

  it("accepts a $oneOf value matching exactly one variant", () => {
    const shape: Shape = { $oneOf: ["string", "number"] };
    expect(() => assertShape(3, shape, "payload.choice")).not.toThrow();
  });

  it("rejects a $oneOf value matching zero variants", () => {
    const shape: Shape = { $oneOf: ["string", "number"] };
    expect(() => assertShape(false, shape, "payload.choice"))
      .toThrow(/payload\.choice.*zero.*variants matched/i);
  });

  it("rejects an ambiguous $oneOf value matching multiple variants", () => {
    const shape: Shape = { $oneOf: ["any", "string"] };
    expect(() => assertShape("ambiguous", shape, "payload.choice"))
      .toThrow(/payload\.choice.*multiple.*variants matched/i);
  });

  it("uses complete-strict record matching inside $oneOf variants", () => {
    const shape: Shape = { $oneOf: [{ kind: "string" }] };
    expect(() => assertShape({ kind: "task", extra: true }, shape, "payload.choice"))
      .toThrow(/payload\.choice.*zero.*variants matched/i);
  });

  it("honors optional fields inside $oneOf variants", () => {
    const shape: Shape = { $oneOf: [{ kind: "string", "detail?": "string" }, "null"] };
    expect(() => assertShape({ kind: "task" }, shape, "payload.choice")).not.toThrow();
    expect(() => assertShape({ kind: "task", detail: "present" }, shape, "payload.choice")).not.toThrow();
  });

  it("nests $oneOf inside $array", () => {
    const shape: Shape = { $array: { $oneOf: ["string", { count: "number" }] } };
    expect(() => assertShape(["first", { count: 2 }], shape, "payload.items")).not.toThrow();
    expect(() => assertShape(["first", { count: "two" }], shape, "payload.items"))
      .toThrow(/payload\.items\[1\].*zero.*variants matched/i);
  });

  it("nests tagged constructs in record fields", () => {
    const shape: Shape = {
      entries: { $array: "string" },
      selected: { $oneOf: ["string", "null"] },
    };
    expect(() => assertShape({ entries: ["a", "b"], selected: null }, shape, "payload"))
      .not.toThrow();
  });

  it.each([
    ["an unknown reserved tag", { $wat: "string" }],
    ["a recognized tag with an extra key", { $array: "string", extra: "number" }],
    ["a non-array $oneOf payload", { $oneOf: "string" }],
    ["an empty $oneOf payload", { $oneOf: [] }],
    ["a reserved record field", { name: "string", $foo: "string" }],
    ["an unknown leaf type", { $array: "bogus" }],
    ["an unknown leaf union member", { value: "string|bogus" }],
    ["required and optional forms of the same field", { x: "string", "x?": "number" }],
  ])("rejects malformed shapes containing %s", (_case, malformed) => {
    expect(() => assertShape({}, malformed as unknown as Shape, "payload"))
      .toThrow(/malformed shape at payload/i);
  });
});

describe("STRAT-LEARN-COST frozen contract declarations", () => {
  it("freezes surface 20 and rejects undeclared nested usage-report keys", async () => {
    const surface = await mcpSurface();
    expect(surface.surface).toBe(20);
    expect(surface.tools.stratum_usage_report).toBeDefined();
    await expect(assertToolRequest("stratum_usage_report", {
      runId: "run-1",
      receipt: {
        dispatchId: "dispatch-1",
        stepId: "build",
        source: "client",
        usage: { tokens: 4 },
        telemetry: { model: "fixture", durationMs: 2, effort: "low" },
        split: { input: 2, output: 2 },
        usdSource: "reported",
        at: "2026-08-30T00:00:00.000Z",
        // Surface 20: the engine's ReceiptInput.detail (receipts.ts) is now on the wire —
        // compose writes zero-usage metadata receipts (COMP-FABLE-ASTRA slice 3) through it.
        detail: { kind: "planned_dispatch", tier: "critical" },
      },
    })).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_usage_report", {
      runId: "run-1",
      receipt: { dispatchId: "dispatch-1", source: "client", usage: {}, extra: true },
    })).rejects.toThrow("stratum_usage_report.request.receipt.extra is undeclared");
  });

  it("freezes events 4 and validates every newly declared event shape strictly", async () => {
    expect((await eventContract()).events).toBe(4);
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "usage_debit",
      stepId: "build",
      detail: {
        seq: 1, dispatchId: "dispatch-1", source: "client", amount: { tokens: 4 },
        model: "fixture", durationMs: 2, epoch: 0, attempt: 1,
      },
    })).resolves.toBeUndefined();
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "step_reset",
      stepId: "build",
      detail: { reason: "revise", reset: [{ stepId: "build", fromEpoch: 0, toEpoch: 1 }], subflowsDropped: [] },
    })).resolves.toBeUndefined();
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "checkpoint_reverted",
      detail: { label: "before", receiptsAtRevert: 3, stepsRestored: ["build"] },
    })).resolves.toBeUndefined();
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "carry_updated",
      stepId: "build",
      detail: {
        name: "wave", reason: "initial",
        provenance: { kind: "initial", sourceStep: "build", sourceEpoch: 0, at: "2026-08-30T00:00:00.000Z" },
      },
    })).resolves.toBeUndefined();
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "flow_cancelled",
      detail: { by: "fg", reason: "abort", burned: { steps: ["build"], items: 2 } },
    })).resolves.toBeUndefined();
    await expect(assertEvent({
      at: "2026-08-30T00:00:00.000Z",
      type: "usage_debit",
      detail: { seq: 1, dispatchId: "dispatch-1", source: "client", amount: {}, model: "fixture", durationMs: 2, extra: true },
    })).rejects.toThrow("event.detail.extra is undeclared");
  });

  // T-S04-4: every stratum_audit variant declares carry, not just the ones edited by hand.
  it.each(["running", "completed", "failed", "budget_exhausted"] as const)(
    "declares carry on the stratum_audit %s response variant",
    async (variant) => {
      const surface = await mcpSurface();
      const carrySample = {
        runId: "r", events: [], steps: {}, flowSpent: {},
        carry: { wave: { value: [], provenance: { kind: "initial", at: "2026-09-09T00:00:00.000Z" } } },
      };
      expect(() => assertShape(carrySample, surface.tools.stratum_audit!.responses[variant]!, `stratum_audit:${variant}`))
        .not.toThrow();
    },
  );
});

describe("agent-run failure envelope declaration", () => {
  it("declares agent_run_failed and every optional key the server attaches", async () => {
    const declaration = (await mcpSurface()).errors.agent_run_failed;
    expect(declaration).toBeDefined();
    // The server attaches these five optional keys beside `code`; each must be declared
    // or the envelope reaches a client in a shape the contract does not describe.
    expect(() => assertShape({
      code: "agent_run_failed",
      usage: { tokens: 9, ms: 12, usd: 0.25 },
      split: { input: 7, output: 2, cacheRead: 4, cacheCreation: 1 },
      usdSource: "reported",
      stderr: "fatal diagnostic",
      telemetry: { model: "fixture", durationMs: 12, effort: "high" },
    }, declaration!.data, "errors.agent_run_failed.data")).not.toThrow();
    // `code` carries a connector-specific failure code when the connector has one.
    expect(() => assertShape({ code: "CANCELLATION_TEARDOWN_TIMEOUT" }, declaration!.data, "errors.agent_run_failed.data")).not.toThrow();
    // Anything the server has not declared is still a contract violation.
    expect(() => assertShape({ code: "agent_run_failed", undeclared: true }, declaration!.data, "errors.agent_run_failed.data"))
      .toThrow("errors.agent_run_failed.data.undeclared is undeclared");
  });
});
