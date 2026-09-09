import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PolicyRuleMap, RuleVerdict } from "../policy/types.js";
import type { Budget } from "./ledger.js";

export type StepStatus = "pending" | "ready" | "running" | "waiting_gate" | "succeeded" | "failed" | "skipped";
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted";

export interface FailureContext {
  attempt: number;
  reason: string;
}

export interface AttemptTelemetry {
  durationMs: number;
  model: string;
  effort?: string;
}

export interface ReceiptRecord {
  seq: number;
  dispatchId: string;
  stepId?: string;
  source: string;
  amount: Budget;
  telemetry: AttemptTelemetry;
  split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
  /** "legacy": dollars arrived on a pre-receipt stepDone envelope; provenance unknown, never counted as reported. */
  usdSource?: "reported" | "estimated" | "legacy";
  reportedAt?: string;
  detail?: Record<string, unknown>;
  at: string;
  egress: "pending" | "sent" | "dead";
  egressStatus?: number;
}

export interface AttemptRecord extends Partial<AttemptTelemetry> {
  attempt: number;
  at: string;
  result?: unknown;
  failure?: FailureContext;
  usage?: Budget;
}

export interface FanoutAttemptRecord extends AttemptRecord {
  stage: number;
  failureKind?: "connector" | "usage" | "contract" | "ensure" | "iterate" | "budget";
}

export interface FanoutItemState {
  index: number;
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";
  /** Monotonic run-global identity for this enumeration; checkpoints never restore the counter. */
  generation: number;
  /** Current stage and plan epoch, persisted for restart-safe consumer descriptors. */
  stage?: number;
  epoch?: number;
  /** Current client/worker issuance; rotated for every attempt and stage. */
  dispatchToken?: string;
  /** Issuance whose accepted report terminalized this item successfully. */
  acceptedDispatchToken?: string;
  attempts: FanoutAttemptRecord[];
  output?: unknown;
  failure?: FailureContext;
  worktree?: string;
  /** Harvested worktree diff, persisted so a restart can still merge this item. */
  patch?: string;
}

export interface FanoutState {
  items: FanoutItemState[];
}

/** Structured merge-bounce record for a parallel task. */
export interface ParMergeBounce {
  /** wire: task_id */
  taskId: string;
  reason: "gate_failed" | "merge_conflict";
  files: string[];
  command: string;
  /** wire: exit_code */
  exitCode: number | null;
  excerpt: string;
}

/** Persisted state for one server-dispatched parallel task. */
export interface ParallelTaskState {
  /** wire: task_id */
  taskId: string;
  /** Default: "pending". */
  state: "pending" | "running" | "reparenting" | "complete" | "failed" | "cancelled";
  /** wire: started_at; default: null. */
  startedAt: number | null;
  /** wire: finished_at; default: null. */
  finishedAt: number | null;
  /** Default: null. */
  result: unknown;
  /** Default: null. */
  error: string | null;
  /** wire: cert_violations; default: null. */
  certViolations: unknown[] | null;
  /** wire: worktree_path; default: null. */
  worktreePath: string | null;
  /** Default: null when not captured, "" when captured with no changes. */
  diff: string | null;
  /** wire: diff_error; default: null. */
  diffError: string | null;
  /** wire: gate_bounce; default: null. */
  gateBounce: ParMergeBounce | null;
  /** Default: 0. */
  tokens: number;
  /** wire: elapsed_s; default: 0. */
  elapsedS: number;
  /** wire: dollars_recorded; default: 0. */
  dollarsRecorded: number;
  // T2-F5-RESUME reparenting is NOT produced by the TS engine (capability delta);
  // fields exist for shape parity only.
  /** wire: child_pid; default: null. */
  childPid: number | null;
  /** wire: stream_path; default: null. */
  streamPath: string | null;
  /** wire: stderr_path; default: null. */
  stderrPath: string | null;
  /** wire: proc_start_time; default: null. */
  procStartTime: string | null;
  /** wire: stream_offset; default: 0. */
  streamOffset: number;
  /** Default: false. */
  reparentable: boolean;
  /** wire: dispatch_debited; default: false. */
  dispatchDebited: boolean;
}

