import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cancelBackgroundRun, pollBackgroundRun, runAgent } from "../connectors/index.js";
import { StratumEngine, type AuditTrail, type EngineResponse, type FlowPollResponse } from "../engine/engine.js";
import { createEvaluator } from "../eval/expr.js";
import { validateSpec } from "../ir/validate.js";
import { evaluateJudged } from "../judge/judged.js";
import { assertEvent, assertToolRequest, assertToolResponse, mcpSurface } from "./contracts.js";

export interface McpDependencies {
  engine?: Pick<StratumEngine, "plan" | "stepDone" | "resume" | "audit" | "gateResolve" | "flowPoll">;
  runAgent?: typeof runAgent;
  pollBackgroundRun?: typeof pollBackgroundRun;
  cancelBackgroundRun?: typeof cancelBackgroundRun;
}

export type ToolName =
  | "stratum_validate" | "stratum_plan" | "stratum_step_done" | "stratum_resume" | "stratum_audit"
  | "stratum_gate_resolve" | "stratum_flow_poll" | "stratum_agent_run" | "stratum_agent_poll" | "stratum_cancel_agent_run";

export interface ToolDispatcher { call(tool: ToolName, request: Record<string, unknown>): Promise<Record<string, unknown>> }

function defaultEngine(): StratumEngine {
  return new StratumEngine({
    ...(process.env.STRATUM_STATE_ROOT ? { stateRoot: process.env.STRATUM_STATE_ROOT } : {}),
    evaluator: createEvaluator(),
    judge: (predicate, context) => evaluateJudged(predicate, context),
  });
}

export function createToolDispatcher(dependencies: McpDependencies = {}): ToolDispatcher {
  const engine = dependencies.engine ?? defaultEngine();
  const agentRun = dependencies.runAgent ?? runAgent;
  const agentPoll = dependencies.pollBackgroundRun ?? pollBackgroundRun;
  const agentCancel = dependencies.cancelBackgroundRun ?? cancelBackgroundRun;
  return {
    async call(tool, request) {
      await assertToolRequest(tool, request);
      let response: Record<string, unknown>;
      switch (tool) {
        case "stratum_validate": {
          const validation = validateSpec(request.spec);
          response = validation.ok ? { status: "valid" } : { status: "invalid", errors: validation.errors };
          break;
        }
        case "stratum_plan": response = await engine.plan(request.spec, request.input, option(request, "workspaceRoot")); break;
        case "stratum_step_done": response = await engine.stepDone(string(request, "runId"), string(request, "stepId"), record(request, "result")); break;
        case "stratum_resume": response = await engine.resume(string(request, "runId")); break;
        case "stratum_audit": response = auditResponse(await engine.audit(string(request, "runId"))); break;
        case "stratum_gate_resolve": response = await engine.gateResolve(string(request, "runId"), string(request, "stepId"), string(request, "decision") as "approve" | "revise" | "kill"); break;
        case "stratum_flow_poll": response = flowPollResponse(await engine.flowPoll(string(request, "runId"), optionalNumber(request, "cursor"))); break;
        case "stratum_agent_run": {
          const model = optionalString(request, "model");
          const sandboxMode = optionalString(request, "sandboxMode");
          const executed = await agentRun({
            agent: string(request, "agent") as "claude" | "codex", prompt: string(request, "prompt"), cwd: string(request, "cwd"),
            ...(model ? { model } : {}),
            ...(sandboxMode ? { sandboxMode: sandboxMode as "read-only" | "workspace-write" } : {}),
            ...(typeof request.background === "boolean" ? { background: request.background } : {}),
          });
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
          break;
        }
        case "stratum_agent_poll": response = await agentPoll(string(request, "runId")); break;
        case "stratum_cancel_agent_run": response = await agentCancel(string(request, "runId")); break;
      }
      if ((tool === "stratum_audit" || tool === "stratum_flow_poll") && Array.isArray(response.events)) {
        for (const event of response.events) await assertEvent(event);
      }
      await assertToolResponse(tool, response);
      return response;
    },
  };
}

export async function createMcpServer(dependencies: McpDependencies = {}): Promise<Server> {
  const dispatcher = createToolDispatcher(dependencies);
  const surface = await mcpSurface();
  const server = new Server({ name: "stratum-mcp", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(surface.tools).map(([name, definition]) => ({ name, description: `Stratum ${name.slice("stratum_".length)}`, inputSchema: jsonSchema(definition.request) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const payload = await dispatcher.call(request.params.name as ToolName, request.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
  });
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = await createMcpServer();
  await server.connect(new StdioServerTransport());
}

function auditResponse(audit: AuditTrail): Record<string, unknown> {
  return { status: audit.status, runId: audit.runId, events: audit.events, steps: audit.steps, flowSpent: audit.flowSpent, ...(audit.output !== undefined ? { output: audit.output } : {}) };
}

function flowPollResponse(response: FlowPollResponse): Record<string, unknown> { return { ...response }; }
function option(request: Record<string, unknown>, key: string): { workspaceRoot?: string } { const value = optionalString(request, key); return value ? { workspaceRoot: value } : {}; }
function string(request: Record<string, unknown>, key: string): string { const value = request[key]; if (typeof value !== "string") throw new Error(`${key} must be a string`); return value; }
function optionalString(request: Record<string, unknown>, key: string): string | undefined { const value = request[key]; return typeof value === "string" ? value : undefined; }
function optionalNumber(request: Record<string, unknown>, key: string): number | undefined { const value = request[key]; return typeof value === "number" ? value : undefined; }
function record(request: Record<string, unknown>, key: string): Record<string, unknown> { const value = request[key]; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`); return value as Record<string, unknown>; }

function jsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [rawKey, child] of Object.entries(shape)) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    properties[key] = schemaFor(child);
    if (!optional) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}
function schemaFor(shape: unknown): Record<string, unknown> {
  if (typeof shape !== "string") return jsonSchema(shape as Record<string, unknown>);
  if (shape === "any") return {};
  if (shape === "array") return { type: "array" };
  if (shape === "object") return { type: "object" };
  if (shape === "null") return { type: "null" };
  if (shape.includes("|")) return { enum: shape.split("|") };
  return { type: shape };
}
