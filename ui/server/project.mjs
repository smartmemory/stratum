// Pure projection: a persisted run document (`~/.stratum/ts/flows/<id>.json`, type
// PersistedRun in ts/src/engine/state.ts:226-260) → the DataClient shapes in
// ui/src/data-client.ts. No IO here, so it is unit-tested directly.

const KINDS = ["do", "set", "gate", "fanout", "run", "evaluate"];

/** @param {any} run */
export function flowOf(run) {
  const flow = run?.spec?.flows?.[run.flowName];
  return flow && typeof flow === "object" && Array.isArray(flow.steps) ? flow : undefined;
}

/** Structural floor, same as query_gate.ts isProjectableRun. */
export function isRun(run) {
  return typeof run === "object" && run !== null
    && typeof run.id === "string" && typeof run.flowName === "string" && typeof run.status === "string"
    && typeof run.steps === "object" && run.steps !== null
    && typeof run.spec === "object" && run.spec !== null;
}

/**
 * Mirrors `projectStatus` (ts/src/cli/query_gate.ts). One difference: `killed` here does not
 * re-run the spec validator (the CLI refuses to call a malformed spec's fake gate a kill);
 * the gate inbox itself always comes from the CLI.
 */
export function displayStatus(run) {
  if (run.status === "completed") return "complete";
  if (run.status === "budget_exhausted") return "budget_exhausted";
  if (run.status === "failed" && run.failure?.attempt === 0) {
    const flow = flowOf(run);
    if (flow?.steps.some((step) => step?.gate !== undefined && run.failure?.reason === `gate ${step.id} killed flow`)) return "killed";
  }
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "failed") return "failed";
  if (Object.values(run.steps).some((step) => step?.status === "waiting_gate")) return "awaiting_gate";
  return "running";
}

/** query_gate.ts currentStepId. */
function currentStepId(run, flow) {
  if (!flow || run.status !== "running") return null;
  for (const status of ["waiting_gate", "running", "ready", "pending"]) {
    const match = flow.steps.find((step) => run.steps[step.id]?.status === status);
    if (match) return match.id;
  }
  return null;
}

function spent(budget) {
  if (!budget || typeof budget !== "object") return {};
  const out = {};
  for (const key of ["dispatches", "usd", "tokens", "ms"]) if (typeof budget[key] === "number") out[key] = budget[key];
  return out;
}

/**
 * A "running" run with no run event for longer than this reads as stale in the UI. A pick forge-main may change.
 * Stratum persists no heartbeat (the MCP progress ping is a notification, never stored), so the last run event is
 * the only liveness signal on disk.
 */
export const STALE_AFTER_MS = 6 * 3600 * 1000;

export function summarize(run, now = Date.now()) {
  const flow = flowOf(run);
  const events = Array.isArray(run.events) ? run.events : [];
  const states = Object.values(run.steps);
  const lastEventAt = events[events.length - 1]?.at ?? null;
  const lastEventMs = lastEventAt === null ? NaN : Date.parse(lastEventAt);
  const stale = displayStatus(run) === "running" && (Number.isNaN(lastEventMs) || now - lastEventMs > STALE_AFTER_MS);
  return {
    id: run.id,
    flowName: run.flowName || run.id,
    status: run.status,
    displayStatus: displayStatus(run),
    stepCount: flow?.steps.length ?? 0,
    completedSteps: states.filter((step) => step?.status === "succeeded" || step?.status === "skipped").length,
    currentStepId: currentStepId(run, flow),
    round: run.rounds ?? 0,
    startedAt: events[0]?.at ?? null,
    updatedAt: lastEventAt,
    lastEventAt,
    stale,
    spent: spent(run.flowSpent),
    waitingGates: states.filter((step) => step?.status === "waiting_gate").length,
  };
}

function failure(value) {
  return value && typeof value === "object" && typeof value.reason === "string"
    ? { attempt: Number(value.attempt) || 0, reason: value.reason }
    : undefined;
}

function attempt(record) {
  const out = { attempt: record?.attempt ?? 0, at: record?.at ?? "" };
  if (record?.result !== undefined) out.result = record.result;
  const fail = failure(record?.failure);
  if (fail) out.failure = fail;
  if (record?.usage) out.usage = spent(record.usage);
  if (typeof record?.durationMs === "number") out.durationMs = record.durationMs;
  if (typeof record?.model === "string") out.model = record.model;
  if (typeof record?.effort === "string") out.effort = record.effort;
  return out;
}