/** Per-flow persisted state for the currently dispatched parallel step. */
export interface ParallelRunState {
  /** wire: step_id */
  stepId: string;
  tasks: ParallelTaskState[];
}

export interface SubflowState {
  input: unknown;
  steps: Record<string, StepState>;
  /** Successful gate revisions within this subflow, scoped independently of the root run. */
  rounds?: number;
}

/** Provenance of one carry write. `sourceStep`/`sourceEpoch` are present exactly when the
 *  evaluated reference was a step reference; an `input.`-sourced initial has neither.
 *  For a revise write they name the INITIAL declaration's source step and its epoch at
 *  write time — that is the pair `materialiseCarry` compares against, so a revise value
 *  survives every advance until the initial's own source is reset. */
export interface CarryProvenance {
  kind: "initial" | "revise";
  sourceStep?: string;
  sourceEpoch?: number;
  /** Revise only: the gate step id that authorised the write. */
  gate?: string;
  /** Revise only: the consumed gate token that fenced the decision. */
  gateToken?: string;
  /** Revise only: `run.rounds` after the bump. */
  round?: number;
  at: string;
}

/** One loop-carried flow value plus the record of who last wrote it. */
export interface CarryEntry {
  value: unknown;
  provenance: CarryProvenance;
}

export interface StepState {
  status: StepStatus;
  attempts: AttemptRecord[];
  /** Bumped whenever revise resets this step; absent in older runs means epoch 0. */
  epoch?: number;
  /** Current client-executed issuance. */
  dispatchToken?: string;
  /** Current waiting-gate round issuance. */
  gateToken?: string;
  /** Issuance whose accepted report terminalized this step successfully. */
  acceptedDispatchToken?: string;
  output?: unknown;
  failure?: FailureContext;
  routed?: FailureContext;
  /** Successful bounded iterate cycles; kept separately from retry attempts. */
  iterations?: number;
  fanout?: FanoutState;
  /** Bumped when a revise invalidates a live fanout — stale executions must not touch the new one. */
  fanoutEpoch?: number;
  sub?: SubflowState;
  spent: Budget;
}

export interface AuditEvent {
  at: string;
  type: "planned" | "ready" | "result" | "judged" | "routed" | "skipped" | "resumed" | "completed" | "failed" | "budget_exhausted"
    | "gate_waiting" | "gate_resolved" | "fanout_item_ready" | "fanout_item_dispatched" | "fanout_attempt_result"
    | "fanout_item_skipped" | "fanout_ledger_debit" | "fanout_merge"
    | "usage_debit" | "step_reset" | "checkpoint_reverted" | "carry_updated";
  stepId?: string;
  detail?: unknown;
}

export type CheckpointSnapshot = Pick<PersistedRun,
  | "status" | "output" | "failure" | "flowSpent" | "rounds"
  | "steps" | "events" | "policy_verdicts" | "cancelRequested" | "parallel" | "carry"
>;

/** One named checkpoint. An ORDERED ARRAY (not a keyed map) so label order is true
 * insertion order: a plain object enumerates integer-string keys numerically, which
 * would reorder numeric labels vs Python's insertion-ordered dict. */
export interface CheckpointEntry {
  label: string;
  snapshot: CheckpointSnapshot;
}

