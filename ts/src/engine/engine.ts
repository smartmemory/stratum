import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { extractReferences, type ExtractedReference, type PathSegment, type Reference } from "../ir/refs.js";
import { type Flow, type Specification, type Step } from "../ir/schema.js";
import { type ValidationError, validateSpec } from "../ir/validate.js";
import { BudgetLedger, type Budget, validUsage } from "./ledger.js";
import { type AttemptRecord, type AuditEvent, type FailureContext, type PersistedRun, StateStore, type StepState } from "./state.js";

export interface EvaluatorContext {
  input: unknown;
  steps: Readonly<Record<string, unknown>>;
  /** Present during ensure evaluation: the step output under test. */
  result?: unknown;
  /** Workspace root for file predicates (file_exists / file_contains jail). */
  workspaceRoot?: string;
}

/** P1 owns only the seam. P2 supplies the expression grammar and sandbox. */
export interface Evaluator {
  evaluate(expression: string, context: EvaluatorContext): unknown;
  /** Optional richer surface: structured pass/fail with a reason (used for ensure). */
  evaluatePredicate?(expression: string, context: EvaluatorContext): { holds: boolean; reason: string };
}

/** Result of a judged predicate, as produced by the injected judge runner (P2's evaluateJudged). */
export interface JudgedOutcome {
  holds: boolean;
  reason: string;
  stakes?: string;
  model?: string;
  usage?: Budget;
}

export type JudgeRunner = (
  predicate: { statement: string; stakes?: "cheap" | "default" | "paranoid" },
  context: { result: unknown; input: unknown },
) => Promise<JudgedOutcome>;

type EnsureOutcome = undefined | { kind: "fail"; reason: string } | { kind: "flow_budget" };

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

/** Flow-ledger snapshot on every response: spend-so-far plus declared limits when present. */
export interface LedgerInfo {
  spent: Budget;
  budget?: Budget;
}

export type EngineResponse =
  | { status: "ready"; runId: string; ready: ReadyStep[]; ledger: LedgerInfo }
  | { status: "completed"; runId: string; output: unknown; ledger: LedgerInfo }
  | { status: "failed"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "budget_exhausted"; runId: string; failure: FailureContext; ledger: LedgerInfo };

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
  /** Runner for `judged:` ensure predicates. Absent = judged predicates fail closed. */
  judge?: JudgeRunner;
}

export interface PlanOptions {
  /** Root directory that file predicates (file_exists / file_contains) are jailed to. */
  workspaceRoot?: string;
}

export class SpecValidationError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super("spec validation failed");
  }
}

export class StratumEngine {
  private readonly store: StateStore;
  private readonly evaluator: Evaluator;
  private readonly judge?: JudgeRunner;
  // Serializes load-modify-save per run: plan may hand out several ready steps, so
  // stepDone/resume can race in-process. The state root is owned by one engine process in v1.
  private readonly runLocks = new Map<string, Promise<unknown>>();

  constructor(options: StratumEngineOptions) {
    this.store = new StateStore(options.stateRoot);
    this.evaluator = options.evaluator;
    if (options.judge) this.judge = options.judge;
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

  async plan(specInput: unknown, input: unknown, options: PlanOptions = {}): Promise<EngineResponse> {
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
      // Canonicalize at plan time: a relative root must never re-resolve against a
      // different process cwd after restart.
      ...(options.workspaceRoot !== undefined ? { workspaceRoot: resolve(options.workspaceRoot) } : {}),
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
    const reported = result.usage ?? {};
    // A shape-invalid report is untrustworthy — nothing recorded, attempt fails with feedback.
    if (!validUsage(reported)) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, "invalid usage ledger entry (nothing recorded)", {}, result.output);
    // The engine reserves one dispatch per attempt itself; a client-reported count would
    // double-charge. Valid keys still settle below — the attempt consumed them regardless.
    const claimedDispatches = reported.dispatches !== undefined;
    const usage = { ...reported };
    delete usage.dispatches;
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
    if (claimedDispatches) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, "dispatches are engine-accounted; do not report them in usage (other keys were recorded)", usage, result.output);

