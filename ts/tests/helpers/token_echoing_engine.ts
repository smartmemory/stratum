import { StratumEngine } from "../../src/engine/engine.js";
import type { StepState } from "../../src/engine/state.js";

type StepResult = Parameters<StratumEngine["stepDone"]>[2];
type GateDecision = Parameters<StratumEngine["gateResolve"]>[2];
type EngineResponse = Awaited<ReturnType<StratumEngine["stepDone"]>>;

/**
 * The adapter's public surface: a StratumEngine whose token arguments are ALSO
 * accepted when omitted — omitting one asks the adapter to echo the current token.
 * Intersecting with StratumEngine (rather than Omit-ing) keeps it assignable to
 * StratumEngine (private brand preserved) while the added optional-token overloads
 * let the adapter's callers omit the token. Production signatures still require it;
 * this relaxation is confined to the test adapter.
 */
export interface TokenEchoingEngine extends StratumEngine {
  stepDone(runId: string, stepId: string, result: StepResult, dispatchToken?: string): Promise<EngineResponse>;
  gateResolve(runId: string, stepId: string, decision: GateDecision, gateToken?: string): Promise<EngineResponse>;
}

function stateFor(steps: Record<string, StepState>, scopedId: string): StepState | undefined {
  const [root, ...children] = scopedId.split("/");
  let state = root === undefined ? undefined : steps[root];
  for (const child of children) {
    if (!state?.sub || child === undefined) return undefined;
    state = state.sub.steps[child];
  }
  return state;
}

/**
 * Test consumer adapter: echo each currently issued token unless a test supplies
 * one explicitly.
 *
 * NEVER use for token-fencing assertions. This adapter forwards the CURRENT token
 * when a test omits one, so a fencing test run through it would pass even if the
 * production call accidentally dropped the token — masking the very regression the
 * fencing test exists to catch. Fencing tests must drive the RAW engine directly.
 */
export function tokenEchoingEngine(engine: StratumEngine): TokenEchoingEngine {
  // The adapter is a lenient test client: it echoes the CURRENT token when a test
  // omits one, and forwards whatever it resolved — including `undefined` for a
  // terminal/cancelled/non-ready step that has no token — so the ENGINE produces
  // the correct domain error (e.g. "background-driven", "not awaiting", "missing
  // dispatch token"). Post-flag-day the engine methods require the token, so the
  // shim forwards through a token-optional VIEW of the same methods. This cast is
  // internal to the compatibility shim, never at a production call site.
  const relaxed = engine as unknown as {
    stepDone(runId: string, stepId: string, result: StepResult, dispatchToken?: string): Promise<EngineResponse>;
    gateResolve(runId: string, stepId: string, decision: GateDecision, gateToken?: string): Promise<EngineResponse>;
  };
  const proxy = new Proxy(engine, {
    get(target, property) {
      if (property === "stepDone") {
        return async (runId: string, stepId: string, result: StepResult, dispatchToken?: string) => {
          const token = dispatchToken ?? stateFor((await target.audit(runId)).steps, stepId)?.dispatchToken;
          return relaxed.stepDone(runId, stepId, result, token);
        };
      }
      if (property === "gateResolve") {
        return async (runId: string, stepId: string, decision: GateDecision, gateToken?: string) => {
          const token = gateToken ?? stateFor((await target.audit(runId)).steps, stepId)?.gateToken;
          return relaxed.gateResolve(runId, stepId, decision, token);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // A Proxy is typed as its target; the adapter deliberately exposes the relaxed
  // optional-token surface, so narrow the wrapper type here (not at any call site).
  return proxy as unknown as TokenEchoingEngine;
}