export interface PersistedRun {
  id: string;
  spec: unknown;
  /** SHA-256 of the canonical JSON serialization of the persisted effective spec. */
  revisionDigest?: string;
  /** Monotonic fanout enumeration counter. Deliberately excluded from checkpoints. */
  generationCounter?: number;
  /** Monotonic receipt identity. Deliberately excluded from checkpoints. */
  receiptCounter?: number;
  input: unknown;
  flowName: string;
  workspaceRoot?: string;
  status: RunStatus;
  output?: unknown;
  failure?: FailureContext;
  flowSpent: Budget;
  rounds?: number;
  steps: Record<string, StepState>;
  events: AuditEvent[];
  /** Append-only model-call accounting spine. Deliberately excluded from checkpoints. */
  receipts?: ReceiptRecord[];
  /** Policy-bundle identity and ensure correlation remain additive for old-run compatibility. */
  bundle_id?: string;
  policy_rules?: PolicyRuleMap;
  /** 2 means policy rule keys are scoped as flow/step; absent is legacy. */
  policy_rules_version?: 2;
  policy_verdicts?: RuleVerdict[];
  /** Cooperative cancel: set by flowCancelBg, observed by the detached driver and
   * in-flight fanout workers so neither dispatches further work after a cancel. */
  cancelRequested?: boolean;
  /** Optional so runs created before detached-flow rehydration remain loadable. */
  bgDriven?: boolean;
  /** Optional so persisted runs created before parallel dispatch remain loadable. */
  parallel?: ParallelRunState;
  /** Named state-only snapshots in insertion order; optional so runs created before
   * checkpoints remain loadable. */
  checkpoints?: CheckpointEntry[];
  /** Loop-carried flow values keyed by declared name. Optional so runs created before
   * STRAT-LOOP-CARRY remain loadable. Root-flow only in v1 (D5). */
  carry?: Record<string, CarryEntry>;
}

let temporarySequence = 0;

export class StateStore {
  readonly root: string;

  constructor(root = join(homedir(), ".stratum", "ts", "flows")) {
    this.root = root;
  }

  async save(run: PersistedRun): Promise<void> {
    const path = this.path(run.id);
    await mkdir(dirname(path), { recursive: true });
    // pid alone collides for concurrent same-process saves; the sequence disambiguates.
    const temporary = `${path}.${process.pid}.${temporarySequence++}.tmp`;
    await writeFile(temporary, JSON.stringify(run, null, 2), "utf8");
    await rename(temporary, path);
  }

  async load(runId: string): Promise<PersistedRun> {
    const run = JSON.parse(await readFile(this.path(runId), "utf8")) as PersistedRun;
    migrateLegacyPolicyRules(run);
    return run;
  }

  async list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    return names.filter((name) => name.endsWith(".json")).sort().map((name) => name.slice(0, -".json".length));
  }

  private path(runId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid run id");
    return join(this.root, `${runId}.json`);
  }
}

function migrateLegacyPolicyRules(run: PersistedRun): void {
  if (run.policy_rules === undefined || run.policy_rules_version === 2) return;
  const scoped = new Map<string, string>();
  const flows = specificationFlows(run.spec);
  for (const [flowName, stepIds] of flows) {
    for (const stepId of stepIds) scoped.set(`${flowName}/${stepId}`, `${flowName}/${stepId}`);
  }

  const migrated: PolicyRuleMap = {};
  for (const [legacyKey, bindings] of Object.entries(run.policy_rules)) {
    let target = scoped.get(legacyKey);
    if (target === undefined) {
      const matches = flows.filter(([, stepIds]) => stepIds.has(legacyKey)).map(([flowName]) => flowName);
      if (matches.length !== 1) {
        const detail = matches.length === 0
          ? "does not exist in any flow"
          : `is ambiguous across flows ${matches.map((name) => JSON.stringify(name)).join(", ")}`;
        throw new Error(`run ${run.id}: legacy policy_rules step ${JSON.stringify(legacyKey)} ${detail}; re-plan required`);
      }
      target = `${matches[0]!}/${legacyKey}`;
    }
    (migrated[target] ??= []).push(...bindings);
  }
  run.policy_rules = migrated;
  run.policy_rules_version = 2;
}

function specificationFlows(spec: unknown): Array<[string, Set<string>]> {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return [];
  const flows = (spec as { flows?: unknown }).flows;
  if (flows === null || typeof flows !== "object" || Array.isArray(flows)) return [];
  return Object.entries(flows).flatMap(([flowName, flow]): Array<[string, Set<string>]> => {
    if (flowName === "entry" || flow === null || typeof flow !== "object" || Array.isArray(flow)) return [];
    const steps = (flow as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) return [];
    const ids = steps.flatMap((step) => {
      if (step === null || typeof step !== "object" || Array.isArray(step)) return [];
      const id = (step as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    });
    return [[flowName, new Set(ids)]];
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
