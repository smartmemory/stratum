import type { PersistedRun, ReceiptRecord } from "../engine/state.js";
import { StateStore } from "../engine/state.js";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const DEAD_STATUSES = new Set([400, 401, 403, 404, 422]);
const MEMORY_TYPES = [
  "stratum_usage_debit",
  "stratum_step_reset",
  "stratum_checkpoint_reverted",
] as const;

type MemoryType = typeof MEMORY_TYPES[number];
type FetchResponse = Pick<Response, "ok" | "status" | "json">;
export type LearnEgressFetch = (input: string | URL | Request, init?: RequestInit) => Promise<FetchResponse>;
export type WithReceiptUpdate = <T>(
  runId: string,
  update: (run: PersistedRun) => T | Promise<T>,
) => Promise<T>;
type TimeoutHandle = ReturnType<typeof setTimeout>;

interface BackoffState {
  consecutiveFailures: number;
  nextAttemptAt: number;
}

interface DrainState {
  dirty: boolean;
  inFlight: Promise<void> | undefined;
}

interface DrainSnapshot {
  id: string;
  flowName: string;
  workspaceRoot?: string;
  revisionDigest?: string;
  pending: ReceiptRecord[];
}

interface ReceiptTransition {
  seq: number;
  egress: "sent" | "dead";
  status?: number;
}

export interface LearnEgressDriver {
  enabled(): boolean;
  drainRun(runId: string): Promise<void>;
  drainAll(): Promise<void>;
  close(): Promise<void>;
}

export interface LearnEgressOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: LearnEgressFetch;
  now?: () => number;
  random?: () => number;
  warn?: (message: string) => void;
  setTimeoutImpl?: (callback: () => void, milliseconds: number) => TimeoutHandle;
  clearTimeoutImpl?: (handle: TimeoutHandle) => void;
  store: StateStore;
  withReceiptUpdate: WithReceiptUpdate;
  /** The READ half of `withReceiptUpdate` (F3). Taking a drain snapshot through the mutating
   *  path re-saves the record it only meant to read — which is how a pure read reverted a
   *  concurrent driver's writes and tripped the cancelled-run guard. Defaults to
   *  `withReceiptUpdate` so an existing caller keeps its current behaviour. */
  withReceiptRead?: WithReceiptUpdate;
}

export type LearnEgressRuntimeOptions = Omit<LearnEgressOptions, "store" | "withReceiptUpdate" | "withReceiptRead">;

export interface EgressVerifyReport {
  runId: string;
  receiptCount: number;
  missingCount: number;
  duplicateCount: number;
  wrongTypeCount: number;
  deadCount: number;
}

export class LearnEgress implements LearnEgressDriver {
  private readonly url: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly workspaceId: string | undefined;
  private readonly optedIn: boolean;
  private readonly fetchImpl: LearnEgressFetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly warn: (message: string) => void;
  private readonly setTimeoutImpl: (callback: () => void, milliseconds: number) => TimeoutHandle;
  private readonly clearTimeoutImpl: (handle: TimeoutHandle) => void;
  private readonly store: StateStore;
  private readonly withReceiptUpdate: WithReceiptUpdate;
  private readonly withReceiptRead: WithReceiptUpdate;
  private readonly drains = new Map<string, DrainState>();
  private readonly backoffs = new Map<string, BackoffState>();
  private workspaceWarningIssued = false;

  constructor(options: LearnEgressOptions) {
    const env = options.env ?? process.env;
    const url = env.SMARTMEMORY_API_URL?.replace(/\/+$/, "");
    this.url = url ? url : undefined;
    this.apiKey = env.SMARTMEMORY_API_KEY || undefined;
    this.workspaceId = env.SMARTMEMORY_WORKSPACE_ID || undefined;
    this.optedIn = env.STRATUM_LEARN_EGRESS === "1";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.warn = options.warn ?? ((warning) => console.warn(warning));
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.store = options.store;
    this.withReceiptUpdate = options.withReceiptUpdate;
    this.withReceiptRead = options.withReceiptRead ?? options.withReceiptUpdate;
  }

  enabled(): boolean {
    if (!this.optedIn || this.url === undefined || this.apiKey === undefined) return false;
    if (this.workspaceId !== undefined) return true;
    if (!this.workspaceWarningIssued) {
      this.workspaceWarningIssued = true;
      this.warn("SmartMemory receipt egress is disabled: SMARTMEMORY_WORKSPACE_ID is required");
    }
    return false;
  }

  async drainRun(runId: string): Promise<void> {
    if (!this.enabled()) return;
    let state = this.drains.get(runId);
    if (state === undefined) {
      state = { dirty: false, inFlight: undefined };
      this.drains.set(runId, state);
    }
    state.dirty = true;
    if (state.inFlight === undefined) this.startDrain(runId, state);
    await state.inFlight;
  }

