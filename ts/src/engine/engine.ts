import { randomUUID } from "node:crypto";
import { z } from "zod";
import { extractReferences, type ExtractedReference, type PathSegment, type Reference } from "../ir/refs.js";
import { type Flow, type Specification, type Step } from "../ir/schema.js";
import { type ValidationError, validateSpec } from "../ir/validate.js";
import { BudgetLedger, type Budget, validUsage } from "./ledger.js";
import { type AttemptRecord, type AuditEvent, type FailureContext, type PersistedRun, StateStore, type StepState } from "./state.js";

export interface EvaluatorContext {
  input: unknown;
  steps: Readonly<Record<string, unknown>>;
}

/** P1 owns only the seam. P2 supplies the expression grammar and sandbox. */
export interface Evaluator {
  evaluate(expression: string, context: EvaluatorContext): unknown;
}

export interface StepResult {
  output?: unknown;
  failure?: string;
  /** Post-dispatch consumption (usd/tokens/ms). `dispatches` is engine-accounted and rejected here. */
  usage?: Budget;
}

export interface ReadyStep {
  id: string;
  do: string;
  agent: "claude" | "codex";
  attempt: number;
  previousFailure?: FailureContext;
}

export type EngineResponse =
  | { status: "ready"; runId: string; ready: ReadyStep[] }
  | { status: "completed"; runId: string; output: unknown }
  | { status: "failed"; runId: string; failure: FailureContext }
  | { status: "budget_exhausted"; runId: string; failure: FailureContext };

export interface AuditTrail {
  runId: string;
  status: PersistedRun["status"];
  events: AuditEvent[];
  steps: Record<string, StepState>;
  flowSpent: Budget;
  output?: unknown;
}

export interface StratumEngineOptions {
  stateRoot?: string;
  evaluator: Evaluator;
}

export class SpecValidationError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super("spec validation failed");
  }
}

export class StratumEngine {
  private readonly store: StateStore;
  private readonly evaluator: Evaluator;
  // Serializes load-modify-save per run: plan may hand out several ready steps, so
  // stepDone/resume can race in-process. The state root is owned by one engine process in v1.
  private readonly runLocks = new Map<string, Promise<unknown>>();

  constructor(options: StratumEngineOptions) {
    this.store = new StateStore(options.stateRoot);
    this.evaluator = options.evaluator;
  }

