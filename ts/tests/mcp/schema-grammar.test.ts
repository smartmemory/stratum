import { describe, expect, it } from "vitest";
import { schemaFor } from "../../src/mcp/server.js";
import { mcpSurface } from "../../src/mcp/contracts.js";
import type { Shape } from "../../src/mcp/contracts.js";

describe("tagged frozen-contract JSON-schema translation", () => {
  it("translates $array with its element schema", () => {
    expect(schemaFor({ $array: { id: "string" } })).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    });
  });

  it("translates $oneOf variants", () => {
    expect(schemaFor({ $oneOf: ["string", "null"] })).toEqual({
      oneOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("translates nested tagged constructs and record optionality", () => {
    expect(schemaFor({
      batches: { $array: { $oneOf: [{ id: "string", "note?": "string" }, "null"] } },
    })).toEqual({
      type: "object",
      properties: {
        batches: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: { id: { type: "string" }, note: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
        },
      },
      required: ["batches"],
      additionalProperties: false,
    });
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
    expect(() => schemaFor(malformed as unknown as Shape))
      .toThrow(/malformed shape at schema/i);
  });
});

describe("spec/input tool parameters advertise a JSON-schema type", () => {
  // "any" maps to the empty schema {}, and MCP clients (Claude Code) deliver
  // untyped arguments as raw strings — the engine's Zod object parse then
  // rejects every spec. spec and input must therefore be declared "object".
  it.each([
    ["stratum_validate", ["spec"]],
    ["stratum_plan", ["spec", "input"]],
    ["stratum_flow_run_bg", ["spec", "input"]],
  ])("%s declares %s as object", async (tool, params) => {
    const surface = await mcpSurface();
    for (const param of params) {
      expect(surface.tools[tool]?.request[param], `${tool}.${param}`).toBe("object");
      expect(schemaFor(surface.tools[tool]!.request)).toMatchObject({
        properties: { [param]: { type: "object" } },
      });
    }
  });
});

describe("STRAT-LEARN-COST JSON-schema surface", () => {
  it("advertises a strict nested schema for stratum_usage_report", async () => {
    const surface = await mcpSurface();
    expect(surface.surface).toBe(22);
    const schema = schemaFor(surface.tools.stratum_usage_report!.request);
    expect(schema).toMatchObject({
      type: "object",
      required: ["runId", "receipt"],
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        receipt: {
          type: "object",
          required: ["dispatchId", "source", "usage"],
          additionalProperties: false,
          properties: {
            telemetry: { type: "object", required: ["durationMs", "model"], additionalProperties: false },
            split: { type: "object", required: ["input", "output"], additionalProperties: false },
          },
        },
      },
    });
  });
});