/** StepState → StepStateView: drops tokens, lessons, worktree/patch internals. */
export function stepView(state, depth = 0) {
  const out = { status: state?.status ?? "pending", attempts: Array.isArray(state?.attempts) ? state.attempts.map(attempt) : [] };
  if (typeof state?.epoch === "number") out.epoch = state.epoch;
  if (state?.output !== undefined) out.output = state.output;
  const fail = failure(state?.failure);
  if (fail) out.failure = fail;
  const routed = failure(state?.routed);
  if (routed) out.routed = routed;
  if (typeof state?.iterations === "number") out.iterations = state.iterations;
  if (state?.spent) out.spent = spent(state.spent);
  if (Array.isArray(state?.fanout?.items)) {
    out.fanout = {
      items: state.fanout.items.map((item) => {
        const view = { index: item.index, status: item.status, attempts: Array.isArray(item.attempts) ? item.attempts.map(attempt) : [] };
        if (typeof item.stage === "number") view.stage = item.stage;
        if (item.output !== undefined) view.output = item.output;
        const itemFail = failure(item.failure);
        if (itemFail) view.failure = itemFail;
        return view;
      }),
    };
  }
  if (depth === 0 && state?.sub && typeof state.sub.steps === "object" && state.sub.steps !== null) {
    out.sub = { steps: Object.fromEntries(Object.entries(state.sub.steps).map(([id, sub]) => [id, stepView(sub, 1)])) };
    if (typeof state.sub.rounds === "number") out.sub.rounds = state.sub.rounds;
  }
  return out;
}

export function stepKind(step) {
  return KINDS.find((kind) => step?.[kind] !== undefined) ?? "do";
}

export function detail(run) {
  const flow = flowOf(run);
  const out = {
    ...summarize(run),
    steps: (flow?.steps ?? []).map((step) => ({ ...step, kind: stepKind(step) })),
    stepStates: Object.fromEntries(Object.entries(run.steps).map(([id, state]) => [id, stepView(state)])),
    events: (Array.isArray(run.events) ? run.events : []).map((event) => {
      const view = { at: event.at, type: event.type };
      if (event.stepId !== undefined) view.stepId = event.stepId;
      if (event.detail !== undefined) view.detail = event.detail;
      return view;
    }),
    maxRounds: typeof flow?.max_rounds === "number" ? flow.max_rounds : null,
  };
  if (run.input !== undefined) out.input = run.input;
  if (run.output !== undefined) out.output = run.output;
  const fail = failure(run.failure);
  if (fail) out.failure = fail;
  if (!flow) out.specError = `spec has no flow named '${run.flowName}' with a steps list`;
  return out;
}

/**
 * `stratum query gates` row (query_gate.ts:168-191) + the run file → PendingGate.
 * `run` may be undefined when the file vanished between the two reads.
 */
export function pendingGate(row, run) {
  const flow = run ? flowOf(run) : undefined;
  const events = Array.isArray(run?.events) ? run.events : [];
  const waiting = [...events].reverse().find((event) => event.type === "gate_waiting" && event.stepId === row.step_id);
  return {
    runId: row.flow_id,
    flowName: row.flow_name,
    stepId: row.step_id,
    gateToken: typeof row.gate_token === "string" ? row.gate_token : null,
    onApprove: row.on_approve ?? null,
    onRevise: row.on_revise ?? null,
    onKill: row.on_kill ?? null,
    round: run?.rounds ?? 0,
    maxRounds: typeof flow?.max_rounds === "number" ? flow.max_rounds : null,
    reviseEndsRun: reviseEndsRun(row, run, flow),
    waitingSince: waiting?.at ?? null,
  };
}

/** Mirrors the revise preflight in `engine.ts` gateResolve (top-level scope). */
function reviseEndsRun(row, run, flow) {
  if (!row.on_revise || !run || !flow) return true;
  const flowLimit = flow.max_rounds;
  if (typeof flowLimit !== "number" || (run.rounds ?? 0) + 1 > flowLimit) return true;
  const gateLimit = flow.steps.find((step) => step?.id === row.step_id)?.gate?.max_rounds;
  const gateRounds = run.steps?.[row.step_id]?.iterations ?? 0;
  return typeof gateLimit === "number" && gateRounds + 1 > gateLimit;
}

/**
 * `stratum gate` result → GateResolution. exit 0 = ok JSON, exit 2 = conflict JSON,
 * anything else = `{error: {code, message}}` or unparseable.
 */
export function gateResolution(code, stdout) {
  let body;
  try { body = JSON.parse(stdout); } catch { body = undefined; }
  if (code === 0 && body?.ok === true) {
    return { ok: true, runId: body.flow_id, stepId: body.step_id, outcome: body.outcome, result: body.result };
  }
  if (code === 2 && body?.conflict) return { ok: false, kind: "conflict", code: "CONFLICT", message: String(body.detail ?? "conflict") };
  if (body?.error) return { ok: false, kind: "error", code: String(body.error.code ?? "ERROR"), message: String(body.error.message ?? "") };
  return { ok: false, kind: "error", code: code === 2 ? "USAGE" : "UNKNOWN", message: `stratum gate exited ${code}` };
}