  private withRunLock<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.catch(() => undefined);
    this.runLocks.set(runId, tail);
    void tail.then(() => {
      if (this.runLocks.get(runId) === tail) this.runLocks.delete(runId);
    });
    return result;
  }

  async plan(specInput: unknown, input: unknown): Promise<EngineResponse> {
    const validation = validateSpec(specInput);
    if (!validation.ok) throw new SpecValidationError(validation.errors);
    const flowName = validation.value.flows.entry;
    const flow = validation.value.flows[flowName];
    if (!flow) throw new Error("entry flow missing after validation");
    const steps: Record<string, StepState> = Object.create(null);
    for (const step of flow.steps) steps[step.id] = { status: "pending", attempts: [], spent: {} };
    const run: PersistedRun = {
      id: randomUUID(), spec: validation.value, input, flowName, status: "running", flowSpent: {}, steps,
      events: [{ at: now(), type: "planned" }],
    };
    await this.persist(run);
    return this.advance(run, validation.value, validation.contracts);
  }

  stepDone(runId: string, stepId: string, result: StepResult): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.stepDoneLocked(runId, stepId, result));
  }

  private async stepDoneLocked(runId: string, stepId: string, result: StepResult): Promise<EngineResponse> {
    const run = await this.store.load(runId);
    const validated = this.validationFor(run);
    const flow = this.flowFor(run, validated.value);
    const step = flow.steps.find((candidate) => candidate.id === stepId);
    const state = run.steps[stepId];
    if (!step || !state || step.do === undefined || state.status !== "ready" || run.status !== "running") {
      throw new Error("step is not awaiting a client result");
    }

    const attempt = state.attempts.length + 1;
    const usage = result.usage ?? {};
    if (!validUsage(usage)) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, "invalid usage ledger entry", usage, result.output);
    // The engine reserves one dispatch per attempt itself; a client-reported count would double-charge.
    if (usage.dispatches !== undefined) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, "dispatches are engine-accounted; do not report them in usage", usage, result.output);
    // "settle": the agent already ran, so over-limit usage is still recorded in both ledgers.
    const budgetFailure = this.debit(run, step, state, usage, "settle");
    if (budgetFailure === "flow") {
      const failure = { attempt, reason: "flow budget exhausted" };
      state.attempts.push({ attempt, at: now(), failure, ...(hasBudget(usage) ? { usage } : {}) });
      state.status = "failed";
      state.failure = failure;
      this.event(run, "result", step.id, { attempt, failure });
      return this.terminalBudget(run, failure);
    }
    if (budgetFailure === "task") return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, "task budget exhausted", usage, result.output);

    if (result.failure !== undefined) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, result.failure, usage);
    const contractError = this.contractError(step, result.output, validated.contracts);
    if (contractError) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, contractError, usage, result.output);

    state.attempts.push({ attempt, at: now(), result: result.output, ...(hasBudget(usage) ? { usage } : {}) });
    state.output = result.output;
    state.status = "succeeded";
    this.event(run, "result", step.id, { attempt, result: result.output });
    const flowError = this.flowOutputError(run, flow, validated.contracts, step.id);
    if (flowError) {
      state.status = "ready";
      delete state.output;
      state.attempts.pop();
      return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, flowError, usage, result.output);
    }
    await this.persist(run);
    return this.advance(run, validated.value, validated.contracts);
  }

  resume(runId: string): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.resumeLocked(runId));
  }

  private async resumeLocked(runId: string): Promise<EngineResponse> {
    const run = await this.store.load(runId);
    const validated = this.validationFor(run);
    this.event(run, "resumed");
    await this.persist(run);
    if (run.status !== "running") return this.response(run);
    return this.advance(run, validated.value, validated.contracts);
  }

  async audit(runId: string): Promise<AuditTrail> {
    const run = await this.store.load(runId);
    return { runId, status: run.status, events: structuredClone(run.events), steps: structuredClone(run.steps), flowSpent: structuredClone(run.flowSpent), ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}) };
  }

  private async advance(run: PersistedRun, spec: Specification, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>): Promise<EngineResponse> {
    const flow = this.flowFor(run, spec);
    let changed = true;
    while (changed && run.status === "running") {
      changed = false;
      for (const step of flow.steps) {
        const state = run.steps[step.id]!;
        if (state.status !== "pending") continue;
        if (!this.isActivated(step, flow, run)) {
          if (this.unreachableOnFailTarget(step, flow, run)) {
            state.status = "skipped";
            this.event(run, "skipped", step.id, { reason: "on_fail target was never routed" });
            changed = true;
            await this.persist(run);
          }
          continue;
        }
        if (!this.dependenciesDone(step, flow, run)) continue;
        if (step.when !== undefined) {
          let enabled: unknown;
          try { enabled = this.evaluator.evaluate(step.when, this.context(run)); } catch (error) {
            await this.terminalFailure(run, { attempt: 0, reason: `when evaluation failed: ${message(error)}` });
            break;
          }
          if (enabled !== true) {
            state.status = "skipped";
            this.event(run, "skipped", step.id);
            changed = true;
            await this.persist(run);
            continue;
          }
        }
        if (step.set !== undefined) {
          const output: Record<string, unknown> = {};
          try {
            for (const [key, expression] of Object.entries(step.set)) output[key] = this.evaluator.evaluate(expression, this.context(run));
          } catch (error) {
            await this.terminalFailure(run, { attempt: 0, reason: `set evaluation failed: ${message(error)}` });
            break;
          }
          const error = this.contractError(step, output, contracts);
          if (error) { await this.terminalFailure(run, { attempt: 0, reason: error }); break; }
          state.status = "succeeded";
          state.output = output;
          state.attempts.push({ attempt: 1, at: now(), result: output });
          this.event(run, "result", step.id, { attempt: 1, result: output });
          changed = true;
          await this.persist(run);
          continue;
        }
        if (step.do === undefined) {
          await this.terminalFailure(run, { attempt: 0, reason: "construct is outside P1 engine scope" });
          break;
        }
        const debit = this.debit(run, step, state, { dispatches: 1 }, "reserve");
        if (debit === "flow") { await this.terminalBudget(run, { attempt: state.attempts.length + 1, reason: "flow budget exhausted" }); break; }
        if (debit === "task") {
          await this.failAttempt(run, spec, contracts, flow, step, state, state.attempts.length + 1, "task budget exhausted", { dispatches: 1 });
          changed = true;
          break;
        }
        try {
          const ready = this.readyStep(run, step, state);
          state.status = "ready";
          this.event(run, "ready", step.id, { attempt: ready.attempt });
          await this.persist(run);
          changed = true;
        } catch (error) {
          await this.failAttempt(run, spec, contracts, flow, step, state, state.attempts.length + 1, message(error), { dispatches: 1 });
          changed = true;
        }
      }
    }
    if (run.status !== "running") return this.response(run);
    const ready = flow.steps.flatMap((step) => {
      const state = run.steps[step.id]!;
      return step.do !== undefined && state.status === "ready" ? [this.readyStep(run, step, state)] : [];
    });
    if (ready.length > 0) return { status: "ready", runId: run.id, ready };
    if (flow.steps.every((step) => terminal(run.steps[step.id]!.status))) {
      const output = this.resolveFlowOutput(run, flow);
      const outputError = contracts[flow.output.contract]?.safeParse(output);
      if (!outputError?.success) return this.terminalFailure(run, { attempt: 0, reason: outputError?.error.message ?? "flow output contract missing" });
      run.output = output;
      run.status = "completed";
      this.event(run, "completed", undefined, { output });
      await this.persist(run);
      return this.response(run);
    }
    return this.terminalFailure(run, { attempt: 0, reason: "no runnable steps remain" });
  }

  private async failAttempt(run: PersistedRun, spec: Specification, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>, flow: Flow, step: Step, state: StepState, attempt: number, reason: string, usage: Budget, result?: unknown): Promise<EngineResponse> {
    const failure = { attempt, reason };
    state.attempts.push({ attempt, at: now(), failure, ...(result !== undefined ? { result } : {}), ...(hasBudget(usage) ? { usage } : {}) });
    state.failure = failure;
    this.event(run, "result", step.id, { attempt, failure });
    const maximum = step.attempts ?? 2;
    if (attempt < maximum) {
      state.status = "pending";
      await this.persist(run);
      return this.advance(run, spec, contracts);
    }
    state.status = "failed";
    if (step.on_fail !== undefined) {
      const target = run.steps[step.on_fail];
      if (!target) throw new Error("on_fail target missing after validation");
      target.routed = failure;
      this.event(run, "routed", step.id, { target: step.on_fail, failure });
      await this.persist(run);
      return this.advance(run, spec, contracts);
    }
    return this.terminalFailure(run, failure);
  }

  /**
   * "reserve" checks before consuming (pre-dispatch — nothing spent yet, so an
   * over-limit reservation records nothing). "settle" records actual post-dispatch
   * usage in BOTH ledgers even when over limit — the resources are already consumed.
   */
  private debit(run: PersistedRun, step: Step, state: StepState, usage: Budget, mode: "reserve" | "settle"): "flow" | "task" | undefined {
    const flowLedger = new BudgetLedger(this.flowFor(run, this.validationFor(run).value).budget, run.flowSpent);
    const taskLedger = new BudgetLedger(step.budget, state.spent);
    const flowOk = flowLedger.canDebit(usage);
    const taskOk = taskLedger.canDebit(usage);
    if (mode === "settle" || (flowOk && taskOk)) {
      flowLedger.debit(usage);
      taskLedger.debit(usage);
      Object.assign(run.flowSpent, flowLedger.spent);
      Object.assign(state.spent, taskLedger.spent);
    }
    if (!flowOk) return "flow";
    if (!taskOk) return "task";
    return undefined;
  }

  private unreachableOnFailTarget(step: Step, flow: Flow, run: PersistedRun): boolean {
    const routers = flow.steps.filter((candidate) => candidate.on_fail === step.id);
    return routers.length > 0
      && run.steps[step.id]!.routed === undefined
      && routers.every((router) => terminal(run.steps[router.id]!.status));
  }

  private isActivated(step: Step, flow: Flow, run: PersistedRun): boolean {
    const routesHere = flow.steps.some((candidate) => candidate.on_fail === step.id);
    return !routesHere || run.steps[step.id]!.routed !== undefined;
  }

  private dependenciesDone(step: Step, flow: Flow, run: PersistedRun): boolean {
    // A skipped dependency satisfies the edge (`when` is a LOCAL skip); a data ref
    // into a skipped step still fails at render time because its output is unavailable.
    return this.dependencies(step).every((id) => {
      const status = run.steps[id]?.status;
      return status === "succeeded" || status === "skipped";
    });
  }

  private dependencies(step: Step): string[] {
    const output = new Set(step.after ?? []);
    for (const value of stringLeaves(step)) {
      for (const extracted of extractReferences(value) ?? []) if (extracted.reference.kind === "step") output.add(extracted.reference.stepId);
    }
    return [...output];
  }

  private readyStep(run: PersistedRun, step: Step, state: StepState): ReadyStep {
    if (step.do === undefined) throw new Error("not a do step");
    const attempt = state.attempts.length + 1;
    return {
      id: step.id, do: this.render(step.do, run), agent: step.agent ?? "claude", attempt,
      ...(state.failure ? { previousFailure: state.failure } : state.routed ? { previousFailure: state.routed } : {}),
    };
  }

  private render(value: string, run: PersistedRun): string {
    const references = extractReferences(value);
    if (!references) throw new Error("invalid reference after validation");
    // Rebuild from match positions in the ORIGINAL template: resolved values that
    // themselves contain `${...}` or `$&`-style text are inserted verbatim, never re-scanned.
    const parts: string[] = [];
    let cursor = 0;
    for (const extracted of references) {
      const resolved = this.resolve(extracted.reference, run);
      if (resolved === undefined) throw new Error("reference output is unavailable (the source may have been skipped)");
      if (extracted.fullValue) {
        if (typeof resolved !== "string") throw new Error("do task must render to a string");
        return resolved;
      }
      const at = value.indexOf(extracted.raw, cursor);
      if (at < 0) throw new Error("reference token missing from template");
      parts.push(value.slice(cursor, at), interpolate(resolved));
      cursor = at + extracted.raw.length;
    }
    parts.push(value.slice(cursor));
    return parts.join("");
  }

  private resolveFlowOutput(run: PersistedRun, flow: Flow): unknown {
    const extracted = extractReferences(flow.output.from)?.[0];
    if (!extracted) throw new Error("invalid flow output reference after validation");
    return this.resolve(extracted.reference, run);
  }

  private flowOutputError(run: PersistedRun, flow: Flow, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>, completedStepId: string): string | undefined {
    const ref = extractReferences(flow.output.from)?.[0]?.reference;
    if (ref?.kind !== "step" || ref.stepId !== completedStepId) return undefined;
    const parse = contracts[flow.output.contract]?.safeParse(this.resolve(ref, run));
    return parse && !parse.success ? parse.error.message : parse ? undefined : "flow output contract missing";
  }

  private contractError(step: Step, output: unknown, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>): string | undefined {
    if (step.out === undefined) return undefined;
    const parse = contracts[step.out]?.safeParse(output);
    return parse && !parse.success ? parse.error.message : parse ? undefined : "output contract missing";
  }

  private resolve(reference: Reference, run: PersistedRun): unknown {
    if (reference.kind === "input") return access(run.input, reference.path);
    if (reference.kind === "step") return access(run.steps[reference.stepId]?.output, reference.path);
    throw new Error("fanout references are outside P1 engine scope");
  }

  private context(run: PersistedRun): EvaluatorContext {
    return { input: run.input, steps: Object.fromEntries(Object.entries(run.steps).flatMap(([id, state]) => state.output === undefined ? [] : [[id, state.output]])) };
  }

  private validationFor(run: PersistedRun) {
    const result = validateSpec(run.spec);
    if (!result.ok) throw new Error("persisted run contains an invalid spec");
    return result;
  }

  private flowFor(run: PersistedRun, spec: Specification): Flow {
    const flow = spec.flows[run.flowName];
    if (!flow || run.flowName === "entry") throw new Error("persisted run references an unknown flow");
    return flow;
  }

  private async terminalBudget(run: PersistedRun, failure: FailureContext): Promise<EngineResponse> {
    run.status = "budget_exhausted";
    run.failure = failure;
    this.event(run, "budget_exhausted", undefined, failure);
    await this.persist(run);
    return this.response(run);
  }

  private async terminalFailure(run: PersistedRun, failure: FailureContext): Promise<EngineResponse> {
    run.status = "failed";
    run.failure = failure;
    this.event(run, "failed", undefined, failure);
    await this.persist(run);
    return this.response(run);
  }

  private response(run: PersistedRun): EngineResponse {
    if (run.status === "completed") return { status: "completed", runId: run.id, output: run.output };
    if (run.status === "budget_exhausted") return { status: "budget_exhausted", runId: run.id, failure: requiredFailure(run) };
    return { status: "failed", runId: run.id, failure: requiredFailure(run) };
  }

  private event(run: PersistedRun, type: AuditEvent["type"], stepId?: string, detail?: unknown): void {
    run.events.push({ at: now(), type, ...(stepId ? { stepId } : {}), ...(detail !== undefined ? { detail } : {}) });
  }

  private persist(run: PersistedRun): Promise<void> { return this.store.save(run); }
}

function access(value: unknown, path: readonly PathSegment[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[part];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function stringLeaves(step: Step): string[] {
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
  };
  if (step.do !== undefined) collect(step.do);
  if (step.when !== undefined) collect(step.when);
  if (step.set !== undefined) collect(step.set);
  return values;
}

function terminal(status: StepState["status"]): boolean { return status === "succeeded" || status === "failed" || status === "skipped"; }
function now(): string { return new Date().toISOString(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasBudget(usage: Budget): boolean { return Object.keys(usage).length > 0; }
function requiredFailure(run: PersistedRun): FailureContext { return run.failure ?? { attempt: 0, reason: "run failed without context" }; }
function interpolate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
