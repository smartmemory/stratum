import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../guard/canonical.js";
import type { EdgePredicates } from "../guard/store.js";
import { SpecificationSchema, type Specification } from "../ir/schema.js";
import type { PolicyBundle, PolicyRuleMap, PredicateStakes, Rule, RulePredicate, Source } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

const SourceSchema = z.object({
  record_id: z.string().min(1),
  memory_type: z.string().min(1),
  version: z.number().int(),
  content_hash: z.string().regex(SHA256_HEX),
  chain_hash: z.string().regex(SHA256_HEX),
  workspace_id: z.string().min(1),
  decision_type: z.string().optional(),
  domain: z.string().optional(),
}).strict();

const RuleBindSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ensure"), step_selector: z.string().optional() }).strict(),
  z.object({ kind: z.literal("guard_edge"), resource_selector: z.string().optional(), edge: z.string().optional() }).strict(),
]);

const RulePredicateSchema = z.union([
  z.object({ judged: z.object({ statement: z.string(), stakes: z.enum(["cheap", "default", "paranoid"]) }).strict() }).strict(),
  z.object({ expr: z.string() }).strict(),
  z.object({ file_exists: z.string() }).strict(),
  z.object({ file_contains: z.object({ path: z.string(), text: z.string() }).strict() }).strict(),
]);

const RuleSchema = z.object({
  rule_id: z.string().min(1),
  source: SourceSchema,
  bind: RuleBindSchema,
  predicate: RulePredicateSchema,
  on_fail: z.enum(["refuse", "gate"]),
}).strict();

const PolicyBundleSchema = z.object({
  bundle_id: z.string().regex(SHA256_HEX),
  workspace_id: z.string().min(1),
  compiled_at: z.string().datetime({ offset: true }).refine((value) => value.endsWith("Z"), "compiled_at must be UTC"),
  selector: z.object({
    workflow: z.string().optional(),
    domain: z.string().optional(),
    status: z.array(z.literal("active")),
  }).strict(),
  rules: z.array(RuleSchema),
}).strict();

export function bundleIdForRules(rules: Rule[]): string {
  return createHash("sha256").update(canonicalJson(rules), "utf8").digest("hex");
}

export function validateBundle(bundle: unknown): PolicyBundle {
  const parsed = PolicyBundleSchema.parse(bundle) as PolicyBundle;
  const expected = bundleIdForRules(parsed.rules);
  if (parsed.bundle_id !== expected) {
    throw new Error(`policy bundle_id mismatch: expected ${expected}, got ${parsed.bundle_id}`);
  }
  for (const rule of parsed.rules) {
    if (rule.bind.kind !== "guard_edge") continue;
    // P1 guard evaluation accepts only trusted builtin statements or judged
    // prose; raw ensure expressions do not have a guard evaluator/context.
    if ("expr" in rule.predicate) {
      throw new Error("guard-edge expr predicates are not evaluable in P1; use judged/file_exists/file_contains");
    }
    if (rule.on_fail === "gate") {
      throw new Error(`guard-edge policy rule ${JSON.stringify(rule.rule_id)} uses on_fail=${JSON.stringify("gate")}; guard gate routing is deferred to P3`);
    }
  }
  return parsed;
}

export function policyRuleKey(flowName: string, stepId: string): string {
  return `${flowName}/${stepId}`;
}

export function mergeBundleIntoSpec(
  spec: Specification,
  bundle: PolicyBundle,
  policyStepSelector?: string,
): { spec: Specification; policy_rules: PolicyRuleMap; bundle_id: string } {
  const merged = structuredClone(spec);
  const policyRules: PolicyRuleMap = Object.create(null) as PolicyRuleMap;

  for (const rule of bundle.rules) {
    if (rule.bind.kind !== "ensure") continue;
    const selector = effectiveStepSelector(rule.bind.step_selector ?? "*", policyStepSelector);
    for (const [flowName, flow] of Object.entries(merged.flows)) {
      if (flowName === "entry" || typeof flow === "string") continue;
      for (const step of flow.steps) {
        if (step.do === undefined || !selector.matches(step.id)) continue;
        const ensure = step.ensure ?? [];
        const ensureIndex = ensure.length;
        step.ensure = [...ensure, structuredClone(rule.predicate)];
        (policyRules[policyRuleKey(flowName, step.id)] ??= []).push({
          ensure_index: ensureIndex,
          rule_id: rule.rule_id,
          source: structuredClone(rule.source),
          step_selector: selector.audit,
          on_fail: rule.on_fail,
        });
      }
    }
  }

  return {
    spec: SpecificationSchema.parse(merged),
    policy_rules: policyRules,
    bundle_id: bundle.bundle_id,
  };
}

