import { z } from "zod";
import type { JudgeRunner } from "../engine/engine.js";
import type { JudgedResult } from "./judged.js";

const fixtureVerdictSchema = z.object({
  holds: z.boolean(),
  reason: z.string().min(1),
  model: z.string().min(1).optional(),
  usage: z.object({
    tokens: z.number().finite().nonnegative(),
    usd: z.number().finite().nonnegative(),
  }).strict().optional(),
}).strict();

type FixtureVerdict = z.infer<typeof fixtureVerdictSchema>;
type FixtureSource = { kind: "statements"; verdicts: Readonly<Record<string, FixtureVerdict>> }
  | { kind: "sequence"; verdicts: FixtureVerdict[] };

/**
 * Creates an engine-local fixture judge. STRATUM_JUDGE_FIXTURE is either a
 * statement-to-verdict JSON object or an ordered JSON verdict array. Keeping
 * the parsed sequence in this closure makes consumption deterministic per
 * engine instead of leaking mutable state across tests.
 */
export function createFixtureJudge(env: NodeJS.ProcessEnv = process.env): JudgeRunner {
  if (env.NODE_ENV !== "test") {
    throw new Error('STRATUM_JUDGE_BACKEND="fixture" is only allowed when NODE_ENV="test"');
  }
  const encoded = env.STRATUM_JUDGE_FIXTURE;
  if (encoded === undefined) {
    throw new Error("STRATUM_JUDGE_FIXTURE must be set when STRATUM_JUDGE_BACKEND=fixture");
  }
  const source = parseFixtureSource(encoded);
  return async (predicate): Promise<JudgedResult> => {
    const verdict = source.kind === "statements"
      ? (Object.hasOwn(source.verdicts, predicate.statement) ? source.verdicts[predicate.statement] : undefined)
      : source.verdicts.shift();
    if (verdict === undefined) throw new Error(`no fixture verdict for ${JSON.stringify(predicate.statement)}`);
    return {
      holds: verdict.holds,
      reason: verdict.reason,
      stakes: predicate.stakes ?? "default",
      model: verdict.model ?? "fixture",
      usage: verdict.usage ?? { tokens: 1, usd: 0 },
    };
  };
}

function parseFixtureSource(encoded: string): FixtureSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error(`invalid STRATUM_JUDGE_FIXTURE JSON: ${message(error)}`);
  }
  try {
    if (Array.isArray(parsed)) {
      return { kind: "sequence", verdicts: z.array(fixtureVerdictSchema).parse(parsed) };
    }
    return { kind: "statements", verdicts: z.record(fixtureVerdictSchema).parse(parsed) };
  } catch (error) {
    throw new Error(`invalid STRATUM_JUDGE_FIXTURE verdicts: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
