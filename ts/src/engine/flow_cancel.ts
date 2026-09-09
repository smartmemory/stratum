import { reapFlowAgents, signalFlowAgents, type AgentCancelSummary, type SweepOptions } from "../connectors/foreground_registry.js";
import type { FlowCancelResult, StratumEngine } from "./engine.js";
import type { RunStatus } from "./state.js";

export interface FlowCancelAck extends FlowCancelResult {
  /** True only when flowSettled AND every claimed agent entry is reaped or durably settled
   *  (R1-5). Never true alongside an unresolved or unreachable-unsettled entry. */
  acknowledged: boolean;
  agents: AgentCancelSummary;
}

export interface CancelFlowOptions {
  registryRoot?: string;
  timeoutMs?: number;
  reason?: string;
  /** Per-group SIGTERM→SIGKILL grace, forwarded verbatim to BOTH agent phases. It has to reach
   *  the signal pass as well as the reap: the grace clock now starts at each group's own
   *  SIGTERM, and that SIGTERM is sent during the signal pass. */
  graceMs?: number;
  identity?: SweepOptions["identity"];
  probes?: SweepOptions["probes"];
  /** OPTIONAL same-process phase (R1-4). The MCP dispatcher passes a callback that aborts
   *  every foreground AbortController belonging to this flow; the CLI passes nothing. It runs
   *  INSIDE this function, so both surfaces execute the identical ordered sequence.
   *
   *  It returns a PROMISE OF SETTLEMENT (R2-5), not void: aborting a controller starts
   *  teardown, it does not finish it, and the dispatcher already holds the `settled` promise
   *  for each foreground run. Awaiting it is what lets the sweep that follows see `settled`
   *  registry entries instead of racing the very teardown this call started. */
  abortLocal?: (flowRunId: string, remainingMs: number) => Promise<void>;
}

/** The single failure shape every cancel error carries (R3-5). */
export interface CancelFailure extends Error {
  code: "CANCELLATION_UNCONFIRMED" | "CANCELLATION_TEARDOWN_TIMEOUT";
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  agents: AgentCancelSummary;
  reason?: "run_lock_held" | "engine_dispatch_active" | "local_teardown_timeout";
  holderPid?: number;
}

export const EMPTY_AGENTS: AgentCancelSummary = Object.freeze({
  signalled: 0, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0,
});

function emptyAgents(): AgentCancelSummary { return { ...EMPTY_AGENTS }; }

function cancelError(
  code: CancelFailure["code"],
  fields: Omit<CancelFailure, keyof Error | "code">,
  message?: string,
): CancelFailure {
  const text = message ?? (fields.reason === "run_lock_held"
    ? `run ${fields.runId} lock is held${fields.holderPid !== undefined ? ` by pid ${fields.holderPid}` : ""}; cancel was not applied`
    : `cancel of run ${fields.runId} was not acknowledged`);
  return Object.assign(new Error(text), { code }, fields) as CancelFailure;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code) : undefined;
}

function pidOf(error: unknown): number | undefined {
  const pid = (error as { holderPid?: unknown } | undefined)?.holderPid;
  return typeof pid === "number" ? pid : undefined;
}

function reasonOf(error: unknown): CancelFailure["reason"] | undefined {
  const reason = (error as { reason?: unknown } | undefined)?.reason;
  return reason === "run_lock_held" || reason === "engine_dispatch_active" || reason === "local_teardown_timeout"
    ? reason : undefined;
}

/** F6. `Number("soon")` is NaN, `Date.now() + NaN` is NaN, and every `Date.now() >= deadline`
 *  test against it is false — so a mistyped budget did not shorten the teardown, it removed the
 *  deadline entirely and let the reap loop run forever. A bad value fails here instead. */
