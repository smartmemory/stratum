import { readdir } from "node:fs/promises";
import { StratumEngine } from "../engine/engine.js";
import { type PersistedRun, StateStore } from "../engine/state.js";
import { createEvaluator } from "../eval/expr.js";
import { type Flow, type Step } from "../ir/schema.js";
import { validateSpec } from "../ir/validate.js";

type ProjectionStatus = "complete" | "running" | "awaiting_gate" | "failed" | "budget_exhausted" | "killed";

interface FlowSummary {
  _schema_version: "1";
  flow_id: string;
  flow_name: string;
  status: ProjectionStatus;
  current_step_id: string | null;
  step_count: number;
  completed_steps: number;
  round: number;
  terminal_status: PersistedRun["status"] | null;
  synthetic: false;
}

function stateRoot(): string {
  return process.env.STRATUM_STATE_ROOT || new StateStore().root;
}

function flowFor(run: Pick<PersistedRun, "spec" | "flowName">): Flow | undefined {
  const spec = run.spec as { flows?: Record<string, unknown> };
  const flow = spec.flows?.[run.flowName];
  return typeof flow === "object" && flow !== null && Array.isArray((flow as Flow).steps) ? flow as Flow : undefined;
}

function flowName(run: PersistedRun): string {
  return typeof run.flowName === "string" && run.flowName ? run.flowName : run.id;
}

function isKilled(run: Pick<PersistedRun, "status" | "failure" | "spec" | "flowName">): boolean {
  if (run.status !== "failed" || run.failure?.attempt !== 0) return false;
  // A gate kill is only derivable from a spec the REAL validator accepts — a
  // malformed spec carrying a fake gate must not spoof "killed".
  if (!validateSpec(run.spec).ok) return false;
  const flow = flowFor(run);
  return flow?.steps.some((step) => step.gate !== undefined && run.failure?.reason === `gate ${step.id} killed flow`) ?? false;
}

/** Project TS persistence terms into the Python CLI vocabulary consumed by compose. */
export function projectStatus(run: Pick<PersistedRun, "status" | "failure" | "steps" | "spec" | "flowName">): ProjectionStatus {
  if (run.status === "completed") return "complete";
  if (run.status === "budget_exhausted") return "budget_exhausted";
  if (isKilled(run)) return "killed";
  if (run.status === "failed") return "failed";
  if (Object.values(run.steps).some((step) => step.status === "waiting_gate")) return "awaiting_gate";
  return "running";
}

function functionName(step: Step): string {
  // TS IR has no Python-style function declarations; `do` is the closest
  // recorded execution name, and structural/gate steps honestly fall back to id.
  return step.do ?? step.id;
}

function currentStepId(run: PersistedRun, flow: Flow | undefined): string | null {
  // Terminal runs have no current step; live runs report the most-active step
  // (a waiting gate, then an engine-running fanout/task, then a ready step) —
  // never a pending successor of the step that is actually active.
  if (!flow || run.status !== "running") return null;
  for (const status of ["waiting_gate", "running", "ready", "pending"] as const) {
    const match = flow.steps.find((step) => run.steps[step.id]?.status === status);
    if (match) return match.id;
  }
  return null;
}

function projectFlow(run: PersistedRun): FlowSummary {
  const flow = flowFor(run);
  const status = projectStatus(run);
  return {
    _schema_version: "1",
    flow_id: run.id,
    flow_name: flowName(run),
    status,
    current_step_id: currentStepId(run, flow),
    step_count: flow?.steps.length ?? 0,
    completed_steps: Object.values(run.steps).filter((step) => step.status === "succeeded" || step.status === "skipped").length,
    round: run.rounds ?? 0,
    // Keep the persisted terminal enum honest; only the public `status` field
    // is normalized into the Python vocabulary (including derived `killed`).
    terminal_status: run.status === "running" ? null : run.status,
    synthetic: false,
  };
}

async function persistedRuns(root: string): Promise<PersistedRun[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const store = new StateStore(root);
  const runs = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    const runId = name.slice(0, -".json".length);
    try {
      const run = await store.load(runId);
      if (!isProjectableRun(run)) throw new Error("persisted document is not a flow run");
      return run;
    } catch (error) {
      process.stderr.write(`stratum: unable to load persisted flow '${runId}': ${message(error)}\n`);
      return undefined;
    }
  }));
  return runs.filter((run): run is PersistedRun => run !== undefined);
}

/**
 * Structural floor for projection: valid JSON that is not a run (`{}`, stray
 * documents) must be skipped like unreadable files, not abort the listing.
 */
function isProjectableRun(run: unknown): run is PersistedRun {
  if (typeof run !== "object" || run === null) return false;
  const candidate = run as Partial<PersistedRun>;
  return typeof candidate.id === "string"
    && typeof candidate.flowName === "string"
    && typeof candidate.status === "string"
    && typeof candidate.steps === "object" && candidate.steps !== null
    && typeof candidate.spec === "object" && candidate.spec !== null;
}

