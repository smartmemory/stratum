import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runAgent } from "../connectors/runner.js";
import { processIdentity } from "../connectors/proc_identity.js";
import { procStartTime } from "../connectors/proc_identity.js";
import { extractReferences, type ExtractedReference, type PathSegment, type Reference } from "../ir/refs.js";
import { type Flow, type Specification, type Step } from "../ir/schema.js";
import { type ValidationError, validateSpec } from "../ir/validate.js";
import { LearnEgress, type LearnEgressDriver, type LearnEgressRuntimeOptions } from "../learn/smartmemory_egress.js";
import { mergeBundleIntoSpec, policyRuleKey, predicateType, validateBundle } from "../policy/bundle.js";
import { buildFlowTerminalEvent, buildGateResolutionEvent } from "../policy/events.js";
import { emitPolicyEvent as postPolicyEvent } from "../policy/smartmemory_client.js";
import type { EnforcementEvent, PolicyBundle, RuleVerdict } from "../policy/types.js";
import { BUDGET_KEYS, BudgetLedger, type Budget, validConnectorTelemetry, validUsage } from "./ledger.js";
import { commitCheckpoint, revertCheckpoint } from "./checkpoint.js";
import { acquireRunLock, cancelLockWaitMs, readDriverLeaseSync, releaseDriverLeaseSync, writeDriverLeaseSync, type RunLockOptions } from "./run_lock.js";
import { buildReceipt, findReceipt, ReceiptValidationError, spineSpent, type ReceiptInput } from "./receipts.js";
import { assertRunId, type AttemptRecord, type AttemptTelemetry, type AuditEvent, burnIssuances, type CarryEntry, type CarryProvenance, type FailureContext, type FanoutItemState, type FanoutState, type PersistedRun, type ReceiptRecord, type RunStatus, StateStore, type StepState } from "./state.js";

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

/**
 * The fixed shape every S1 `evaluate:` step must return. Engine-owned and
 * strict — an author's `out` contract governs what is *referenceable*, this
 * schema governs what the data must *be*. It is the trust anchor: a transport
 * failure can never be laundered into a `closed` verdict, and the cross-field
 * invariants (`closed` ⇒ no children, `open` ⇒ ≥1 child) are enforced here.
 */
export const evaluatorResultSchema = z.object({
  status: z.enum(["closed", "open", "failed"]),
  children: z.array(z.unknown()),
  reason: z.string(),
  score: z.number().optional(),
  route: z.enum(["claude", "codex"]).optional(),
}).strict().superRefine((result, ctx) => {
  if (result.status === "closed" && result.children.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children"], message: "a closed verdict must carry no children" });
  }
  if (result.status === "open" && result.children.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["children"], message: "an open verdict must carry at least one child" });
  }
});
export type EvaluatorResult = z.infer<typeof evaluatorResultSchema>;

/** Transport outcome of one evaluate invocation, distinct from the domain verdict it may carry. */
export type EvaluateRunResult =
  | { ok: true; result: unknown }
  | { ok: false; kind: "exit" | "timeout" | "parse"; reason: string };

/**
 * The engine validates the runner's ENVELOPE at runtime, not just the verdict
 * inside it — the `ok` discriminant is the runner's word for whether it even
 * succeeded, and a malformed envelope must never let a `{status:"closed"}`
 * payload reach the success path. Same trust posture as the judge verdict.
 */
const evaluateRunResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), kind: z.enum(["exit", "timeout", "parse"]), reason: z.string() }),
]);

/**
 * Runner for `evaluate:` steps. Invoked BY THE ENGINE, never by an agent — a
 * proof system that takes an agent's word for whether it proved something is
 * not a proof system. Absent = evaluate steps fail closed.
 */
export type EvaluateRunner = (
  invocation: { command: string; input: unknown; timeoutMs: number },
  context: { workspaceRoot?: string },
) => Promise<EvaluateRunResult>;

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
  /** Root-flow loop-carried values (D5). Populated by rootScope only; childScope
   *  deliberately leaves it undefined so a subflow can never read carry even if a
   *  future validation change let it try. */
  carry?: Record<string, CarryEntry> | undefined;
  flow: Flow;
  flowName: string;
  prefix?: string;
  parent?: { step: Step; state: StepState };
}

/** Result of one `materialiseCarry` pass. It never throws: `failed` is turned into a
 *  `failScope` transition by the caller, so a partial write can never be persisted (R2-5). */
type CarryMaterialisation =
  | { kind: "unchanged" }
  | { kind: "written" }
  | { kind: "failed"; reason: string };

interface LocatedStep {
  scope: ExecutionScope;
  step: Step;
  state: StepState;
  item?: FanoutItemState;
}

export interface StepResult {
  output?: unknown;
  failure?: string;
  /** Post-dispatch consumption (usd/tokens/ms). `dispatches` is engine-accounted and rejected here. */
  usage?: Budget;
  /** Connector-owned wall time and resolved execution identity. */
  telemetry?: AttemptTelemetry;
  /** Provenance of usage.usd when the connector reported a provider price (ConnectorResult.usdSource). */
  usdSource?: "reported" | "estimated";
  /** Input/output token detail preserved beside the Budget-shaped usage (ConnectorResult.split). */
  split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
}

export interface ReadyStep {
  id: string;
  do: string;
  agent: "claude" | "codex";
  attempt: number;
  epoch: number;
  dispatchToken: string;
  previousFailure?: FailureContext;
}

export interface ConsumerDispatchDescriptor extends ReadyStep {
  flow: string;
  step: string;
  stage: number;
  isFinalStage: boolean;
  itemIndex: number;
  /** The resolved fanout element for this item. Computed from `over`, never persisted:
   *  the carried list can only change at a gate that runs after the fanout settles, and
   *  that revise resets the fanout, so no in-flight item can observe a rewritten list. */
  item: unknown;
  generation: number;
  contract: { root: string; contracts: Record<string, Record<string, string>> } | null;
  contractDigest: string | null;
  policy: {
    isolation: "worktree" | "none";
    merge: "sequential";
    pre_merge: string[];
  };
  revisionDigest: string;
}

export type ReadyEntry = ReadyStep | ConsumerDispatchDescriptor;

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

export type UsageReportResponse =
  | { status: "ok"; runId: string; seq: number; budget?: "flow_exhausted" | "flow_exhausted_after_terminal" | "subflow_exhausted" | "task_exhausted"; ledger: LedgerInfo }
  | { status: "duplicate"; runId: string; seq: number; ledger: LedgerInfo };

export type EngineResponse =
  | { status: "ready"; runId: string; ready: ReadyEntry[]; ledger: LedgerInfo }
  | { status: "completed"; runId: string; output: unknown; ledger: LedgerInfo }
  | { status: "failed"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "budget_exhausted"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "running"; runId: string; ledger: LedgerInfo }
  // D3: NO `failure` on the cancelled variant. The status is honest, so a fabricated
  // FailureContext would put a lie in the audit trail.
  | { status: "cancelled"; runId: string; ledger: LedgerInfo };

export type RevisionedEngineResponse = EngineResponse & { revisionDigest: string };

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

/** The engine half of a foreground cancel.
 *
 *  `flowSettled` is true when the run is durably `cancelled` — either because THIS call moved
 *  it there, or because it already was. It is the flow-side fact, and it is deliberately
 *  separate from the caller-facing `acknowledged`, which additionally requires every agent
 *  claimed for the flow to be reaped or durably settled and is computed by `cancelFlow`.
 *
 *  `status` is the run's REAL status: `cancelled` after a settle, or the pre-existing terminal
 *  status when the cancel arrived too late. `reason` carries `already_<status>` in that case. */
export interface FlowCancelResult {
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  /** True only when this call performed the settle. */
  settledByThisCall: boolean;
  reason?: string;
  ledger: LedgerInfo;
}

export interface AuditTrail {
  runId: string;
  status: PersistedRun["status"];
  events: AuditEvent[];
  steps: Record<string, StepState>;
  flowSpent: Budget;
  output?: unknown;
  carry?: Record<string, CarryEntry>;
}

export interface StratumEngineOptions {
  stateRoot?: string;
  evaluator: Evaluator;
  /** Runner for `judged:` ensure predicates. Absent = judged predicates fail closed. */
  judge?: JudgeRunner;
  /** Runner for `evaluate:` steps. Absent = evaluate steps fail closed. */
  evaluateRunner?: EvaluateRunner;
  /** Engine-owned P4 dispatch seam. Defaults to the P3 connector runner. */
  connector?: EngineConnector;
  /** Test seam for receipt delivery. Production constructs LearnEgress from process.env. */
  learnEgress?: LearnEgressDriver;
  /** Runtime seams for the real LearnEgress driver. */
  learnEgressOptions?: LearnEgressRuntimeOptions;
  /** Cross-process run-lock seams (timeouts, identity oracle). Tests inject here. */
  lockOptions?: RunLockOptions;
  /** Test seams for the pin transaction. `beforePin` runs after a candidate run is enumerated
   *  and BEFORE its locked load/pin/lease/launch section, which is the only place a competing
   *  cancel can legitimately land. */
  hooks?: { beforePin?: (runId: string) => Promise<void> };
}

export interface PlanOptions {
  /** Root directory that file predicates (file_exists / file_contains) are jailed to. */
  workspaceRoot?: string;
  policyBundle?: PolicyBundle;
  /** Optional caller-side narrowing glob for policy ensure-rule bindings. */
  policyStepSelector?: string;
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
  readonly errorType: "flow_not_found" | "invalid_label" | "checkpoint_not_found" | "flow_cancelled";
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

export class InputValidationError extends SpecValidationError {
  constructor(errors: ValidationError[]) { super(errors); this.message = "entry input validation failed"; }
}

export class StratumEngine {
  private readonly store: StateStore;
  private readonly evaluator: Evaluator;
  private readonly judge?: JudgeRunner;
  private readonly evaluateRunner?: EvaluateRunner;
  private readonly connector: EngineConnector;
  private readonly learnEgress: LearnEgressDriver;
  private readonly learnEgressStartup: Promise<void>;
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
  // Run ids whose cross-process file lock this engine currently holds. `persist` asserts
  // membership: every write to a run record happens inside a locked section, and this
  // assertion is what makes that claim checkable rather than a comment.
  private readonly heldLocks = new Set<string>();
  // Driver-lease tokens for the runs this engine has pinned (R4-4). A lease naming another
  // LIVE process means that process owns the in-memory copy of the run, and a cancel from
  // here is refused rather than raced.
  private readonly driverLeases = new Map<string, string>();
  private readonly lockOptions: RunLockOptions;
  private readonly hooks: NonNullable<StratumEngineOptions["hooks"]>;
  private readonly identity: (pid: number, startTime: string) => Promise<"alive" | "dead" | "unknown">;
  private selfStartTime?: string;
  private readonly selfIdentityReady: Promise<void>;

  constructor(options: StratumEngineOptions) {
    this.store = new StateStore(options.stateRoot);
    this.lockOptions = options.lockOptions ?? {};
    this.hooks = options.hooks ?? {};
    this.identity = this.lockOptions.identity ?? processIdentity;
    this.selfIdentityReady = (this.lockOptions.selfStartTime ?? (() => procStartTime(process.pid)))()
      .then((value) => { if (value !== undefined) this.selfStartTime = value; })
      .catch(() => undefined);
    this.evaluator = options.evaluator;
    if (options.judge) this.judge = options.judge;
    if (options.evaluateRunner) this.evaluateRunner = options.evaluateRunner;
    this.connector = options.connector ?? defaultConnector;
    this.learnEgress = options.learnEgress ?? new LearnEgress({
      ...options.learnEgressOptions,
      store: this.store,
      withReceiptUpdate: (runId, update) => this.withReceiptUpdate(runId, update),
      // F3: a drain snapshot is a READ. Routed through the update path it re-persisted the
      // record, and on a cancelled run that meant the guard above rejected a call that was
      // never going to write anything.
      withReceiptRead: (runId, read) => this.withRunLock(runId, async () => read(await this.loadRun(runId))),
    });
    this.learnEgressStartup = this.learnEgress.enabled()
      ? this.learnEgress.drainAll().catch((error) => {
        console.warn(`SmartMemory egress startup reconciliation failed: ${message(error)}`);
      })
      : Promise.resolve();
  }

  private async loadRun(runId: string): Promise<PersistedRun> {
    const active = this.activeRuns.get(runId);
    if (active) return active.run;
    return this.store.load(runId);
  }

  /** Pinning is SYNCHRONOUS by design (see scheduleFanout), so the lease it declares is
   *  written synchronously too — a deferred async write would leave a window in which a
   *  pinned run looks unowned to a second process. */
  private retainRun(runId: string, run: PersistedRun): void {
    const active = this.activeRuns.get(runId);
    if (active) { active.refs += 1; return; }
    // An UNLEASED pin is the exact state the lease exists to make impossible: this process
    // holds the run's in-memory object, and nothing on disk says so, so a second process reads
    // "unowned", cancels against its own copy, and the two diverge. Refusing to pin is the
    // only safe answer to "we cannot declare ownership" — the previous `return` pinned anyway.
    if (this.selfStartTime === undefined) {
      throw Object.assign(
        new Error(`cannot establish process identity; run ${runId} cannot be pinned`),
        { code: "RUN_LOCK_IDENTITY_UNAVAILABLE" },
      );
    }
    // Lease FIRST, then register the pin: a throwing claim must leave no pin behind. The error
    // propagates — a swallowed one produced precisely the unleased pin above, and reported
    // success while doing it.
    //
    // The token we already hold for this run is passed so `writeDriverLeaseSync` can tell OUR
    // leftover from a live sibling's lease. Identity alone cannot: two engines in one process
    // share a pid and a start time, so the old same-identity reclaim let the second one delete
    // the first's live lease and drive the same run (F1).
    const token = writeDriverLeaseSync(this.store.root, runId, this.selfStartTime, this.driverLeases.get(runId));
    this.activeRuns.set(runId, { run, refs: 1 });
    this.driverLeases.set(runId, token);
  }