  async drainAll(): Promise<void> {
    if (!this.enabled()) return;
    try {
      await Promise.all((await this.store.list()).map((runId) => this.drainRun(runId)));
    } catch (error) {
      this.warn(`SmartMemory egress reconciliation failed: ${message(error)}`);
    }
  }

  async close(): Promise<void> {
    for (;;) {
      const inFlight = [...this.drains.values()].flatMap((state) => state.inFlight ? [state.inFlight] : []);
      if (inFlight.length === 0) return;
      await Promise.all(inFlight);
    }
  }

  async verifyRun(runId: string): Promise<EgressVerifyReport> {
    if (!this.enabled()) {
      throw new Error("SmartMemory egress is disabled: STRATUM_LEARN_EGRESS=1 and SMARTMEMORY_API_URL/API_KEY/WORKSPACE_ID are required");
    }
    const run = await this.store.load(runId);
    const local = run.receipts ?? [];
    let missingCount = 0;
    let duplicateCount = 0;
    let wrongTypeCount = 0;

    for (const receipt of local) {
      const receiptId = `${runId}:${receipt.seq}`;
      const expectedType = memoryTypeFor(receipt);
      const expectedHits = await this.exactHits(receiptId, expectedType);
      if (expectedHits.length > 0) {
        duplicateCount += expectedHits.length - 1;
        continue;
      }

      missingCount += 1;
      for (const otherType of MEMORY_TYPES) {
        if (otherType === expectedType) continue;
        wrongTypeCount += (await this.exactHits(receiptId, otherType)).length;
      }
    }

    return {
      runId,
      receiptCount: local.length,
      missingCount,
      duplicateCount,
      wrongTypeCount,
      deadCount: local.filter((receipt) => receipt.egress === "dead").length,
    };
  }

  async retryDead(runId: string): Promise<number> {
    let retried = 0;
    try {
      retried = await this.withReceiptUpdate(runId, (run) => {
        let changed = 0;
        for (const receipt of run.receipts ?? []) {
          if (receipt.egress !== "dead") continue;
          receipt.egress = "pending";
          delete receipt.egressStatus;
          changed += 1;
        }
        return changed;
      });
      await this.drainRun(runId);
    } catch (error) {
      this.warn(`SmartMemory egress could not retry dead receipts for run ${runId}: ${message(error)}`);
    }
    return retried;
  }

  private startDrain(runId: string, state: DrainState): void {
    const inFlight = this.drainLoop(runId, state)
      .catch((error) => {
        this.warn(`SmartMemory egress could not drain run ${runId}: ${message(error)}`);
      })
      .finally(() => {
        state.inFlight = undefined;
        if (state.dirty) this.startDrain(runId, state);
        else if (this.drains.get(runId) === state) this.drains.delete(runId);
      });
    state.inFlight = inFlight;
  }

  private async drainLoop(runId: string, state: DrainState): Promise<void> {
    while (state.dirty) {
      state.dirty = false;
      await this.drainOnce(runId);
    }
  }

  private async drainOnce(runId: string): Promise<void> {
    const backoff = this.backoffs.get(runId);
    if (backoff !== undefined && this.now() < backoff.nextAttemptAt) return;

    const snapshot = await this.withReceiptRead(runId, (run): DrainSnapshot => ({
      id: run.id,
      flowName: run.flowName,
      ...(run.workspaceRoot !== undefined ? { workspaceRoot: run.workspaceRoot } : {}),
      ...(run.revisionDigest !== undefined ? { revisionDigest: run.revisionDigest } : {}),
      pending: (run.receipts ?? [])
        .filter((receipt) => receipt.egress === "pending")
        .sort((left, right) => left.seq - right.seq)
        .map((receipt) => structuredClone(receipt)),
    }));
    if (snapshot.pending.length === 0) return;

    const transitions: ReceiptTransition[] = [];
    for (const receipt of snapshot.pending) {
      let response: FetchResponse | undefined;
      let failure: unknown;
      try {
        response = await this.add(snapshot, receipt);
      } catch (error) {
        failure = error;
      }
      if (response?.ok) {
        transitions.push({ seq: receipt.seq, egress: "sent" });
        this.resetBackoff(runId);
        continue;
      }
      if (response !== undefined && DEAD_STATUSES.has(response.status)) {
        transitions.push({ seq: receipt.seq, egress: "dead", status: response.status });
        this.warn(`SmartMemory egress dead-lettered ${snapshot.id}:${receipt.seq}: HTTP ${response.status}`);
        continue;
      }

      this.recordFailure(runId);
      const detail = response === undefined ? message(failure) : `HTTP ${response.status}`;
      this.warn(`SmartMemory egress stopped at ${snapshot.id}:${receipt.seq}: ${detail}`);
      break;
    }

    if (transitions.length === 0) return;
    await this.withReceiptUpdate(runId, (run) => {
      const bySequence = new Map((run.receipts ?? []).map((receipt) => [receipt.seq, receipt]));
      for (const transition of transitions) {
        const receipt = bySequence.get(transition.seq);
        if (receipt === undefined || receipt.egress !== "pending") continue;
        receipt.egress = transition.egress;
        if (transition.status === undefined) delete receipt.egressStatus;
        else receipt.egressStatus = transition.status;
      }
    });
  }

