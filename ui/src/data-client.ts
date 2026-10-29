/**
 * DataClient: the ONE seam between @stratum/ui components and wherever run data lives.
 *
 * Components never fetch. They read this interface from <DataClientProvider> and call its
 * async methods. Two implementations exist / are planned:
 *   - the standalone shell (`ui/shell/http-client.ts`) talks to `ui/server/` over HTTP;
 *   - Compose (COMPOSE-STRAT-TAB-1) supplies its own, over its `/api/stratum/*` router.
 *
 * Shapes mirror the engine's persisted run (`ts/src/engine/state.ts` PersistedRun,
 * StepState, AuditEvent) trimmed to what a viewer needs: receipts, checkpoints, carry,
 * lessons and parallel-task internals are dropped server-side. Status words are the
 * engine's own (`state.ts:8-9`); `displayStatus` is the `stratum query flows` projection
 * (`ts/src/cli/query_gate.ts` projectStatus), so a Compose client wrapping the CLI and the
 * standalone server reading files agree on what "killed" or "awaiting_gate" means.
 *
 * Contract version: bump CONTRACT_VERSION on any breaking change to these types.
 */

export const CONTRACT_VERSION = 1 as const;

/** Engine step status (`state.ts:8`). */
export type StepStatus = "pending" | "ready" | "running" | "waiting_gate" | "succeeded" | "failed" | "skipped";
/** Engine run status (`state.ts:9`). */
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted" | "cancelled";
/** `stratum query flows` projection (`query_gate.ts` projectStatus). */
export type DisplayStatus = "complete" | "running" | "awaiting_gate" | "failed" | "budget_exhausted" | "killed" | "cancelled";
/** The six step kinds (`ir/schema.ts:91-96`, exactly one per step). */
export type StepKind = "do" | "set" | "gate" | "fanout" | "run" | "evaluate";

/** Engine budget ledger (`engine/ledger.ts` Budget). Every field optional on old runs. */
export interface Spent {
  dispatches?: number;
  usd?: number;
  tokens?: number;
  ms?: number;
}

export interface FailureInfo {
  attempt: number;
  reason: string;
}

/** One row of the runs list. */
export interface RunSummary {
  id: string;
  flowName: string;
  status: RunStatus;
  displayStatus: DisplayStatus;
  stepCount: number;
  /** succeeded + skipped, as `stratum query flows` counts them. */
  completedSteps: number;
  currentStepId: string | null;
  round: number;
  /** First event's `at` (the `planned` event); null when the run has no events. */
  startedAt: string | null;
  /** Last event's `at`. */
  updatedAt: string | null;
  spent: Spent;
  /** Steps waiting on a gate right now. */
  waitingGates: number;
}

/**
 * One step as authored in the spec (`ir/schema.ts` Step), passed through unmodified apart
 * from the derived `kind`. Kept loose on purpose: the UI reads `id`, `after`, `when`,
 * `on_fail`, `gate`, `fanout` and string leaves for `${step.output}` edges, and shows the
 * rest as JSON.
 */
export interface StepSpec {
  id: string;
  kind: StepKind;
  after?: string[] | null;
  when?: unknown;
  on_fail?: string | null;
  gate?: { on_approve?: string | null; on_revise?: string | null; on_kill?: string | null } & Record<string, unknown>;
  fanout?: { over?: unknown; steps?: Array<Record<string, unknown>> } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface AttemptView {
  attempt: number;
  at: string;
  result?: unknown;
  failure?: FailureInfo;
  usage?: Spent;
  durationMs?: number;
  model?: string;
  effort?: string;
}

export interface FanoutItemView {
  index: number;
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";
  stage?: number;
  attempts: AttemptView[];
  output?: unknown;
  failure?: FailureInfo;
}

/** Engine StepState (`state.ts:177-200`) minus tokens, lessons and fanout internals. */
export interface StepStateView {
  status: StepStatus;
  attempts: AttemptView[];
  epoch?: number;
  output?: unknown;
  failure?: FailureInfo;
  routed?: FailureInfo;
  iterations?: number;
  spent?: Spent;
  fanout?: { items: FanoutItemView[] };
  /** Sub-flow (`run:` step) step states, same shape, one level deep. */
  sub?: { steps: Record<string, StepStateView>; rounds?: number };
}

/** Engine AuditEvent (`state.ts:203-210`). `type` is open: the engine adds kinds over time. */
export interface RunEvent {
  at: string;
  type: string;
  stepId?: string;
  detail?: unknown;
}

export interface RunDetail extends RunSummary {
  /** Steps of the run's own flow, in spec order. */
  steps: StepSpec[];
  /** Live state per step id. A step missing here has not been planned yet (render as pending). */
  stepStates: Record<string, StepStateView>;
  events: RunEvent[];
  /**
   * The flow's `max_rounds` (total revise budget). null means the flow declares none, and then
   * the engine treats ANY revise as exhausting the rounds and fails the run (`engine.ts` gateResolve).
   */
  maxRounds: number | null;
  input?: unknown;
  output?: unknown;
  failure?: FailureInfo;
  /** Set when the run file exists but its spec could not be read as a flow. */
  specError?: string;
}

/** One gate awaiting a decision (`stratum query gates`, `query_gate.ts:168-191`). */
export interface PendingGate {
  runId: string;
  flowName: string;
  stepId: string;
  /**
   * The waiting round's token. The CLI REQUIRES it at resolve time and never re-reads it
   * (`query_gate.ts` parseGate, "S1"), so a stale round is refused instead of silently
   * approving a newer one. Echo it back in ResolveGateRequest unchanged.
   */
  gateToken: string | null;
  onApprove: string | null;
  onRevise: string | null;
  onKill: string | null;
  /** Revisions used so far in this run (`run.rounds`). */
  round: number;
  /** Flow `max_rounds`; null = none declared (a revise then fails the run). */
  maxRounds: number | null;
  /**
   * True when a revise right now would end the run instead of re-running `onRevise`: no
   * route, no flow max_rounds, the flow budget spent, or the gate's own max_rounds spent
   * (`engine.ts` gateResolve preflight). The UI warns before sending it.
   */
  reviseEndsRun: boolean;
  /** `at` of the latest `gate_waiting` event for this step, if any. */
  waitingSince: string | null;
}

export type GateAction = "approve" | "reject" | "revise";

export interface ResolveGateRequest {
  runId: string;
  stepId: string;
  action: GateAction;
  /** Required for revise by the UI; the v1 CLI accepts and drops it (`query_gate.ts` gateCommand). */
  note?: string;
  /** From PendingGate.gateToken. */
  gateToken: string;
}

export type GateResolution =
  | { ok: true; runId: string; stepId: string; outcome: "approve" | "kill" | "revise"; result: string }
  /** `conflict`: the run finished or the gate moved on (CLI exit 2). `error`: anything else. */
  | { ok: false; kind: "conflict" | "error"; code: string; message: string };

export interface DataClient {
  /** All runs, newest first. */
  listRuns(): Promise<RunSummary[]>;
  /** One run, or null when no such run exists. */
  getRun(runId: string): Promise<RunDetail | null>;
  /** Every gate currently awaiting a decision, across runs. */
  listGates(): Promise<PendingGate[]>;
  /** Approve, reject (kill) or revise one waiting gate. Never throws for a refusal; returns ok:false. */
  resolveGate(request: ResolveGateRequest): Promise<GateResolution>;
}
