import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { cancelBackgroundRun, pollBackgroundRun, runAgent } from "../connectors/index.js";
import { StratumEngine, type AuditTrail, type BgFlowPollResponse, type EngineResponse, type FlowPollResponse } from "../engine/engine.js";
import { createEvaluator } from "../eval/expr.js";
import { validateSpec } from "../ir/validate.js";
import { evaluateJudgedViaCodex } from "../judge/codex_judged.js";
import { evaluateJudged } from "../judge/judged.js";
import type { GuardJudge } from "../guard/transition.js";
import { assertEvent, assertToolRequest, assertToolResponse, mcpSurface } from "./contracts.js";

export interface McpDependencies {
  engine?: Pick<StratumEngine, "plan" | "stepDone" | "resume" | "audit" | "gateResolve" | "flowPoll" | "flowRunBg" | "flowBgPoll" | "flowCancelBg">;
  runAgent?: typeof runAgent;
  pollBackgroundRun?: typeof pollBackgroundRun;
  cancelBackgroundRun?: typeof cancelBackgroundRun;
  /** Isolated-test seam for LLM-tier guard predicates. */
  guardJudge?: GuardJudge | null;
}

export type ToolName =
  | "stratum_validate" | "stratum_plan" | "stratum_step_done" | "stratum_resume" | "stratum_audit"
  | "stratum_gate_resolve" | "stratum_flow_poll" | "stratum_flow_run_bg" | "stratum_flow_bg_poll" | "stratum_flow_cancel_bg"
  | "stratum_agent_run" | "stratum_agent_poll" | "stratum_cancel_agent_run"
  | "stratum_guard_register" | "stratum_guard_transition" | "stratum_guard_override" | "stratum_guard_migrate" | "stratum_guard_history";

export interface ToolDispatcher { call(tool: ToolName, request: Record<string, unknown>): Promise<Record<string, unknown>> }

/**
 * Judged-ensure backend: explicit via STRATUM_JUDGE_BACKEND, otherwise keyed
 * to the environment — the OpenAI-API judge can never succeed without
 * OPENAI_API_KEY, so a keyless host routes through the codex connector
 * (OAuth), matching the Python judge kernel. Unknown values fail loudly.
 */
export function judgeBackend(env: NodeJS.ProcessEnv = process.env): "openai" | "codex" {
  const explicit = env.STRATUM_JUDGE_BACKEND;
  if (explicit === "openai" || explicit === "codex") return explicit;
  if (explicit !== undefined) throw new Error(`STRATUM_JUDGE_BACKEND must be "openai" or "codex", got ${JSON.stringify(explicit)}`);
  return env.OPENAI_API_KEY ? "openai" : "codex";
}

function defaultEngine(): StratumEngine {
  const judge = judgeBackend() === "openai"
    ? (predicate: Parameters<typeof evaluateJudged>[0], context: Parameters<typeof evaluateJudged>[1]) => evaluateJudged(predicate, context)
    : (predicate: Parameters<typeof evaluateJudged>[0], context: Parameters<typeof evaluateJudged>[1]) => evaluateJudgedViaCodex(predicate, context);
  return new StratumEngine({
    ...(process.env.STRATUM_STATE_ROOT ? { stateRoot: process.env.STRATUM_STATE_ROOT } : {}),
    evaluator: createEvaluator(),
    judge,
  });
}

