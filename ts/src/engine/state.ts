import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Budget } from "./ledger.js";

export type StepStatus = "pending" | "ready" | "succeeded" | "failed" | "skipped";
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted";

export interface FailureContext {
  attempt: number;
  reason: string;
}

export interface AttemptRecord {
  attempt: number;
  at: string;
  result?: unknown;
  failure?: FailureContext;
  usage?: Budget;
}

export interface StepState {
  status: StepStatus;
  attempts: AttemptRecord[];
  output?: unknown;
  failure?: FailureContext;
  routed?: FailureContext;
  spent: Budget;
}

export interface AuditEvent {
  at: string;
  type: "planned" | "ready" | "result" | "routed" | "skipped" | "resumed" | "completed" | "failed" | "budget_exhausted";
  stepId?: string;
  detail?: unknown;
}

export interface PersistedRun {
  id: string;
  spec: unknown;
  input: unknown;
  flowName: string;
  status: RunStatus;
  output?: unknown;
  failure?: FailureContext;
  flowSpent: Budget;
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
