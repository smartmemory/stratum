import { linkAbort, teardownDeadline } from "../connectors/cancellation.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { cancelBackgroundRun, pollBackgroundRun, runAgent } from "../connectors/index.js";
import type { ConnectorEventHandler } from "../connectors/base.js";
import { CheckpointOperationError, InputValidationError, SpecValidationError, StratumEngine, type AuditTrail, type BgFlowPollResponse, type EngineResponse, type FlowPollResponse } from "../engine/engine.js";
import { createEvaluator } from "../eval/expr.js";
import { createEvaluateRunner } from "../engine/evaluate.js";
import { validateSpec } from "../ir/validate.js";
import { evaluateJudgedViaCodex } from "../judge/codex_judged.js";
import { createFixtureJudge } from "../judge/fixture_judged.js";
import { evaluateJudged } from "../judge/judged.js";
import type { GuardJudge } from "../guard/transition.js";
import type { PolicyBundle } from "../policy/types.js";
import { compileSpeckit, SpeckitCompileError } from "../speckit/compiler.js";
import { assertEvent, assertShape, assertToolRequest, assertToolResponse, mcpSurface, validateShape, type OneOfShape, type Shape } from "./contracts.js";

// Single source of truth for the MCP serverInfo version: the package manifest.
// `../../package.json` resolves to the package root in both the dev tree
// (src/mcp/) and the published tree (dist/mcp/), since npm always ships
// package.json at the package root.
const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export interface McpDependencies {
  engine?: Pick<StratumEngine, "plan" | "stepDone" | "usageReport" | "commit" | "revert" | "resume" | "audit" | "gateResolve" | "flowPoll" | "flowRunBg" | "flowBgPoll" | "flowCancelBg">;
  runAgent?: typeof runAgent;
  pollBackgroundRun?: typeof pollBackgroundRun;
  cancelBackgroundRun?: typeof cancelBackgroundRun;
  /** Isolated-test seam for LLM-tier guard predicates. */
  guardJudge?: GuardJudge | null;
  /**
   * Interval between notifications/progress heartbeats while a tool call
   * executes, for requests that carry a progressToken. Keeps clients using
   * resetTimeoutOnProgress alive through agent runs longer than one timeout
   * window (python-server parity: ctx.report_progress).
   */
  heartbeatMs?: number;
  cancellationTimeoutMs?: number;
}

export type ToolName =
  | "stratum_validate" | "stratum_compile_speckit" | "stratum_plan" | "stratum_step_done" | "stratum_usage_report" | "stratum_resume" | "stratum_audit"
  | "stratum_commit" | "stratum_revert"
  | "stratum_gate_resolve" | "stratum_flow_poll" | "stratum_flow_run_bg" | "stratum_flow_bg_poll" | "stratum_flow_cancel_bg"
  | "stratum_agent_run" | "stratum_agent_poll" | "stratum_cancel_agent_run"
  | "stratum_guard_register" | "stratum_guard_transition" | "stratum_guard_override" | "stratum_guard_migrate" | "stratum_guard_upgrade" | "stratum_guard_apply_upgrade" | "stratum_guard_history";

interface ToolCallContext { onAgentEvent?: ConnectorEventHandler; signal?: AbortSignal }

export interface ToolDispatcher {
  call(tool: ToolName, request: Record<string, unknown>, context?: ToolCallContext): Promise<Record<string, unknown>>;
}

/**
 * Judged-ensure backend: explicit via STRATUM_JUDGE_BACKEND, otherwise keyed
 * to the environment — the OpenAI-API judge can never succeed without
 * OPENAI_API_KEY, so a keyless host routes through the codex connector
 * (OAuth), matching the Python judge kernel. Tests can explicitly select the
 * guarded fixture backend; unknown values fail loudly.
 */
export function judgeBackend(env: NodeJS.ProcessEnv = process.env): "openai" | "codex" | "fixture" {
  const explicit = env.STRATUM_JUDGE_BACKEND;
  if (explicit === "openai" || explicit === "codex") return explicit;
  if (explicit === "fixture") {
    if (env.NODE_ENV !== "test") throw new Error('STRATUM_JUDGE_BACKEND="fixture" is only allowed when NODE_ENV="test"');
    return explicit;
  }
  if (explicit !== undefined) throw new Error(`STRATUM_JUDGE_BACKEND must be "openai", "codex", or "fixture", got ${JSON.stringify(explicit)}`);
  return env.OPENAI_API_KEY ? "openai" : "codex";
}