  /** Resolve any INCUMBENT driver lease, immediately before a pin claims one (R4-4).
   *
   *  `writeDriverLeaseSync` now claims with `link()` and refuses to overwrite, so the identity
   *  question has to be ANSWERED rather than papered over by a `rename()`. It is answered here
   *  because it is async — a probe of another process — while `retainRun` is synchronous by
   *  design. Every async pin site runs this inside its own locked section, so the answer cannot
   *  go stale between the probe and the claim. */
  private async prepareLease(runId: string): Promise<void> {
    const lease = readDriverLeaseSync(this.store.root, runId);
    if (lease === undefined) return;
    if (this.driverLeases.get(runId) === lease.token) return;                        // ours, by TOKEN
    // There is deliberately no "same pid and start time, therefore ours" arm here (F1). Two
    // engine instances in one process answer that test identically, so it let the second one
    // reclaim a lease the first was actively driving. A same-identity lease whose token we do
    // not hold is a LIVE lease, and the probe below says so.
    const state = await this.identity(lease.pid, lease.startTime);
    if (state === "dead") { releaseDriverLeaseSync(this.store.root, runId, lease.token); return; }
    throw Object.assign(
      new Error(`run ${runId} is driven by pid ${lease.pid}; it cannot be pinned from this process`),
      { code: "DRIVER_LEASE_HELD", holderPid: lease.pid },
    );
  }

  private releaseRun(runId: string): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.refs -= 1;
    if (active.refs > 0) return;
    this.activeRuns.delete(runId);
    const token = this.driverLeases.get(runId);
    if (token === undefined) return;
    // Reached from `finally` blocks, so it must not throw — but it must not go quiet either:
    // a lease left behind wedges every other process off this run.
    //
    // The token is forgotten only once the release has actually SUCCEEDED (F5). Deleting it
    // first meant a transient unlink failure left a lease on disk that this engine no longer
    // recognised: `prepareLease` and `claimDriverLease` compare by token, so their own leftover
    // read back as a live foreign lease naming this very pid, and the run became unpinnable and
    // uncancellable from the one process that owned it. Retaining it keeps the reclaim path open.
    try {
      releaseDriverLeaseSync(this.store.root, runId, token);
      this.driverLeases.delete(runId);
    } catch (error) { process.stderr.write(`stratum: unable to release driver lease for ${runId}: ${message(error)}\n`); }
  }

  /** The in-process promise chain still serialises same-process callers cheaply; the file
   *  lock is what makes the exclusion cross-process. */
  private withRunLock<T>(runId: string, action: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    assertRunId(runId);
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const result = previous.then(async () => {
      await this.selfIdentityReady;
      // The cached identity, not a fresh probe: `procStartTime` shells out to python/ps on
      // darwin, and every locked section on the hot path would otherwise pay for it again.
      const release = await acquireRunLock(this.store.root, runId, {
        ...this.lockOptions, ...options, selfStartTime: () => Promise.resolve(this.selfStartTime),
      });
      this.heldLocks.add(runId);
      try {
        return await action();
      } finally {
        this.heldLocks.delete(runId);
        await release();
      }
    });
    const tail = result.catch(() => undefined);
    this.runLocks.set(runId, tail);
    void tail.then(() => {
      if (this.runLocks.get(runId) === tail) this.runLocks.delete(runId);
    });
    return result;
  }

  async withReceiptUpdate<T>(
    runId: string,
    update: (run: PersistedRun) => T | Promise<T>,
  ): Promise<T> {
    return this.withRunLock(runId, async () => {
      const run = await this.loadRun(runId);
      // Same reason as `usageReport`: refuse BEFORE `update` touches the shared object, not
      // after, at the persist. The run object is pinned and shared, so a mutation applied and
      // then rejected is a mutation the rest of the engine can still see.
      if (run.status === "cancelled" || run.cancelRequested === true) {
        throw Object.assign(
          new Error(`run ${runId} is cancelled; no further receipt updates are accepted`),
          { code: "PERSIST_ON_CANCELLED_RUN" },
        );
      }
      const result = await update(run);
      await this.persist(run);
      return result;
    });
  }

  async closeLearnEgress(): Promise<void> {
    await this.learnEgressStartup;
    await this.learnEgress.close();
  }

