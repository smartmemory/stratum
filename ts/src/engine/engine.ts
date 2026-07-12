import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runAgent } from "../connectors/runner.js";
import { extractReferences, type ExtractedReference, type PathSegment, type Reference } from "../ir/refs.js";
import { type Flow, type Specification, type Step } from "../ir/schema.js";
import { type ValidationError, validateSpec } from "../ir/validate.js";
import { BudgetLedger, type Budget, validUsage } from "./ledger.js";
import { commitCheckpoint, revertCheckpoint } from "./checkpoint.js";
import { type AttemptRecord, type AttemptTelemetry, type AuditEvent, type FailureContext, type FanoutItemState, type FanoutState, type PersistedRun, StateStore, type StepState } from "./state.js";

const execFileAsync = promisify(execFile);

export interface EvaluatorContext {
  input: unknown;
  steps: Readonly<Record<string, unknown>>;
  /** Present during ensure evaluation: the step output under test. */
  result?: unknown;
  /** Fanout-local bindings; absent for ordinary task evaluation. */
  item?: unknown;
  prev?: unknown;
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

type EnsureOutcome = undefined | { kind: "fail"; reason: string } | { kind: "flow_budget" } | { kind: "subflow_budget"; reason: string };

/** Fanout-stage ensure evaluation context: legal item/prev bindings plus the item's jail root. */
interface FanoutEnsureContext {
  itemIndex: number;
  stage: number;
  item?: unknown;
  prev?: unknown;
  workspaceRoot?: string;
}

interface ExecutionScope {
  input: unknown;
  steps: Record<string, StepState>;
  flow: Flow;
  prefix?: string;
  parent?: { step: Step; state: StepState };
}

export interface StepResult {
  output?: unknown;
  failure?: string;
  /** Post-dispatch consumption (usd/tokens/ms). `dispatches` is engine-accounted and rejected here. */
  usage?: Budget;
  /** Connector-owned wall time and resolved execution identity. */
  telemetry?: AttemptTelemetry;
}

export interface ReadyStep {
  id: string;
  do: string;
  agent: "claude" | "codex";
  attempt: number;
  epoch: number;
  previousFailure?: FailureContext;
}

/** The only P4 process/SDK boundary. Tests fake this rather than mocking git or SDK internals. */
export type EngineConnector = (request: {
  agent: "claude" | "codex";
  prompt: string;
  cwd?: string;
  attempt: number;
  previousFailure?: FailureContext;
  /** Raw contract fields for the stage's `out` — the connector must obtain JSON matching them. */
  outSchema?: Record<string, unknown>;
  /** "workspace-write" for worktree-isolated stages that must edit files. */
  sandbox?: "read-only" | "workspace-write";
}) => Promise<StepResult>;

/** Flow-ledger snapshot on every response: spend-so-far plus declared limits when present. */
export interface LedgerInfo {
  spent: Budget;
  budget?: Budget;
}

export type EngineResponse =
  | { status: "ready"; runId: string; ready: ReadyStep[]; ledger: LedgerInfo }
  | { status: "completed"; runId: string; output: unknown; ledger: LedgerInfo }
  | { status: "failed"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "budget_exhausted"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "running"; runId: string; ledger: LedgerInfo };

export interface FlowPollResponse {
  runId: string;
  status: PersistedRun["status"];
  events: AuditEvent[];
  nextCursor: number;
  ledger: LedgerInfo;
  output?: unknown;
  failure?: FailureContext;
}

export type BgStatus = "running" | "paused_gate" | "completed" | "failed" | "budget_exhausted" | "cancelled";

interface BgFlowState {
  status: BgStatus;
  cancelRequested: boolean;
  loop?: Promise<void>;
  pendingGates: string[];
}

export interface BgFlowPollResponse extends FlowPollResponse {
  bg: { status: BgStatus; cancelRequested: boolean; pendingGates: string[] };
}

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
  /** Engine-owned P4 dispatch seam. Defaults to the P3 connector runner. */
  connector?: EngineConnector;
}

export interface PlanOptions {
  /** Root directory that file predicates (file_exists / file_contains) are jailed to. */
  workspaceRoot?: string;
}

export interface CommitResponse {
  status: "committed";
  flow_id: string;
  label: string;
  step_number: number;
  current_step_id: string | null;
  checkpoints: string[];
}

export type RevertResponse = EngineResponse & { reverted_to: string };

export class CheckpointOperationError extends Error {
  readonly errorType: "flow_not_found" | "invalid_label" | "checkpoint_not_found";
  readonly available?: string[];

  constructor(errorType: CheckpointOperationError["errorType"], message: string, available?: string[]) {
    super(message);
    this.name = "CheckpointOperationError";
    this.errorType = errorType;
    if (available !== undefined) this.available = available;
  }
}

export class SpecValidationError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super("spec validation failed");
    this.errors = errors;
  }
}

export class StratumEngine {
  private readonly store: StateStore;
  private readonly evaluator: Evaluator;
  private readonly judge?: JudgeRunner;
  private readonly connector: EngineConnector;
  // Serializes load-modify-save per run: plan may hand out several ready steps, so
  // stepDone/resume can race in-process. The state root is owned by one engine process in v1.
  private readonly runLocks = new Map<string, Promise<unknown>>();
  private readonly persistLocks = new Map<string, Promise<unknown>>();
  private readonly scheduledFanouts = new Set<string>();
  // While a fanout executes, its run object is the in-process authority: every
  // entry point mutates THIS instance (not a fresh disk copy), so the fanout
  // can release the run lock across connector awaits without divergent copies.
  private readonly activeRuns = new Map<string, { run: PersistedRun; refs: number }>();
  // V1 loop ownership is in-process like runLocks; startup rehydrates ownership
  // for detached runs marked in their durable state.
  private readonly bgFlows = new Map<string, BgFlowState>();

  constructor(options: StratumEngineOptions) {
    this.store = new StateStore(options.stateRoot);
    this.evaluator = options.evaluator;
    if (options.judge) this.judge = options.judge;
    this.connector = options.connector ?? defaultConnector;
  }

  private async loadRun(runId: string): Promise<PersistedRun> {
    const active = this.activeRuns.get(runId);
    if (active) return active.run;
    return this.store.load(runId);
  }

  private retainRun(runId: string, run: PersistedRun): void {
    const active = this.activeRuns.get(runId);
    if (active) active.refs += 1;
    else this.activeRuns.set(runId, { run, refs: 1 });
  }

  private releaseRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.refs -= 1;
    if (active.refs <= 0) this.activeRuns.delete(runId);
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

  async flowRunBg(specInput: unknown, input: unknown, options: PlanOptions = {}): Promise<{ runId: string; status: "running" }> {
    const first = await this.plan(specInput, input, options);
    const run = await this.withRunLock(first.runId, async () => {
      const current = await this.loadRun(first.runId);
      current.bgDriven = true;
      await this.persist(current);
      return current;
    });
    const bg: BgFlowState = { status: "running", cancelRequested: false, pendingGates: [] };
    this.bgFlows.set(first.runId, bg);
    // Pin before launch so the loop and any fanout always share one run object.
    this.retainRun(first.runId, run);
    const loop = this.driveBg(first.runId, first);
    bg.loop = loop;
    void loop.finally(() => {
      this.releaseRun(first.runId);
      if (bg.loop === loop) delete bg.loop;
    });
    return { runId: first.runId, status: "running" };
  }

  async rehydrateBgFlows(): Promise<void> {
    for (const runId of await this.store.list()) {
      let run: PersistedRun;
      try {
        run = await this.store.load(runId);
      } catch (error) {
        process.stderr.write(`stratum: unable to load persisted flow '${runId}': ${message(error)}\n`);
        continue;
      }
      if (!run.bgDriven || this.bgFlows.has(run.id)) continue;
      if (run.status !== "running") {
        this.bgFlows.set(run.id, { status: run.status, cancelRequested: false, pendingGates: [] });
        continue;
      }
      if (run.cancelRequested === true) {
        this.bgFlows.set(run.id, { status: "cancelled", cancelRequested: true, pendingGates: [] });
        continue;
      }

      // Launch the driver WITHOUT awaiting per-run advancement: a slow/stalled run
      // must never block server startup, and a malformed persisted run must fail in
      // its own (background) driver, not abort the whole scan. driveBg self-discovers
      // the live state via reAdvance (which also re-schedules any in-flight fanout),
      // so no explicit resume is needed; the synthesized initial's ledger is never
      // read (driveBg re-derives it). retainRun and the launch are adjacent with no
      // throwing await between them, so the retain can never leak.
      //
      // AT-LEAST-ONCE across restart: an in-flight connector was durable as `ready`,
      // so the driver re-dispatches it — a step may run twice, and that second
      // physical dispatch is NOT re-ledgered (a dispatch budget may under-count by the
      // in-flight-at-crash count). Callers doing writes must be idempotent. A worktree
      // fanout merge retains its pre-existing crash window (accepted residual). This
      // assumes SINGLE-PROCESS ownership — the prior engine is gone; two live engines
      // on one state root are unsupported in v1 (same single-owner model as runLocks).
      const bg: BgFlowState = { status: "running", cancelRequested: false, pendingGates: [] };
      this.bgFlows.set(run.id, bg);
      this.retainRun(run.id, run);
      const loop = this.driveBg(run.id, { status: "running", runId: run.id, ledger: { spent: {} } });
      bg.loop = loop;
      void loop.finally(() => {
        this.releaseRun(run.id);
        if (bg.loop === loop) delete bg.loop;
      });
    }
  }