/**
 * A caller selector is a narrowing constraint, never permission to bind a rule
 * beyond its compiler-provided selector. When neither glob contains the other,
 * retain their intersection and make that conjunction explicit in the audit.
 */
function effectiveStepSelector(ruleSelector: string, override: string | undefined): { audit: string; matches: (stepId: string) => boolean } {
  if (override === undefined || override === ruleSelector) {
    return { audit: ruleSelector, matches: (stepId) => globMatches(ruleSelector, stepId) };
  }
  if (override === "*") {
    return { audit: ruleSelector, matches: (stepId) => globMatches(ruleSelector, stepId) };
  }
  if (ruleSelector === "*") {
    return { audit: override, matches: (stepId) => globMatches(override, stepId) };
  }
  return {
    audit: `${ruleSelector} & ${override}`,
    matches: (stepId) => globMatches(ruleSelector, stepId) && globMatches(override, stepId),
  };
}

export function guardEdgePredicatesFor(
  bundle: PolicyBundle,
  resourceId: string,
  edgePredicates: EdgePredicates,
  stakes: Record<string, string>,
): EdgePredicates {
  const merged = structuredClone(edgePredicates);
  const addedJudged = new Map<string, string[]>();

  for (const rule of bundle.rules) {
    if (rule.bind.kind !== "guard_edge") continue;
    if (!globMatches(rule.bind.resource_selector ?? "*", resourceId)) continue;
    for (const edge of Object.keys(merged)) {
      if (rule.bind.edge !== undefined && rule.bind.edge !== edge) continue;
      const predicate = guardPredicate(rule);
      (merged[edge] ??= []).push(predicate);
      if ("judged" in rule.predicate) {
        (addedJudged.get(edge) ?? setAndGet(addedJudged, edge)).push(rule.rule_id);
        stakes[edge] = maxStakes(stakes[edge], rule.predicate.judged.stakes);
      }
    }
  }

  for (const [edge, ruleIds] of addedJudged) {
    const predicates = merged[edge] ?? [];
    const hasDeterministic = predicates.some((predicate) => predicate.type === undefined || predicate.type === "deterministic");
    if (stakes[edge] === "paranoid" && !hasDeterministic) {
      throw new Error(`policy rule ${JSON.stringify(ruleIds[0])} cannot merge onto paranoid edge ${JSON.stringify(edge)} without a deterministic predicate`);
    }
  }
  return merged;
}

const STAKE_ORDER: Record<PredicateStakes, number> = { cheap: 0, default: 1, paranoid: 2 };

function maxStakes(existing: string | undefined, added: PredicateStakes): PredicateStakes {
  const current = existing === "cheap" || existing === "default" || existing === "paranoid" ? existing : "default";
  return STAKE_ORDER[added] > STAKE_ORDER[current] ? added : current;
}

function guardPredicate(rule: Rule): Record<string, unknown> {
  const common = { id: rule.rule_id, source: structuredClone(rule.source) };
  const predicate = rule.predicate;
  if ("judged" in predicate) return { type: "judged", statement: predicate.judged.statement, stakes: predicate.judged.stakes, ...common };
  if ("expr" in predicate) return { type: "deterministic", statement: predicate.expr, ...common };
  if ("file_exists" in predicate) {
    return { type: "deterministic", statement: `server_file_exists(${JSON.stringify(predicate.file_exists)})`, ...common };
  }
  return {
    type: "deterministic",
    statement: `server_file_contains(${JSON.stringify(predicate.file_contains.path)}, ${JSON.stringify(predicate.file_contains.text)})`,
    ...common,
  };
}

function setAndGet(map: Map<string, string[]>, key: string): string[] {
  const value: string[] = [];
  map.set(key, value);
  return value;
}

function globMatches(pattern: string, value: string): boolean {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "u").test(value);
}

export function predicateType(predicate: RulePredicate): "deterministic" | "judged" {
  return "judged" in predicate ? "judged" : "deterministic";
}

export function sourceFromPredicate(predicate: Record<string, unknown>): Source | undefined {
  const source = predicate.source;
  return SourceSchema.safeParse(source).success ? source as Source : undefined;
}