export function createToolDispatcher(dependencies: McpDependencies = {}): ToolDispatcher {
  const engine = dependencies.engine ?? defaultEngine();
  const agentRun = dependencies.runAgent ?? runAgent;
  const agentPoll = dependencies.pollBackgroundRun ?? pollBackgroundRun;
  const agentCancel = dependencies.cancelBackgroundRun ?? cancelBackgroundRun;
  return {
    async call(tool, request) {
      try {
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
        case "stratum_flow_run_bg": response = await engine.flowRunBg(request.spec, request.input, option(request, "workspaceRoot")); break;
        case "stratum_flow_bg_poll": response = bgFlowPollResponse(await engine.flowBgPoll(string(request, "runId"), optionalNumber(request, "cursor"))); break;
        case "stratum_flow_cancel_bg": response = await engine.flowCancelBg(string(request, "runId")); break;
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
        case "stratum_guard_register": {
          const { registerGuard } = await import("../guard/transition.js");
          response = await registerGuard(string(request, "resource_id"), record(request, "graph") as Record<string, string[]>, record(request, "edge_predicates") as Record<string, Array<Record<string, unknown>>>, string(request, "initial"), optionalArray(request, "terminal"), optionalRecord(request, "stakes"), optionalString(request, "workspace_root") ?? null);
          break;
        }
        case "stratum_guard_transition": {
          const { guardTransition } = await import("../guard/transition.js");
          response = await guardTransition(string(request, "resource_id"), string(request, "from_state"), string(request, "to_state"), {
            artifacts: record(request, "artifacts") as Record<string, string>, modifiedFiles: optionalArray(request, "modified_files"), idempotencyKey: optionalString(request, "idempotency_key") ?? null, resolvedBy: optionalString(request, "resolved_by") ?? "agent",
            ...(dependencies.guardJudge !== undefined ? { judge: dependencies.guardJudge } : {}),
          });
          break;
        }
        case "stratum_guard_override": {
          const { guardOverride } = await import("../guard/transition.js");
          response = await guardOverride(string(request, "resource_id"), string(request, "from_state"), string(request, "to_state"), string(request, "override_token"), string(request, "rationale"), optionalString(request, "resolved_by") ?? "human");
          break;
        }
        case "stratum_guard_migrate": {
          const { guardMigrate } = await import("../guard/transition.js");
          response = await guardMigrate(string(request, "resource_id"), record(request, "new_graph") as Record<string, string[]>, record(request, "new_edge_predicates") as Record<string, Array<Record<string, unknown>>>, string(request, "override_token"), string(request, "rationale"), optionalArray(request, "new_terminal"), optionalRecord(request, "new_stakes"));
          break;
        }
        case "stratum_guard_history": {
          const { guardHistory } = await import("../guard/transition.js");
          response = guardHistory(string(request, "resource_id"));
          break;
        }
      }
        if ((tool === "stratum_audit" || tool === "stratum_flow_poll" || tool === "stratum_flow_bg_poll") && Array.isArray(response.events)) {
          for (const event of response.events) await assertEvent(event);
        }
        await assertToolResponse(tool, response);
        return response;
      } catch (error) {
        if (!tool.startsWith("stratum_guard_")) throw error;
        const response = guardErrorEnvelope(error);
        await assertToolResponse(tool, response);
        return response;
      }
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
  const engine = defaultEngine();
  await engine.rehydrateBgFlows();
  const server = await createMcpServer({ engine });
  await server.connect(new StdioServerTransport());
}

function auditResponse(audit: AuditTrail): Record<string, unknown> {
  return { status: audit.status, runId: audit.runId, events: audit.events, steps: audit.steps, flowSpent: audit.flowSpent, ...(audit.output !== undefined ? { output: audit.output } : {}) };
}

function flowPollResponse(response: FlowPollResponse): Record<string, unknown> { return { ...response }; }
function bgFlowPollResponse(response: BgFlowPollResponse): Record<string, unknown> { return { ...response }; }
function option(request: Record<string, unknown>, key: string): { workspaceRoot?: string } { const value = optionalString(request, key); return value ? { workspaceRoot: value } : {}; }
function string(request: Record<string, unknown>, key: string): string { const value = request[key]; if (typeof value !== "string") throw new Error(`${key} must be a string`); return value; }
function optionalString(request: Record<string, unknown>, key: string): string | undefined { const value = request[key]; return typeof value === "string" ? value : undefined; }
function optionalNumber(request: Record<string, unknown>, key: string): number | undefined { const value = request[key]; return typeof value === "number" ? value : undefined; }
function record(request: Record<string, unknown>, key: string): Record<string, unknown> { const value = request[key]; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`); return value as Record<string, unknown>; }
function optionalArray(request: Record<string, unknown>, key: string): string[] { const value = request[key]; return Array.isArray(value) ? value as string[] : []; }
function optionalRecord(request: Record<string, unknown>, key: string): Record<string, string> { const value = request[key]; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, string> : {}; }
function guardErrorEnvelope(error: unknown): { status: "error"; error_type: string; message: string } {
  if (typeof error === "object" && error !== null && "errorType" in error && typeof error.errorType === "string" && "message" in error && typeof error.message === "string") {
    return { status: "error", error_type: error.errorType, message: error.message };
  }
  if (error instanceof Error) return { status: "error", error_type: error.name || "unexpected_error", message: error.message };
  return { status: "error", error_type: "unexpected_error", message: String(error) };
}

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
  if (shape.includes("|")) return { anyOf: shape.split("|").map((alternative) => schemaFor(alternative)) };
  return { type: shape };
}