function defaultEngine(): StratumEngine {
  const backend = judgeBackend();
  const judge = backend === "openai"
    ? (predicate: Parameters<typeof evaluateJudged>[0], context: Parameters<typeof evaluateJudged>[1]) => evaluateJudged(predicate, context)
    : backend === "codex"
      ? (predicate: Parameters<typeof evaluateJudged>[0], context: Parameters<typeof evaluateJudged>[1]) => evaluateJudgedViaCodex(predicate, context)
      : createFixtureJudge();
  return new StratumEngine({
    ...(process.env.STRATUM_STATE_ROOT ? { stateRoot: process.env.STRATUM_STATE_ROOT } : {}),
    evaluator: createEvaluator(),
    judge,
    evaluateRunner: createEvaluateRunner(),
  });
}

/** Every structured MCP error goes through the registry: an envelope the
 * contract does not declare (or whose payload drifts from the declaration)
 * fails here rather than reaching a client as an undeclared shape. */
async function registryError(envelope: string, errorCode: ErrorCode, message: string, data: Record<string, unknown>): Promise<McpError> {
  const declaration = (await mcpSurface()).errors[envelope];
  if (!declaration) throw new Error(`MCP error registry is missing ${envelope}`);
  assertShape(data, declaration.data, `errors.${envelope}.data`);
  return new McpError(errorCode, message, data);
}

/** Rejects a request field before the contract check can run — the cancellation
 * bookkeeping below must be in place before any awaited contract I/O, so these
 * few fields are validated by hand and reported in the declared shape. */
function inputValidationError(path: string, message: string): Promise<McpError> {
  return registryError("input_validation_failed", ErrorCode.InvalidParams, message, {
    code: "input_validation_failed",
    errors: [{ code: "input_validation_failed", path, message }],
  });
}