async function loadRun(root: string, runId: string): Promise<PersistedRun | undefined> {
  try {
    return await new StateStore(root).load(runId);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeError(code: string, text: string): void {
  writeJson({ error: { code, message: text } });
  process.stderr.write(`stratum: ${text}\n`);
}

function notFound(runId: string): number {
  writeError("NOT_FOUND", `Flow '${runId}' not found`);
  return 1;
}

export async function queryCommand(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && args[0] === "flows") {
      writeJson((await persistedRuns(stateRoot())).map(projectFlow));
      return 0;
    }
    if (args.length === 1 && args[0] === "gates") {
      const gates = (await persistedRuns(stateRoot())).flatMap((run) => {
        const flow = flowFor(run);
        if (!flow || run.status !== "running") return [];
        return flow.steps.flatMap((step) => {
          if (!step.gate || run.steps[step.id]?.status !== "waiting_gate") return [];
          return [{
            _schema_version: "1" as const,
            flow_id: run.id,
            flow_name: flowName(run),
            step_id: step.id,
            function: functionName(step),
            on_approve: step.gate.on_approve,
            on_revise: step.gate.on_revise,
            on_kill: step.gate.on_kill,
            timeout: null,
          }];
        });
      });
      writeJson(gates);
      return 0;
    }
    if (args.length === 2 && args[0] === "flow") {
      const run = await loadRun(stateRoot(), args[1]!);
      if (!run) return notFound(args[1]!);
      const flow = flowFor(run);
      writeJson({
        ...projectFlow(run),
        ordered_steps: (flow?.steps ?? []).map((step) => ({ id: step.id, function: functionName(step), mode: step.gate ? "gate" : "step" })),
      });
      return 0;
    }
    process.stderr.write("Usage: stratum query <flows|flow <id>|gates>\n");
    return 2;
  } catch (error) {
    writeError("INVALID", message(error));
    return 1;
  }
}

interface GateOptions {
  action: "approve" | "reject" | "revise";
  flowId: string;
  stepId: string;
}

function parseGate(args: string[]): GateOptions | undefined {
  const [action, flowId, stepId, ...flags] = args;
  if ((action !== "approve" && action !== "reject" && action !== "revise") || !flowId || !stepId) return undefined;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--note") {
      if (flags[index + 1] === undefined) return undefined;
      index += 1;
      continue;
    }
    if (flag === "--resolved-by") {
      const resolvedBy = flags[index + 1];
      if (resolvedBy !== "human" && resolvedBy !== "agent" && resolvedBy !== "system") return undefined;
      index += 1;
      continue;
    }
    return undefined;
  }
  return { action, flowId, stepId };
}

export async function gateCommand(args: string[]): Promise<number> {
  const parsed = parseGate(args);
  if (!parsed) {
    process.stderr.write("Usage: stratum gate <approve|reject|revise> <flow_id> <step_id> [--note <s>] [--resolved-by human|agent|system]\n");
    return 2;
  }
  const root = stateRoot();
  try {
    const run = await loadRun(root, parsed.flowId);
    if (!run) return notFound(parsed.flowId);
    // Python resolve_gate order: a finished flow and a non-current step are
    // idempotency CONFLICTS (flow_already_complete / wrong_step, exit 2);
    // not_a_gate_step (exit 1) fires only for the CURRENT step.
    const conflict = (detail: string): number => {
      writeJson({ conflict: true, flow_id: parsed.flowId, step_id: parsed.stepId, detail });
      process.stderr.write(`stratum gate: ${detail}\n`);
      return 2;
    };
    if (run.status !== "running") return conflict("Flow is already complete");
    // A step that is actually waiting on its gate is always resolvable — the
    // TS DAG (unlike Python's linear current_idx) can hold several waiting
    // gates at once. The Python-parity classification below applies only when
    // the named step is NOT waiting.
    if (run.steps[parsed.stepId]?.status !== "waiting_gate") {
      const flow = flowFor(run);
      const current = flow ? currentStepId(run, flow) : null;
      if (!flow || current === null || current !== parsed.stepId) {
        return conflict(`Expected gate step '${current ?? "none"}', got '${parsed.stepId}'`);
      }
      const step = flow.steps.find((candidate) => candidate.id === parsed.stepId);
      if (!step?.gate) {
        writeError("not_a_gate_step", `Step '${parsed.stepId}' is not a gate step in flow '${parsed.flowId}'`);
        return 1;
      }
      return conflict("gate is not awaiting a decision");
    }
    const decision = parsed.action === "reject" ? "kill" : parsed.action;
    const waitingFlow = flowFor(run);
    const waitingStep = waitingFlow?.steps.find((candidate) => candidate.id === parsed.stepId);
    const gate = waitingStep?.gate;
    const target = gate === undefined ? null
      : decision === "approve" ? gate.on_approve
      : decision === "revise" ? gate.on_revise
      : gate.on_kill;
    if (decision === "revise" && target === null) {
      // Python: a null on_revise is missing_on_revise (exit 1) UNLESS the round
      // budget is already exceeded — then resolving yields max_rounds_exceeded.
      const maxRounds = waitingFlow?.max_rounds;
      const exceeded = typeof maxRounds === "number" && (run.rounds ?? 0) + 1 > maxRounds;
      if (!exceeded) {
        writeError("missing_on_revise", `Gate '${parsed.stepId}' has no on_revise route`);
        return 1;
      }
    }
    // v1 engine gateResolve carries no note/resolver fields, so validated flags
    // are intentionally accepted and dropped at this CLI compatibility boundary.
    const result = await new StratumEngine({ stateRoot: root, evaluator: createEvaluator() }).gateResolve(parsed.flowId, parsed.stepId, decision);
    // Python result vocabulary, decided from the GATE'S OWN ROUTE, never from
    // downstream advancement (a routed target may complete synchronously):
    // any named route → "execute_step"; terminal kill → "killed"; revise past
    // the round budget → "max_rounds_exceeded"; null-route approve completes
    // the flow ("complete") unless DAG after-successors keep it running.
    const resultWord = decision === "revise" && (result.status === "failed" || result.status === "budget_exhausted") ? "max_rounds_exceeded"
      : target !== null ? "execute_step"
      : decision === "kill" ? "killed"
      : result.status === "completed" ? "complete"
      : "execute_step";
    writeJson({ _schema_version: "1", ok: true, flow_id: parsed.flowId, step_id: parsed.stepId, outcome: decision, result: resultWord });
    return 0;
  } catch (error) {
    writeError("INVALID", message(error));
    return 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
