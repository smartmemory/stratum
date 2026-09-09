import { StratumEngine } from "../engine/engine.js";
import { cancelFlow, type CancelFailure } from "../engine/flow_cancel.js";
import { StateStore } from "../engine/state.js";
import { createEvaluator } from "../eval/expr.js";
import { createEvaluateRunner } from "../engine/evaluate.js";
import { message, writeJson } from "./query_gate.js";

/** `stratum flow cancel <flow_id>` — the CLI half of STRAT-FLOW-CANCEL-FG.
 *
 *  It runs the identical phase sequence as the MCP tool because both call `cancelFlow` and
 *  nothing else (R1-4). The one asymmetry is a parameter, not a code path: this process holds
 *  no foreground AbortControllers, so it passes no `abortLocal` and the registry sweep does
 *  all the work. */
export async function flowCommand(args: string[]): Promise<number> {
  if (args[0] !== "cancel" || args.length !== 2) {
    process.stderr.write("Usage: stratum flow cancel <flow_id>\n");
    return 2;
  }
  const runId = args[1]!;
  const root = process.env.STRATUM_STATE_ROOT || new StateStore().root;
  const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), evaluateRunner: createEvaluateRunner() });
  try {
    const ack = await cancelFlow(engine, runId);
    // R1-8: an already-terminal flow is a SUCCESS, not a conflict. The caller asked for the
    // flow to be stopped and the flow is stopped; exit 2 here maps to {conflict:true} in
    // compose's mutation client and would make every idempotent abort look like a failure.
    writeJson({
      _schema_version: "1", ok: true, flow_id: runId, status: ack.status,
      flowSettled: ack.flowSettled, acknowledged: ack.acknowledged, agents: ack.agents,
      ...(ack.reason !== undefined ? { detail: ack.reason } : {}),
    });
    return 0;
  } catch (error) {
    // An unknown flow is a CONFLICT (exit 2), the shape `stratum gate` already uses — reached
    // by an explicit ENOENT test, never by falling through to the catch-all.
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      writeJson({ _schema_version: "1", conflict: true, flow_id: runId, detail: "flow_not_found" });
      process.stderr.write(`stratum flow cancel: flow '${runId}' not found\n`);
      return 2;
    }
    const failure = error as Partial<CancelFailure> & Error;
    if (failure.code === "CANCELLATION_TEARDOWN_TIMEOUT" || failure.code === "CANCELLATION_UNCONFIRMED") {
      // Structured, not just a message: the caller must be able to see that the FLOW is
      // settled even though an agent was not confirmed dead. R3-5: print reason and holderPid
      // — "the run is locked by pid 41823" is actionable; "cancel not acknowledged" is not.
      writeJson({
        _schema_version: "1", ok: false, error: failure.code, flow_id: runId,
        status: failure.status, flowSettled: failure.flowSettled, agents: failure.agents,
        ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
        ...(failure.holderPid !== undefined ? { holderPid: failure.holderPid } : {}),
        message: failure.message,
      });
      process.stderr.write(`stratum flow cancel: ${failure.message}\n`);
      return 1;
    }
    writeJson({ _schema_version: "1", ok: false, error: "INVALID", flow_id: runId, message: message(error) });
    process.stderr.write(`stratum flow cancel: ${message(error)}\n`);
    return 1;
  }
}