export function createToolDispatcher(dependencies: McpDependencies = {}): ToolDispatcher {
  const engine = dependencies.engine ?? defaultEngine();
  const agentRun = dependencies.runAgent ?? runAgent;
  const agentPoll = dependencies.pollBackgroundRun ?? pollBackgroundRun;
  const agentCancel = dependencies.cancelBackgroundRun ?? cancelBackgroundRun;
  // Register before contract I/O: an immediate cancellation cannot overtake startup.
  // UUIDs cannot collide with durable background IDs.
  const foreground = new Map<string, { controller: AbortController; settled: Promise<void> }>();
  const completed = new Map<string, "already_complete" | "already_error" | "cancelled" | Error>();
  return {
    async call(tool, request, context = {}) {
      // This request has one required string field. Check that exact shape before
      // acting synchronously, otherwise contract loading can let startup overtake
      // an already-received cancellation. Full contract validation still follows.
      if (tool === "stratum_cancel_agent_run" && typeof request.runId === "string"
        && Object.keys(request).length === 1) {
        foreground.get(request.runId)?.controller.abort(new Error("Foreground agent run cancelled"));
      }
      let cancellationId: string | undefined;
      let controller: AbortController | undefined;
      let settle: (() => void) | undefined;
      let unlink: (() => void) | undefined;
      let succeeded = false;
      let teardownFailure: Error | undefined;
      try {
        if (tool === "stratum_agent_run" && request.cancellationId !== undefined) {
          if (typeof request.cancellationId !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.cancellationId)) {
            throw await inputValidationError("cancellationId", "cancellationId must be a UUID");
          }
          cancellationId = request.cancellationId;
          if (request.background === true) throw await inputValidationError("background", "cancellationId is only supported for foreground runs");
          if (foreground.has(cancellationId) || completed.has(cancellationId)) throw await inputValidationError("cancellationId", "cancellationId has already been used");
          controller = new AbortController();
          const settled = new Promise<void>((resolve) => { settle = resolve; });
          foreground.set(cancellationId, { controller, settled });
          unlink = linkAbort(context.signal, controller);
        }
        await assertToolRequest(tool, request);
        let response: Record<string, unknown>;
        switch (tool) {
        case "stratum_compile_speckit": {
          const tasksDir = string(request, "tasks_dir");
          const flowName = optionalString(request, "flow_name") ?? "tasks";
          try {
            if (!(await stat(tasksDir)).isDirectory()) {
              response = { status: "error", error_type: "directory_not_found", message: `tasks_dir '${tasksDir}' is not a directory` };
              break;
            }
          } catch {
            response = { status: "error", error_type: "directory_not_found", message: `tasks_dir '${tasksDir}' is not a directory` };
            break;
          }
          try {
            const compiled = await compileSpeckit(tasksDir, flowName);
            response = { status: "ok", yaml: compiled.yaml, flow_name: compiled.flowName, steps: compiled.steps };
          } catch (error) {
            response = speckitErrorEnvelope(error);
          }
          break;
        }
        case "stratum_validate": {
          const validation = validateSpec(request.spec);
          response = validation.ok ? { status: "valid" } : { status: "invalid", errors: validation.errors };
          break;
        }
        case "stratum_plan": {
          const policyStepSelector = optionalString(request, "policy_step_selector");
          response = await engine.plan(request.spec, request.input, {
            ...option(request, "workspaceRoot"),
            ...(request.policy_bundle !== undefined ? { policyBundle: record(request, "policy_bundle") as unknown as PolicyBundle } : {}),
            ...(policyStepSelector !== undefined ? { policyStepSelector } : {}),
          });
          break;
        }
        case "stratum_step_done": response = await engine.stepDone(string(request, "runId"), string(request, "stepId"), record(request, "result"), string(request, "dispatchToken")); break;
        case "stratum_usage_report": response = await engine.usageReport(string(request, "runId"), record(request, "receipt")); break;
        case "stratum_commit": response = { ...await engine.commit(string(request, "flow_id"), string(request, "label")) }; break;
        case "stratum_revert": response = await engine.revert(string(request, "flow_id"), string(request, "label")); break;
        case "stratum_resume": response = await engine.resume(string(request, "runId")); break;
        case "stratum_audit": response = auditResponse(await engine.audit(string(request, "runId"))); break;
        case "stratum_gate_resolve": response = await engine.gateResolve(string(request, "runId"), string(request, "stepId"), string(request, "decision") as "approve" | "revise" | "kill", string(request, "gateToken"), optionalString(request, "user_id")); break;
        case "stratum_flow_poll": response = flowPollResponse(await engine.flowPoll(string(request, "runId"), optionalNumber(request, "cursor"))); break;
        case "stratum_flow_run_bg": response = await engine.flowRunBg(request.spec, request.input, option(request, "workspaceRoot")); break;
        case "stratum_flow_bg_poll": response = bgFlowPollResponse(await engine.flowBgPoll(string(request, "runId"), optionalNumber(request, "cursor"))); break;
        case "stratum_flow_cancel_bg": response = await engine.flowCancelBg(string(request, "runId")); break;
        case "stratum_agent_run": {
          const model = optionalString(request, "model");
          const sandboxMode = optionalString(request, "sandboxMode");
          // assertToolRequest (line 72) has already validated allowedTools/disallowedTools
          // element types via {"$array":"string"} in the contract — optionalArray() is safe.
          // Check Array.isArray() first to distinguish "not provided" from "provided as []".
          const allowedTools = Array.isArray(request.allowedTools)
            ? optionalArray(request, "allowedTools")
            : undefined;
          const disallowedTools = Array.isArray(request.disallowedTools)
            ? optionalArray(request, "disallowedTools")
            : undefined;
          const executed = await agentRun({
            agent: string(request, "agent") as "claude" | "codex",
            ...(cancellationId !== undefined ? { ownProcessGroup: true } : {}),
            prompt: string(request, "prompt"),
            cwd: string(request, "cwd"),
            // Presence-based forwarding, NOT truthiness: sandboxMode:"" must reach
            // runner/background discriminant validation and be rejected there — a
            // truthy check silently drops it and the run falls back to the default
            // (workspace-write for claude bg), bypassing the caller's intent.
            ...(model !== undefined ? { model } : {}),
            ...(sandboxMode !== undefined ? { sandboxMode: sandboxMode as "read-only" | "workspace-write" } : {}),
            ...(typeof request.background === "boolean" ? { background: request.background } : {}),
            ...(allowedTools !== undefined ? { allowedTools } : {}),
            ...(disallowedTools !== undefined ? { disallowedTools } : {}),
            ...(context.onAgentEvent !== undefined ? { onEvent: context.onAgentEvent } : {}),
            ...((controller?.signal ?? context.signal) !== undefined ? { signal: (controller?.signal ?? context.signal)! } : {}),
            ...(request.thinking !== undefined ? { thinking: record(request, "thinking") } : {}),
            ...(request.effort !== undefined ? { effort: string(request, "effort") } : {}),
          });
          unlink?.(); // Provider finished; a late disconnect cannot cancel a completed run.
          succeeded = true;
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
          break;
        }
        case "stratum_agent_poll": response = await agentPoll(string(request, "runId")); break;
        case "stratum_cancel_agent_run": {
          const runId = string(request, "runId");
          const running = foreground.get(runId);
          if (running) {
            running.controller.abort(new Error("Foreground agent run cancelled"));
            // Acknowledge only after the connector has finished teardown.
            await teardownDeadline(running.settled, dependencies.cancellationTimeoutMs ?? Number(process.env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000), "Foreground connector teardown did not settle");
            const outcome = completed.get(runId);
            if (outcome instanceof Error) throw outcome;
            response = { status: "cancelled", runId };
          } else if (completed.has(runId)) {
            const outcome = completed.get(runId);
            if (outcome instanceof Error) throw outcome;
            response = { status: outcome, runId };
          }
          else response = await agentCancel(runId);
          break;
        }
        case "stratum_guard_register": {
          const { registerGuard } = await import("../guard/transition.js");
          response = await registerGuard(string(request, "resource_id"), record(request, "graph") as Record<string, string[]>, record(request, "edge_predicates") as Record<string, Array<Record<string, unknown>>>, string(request, "initial"), optionalArray(request, "terminal"), optionalRecord(request, "stakes"), optionalString(request, "workspace_root") ?? null, request.policy_bundle !== undefined ? record(request, "policy_bundle") as unknown as PolicyBundle : undefined);
          break;
        }
        case "stratum_guard_transition": {
          const { guardTransition } = await import("../guard/transition.js");
          const runId = optionalString(request, "run_id");
          response = await guardTransition(string(request, "resource_id"), string(request, "from_state"), string(request, "to_state"), {
            artifacts: record(request, "artifacts") as Record<string, string>, modifiedFiles: optionalArray(request, "modified_files"), idempotencyKey: optionalString(request, "idempotency_key") ?? null, resolvedBy: optionalString(request, "resolved_by") ?? "agent",
            ...(runId !== undefined ? { runId } : {}),
            ...(dependencies.guardJudge !== undefined ? { judge: dependencies.guardJudge } : {}),
          });
          break;
        }
        case "stratum_guard_override": {
          const { guardOverride } = await import("../guard/transition.js");
          response = await guardOverride(string(request, "resource_id"), string(request, "from_state"), string(request, "to_state"), string(request, "authorization"), string(request, "rationale"), optionalString(request, "resolved_by") ?? "human", optionalString(request, "user_id"), optionalString(request, "run_id"));
          break;
        }
        case "stratum_guard_migrate": {
          const { guardMigrate } = await import("../guard/transition.js");
          response = await guardMigrate(string(request, "resource_id"), record(request, "new_graph") as Record<string, string[]>, record(request, "new_edge_predicates") as Record<string, Array<Record<string, unknown>>>, string(request, "authorization"), string(request, "rationale"), optionalArray(request, "new_terminal"), optionalRecord(request, "new_stakes"));
          break;
        }
        case "stratum_guard_upgrade": {
          const { guardUpgrade } = await import("../guard/transition.js");
          response = await guardUpgrade(string(request, "resource_id"), record(request, "new_graph") as Record<string, string[]>, record(request, "new_edge_predicates") as Record<string, Array<Record<string, unknown>>>, string(request, "rationale"), optionalArray(request, "new_terminal"), optionalRecord(request, "new_stakes"));
          break;
        }
        case "stratum_guard_apply_upgrade": {
          const { guardApplyUpgrade } = await import("../guard/transition.js");
          response = await guardApplyUpgrade(string(request, "resource_id"), string(request, "descriptor_id"));
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
        succeeded = true;
        return response;
      } catch (error) {
        if (error instanceof Error && "code" in error
          && ["CANCELLATION_TEARDOWN_TIMEOUT", "CANCELLATION_UNCONFIRMED"].includes(String(error.code))) {
          teardownFailure = error;
        }
        if (error instanceof SpecValidationError) {
          const code = tool === "stratum_flow_run_bg"
            && error.errors.some((entry) => entry.code === "consumer_dispatch_bg_unsupported")
            ? "consumer_dispatch_bg_unsupported" : error instanceof InputValidationError ? "input_validation_failed" : "spec_validation_failed";
          throw await registryError(code, ErrorCode.InvalidParams, error.message, { code, errors: error.errors });
        }
        if ((tool === "stratum_commit" || tool === "stratum_revert") && error instanceof CheckpointOperationError) {
          const response = checkpointErrorEnvelope(error);
          await assertToolResponse(tool, response);
          return response;
        }
        if (tool === "stratum_agent_run" || tool === "stratum_cancel_agent_run") {
          // An McpError already carries a declared code and payload — rewrapping it
          // as agent_run_failed would replace a precise contract error (a rejected
          // request field, an undeclared response) with a generic provider failure.
          if (error instanceof McpError) throw error;
          const failure = error as Error & { code?: string; usage?: unknown; split?: unknown; usdSource?: unknown; stderr?: string };
          // The envelope is always agent_run_failed; `code` names the specific
          // connector failure (CANCELLATION_TEARDOWN_TIMEOUT and friends) when it has one.
          const data = { code: failure.code ?? "agent_run_failed", ...Object.fromEntries(
            ["usage", "split", "usdSource", "stderr", "telemetry"].filter(key => key in Object(failure)).map(key => [key, (failure as unknown as Record<string, unknown>)[key]])) };
          throw await registryError("agent_run_failed", ErrorCode.InternalError, failure.message ?? String(error), data);
        }
        if (!tool.startsWith("stratum_guard_")) throw error;
        const response = guardErrorEnvelope(error);
        await assertToolResponse(tool, response);
        return response;
      } finally {
        unlink?.();
        if (cancellationId !== undefined && controller) {
          completed.set(cancellationId, teardownFailure ?? (succeeded ? "already_complete" : controller.signal.aborted ? "cancelled" : "already_error"));
          foreground.delete(cancellationId);
          if (completed.size > 1024) completed.delete(completed.keys().next().value!);
          settle?.();
        }
      }
    },
  };
}

export async function createMcpServer(dependencies: McpDependencies = {}): Promise<Server> {
  const dispatcher = createToolDispatcher(dependencies);
  const surface = await mcpSurface();
  const server = new Server({ name: "stratum-mcp", version: SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(surface.tools).map(([name, definition]) => ({
      name,
      description: (definition as typeof definition & { description?: string }).description ?? `Stratum ${name.slice("stratum_".length)}`,
      inputSchema: jsonSchema(definition.request),
    })),
  }));
  const heartbeatMs = dependencies.heartbeatMs ?? 15_000;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = request.params._meta?.progressToken;
    let progressSeq = 0;
    const sendProgress = async (message?: string): Promise<void> => {
      if (progressToken === undefined) return;
      progressSeq += 1;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: progressSeq, ...(message !== undefined ? { message } : {}) },
        });
      } catch { /* transport gone — the call itself will surface the failure */ }
    };
    let heartbeat: NodeJS.Timeout | undefined;
    if (progressToken !== undefined) {
      heartbeat = setInterval(() => {
        void sendProgress();
      }, heartbeatMs);
      heartbeat.unref?.();
    }
    try {
      let context: ToolCallContext = { signal: extra.signal };
      if (request.params.name === "stratum_agent_run" && progressToken !== undefined) {
        // No flow_id: an agent run has no flow, and a server-invented UUID cannot
        // match any consumer's correlation id — compose dropped EVERY agent event
        // as "misrouted" while it was stamped (2026-08-30 census). Progress
        // notifications are already scoped to this call by progressToken; the
        // consumer stamps its own correlation id on an absent flow_id.
        let eventSeq = 0;
        context = {
          signal: extra.signal,
          onAgentEvent: async (event) => {
            const message = JSON.stringify({
              // 0.2.8: flow_id is OPTIONAL on `_agent_run` envelopes (call-local).
              schema_version: "0.2.8",
              step_id: "_agent_run",
              seq: eventSeq,
              ts: new Date().toISOString(),
              kind: event.kind,
              // Agent connector events are call-local; stamp the same step
              // identity in usage metadata required by the BuildStreamEvent contract.
              metadata: event.kind === "step_usage"
                ? { ...event.metadata, stepId: "_agent_run" }
                : event.metadata,
              reply_required: false,
            });
            eventSeq += 1;
            await sendProgress(message);
          },
        };
      }
      const payload = await dispatcher.call(request.params.name as ToolName, request.params.arguments ?? {}, context);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }
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
  return { status: audit.status, runId: audit.runId, events: audit.events, steps: audit.steps, flowSpent: audit.flowSpent, ...(audit.output !== undefined ? { output: audit.output } : {}), ...(audit.carry !== undefined ? { carry: audit.carry } : {}) };
}