  private async add(run: DrainSnapshot, receipt: ReceiptRecord): Promise<FetchResponse> {
    return this.request(`${this.url!}/memory/add`, {
      content: summary(run, receipt),
      memory_type: memoryTypeFor(receipt),
      metadata: {
        ...receipt,
        ...(receipt.detail !== undefined ? { detail: receipt.detail } : {}),
        run_id: run.id,
        workspace_root: run.workspaceRoot ?? null,
        flow_name: run.flowName,
        spec_digest: run.revisionDigest ?? null,
        event_ordinal: receipt.seq,
        receipt_id: `${run.id}:${receipt.seq}`,
        origin: "cli:stratum",
      },
      use_pipeline: false,
    });
  }

  private async exactHits(receiptId: string, memoryType: MemoryType): Promise<unknown[]> {
    const response = await this.request(`${this.url!}/memory/search`, {
      query: receiptId,
      memory_type: memoryType,
      top_k: 20,
    });
    if (!response.ok) throw new Error(`SmartMemory verify failed for ${memoryType}: HTTP ${response.status}`);
    const payload = await response.json() as { results?: unknown };
    if (!Array.isArray(payload.results)) throw new Error(`SmartMemory verify returned no results array for ${memoryType}`);
    return payload.results.filter((result) =>
      resultReceiptId(result) === receiptId && resultMemoryType(result) === memoryType);
  }

  private async request(url: string, body: unknown): Promise<FetchResponse> {
    const controller = new AbortController();
    const timeout = this.setTimeoutImpl(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey!}`,
          "X-Workspace-Id": this.workspaceId!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      this.clearTimeoutImpl(timeout);
    }
  }

  private recordFailure(runId: string): void {
    const current = this.backoffs.get(runId) ?? { consecutiveFailures: 0, nextAttemptAt: 0 };
    current.consecutiveFailures += 1;
    const exponent = Math.min(current.consecutiveFailures - 1, 20);
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * (2 ** exponent));
    const jittered = Math.min(MAX_BACKOFF_MS, base + (base * 0.2 * this.random()));
    current.nextAttemptAt = this.now() + jittered;
    this.backoffs.set(runId, current);
  }

  private resetBackoff(runId: string): void {
    this.backoffs.delete(runId);
  }
}

function memoryTypeFor(receipt: ReceiptRecord): MemoryType {
  if (receipt.source === "engine" && receipt.dispatchId.startsWith("engine:step_reset:")) return "stratum_step_reset";
  if (receipt.source === "engine" && receipt.dispatchId.startsWith("engine:checkpoint_reverted:")) return "stratum_checkpoint_reverted";
  return "stratum_usage_debit";
}

function summary(run: Pick<PersistedRun, "flowName">, receipt: ReceiptRecord): string {
  const tokens = receipt.amount.tokens ?? 0;
  const milliseconds = receipt.amount.ms ?? receipt.telemetry.durationMs;
  return `${run.flowName}/${receipt.stepId ?? "run"} ${receipt.source} (${receipt.telemetry.model}): ${tokens} tokens, ${milliseconds} ms`;
}

function resultReceiptId(result: unknown): string | undefined {
  return resultField(result, (value) => {
    if (typeof value.receipt_id === "string") return value.receipt_id;
    if (typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata)) return undefined;
    const receiptId = (value.metadata as Record<string, unknown>).receipt_id;
    return typeof receiptId === "string" ? receiptId : undefined;
  });
}

function resultMemoryType(result: unknown): string | undefined {
  return resultField(result, (value) => {
    if (typeof value.memory_type === "string") return value.memory_type;
    if (typeof value.metadata !== "object" || value.metadata === null || Array.isArray(value.metadata)) return undefined;
    const memoryType = (value.metadata as Record<string, unknown>).memory_type;
    return typeof memoryType === "string" ? memoryType : undefined;
  });
}

function resultField(
  result: unknown,
  read: (value: Record<string, unknown>) => string | undefined,
): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const row = result as Record<string, unknown>;
  const direct = read(row);
  if (direct !== undefined) return direct;
  for (const key of ["item", "context"] as const) {
    const nested = row[key];
    if (typeof nested !== "object" || nested === null || Array.isArray(nested)) continue;
    const found = read(nested as Record<string, unknown>);
    if (found !== undefined) return found;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