  async plan(specInput: unknown, input: unknown, options: PlanOptions = {}): Promise<RevisionedEngineResponse> {
    const validation = validateSpec(specInput);
    if (!validation.ok) throw new SpecValidationError(validation.errors);
    let effectiveSpec = validation.value;
    let policyFields: Pick<PersistedRun, "bundle_id" | "policy_rules" | "policy_rules_version" | "policy_verdicts"> = {};
    if (options.policyBundle !== undefined) {
      const bundle = validateBundle(options.policyBundle);
      const merged = mergeBundleIntoSpec(effectiveSpec, bundle, options.policyStepSelector);
      effectiveSpec = merged.spec;
      policyFields = { bundle_id: merged.bundle_id, policy_rules: merged.policy_rules, policy_rules_version: 2, policy_verdicts: [] };
      const policyBindings = Object.values(merged.policy_rules).flat();
      const ruleCount = new Set(policyBindings.map((binding) => binding.rule_id)).size;
      console.warn(`policy bundle ${merged.bundle_id}: ${ruleCount} rules bound to ${policyBindings.length} step-predicate pairs`);
      if (bundle.rules.some((rule) => rule.bind.kind === "ensure" && rule.on_fail === "gate")) {
        console.warn("ensure policy rule on_fail=gate is enforced as refuse in P1; gate routing is deferred to P3");
      }
    }
    // Validate the policy-merged specification and entry input before allocating
    // or persisting a run. A rejected request must never dispatch work.
    const effectiveValidation = validateSpec(effectiveSpec);
    if (!effectiveValidation.ok) throw new SpecValidationError(effectiveValidation.errors);
    effectiveSpec = effectiveValidation.value;
    const flowName = effectiveSpec.flows.entry;
    const parsedInput = effectiveValidation.inputs[flowName]?.safeParse(input);
    if (!parsedInput) throw new Error("entry flow input contract missing after validation");
    if (!parsedInput.success) {
      throw new InputValidationError(parsedInput.error.issues.map((issue) => ({
        code: "INPUT_CONTRACT_INVALID",
        path: ["input", ...issue.path].map((part, index) => typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`).join(""),
        message: issue.message,
      })));
    }
    const flow = effectiveSpec.flows[flowName];
    if (!flow) throw new Error("entry flow missing after validation");
    const steps: Record<string, StepState> = Object.create(null);
    for (const step of flow.steps) steps[step.id] = { status: "pending", attempts: [], spent: {} };
    const run: PersistedRun = {
      id: randomUUID(), spec: effectiveSpec, revisionDigest: digest(effectiveSpec), generationCounter: 0,
      input: parsedInput.data, flowName, status: "running", flowSpent: {}, steps,
      events: [{ at: now(), type: "planned" }],
      ...policyFields,
      // Canonicalize at plan time: a relative root must never re-resolve against a
      // different process cwd after restart.
      ...(options.workspaceRoot !== undefined ? { workspaceRoot: resolve(options.workspaceRoot) } : {}),
    };
    // R3-3a: the initial persist AND the first advance are inside the lock. The run id is
    // minted above, and acquireRunLock mkdir -p's the state root, so the lock may legitimately
    // precede the run file's existence. The advance must be inside too: it is what issues the
    // first dispatch tokens.
    return this.withRunLock(run.id, async () => {
      await this.persist(run);
      return this.withRevisionDigest(await this.advance(run, effectiveValidation.value, effectiveValidation.contracts), run);
    });
  }

  async flowRunBg(specInput: unknown, input: unknown, options: PlanOptions = {}): Promise<{ runId: string; status: "running" }> {
    const validation = validateSpec(specInput);
    if (!validation.ok) throw new SpecValidationError(validation.errors);
    for (const [flowName, flow] of Object.entries(validation.value.flows)) {
      if (flowName === "entry" || typeof flow === "string") continue;
      for (const [index, step] of flow.steps.entries()) {
        if (step.fanout?.dispatch !== "consumer") continue;
        throw new SpecValidationError([{
          code: "consumer_dispatch_bg_unsupported",
          path: `flows.${flowName}.steps[${index}].fanout.dispatch`,
          message: "consumer fanout dispatch is not supported for background flows",
        }]);
      }
    }
    const first = await this.plan(validation.value, input, options);
    await this.hooks.beforePin?.(first.runId);
    // ONE locked transaction: load, mark, claim the lease, pin, launch. Splitting it — as this
    // did, pinning after the lock was released — leaves a window in which the run is loaded,
    // unpinned and unleased, so a cancel from anywhere settles it durably and the driver then
    // pins the stale object it loaded before that and writes `running` back over the settle.
    // The launch is INSIDE too: `driveBg` is not awaited, and its own first `withRunLock`
    // queues behind this section, so it observes whatever the durable record says afterwards.
    await this.withRunLock(first.runId, async () => {
      const current = await this.loadRun(first.runId);
      // OWNERSHIP BEFORE BOOKKEEPING (F2). The durable `bgDriven` mark used to be written
      // first, so a lease this process could not claim left the run marked as driven by a
      // driver that never started — a run rehydrated on the next boot as a live bg flow with
      // nothing behind it. Nothing is mutated until the lease and the pin are both held, and
      // anything that fails after them is rolled back here.
      await this.prepareLease(first.runId);
      this.retainRun(first.runId, current);
      const bg: BgFlowState = { status: "running", cancelRequested: false, pendingGates: [] };
      this.bgFlows.set(first.runId, bg);
      try {
        current.bgDriven = true;
        await this.persist(current);
      } catch (error) {
        delete current.bgDriven;
        this.bgFlows.delete(first.runId);
        this.releaseRun(first.runId);
        throw error;
      }
      const loop = this.driveBg(first.runId, first);
      bg.loop = loop;
      void loop.finally(() => {
        this.releaseRun(first.runId);
        if (bg.loop === loop) delete bg.loop;
      });
    });
    return { runId: first.runId, status: "running" };
  }

  async rehydrateBgFlows(): Promise<void> {
    // The pins below are synchronous and write a driver lease, which needs this process's
    // identity resolved first.
    await this.selfIdentityReady;
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
      // read (driveBg re-derives it).
      //
      // The load above is only a FILTER. Everything that decides ownership — the
      // authoritative re-load, the lease claim, the pin and the launch — happens inside one
      // locked section below, because the scan is long and a cancel that lands during it must
      // be observed rather than overwritten by a driver pinning a pre-cancel snapshot.
      //
      // AT-LEAST-ONCE across restart: an in-flight connector was durable as `ready`,
      // so the driver re-dispatches it — a step may run twice, and that second
      // physical dispatch is NOT re-ledgered (a dispatch budget may under-count by the
      // in-flight-at-crash count). Callers doing writes must be idempotent. A worktree
      // fanout merge retains its pre-existing crash window (accepted residual).
      await this.hooks.beforePin?.(run.id);
      try {
        await this.withRunLock(run.id, async () => {
          const current = await this.store.load(run.id);
          // Re-read under the lock: `current`, not the snapshot the scan filtered on.
          if (!current.bgDriven || this.bgFlows.has(current.id)) return;
          if (current.status !== "running") {
            this.bgFlows.set(current.id, { status: current.status, cancelRequested: false, pendingGates: [] });
            return;
          }
          if (current.cancelRequested === true) {
            this.bgFlows.set(current.id, { status: "cancelled", cancelRequested: true, pendingGates: [] });
            return;
          }
          // Lease and pin BEFORE the `bgFlows` insert (F2): a failing lease write used to leave
          // a `running` entry naming a driver that never launched, and every later poll and
          // cancel read that entry as a live loop in this process.
          await this.prepareLease(current.id);
          this.retainRun(current.id, current);
          const bg: BgFlowState = { status: "running", cancelRequested: false, pendingGates: [] };
          this.bgFlows.set(current.id, bg);
          let loop: Promise<void>;
          try { loop = this.driveBg(current.id, { status: "running", runId: current.id, ledger: { spent: {} } }); }
          catch (error) { this.bgFlows.delete(current.id); this.releaseRun(current.id); throw error; }
          bg.loop = loop;
          void loop.finally(() => {
            this.releaseRun(current.id);
            if (bg.loop === loop) delete bg.loop;
          });
        });
      } catch (error) {
        // A live lease elsewhere means another process owns this run: leave it alone rather
        // than aborting the whole scan. Everything else is equally per-run.
        process.stderr.write(`stratum: not rehydrating flow '${run.id}': ${message(error)}\n`);
      }
    }
  }

  async stepDone(runId: string, stepId: string, result: StepResult, dispatchToken: string): Promise<EngineResponse> {
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
    return this.stepDoneOwned(runId, stepId, result, undefined, dispatchToken);
  }

  /** Lock-wrapped stepDone used by the bg driver itself, bypassing the
   * sole-mutator guard on the public entry point. */
  private stepDoneOwned(runId: string, stepId: string, result: StepResult, expectedEpoch?: number, dispatchToken?: string): Promise<EngineResponse> {
    return this.withRunLock(runId, () => this.stepDoneLocked(runId, stepId, result, expectedEpoch, dispatchToken));
  }

  private async stepDoneLocked(runId: string, stepId: string, result: StepResult, expectedEpoch?: number, dispatchToken?: string): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    if (run.cancelRequested === true) throw new Error(`run ${runId} is cancelled; outstanding step issuances cannot be resolved`);
    const validated = this.validationFor(run);
    const located = this.locateStep(run, validated.value, stepId);
    const scope = located?.scope;
    const step = located?.step;
    const state = located?.state;
    if (located?.item !== undefined) {
      if (!scope || !step || !state || run.status !== "running") throw new Error("step is not awaiting a client result");
      return this.consumerFanoutStepDone(run, validated.value, validated.contracts, scope.flow, step, state, located.item, result, expectedEpoch, dispatchToken);
    }
    if (!step || !state || step.do === undefined || state.status !== "ready" || run.status !== "running") {
      throw new Error("step is not awaiting a client result");
    }
    if (!scope) throw new Error("step scope missing after lookup");
    if (expectedEpoch !== undefined && (state.epoch ?? 0) !== expectedEpoch) {
      throw new Error("step result is stale: dispatched for a superseded epoch");
    }
    if (dispatchToken === undefined) {
      throw new Error("step result is stale: missing dispatch token");
    }
    if (state.dispatchToken !== dispatchToken) {
      throw new Error("step result is stale: dispatched for a superseded issuance");
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
    const budgetFailure = hasBudget(usage)
      ? this.settleLegacyReceipt(run, usage, "step_done", telemetry, { scope, step, state }, result.usdSource, result.split)
      : undefined;
    if (budgetFailure === "flow") {
      const failure = { attempt, reason: "flow budget exhausted" };
      state.attempts.push({ attempt, at: now(), failure, ...telemetryFields(telemetry), ...(hasBudget(usage) ? { usage } : {}) });
      state.status = "failed";
      state.failure = failure;
      delete state.dispatchToken;
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
      delete state.dispatchToken;
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
        delete state.dispatchToken;
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
    if (state.dispatchToken !== undefined) state.acceptedDispatchToken = state.dispatchToken;
    delete state.dispatchToken;
    await this.persist(run);
    return this.advance(run, validated.value, validated.contracts, scope);
  }

  async usageReport(runId: string, input: unknown): Promise<UsageReportResponse> {
    return this.withRunLock(runId, async () => {
      if (typeof input === "object" && input !== null && (input as { usdSource?: unknown }).usdSource === "legacy") {
        throw new ReceiptValidationError('usdSource "legacy" is reserved for engine-synthesized receipts');
      }
      const run = await this.loadRun(runId);
      // R4-1 BEFORE duplicate detection and before any mutation. `persist` refuses a cancelled
      // record, but by the time it does, this method has already advanced `receiptCounter`,
      // debited the ledger and appended the receipt and its events to the in-memory object the
      // rest of the engine shares — so the throw leaves the pinned run mutated, and an
      // automatic retry finds its own receipt, takes the duplicate branch, and reports SUCCESS
      // for a receipt that was never durably recorded.
      if (run.status === "cancelled" || run.cancelRequested === true) {
        throw Object.assign(
          new Error(`run ${runId} is cancelled; no further receipts are accepted`),
          { code: "PERSIST_ON_CANCELLED_RUN" },
        );
      }
      const candidate = input as Partial<ReceiptInput> | null;
      if (typeof input !== "object" || input === null || Array.isArray(input)
        || typeof candidate?.dispatchId !== "string" || candidate.dispatchId.length === 0) {
        throw new ReceiptValidationError("dispatchId must be a non-empty string");
      }
      if (candidate.dispatchId.startsWith("legacy:")) {
        throw new ReceiptValidationError('dispatchId prefix "legacy:" is reserved for engine-synthesized receipts');
      }
      if (candidate.dispatchId.startsWith("engine:")) {
        throw new ReceiptValidationError('dispatchId prefix "engine:" is reserved for engine-synthesized receipts');
      }
      const duplicate = findReceipt(run, candidate.dispatchId);
      if (duplicate !== undefined) {
        return { status: "duplicate", runId: run.id, seq: duplicate.seq, ledger: this.ledgerInfo(run) };
      }

      // Validate and allocate against a staging copy so a rejected receipt cannot
      // advance the live counter (important while an active fanout pins the run object).
      const staged = { ...run };
      const receipt = buildReceipt(staged, input as ReceiptInput);
      const located = receipt.stepId === undefined
        ? undefined
        : this.locateReceiptStep(run, this.validationFor(run).value, receipt.stepId);
      if (receipt.stepId !== undefined && located === undefined) {
        throw new ReceiptValidationError(`receipt step ${JSON.stringify(receipt.stepId)} does not exist`, "invalid_step");
      }
      run.receiptCounter = receipt.seq;

      const wasRunning = run.status === "running";
      const settled = this.settleReceipt(run, receipt, located);
      if (settled.status === "duplicate") {
        return { status: "duplicate", runId: run.id, seq: settled.receipt.seq, ledger: this.ledgerInfo(run) };
      }

      let budget: "flow_exhausted" | "flow_exhausted_after_terminal" | "subflow_exhausted" | "task_exhausted" | undefined;
      if (settled.budget === "flow") {
        budget = wasRunning ? "flow_exhausted" : "flow_exhausted_after_terminal";
        if (wasRunning) {
          const attempt = located?.item?.attempts.length ?? located?.state.attempts.length ?? 0;
          await this.terminalBudget(run, { attempt: attempt + 1, reason: "flow budget exhausted" });
        } else {
          await this.persist(run);
        }
      } else {
        if (settled.budget === "subflow") budget = "subflow_exhausted";
        if (settled.budget === "task") budget = "task_exhausted";
        await this.persist(run);
      }
      return {
        status: "ok",
        runId: run.id,
        seq: receipt.seq,
        ...(budget !== undefined ? { budget } : {}),
        ledger: this.ledgerInfo(run),
      };
    });
  }

  async commit(runId: string, label: string): Promise<CommitResponse> {
    this.assertExternalMutationAllowed(runId, "commit");
    return await this.withRunLock(runId, async () => {
      const run = await this.loadCheckpointRun(runId);
      this.assertCancelledCheckpointRefusal(run, "commit");
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
      this.assertCancelledCheckpointRefusal(run, "revert");
      this.assertNoForegroundFanout(run, "revert");
      const normalized = label.trim();
      // Money spent is spent: a revert restores state, never spend. Capture the live
      // cumulative total before the snapshot overwrites it.
      const liveSpentBeforeRevert: Budget = { ...run.flowSpent };
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
      const receiptsAtRevert = run.receiptCounter ?? 0;
      const stepsRestored = Object.keys(run.steps);
      // flowSpent is monotonic across reverts: the live pre-revert total already
      // includes every receipt (spine) plus any pre-receipt legacy spend, so it is
      // the correct value in both the receipt-era and the upgraded-mid-run case.
      // The spine is kept as a floor (defense against a corrupted live total); the
      // restored snapshot is never consulted for spend.
      const spine = spineSpent(run);
      const reconciled: Budget = {};
      for (const key of BUDGET_KEYS) {
        const value = Math.max(liveSpentBeforeRevert[key] ?? 0, spine[key] ?? 0);
        if (value !== 0) reconciled[key] = value;
      }
      run.flowSpent = reconciled;
      const detail = { label: normalized, receiptsAtRevert, stepsRestored };
      this.event(run, "checkpoint_reverted", undefined, detail);
      const checkpointReceiptSeq = receiptsAtRevert + 1;
      (run.receipts ??= []).push(buildReceipt(run, {
        dispatchId: `engine:checkpoint_reverted:${checkpointReceiptSeq}`,
        source: "engine",
        usage: {},
        detail,
      }));
      this.rotateRestoredIssuances(run);
      await this.persist(run);
      return { ...await this.reAdvanceLocked(runId), reverted_to: normalized };
    });
  }

  async resume(runId: string): Promise<RevisionedEngineResponse> {
    // Sole-mutator enforcement, same as stepDone/commit/revert: a bg-driven run's
    // in-flight step is durably `ready`, so an external resume would hand that same
    // work to a second executor while the driver's dispatch is still running.
    // Python returns bg_owned here (server.py:1057); cancelled runs stay abandoned.
    this.assertExternalMutationAllowed(runId, "resume");
    return this.withRunLock(runId, async () => {
      const response = await this.resumeLocked(runId);
      const run = await this.loadRun(runId);
      return this.withRevisionDigest(response, run);
    });
  }

  private async resumeLocked(runId: string): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    // D5. Without this a cancelled run re-emits `resumed`, re-arms every in-flight fanout
    // below, and lands in advance's {status:"running"} limbo. assertExternalMutationAllowed
    // cannot cover it: a foreground run has no bgFlows entry.
    if (run.cancelRequested === true || run.status === "cancelled") {
      throw new Error(`run ${runId} is cancelled; resume is not permitted`);
    }
    // Resume is the TAKEOVER entry point: it re-arms in-flight fanouts, and arming one pins the
    // run. The pin used to meet the incumbent lease with no way to resolve it — `scheduleFanout`
    // is synchronous, so it cannot probe an owner — and the only thing that got past a leftover
    // lease was the same-pid reclaim F1 removes. A crashed driver's lease would therefore have
    // wedged every later resume. Resolve it HERE, where the probe can be awaited: a dead owner
    // is reclaimed, a live one still refuses.
    await this.prepareLease(runId);
    const computedDigest = digest(run.spec);
    if (run.revisionDigest !== undefined && run.revisionDigest !== computedDigest) {
      throw new Error("persisted revision digest does not match the effective specification");
    }
    run.revisionDigest = computedDigest;
    run.generationCounter ??= 0;
    this.backfillIssuanceTokens(run);
    const validated = this.validationFor(run);
    this.event(run, "resumed");
    await this.persist(run);
    if (run.status !== "running") return this.response(run);
    const flow = this.flowFor(run, validated.value);
    for (const step of flow.steps) if (step.fanout && run.steps[step.id]?.status === "running") this.scheduleFanout(run, step.id);
    return this.advance(run, validated.value, validated.contracts);
  }

  async audit(runId: string): Promise<AuditTrail> {
    // Durable read, deliberately bypassing the in-memory pin an active fanout
    // holds: audit is the consumer's discovery surface (D5) and a token minted
    // on the live object must stay invisible until its save lands.
    const run = await this.store.load(runId);
    return { runId, status: run.status, events: structuredClone(run.events), steps: structuredClone(run.steps), flowSpent: structuredClone(run.flowSpent), ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}), ...(run.carry !== undefined ? { carry: structuredClone(run.carry) } : {}) };
  }

  /** Restart-safe read-only wait surface: events are sliced from the persisted spine. */
  async flowPoll(runId: string, cursor = 0): Promise<FlowPollResponse> {
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("invalid event cursor");
    // Active fanouts pin a mutable run and set terminal status before save()
    // finishes. Observers must see only committed state; otherwise "completed"
    // can race the final write/rename and disagree with a restarted engine.
    const run = await this.store.load(runId);
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
    const bg = this.bgFlows.get(runId);
    if (!bg) throw new Error(`background flow ${runId} not found`);
    // Capture driver state before reading disk. A terminal driver status is set
    // only after persistence, so this ordering cannot pair bg.completed with an
    // older running snapshot when the driver finishes during the asynchronous read.
    const driver = {
      status: bg.status,
      cancelRequested: bg.cancelRequested,
      pendingGates: [...bg.pendingGates],
    };
    const flow = await this.flowPoll(runId, cursor);
    return { ...flow, bg: driver };
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

  /** R4-4. A live lease held by ANOTHER process means that process owns the in-memory copy of
   *  this run: refuse rather than race it. A provably dead owner's lease is removed and we
   *  proceed, because the crashed driver's memory is gone and disk is truth again. An
   *  `unknown` identity is never reclaimed — we do not break a lease we cannot disprove. */
  private async claimDriverLease(runId: string): Promise<void> {
    const lease = readDriverLeaseSync(this.store.root, runId);
    if (lease === undefined) return;
    if (this.driverLeases.get(runId) === lease.token) return;   // ours
    const state = await this.identity(lease.pid, lease.startTime);
    if (state === "dead") { releaseDriverLeaseSync(this.store.root, runId, lease.token); return; }
    throw Object.assign(
      new Error(`run ${runId} is driven by pid ${lease.pid}; cancel must be issued from that process`),
      { code: "CANCELLATION_UNCONFIRMED", reason: "engine_dispatch_active", holderPid: lease.pid },
    );
  }

  /** R3-7. Admission for a foreground agent about to be spawned against this flow.
   *
   *  Deliberately NOT a boolean: `false` would conflate "healthy", "does not exist" and
   *  "could not read the record", and only the first is a reason to start an agent. An
   *  unreadable record fails CLOSED, because admitting an uncancellable agent is the failure
   *  this check exists to prevent. */
  async admitFlowAgent(runId: string): Promise<void> {
    let run: PersistedRun;
    try {
      run = await this.withRunLock(runId, () => this.loadRun(runId));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw Object.assign(new Error(`flow ${runId} is not running`), { code: "FLOW_NOT_RUNNING" });
      }
      throw Object.assign(new Error(`flow ${runId} admission check failed: ${message(error)}`), { code: "FLOW_ADMISSION_FAILED" });
    }
    if (run.status !== "running" || run.cancelRequested === true) {
      throw Object.assign(new Error(`flow ${runId} is ${run.status === "running" ? "cancelled" : run.status}`), { code: "FLOW_NOT_RUNNING" });
    }
  }

  /** Foreground cancel, addressable by flow id from any process (STRAT-FLOW-CANCEL-FG).
   *  Unlike flowCancelBg this SETTLES the run rather than abandoning it, and it works with no
   *  bgFlows entry — which is the whole point: a compose team build is a foreground
   *  consumer-fanout run, and `compose build --abort` runs in a different process.
   *
   *  One locked section, one persist. No mark-then-settle two-phase: under the lock there is
   *  nothing to race, so the durable mark and the settle ARE the same write. */
  async flowCancel(runId: string, reason?: string): Promise<FlowCancelResult> {
    return this.withRunLock(runId, async () => {
      // DURABLE STATUS FIRST, and BEFORE the lease decision. Two reasons, both load-bearing:
      //
      // A terminal run must not be MUTATED at all, and a lease refusal is a mutation refusal
      // for a mutation nobody asked for. Worse, an already-cancelled run whose driver's lease
      // is still live would raise `engine_dispatch_active` — so the orchestrator's re-sweep,
      // which is the documented recovery from a CANCELLATION_TEARDOWN_TIMEOUT, would fail on
      // the very run it just cancelled. `already_cancelled` is what lets that sweep run.
      //
      // The decision is read from DISK, not from a pinned object: another process may have
      // completed this run.
      const persisted = await this.store.load(runId);
      if (persisted.status !== "running") {
        return {
          runId,
          status: persisted.status,
          flowSettled: persisted.status === "cancelled",
          settledByThisCall: false,
          reason: `already_${persisted.status}`,
          ledger: this.ledgerInfo(persisted),
        };
      }
      // Only NOW, with the run known to be durably running, does the lease decide whether this
      // process may apply the cancel at all.
      await this.claimDriverLease(runId);
      // Mutate the object the rest of the engine is using. When a fanout of OURS holds a pin,
      // loadRun returns that instance, so its cooperative brake and its item settle see the
      // burn on the very same object — which is the whole reason the lease restricts this
      // path to the driving process (R4-4).
      const run = await this.loadRun(runId);
      await this.terminalCancel(run, reason);
      return { runId, status: run.status, flowSettled: true, settledByThisCall: true, ledger: this.ledgerInfo(run) };
    }, { timeoutMs: cancelLockWaitMs() });
  }

  async gateResolve(runId: string, stepId: string, decision: "approve" | "revise" | "kill", gateToken: string, userId?: string): Promise<EngineResponse> {
    // A PAUSED background flow resolves its gate and re-kicks its driver in ONE locked
    // transaction, and the driver lease is claimed FIRST (F1). Resolving the gate first —
    // even in its own earlier locked section — consumed and PERSISTED the gate token before
    // this process knew it could drive the run at all: a refused claim then left a run whose
    // successor step was ready, whose durable gate token was already spent, and whose loop had
    // never started. Nothing could resolve the gate again to produce a driver. Claiming first
    // means a refusal leaves the durable gate exactly as it was, so the SAME token retries.
    const bg = this.bgFlows.get(runId);
    const rekick = bg !== undefined && bg.status === "paused_gate";
    if (rekick) await this.hooks.beforePin?.(runId);
    let policy: { bundleId: string; round: number } | undefined;
    const response = await this.withRunLock(runId, async () => {
      if (!rekick || bg === undefined) {
        const plain = await this.gateResolveLocked(runId, stepId, decision, gateToken);
        policy = await this.gatePolicySnapshot(runId, stepId);
        return plain;
      }
      // Claim and pin BEFORE the gate is touched. A throw here has mutated nothing.
      await this.prepareLease(runId);
      this.retainRun(runId, await this.loadRun(runId));
      let resolved: EngineResponse;
      try { resolved = await this.gateResolveLocked(runId, stepId, decision, gateToken); }
      catch (error) { this.releaseRun(runId); throw error; }
      policy = await this.gatePolicySnapshot(runId, stepId);
      const durable = await this.store.load(runId);
      if (resolved.status !== "ready" && resolved.status !== "running") {
        bg.status = resolved.status;
        bg.pendingGates = [];
        this.releaseRun(runId);
        return resolved;
      }
      if (durable.status !== "running" || durable.cancelRequested === true) {
        bg.status = durable.status === "running" ? "cancelled" : durable.status;
        bg.pendingGates = [];
        this.releaseRun(runId);
        return resolved;
      }
      const priorStatus = bg.status;
      const priorGates = bg.pendingGates;
      bg.status = "running";
      bg.pendingGates = [];
      let loop: Promise<void>;
      try { loop = this.driveBg(runId, resolved); }
      catch (error) {
        bg.status = priorStatus;
        bg.pendingGates = priorGates;
        this.releaseRun(runId);
        throw error;
      }
      bg.loop = loop;
      void loop.finally(() => {
        this.releaseRun(runId);
        if (bg.loop === loop) delete bg.loop;
      });
      return resolved;
    });
    if (policy !== undefined) {
      this.firePolicyEvent(buildGateResolutionEvent({
        runId,
        bundleId: policy.bundleId,
        stepId,
        round: policy.round,
        outcome: decision,
        ...(userId !== undefined ? { resolvedByUserId: userId } : {}),
      }));
    }
    return response;
  }

  /** The bundle/round pair the policy event needs, read INSIDE the gate's locked transaction.
   *  Read afterwards it could count a later round appended by the loop this call just launched. */
  private async gatePolicySnapshot(runId: string, stepId: string): Promise<{ bundleId: string; round: number } | undefined> {
    const run = await this.loadRun(runId);
    if (run.bundle_id === undefined) return undefined;
    return {
      bundleId: run.bundle_id,
      round: run.events.filter((event) => event.type === "gate_resolved" && event.stepId === stepId).length,
    };
  }

  /** Every on_revise write this gate declares, resolved against the UN-RESET scope.
   *  All expressions are resolved before any of them is applied, so a missing source
   *  output fails the decision with no partial mutation. */
  private resolveCarryOnRevise(scope: ExecutionScope, gateId: string, gateToken: string): Array<{ name: string; value: unknown; provenance: CarryProvenance }> {
    const declarations = scope.flow.carry;
    if (declarations === undefined) return [];
    const writes: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    for (const [name, declaration] of Object.entries(declarations)) {
      // Object.hasOwn on the on_revise map too: a gate step legitimately named
      // `constructor` must not pick up an inherited member as a declaration (R2-3).
      const onRevise = declaration.on_revise;
      if (onRevise === undefined || !Object.hasOwn(onRevise, gateId)) continue;   // gates that declare nothing leave the entry untouched
      const expression = onRevise[gateId]!;
      const value = this.resolve(this.carryReference(expression), scope);
      if (value === undefined) {
        throw new Error(`carry_revise_unresolved: carry ${JSON.stringify(name)} at gate ${JSON.stringify(gateId)} resolved to no value`);
      }
      // sourceStep/sourceEpoch name the INITIAL declaration's source (D6), so the write
      // survives every later advance until that source is itself reset (D7).
      const initial = this.carryReference(declaration.initial);
      const source = initial.kind === "step" ? { sourceStep: initial.stepId, sourceEpoch: scope.steps[initial.stepId]?.epoch ?? 0 } : {};
      writes.push({ name, value, provenance: { kind: "revise", ...source, gate: gateId, gateToken, at: now() } });
    }
    return writes;
  }

  private async gateResolveLocked(runId: string, stepId: string, decision: "approve" | "revise" | "kill", gateToken?: string): Promise<EngineResponse> {
    // Runtime guard for JS callers: an unknown decision must be rejected, not
    // fall through the ternary chain onto the kill route.
    if (decision !== "approve" && decision !== "revise" && decision !== "kill") throw new Error(`invalid gate decision ${JSON.stringify(decision)}`);
    const run = await this.loadRun(runId);
    // Gates are the one exception to the bg sole-mutator guard, so they must honor
    // the durable cancel flag themselves: a cancelled run is abandoned, and a
    // decision on its still-waiting gate must not complete it or issue new work.
    if (run.cancelRequested === true) throw new Error(`run ${runId} is cancelled; gate ${stepId} cannot be resolved`);
    const validated = this.validationFor(run);
    const located = this.locateStep(run, validated.value, stepId);
    const scope = located?.scope;
    const step = located?.step;
    const state = located?.state;
    if (!scope || !step?.gate || !state || state.status !== "waiting_gate" || run.status !== "running") throw new Error("gate is not awaiting a decision");
    if (gateToken === undefined) {
      throw new Error("gate decision is stale: missing gate token");
    }
    if (state.gateToken !== gateToken) {
      throw new Error("gate decision is stale: issued for a superseded gate round");
    }
    const target = decision === "approve" ? step.gate.on_approve : decision === "revise" ? step.gate.on_revise : step.gate.on_kill;

    // ---- STRAT-LOOP-CARRY R1-6: MUTATION-FREE PREFLIGHT ---------------------
    // Everything that can throw runs here, while the gate token is still valid and no
    // event has been appended. loadRun returns the LIVE run object while a fanout is
    // active, so a throw after this point would strand the gate: the token would be
    // consumed and the decision unrepeatable.
    let carryWrites: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    let reviseTotal = 0;
    let reviseGateRounds = 0;
    if (decision === "revise") {
      reviseGateRounds = state.iterations ?? 0;
      reviseTotal = (scope.parent ? scope.parent.state.sub?.rounds ?? 0 : run.rounds ?? 0) + 1;
      const flowLimit = scope.flow.max_rounds;
      const gateLimit = step.gate.max_rounds;
      if (target === null || flowLimit === undefined || reviseTotal > flowLimit || (gateLimit !== undefined && reviseGateRounds + 1 > gateLimit)) {
        // Rounds exhaustion terminalises the run deliberately; it is the one preflight
        // outcome that mutates, and nothing runs after it.
        delete state.gateToken;
        this.event(run, "gate_resolved", stepId, { decision, target });
        return scope.parent
          ? this.failScope(run, validated.value, validated.contracts, scope, "gate revision rounds exhausted")
          : this.terminalFailure(run, { attempt: 0, reason: "gate revision rounds exhausted" });
      }
      // Resolves every declared expression against the UN-RESET scope. Throws
      // `carry_revise_unresolved` before any mutation if one has no value.
      carryWrites = this.resolveCarryOnRevise(scope, step.id, gateToken);
    }
    // ---- END PREFLIGHT; EVERYTHING BELOW MUTATES ----------------------------

    delete state.gateToken;
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
      if (scope.parent) scope.parent.state.sub!.rounds = reviseTotal;
      else run.rounds = reviseTotal;
      if (carryWrites.length > 0) {
        const carryStore = this.carryScope(run, validated.value, scope).carry!;
        for (const write of carryWrites) {
          const provenance: CarryProvenance = { ...write.provenance, round: reviseTotal };
          carryStore[write.name] = { value: write.value, provenance };
          this.event(run, "carry_updated", step.id, { name: write.name, reason: "revise", provenance });
        }
      }
      this.resetFrom(run, scope, target!);
      // The target's descendants include this gate; retain its local revision counter.
      scope.steps[step.id]!.iterations = reviseGateRounds + 1;
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
    const output = this.resolveFlowOutput({ input: run.input, steps: run.steps, flow, flowName: run.flowName });
    const parsed = contracts[flow.output.contract]?.safeParse(output);
    if (!parsed?.success) return this.terminalFailure(run, { attempt: 0, reason: parsed?.error.message ?? "flow output contract missing" });
    run.output = output;
    run.status = "completed";
    this.event(run, "completed", undefined, { output });
    await this.persist(run);
    this.emitFlowTerminal(run);
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
              await this.stepDoneOwned(runId, step.id, result, step.epoch, step.dispatchToken);
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
              const superseded = current.status !== "running" || current.cancelRequested === true || state === undefined
                || state.status !== "ready" || (state.epoch ?? 0) !== step.epoch || state.dispatchToken !== step.dispatchToken;
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
        // R2-11: bg.cancelRequested above is IN-MEMORY, and a second process cannot set it.
        // Without this a bg run cancelled cross-process settles durably while flowBgPoll
        // reports `running` forever — the two halves disagreeing is exactly the hazard
        // rehydrateBgFlows exists to prevent across restarts.
        // Deliberately store.load, NOT loadRun: a bg-driven run is PINNED by flowRunBg, so
        // loadRun would hand back this driver's own in-memory object and could never observe
        // a settle performed anywhere else. The durable record is the only source that can.
        if (response.status === "cancelled" || (await this.store.load(runId).catch(() => undefined))?.status === "cancelled") {
          bg.cancelRequested = true;
          bg.status = "cancelled";
          bg.pendingGates = [];
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

  /** Idempotent `initial` materialisation. Re-writes only when the source step's epoch
   *  differs from the recorded one, so:
   *   - a source that re-runs (which can only happen after a reset bumped its epoch)
   *     replaces its now-stale derived value;
   *   - a revise write, stamped with the initial source's CURRENT epoch, survives every
   *     later advance until that source is itself reset.
   *  `scope` MUST come from `carryScope` so `scope.carry === run.carry` (R2-1). */
  private materialiseCarry(run: PersistedRun, scope: ExecutionScope): CarryMaterialisation {
    const declarations = scope.flow.carry;
    if (declarations === undefined) return { kind: "unchanged" };
    const store = scope.carry;
    if (store === undefined) return { kind: "unchanged" };
    const staged: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    for (const [name, declaration] of Object.entries(declarations)) {
      const reference = this.carryReference(declaration.initial);
      // Object.hasOwn: a declared variable named `toString` must not read as materialised
      // just because Object.prototype has one (R2-3).
      const existing = Object.hasOwn(store, name) ? store[name] : undefined;
      let provenance: CarryProvenance;
      if (reference.kind === "step") {
        const source = scope.steps[reference.stepId];
        if (source?.status !== "succeeded") continue;
        const sourceEpoch = source.epoch ?? 0;
        if (existing !== undefined && existing.provenance.sourceEpoch === sourceEpoch) continue;
        provenance = { kind: "initial", sourceStep: reference.stepId, sourceEpoch, at: now() };
      } else {
        if (existing !== undefined) continue;                 // input-sourced: write once
        provenance = { kind: "initial", at: now() };
      }
      const value = this.resolve(reference, scope);
      // NEVER create an entry from an absent value (R1-3): a materialised-but-undefined
      // carry would fail later at a confusing site, or hand `undefined` to a fanout.
      if (value === undefined) {
        return { kind: "failed", reason: `carry_initial_unresolved: carry ${JSON.stringify(name)} resolved to no value from ${declaration.initial}` };
      }
      staged.push({ name, value, provenance });
    }
    if (staged.length === 0) return { kind: "unchanged" };
    for (const write of staged) {
      store[write.name] = { value: write.value, provenance: write.provenance };
      this.event(run, "carry_updated", write.provenance.sourceStep, { name: write.name, reason: "initial", provenance: write.provenance });
    }
    return { kind: "written" };
  }

  private async advance(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    scope: ExecutionScope = this.rootScope(run, spec),
  ): Promise<EngineResponse> {
    // STRAT-LOOP-CARRY D7: the re-entry after every dispatching settle, and BEFORE the
    // scope loop, so a ${carry} fanout sees the value in the same pass it activates.
    // carryScope patches THIS scope object when it is the root one (R2-1) — building a
    // detached root scope here would leave the live scope's carry undefined.
    // `advance` does not persist on every path, so a write persists itself.
    const materialised = this.materialiseCarry(run, this.carryScope(run, spec, scope));
    if (materialised.kind === "failed") return this.failScope(run, spec, contracts, scope, materialised.reason);
    if (materialised.kind === "written") await this.persist(run);
    await this.advanceScopeLoop(run, spec, contracts, scope);
    if (run.status !== "running") return this.response(run);
    if (run.cancelRequested === true) return { status: "running", runId: run.id, ledger: this.ledgerInfo(run) };
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
      this.emitFlowTerminal(run);
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
    while (changed && run.status === "running" && run.cancelRequested !== true) {
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
          // R1-2: a later step in THIS pass may read the value. R2-5: never a partial write.
          const setCarry = this.materialiseCarry(run, this.carryScope(run, spec, scope));
          if (setCarry.kind === "failed") { await this.failScope(run, spec, contracts, scope, setCarry.reason); break; }
          changed = true;
          await this.persist(run);
          continue;
        }
        if (step.gate !== undefined) {
          state.status = "waiting_gate";
          state.gateToken = randomUUID();
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
            items: items.map((_, index) => ({
              index, status: "pending", attempts: [], generation: this.nextGeneration(run), epoch: state.epoch ?? 0,
            })),
          };
          await this.persist(run);
          if (step.fanout.dispatch === "consumer") {
            await this.promoteConsumerItems(run, spec, contracts, flow, step, state);
            if (state.fanout.items.every((item) => terminalFanoutItem(item.status))) {
              await this.settleFanout(run, spec, contracts, flow, step, state, state.fanout);
            }
          } else {
            for (const item of state.fanout.items) this.event(run, "fanout_item_ready", step.id, { itemIndex: item.index });
            this.scheduleFanout(run, step.id);
          }
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
        if (step.evaluate !== undefined) {
          const attempt = state.attempts.length + 1;
          const evaluate = step.evaluate;
          // Deterministic, single-shot, and atomic: no intermediate `running`
          // is persisted, so a crash mid-evaluate leaves the step `pending` and
          // it re-runs on resume. `forceExhausted` terminalizes every failure —
          // retrying a deterministic evaluator is pointless (backtrack is S3).
          const evalFail = (reason: string) =>
            this.failAttempt(run, spec, contracts, scope, step, state, attempt, reason, {}, undefined, undefined, true);
          if (!this.evaluateRunner) {
            await evalFail("evaluate: no evaluate runner configured");
            changed = true;
            break;
          }
          let input: unknown;
          try {
            input = evaluate.in === undefined ? undefined : this.renderValue(evaluate.in, scope);
          } catch (error) {
            await evalFail(`evaluate: input render failed: ${message(error)}`);
            changed = true;
            break;
          }
          // Sandboxing (workspaceRoot jail) is deferred — see design open question 3.
          let rawOutcome: unknown;
          try {
            rawOutcome = await this.evaluateRunner(
              { command: evaluate.command, input, timeoutMs: evaluate.timeout_ms },
              {},
            );
          } catch (error) {
            await evalFail(`evaluate: runner threw: ${message(error)}`);
            changed = true;
            break;
          }
          const envelope = evaluateRunResultSchema.safeParse(rawOutcome);
          if (!envelope.success) {
            await evalFail(`evaluate: runner returned a malformed result envelope: ${envelope.error.message}`);
            changed = true;
            break;
          }
          const outcome = envelope.data;
          if (!outcome.ok) {
            const detail = outcome.reason;
            const reason = outcome.kind === "exit" ? `evaluate: command exited with a non-zero status (${detail})`
              : outcome.kind === "timeout" ? `evaluate: command timed out (${detail})`
              : `evaluate: output was not valid JSON (${detail})`;
            await evalFail(reason);
            changed = true;
            break;
          }
          const parsed = evaluatorResultSchema.safeParse(outcome.result);
          if (!parsed.success) {
            await evalFail(`evaluate: output failed the evaluator-result contract: ${parsed.error.message}`);
            changed = true;
            break;
          }
          const outError = this.contractError(step, parsed.data, contracts);
          if (outError) {
            await evalFail(`evaluate: output failed the ${step.out} contract: ${outError}`);
            changed = true;
            break;
          }
          state.status = "succeeded";
          state.output = parsed.data;
          state.attempts.push({ attempt, at: now(), result: parsed.data });
          this.event(run, "result", this.scopedId(scope, step.id), { attempt, result: parsed.data });
          const evalCarry = this.materialiseCarry(run, this.carryScope(run, spec, scope));
          if (evalCarry.kind === "failed") { await this.failScope(run, spec, contracts, scope, evalCarry.reason); break; }
          await this.persist(run);
          changed = true;
          continue;
        }
        if (step.do === undefined) {
          await this.failScope(run, spec, contracts, scope, "construct is outside P1 engine scope");
          break;
        }
        // Render BEFORE reserving: a render failure dispatches nothing, so it must not
        // debit a dispatch — and its attempt record carries no usage.
        let attempt: number;
        try {
          this.render(step.do, scope);
          attempt = state.attempts.length + 1;
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
        state.dispatchToken = randomUUID();
        delete state.acceptedDispatchToken;
        state.status = "ready";
        this.event(run, "ready", this.scopedId(scope, step.id), { attempt });
        await this.persist(run);
        changed = true;
      }
    }
  }

  private scheduleFanout(run: PersistedRun, stepId: string): void {
    const validated = this.validationFor(run);
    const scheduledStep = this.flowFor(run, validated.value).steps.find((step) => step.id === stepId);
    if (scheduledStep?.fanout?.dispatch === "consumer") return;
    // Epoch-keyed: a revise that invalidated a live fanout must not be blocked
    // from scheduling the fresh one by the stale execution still draining.
    const key = `${run.id}:${stepId}:${run.steps[stepId]?.fanoutEpoch ?? 0}`;
    if (this.scheduledFanouts.has(key)) return;
    // Pin SYNCHRONOUSLY with the scheduler's own run object: from here until
    // release, loadRun hands this exact instance to every entry point, so an
    // independent stepDone proceeds during a slow fanout and mutates the same
    // instance — never a divergent disk copy, never blocked behind the batch.
    //
    // The pin comes BEFORE the key is marked scheduled (F2). Marked first, a failing lease
    // write left the key set with no execution behind it, and the epoch-keyed guard above then
    // refused to schedule the fanout ever again — the step simply never ran.
    this.retainRun(run.id, run);
    this.scheduledFanouts.add(key);
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

  private async promoteConsumerItems(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    flow: Flow,
    step: Step,
    state: StepState,
  ): Promise<void> {
    if (!step.fanout || step.fanout.dispatch !== "consumer" || !state.fanout || run.status !== "running") return;
    let assigned = state.fanout.items.filter((item) => item.status === "ready" || item.status === "running").length;
    for (const item of state.fanout.items) {
      if (assigned >= step.fanout.concurrency || run.status !== "running") break;
      if (item.status !== "pending") continue;
      await this.prepareConsumerItem(run, spec, contracts, flow, step, state, item);
      const prepared = item as FanoutItemState;
      if (prepared.status === "ready" || prepared.status === "running") assigned += 1;
    }
  }

  private async prepareConsumerItem(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    _flow: Flow,
    step: Step,
    state: StepState,
    item: FanoutItemState,
  ): Promise<void> {
    if (!step.fanout || step.fanout.dispatch !== "consumer") throw new Error("consumer fanout missing after validation");
    const values = this.resolveFanoutOver(step.fanout.over, run);
    if (!Array.isArray(values)) throw new Error("fanout over must resolve to an array");
    while (run.status === "running") {
      const stageIndex = item.stage ?? 0;
      const stage = step.fanout.steps[stageIndex];
      if (!stage) throw new Error("consumer fanout stage is out of range");
      item.stage = stageIndex;
      item.epoch = state.epoch ?? 0;
      if (stage.when !== undefined) {
        const enabled = this.evaluateFanout(stage.when, run, values[item.index], item.output);
        if (enabled !== true) {
          this.event(run, "fanout_item_skipped", step.id, { itemIndex: item.index, stage: stageIndex });
          delete item.dispatchToken;
          if (stageIndex === step.fanout.steps.length - 1) {
            item.status = "skipped";
            await this.persist(run);
            return;
          }
          item.stage = stageIndex + 1;
          continue;
        }
      }

      const attempt = item.attempts.length + 1;
      try {
        this.renderFanout(stage.do, run, values[item.index], item.output);
      } catch (error) {
        const failure = { attempt, reason: message(error) };
        this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", failure);
        item.failure = failure;
        const used = item.attempts.filter((record) => record.stage === stageIndex).length;
        if (used >= (stage.attempts ?? step.attempts ?? 2)) {
          item.status = "failed";
          await this.persist(run);
          return;
        }
        continue;
      }
      const reserve = this.debit(run, step, state, { dispatches: 1 }, "reserve");
      if (reserve !== undefined) {
        const failure = { attempt, reason: `${reserve} budget exhausted` };
        this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "budget", failure);
        item.failure = failure;
        if (reserve === "flow") {
          item.status = "failed";
          await this.terminalBudget(run, failure);
          return;
        }
        const used = item.attempts.filter((record) => record.stage === stageIndex).length;
        if (used >= (stage.attempts ?? step.attempts ?? 2)) {
          item.status = "failed";
          await this.persist(run);
          return;
        }
        continue;
      }
      item.status = "ready";
      item.dispatchToken = randomUUID();
      delete item.acceptedDispatchToken;
      this.event(run, "fanout_ledger_debit", step.id, { itemIndex: item.index, amount: { dispatches: 1 } });
      this.event(run, "fanout_item_ready", step.id, { itemIndex: item.index });
      await this.persist(run);
      return;
    }
  }

  private async consumerFanoutStepDone(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    flow: Flow,
    step: Step,
    state: StepState,
    item: FanoutItemState,
    result: StepResult,
    expectedEpoch?: number,
    dispatchToken?: string,
  ): Promise<EngineResponse> {
    if (!step.fanout || step.fanout.dispatch !== "consumer" || !state.fanout || item.status !== "ready") {
      throw new Error("step is not awaiting a client result");
    }
    if (dispatchToken === undefined) throw new Error("dispatchToken is required for a consumer fanout item");
    if (item.dispatchToken !== dispatchToken) throw new Error("step result is stale: dispatched for a superseded issuance");
    if (expectedEpoch !== undefined && (item.epoch ?? state.epoch ?? 0) !== expectedEpoch) {
      throw new Error("step result is stale: dispatched for a superseded epoch");
    }
    const stageIndex = item.stage;
    const stage = stageIndex === undefined ? undefined : step.fanout.steps[stageIndex];
    if (stageIndex === undefined || !stage) throw new Error("consumer fanout stage is out of range");
    const values = this.resolveFanoutOver(step.fanout.over, run);
    if (!Array.isArray(values)) throw new Error("fanout over must resolve to an array");
    const attempt = item.attempts.length + 1;
    const outcome = await this.settleFanoutAttempt(
      run, spec, contracts, step, state, item, values[item.index], item.output, stageIndex, attempt, result,
    );
    if (!outcome.success) {
      item.failure = outcome.failure;
      if (run.status !== "running") return this.response(run);
      const stageAttempts = item.attempts.filter((record) => record.stage === stageIndex).length;
      if (stageAttempts < (stage.attempts ?? step.attempts ?? 2)) {
        item.status = "pending";
        await this.prepareConsumerItem(run, spec, contracts, flow, step, state, item);
      } else {
        item.status = "failed";
        delete item.dispatchToken;
      }
    } else {
      item.output = result.output;
      delete item.failure;
      if (stageIndex === step.fanout.steps.length - 1) {
        item.status = "succeeded";
        item.acceptedDispatchToken = dispatchToken;
        delete item.dispatchToken;
      } else {
        item.stage = stageIndex + 1;
        item.status = "pending";
        delete item.dispatchToken;
        delete item.acceptedDispatchToken;
        await this.prepareConsumerItem(run, spec, contracts, flow, step, state, item);
      }
    }

    if (terminalFanoutItem(item.status)) await this.promoteConsumerItems(run, spec, contracts, flow, step, state);
    await this.persist(run);
    if (state.fanout.items.every((candidate) => terminalFanoutItem(candidate.status))) {
      return (await this.settleFanout(run, spec, contracts, flow, step, state, state.fanout)) ?? this.advance(run, spec, contracts);
    }
    return this.advance(run, spec, contracts);
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
  ): Promise<EngineResponse | undefined> {
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
      return this.failAttempt(run, spec, contracts, this.rootScope(run, spec), step, state, state.attempts.length + 1, `fanout require ${String(step.fanout.require)} not met (${succeeded}/${values.length} succeeded)`, {}, undefined, undefined, true);
    }
    if (step.fanout.dispatch === "engine" && step.fanout.isolation === "worktree") {
      try {
        await this.mergeFanoutPatches(run, step, state);
      } catch (error) {
        return this.terminalFailure(run, { attempt: state.attempts.length + 1, reason: `fanout merge failed: ${message(error)}` });
      }
    }
    state.output = fanoutRef.items.map((item) => item.status === "succeeded" ? item.output ?? null : null);
    state.status = "succeeded";
    state.attempts.push({ attempt: state.attempts.length + 1, at: now(), result: state.output });
    this.event(run, "result", step.id, { attempt: state.attempts.length, result: state.output });
    await this.persist(run);
    return this.advance(run, spec, contracts);
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
    const fanout = step.fanout;
    // A revise can invalidate this fanout at any await point; once stale, the
    // item belongs to a dead epoch — stop recording into it (already-reserved
    // dispatch costs stay in the flow ledger: they were really spent). A cancel
    // is the other way in: the settle sets both `cancelRequested` and `status`.
    const stale = (): boolean => run.cancelRequested === true || run.status === "cancelled" || state.fanout !== fanoutRef;
    // R2-2/R4-5: the connector await is the ONE thing outside the lock. Everything that
    // ADMITS, ACCEPTS or RECORDS an attempt runs inside a locked transaction, so a cancel
    // landing during the await is seen at the one point where its answer becomes durable.
    const lock = <T>(action: () => Promise<T>): Promise<T> => this.withRunLock(run.id, action);
    item.status = "running";
    let cwd = run.workspaceRoot;
    try {
      if (fanout.isolation === "worktree") {
        const prepared = await lock(async (): Promise<string | undefined> => {
          if (stale()) return undefined;
          if (!cwd) throw new Error("worktree fanout requires workspaceRoot");
          const previousWorktree = item.worktree;
          const directory = await mkdtemp(join(tmpdir(), `stratum-${run.id.slice(0, 8)}-${item.index}-`));
          await rm(directory, { recursive: true, force: true });
          await execFileAsync("git", ["-C", cwd, "worktree", "add", "--detach", directory, "HEAD"]);
          if (previousWorktree && previousWorktree !== directory) {
            await this.teardownWorktree(cwd, previousWorktree);
          }
          item.worktree = directory;
          return directory;
        });
        if (prepared === undefined) return;
        cwd = prepared;
      }
      let previous: unknown = undefined;
      let finalStageSkipped = false;
      for (const [stageIndex, stage] of fanout.steps.entries()) {
        if (stale()) return;
        const gate = await lock(async (): Promise<"abandon" | "skip" | "run"> => {
          if (stale()) return "abandon";
          item.stage = stageIndex;
          item.epoch = state.epoch ?? 0;
          delete item.dispatchToken;
          delete item.acceptedDispatchToken;
          if (stage.when !== undefined) {
            const enabled = this.evaluateFanout(stage.when, run, value, previous, cwd);
            if (enabled !== true) {
              this.event(run, "fanout_item_skipped", step.id, { itemIndex: item.index, stage: stageIndex });
              return "skip";
            }
          }
          return "run";
        });
        if (gate === "abandon") return;
        if (gate === "skip") {
          if (stageIndex === fanout.steps.length - 1) finalStageSkipped = true;
          continue;
        }
        let success = false;
        let lastFailure: FailureContext | undefined;
        const maximum = stage.attempts ?? step.attempts ?? 2;
        for (let stageAttempt = 1; stageAttempt <= maximum; stageAttempt += 1) {
          // R3-3b: the whole admission and reservation stretch — render, debit, token mint,
          // both lifecycle events and the pre-dispatch persist — is one locked transaction,
          // re-entered on every stage attempt rather than held across the whole retry loop,
          // so a cancel between attempts is seen at the next acquire.
          type Admission =
            | { kind: "abandon" }
            | { kind: "continue" }
            | { kind: "break" }
            | { kind: "dispatch"; prompt: string; attempt: number; previousFailure?: FailureContext };
          const admission = await lock(async (): Promise<Admission> => {
            if (stale()) return { kind: "abandon" };
            const attempt = item.attempts.length + 1;
            const carried = lastFailure;
            let prompt: string;
            try { prompt = this.renderFanout(stage.do, run, value, previous); }
            catch (error) {
              lastFailure = { attempt, reason: message(error) };
              this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure);
              return { kind: "continue" };
            }
            const reserve = this.debit(run, step, state, { dispatches: 1 }, "reserve");
            if (reserve) {
              lastFailure = { attempt, reason: `${reserve} budget exhausted` };
              this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "budget", lastFailure);
              // Flow-ledger exhaustion is TERMINAL for the run — it must never be
              // absorbed as one failed item that a tolerant `require` outweighs.
              if (reserve === "flow") await this.terminalBudget(run, lastFailure);
              return { kind: "break" };
            }
            item.dispatchToken = randomUUID();
            this.event(run, "fanout_ledger_debit", step.id, { itemIndex: item.index, amount: { dispatches: 1 } });
            this.event(run, "fanout_item_dispatched", step.id, { itemIndex: item.index, stage: stageIndex, attempt });
            // Durable BEFORE the (possibly long) connector await: a restart or a
            // fresh poller must see the dispatched lifecycle event, not a
            // pending item — the event spine is restart-proof.
            await this.persist(run);
            return { kind: "dispatch", prompt, attempt, ...(carried ? { previousFailure: carried } : {}) };
          });
          if (admission.kind === "abandon") return;
          if (admission.kind === "continue") continue;
          if (admission.kind === "break") break;
          const { prompt, attempt } = admission;
          const rawContract = stage.out !== undefined ? (spec.contracts as Record<string, Record<string, unknown>>)[stage.out] : undefined;
          // R4-5: capture, do not act. Neither arm touches the run — the failure path used to
          // call recordFanoutAttempt in a bare catch, recording an attempt against a run that
          // may already have been cancelled.
          let outcome: { ok: true; result: StepResult } | { ok: false; error: unknown };
          try {
            outcome = { ok: true, result: await this.connector({
              agent: stage.agent ?? "claude", prompt, ...(cwd !== undefined ? { cwd } : {}), attempt,
              ...(admission.previousFailure ? { previousFailure: admission.previousFailure } : {}),
              ...(rawContract !== undefined ? { outSchema: rawContract } : {}),
              sandbox: fanout.isolation === "worktree" ? "workspace-write" : "read-only",
            }) };
          }
          catch (error) { outcome = { ok: false, error }; }
          const disposition = await lock(async (): Promise<"abandon" | "retry" | "accepted"> => {
            if (stale()) return "abandon";
            if (!outcome.ok) {
              lastFailure = { attempt, reason: message(outcome.error) };
              this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure);
              return "retry";
            }
            const settled = await this.settleFanoutAttempt(
              run, spec, contracts, step, state, item, value, previous, stageIndex, attempt, outcome.result, cwd,
            );
            if (stale()) return "abandon";
            if (!settled.success) {
              lastFailure = settled.failure;
              return "retry";
            }
            return "accepted";
          });
          if (disposition === "abandon") return;
          if (disposition === "retry") continue;
          previous = outcome.ok ? outcome.result.output : undefined;
          success = true;
          break;
        }
        if (!success) {
          const abandoned = await lock(async () => {
            if (stale()) return true;
            item.status = "failed";
            item.failure = lastFailure ?? { attempt: item.attempts.length + 1, reason: "fanout stage failed" };
            delete item.dispatchToken;
            return false;
          });
          void abandoned;
          return undefined;
        }
      }
      await lock(async () => {
        if (stale()) return;
        if (finalStageSkipped) {
          // The fanout output element type is the LAST stage's contract; an item
          // whose final stage was `when`-skipped has no such value — it is a
          // skipped item (null in the output array), never a success `require`
          // can count, and its partial worktree work is never merged.
          item.status = "skipped";
          delete item.dispatchToken;
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
        if (item.dispatchToken !== undefined) item.acceptedDispatchToken = item.dispatchToken;
        delete item.dispatchToken;
      });
    } finally {
      await lock(async () => {
        if (run.cancelRequested === true) delete item.dispatchToken;
        // Worktree teardown still runs on the abandon path: a cancelled run must not leak
        // worktrees just because it may not write.
        if (item.worktree && run.workspaceRoot) {
          await this.teardownWorktree(run.workspaceRoot, item.worktree);
          delete item.worktree;
        }
        // R4-1/R4-4: the settle already wrote the final record — and on the same object,
        // since the lease guarantees this process performed it. Nothing to add.
        if (run.status !== "cancelled") await this.persist(run);
      });
    }
  }

  private async teardownWorktree(workspaceRoot: string, directory: string): Promise<void> {
    try {
      await execFileAsync("git", ["-C", workspaceRoot, "worktree", "remove", "--force", directory]);
    } catch (error) {
      process.stderr.write(`stratum: unable to remove worktree '${directory}': ${message(error)}\n`);
      await execFileAsync("git", ["-C", workspaceRoot, "worktree", "prune"]).catch((pruneError: unknown) => {
        process.stderr.write(`stratum: unable to prune worktree registrations: ${message(pruneError)}\n`);
      });
    }
  }

  /** Shared settlement kernel for connector-owned and consumer-owned fanout
   * attempts. Dispatch ownership ends at the result envelope; usage, contract,
   * ensure, audit, and terminal budget semantics stay identical here. */
  private async settleFanoutAttempt(
    run: PersistedRun,
    spec: Specification,
    contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
    step: Step,
    state: StepState,
    item: FanoutItemState,
    value: unknown,
    previous: unknown,
    stageIndex: number,
    attempt: number,
    result: StepResult,
    workspaceRoot?: string,
  ): Promise<{ success: true } | { success: false; failure: FailureContext }> {
    if (!step.fanout) throw new Error("fanout missing after validation");
    const stage = step.fanout.steps[stageIndex];
    if (!stage) throw new Error("fanout stage is out of range");
    if (!validConnectorTelemetry(result.telemetry) || !validUsage(result.usage ?? {})) {
      const failure = { attempt, reason: "invalid connector telemetry or usage" };
      this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "usage", failure, result);
      return { success: false, failure };
    }
    const usage = { ...(result.usage ?? {}) };
    const reportedDispatches = usage.dispatches !== undefined;
    delete usage.dispatches;
    const settled = hasBudget(usage)
      ? this.settleLegacyReceipt(run, usage, "fanout", result.telemetry, {
        scope: this.rootScope(run, spec), step, state, item,
      }, result.usdSource, result.split)
      : undefined;
    if (hasBudget(usage)) this.event(run, "fanout_ledger_debit", step.id, { itemIndex: item.index, amount: usage });
    const stageStep = { ...step, do: stage.do, out: stage.out, ensure: stage.ensure, budget: step.budget } as Step;
    const contractFailure = this.contractError(stageStep, result.output, contracts);
    const failureReason = settled === "flow" ? "flow budget exhausted" : settled === "task" ? "task budget exhausted"
      : reportedDispatches ? "dispatches are engine-accounted; do not report them in usage"
        : result.failure ?? contractFailure;
    const ensure = failureReason === undefined
      ? await this.runEnsures(run, stageStep, state, result.output, this.rootScope(run, spec), {
        itemIndex: item.index,
        stage: stageIndex,
        item: value,
        prev: previous,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      })
      : undefined;
    const reason = failureReason
      ?? (ensure?.kind === "fail" || ensure?.kind === "subflow_budget" ? ensure.reason : ensure?.kind === "flow_budget" ? "flow budget exhausted" : undefined);
    if (reason !== undefined) {
      const kind = contractFailure !== undefined ? "contract"
        : ensure?.kind === "fail" ? "ensure"
          : settled !== undefined || ensure?.kind === "flow_budget" || ensure?.kind === "subflow_budget" ? "budget"
            : !validConnectorTelemetry(result.telemetry) || !validUsage(result.usage ?? {}) ? "usage" : "connector";
      const failure = { attempt, reason };
      this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, kind, failure, result, usage);
      if (ensure?.kind === "flow_budget" || settled === "flow") await this.terminalBudget(run, failure);
      return { success: false, failure };
    }
    item.attempts.push({
      attempt,
      at: now(),
      stage: stageIndex,
      result: result.output,
      ...telemetryFields(result.telemetry),
      ...(hasBudget(usage) ? { usage } : {}),
    });
    this.event(run, "fanout_attempt_result", step.id, { itemIndex: item.index, stage: stageIndex, attempt, success: true });
    return { success: true };
  }

  private recordFanoutAttempt(run: PersistedRun, step: Step, item: FanoutItemState, stage: number, attempt: number, success: boolean, failureKind: "connector" | "usage" | "contract" | "ensure" | "iterate" | "budget", failure: FailureContext, result?: StepResult, usage?: Budget): void {
    item.attempts.push({ attempt, at: now(), stage, failure, failureKind, ...(result?.output !== undefined ? { result: result.output } : {}), ...telemetryFields(result?.telemetry), ...(usage && hasBudget(usage) ? { usage } : {}) });
    delete item.dispatchToken;
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
    delete state.dispatchToken;
    delete state.acceptedDispatchToken;
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
    delete state.dispatchToken;
    delete state.acceptedDispatchToken;
    this.event(run, "result", this.scopedId(scope, step.id), { attempt, failure });
    return this.failParentRunStep(run, spec, contracts, scope, failure);
  }

  /** Evaluates a step's ensure list in order; the first failing predicate wins. */
  private async runEnsures(run: PersistedRun, step: Step, state: StepState, output: unknown, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value), fanoutItem?: FanoutEnsureContext): Promise<EnsureOutcome> {
    for (const [ensureIndex, predicate] of (step.ensure ?? []).entries()) {
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
        const usage = { ...(outcome?.usage ?? {}) };
        const judgedUsageAsReported = { ...usage };
        // A judge may report `dispatches`; that key is ledger-only (never a receipt)
        // and keeps its pre-receipt settle semantics.
        const judgedDispatches = usage.dispatches !== undefined ? { dispatches: usage.dispatches } : undefined;
        delete usage.dispatches;
        const receiptItem = fanoutItem === undefined ? undefined : state.fanout?.items[fanoutItem.itemIndex];
        const dispatchFailure = judgedDispatches !== undefined ? this.debit(run, step, state, judgedDispatches, "settle", scope) : undefined;
        const costFailure = hasBudget(usage)
          ? this.settleLegacyReceipt(run, usage, "judged", outcome?.model === undefined ? undefined : {
            model: outcome.model.length > 0 ? outcome.model : "unknown", durationMs: 0,
          }, { scope, step, state, ...(receiptItem !== undefined ? { item: receiptItem } : {}) })
          : undefined;
        const budgetFailure = worstBudget(dispatchFailure, costFailure);
        // A judged debit inside a fanout item must stay visible per item — the
        // observability contract forbids anonymous ledger movement.
        if (fanoutItem && hasBudget(judgedUsageAsReported)) {
          this.event(run, "fanout_ledger_debit", step.id, { itemIndex: fanoutItem.itemIndex, amount: judgedUsageAsReported, source: "judged" });
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
        this.recordPolicyVerdict(run, scope.flowName, step.id, ensureIndex, failureReason === undefined && outcome?.holds === true, "judged");
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
      this.recordPolicyVerdict(run, scope.flowName, step.id, ensureIndex, verdict.holds, predicateType(predicate));
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

  private settleReceipt(run: PersistedRun, receipt: ReceiptRecord, located?: LocatedStep, explicitAttempt?: number):
    | { status: "duplicate"; receipt: ReceiptRecord }
    | { status: "ok"; budget?: "flow" | "subflow" | "task" } {
    const duplicate = findReceipt(run, receipt.dispatchId);
    if (duplicate !== undefined) return { status: "duplicate", receipt: duplicate };

    const canonicalStepId = located === undefined ? undefined : this.scopedId(located.scope, located.step.id);
    if (canonicalStepId !== undefined) receipt.stepId = canonicalStepId;
    let budget: "flow" | "subflow" | "task" | undefined;
    const executable = located !== undefined && (located.step.do !== undefined || located.step.fanout !== undefined);
    if (executable) {
      budget = this.debit(run, located.step, located.state, receipt.amount, "settle", located.scope);
    } else {
      const flowLedger = new BudgetLedger(this.flowFor(run, this.validationFor(run).value).budget, run.flowSpent);
      const subflowLedger = located?.scope.parent
        ? new BudgetLedger(located.scope.parent.step.budget, located.scope.parent.state.spent)
        : undefined;
      const flowOk = flowLedger.canDebit(receipt.amount);
      const subflowOk = subflowLedger?.canDebit(receipt.amount) ?? true;
      flowLedger.debit(receipt.amount);
      subflowLedger?.debit(receipt.amount);
      Object.assign(run.flowSpent, flowLedger.spent);
      if (subflowLedger && located?.scope.parent) Object.assign(located.scope.parent.state.spent, subflowLedger.spent);
      if (!flowOk) budget = "flow";
      else if (!subflowOk) budget = "subflow";
    }

    (run.receipts ??= []).push(receipt);
    // `attempt` names the attempt the call belongs to. Legacy settles pass it (the
    // attempt record is pushed after settlement, so length+1 is that attempt);
    // external receipts get it only while the step is awaiting a result. Gates
    // and finished steps have no attempt to name.
    const attempt = explicitAttempt
      ?? (executable && (located?.item !== undefined
        ? (located.item.status === "ready" || located.item.status === "running")
        : located?.state.status === "ready")
        ? (located?.item !== undefined ? located.item.attempts.length + 1 : located!.state.attempts.length + 1)
        : undefined);
    const item = located?.item;
    const detail = {
      ...(located?.state.epoch !== undefined ? { epoch: located.state.epoch } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      ...(item?.stage !== undefined ? { item: { itemIndex: item.index, stage: item.stage, generation: item.generation } } : {}),
    };
    // One detail object serves both the audit event and the receipt row, so the
    // SmartMemory mirror carries exactly what the event stream carries.
    const eventDetail = {
      seq: receipt.seq,
      dispatchId: receipt.dispatchId,
      source: receipt.source,
      amount: { ...receipt.amount },
      model: receipt.telemetry.model,
      ...(receipt.telemetry.effort !== undefined ? { effort: receipt.telemetry.effort } : {}),
      durationMs: receipt.telemetry.durationMs,
      ...detail,
      ...(receipt.split !== undefined ? { split: { ...receipt.split } } : {}),
      ...(receipt.usdSource !== undefined ? { usdSource: receipt.usdSource } : {}),
      ...(receipt.reportedAt !== undefined ? { reportedAt: receipt.reportedAt } : {}),
    };
    receipt.detail = { ...(receipt.detail ?? {}), ...eventDetail };
    this.event(run, "usage_debit", canonicalStepId, structuredClone(eventDetail));
    return { status: "ok", ...(budget !== undefined ? { budget } : {}) };
  }

  private settleLegacyReceipt(
    run: PersistedRun,
    usage: Budget,
    source: "step_done" | "fanout" | "judged",
    telemetry: AttemptTelemetry | undefined,
    located: LocatedStep,
    usdSource?: "reported" | "estimated",
    split?: StepResult["split"],
  ): "flow" | "subflow" | "task" | undefined {
    const seq = (run.receiptCounter ?? 0) + 1;
    const receipt = buildReceipt(run, {
      dispatchId: `legacy:${seq}`,
      stepId: this.scopedId(located.scope, located.step.id),
      source,
      usage,
      ...(telemetry !== undefined ? { telemetry } : {}),
      ...(split !== undefined ? { split } : {}),
      // A connector that priced the call itself keeps "reported"; only an
      // unlabelled usd is engine-synthesized "legacy".
      ...(usage.usd !== undefined ? { usdSource: usdSource ?? "legacy" } : {}),
    });
    const attempt = (located.item?.attempts.length ?? located.state.attempts.length) + 1;
    const settled = this.settleReceipt(run, receipt, located, attempt);
    if (settled.status === "duplicate") throw new Error(`legacy receipt sequence ${seq} collided`);
    return settled.budget;
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
  private resetFrom(run: PersistedRun, scope: ExecutionScope, target: string): void {
    const { flow, steps } = scope;
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
    const reset = [...descendants].map((id) => {
      const fromEpoch = steps[id]!.epoch ?? 0;
      return { stepId: this.scopedId(scope, id), fromEpoch, toEpoch: fromEpoch + 1 };
    });
    const subflowsDropped = [...descendants].flatMap((id) =>
      steps[id]!.sub === undefined ? [] : [this.scopedId(scope, id)]);
    const detail = { reason: "revise", reset, subflowsDropped };
    this.event(run, "step_reset", this.scopedId(scope, target), detail);
    const resetReceiptSeq = (run.receiptCounter ?? 0) + 1;
    (run.receipts ??= []).push(buildReceipt(run, {
      dispatchId: `engine:step_reset:${resetReceiptSeq}`,
      source: "engine",
      usage: {},
      detail,
    }));
    const gateIds = new Set(flow.steps.flatMap((step) => step.gate !== undefined ? [step.id] : []));
    for (const id of descendants) {
      const state = steps[id]!;
      state.status = "pending";
      state.attempts = [];
      state.spent = {};
      delete state.output;
      delete state.failure;
      delete state.routed;
      delete state.dispatchToken;
      delete state.gateToken;
      delete state.acceptedDispatchToken;
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
    for (const { value } of stringLeaves(step)) {
      for (const extracted of extractReferences(value) ?? []) if (extracted.reference.kind === "step") output.add(extracted.reference.stepId);
    }
    return [...output];
  }

  private readyStep(run: PersistedRun, step: Step, state: StepState, scope: ExecutionScope = this.rootScope(run, this.validationFor(run).value)): ReadyStep {
    if (step.do === undefined) throw new Error("not a do step");
    if (state.dispatchToken === undefined) throw new Error("ready step is missing its persisted dispatch token");
    const attempt = state.attempts.length + 1;
    return {
      id: this.scopedId(scope, step.id), do: this.render(step.do, scope), agent: step.agent ?? "claude", attempt,
      epoch: state.epoch ?? 0, dispatchToken: state.dispatchToken,
      ...(state.failure ? { previousFailure: state.failure } : state.routed ? { previousFailure: state.routed } : {}),
    };
  }

  private consumerDescriptor(run: PersistedRun, spec: Specification, step: Step, state: StepState, item: FanoutItemState): ConsumerDispatchDescriptor {
    if (!step.fanout || step.fanout.dispatch !== "consumer") throw new Error("not a consumer fanout");
    if (item.status !== "ready" || item.dispatchToken === undefined || item.stage === undefined) {
      throw new Error("consumer fanout item is missing persisted readiness");
    }
    if (run.revisionDigest === undefined) throw new Error("consumer descriptor requires a persisted revision digest");
    const values = this.resolveFanoutOver(step.fanout.over, run);
    if (!Array.isArray(values)) throw new Error("fanout over must resolve to an array");
    const stage = step.fanout.steps[item.stage];
    if (!stage) throw new Error("consumer fanout stage is out of range");
    const closure = stage.out === undefined ? null : this.contractClosure(spec, stage.out);
    return {
      id: `${step.id}/${item.index}`,
      do: this.renderFanout(stage.do, run, values[item.index], item.output),
      agent: stage.agent ?? "claude",
      attempt: item.attempts.length + 1,
      epoch: item.epoch ?? state.epoch ?? 0,
      dispatchToken: item.dispatchToken,
      ...(item.failure ? { previousFailure: item.failure } : {}),
      flow: run.flowName,
      step: step.id,
      stage: item.stage,
      isFinalStage: item.stage === step.fanout.steps.length - 1,
      itemIndex: item.index,
      item: values[item.index],
      generation: item.generation,
      contract: closure,
      contractDigest: closure === null ? null : digest(closure),
      policy: {
        isolation: step.fanout.isolation,
        merge: step.fanout.merge,
        pre_merge: [...(step.fanout.pre_merge ?? [])],
      },
      revisionDigest: run.revisionDigest,
    };
  }

  private contractClosure(spec: Specification, root: string): { root: string; contracts: Record<string, Record<string, string>> } {
    const raw = spec.contracts as Record<string, Record<string, string>>;
    const reachable = new Set<string>();
    const visit = (name: string): void => {
      if (reachable.has(name)) return;
      const fields = raw[name];
      if (!fields) throw new Error(`output contract ${name} is missing`);
      reachable.add(name);
      for (const type of Object.values(fields)) {
        const referenced = contractReference(type, raw);
        if (referenced !== undefined) visit(referenced);
      }
    };
    visit(root);
    return {
      root,
      contracts: Object.fromEntries([...reachable].sort().map((name) => [name, structuredClone(raw[name]!) ])),
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
    return { input: run.input, steps: run.steps, carry: run.carry, flow: this.flowFor(run, spec), flowName: run.flowName };
  }

  /** The root scope carry is written through, sharing ONE object with the run so a write
   *  made during this pass is visible to every later read through the LIVE scope (R2-1).
   *  Null-prototype so an inherited name like `toString` can never masquerade as a
   *  declared variable (R2-3); a reloaded run's plain object is guarded by Object.hasOwn. */
  private carryScope(run: PersistedRun, spec: Specification, scope: ExecutionScope): ExecutionScope {
    const root = scope.parent === undefined ? scope : this.rootScope(run, spec);
    if (root.flow.carry === undefined) return root;      // never persist an empty carry map
    run.carry ??= Object.create(null) as Record<string, CarryEntry>;
    root.carry = run.carry;
    return root;
  }

  private childScope(spec: Specification, parentStep: Step, parentState: StepState): ExecutionScope {
    if (parentStep.run === undefined || parentState.sub === undefined) throw new Error("subflow state missing");
    const flow = spec.flows[parentStep.run];
    if (!flow || typeof flow === "string") throw new Error("subflow missing after validation");
    return {
      input: parentState.sub.input,
      steps: parentState.sub.steps,
      flow,
      flowName: parentStep.run,
      prefix: parentStep.id,
      parent: { step: parentStep, state: parentState },
    };
  }

  private locateStep(run: PersistedRun, spec: Specification, id: string): LocatedStep | undefined {
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
    if (parentStep?.fanout?.dispatch === "consumer" && parentState?.status === "running" && parentState.fanout) {
      if (!/^(0|[1-9][0-9]*)$/.test(childId)) return undefined;
      const item = parentState.fanout.items[Number(childId)];
      return item && item.index === Number(childId) ? { scope: root, step: parentStep, state: parentState, item } : undefined;
    }
    if (!parentStep || parentStep.run === undefined || !parentState?.sub || parentState.status !== "running") return undefined;
    const scope = this.childScope(spec, parentStep, parentState);
    const step = scope.flow.steps.find((candidate) => candidate.id === childId);
    const state = scope.steps[childId];
    return step && state ? { scope, step, state } : undefined;
  }

  /** Receipt attribution may arrive after a step or run terminalizes, when the
   * execution lookup intentionally hides inactive subflow/fanout state. */
  private locateReceiptStep(run: PersistedRun, spec: Specification, id: string): LocatedStep | undefined {
    const active = this.locateStep(run, spec, id);
    if (active !== undefined || !id.includes("/")) return active;
    const parts = id.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    const [parentId, childId] = parts;
    const root = this.rootScope(run, spec);
    const parentStep = root.flow.steps.find((candidate) => candidate.id === parentId);
    const parentState = root.steps[parentId];
    if (!parentStep || !parentState) return undefined;
    if (parentStep.fanout?.dispatch === "consumer" && parentState.fanout && /^(0|[1-9][0-9]*)$/.test(childId)) {
      const item = parentState.fanout.items[Number(childId)];
      return item && item.index === Number(childId) ? { scope: root, step: parentStep, state: parentState, item } : undefined;
    }
    if (parentStep.run === undefined || parentState.sub === undefined) return undefined;
    const scope = this.childScope(spec, parentStep, parentState);
    const step = scope.flow.steps.find((candidate) => candidate.id === childId);
    const state = scope.steps[childId];
    return step && state ? { scope, step, state } : undefined;
  }

  private collectReady(run: PersistedRun, spec: Specification): ReadyEntry[] {
    const root = this.rootScope(run, spec);
    const ready: ReadyEntry[] = root.flow.steps.flatMap((step) => {
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
    for (const step of root.flow.steps) {
      const state = root.steps[step.id];
      if (step.fanout?.dispatch !== "consumer" || state?.status !== "running" || !state.fanout) continue;
      for (const item of state.fanout.items) {
        if (item.status === "ready") ready.push(this.consumerDescriptor(run, spec, step, state, item));
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

  /** The single reference in a carry `initial` / `on_revise` value. Validation has
   *  already proved the shape (CARRY_REF_INVALID), so a failure here is a bug. */
  private carryReference(value: string): Reference {
    const extracted = extractReferences(value);
    const reference = extracted?.length === 1 && extracted[0]!.fullValue ? extracted[0]!.reference : undefined;
    if (!reference) throw new Error("invalid carry reference after validation");
    return reference;
  }

  private resolve(reference: Reference, scope: ExecutionScope): unknown {
    if (reference.kind === "input") return access(scope.input, reference.path);
    if (reference.kind === "step") return access(scope.steps[reference.stepId]?.output, reference.path);
    if (reference.kind === "carry") {
      // Object.hasOwn, never `?.[name]`: a persisted run reloads as a PLAIN object
      // (state.ts JSON.parse), so a variable legitimately named `toString` or
      // `constructor` would otherwise resolve to an inherited function (R2-3).
      const store = scope.carry;
      if (store === undefined || !Object.hasOwn(store, reference.name)) {
        // A named, actionable failure replaces the generic "must resolve to an array"
        // that `over` would otherwise produce two frames up (D1).
        throw new Error(`carry variable ${JSON.stringify(reference.name)} is not materialised`);
      }
      return access(store[reference.name]!.value, reference.path);
    }
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

  private assertExternalMutationAllowed(runId: string, operation: "stepDone" | "commit" | "revert" | "resume"): void {
    const bg = this.bgFlows.get(runId);
    // R4-6: commit and revert take this pre-check BEFORE the lock, and "cancelled" is not in
    // the terminal allowlist below — so a cancelled BG run would report `is background-driven`
    // while a cancelled FOREGROUND run reported `flow_cancelled`. Two errors for one
    // condition, neither of them true. Let a cancelled run through to
    // assertCancelledCheckpointRefusal, which runs inside the lock and is the truth.
    // stepDone and resume keep refusing here: both have their own cancelled refusal further in,
    // and a bg-driven run must not be externally pumped whatever its status.
    if (bg?.status === "cancelled" && (operation === "commit" || operation === "revert")) return;
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
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      throw new CheckpointOperationError("flow_not_found", `No active flow with id '${runId}'`);
    }
  }

  private nextGeneration(run: PersistedRun): number {
    const next = (run.generationCounter ?? 0) + 1;
    run.generationCounter = next;
    return next;
  }

  /** Runs persisted before token fencing carry ready/waiting issuances without
   * tokens; mint them on resume (before the resume persist) so their readiness
   * can be re-exposed instead of throwing — the state-side half of the
   * missing-echo migration compat. */
  private backfillIssuanceTokens(run: PersistedRun): void {
    const walk = (steps: Record<string, StepState>): void => {
      for (const state of Object.values(steps)) {
        if (state.status === "ready" && state.dispatchToken === undefined) state.dispatchToken = randomUUID();
        if (state.status === "waiting_gate" && state.gateToken === undefined) state.gateToken = randomUUID();
        if (state.sub) walk(state.sub.steps);
      }
    };
    walk(run.steps);
  }

  /** Checkpoints intentionally restore `steps` but not the run-global counter.
   * Rotate every restored live issuance and give every restored non-terminal
   * fanout item a fresh generation before the state can be exposed again. */
  private rotateRestoredIssuances(run: PersistedRun): void {
    const rotateSteps = (steps: Record<string, StepState>): void => {
      for (const state of Object.values(steps)) {
        if (state.status === "ready") {
          state.dispatchToken = randomUUID();
          delete state.acceptedDispatchToken;
        } else if (state.status === "waiting_gate") {
          state.gateToken = randomUUID();
        }
        for (const item of state.fanout?.items ?? []) {
          if (item.status === "succeeded" || item.status === "failed" || item.status === "skipped") continue;
          item.generation = this.nextGeneration(run);
          item.epoch = state.epoch ?? item.epoch ?? 0;
          if (item.dispatchToken !== undefined || item.status === "ready" || item.status === "running") {
            item.dispatchToken = randomUUID();
          }
          delete item.acceptedDispatchToken;
        }
        if (state.sub) rotateSteps(state.sub.steps);
      }
    };
    rotateSteps(run.steps);
  }

  // A foreground fanout runs its connector work OUTSIDE the run lock, then settles under
  // it — holding references to the pre-checkpoint step/fanout objects. A commit would
  // snapshot mid-flight state; a revert reassigns run.steps to a clone, orphaning those
  // objects so the worker's `state.fanout === fanoutRef` staleness check still passes and
  // it settles onto the restored state. Refuse both while a fanout is in flight (a fanout
  // step stays `running` from dispatch through settlement), the same quiescence the
  // detached driver already requires. bg-driven runs are covered by the ownership guard.
  /** D5/R2-10. A cancelled run is terminal. `cancelRequested` is a CHECKPOINT_FIELD, so a
   *  revert could otherwise restore `cancelRequested: false` and resurrect a run whose agents
   *  have already been killed; and a commit would snapshot a half-torn-down run as if it were
   *  a recovery point. Round 0's carve-out for commit ("snapshotting a terminal run is the
   *  documented recovery case") does not survive: that case is a run that failed on its own,
   *  whose state is coherent — a cancelled run's is mid-teardown by construction.
   *
   *  R4-6: this runs INSIDE the lock, and it is the first thing that can report on a
   *  cancelled run. assertExternalMutationAllowed's terminal allowlist does not contain
   *  "cancelled", so a cancelled BG run would otherwise report `is background-driven` while a
   *  cancelled foreground run reported `flow_cancelled` — two errors for one condition,
   *  neither of them true. */
  private assertCancelledCheckpointRefusal(run: PersistedRun, operation: "commit" | "revert"): void {
    if (run.status !== "cancelled" && run.cancelRequested !== true) return;
    throw new CheckpointOperationError("flow_cancelled", `Flow '${run.id}' is cancelled; ${operation} is not permitted`);
  }

  private assertNoForegroundFanout(run: PersistedRun, operation: "commit" | "revert"): void {
    if (run.status !== "running") return;
    const spec = this.validationFor(run).value;
    const flow = this.flowFor(run, spec);
    for (const step of flow.steps) {
      if (!step.fanout) continue;
      const state = run.steps[step.id]!;
      if (state.status === "running") {
        throw new Error(`run ${run.id} has an in-flight fanout; ${operation} must wait for it to settle`);
      }
      if (step.fanout.dispatch !== "consumer" || step.fanout.isolation !== "worktree" || state.fanout === undefined) continue;
      // Release through the SAME successor notion validation enforces — an
      // unconditional, normally-activated gate whose dependencies include the
      // fanout. Array adjacency is not that notion: the validated gate may sit
      // anywhere in the steps array.
      const routedTargets = new Set<string>();
      for (const candidate of flow.steps) {
        if (candidate.on_fail !== undefined) routedTargets.add(candidate.on_fail);
        if (candidate.gate?.on_approve) routedTargets.add(candidate.gate.on_approve);
        if (candidate.gate?.on_kill) routedTargets.add(candidate.gate.on_kill);
      }
      const qualifying = flow.steps.filter((candidate) =>
        candidate.gate !== undefined
        && candidate.when === undefined
        && !routedTargets.has(candidate.id)
        && this.dependencies(candidate).includes(step.id));
      const released = qualifying.length > 0 && qualifying.every((gate) => run.steps[gate.id]?.status === "succeeded");
      if (!released) {
        throw new Error(`run ${run.id} has an active consumer fanout lifecycle; ${operation} must wait for its successor gate to resolve`);
      }
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
    this.emitFlowTerminal(run);
    return this.response(run);
  }

  /** D3. `failure` stays UNSET: the status is honest, so inventing a FailureContext would put
   *  a lie in the audit trail (and requiredFailure would invent a worse one).
   *
   *  Cancel is exempt from both mutation guards, DELIBERATELY: not assertNoForegroundFanout —
   *  cancel exists precisely to break the stuck consumer-fanout lifecycle that guard protects
   *  — and not assertExternalMutationAllowed, because a bg-driven run is cancellable from
   *  outside. Do not "fix" the omission; it reintroduces the wedge this feature exists to
   *  break. Assumes the run lock is held: every caller is inside a locked section. */
  private async terminalCancel(run: PersistedRun, reason?: string): Promise<EngineResponse> {
    run.cancelRequested = true;
    const burned = burnIssuances(run);
    run.status = "cancelled";
    this.event(run, "flow_cancelled", undefined, { by: "fg", ...(reason !== undefined ? { reason } : {}), burned });
    // R4-1: the ONE sanctioned write of a cancelled record.
    await this.persistTerminalCancel(run);
    this.emitFlowTerminal(run);
    // A bg run cancelled through the fg surface must report consistently to flowBgPoll — but
    // only in THIS process; another engine's bgFlows map is reached by driveBg's own check.
    const bg = this.bgFlows.get(run.id);
    if (bg) { bg.cancelRequested = true; bg.status = "cancelled"; bg.pendingGates = []; }
    return this.response(run);
  }

  private async terminalFailure(run: PersistedRun, failure: FailureContext): Promise<EngineResponse> {
    run.status = "failed";
    run.failure = failure;
    this.event(run, "failed", undefined, failure);
    await this.persist(run);
    this.emitFlowTerminal(run);
    return this.response(run);
  }

  private recordPolicyVerdict(
    run: PersistedRun,
    flowName: string,
    stepId: string,
    ensureIndex: number,
    met: boolean,
    predicateTypeValue: RuleVerdict["predicate_type"],
  ): void {
    const binding = run.policy_rules?.[policyRuleKey(flowName, stepId)]?.find((candidate) => candidate.ensure_index === ensureIndex);
    if (binding === undefined) return;
    (run.policy_verdicts ??= []).push({
      rule_id: binding.rule_id,
      source: structuredClone(binding.source),
      met,
      predicate_type: predicateTypeValue,
    });
  }

  private emitFlowTerminal(run: PersistedRun): void {
    if (run.bundle_id === undefined) return;
    this.firePolicyEvent(buildFlowTerminalEvent({
      runId: run.id,
      bundleId: run.bundle_id,
      outcome: run.status,
      rulesEvaluated: run.policy_verdicts ?? [],
    }));
  }

  private firePolicyEvent(event: EnforcementEvent): void {
    void postPolicyEvent(event).catch((error) => {
      console.warn(`policy event ${event.event_id} delivery failed: ${message(error)}`);
    });
  }

  private triggerLearnEgress(runId: string): void {
    if (!this.learnEgress.enabled()) return;
    void this.learnEgress.drainRun(runId).catch((error) => {
      console.warn(`SmartMemory egress drain failed for run ${runId}: ${message(error)}`);
    });
  }

  private response(run: PersistedRun): EngineResponse {
    const ledger = this.ledgerInfo(run);
    if (run.status === "completed") return { status: "completed", runId: run.id, output: run.output, ledger };
    if (run.status === "budget_exhausted") return { status: "budget_exhausted", runId: run.id, failure: requiredFailure(run), ledger };
    // Above the failed fallthrough: requiredFailure would otherwise INVENT
    // {attempt: 0, reason: "run failed without context"} and report a cancelled run as a
    // failure with a fabricated reason (C15).
    if (run.status === "cancelled") return { status: "cancelled", runId: run.id, ledger };
    return { status: "failed", runId: run.id, failure: requiredFailure(run), ledger };
  }

  private withRevisionDigest(response: EngineResponse, run: PersistedRun): RevisionedEngineResponse {
    if (run.revisionDigest === undefined) throw new Error("run is missing its persisted revision digest");
    return { ...response, revisionDigest: run.revisionDigest };
  }

  private ledgerInfo(run: PersistedRun): LedgerInfo {
    const budget = this.flowFor(run, this.validationFor(run).value).budget;
    return { spent: structuredClone(run.flowSpent), ...(budget ? { budget: structuredClone(budget) } : {}) };
  }

  private event(run: PersistedRun, type: AuditEvent["type"], stepId?: string, detail?: unknown): void {
    run.events.push({ at: now(), type, ...(stepId ? { stepId } : {}), ...(detail !== undefined ? { detail } : {}) });
  }

  /** Every persist happens inside a locked section. A persist outside one is a lost update
   *  waiting to happen, and the three write paths this assertion caught (plan's initial
   *  persist, the engine-fanout admission writes, and `stratum learn egress`) are why it is a
   *  check rather than a comment. */
  private assertLockHeld(runId: string): void {
    if (this.heldLocks.has(runId)) return;
    const detail = `run ${runId}: persist outside a locked section`;
    if (process.env.NODE_ENV === "production") { process.stderr.write(`stratum: ${detail}\n`); return; }
    throw new Error(detail);
  }

  /** The single sanctioned save of a cancelled run: terminalCancel's own. */
  private persistTerminalCancel(run: PersistedRun): Promise<void> { return this.persist(run, true); }

  private persist(run: PersistedRun, sanctioned = false): Promise<void> {
    this.assertLockHeld(run.id);
    // R4-1: after a settle the durable record is final. Refusing is right; refusing SILENTLY
    // is not — a swallowed usageReport or receipt update is indistinguishable from one that
    // succeeded, so every unsanctioned caller reaching here surfaces instead of vanishing.
    if (run.status === "cancelled" && !sanctioned) {
      throw Object.assign(new Error(`run ${run.id} is cancelled; no further writes are accepted`),
        { code: "PERSIST_ON_CANCELLED_RUN" });
    }
    const previous = this.persistLocks.get(run.id) ?? Promise.resolve();
    const result = previous
      .then(() => this.store.save(run))
      .then(() => {
        if (this.learnEgress.enabled() && run.receipts?.some((receipt) => receipt.egress === "pending") === true) {
          this.triggerLearnEgress(run.id);
        }
      });
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

export function stringLeaves(step: Step): Array<{ value: string; expression: boolean }> {
  const values: Array<{ value: string; expression: boolean }> = [];
  const collect = (value: unknown, expression = false): void => {
    if (typeof value === "string") values.push({ value, expression });
    else if (Array.isArray(value)) value.forEach((entry) => collect(entry, expression));
    else if (typeof value === "object" && value !== null) Object.values(value).forEach((entry) => collect(entry, expression));
  };
  if (step.do !== undefined) collect(step.do);
  if (step.when !== undefined) collect(step.when, true);
  if (step.set !== undefined) collect(step.set, true);
  if (step.iterate?.until !== undefined) collect(step.iterate.until, true);
  for (const predicate of step.ensure ?? []) if ("expr" in predicate) collect(predicate.expr, true);
  // The engine's dependency edges must mirror the validator's: subflow `with`
  // templates and fanout over/stage templates reference steps too — a fanout
  // over "${prep.output.items}" must wait for prep, not fail at resolve time.
  if (step.with !== undefined) collect(step.with);
  if (step.evaluate?.in !== undefined) collect(step.evaluate.in);
  if (step.fanout !== undefined) {
    collect(step.fanout.over);
    for (const stage of step.fanout.steps) {
      collect(stage.do);
      if (stage.when !== undefined) collect(stage.when, true);
      for (const predicate of stage.ensure ?? []) if ("expr" in predicate) collect(predicate.expr, true);
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("effective specification contains a non-JSON value");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("effective specification contains a non-JSON value");
}

function terminal(status: StepState["status"]): boolean { return status === "succeeded" || status === "failed" || status === "skipped"; }
function terminalFanoutItem(status: FanoutItemState["status"]): boolean { return status === "succeeded" || status === "failed" || status === "skipped"; }
function contractReference(type: string, contracts: Record<string, Record<string, string>>): string | undefined {
  let raw = type.endsWith("?") ? type.slice(0, -1) : type;
  while (raw.endsWith("[]")) raw = raw.slice(0, -2);
  return Object.hasOwn(contracts, raw) ? raw : undefined;
}
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
/** Two settle results from one attempt collapse to the most severe ledger breach. */
function worstBudget(...results: Array<"flow" | "subflow" | "task" | undefined>): "flow" | "subflow" | "task" | undefined {
  for (const level of ["flow", "subflow", "task"] as const) if (results.includes(level)) return level;
  return undefined;
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
  const provenance = {
    ...(result.usdSource !== undefined ? { usdSource: result.usdSource } : {}),
    ...(result.split !== undefined ? { split: result.split } : {}),
  };
  if (outSchema === undefined) return { output: result.text, usage: result.usage, telemetry: result.telemetry, ...provenance };
  try {
    return { output: JSON.parse(stripJsonFences(result.text)), usage: result.usage, telemetry: result.telemetry, ...provenance };
  } catch {
    return { failure: "connector result must be JSON for a contract-enforced fanout stage", usage: result.usage, telemetry: result.telemetry, ...provenance };
  }
};

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}