function flowPollResponse(response: FlowPollResponse): Record<string, unknown> { return { ...response }; }
function bgFlowPollResponse(response: BgFlowPollResponse): Record<string, unknown> {
  const gateStepId = response.bg.pendingGates[0];
  return { ...response, bg: { ...response.bg, ...(gateStepId !== undefined ? { gateStepId } : {}) } };
}
function option(request: Record<string, unknown>, key: string): { workspaceRoot?: string } { const value = optionalString(request, key); return value ? { workspaceRoot: value } : {}; }
function string(request: Record<string, unknown>, key: string): string { const value = request[key]; if (typeof value !== "string") throw new Error(`${key} must be a string`); return value; }
function optionalString(request: Record<string, unknown>, key: string): string | undefined { const value = request[key]; return typeof value === "string" ? value : undefined; }
function optionalNumber(request: Record<string, unknown>, key: string): number | undefined { const value = request[key]; return typeof value === "number" ? value : undefined; }
function record(request: Record<string, unknown>, key: string): Record<string, unknown> { const value = request[key]; if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`); return value as Record<string, unknown>; }
function optionalArray(request: Record<string, unknown>, key: string): string[] { const value = request[key]; return Array.isArray(value) ? value as string[] : []; }
function optionalRecord(request: Record<string, unknown>, key: string): Record<string, string> { const value = request[key]; return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, string> : {}; }
function speckitErrorEnvelope(error: unknown): { status: "error"; error_type: string; message: string } {
  if (error instanceof SpeckitCompileError) return { status: "error", error_type: error.kind, message: error.message };
  return { status: "error", error_type: "compile_error", message: error instanceof Error ? error.message : String(error) };
}
function guardErrorEnvelope(error: unknown): { status: "error"; error_type: string; message: string } {
  if (typeof error === "object" && error !== null && "errorType" in error && typeof error.errorType === "string" && "message" in error && typeof error.message === "string") {
    return { status: "error", error_type: error.errorType, message: error.message };
  }
  if (error instanceof Error) return { status: "error", error_type: error.name || "unexpected_error", message: error.message };
  return { status: "error", error_type: "unexpected_error", message: String(error) };
}

function checkpointErrorEnvelope(error: CheckpointOperationError): { status: "error"; error_type: string; message: string; available?: string[] } {
  return {
    status: "error",
    error_type: error.errorType,
    message: error.message,
    ...(error.available !== undefined ? { available: [...error.available] } : {}),
  };
}

function jsonSchema(shape: Record<string, unknown>): Record<string, unknown> {
  validateShape(shape, "schema");
  return schemaForValidated(shape);
}
export function schemaFor(shape: unknown): Record<string, unknown> {
  validateShape(shape, "schema");
  return schemaForValidated(shape);
}
function schemaForValidated(shape: Shape): Record<string, unknown> {
  if (typeof shape === "string") {
    if (shape === "any") return {};
    if (shape === "array") return { type: "array" };
    if (shape === "object") return { type: "object" };
    if (shape === "null") return { type: "null" };
    if (shape.includes("|")) return { anyOf: shape.split("|").map((alternative) => schemaForValidated(alternative)) };
    return { type: shape };
  }
  if ("$array" in shape) return { type: "array", items: schemaForValidated(shape.$array) };
  if ("$oneOf" in shape) {
    return { oneOf: (shape as OneOfShape).$oneOf.map((variant) => schemaForValidated(variant)) };
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [rawKey, child] of Object.entries(shape)) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    properties[key] = schemaForValidated(child);
    if (!optional) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}
