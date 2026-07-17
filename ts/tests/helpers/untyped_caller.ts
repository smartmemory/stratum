import type { StratumEngine } from "../../src/engine/engine.js";

/**
 * S2/flag-day: `stepDone`/`gateResolve` now REQUIRE the token at the type
 * boundary, so a TS caller can no longer omit it. The engine still guards the
 * UNTYPED (JS) call path at runtime. Negative tests that assert those runtime
 * guards reject a MISSING token reach them through this token-optional view.
 *
 * This is a raw-JS-caller SIMULATION — NOT the token-echoing adapter, and NOT a
 * way to skip passing a real token in a normal flow. Use it only to exercise the
 * missing-token runtime rejection now that the type prevents it at compile time.
 */
export interface TokenOptionalEngine {
  stepDone(runId: string, stepId: string, result: Parameters<StratumEngine["stepDone"]>[2]): Promise<unknown>;
  gateResolve(runId: string, stepId: string, decision: "approve" | "revise" | "kill"): Promise<unknown>;
}

export function asUntypedCaller(engine: StratumEngine): TokenOptionalEngine {
  return engine as unknown as TokenOptionalEngine;
}