function timeoutBudgetMs(options: CancelFlowOptions): number {
  const value = options.timeoutMs ?? Number(process.env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${options.timeoutMs !== undefined ? "timeoutMs" : "STRATUM_CANCEL_TIMEOUT_MS"} must be a nonnegative finite number`);
  }
  return value;
}

/** The phases of a foreground cancel, shared by the MCP tool and the CLI. Both surfaces call
 *  this and NOTHING else (R1-4) — a phase implemented at one call site is a phase the other
 *  surface silently lacks.
 *
 *  Order (R2-5): SETTLE → signal every recorded group → await the local abort's settlement →
 *  await the reap and the registry settlement → compute `acknowledged`.
 *
 *  Settling first (D4) means the acknowledgement is never lost to a hung teardown: the run is
 *  durably cancelled before a single signal is sent, and a teardown failure is reported ON TOP
 *  of a completed settle. Signalling before awaiting the local abort matters because the two
 *  teardowns overlap — SIGTERM to a group and an AbortController on the same run are the same
 *  child from two directions — and serialising them would add a full grace window per agent.
 *  Awaiting the local settlement BEFORE the reap pass is what stops the sweep from reading
 *  `running` entries whose teardown this very call started (R2-5).
 *
 *  A terminal run that was not cancelled skips the agent phases entirely (R2-4): there are no
 *  agents of ours to reap, and sweeping would manufacture a teardown verdict about work that
 *  was never ours. An ALREADY-cancelled run does not skip them — re-running the sweep is how a
 *  caller recovers from an earlier CANCELLATION_TEARDOWN_TIMEOUT. */
export async function cancelFlow(
  engine: Pick<StratumEngine, "flowCancel">,
  runId: string,
  options: CancelFlowOptions = {},
): Promise<FlowCancelAck> {
  // Phase 1: settle, and SETTLE FIRST IS ABSOLUTE. A refusal here means the flow is still
  // running, so NO agent is signalled or reaped: killing a live driver's agents without
  // settling the flow leaves a live flow with dead agents, which is the hazard R1-4 forbids.
  // The refusal returns an all-zero agents summary because no teardown was attempted.
  //
  // A RUN_LOCK_TIMEOUT or a live driver lease here means nothing was mutated
  // (§2.1b) — normalise both rather than letting a raw engine error reach a surface that has
  // no envelope for it (R3-5). Every other error (ENOENT for an unknown flow above all)
  // propagates untouched: the CLI maps it, and inventing a cancellation code for it would
  // report a teardown verdict about a run we never found.
  let settled: FlowCancelResult;
  try {
    settled = await engine.flowCancel(runId, options.reason);
  } catch (error) {
    const code = codeOf(error);
    if (code !== "RUN_LOCK_TIMEOUT" && code !== "CANCELLATION_UNCONFIRMED") throw error;
    const holderPid = pidOf(error);
    throw cancelError("CANCELLATION_UNCONFIRMED", {
      runId,
      status: "running",
      flowSettled: false,
      agents: emptyAgents(),
      reason: code === "RUN_LOCK_TIMEOUT" ? "run_lock_held" : (reasonOf(error) ?? "engine_dispatch_active"),
      ...(holderPid !== undefined ? { holderPid } : {}),
    }, error instanceof Error ? error.message : undefined);
  }
  if (!settled.flowSettled) {
    // completed / failed / budget_exhausted: nothing of ours is running (R2-4).
    return { ...settled, acknowledged: false, agents: emptyAgents() };
  }
  // R3-5: ONE absolute teardown deadline, computed here — after settlement, so the lock wait
  // never eats into it — and shared by every phase. Three independent per-phase timeouts is how
  // a caller ends up waiting 3x the budget it configured, and how a slow signal pass silently
  // leaves no time to reap.
  const deadline = Date.now() + timeoutBudgetMs(options);
  const remaining = (): number => Math.max(0, deadline - Date.now());
  const registryOptions: SweepOptions = {
    ...(options.registryRoot !== undefined ? { registryRoot: options.registryRoot } : {}),
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
    ...(options.probes !== undefined ? { probes: options.probes } : {}),
    deadlineAt: deadline,
  };

  // The signal pass gets the SAME absolute deadline as the reap. A signal pass with no deadline
  // can spend the whole budget probing and then hand the reap nothing, and can keep sending
  // SIGTERMs after the caller has stopped waiting for an answer to any of them.
  const signalled = await signalFlowAgents(runId, registryOptions);
  // An abortLocal that times out does NOT abort the cancel: the groups were already signalled
  // and the reap is the authority on whether they died. Record it and keep going (R3-5).
  let localTimedOut = false;
  try {
    await options.abortLocal?.(runId, remaining());
  } catch (error) {
    if (codeOf(error) !== "CANCELLATION_TEARDOWN_TIMEOUT") throw error;
    localTimedOut = true;
  }
  const agents = await reapFlowAgents(runId, signalled, registryOptions);
  // R1-5: acknowledged is a GUARANTEE, not a summary. Anything unresolved is an error.
  // R3-6: unsettled is the strongest of the three and subsumes "groups reaped but the owning
  // dispatcher is still unwinding". All four must be clear.
  // Acknowledgement is "every group reached a final resolved state and nothing is outstanding",
  // NOT the old `signalled === reaped` equality. That equality failed both ways: a group that
  // had already exited before our SIGTERM is never counted `signalled`, so a flow whose agent
  // died on its own could never be acknowledged; and a group signalled and later found
  // unreachable satisfied it by accident.
  const acknowledged = settled.flowSettled
    && agents.unsettled === 0
    && agents.unresolved === 0
    && agents.unreachable === 0
    && agents.unreaped === 0;
  if (!acknowledged) {
    const code = agents.unreachable > 0 && agents.unresolved === 0 && agents.unreaped === 0
      ? "CANCELLATION_UNCONFIRMED"
      : "CANCELLATION_TEARDOWN_TIMEOUT";
    // R3-5: every failure leaves this function as ONE structured error with the same fields,
    // so the MCP and CLI projections have exactly one shape to render. `status` and
    // `flowSettled` come from the engine, never from an assumption (R1-5).
    throw cancelError(code, {
      runId, status: settled.status, flowSettled: settled.flowSettled, agents,
      ...(localTimedOut ? { reason: "local_teardown_timeout" as const } : {}),
    });
  }
  return { ...settled, acknowledged, agents };
}
