// Builder bridge to the engine (STRAT-UI-BUILDER-1). Loads the BUILT engine (`ts/dist`), so
// the builder is judged by the engine's own code, never a copy of its schema:
//
//   validate(spec)      → validateSpec() (`ts/src/ir/validate.ts:348`) in the `stratum_validate`
//                         shape (`ts/src/mcp/server.ts:300-303`)
//   plan(spec, input)   → a DRY `stratum_plan`: engine.plan() (`mcp/server.ts:305-312`) against a
//                         fresh throwaway state dir that is deleted afterwards. Agent dispatch is
//                         refused (connector stub), `evaluate:` commands and `judged:` predicates
//                         have no runner (fail closed), learn egress is off. Nothing reaches the
//                         real flows dir and no agent is started.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DRY_PLAN_REFUSAL = "dry plan: agent dispatch is disabled";


/** The three engine modules the bridge uses, as built in `ts/dist`. */
export function engineFromDist(engineDist) {
  const url = (...parts) => pathToFileURL(join(realpathSync(engineDist), ...parts)).href;
  return () => Promise.all([import(url("ir", "validate.js")), import(url("engine", "engine.js")), import(url("eval", "expr.js"))])
    .then(([validate, engine, expr]) => engineModules(validate, engine, expr));
}

/** Pick what the bridge needs out of `ir/validate`, `engine/engine` and `eval/expr`. */
export function engineModules(validate, engine, expr) {
  return { validateSpec: validate.validateSpec, StratumEngine: engine.StratumEngine, SpecValidationError: engine.SpecValidationError, createEvaluator: expr.createEvaluator };
}

/**
 * @param {() => Promise<ReturnType<typeof engineModules>>} loadEngine  e.g. `engineFromDist("<repo>/ts/dist")`
 * @param {{ planScratch?: string }} [options]  parent dir for throwaway plan state (default os.tmpdir())
 */
export function createEngineBridge(loadEngine, { planScratch } = {}) {
  let loaded;
  const load = () => (loaded ??= loadEngine());

  async function validate(spec) {
    const { validateSpec } = await load();
    const result = validateSpec(spec);
    return result.ok ? { status: "valid" } : { status: "invalid", errors: result.errors };
  }

  async function plan(spec, input) {
    const { StratumEngine, SpecValidationError, createEvaluator } = await load();
    const root = await mkdtemp(join(planScratch ?? tmpdir(), "stratum-ui-dry-plan-"));
    try {
      const engine = new StratumEngine({
        stateRoot: root,
        evaluator: createEvaluator(),
        connector: async () => { throw new Error(DRY_PLAN_REFUSAL); },
        learnEgress: { enabled: () => false, drainRun: async () => {}, drainAll: async () => {}, close: async () => {} },
      });
      try {
        return { status: "planned", response: await engine.plan(spec, input ?? {}) };
      } catch (error) {
        if (error instanceof SpecValidationError) return { status: "invalid", errors: error.errors };
        return { status: "error", message: String(error?.message ?? error) };
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  return { validate, plan };
}
