import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
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

export interface SubflowState {
  input: unknown;
  steps: Record<string, StepState>;
}

export interface StepState {
  status: StepStatus;
  attempts: AttemptRecord[];
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
    | "fanout_item_skipped" | "fanout_ledger_debit" | "fanout_merge";
  stepId?: string;
  detail?: unknown;
}

export interface PersistedRun {
  id: string;
  spec: unknown;
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
    return JSON.parse(await readFile(this.path(runId), "utf8")) as PersistedRun;
  }

  private path(runId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid run id");
    return join(this.root, `${runId}.json`);
  }
}