    if (result.failure !== undefined) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, result.failure, usage);
    const contractError = this.contractError(step, result.output, validated.contracts);
    if (contractError) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, contractError, usage, result.output);

    const ensureOutcome = await this.runEnsures(run, step, state, result.output);
    if (ensureOutcome?.kind === "flow_budget") {
      const failure = { attempt, reason: "flow budget exhausted (judged predicate)" };
      state.attempts.push({ attempt, at: now(), failure, ...(hasBudget(usage) ? { usage } : {}) });
      state.status = "failed";
      state.failure = failure;
      this.event(run, "result", step.id, { attempt, failure });
      return this.terminalBudget(run, failure);
    }
    if (ensureOutcome) return this.failAttempt(run, validated.value, validated.contracts, flow, step, state, attempt, ensureOutcome.reason, usage, result.output);

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
          // Set steps are pure: an ensure failure is deterministic, so it terminalizes.
          const setEnsure = await this.runEnsures(run, step, state, output);
          if (setEnsure?.kind === "flow_budget") {
            await this.terminalBudget(run, { attempt: 0, reason: "flow budget exhausted (judged predicate)" });
            break;
          }
          if (setEnsure) { await this.terminalFailure(run, { attempt: 0, reason: setEnsure.reason }); break; }
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
        // Render BEFORE reserving: a render failure dispatches nothing, so it must not
        // debit a dispatch — and its attempt record carries no usage.
        let ready: ReadyStep;
        try {
          ready = this.readyStep(run, step, state);
        } catch (error) {
          await this.failAttempt(run, spec, contracts, flow, step, state, state.attempts.length + 1, message(error), {});
          changed = true;
          break;
        }
        const debit = this.debit(run, step, state, { dispatches: 1 }, "reserve");
        if (debit === "flow") { await this.terminalBudget(run, { attempt: state.attempts.length + 1, reason: "flow budget exhausted" }); break; }
        if (debit === "task") {
          // Over-limit reservation: nothing dispatched, nothing ledgered, no usage on the record.
          await this.failAttempt(run, spec, contracts, flow, step, state, state.attempts.length + 1, "task budget exhausted", {});
          changed = true;
          break;
        }
        state.status = "ready";
        this.event(run, "ready", step.id, { attempt: ready.attempt });
        await this.persist(run);
        changed = true;
      }
    }
    if (run.status !== "running") return this.response(run);
    const ready = flow.steps.flatMap((step) => {
      const state = run.steps[step.id]!;
      return step.do !== undefined && state.status === "ready" ? [this.readyStep(run, step, state)] : [];
    });
    if (ready.length > 0) return { status: "ready", runId: run.id, ready, ledger: this.ledgerInfo(run) };
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

  /** Evaluates a step's ensure list in order; the first failing predicate wins. */
  private async runEnsures(run: PersistedRun, step: Step, state: StepState, output: unknown): Promise<EnsureOutcome> {
    for (const predicate of step.ensure ?? []) {
      if ("judged" in predicate) {
        const { statement, stakes } = predicate.judged;
        // The runner is an injected seam — validate its outcome; a malformed shape
        // (non-boolean holds, invalid usage) must fail the attempt, never pass it.
        let outcome: JudgedOutcome | undefined;
        let failureReason: string | undefined;
        if (!this.judge) {
          failureReason = "judged predicate requires a configured judge runner";
        } else {
          try {
            const raw = (await this.judge(predicate.judged, { result: output, input: run.input })) as
              | { holds?: unknown; reason?: unknown; stakes?: unknown; model?: unknown; usage?: unknown }
              | null
              | undefined;
            // Snapshot every runner-owned field exactly once, inside the guard —
            // hostile or unstable getters must not throw past this block or
            // return different values on a second read.
            const holds = raw?.holds;
            const reason = raw?.reason;
            const stakesValue = raw?.stakes;
            const modelValue = raw?.model;
            const usageRaw = raw?.usage; // single read — unstable getters must not diverge across reads
            const usageValue = typeof usageRaw === "object" && usageRaw !== null ? { ...(usageRaw as Record<string, unknown>) } : usageRaw;
            if (typeof holds !== "boolean" || typeof reason !== "string" || (usageValue !== undefined && !validUsage(usageValue))) {
              failureReason = "judge runner returned a malformed outcome";
            } else {
              outcome = {
                holds,
                reason,
                ...(typeof stakesValue === "string" ? { stakes: stakesValue } : {}),
                ...(typeof modelValue === "string" ? { model: modelValue } : {}),
                ...(usageValue !== undefined ? { usage: usageValue } : {}),
              };
            }
          } catch (error) {
            failureReason = `judged predicate failed: ${message(error)}`;
          }
        }
        const usage = outcome?.usage ?? {};
        const budgetFailure = hasBudget(usage) ? this.debit(run, step, state, usage, "settle") : undefined;
        // Fixed audit payload — every judged evaluation events, failures included.
        this.event(run, "judged", step.id, {
          statement,
          holds: outcome?.holds ?? false,
          reason: outcome?.reason ?? failureReason ?? "unknown judged failure",
          // outcome fields are snapshot-normalized above — plain values, no getters.
          stakes: outcome?.stakes ?? stakes,
          model: outcome?.model ?? "none",
          usage: { tokens: usage.tokens ?? 0, usd: usage.usd ?? 0 },
        });
        if (budgetFailure === "flow") return { kind: "flow_budget" };
        if (budgetFailure === "task") return { kind: "fail", reason: "task budget exhausted (judged predicate)" };
        if (failureReason !== undefined) return { kind: "fail", reason: failureReason };
        if (!outcome!.holds) {
          return { kind: "fail", reason: `ensure judged ${JSON.stringify(statement)} failed: ${outcome!.reason}` };
        }
        continue;
      }
      const expression = "expr" in predicate
        ? predicate.expr
        : "file_exists" in predicate
          ? `file_exists(${JSON.stringify(predicate.file_exists)})`
          : `file_contains(${JSON.stringify(predicate.file_contains.path)}, ${JSON.stringify(predicate.file_contains.text)})`;
      const verdict = this.ensurePredicate(expression, run, output);
      if (!verdict.holds) return { kind: "fail", reason: `ensure ${JSON.stringify(expression)} failed: ${verdict.reason}` };
    }
    return undefined;
  }

  private ensurePredicate(expression: string, run: PersistedRun, output: unknown): { holds: boolean; reason: string } {
    const context: EvaluatorContext = {
      ...this.context(run),
      result: output,
      ...(run.workspaceRoot !== undefined ? { workspaceRoot: run.workspaceRoot } : {}),
    };
    // The evaluator is an injected seam: a throw or malformed verdict fails the
    // predicate with a structured reason — it never escapes stepDone unrecorded.
    try {
      if (this.evaluator.evaluatePredicate) {
        const verdict = this.evaluator.evaluatePredicate(expression, context) as { holds?: unknown; reason?: unknown } | null | undefined;
        if (typeof verdict?.holds !== "boolean" || typeof verdict.reason !== "string") {
          return { holds: false, reason: "evaluator returned a malformed predicate verdict" };
        }
        return { holds: verdict.holds, reason: verdict.reason };
      }
      const value = this.evaluator.evaluate(expression, context);
      return value === true
        ? { holds: true, reason: "predicate evaluated to true" }
        : { holds: false, reason: `predicate evaluated to ${JSON.stringify(value) ?? "undefined"}` };
    } catch (error) {
      return { holds: false, reason: message(error) };
    }
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
    const ledger = this.ledgerInfo(run);
    if (run.status === "completed") return { status: "completed", runId: run.id, output: run.output, ledger };
    if (run.status === "budget_exhausted") return { status: "budget_exhausted", runId: run.id, failure: requiredFailure(run), ledger };
    return { status: "failed", runId: run.id, failure: requiredFailure(run), ledger };
  }

  private ledgerInfo(run: PersistedRun): LedgerInfo {
    const budget = this.flowFor(run, this.validationFor(run).value).budget;
    return { spent: structuredClone(run.flowSpent), ...(budget ? { budget: structuredClone(budget) } : {}) };
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
// Total for arbitrary thrown values: Object.create(null) and hostile getters must
// not turn an error-formatting call into a second unhandled throw.
function message(error: unknown): string {
  try {
    const text = error instanceof Error ? error.message : String(error);
    return typeof text === "string" ? text : String(text);
  } catch {
    return "unstringifiable thrown value";
  }
}
function hasBudget(usage: Budget): boolean { return Object.keys(usage).length > 0; }
function requiredFailure(run: PersistedRun): FailureContext { return run.failure ?? { attempt: 0, reason: "run failed without context" }; }
function interpolate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