  async stepDone(runId: string, stepId: string, result: StepResult, expectedEpoch?: number): Promise<EngineResponse> {
    // Sole-mutator enforcement (STRAT-TS-FLOW-BG-OWNERSHIP): while a run is
    // actively bg-driven, the driver owns its mutation surface — an external
    // stepDone would race an in-flight connector dispatch and could commit a
    // stale result against a reset attempt. Poll via flow_bg_poll instead;
    // gates are the one exception and resolve through gateResolve.
    // Refuse for every non-cleanly-terminal bg state: running, paused_gate, AND
    // cancelled (a cancelled run is durably abandoned but may still hold a
    // `ready` step, so an external pump could mutate it). Only a genuinely
    // finished bg run (completed/failed/budget_exhausted) falls through, where
    // stepDone raises the normal "not awaiting" error anyway.
    this.assertExternalMutationAllowed(runId, "stepDone");
    return this.stepDoneOwned(runId, stepId, result, expectedEpoch);
  }

  /** Lock-wrapped stepDone used by the bg driver itself, bypassing the
   * sole-mutator guard on the public entry point. */
  private stepDoneOwned(runId: string, stepId: string, result: StepResult, expectedEpoch?: number): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.stepDoneLocked(runId, stepId, result, expectedEpoch));
  }

  private async stepDoneLocked(runId: string, stepId: string, result: StepResult, expectedEpoch?: number): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    const validated = this.validationFor(run);
    const located = this.locateStep(run, validated.value, stepId);
    const scope = located?.scope;
    const step = located?.step;
    const state = located?.state;
    if (!step || !state || step.do === undefined || state.status !== "ready" || run.status !== "running") {
      throw new Error("step is not awaiting a client result");
    }
    if (!scope) throw new Error("step scope missing after lookup");
    if (expectedEpoch !== undefined && (state.epoch ?? 0) !== expectedEpoch) {
      throw new Error("step result is stale: dispatched for a superseded epoch");
    }

    const attempt = state.attempts.length + 1;
    const telemetry = result.telemetry;
    if (!validConnectorTelemetry(telemetry)) {
      return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, "invalid connector telemetry (nothing recorded)", {}, result.output);
    }
    const reported = result.usage ?? {};
    // A shape-invalid report is untrustworthy — nothing recorded, attempt fails with feedback.
    if (!validUsage(reported)) return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, "invalid usage ledger entry (nothing recorded)", {}, result.output, telemetry);
    // The engine reserves one dispatch per attempt itself; a client-reported count would
    // double-charge. Valid keys still settle below — the attempt consumed them regardless.
    const claimedDispatches = reported.dispatches !== undefined;
    const usage = { ...reported };
    delete usage.dispatches;
    // "settle": the agent already ran, so over-limit usage is still recorded in both ledgers.
    const budgetFailure = this.debit(run, step, state, usage, "settle", scope);
    if (budgetFailure === "flow") {
      const failure = { attempt, reason: "flow budget exhausted" };
      state.attempts.push({ attempt, at: now(), failure, ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
      state.status = "failed";
      state.failure = failure;
      this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure });
      return this.terminalBudget(run, failure);
    }
    if (budgetFailure === "subflow") return this.failSubflowBudget(run, validated.value, validated.contracts, scope, step, state, attempt, "subflow budget exhausted", usage, result.output, telemetry);
    if (budgetFailure === "task") return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, "task budget exhausted", usage, result.output, telemetry);
    if (claimedDispatches) return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, "dispatches are engine-accounted; do not report them in usage (other keys were recorded)", usage, result.output, telemetry);

    if (result.failure !== undefined) return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, result.failure, usage, undefined, telemetry);
    const contractError = this.contractError(step, result.output, validated.contracts);
    if (contractError) return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, contractError, usage, result.output, telemetry);

    const ensureOutcome = await this.runEnsures(run, step, state, result.output, scope);
    if (ensureOutcome?.kind === "flow_budget") {
      const failure = { attempt, reason: "flow budget exhausted (judged predicate)" };
      state.attempts.push({ attempt, at: now(), failure, ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
      state.status = "failed";
      state.failure = failure;
      this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure });
      return this.terminalBudget(run, failure);
    }
    if (ensureOutcome?.kind === "subflow_budget") return this.failSubflowBudget(run, validated.value, validated.contracts, scope, step, state, attempt, ensureOutcome.reason, usage, result.output, telemetry);
    if (ensureOutcome) return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, ensureOutcome.reason, usage, result.output, telemetry);

    if (step.iterate !== undefined) {
      const until = this.ensurePredicate(step.iterate.until, run, result.output, scope);
      if (!until.holds) {
        const completedIterations = (state.iterations ?? 0) + 1;
        state.iterations = completedIterations;
        const failure = { attempt, reason: `iterate until ${JSON.stringify(step.iterate.until)} failed: ${until.reason}` };
        // Identical output can never satisfy a deterministic `until` predicate, so
        // spinning to iterate.max on unchanged evidence is pointless — exhaust now
        // (failAttempt marks the reason with the identical-evidence note).
        const previousResult = state.attempts[state.attempts.length - 1]?.result;
        const identicalEvidence = result.output !== undefined && previousResult !== undefined && deepEqual(result.output, previousResult);
        if (completedIterations >= step.iterate.max || identicalEvidence) {
          // Max exhaustion is a normal validation failure, including on_fail routing.
          return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, failure.reason, usage, result.output, telemetry, true);
        }
        state.attempts.push({ attempt, at: now(), failure, ...(result.output !== undefined ? { result: result.output } : {}), ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
        state.failure = failure;
        state.status = "pending";
        this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure, iterate: { iteration: completedIterations, max: step.iterate.max } });
        await this.persist(run);
        return this.advance(run, validated.value, validated.contracts, scope);
      }
    }

    state.attempts.push({ attempt, at: now(), result: result.output, ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
    state.output = result.output;
    state.status = "succeeded";
    this.event(run, "result", this.scopedId(scope, step.id), { attempt, result: result.output });
    const flowError = this.flowOutputError(scope, validated.contracts, step.id);
    if (flowError) {
      state.status = "ready";
      delete state.output;
      state.attempts.pop();
      return this.failAttempt(run, validated.value, validated.contracts, scope, step, state, attempt, flowError, usage, result.output, telemetry);
    }
    await this.persist(run);
    return this.advance(run, validated.value, validated.contracts, scope);
  }

  async commit(runId: string, label: string): Promise<CommitResponse> {
    this.assertExternalMutationAllowed(runId, "commit");
    return await this.withRunLock(runId, async () => {
      const run = await this.loadCheckpointRun(runId);
      this.assertNoForegroundFanout(run, "commit");
      const normalized = label.trim();
      if (!normalized) throw new CheckpointOperationError("invalid_label", "label must be a non-empty string");
      commitCheckpoint(run, normalized);
      await this.persist(run);
      const flow = this.flowFor(run, this.validationFor(run).value);
      const index = flow.steps.findIndex((step) => !terminal(run.steps[step.id]!.status));
      return {
        status: "committed",
        flow_id: run.id,
        label: normalized,
        step_number: (index < 0 ? flow.steps.length : index) + 1,
        current_step_id: index < 0 ? null : flow.steps[index]!.id,
        checkpoints: (run.checkpoints ?? []).map((entry) => entry.label),
      };
    });
  }

  async revert(runId: string, label: string): Promise<RevertResponse> {
    this.assertExternalMutationAllowed(runId, "revert");
    return await this.withRunLock(runId, async () => {
      const run = await this.loadCheckpointRun(runId);
      this.assertNoForegroundFanout(run, "revert");
      const normalized = label.trim();
      if (!revertCheckpoint(run, normalized)) {
        // Insertion order, matching Python (list(state.checkpoints.keys())) and the commit
        // envelope's `checkpoints` — not sorted, and robust to numeric labels (array, not object).
        const available = (run.checkpoints ?? []).map((entry) => entry.label);
        throw new CheckpointOperationError(
          "checkpoint_not_found",
          `No checkpoint '${normalized}' on flow '${runId}'`,
          available,
        );
      }
      await this.persist(run);
      return { ...await this.reAdvanceLocked(runId), reverted_to: normalized };
    });
  }

  resume(runId: string): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.resumeLocked(runId));
  }

  private async resumeLocked(runId: string): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    const validated = this.validationFor(run);
    this.event(run, "resumed");
    await this.persist(run);
    if (run.status !== "running") return this.response(run);
    const flow = this.flowFor(run, validated.value);
    for (const step of flow.steps) if (step.fanout && run.steps[step.id]?.status === "running") this.scheduleFanout(run, step.id);
    return this.advance(run, validated.value, validated.contracts);
  }

  async audit(runId: string): Promise<AuditTrail> {
    const run = await this.loadRun(runId);
    return { runId, status: run.status, events: structuredClone(run.events), steps: structuredClone(run.steps), flowSpent: structuredClone(run.flowSpent), ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}) };
  }

  /** Restart-safe read-only wait surface: events are sliced from the persisted spine. */
  async flowPoll(runId: string, cursor = 0): Promise<FlowPollResponse> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("invalid event cursor");
    const run = await this.loadRun(runId);
    return {
      runId,
      status: run.status,
      events: structuredClone(run.events.slice(cursor)),
      nextCursor: run.events.length,
      ledger: this.ledgerInfo(run),
      ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}),
      ...(run.failure !== undefined ? { failure: structuredClone(run.failure) } : {}),
    };
  }

  async flowBgPoll(runId: string, cursor = 0): Promise<BgFlowPollResponse> {
    const flow = await this.flowPoll(runId, cursor);
    const bg = this.bgFlows.get(runId);
    if (!bg) throw new Error(`background flow ${runId} not found`);
    return {
      ...flow,
      bg: {
        status: bg.status,
        cancelRequested: bg.cancelRequested,
        pendingGates: [...bg.pendingGates],
      },
    };
  }

  async flowCancelBg(runId: string): Promise<{ status: BgStatus }> {
    const bg = this.bgFlows.get(runId);
    if (!bg) throw new Error(`background flow ${runId} not found`);
    bg.cancelRequested = true;
    // Durable cooperative flag: an in-flight fanout batch observes this on the
    // shared run instance and stops dispatching further items (already-dispatched
    // items finish). The driver loop observes bg.cancelRequested at its boundary.
    await this.withRunLock(runId, async () => {
      const run = await this.loadRun(runId);
      if (run.status === "running" && !run.cancelRequested) { run.cancelRequested = true; await this.persist(run); }
    });
    // A gate-paused flow has no live loop to observe the flag, so cancel abandons
    // the hand-off here instead of wedging at paused_gate forever.
    if (bg.status === "paused_gate") { bg.status = "cancelled"; bg.pendingGates = []; }
    return { status: bg.status };
  }

  async gateResolve(runId: string, stepId: string, decision: "approve" | "revise" | "kill"): Promise<EngineResponse> {
    const response = await this.withRunLock(runId, () => this.gateResolveLocked(runId, stepId, decision));
    const bg = this.bgFlows.get(runId);
    if (bg?.status === "paused_gate" && response.status !== "ready" && response.status !== "running") {
      bg.status = response.status;
      bg.pendingGates = [];
    } else if (bg?.status === "paused_gate") {
      bg.status = "running";
      bg.pendingGates = [];
      const run = await this.loadRun(runId);
      // Re-kick only after gateResolve releases the run lock; stepDone must interleave.
      this.retainRun(runId, run);
      const loop = this.driveBg(runId, response);
      bg.loop = loop;
      void loop.finally(() => {
        this.releaseRun(runId);
        if (bg.loop === loop) delete bg.loop;
      });
    }
    return response;
  }

  private async gateResolveLocked(runId: string, stepId: string, decision: "approve" | "revise" | "kill"): Promise<EngineResponse> {
    // Runtime guard for JS callers: an unknown decision must be rejected, not
    // fall through the ternary chain onto the kill route.
    if (decision !== "approve" && decision !== "revise" && decision !== "kill") throw new Error(`invalid gate decision ${JSON.stringify(decision)}`);
    const run = await this.loadRun(runId);
    const validated = this.validationFor(run);
    const located = this.locateStep(run, validated.value, stepId);
    const scope = located?.scope;
    const step = located?.step;
    const state = located?.state;
    if (!scope || !step?.gate || !state || state.status !== "waiting_gate" || run.status !== "running") throw new Error("gate is not awaiting a decision");
    const target = decision === "approve" ? step.gate.on_approve : decision === "revise" ? step.gate.on_revise : step.gate.on_kill;
    this.event(run, "gate_resolved", stepId, { decision, target });
    if (decision === "kill") {
      state.status = "succeeded";
      if (target === null) {
        const reason = `gate ${stepId} killed flow`;
        return scope.parent
          ? this.failScope(run, validated.value, validated.contracts, scope, reason)
          : this.terminalFailure(run, { attempt: 0, reason });
      }
    } else if (decision === "revise") {
      const total = (scope.parent ? scope.parent.state.sub?.rounds ?? 0 : run.rounds ?? 0) + 1;
      const gateRounds = state.iterations ?? 0;
      const flowLimit = scope.flow.max_rounds;
      const gateLimit = step.gate.max_rounds;
      if (target === null || flowLimit === undefined || total > flowLimit || (gateLimit !== undefined && gateRounds + 1 > gateLimit)) {
        return scope.parent
          ? this.failScope(run, validated.value, validated.contracts, scope, "gate revision rounds exhausted")
          : this.terminalFailure(run, { attempt: 0, reason: "gate revision rounds exhausted" });
      }
      if (scope.parent) scope.parent.state.sub!.rounds = total;
      else run.rounds = total;
      this.resetFrom(scope.flow, scope.steps, target);
      // The target's descendants include this gate; retain its local revision counter.
      scope.steps[step.id]!.iterations = gateRounds + 1;
      await this.persist(run);
      return this.advance(run, validated.value, validated.contracts, scope);
    } else {
      state.status = "succeeded";
    }
    if (decision === "approve" && target === null) {
      if (!scope.parent) return this.completeTerminalGate(run, scope.flow, validated.contracts);
      const output = this.resolveFlowOutput(scope);
      const parsed = validated.contracts[scope.flow.output.contract]?.safeParse(output);
      if (!parsed?.success) return this.failScope(run, validated.value, validated.contracts, scope, parsed?.error.message ?? "flow output contract missing");
      return this.completeSubflow(run, validated.value, validated.contracts, scope, output);
    }
    if (target !== null) {
      const targetState = scope.steps[target];
      if (!targetState) throw new Error("gate target missing after validation");
      targetState.routed = { attempt: 0, reason: `gate ${decision}` };
    }
    await this.persist(run);
    return this.advance(run, validated.value, validated.contracts, scope);
  }

  private async completeTerminalGate(run: PersistedRun, flow: Flow, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>): Promise<EngineResponse> {
    const output = this.resolveFlowOutput({ input: run.input, steps: run.steps, flow });
    const parsed = contracts[flow.output.contract]?.safeParse(output);
    if (!parsed?.success) return this.terminalFailure(run, { attempt: 0, reason: parsed?.error.message ?? "flow output contract missing" });
    run.output = output;
    run.status = "completed";
    this.event(run, "completed", undefined, { output });
    await this.persist(run);
    return this.response(run);
  }

  /** Re-derive a run's response after async fanout/subflow progress without
   * emitting a `resumed` event on every detached-driver poll. */
  private reAdvance(runId: string): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.reAdvanceLocked(runId));
  }

  private async reAdvanceLocked(runId: string): Promise<EngineResponse> {
    const current = await this.loadRun(runId);
    if (current.status !== "running") return this.response(current);
    const validated = this.validationFor(current);
    const flow = this.flowFor(current, validated.value);
    for (const step of flow.steps) if (step.fanout && current.steps[step.id]?.status === "running") this.scheduleFanout(current, step.id);
    return this.advance(current, validated.value, validated.contracts);
  }

  // SOLE-MUTATOR INVARIANT (v1): while a run is bg-driven, this driver owns its
  // mutation surface — a session polls (flowBgPoll) and resolves gates
  // (gateResolve), but must NOT externally call stepDone on it. The defensive
  // epoch-bound settlement below rejects any result dispatched before a revise.
  private async driveBg(runId: string, initial: EngineResponse): Promise<void> {
    const bg = this.bgFlows.get(runId);
    if (!bg) return;
    let response = initial;
    try {
      while (true) {
        if (bg.cancelRequested) {
          bg.status = "cancelled";
          return;
        }
        if (response.status === "ready") {
          const steps = response.ready;
          if (steps.length === 0) throw new Error("ready response contained no steps");
          const run = await this.loadRun(runId);
          const results = await Promise.all(steps.map(async (step) => {
            let result: StepResult;
            try {
              result = await this.connector({
                agent: step.agent,
                prompt: step.do,
                attempt: step.attempt,
                ...(run.workspaceRoot !== undefined ? { cwd: run.workspaceRoot } : {}),
                ...(step.previousFailure !== undefined ? { previousFailure: step.previousFailure } : {}),
                sandbox: "read-only",
              });
            } catch (error) {
              result = { failure: message(error) };
            }
            return { step, result };
          }));
          for (const { step, result } of results) {
            try {
              await this.stepDoneOwned(runId, step.id, result, step.epoch);
            } catch (error) {
              // Swallow ONLY genuine supersession — the run ended, the step already
              // advanced, or a revise bumped its epoch (a stale-epoch rejection);
              // reAdvance reconciles those below. A throw while the step is still
              // ready at the SAME epoch (e.g. a malformed connector result) is a
              // real driver failure and must terminalize, not spin forever.
              // Resolve via locateStep: subflow child ids are scoped (parent/child)
              // and live in parentState.sub.steps, not the root steps map.
              const current = await this.loadRun(runId);
              const state = this.locateStep(current, this.validationFor(current).value, step.id)?.state;
              const superseded = current.status !== "running" || state === undefined
                || state.status !== "ready" || (state.epoch ?? 0) !== step.epoch;
              if (!superseded) throw error;
            }
          }
          response = await this.reAdvance(runId);
          continue;
        }
        if (response.status === "completed" || response.status === "failed" || response.status === "budget_exhausted") {
          bg.status = response.status;
          return;
        }
        // Pause on gates only when the run is QUIESCENT: no in-flight fanout can
        // still settle behind the exited driver. Decided under the run lock so it
        // cannot interleave inside settleFanout's locked flip+advance — otherwise a
        // driver could pause with a stale set (missing a gate the settlement is about
        // to activate) or, worse, exit into paused_gate while a fanout terminalizes
        // the run, leaving bg wedged at paused_gate with no driver left to observe it.
        const gates = await this.withRunLock(runId, async () => {
          const current = await this.loadRun(runId);
          if (current.status !== "running") return [];
          const spec = this.validationFor(current).value;
          if (this.anyFanoutRunning(current, spec)) return null;
          return this.collectWaitingGates(current, spec);
        });
        if (gates && gates.length > 0) {
          bg.status = "paused_gate";
          bg.pendingGates = gates;
          return;
        }
        await delay(25);
        response = await this.reAdvance(runId);
      }
    } catch (error) {
      try {
        await this.withRunLock(runId, async () => {
          const run = await this.loadRun(runId);
          if (run.status === "running") await this.terminalFailure(run, { attempt: 0, reason: `background driver failed: ${message(error)}` });
        });
      } catch { /* persistence failure is already the terminal boundary */ }
      // Flip the registry status only AFTER the durable terminalization settles, so
      // a poller that observes "failed" can trust the persisted state is written —
      // consistent with the response-driven terminal paths above.
      bg.status = "failed";
    }
  }

  private async advance(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope = this.rootScope(run, spec),
  ): Promise<EngineResponse> {
    await this.advanceScopeLoop(run, spec, contracts, scope);
    if (run.status !== "running") return this.response(run);
    if (scope.parent) {
      const finished = await this.settleSubflow(run, spec, contracts, scope);
      if (finished) return finished;
      // This child cannot finish yet — every other scope still advances at the root.
      return this.advance(run, spec, contracts);
    }
    // Root: advance EVERY active subflow — independent `run:` steps progress
    // concurrently; list order is never an implicit dependency. A completed
    // child transitions its parent step and re-advances the root (recursion
    // bounded by the number of run steps).
    for (const step of scope.flow.steps) {
      if (run.status !== "running") return this.response(run);
      const state = scope.steps[step.id]!;
      if (step.run === undefined || state.status !== "running" || !state.sub) continue;
      const child = this.childScope(spec, step, state);
      await this.advanceScopeLoop(run, spec, contracts, child);
      if (run.status !== "running") return this.response(run);
      const finished = await this.settleSubflow(run, spec, contracts, child);
      if (finished) return finished;
    }
    const ready = this.collectReady(run, spec);
    if (ready.length > 0) return { status: "ready", runId: run.id, ready, ledger: this.ledgerInfo(run) };
    if (scope.flow.steps.some((step) => {
      const status = scope.steps[step.id]!.status;
      return status === "running" || status === "waiting_gate";
    })) return { status: "running", runId: run.id, ledger: this.ledgerInfo(run) };
    if (scope.flow.steps.every((step) => terminal(scope.steps[step.id]!.status))) {
      const output = this.resolveFlowOutput(scope);
      const outputError = contracts[scope.flow.output.contract]?.safeParse(output);
      if (!outputError?.success) return this.failScope(run, spec, contracts, scope, outputError?.error.message ?? "flow output contract missing");
      run.output = output;
      run.status = "completed";
      this.event(run, "completed", undefined, { output });
      await this.persist(run);
      return this.response(run);
    }
    return this.failScope(run, spec, contracts, scope, "no runnable steps remain");
  }

  /** When every step of a child scope is terminal, settle it into the parent run step. */
  private async settleSubflow(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope,
  ): Promise<EngineResponse | undefined> {
    if (!scope.parent) return undefined;
    if (!scope.flow.steps.every((step) => terminal(scope.steps[step.id]!.status))) return undefined;
    const output = this.resolveFlowOutput(scope);
    const outputError = contracts[scope.flow.output.contract]?.safeParse(output);
    if (!outputError?.success) return this.failScope(run, spec, contracts, scope, outputError?.error.message ?? "flow output contract missing");
    return this.completeSubflow(run, spec, contracts, scope, output);
  }

  private async advanceScopeLoop(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope,
  ): Promise<void> {
    const flow = scope.flow;
    let changed = true;
    while (changed && run.status === "running") {
      changed = false;
      for (const step of flow.steps) {
        const state = scope.steps[step.id]!;
        if (state.status !== "pending") continue;
        if (!this.isActivated(step, scope)) {
          if (this.unreachableOnFailTarget(step, scope)) {
            state.status = "skipped";
            this.event(run, "skipped", this.scopedId(scope, step.id), { reason: "on_fail target was never routed" });
            changed = true;
            await this.persist(run);
          }
          continue;
        }
        if (!this.dependenciesDone(step, scope)) continue;
        if (step.when !== undefined) {
          let enabled: unknown;
          try { enabled = this.evaluator.evaluate(step.when, this.context(run, scope)); } catch (error) {
            await this.failScope(run, spec, contracts, scope, `when evaluation failed: ${message(error)}`);
            break;
          }
          if (enabled !== true) {
            state.status = "skipped";
            this.event(run, "skipped", this.scopedId(scope, step.id));
            changed = true;
            await this.persist(run);
            continue;
          }
        }
        if (step.set !== undefined) {
          const output: Record<string, unknown> = {};
          try {
            for (const [key, expression] of Object.entries(step.set)) output[key] = this.evaluator.evaluate(expression, this.context(run, scope));
          } catch (error) {
            await this.failScope(run, spec, contracts, scope, `set evaluation failed: ${message(error)}`);
            break;
          }
          const error = this.contractError(step, output, contracts);
          if (error) { await this.failScope(run, spec, contracts, scope, error); break; }
          // Set steps are pure: an ensure failure is deterministic, so it terminalizes.
          const setEnsure = await this.runEnsures(run, step, state, output, scope);
          if (setEnsure?.kind === "flow_budget") {
            await this.terminalBudget(run, { attempt: 0, reason: "flow budget exhausted (judged predicate)" });
            break;
          }
          if (setEnsure) { await this.failScope(run, spec, contracts, scope, setEnsure.reason); break; }
          state.status = "succeeded";
          state.output = output;
          state.attempts.push({ attempt: 1, at: now(), result: output });
          this.event(run, "result", this.scopedId(scope, step.id), { attempt: 1, result: output });
          changed = true;
          await this.persist(run);
          continue;
        }
        if (step.gate !== undefined) {
          state.status = "waiting_gate";
          this.event(run, "gate_waiting", this.scopedId(scope, step.id));
          await this.persist(run);
          changed = true;
          continue;
        }
        if (step.fanout !== undefined) {
          let items: unknown[];
          try {
            const over = this.resolveFanoutOver(step.fanout.over, run, scope);
            if (!Array.isArray(over)) throw new Error("fanout over must resolve to an array");
            items = over;
          } catch (error) {
            // Real attempt numbering — a hardcoded 1 would retry this
            // deterministic resolution failure forever.
            await this.failAttempt(run, spec, contracts, scope, step, state, state.attempts.length + 1, message(error), {});
            changed = true;
            break;
          }
          state.status = "running";
          state.fanout = {
            items: items.map((_, index) => ({ index, status: "pending", attempts: [] })),
          };
          for (const item of state.fanout.items) this.event(run, "fanout_item_ready", step.id, { itemIndex: item.index });
          await this.persist(run);
          this.scheduleFanout(run, step.id);
          // The fanout runs off the microtask queue — later independent steps
          // still activate in this same pass.
          changed = true;
          continue;
        }
        if (step.run !== undefined) {
          try {
            const callee = spec.flows[step.run];
            if (!callee || typeof callee === "string") throw new Error("subflow missing after validation");
            const input = this.renderValue(step.with ?? {}, scope);
            const parsed = this.validationFor(run).inputs[step.run]?.safeParse(input);
            if (!parsed?.success) throw new Error(parsed?.error.message ?? "subflow input contract missing");
            const steps: Record<string, StepState> = Object.create(null);
            for (const child of callee.steps) steps[child.id] = { status: "pending", attempts: [], spent: {} };
            state.sub = { input: parsed.data, steps };
            state.status = "running";
            await this.persist(run);
            // The child scope advances in the root's subflow pass — later
            // independent steps in THIS scope activate first.
            changed = true;
            continue;
          } catch (error) {
            await this.failAttempt(run, spec, contracts, scope, step, state, state.attempts.length + 1, message(error), {}, undefined, undefined, true);
            changed = true;
            break;
          }
        }
        if (step.do === undefined) {
          await this.failScope(run, spec, contracts, scope, "construct is outside P1 engine scope");
          break;
        }
        // Render BEFORE reserving: a render failure dispatches nothing, so it must not
        // debit a dispatch — and its attempt record carries no usage.
        let ready: ReadyStep;
        try {
          ready = this.readyStep(run, step, state, scope);
        } catch (error) {
          await this.failAttempt(run, spec, contracts, scope, step, state, state.attempts.length + 1, message(error), {});
          changed = true;
          break;
        }
        const debit = this.debit(run, step, state, { dispatches: 1 }, "reserve", scope);
        if (debit === "flow") { await this.terminalBudget(run, { attempt: state.attempts.length + 1, reason: "flow budget exhausted" }); break; }
        if (debit === "subflow") {
          await this.failSubflowBudget(run, spec, contracts, scope, step, state, state.attempts.length + 1, "subflow budget exhausted", {});
          changed = true;
          break;
        }
        if (debit === "task") {
          // Over-limit reservation: nothing dispatched, nothing ledgered, no usage on the record.
          await this.failAttempt(run, spec, contracts, scope, step, state, state.attempts.length + 1, "task budget exhausted", {});
          changed = true;
          break;
        }
        state.status = "ready";
        this.event(run, "ready", this.scopedId(scope, step.id), { attempt: ready.attempt });
        await this.persist(run);
        changed = true;
      }
    }
  }

  private scheduleFanout(run: PersistedRun, stepId: string): void {
    // Epoch-keyed: a revise that invalidated a live fanout must not be blocked
    // from scheduling the fresh one by the stale execution still draining.
    const key = `${run.id}:${stepId}:${run.steps[stepId]?.fanoutEpoch ?? 0}`;
    if (this.scheduledFanouts.has(key)) return;
    this.scheduledFanouts.add(key);
    // Pin SYNCHRONOUSLY with the scheduler's own run object: from here until
    // release, loadRun hands this exact instance to every entry point, so an
    // independent stepDone proceeds during a slow fanout and mutates the same
    // instance — never a divergent disk copy, never blocked behind the batch.
    this.retainRun(run.id, run);
    const scheduledFanout = run.steps[stepId]?.fanout;
    queueMicrotask(() => {
      void this.executeFanout(run, stepId).catch(async (error) => {
        // A connector/git error must become a durable flow failure, never an
        // unhandled side channel — but only while THIS execution still owns
        // the step; a revise-invalidated epoch's late error must not fail the
        // freshly reset run.
        try {
          await this.withRunLock(run.id, async () => {
            if (run.status === "running" && run.steps[stepId]?.fanout === scheduledFanout) {
              await this.terminalFailure(run, { attempt: 0, reason: `fanout execution failed: ${message(error)}` });
            }
          });
        } catch { /* persistence failure is already the terminal boundary */ }
      }).finally(() => {
        this.releaseRun(run.id);
        this.scheduledFanouts.delete(key);
      });
    });
  }

  private async executeFanout(run: PersistedRun, stepId: string): Promise<void> {
    if (run.status !== "running") return;
    const validated = this.validationFor(run);
    const flow = this.flowFor(run, validated.value);
    const step = flow.steps.find((candidate) => candidate.id === stepId);
    const state = run.steps[stepId];
    if (!step?.fanout || !state?.fanout || state.status !== "running") return;
    const values = this.resolveFanoutOver(step.fanout.over, run);
    if (!Array.isArray(values)) throw new Error("fanout over must resolve to an array");
    // Staleness token: a revise deletes/replaces state.fanout, so workers and
    // settlement compare against this exact object and abandon on mismatch.
    const fanoutRef = state.fanout;
    let next = 0;
    const workers = Array.from({ length: Math.min(step.fanout.concurrency, values.length) }, async () => {
      // `run.cancelRequested` is a cooperative brake: a background cancel stops
      // dispatching further items (the in-flight one finishes) without hard-kill.
      while (next < values.length && run.status === "running" && !run.cancelRequested && state.fanout === fanoutRef) {
        const index = next++;
        const item = fanoutRef.items[index]!;
        // A restart re-schedules the whole fanout; items that already reached a
        // terminal status must never re-dispatch (their patches are persisted).
        if (item.status === "succeeded" || item.status === "failed" || item.status === "skipped") continue;
        await this.executeFanoutItem(run, validated.value, validated.contracts, flow, step, state, item, values[index], fanoutRef);
      }
    });
    await Promise.all(workers);
    if (state.fanout !== fanoutRef) return; // invalidated mid-flight — the fresh epoch owns the step now
    // A cancelled batch must not settle (no spurious `require` failure or merge);
    // the run is left running-but-abandoned, consistent with the cancelled driver.
    if (run.cancelRequested) return;
    // Aggregation (merge, require, advance) mutates cross-step state — back
    // under the run lock like every other advancement path.
    await this.withRunLock(run.id, () => this.settleFanout(run, validated.value, validated.contracts, flow, step, state, fanoutRef));
  }

  private async settleFanout(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    flow: Flow,
    step: Step,
    state: StepState,
    fanoutRef: FanoutState,
  ): Promise<void> {
    if (run.status !== "running" || !step.fanout || state.fanout !== fanoutRef) return;
    const values = this.resolveFanoutOver(step.fanout.over, run);
    if (!Array.isArray(values)) throw new Error("fanout over must resolve to an array");
    // `require` is judged BEFORE any patch touches the parent workspace — a
    // failing batch must leave the workspace untouched, not half-merged.
    const succeeded = fanoutRef.items.filter((item) => item.status === "succeeded").length;
    const required = step.fanout.require === "all" ? values.length : step.fanout.require === "any" ? 1 : step.fanout.require;
    if (succeeded < required) {
      // `attempts` on a fanout step bounds PER-ITEM stage retries (already
      // consumed above) — an unmet `require` never re-dispatches the whole
      // batch; it takes the on_fail/terminal path directly.
      await this.failAttempt(run, spec, contracts, this.rootScope(run, spec), step, state, state.attempts.length + 1, `fanout require ${String(step.fanout.require)} not met (${succeeded}/${values.length} succeeded)`, {}, undefined, undefined, true);
      return;
    }
    if (step.fanout.isolation === "worktree") {
      try {
        await this.mergeFanoutPatches(run, step, state);
      } catch (error) {
        await this.terminalFailure(run, { attempt: state.attempts.length + 1, reason: `fanout merge failed: ${message(error)}` });
        return;
      }
    }
    state.output = fanoutRef.items.map((item) => item.status === "succeeded" ? item.output ?? null : null);
    state.status = "succeeded";
    state.attempts.push({ attempt: state.attempts.length + 1, at: now(), result: state.output });
    this.event(run, "result", step.id, { attempt: state.attempts.length, result: state.output });
    await this.persist(run);
    await this.advance(run, spec, contracts);
  }

  private async executeFanoutItem(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    flow: Flow,
    step: Step,
    state: StepState,
    item: FanoutItemState,
    value: unknown,
    fanoutRef: FanoutState,
  ): Promise<void> {
    if (!step.fanout) throw new Error("fanout missing after validation");
    // A revise can invalidate this fanout at any await point; once stale, the
    // item belongs to a dead epoch — stop recording into it (already-reserved
    // dispatch costs stay in the flow ledger: they were really spent).
    const stale = (): boolean => state.fanout !== fanoutRef;
    item.status = "running";
    let cwd = run.workspaceRoot;
    try {
      if (step.fanout.isolation === "worktree") {
        if (!cwd) throw new Error("worktree fanout requires workspaceRoot");
        const directory = await mkdtemp(join(tmpdir(), `stratum-${run.id.slice(0, 8)}-${item.index}-`));
        await rm(directory, { recursive: true, force: true });
        await execFileAsync("git", ["-C", cwd, "worktree", "add", "--detach", directory, "HEAD"]);
        item.worktree = directory;
        cwd = directory;
      }
      let previous: unknown = undefined;
      let finalStageSkipped = false;
      for (const [stageIndex, stage] of step.fanout.steps.entries()) {
        if (stale()) return;
        if (stage.when !== undefined) {
          const enabled = this.evaluateFanout(stage.when, run, value, previous, cwd);
          if (enabled !== true) {
            this.event(run, "fanout_item_skipped", step.id, { itemIndex: item.index, stage: stageIndex });
            if (stageIndex === step.fanout.steps.length - 1) finalStageSkipped = true;
            continue;
          }
        }
        let success = false;
        let lastFailure: FailureContext | undefined;
        const maximum = stage.attempts ?? step.attempts ?? 2;
        for (let stageAttempt = 1; stageAttempt <= maximum; stageAttempt += 1) {
          const attempt = item.attempts.length + 1;
          let prompt: string;
          try { prompt = this.renderFanout(stage.do, run, value, previous); }
          catch (error) { lastFailure = { attempt, reason: message(error) }; this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure); continue; }
          const reserve = this.debit(run, step, state, { dispatches: 1 }, "reserve");
          if (reserve) {
            lastFailure = { attempt, reason: `${reserve} budget exhausted` };
            this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "budget", lastFailure);
            // Flow-ledger exhaustion is TERMINAL for the run — it must never be
            // absorbed as one failed item that a tolerant `require` outweighs.
            if (reserve === "flow") await this.terminalBudget(run, lastFailure);
            break;
          }
          this.event(run, "fanout_ledger_debit", step.id, { itemIndex: item.index, amount: { dispatches: 1 } });
          this.event(run, "fanout_item_dispatched", step.id, { itemIndex: item.index, stage: stageIndex, attempt });
          // Durable BEFORE the (possibly long) connector await: a restart or a
          // fresh poller must see the dispatched lifecycle event, not a
          // pending item — the event spine is restart-proof.
          await this.persist(run);
          let result: StepResult;
          const rawContract = stage.out !== undefined ? (spec.contracts as Record<string, Record<string, unknown>>)[stage.out] : undefined;
          try {
            result = await this.connector({
              agent: stage.agent ?? "claude", prompt, ...(cwd !== undefined ? { cwd } : {}), attempt,
              ...(lastFailure ? { previousFailure: lastFailure } : {}),
              ...(rawContract !== undefined ? { outSchema: rawContract } : {}),
              sandbox: step.fanout.isolation === "worktree" ? "workspace-write" : "read-only",
            });
          }
          catch (error) {
            if (stale()) return;
            lastFailure = { attempt, reason: message(error) }; this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure); continue;
          }
          if (stale()) return;
          if (!validConnectorTelemetry(result.telemetry) || !validUsage(result.usage ?? {})) {
            lastFailure = { attempt, reason: "invalid connector telemetry or usage" };
            this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "usage", lastFailure, result);
            continue;
          }
          const usage = { ...(result.usage ?? {}) };
          const reportedDispatches = usage.dispatches !== undefined;
          delete usage.dispatches;
          const settled = this.debit(run, step, state, usage, "settle");
          if (hasBudget(usage)) this.event(run, "fanout_ledger_debit", step.id, { itemIndex: item.index, amount: usage });
          const stageStep = { ...step, do: stage.do, out: stage.out, ensure: stage.ensure, budget: step.budget } as Step;
          const contractFailure = this.contractError(stageStep, result.output, contracts);
          const failureReason = settled === "flow" ? "flow budget exhausted" : settled === "task" ? "task budget exhausted"
            : reportedDispatches ? "dispatches are engine-accounted; do not report them in usage"
              : result.failure ?? contractFailure;
          const ensure = failureReason === undefined ? await this.runEnsures(run, stageStep, state, result.output, this.rootScope(run, spec), { itemIndex: item.index, stage: stageIndex, item: value, prev: previous, ...(cwd !== undefined ? { workspaceRoot: cwd } : {}) }) : undefined;
          if (stale()) return;
          const reason = failureReason ?? (ensure?.kind === "fail" ? ensure.reason : ensure?.kind === "flow_budget" ? "flow budget exhausted" : undefined);
          if (reason !== undefined) {
            const kind = contractFailure !== undefined ? "contract"
              : reason.startsWith("ensure") ? "ensure" : settled ? "budget" : "connector";
            lastFailure = { attempt, reason };
            this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, kind, lastFailure, result, usage);
            if (ensure?.kind === "flow_budget" || settled === "flow") await this.terminalBudget(run, lastFailure);
            continue;
          }
          item.attempts.push({ attempt, at: now(), stage: stageIndex, result: result.output, ...telemetryFields(result.telemetry), ...(hasBudget(usage) ? { usage } : {}) });
          this.event(run, "fanout_attempt_result", step.id, { itemIndex: item.index, stage: stageIndex, attempt, success: true });
          previous = result.output;
          success = true;
          break;
        }
        if (!success) {
          item.status = "failed";
          item.failure = lastFailure ?? { attempt: item.attempts.length + 1, reason: "fanout stage failed" };
          return undefined;
        }
      }
      if (finalStageSkipped) {
        // The fanout output element type is the LAST stage's contract; an item
        // whose final stage was `when`-skipped has no such value — it is a
        // skipped item (null in the output array), never a success `require`
        // can count, and its partial worktree work is never merged.
        item.status = "skipped";
        return;
      }
      if (item.worktree) {
        // Include newly-created files in the patch without staging their contents.
        // Persisted on the item BEFORE it turns succeeded, so a restart between
        // item completion and merge still has every patch.
        await execFileAsync("git", ["-C", item.worktree, "add", "-N", "."]);
        // Diff against HEAD so STAGED changes are captured too — an agent that
        // ran `git add` in its worktree must not have its work silently lost.
        // Node's default 1 MiB maxBuffer would fail any item touching a large
        // or binary file; 64 MiB bounds the patch without breaking real work.
        const patch = (await execFileAsync("git", ["-C", item.worktree, "diff", "--binary", "HEAD"], { maxBuffer: 64 * 1024 * 1024 })).stdout;
        if (patch) item.patch = patch;
      }
      item.output = previous;
      item.status = "succeeded";
    } finally {
      if (item.worktree && run.workspaceRoot) {
        await execFileAsync("git", ["-C", run.workspaceRoot, "worktree", "remove", "--force", item.worktree]).catch(() => undefined);
        delete item.worktree;
      }
      await this.persist(run);
    }
  }

  private recordFanoutAttempt(run: PersistedRun, step: Step, item: FanoutItemState, stage: number, attempt: number, success: boolean, failureKind: "connector" | "usage" | "contract" | "ensure" | "iterate" | "budget", failure: FailureContext, result?: StepResult, usage?: Budget): void {
    item.attempts.push({ attempt, at: now(), stage, failure, failureKind, ...(result?.output !== undefined ? { result: result.output } : {}), ...telemetryFields(result?.telemetry), ...(usage && hasBudget(usage) ? { usage } : {}) });
    this.event(run, "fanout_attempt_result", step.id, { itemIndex: item.index, stage, attempt, success, failure: { kind: failureKind, reason: failure.reason } });
  }

  private async mergeFanoutPatches(run: PersistedRun, step: Step, state: StepState): Promise<void> {
    if (!step.fanout || !run.workspaceRoot || !state.fanout) throw new Error("worktree fanout requires workspaceRoot");
    for (const command of step.fanout.pre_merge ?? []) await execFileAsync("sh", ["-lc", command], { cwd: run.workspaceRoot });
    const pending = state.fanout.items
      .filter((item) => item.status === "succeeded" && item.patch)
      .sort((a, b) => a.index - b.index);
    for (const item of pending) {
      const patch = item.patch!;
      try {
        const patchRoot = await mkdtemp(join(tmpdir(), "stratum-merge-"));
        const patchPath = join(patchRoot, "item.patch");
        try {
          await writeFile(patchPath, patch, "utf8");
          await execFileAsync("git", ["-C", run.workspaceRoot, "apply", "--index", "--3way", patchPath]);
        } finally {
          await rm(patchRoot, { recursive: true, force: true });
        }
        this.event(run, "fanout_merge", step.id, { itemIndex: item.index, success: true });
        // Merge progress is durable per item: a restart resumes with only the
        // unapplied patches, never re-applying one that already landed. (The
        // window between `git apply` and this persist is an accepted residual.)
        delete item.patch;
        await this.persist(run);
      } catch (error) {
        this.event(run, "fanout_merge", step.id, { itemIndex: item.index, success: false, reason: message(error) });
        throw error;
      }
    }
  }

  private async failAttempt(run: PersistedRun, spec: Specification, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>, scope: ExecutionScope, step: Step, state: StepState, attempt: number, reason: string, usage: Budget, result?: unknown, telemetry?: AttemptTelemetry, forceExhausted = false): Promise<EngineResponse> {
    const previousResult = state.attempts[state.attempts.length - 1]?.result;
    const identicalEvidence = result !== undefined && previousResult !== undefined && deepEqual(result, previousResult);
    const failure = { attempt, reason: identicalEvidence ? `${reason} (no retry: identical evidence)` : reason };
    state.attempts.push({ attempt, at: now(), failure, ...(result !== undefined ? { result } : {}), ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
    state.failure = failure;
    this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure });
    const maximum = step.attempts ?? 2;
    if (!forceExhausted && !identicalEvidence && attempt < maximum) {
      state.status = "pending";
      await this.persist(run);
      return this.advance(run, spec, contracts, scope);
    }
    state.status = "failed";
    if (step.on_fail !== undefined) {
      const target = scope.steps[step.on_fail];
      if (!target) throw new Error("on_fail target missing after validation");
      target.routed = failure;
      this.event(run, "routed", this.scopedId(scope, step.id), { target: this.scopedId(scope, step.on_fail), failure });
      await this.persist(run);
      return this.advance(run, spec, contracts, scope);
    }
    if (scope.parent) return this.failParentRunStep(run, spec, contracts, scope, failure);
    return this.terminalFailure(run, failure);
  }

  private failSubflowBudget(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope,
    step: Step,
    state: StepState,
    attempt: number,
    reason: string,
    usage: Budget,
    result?: unknown,
    telemetry?: AttemptTelemetry,
  ): Promise<EngineResponse> {
    if (!scope.parent) return this.failAttempt(run, spec, contracts, scope, step, state, attempt, reason, usage, result, telemetry, true);
    const failure = { attempt, reason };
    state.attempts.push({ attempt, at: now(), failure, ...(result !== undefined ? { result } : {}), ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
    state.failure = failure;
    state.status = "failed";
    this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure });
    return this.failParentRunStep(run, spec, contracts, scope, failure);
  }

  /** Evaluates a step's ensure list in order; the first failing predicate wins. */
  private async runEnsures(run: PersistedRun, step: Step, state: StepState, output: unknown, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value), fanoutItem?: FanoutEnsureContext): Promise<EnsureOutcome> {
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
            const raw = (await this.judge(predicate.judged, { result: output, input: scope.input })) as
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
        const budgetFailure = hasBudget(usage) ? this.debit(run, step, state, usage, "settle", scope) : undefined;
        // A judged debit inside a fanout item must stay visible per item — the
        // observability contract forbids anonymous ledger movement.
        if (fanoutItem && hasBudget(usage)) {
          this.event(run, "fanout_ledger_debit", step.id, { itemIndex: fanoutItem.itemIndex, amount: usage, source: "judged" });
        }
        // Fixed audit payload — every judged evaluation events, failures included.
        this.event(run, "judged", this.scopedId(scope, step.id), {
          statement,
          holds: outcome?.holds ?? false,
          reason: outcome?.reason ?? failureReason ?? "unknown judged failure",
          // outcome fields are snapshot-normalized above — plain values, no getters.
          stakes: outcome?.stakes ?? stakes,
          model: outcome?.model ?? "none",
          usage: { tokens: usage.tokens ?? 0, usd: usage.usd ?? 0 },
          ...(fanoutItem ? { itemIndex: fanoutItem.itemIndex, stage: fanoutItem.stage } : {}),
        });
        if (budgetFailure === "flow") return { kind: "flow_budget" };
        if (budgetFailure === "subflow") return { kind: "subflow_budget", reason: "subflow budget exhausted (judged predicate)" };
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
      const verdict = this.ensurePredicate(expression, run, output, scope, fanoutItem);
      if (!verdict.holds) return { kind: "fail", reason: `ensure ${JSON.stringify(expression)} failed: ${verdict.reason}` };
    }
    return undefined;
  }

  private ensurePredicate(expression: string, run: PersistedRun, output: unknown, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value), fanoutItem?: FanoutEnsureContext): { holds: boolean; reason: string } {
    // Stage ensures evaluate with their legal item/prev bindings, and file
    // predicates jail to the ITEM's working directory (the worktree, under
    // isolation) — its files do not exist in the parent workspace until merge.
    const workspaceRoot = fanoutItem?.workspaceRoot ?? run.workspaceRoot;
    const context: EvaluatorContext = {
      ...this.context(run, scope),
      result: output,
      ...(fanoutItem ? { item: fanoutItem.item, prev: fanoutItem.prev } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
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
  private debit(run: PersistedRun, step: Step, state: StepState, usage: Budget, mode: "reserve" | "settle", scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value)): "flow" | "subflow" | "task" | undefined {
    const flowLedger = new BudgetLedger(this.flowFor(run, this.validationFor(run).value).budget, run.flowSpent);
    const subflowLedger = scope.parent ? new BudgetLedger(scope.parent.step.budget, scope.parent.state.spent) : undefined;
    const taskLedger = new BudgetLedger(step.budget, state.spent);
    const flowOk = flowLedger.canDebit(usage);
    const subflowOk = subflowLedger?.canDebit(usage) ?? true;
    const taskOk = taskLedger.canDebit(usage);
    if (mode === "settle" || (flowOk && subflowOk && taskOk)) {
      flowLedger.debit(usage);
      subflowLedger?.debit(usage);
      taskLedger.debit(usage);
      Object.assign(run.flowSpent, flowLedger.spent);
      if (subflowLedger && scope.parent) Object.assign(scope.parent.state.spent, subflowLedger.spent);
      Object.assign(state.spent, taskLedger.spent);
    }
    if (!flowOk) return "flow";
    if (!subflowOk) return "subflow";
    if (!taskOk) return "task";
    return undefined;
  }

  private unreachableOnFailTarget(step: Step, scope: ExecutionScope): boolean {
    const routers = scope.flow.steps.filter((candidate) => candidate.on_fail === step.id);
    return routers.length > 0
      && scope.steps[step.id]!.routed === undefined
      && routers.every((router) => terminal(scope.steps[router.id]!.status));
  }

  private isActivated(step: Step, scope: ExecutionScope): boolean {
    const routesHere = scope.flow.steps.some((candidate) => candidate.on_fail === step.id
      || candidate.gate?.on_approve === step.id || candidate.gate?.on_kill === step.id);
    return !routesHere || scope.steps[step.id]!.routed !== undefined;
  }

  /** Reset a revise target and its ordinary descendants; static validation proved target ancestry. */
  private resetFrom(flow: Flow, steps: Record<string, StepState>, target: string): void {
    const descendants = new Set<string>([target]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of flow.steps) {
        if (descendants.has(step.id)) continue;
        // Descendants close over the SAME forward edges the validator's
        // ancestry check walks: after/data refs, on_fail routes, and gate
        // approve/kill routes (revise is a back-edge, never forward) — a
        // revise into an on_fail/gate-routed region must clear all of it.
        const viaDependency = this.dependencies(step).some((dependency) => descendants.has(dependency));
        const viaRoute = flow.steps.some((router) => descendants.has(router.id)
          && (router.on_fail === step.id || router.gate?.on_approve === step.id || router.gate?.on_kill === step.id));
        if (viaDependency || viaRoute) {
          descendants.add(step.id);
          changed = true;
        }
      }
    }
    const gateIds = new Set(flow.steps.flatMap((step) => step.gate !== undefined ? [step.id] : []));
    for (const id of descendants) {
      const state = steps[id]!;
      state.status = "pending";
      state.attempts = [];
      state.spent = {};
      delete state.output;
      delete state.failure;
      delete state.routed;
      // A live fanout for this step must be invalidated, not just cleared:
      // the epoch bump makes in-flight workers/settlement stale (they check
      // object identity) and lets the re-activated step schedule freshly.
      state.epoch = (state.epoch ?? 0) + 1;
      if (state.fanout) state.fanoutEpoch = (state.fanoutEpoch ?? 0) + 1;
      delete state.fanout;
      delete state.sub;
      // On gates, `iterations` is the gate's REVISION counter — its max_rounds
      // cap counts total revisions for the whole run, so a revise must never
      // reset it (any gate's, target included). On tasks it is the
      // iterate-loop counter, which always restarts with the region.
      if (!gateIds.has(id)) delete state.iterations;
    }
  }

  private dependenciesDone(step: Step, scope: ExecutionScope): boolean {
    // A skipped dependency satisfies the edge (`when` is a LOCAL skip); a data ref
    // into a skipped step still fails at render time because its output is unavailable.
    return this.dependencies(step).every((id) => {
      const status = scope.steps[id]?.status;
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

  private readyStep(run: PersistedRun, step: Step, state: StepState, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value)): ReadyStep {
    if (step.do === undefined) throw new Error("not a do step");
    const attempt = state.attempts.length + 1;
    return {
      id: this.scopedId(scope, step.id), do: this.render(step.do, scope), agent: step.agent ?? "claude", attempt, epoch: state.epoch ?? 0,
      ...(state.failure ? { previousFailure: state.failure } : state.routed ? { previousFailure: state.routed } : {}),
    };
  }

  private render(value: string, scope: ExecutionScope): string {
    const references = extractReferences(value);
    if (!references) throw new Error("invalid reference after validation");
    // Rebuild from match positions in the ORIGINAL template: resolved values that
    // themselves contain `${...}` or `$&`-style text are inserted verbatim, never re-scanned.
    const parts: string[] = [];
    let cursor = 0;
    for (const extracted of references) {
      const resolved = this.resolve(extracted.reference, scope);
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

  private resolveFanoutOver(value: string, run: PersistedRun, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value)): unknown {
    const references = extractReferences(value);
    if (!references || references.length !== 1 || !references[0]!.fullValue) throw new Error("fanout over must be one full reference");
    return this.resolve(references[0]!.reference, scope);
  }

  private renderFanout(value: string, run: PersistedRun, item: unknown, previous: unknown): string {
    const references = extractReferences(value);
    if (!references) throw new Error("invalid reference after validation");
    const scope = this.rootScope(run, this.validationFor(run).value);
    const resolveReference = (reference: Reference): unknown => reference.kind === "item" ? item : reference.kind === "prev" ? previous : this.resolve(reference, scope);
    const parts: string[] = [];
    let cursor = 0;
    for (const extracted of references) {
      const resolved = resolveReference(extracted.reference);
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

  private evaluateFanout(expression: string, run: PersistedRun, item: unknown, previous: unknown, itemRoot?: string): unknown {
    // File predicates in a stage `when` see the ITEM's working directory (the
    // worktree under isolation) — same jail the stage's ensures evaluate in.
    const workspaceRoot = itemRoot ?? run.workspaceRoot;
    return this.evaluator.evaluate(expression, { ...this.context(run, this.rootScope(run, this.validationFor(run).value)), item, prev: previous, ...(workspaceRoot !== undefined ? { workspaceRoot } : {}) });
  }

  private resolveFlowOutput(scope: ExecutionScope): unknown {
    const extracted = extractReferences(scope.flow.output.from)?.[0];
    if (!extracted) throw new Error("invalid flow output reference after validation");
    return this.resolve(extracted.reference, scope);
  }

  private flowOutputError(scope: ExecutionScope, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>, completedStepId: string): string | undefined {
    const ref = extractReferences(scope.flow.output.from)?.[0]?.reference;
    if (ref?.kind !== "step" || ref.stepId !== completedStepId) return undefined;
    const parse = contracts[scope.flow.output.contract]?.safeParse(this.resolve(ref, scope));
    return parse && !parse.success ? parse.error.message : parse ? undefined : "flow output contract missing";
  }

  private contractError(step: Step, output: unknown, contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>): string | undefined {
    if (step.out === undefined) return undefined;
    const parse = contracts[step.out]?.safeParse(output);
    return parse && !parse.success ? parse.error.message : parse ? undefined : "output contract missing";
  }

  private rootScope(run: PersistedRun, spec: Specification): ExecutionScope {
    return { input: run.input, steps: run.steps, flow: this.flowFor(run, spec) };
  }

  private childScope(spec: Specification, parentStep: Step, parentState: StepState): ExecutionScope {
    if (parentStep.run === undefined || parentState.sub === undefined) throw new Error("subflow state missing");
    const flow = spec.flows[parentStep.run];
    if (!flow || typeof flow === "string") throw new Error("subflow missing after validation");
    return {
      input: parentState.sub.input,
      steps: parentState.sub.steps,
      flow,
      prefix: parentStep.id,
      parent: { step: parentStep, state: parentState },
    };
  }

  private locateStep(run: PersistedRun, spec: Specification, id: string): { scope: ExecutionScope; step: Step; state: StepState } | undefined {
    const root = this.rootScope(run, spec);
    if (!id.includes("/")) {
      const step = root.flow.steps.find((candidate) => candidate.id === id);
      const state = root.steps[id];
      return step && state ? { scope: root, step, state } : undefined;
    }
    const parts = id.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    const [parentId, childId] = parts;
    const parentStep = root.flow.steps.find((candidate) => candidate.id === parentId);
    const parentState = root.steps[parentId];
    if (!parentStep || parentStep.run === undefined || !parentState?.sub || parentState.status !== "running") return undefined;
    const scope = this.childScope(spec, parentStep, parentState);
    const step = scope.flow.steps.find((candidate) => candidate.id === childId);
    const state = scope.steps[childId];
    return step && state ? { scope, step, state } : undefined;
  }

  private collectReady(run: PersistedRun, spec: Specification): ReadyStep[] {
    const root = this.rootScope(run, spec);
    const ready = root.flow.steps.flatMap((step) => {
      const state = root.steps[step.id]!;
      return step.do !== undefined && state.status === "ready" ? [this.readyStep(run, step, state, root)] : [];
    });
    for (const parentStep of root.flow.steps) {
      const parentState = root.steps[parentStep.id];
      if (parentStep.run === undefined || parentState?.status !== "running" || !parentState.sub) continue;
      const child = this.childScope(spec, parentStep, parentState);
      for (const step of child.flow.steps) {
        const state = child.steps[step.id]!;
        if (step.do !== undefined && state.status === "ready") ready.push(this.readyStep(run, step, state, child));
      }
    }
    return ready;
  }

  /** Root gates first, then child gates in parent/child declaration order. */
  private collectWaitingGates(run: PersistedRun, spec: Specification): string[] {
    const root = this.rootScope(run, spec);
    const waiting = root.flow.steps.flatMap((step) => root.steps[step.id]!.status === "waiting_gate" ? [step.id] : []);
    for (const parentStep of root.flow.steps) {
      const parentState = root.steps[parentStep.id];
      if (parentStep.run === undefined || parentState?.status !== "running" || !parentState.sub) continue;
      const child = this.childScope(spec, parentStep, parentState);
      for (const step of child.flow.steps) {
        if (child.steps[step.id]!.status === "waiting_gate") waiting.push(this.scopedId(child, step.id));
      }
    }
    return waiting;
  }

  /** Fanout lives only at root (subflow bodies forbid it). A fanout step stays
   * `running` from dispatch until settleFanout flips it, so this is true exactly
   * while a settlement is still pending and could advance the run behind the driver. */
  private anyFanoutRunning(run: PersistedRun, spec: Specification): boolean {
    const root = this.rootScope(run, spec);
    return root.flow.steps.some((step) => step.fanout !== undefined && root.steps[step.id]!.status === "running");
  }

  private renderValue(value: unknown, scope: ExecutionScope): unknown {
    if (typeof value === "string") return this.resolveTemplate(value, scope);
    if (Array.isArray(value)) return value.map((item) => this.renderValue(item, scope));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.renderValue(item, scope)]));
    }
    return value;
  }

  private resolveTemplate(value: string, scope: ExecutionScope): unknown {
    const references = extractReferences(value);
    if (!references) throw new Error("invalid reference after validation");
    const parts: string[] = [];
    let cursor = 0;
    for (const extracted of references) {
      const resolved = this.resolve(extracted.reference, scope);
      if (resolved === undefined) throw new Error("reference output is unavailable (the source may have been skipped)");
      if (extracted.fullValue) return resolved;
      const at = value.indexOf(extracted.raw, cursor);
      if (at < 0) throw new Error("reference token missing from template");
      parts.push(value.slice(cursor, at), interpolate(resolved));
      cursor = at + extracted.raw.length;
    }
    parts.push(value.slice(cursor));
    return parts.join("");
  }

  private scopedId(scope: ExecutionScope, stepId: string): string {
    return scope.prefix ? `${scope.prefix}/${stepId}` : stepId;
  }

  private async failScope(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope,
    reason: string,
  ): Promise<EngineResponse> {
    const failure = { attempt: 0, reason };
    return scope.parent ? this.failParentRunStep(run, spec, contracts, scope, failure) : this.terminalFailure(run, failure);
  }

  private failParentRunStep(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    childScope: ExecutionScope,
    failure: FailureContext,
  ): Promise<EngineResponse> {
    if (!childScope.parent) return this.terminalFailure(run, failure);
    const root = this.rootScope(run, spec);
    const { step, state } = childScope.parent;
    return this.failAttempt(run, spec, contracts, root, step, state, state.attempts.length + 1, failure.reason, {}, undefined, undefined, true);
  }

  private async completeSubflow(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    childScope: ExecutionScope,
    output: unknown,
  ): Promise<EngineResponse> {
    if (!childScope.parent) throw new Error("cannot complete the root as a subflow");
    const root = this.rootScope(run, spec);
    const { step, state } = childScope.parent;
    const contractFailure = this.contractError(step, output, contracts);
    state.output = output;
    const flowFailure = this.flowOutputError(root, contracts, step.id);
    if (contractFailure ?? flowFailure) {
      delete state.output;
      return this.failParentRunStep(run, spec, contracts, childScope, { attempt: 1, reason: contractFailure ?? flowFailure! });
    }
    state.status = "succeeded";
    state.attempts.push({ attempt: state.attempts.length + 1, at: now(), result: output });
    this.event(run, "result", step.id, { attempt: state.attempts.length, result: output });
    await this.persist(run);
    return this.advance(run, spec, contracts, root);
  }

  private resolve(reference: Reference, scope: ExecutionScope): unknown {
    if (reference.kind === "input") return access(scope.input, reference.path);
    if (reference.kind === "step") return access(scope.steps[reference.stepId]?.output, reference.path);
    throw new Error("fanout references are outside P1 engine scope");
  }

  private context(_run: PersistedRun, scope: ExecutionScope): EvaluatorContext {
    return { input: scope.input, steps: Object.fromEntries(Object.entries(scope.steps).flatMap(([id, state]) => state.output === undefined ? [] : [[id, state.output]])) };
  }

  private validationFor(run: PersistedRun) {
    const result = validateSpec(run.spec);
    if (!result.ok) throw new Error("persisted run contains an invalid spec");
    return result;
  }

  private assertExternalMutationAllowed(runId: string, operation: "stepDone" | "commit" | "revert"): void {
    const bg = this.bgFlows.get(runId);
    if (bg !== undefined && bg.status !== "completed" && bg.status !== "failed" && bg.status !== "budget_exhausted") {
      throw new Error(`run ${runId} is background-driven; external ${operation} is not permitted (poll via flow_bg_poll)`);
    }
  }

  private async loadCheckpointRun(runId: string): Promise<PersistedRun> {
    // Parity with Python (server.py:3970-4055): commit/revert operate on ANY retained
    // run regardless of status — reverting a terminal (failed/completed) run to a good
    // checkpoint is the whole point of the recovery use case. Only an unloadable run is
    // flow_not_found.
    try {
      return await this.loadRun(runId);
    } catch {
      throw new CheckpointOperationError("flow_not_found", `No active flow with id '${runId}'`);
    }
  }

  // A foreground fanout runs its connector work OUTSIDE the run lock, then settles under
  // it — holding references to the pre-checkpoint step/fanout objects. A commit would
  // snapshot mid-flight state; a revert reassigns run.steps to a clone, orphaning those
  // objects so the worker's `state.fanout === fanoutRef` staleness check still passes and
  // it settles onto the restored state. Refuse both while a fanout is in flight (a fanout
  // step stays `running` from dispatch through settlement), the same quiescence the
  // detached driver already requires. bg-driven runs are covered by the ownership guard.
  private assertNoForegroundFanout(run: PersistedRun, operation: "commit" | "revert"): void {
    if (this.anyFanoutRunning(run, this.validationFor(run).value)) {
      throw new Error(`run ${run.id} has an in-flight fanout; ${operation} must wait for it to settle`);
    }
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

  private persist(run: PersistedRun): Promise<void> {
    const previous = this.persistLocks.get(run.id) ?? Promise.resolve();
    const result = previous.then(() => this.store.save(run));
    const tail = result.catch(() => undefined);
    this.persistLocks.set(run.id, tail);
    void tail.then(() => { if (this.persistLocks.get(run.id) === tail) this.persistLocks.delete(run.id); });
    return result;
  }
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
  // The engine's dependency edges must mirror the validator's: subflow `with`
  // templates and fanout over/stage templates reference steps too — a fanout
  // over "${prep.output.items}" must wait for prep, not fail at resolve time.
  if (step.with !== undefined) collect(step.with);
  if (step.fanout !== undefined) {
    collect(step.fanout.over);
    for (const stage of step.fanout.steps) {
      collect(stage.do);
      if (stage.when !== undefined) collect(stage.when);
    }
  }
  return values;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
}

function terminal(status: StepState["status"]): boolean { return status === "succeeded" || status === "failed" || status === "skipped"; }
function now(): string { return new Date().toISOString(); }
function delay(ms: number): Promise<void> { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
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
function validConnectorTelemetry(value: AttemptTelemetry | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["durationMs", "model", "effort"].includes(key))) return false;
  return typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0
    && typeof value.model === "string" && value.model.length > 0
    && (value.effort === undefined || (typeof value.effort === "string" && value.effort.length > 0));
}
function telemetryFields(value: AttemptTelemetry | undefined): Partial<AttemptTelemetry> {
  return value === undefined ? {} : { durationMs: value.durationMs, model: value.model, ...(value.effort !== undefined ? { effort: value.effort } : {}) };
}
function requiredFailure(run: PersistedRun): FailureContext { return run.failure ?? { attempt: 0, reason: "run failed without context" }; }
function interpolate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export const defaultConnector: EngineConnector = async ({ agent, prompt, cwd, previousFailure, outSchema, sandbox }) => {
  // The agent is TOLD the output contract and the prior failure — engine-owned
  // retries are structured feedback loops, never blind re-dispatches.
  let fullPrompt = prompt;
  if (outSchema !== undefined) {
    fullPrompt += `\n\nRespond with ONLY a minified JSON object matching this contract (field: type): ${JSON.stringify(outSchema)}. No prose, no code fences.`;
  }
  if (previousFailure !== undefined) {
    fullPrompt += `\n\nYour previous attempt failed: ${previousFailure.reason}\nCorrect the problem and try again.`;
  }
  const result = await runAgent({
    agent,
    prompt: fullPrompt,
    ...(cwd !== undefined ? { cwd } : {}),
    // Worktree-isolated stages must be able to edit their worktree.
    ...(agent === "codex" && sandbox !== undefined ? { sandboxMode: sandbox } : {}),
  });
  if ("status" in result) return { failure: "background connector response is not valid for synchronous fanout" };
  if (outSchema === undefined) return { output: result.text, usage: result.usage, telemetry: result.telemetry };
  try {
    return { output: JSON.parse(stripJsonFences(result.text)), usage: result.usage, telemetry: result.telemetry };
  } catch {
    return { failure: "connector result must be JSON for a contract-enforced fanout stage", usage: result.usage, telemetry: result.telemetry };
  }
};

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}
