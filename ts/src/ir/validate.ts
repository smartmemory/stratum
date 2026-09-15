import { z } from "zod";
import { expressionUsesFilePredicate } from "../eval/expr.js";
import { extractReferences, referenceEdges, type PathSegment, type Reference } from "./refs.js";
import { SpecificationSchema, type Flow, type Specification, type Step } from "./schema.js";

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult =
  | {
      ok: true;
      value: Specification;
      contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>;
      inputs: Record<string, z.ZodObject<z.ZodRawShape, "strict">>;
    }
  | { ok: false; errors: ValidationError[] };

type ContractNode =
  | { kind: "scalar"; scalar: "string" | "integer" | "number" | "boolean"; optional: boolean }
  | { kind: "object" | "array"; optional: boolean }
  | { kind: "enum"; values: string[]; optional: boolean }
  | { kind: "ref"; name: string; optional: boolean }
  | { kind: "typed-array"; item: ContractNode; optional: boolean };

interface ParsedContract {
  fields: Record<string, ContractNode>;
}

interface Edge {
  from: string;
  to: string;
  path: string;
}

const PRIMITIVES = new Set(["string", "integer", "number", "boolean", "object", "array"]);
const CONTRACT_NAME = /^[A-Z][a-zA-Z0-9_]*$/;

function formatPath(path: readonly (string | number)[]): string {
  let formatted = "";
  for (const part of path) {
    formatted += typeof part === "number" ? `[${part}]` : formatted ? `.${part}` : part;
  }
  return formatted;
}

function schemaErrors(error: z.ZodError): ValidationError[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return issue.keys.map((key) => ({
        code: "E2_UNKNOWN_FIELD", path: formatPath([...issue.path, key]), message: issue.message,
      }));
    }
    if (issue.code === z.ZodIssueCode.custom && issue.message.startsWith("E2_")) {
      return { code: issue.message, path: formatPath(issue.path), message: issue.message };
    }
    return { code: "SCHEMA_INVALID", path: formatPath(issue.path), message: issue.message };
  });
}

function parseContractType(value: string): ContractNode | undefined {
  let raw = value;
  let optional = false;
  if (raw.endsWith("?")) {
    optional = true;
    raw = raw.slice(0, -1);
  }
  if (raw.length === 0 || raw.endsWith("?")) return undefined;

  const enumArray = /^\(([^()]+)\)\[\]$/.exec(raw);
  if (enumArray?.[1]) {
    const values = enumArray[1].split("|");
    if (values.some((item) => item.length === 0)) return undefined;
    return { kind: "typed-array", item: { kind: "enum", values, optional: false }, optional };
  }
  if (raw.endsWith("[]")) {
    const item = parseContractType(raw.slice(0, -2));
    if (!item || item.optional) return undefined;
    return { kind: "typed-array", item, optional };
  }
  if (raw === "object" || raw === "array") return { kind: raw, optional };
  if (PRIMITIVES.has(raw)) return { kind: "scalar", scalar: raw as "string" | "integer" | "number" | "boolean", optional };
  if (raw.includes("|")) {
    const values = raw.split("|");
    if (values.some((item) => item.length === 0 || /[\[\]()]/.test(item))) return undefined;
    return { kind: "enum", values, optional };
  }
  if (CONTRACT_NAME.test(raw)) return { kind: "ref", name: raw, optional };
  return undefined;
}

function primitiveToZod(name: string): z.ZodTypeAny {
  switch (name) {
    case "string": return z.string();
    case "integer": return z.number().int();
    case "number": return z.number();
    case "boolean": return z.boolean();
    default: return z.never();
  }
}

function parseContracts(contracts: Record<string, Record<string, string>>): { parsed?: Record<string, ParsedContract>; errors: ValidationError[] } {
  const parsed: Record<string, ParsedContract> = Object.create(null);
  for (const [name, contract] of Object.entries(contracts)) {
    const fields: Record<string, ContractNode> = Object.create(null);
    for (const [field, type] of Object.entries(contract)) {
      const node = parseContractType(type);
      if (!node) return { errors: [{ code: "CONTRACT_INVALID_TYPE", path: `contracts.${name}.${field}`, message: `invalid contract type ${type}` }] };
      fields[field] = node;
    }
    parsed[name] = { fields };
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (node: ContractNode, path: string): ValidationError | undefined => {
    if (node.kind === "typed-array") return walk(node.item, path);
    if (node.kind !== "ref") return undefined;
    if (!parsed[node.name]) return { code: "CONTRACT_UNKNOWN_REF", path, message: `unknown contract ${node.name}` };
    if (visiting.has(node.name)) return { code: "CONTRACT_RECURSIVE_REF", path, message: `recursive contract ${node.name}` };
    if (visited.has(node.name)) return undefined;
    visiting.add(node.name);
    for (const [field, child] of Object.entries(parsed[node.name]!.fields)) {
      const error = walk(child, `contracts.${node.name}.${field}`);
      if (error) return error;
    }
    visiting.delete(node.name);
    visited.add(node.name);
    return undefined;
  };
  for (const [name, contract] of Object.entries(parsed)) {
    if (visited.has(name)) continue;
    visiting.add(name);
    for (const [field, node] of Object.entries(contract.fields)) {
      const error = walk(node, `contracts.${name}.${field}`);
      if (error) return { errors: [error] };
    }
    visiting.delete(name);
    visited.add(name);
  }
  return { parsed, errors: [] };
}

function compileContracts(parsed: Record<string, ParsedContract>): Record<string, z.ZodObject<z.ZodRawShape, "strict">> {
  const cache: Record<string, z.ZodObject<z.ZodRawShape, "strict">> = Object.create(null);
  const compileNode = (node: ContractNode): z.ZodTypeAny => {
    let schema: z.ZodTypeAny;
    if (node.kind === "scalar") schema = primitiveToZod(node.scalar);
    else if (node.kind === "object") schema = z.record(z.unknown());
    else if (node.kind === "array") schema = z.array(z.unknown());
    else if (node.kind === "enum") schema = z.enum(node.values as [string, ...string[]]);
    else if (node.kind === "ref") schema = compile(node.name);
    else if (node.kind === "typed-array") schema = z.array(compileNode(node.item));
    else schema = z.never();
    return node.optional ? schema.nullish() : schema;
  };
  const compile = (name: string): z.ZodObject<z.ZodRawShape, "strict"> => {
    if (cache[name]) return cache[name];
    const shape: z.ZodRawShape = Object.create(null);
    for (const [field, node] of Object.entries(parsed[name]!.fields)) shape[field] = compileNode(node);
    const schema = z.object(shape).strict();
    cache[name] = schema;
    return schema;
  };
  for (const name of Object.keys(parsed)) compile(name);
  return cache;
}

function compileFields(
  fields: Record<string, ContractNode>,
  contracts: Record<string, z.ZodObject<z.ZodRawShape, "strict">>,
): z.ZodObject<z.ZodRawShape, "strict"> {
  const compileNode = (node: ContractNode): z.ZodTypeAny => {
    let schema: z.ZodTypeAny;
    if (node.kind === "scalar") schema = primitiveToZod(node.scalar);
    else if (node.kind === "object") schema = z.record(z.unknown());
    else if (node.kind === "array") schema = z.array(z.unknown());
    else if (node.kind === "enum") schema = z.enum(node.values as [string, ...string[]]);
    else if (node.kind === "ref") schema = contracts[node.name] ?? z.never();
    else if (node.kind === "typed-array") schema = z.array(compileNode(node.item));
    else schema = z.never();
    return node.optional ? schema.nullish() : schema;
  };
  const shape: z.ZodRawShape = Object.create(null);
  for (const [field, node] of Object.entries(fields)) shape[field] = compileNode(node);
  return z.object(shape).strict();
}

function containsPath(node: ContractNode, path: readonly PathSegment[], parsed: Record<string, ParsedContract>): boolean {
  if (path.length === 0) return true;
  const [head, ...tail] = path;
  if (node.kind === "ref") return containsPathInContract(node.name, path, parsed);
  if (node.kind === "typed-array") return typeof head === "number" && containsPath(node.item, tail, parsed);
  if (node.kind === "object") return typeof head === "string" ? true : false;
  if (node.kind === "array") return typeof head === "number";
  return false;
}

function containsPathInContract(name: string, path: readonly PathSegment[], parsed: Record<string, ParsedContract>): boolean {
  if (path.length === 0) return true;
  const [head, ...tail] = path;
  return typeof head === "string" && !!parsed[name]?.fields[head] && containsPath(parsed[name]!.fields[head]!, tail, parsed);
}

function containsPathInFields(fields: Record<string, ContractNode>, path: readonly PathSegment[], parsed: Record<string, ParsedContract>): boolean {
  if (path.length === 0) return true;
  const [head, ...tail] = path;
  return typeof head === "string" && !!fields[head] && containsPath(fields[head]!, tail, parsed);
}

function unknownContractIn(node: ContractNode, parsed: Record<string, ParsedContract>): string | undefined {
  if (node.kind === "ref") return parsed[node.name] ? undefined : node.name;
  if (node.kind === "typed-array") return unknownContractIn(node.item, parsed);
  return undefined;
}

function leaves(value: unknown, path: readonly (string | number)[]): Array<{ value: string; path: string }> {
  if (typeof value === "string") return [{ value, path: formatPath(path) }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => leaves(item, [...path, key]));
  return [];
}

export function referencesInStep(step: Step, base: readonly (string | number)[]): Array<{ value: string; path: string; fanoutStage: boolean; expression: boolean }> {
  const result: Array<{ value: string; path: string; fanoutStage: boolean; expression: boolean }> = [];
  const add = (value: unknown, path: readonly (string | number)[], fanoutStage = false, expression = false) => {
    result.push(...leaves(value, path).map((leaf) => ({ ...leaf, fanoutStage, expression })));
  };
  if (step.do !== undefined) add(step.do, [...base, "do"]);
  if (step.when !== undefined) add(step.when, [...base, "when"], false, true);
  if (step.set !== undefined) add(step.set, [...base, "set"], false, true);
  if (step.iterate?.until !== undefined) add(step.iterate.until, [...base, "iterate", "until"], false, true);
  step.ensure?.forEach((predicate, index) => {
    if ("expr" in predicate) add(predicate.expr, [...base, "ensure", index, "expr"], false, true);
  });
  if (step.run !== undefined && step.with !== undefined) add(step.with, [...base, "with"]);
  if (step.evaluate?.in !== undefined) add(step.evaluate.in, [...base, "evaluate", "in"]);
  if (step.fanout !== undefined) {
    add(step.fanout.over, [...base, "fanout", "over"]);
    step.fanout.steps.forEach((stage, index) => {
      add(stage.do, [...base, "fanout", "steps", index, "do"], true);
      if (stage.when !== undefined) add(stage.when, [...base, "fanout", "steps", index, "when"], true, true);
      stage.ensure?.forEach((predicate, ensureIndex) => {
        if ("expr" in predicate) add(predicate.expr, [...base, "fanout", "steps", index, "ensure", ensureIndex, "expr"], true, true);
      });
    });
  }
  return result;
}

/** Mirrors engine.dependencies(): direct `after` plus direct step-output references. */
function dependencyIds(step: Step): Set<string> {
  const dependencies = new Set(step.after ?? []);
  for (const leaf of referencesInStep(step, [])) {
    for (const extracted of extractReferences(leaf.value) ?? []) {
      if (extracted.reference.kind === "step") dependencies.add(extracted.reference.stepId);
    }
  }
  return dependencies;
}

function addEdge(adjacency: Map<string, Edge[]>, edge: Edge): ValidationError | undefined {
  if (edge.from === edge.to) return { code: "ROUTING_SELF_TARGET", path: edge.path, message: "routing edge targets itself" };
  const queue = [edge.to];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === edge.from) {
      return { code: "ROUTING_CYCLE", path: edge.path, message: "routing edge creates a cycle" };
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next.to)) {
        seen.add(next.to);
        queue.push(next.to);
      }
    }
  }
  adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  return undefined;
}

function reaches(adjacency: Map<string, Edge[]>, from: string, target: string): boolean {
  const queue = [from];
  const seen = new Set<string>(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === target) return true;
    for (const edge of adjacency.get(current) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return false;
}

/** Mirrors engine.resetFrom's descendant closure (engine.ts:2226-2244): dependency
 *  edges PLUS on_fail / gate approve+kill routes. Exported as the parity-test seam;
 *  the engine keeps its own walk over live StepState, so the two must be pinned
 *  against each other (T-S01-14). */
export function resetClosure(flow: Flow, target: string): Set<string> {
  const descendants = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of flow.steps) {
      if (descendants.has(step.id)) continue;
      const viaDependency = [...dependencyIds(step)].some((dependency) => descendants.has(dependency));
      const viaRoute = flow.steps.some((router) => descendants.has(router.id)
        && (router.on_fail === step.id || router.gate?.on_approve === step.id || router.gate?.on_kill === step.id));
      if (viaDependency || viaRoute) { descendants.add(step.id); grew = true; }
    }
  }
  return descendants;
}

function flowEntries(spec: Specification): Array<[string, Flow]> {
  return Object.entries(spec.flows).filter(([name]) => name !== "entry") as Array<[string, Flow]>;
}

function contractForStep(step: Step, flows: Record<string, Flow>): string | undefined {
  if (step.do !== undefined || step.set !== undefined || step.evaluate !== undefined) return step.out;
  if (step.fanout !== undefined) return step.fanout.steps.at(-1)?.out;
  if (step.run !== undefined) return flows[step.run]?.output.contract;
  return undefined;
}

function preflightRuns(flows: Record<string, Flow>): ValidationError | undefined {
  for (const [flowName, flow] of Object.entries(flows)) {
    for (const [index, step] of flow.steps.entries()) {
      if (step.run === undefined) continue;
      const callee = flows[step.run];
      if (!callee) return { code: "SUBFLOW_UNKNOWN", path: `flows.${flowName}.steps[${index}].run`, message: `unknown subflow ${step.run}` };
      const expected = Object.keys(callee.input).sort();
      const actual = Object.keys(step.with ?? {}).sort();
      if (expected.length !== actual.length || expected.some((key, keyIndex) => key !== actual[keyIndex])) {
        return { code: "SUBFLOW_WITH_MISMATCH", path: `flows.${flowName}.steps[${index}].with`, message: "with keys must exactly match callee input" };
      }
    }
  }
  return undefined;
}

/** Validates all P0 structural and static-routing invariants. */
export function validateSpec(input: unknown): ValidationResult {
  const structural = SpecificationSchema.safeParse(input);
  if (!structural.success) return { ok: false, errors: schemaErrors(structural.error) };
  const spec = structural.data;
  const contractsInput = spec.contracts as Record<string, Record<string, string>>;
  const parsedResult = parseContracts(contractsInput);
  if (!parsedResult.parsed) return { ok: false, errors: parsedResult.errors };
  const parsed = parsedResult.parsed;
  const contracts = compileContracts(parsed);
  const flows = Object.fromEntries(flowEntries(spec));
  const inputs: Record<string, z.ZodObject<z.ZodRawShape, "strict">> = Object.create(null);

  if (!flows[spec.flows.entry]) return { ok: false, errors: [{ code: "FLOW_UNKNOWN_ENTRY", path: "flows.entry", message: "entry must name an existing flow" }] };
  const runError = preflightRuns(flows);
  if (runError) return { ok: false, errors: [runError] };

  for (const [flowName, flow] of Object.entries(flows)) {
    if (!contracts[flow.output.contract]) return { ok: false, errors: [{ code: "CONTRACT_UNKNOWN_REF", path: `flows.${flowName}.output.contract`, message: "unknown output contract" }] };
    const inputFields: Record<string, ContractNode> = {};
    for (const [field, type] of Object.entries(flow.input)) {
      const node = parseContractType(type);
      if (!node) return { ok: false, errors: [{ code: "CONTRACT_INVALID_TYPE", path: `flows.${flowName}.input.${field}`, message: "invalid input contract type" }] };
      if (unknownContractIn(node, parsed)) return { ok: false, errors: [{ code: "CONTRACT_UNKNOWN_REF", path: `flows.${flowName}.input.${field}`, message: "unknown input contract reference" }] };
      inputFields[field] = node;
    }
    inputs[flowName] = compileFields(inputFields, contracts);
    const ids = new Map<string, { step: Step; index: number }>();
    for (const [index, step] of flow.steps.entries()) {
      if (ids.has(step.id)) return { ok: false, errors: [{ code: "STEP_DUPLICATE_ID", path: `flows.${flowName}.steps[${index}].id`, message: "duplicate step id" }] };
      ids.set(step.id, { step, index });
      if (step.fanout) {
        for (const [stageIndex, stage] of step.fanout.steps.entries()) {
          if (stage.out !== undefined && !contracts[stage.out]) {
            return { ok: false, errors: [{ code: "CONTRACT_UNKNOWN_REF", path: `flows.${flowName}.steps[${index}].fanout.steps[${stageIndex}].out`, message: "unknown output contract" }] };
          }
        }
      }
      const out = contractForStep(step, flows);
      if (out !== undefined && !contracts[out]) return { ok: false, errors: [{ code: "CONTRACT_UNKNOWN_REF", path: `flows.${flowName}.steps[${index}].out`, message: "unknown output contract" }] };
    }

    const adjacency = new Map<string, Edge[]>();
    // Dependency-only forward graph: `after` plus step-output refs, NO routing edges.
    // Only these edges guarantee execution, which is what carry ordering needs (R1-4).
    const dependencyEdges = new Map<string, Set<string>>();
    const carryUses: Array<{ name: string; stepId: string; path: string }> = [];
    const add = (edge: Edge): ValidationError | undefined => {
      if (!ids.has(edge.from)) return { code: "ROUTING_UNKNOWN_TARGET", path: edge.path, message: `unknown step ${edge.from}` };
      if (!ids.has(edge.to)) return { code: "ROUTING_UNKNOWN_TARGET", path: edge.path, message: `unknown step ${edge.to}` };
      return addEdge(adjacency, edge);
    };

    /** Every type rule an ordinary `${}` reference obeys, shared by the per-step loop
     *  and the carry pass (R1-3). Returns undefined when the reference is well typed.
     *  Edge creation stays at the call site — carry creates no edges. */
    const referenceTypeError = (reference: Reference, path: string): ValidationError | undefined => {
      if (reference.kind === "input" && !containsPathInFields(inputFields, reference.path, parsed)) {
        return { code: "REF_UNKNOWN_PATH", path, message: "unknown input path" };
      }
      if (reference.kind !== "step") return undefined;
      const source = ids.get(reference.stepId);
      // A step id that is a declared carry name can only be the reserved `${name.output…}`
      // spelling (CARRY_NAME_CONFLICT already forbids a real collision) — R1-8. This arm is
      // total only because carry names share the step-id charset (R3-2): every legal carry
      // name is a legal step id, so the step regex always claims the reserved spelling.
      if (!source && Object.hasOwn(flow.carry ?? {}, reference.stepId)) {
        return { code: "CARRY_PATH_RESERVED", path, message: `carry paths may not begin with "output"; ${reference.stepId}.output reads as a step reference` };
      }
      if (!source) return { code: "REF_UNKNOWN_STEP", path, message: `unknown step ${reference.stepId}` };
      if (source.step.fanout !== undefined && !source.step.fanout.steps.at(-1)?.out) {
        return { code: "FANOUT_OUTPUT_REQUIRES_FINAL_OUT", path: `flows.${flowName}.steps[${source.index}].fanout.steps[${source.step.fanout.steps.length - 1}].out`, message: "fanout output requires final stage out" };
      }
      const sourceContract = contractForStep(source.step, flows);
      if (!sourceContract) return { code: "REF_OUTPUT_CONTRACT_REQUIRED", path, message: "referenced output requires an out contract" };
      if (source.step.fanout !== undefined) {
        const [head, ...rest] = reference.path;
        if (reference.path.length > 0 && (typeof head !== "number" || !containsPathInContract(sourceContract, rest, parsed))) {
          return { code: "REF_UNKNOWN_PATH", path, message: "fanout output is an array — index it before accessing fields" };
        }
        return undefined;
      }
      if (!containsPathInContract(sourceContract, reference.path, parsed)) {
        return { code: "REF_UNKNOWN_PATH", path, message: "unknown output path" };
      }
      return undefined;
    };

    for (const [index, step] of flow.steps.entries()) {
      const base = ["flows", flowName, "steps", index] as const;
      for (const [afterIndex, source] of (step.after ?? []).entries()) {
        const error = add({ from: source, to: step.id, path: formatPath([...base, "after", afterIndex]) });
        if (error) return { ok: false, errors: [error] };
      }
      if (step.on_fail !== undefined) {
        const error = add({ from: step.id, to: step.on_fail, path: formatPath([...base, "on_fail"]) });
        if (error) return { ok: false, errors: [error] };
      }

      if (step.fanout !== undefined) {
        const overRefs = extractReferences(step.fanout.over);
        if (!overRefs || overRefs.length !== 1 || !overRefs[0]!.fullValue) {
          return { ok: false, errors: [{ code: "FANOUT_OVER_SINGLE_REF", path: formatPath([...base, "fanout", "over"]), message: "fanout over must be one full reference" }] };
        }
      }

      for (const leaf of referencesInStep(step, base)) {
        const extracted = extractReferences(leaf.value);
        if (!extracted) return { ok: false, errors: [{ code: "REF_INVALID", path: leaf.path, message: "invalid reference syntax" }] };
        for (const extractedReference of extracted) {
          const reference = extractedReference.reference;
          if ((reference.kind === "item" || reference.kind === "prev") && !leaf.fanoutStage) {
            return { ok: false, errors: [{ code: "REF_INVALID_SCOPE", path: leaf.path, message: `${reference.kind} is only available in fanout stages` }] };
          }
          if (reference.kind === "carry") {
            // Carry is resolved by `resolve()` during template rendering. It is NOT a
            // binding in the `expr` language, whose identifier set is closed at
            // eval/expr.ts:5,22 to result|input|item|prev — so it is illegal on any
            // expression-language field (R1-5).
            if (leaf.expression) {
              return { ok: false, errors: [{ code: "CARRY_REF_IN_EXPRESSION", path: leaf.path, message: "carry references are not available in expressions" }] };
            }
            carryUses.push({ name: reference.name, stepId: step.id, path: leaf.path });
          }
          const typeError = referenceTypeError(reference, leaf.path);
          if (typeError) return { ok: false, errors: [typeError] };
          if (reference.kind === "step") {
            for (const refEdge of referenceEdges(step.id, [extractedReference])) {
              const error = add({ ...refEdge, path: leaf.path });
              if (error) return { ok: false, errors: [error] };
            }
          }
        }
      }

      if (step.gate) {
        for (const key of ["on_approve", "on_kill"] as const) {
          const target = step.gate[key];
          if (target !== null) {
            const error = add({ from: step.id, to: target, path: formatPath([...base, "gate", key]) });
            if (error) return { ok: false, errors: [error] };
          }
        }
      }
    }

    for (const [index, step] of flow.steps.entries()) {
      // Fanout in non-entry flows is rejected later by the existing root-only
      // rule; preserve that stable diagnostic ahead of consumer-specific rules.
      if (flowName !== spec.flows.entry
        || step.fanout?.dispatch !== "consumer"
        || step.fanout.isolation !== "worktree") continue;
      for (const [stageIndex, stage] of step.fanout.steps.entries()) {
        const ensureIndex = stage.ensure?.findIndex((predicate) =>
          "file_exists" in predicate
          || "file_contains" in predicate
          || ("expr" in predicate && expressionUsesFilePredicate(predicate.expr))) ?? -1;
        if (ensureIndex >= 0) {
          return { ok: false, errors: [{
            code: "CONSUMER_WORKTREE_FILESYSTEM_UNSUPPORTED",
            path: `flows.${flowName}.steps[${index}].fanout.steps[${stageIndex}].ensure[${ensureIndex}]`,
            message: "consumer worktree stages cannot use engine filesystem predicates",
          }] };
        }
        if (stage.when !== undefined && expressionUsesFilePredicate(stage.when)) {
          return { ok: false, errors: [{
            code: "CONSUMER_WORKTREE_FILESYSTEM_UNSUPPORTED",
            path: `flows.${flowName}.steps[${index}].fanout.steps[${stageIndex}].when`,
            message: "consumer worktree stages cannot use engine filesystem predicates",
          }] };
        }
      }
      // The gate must be guaranteed to enter waiting_gate: a `when` can skip it
      // (engine advance), and a routing target (on_fail/on_approve/on_kill)
      // only activates when routed (engine.isActivated) — either would bypass
      // the mandatory merge handshake.
      const routedTargets = new Set<string>();
      for (const candidate of flow.steps) {
        if (candidate.on_fail !== undefined) routedTargets.add(candidate.on_fail);
        if (candidate.gate?.on_approve) routedTargets.add(candidate.gate.on_approve);
        if (candidate.gate?.on_kill) routedTargets.add(candidate.gate.on_kill);
      }
      const hasDirectGateSuccessor = flow.steps.some((candidate) =>
        candidate.gate !== undefined
        && candidate.when === undefined
        && !routedTargets.has(candidate.id)
        && dependencyIds(candidate).has(step.id));
      if (!hasDirectGateSuccessor) {
        return { ok: false, errors: [{
          code: "CONSUMER_WORKTREE_GATE_REQUIRED",
          path: `flows.${flowName}.steps[${index}].fanout.isolation`,
          message: "consumer worktree fanout requires an unconditional, normally-activated direct-successor gate",
        }] };
      }
    }

    for (const step of flow.steps) {
      for (const dependency of dependencyIds(step)) {
        if (!dependencyEdges.has(dependency)) dependencyEdges.set(dependency, new Set());
        dependencyEdges.get(dependency)!.add(step.id);
      }
    }
    const reachesByDependency = (from: string, target: string): boolean => {
      const queue = [from];
      const seen = new Set(queue);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === target) return true;
        for (const next of dependencyEdges.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      return false;
    };

    // --- STRAT-LOOP-CARRY ---------------------------------------------------
    // Carry is root-only (D5) and adds NO dependency edge, so ordering and reset
    // coverage are both proved statically here rather than discovered at runtime.
    const carry = flow.carry ?? {};
    const carryNames = new Set(Object.keys(carry));      // never `name in carry` — R1-11
    const carryPath = `flows.${flowName}.carry`;
    // Same construction the consumer-worktree rule uses at validate.ts:456-462; built once
    // here because the carry pass needs it too (R2-2).
    const routedTargets = new Set<string>();
    for (const candidate of flow.steps) {
      if (candidate.on_fail !== undefined) routedTargets.add(candidate.on_fail);
      if (candidate.gate?.on_approve) routedTargets.add(candidate.gate.on_approve);
      if (candidate.gate?.on_kill) routedTargets.add(candidate.gate.on_kill);
    }
    if (flow.carry !== undefined && flowName !== spec.flows.entry) {
      return { ok: false, errors: [{ code: "CARRY_ROOT_ONLY", path: carryPath, message: "carry may only be declared on the entry flow" }] };
    }

    // Exactly one full-value ${} reference of kind step|input (D2). Shape only — typing is a
    // separate step so the carry-specific rules can be reported before the generic ones (F1).
    const carryShape = (value: string, path: string): Reference | ValidationError => {
      const extracted = extractReferences(value);
      if (!extracted || extracted.length !== 1 || !extracted[0]!.fullValue) {
        return { code: "CARRY_REF_INVALID", path, message: "carry value must be one full reference" };
      }
      const reference = extracted[0]!.reference;
      if (reference.kind !== "step" && reference.kind !== "input") {
        return { code: "CARRY_REF_INVALID", path, message: "carry value must reference a step output or a flow input" };
      }
      return reference;
    };

    // Shape plus the same type rules an ordinary reference obeys (R1-3).
    const carryReference = (value: string, path: string): Reference | ValidationError => {
      const reference = carryShape(value, path);
      if ("code" in reference) return reference;
      return referenceTypeError(reference, path) ?? reference;
    };

    const carrySources = new Map<string, string | undefined>();   // name -> initial source step id
    for (const [name, declaration] of Object.entries(carry)) {
      if (name === "item" || name === "prev" || name === "input" || ids.has(name)) {
        return { ok: false, errors: [{ code: "CARRY_NAME_CONFLICT", path: `${carryPath}.${name}`, message: "carry name is reserved or collides with a step id" }] };
      }
      const initialPath = `${carryPath}.${name}.initial`;
      const initial = carryShape(declaration.initial, initialPath);
      if ("code" in initial) return { ok: false, errors: [initial] };
      if (initial.kind === "step" && ids.has(initial.stepId)) {
        // The initial source must be UNCONDITIONAL. Three ways a step can fail to run:
        //  - a `when` can skip it (engine advanceScopeLoop);
        //  - a gate step never produces an output;
        //  - a ROUTING target is inactive until routed (engine.isActivated, engine.ts:2217-2221)
        //    and can be skipped outright (unreachableOnFailTarget, :2210-2215) — and a skipped
        //    dependency satisfies its edge (dependenciesDone, :2287-2293), so ordering alone
        //    would not save it. R2-2.
        const source = ids.get(initial.stepId)!.step;
        if (source.when !== undefined || source.gate !== undefined || routedTargets.has(initial.stepId)) {
          return { ok: false, errors: [{ code: "CARRY_INITIAL_SOURCE_CONDITIONAL", path: initialPath, message: "carry initial source must be an unconditional, non-gate, non-routed step" }] };
        }
      }
      // Typing runs LAST: an unknown step, a missing out contract or a bad path are all
      // reported here, after the carry-specific conditional-source rule has had its say.
      const typeError = referenceTypeError(initial, initialPath);
      if (typeError) return { ok: false, errors: [typeError] };
      carrySources.set(name, initial.kind === "step" ? initial.stepId : undefined);
    }

    // Reference-side rules. carryUses was collected by the per-step loop (S01-6).
    for (const use of carryUses) {
      if (!carryNames.has(use.name)) {
        return { ok: false, errors: [{ code: "REF_UNKNOWN_CARRY", path: use.path, message: `unknown carry variable ${use.name}` }] };
      }
      const source = carrySources.get(use.name);
      if (source === undefined) continue;                       // input-sourced: available from step zero
      if (source === use.stepId || !reachesByDependency(source, use.stepId)) {
        return { ok: false, errors: [{ code: "CARRY_REF_BEFORE_INITIAL", path: use.path, message: `carry ${use.name} is not guaranteed materialised before ${use.stepId}` }] };
      }
    }

    // on_revise coverage (R1-1). A gate that rewrites a variable must also reset every
    // consumer of it, and must itself run after every consumer, or a step would keep a
    // rendering derived from a list that has just changed.
    for (const [name, declaration] of Object.entries(carry)) {
      const consumers = carryUses.filter((use) => use.name === name).map((use) => use.stepId);
      for (const [gateId, expression] of Object.entries(declaration.on_revise ?? {})) {
        const gatePath = `${carryPath}.${name}.on_revise.${gateId}`;
        const gateStep = ids.get(gateId)?.step;
        if (gateStep?.gate === undefined) {
          return { ok: false, errors: [{ code: "CARRY_UNKNOWN_GATE", path: gatePath, message: "on_revise key must be a gate step in this flow" }] };
        }
        const revise = carryReference(expression, gatePath);
        if ("code" in revise) return { ok: false, errors: [revise] };
        const target = gateStep.gate.on_revise;
        if (target === null) {
          return { ok: false, errors: [{ code: "CARRY_REVISE_TARGET_NULL", path: gatePath, message: "a gate that rewrites carry must have a revise target" }] };
        }
        // The target must be a real, non-self step BEFORE the closure is computed: running
        // resetClosure over an invalid target yields a closure that misses every consumer,
        // and CARRY_REVISE_MISSES_CONSUMER would mask the routing defect (F2). Same codes
        // and path the later reviseGates pass uses.
        const gateReviseIndex = ids.get(gateId)!.index;
        const gateRevisePath = `flows.${flowName}.steps[${gateReviseIndex}].gate.on_revise`;
        if (!ids.has(target)) {
          return { ok: false, errors: [{ code: "ROUTING_UNKNOWN_TARGET", path: gateRevisePath, message: "unknown revise target" }] };
        }
        if (target === gateId) {
          return { ok: false, errors: [{ code: "ROUTING_SELF_TARGET", path: gateRevisePath, message: "routing edge targets itself" }] };
        }
        const closure = resetClosure(flow, target);
        for (const consumer of consumers) {
          if (!closure.has(consumer)) {
            return { ok: false, errors: [{ code: "CARRY_REVISE_MISSES_CONSUMER", path: gatePath, message: `revise target ${target} does not reset ${consumer}, which reads ${name}` }] };
          }
          if (consumer !== gateId && !reachesByDependency(consumer, gateId)) {
            return { ok: false, errors: [{ code: "CARRY_REVISE_GATE_NOT_AFTER_CONSUMER", path: gatePath, message: `gate ${gateId} is not ordered after ${consumer}, which reads ${name}` }] };
          }
        }
      }
    }
    // --- end STRAT-LOOP-CARRY -----------------------------------------------

    const reviseGates = flow.steps.flatMap((step, index) => step.gate?.on_revise ? [{ step, index, target: step.gate.on_revise }] : []);
    if (reviseGates.length > 0 && flow.max_rounds === undefined) {
      const revise = reviseGates[0]!;
      return { ok: false, errors: [{ code: "GATE_REVISE_REQUIRES_MAX_ROUNDS", path: `flows.${flowName}.steps[${revise.index}].gate.on_revise`, message: "on_revise requires flow max_rounds" }] };
    }
    for (const revise of reviseGates) {
      if (!ids.has(revise.target)) return { ok: false, errors: [{ code: "ROUTING_UNKNOWN_TARGET", path: `flows.${flowName}.steps[${revise.index}].gate.on_revise`, message: "unknown revise target" }] };
      if (revise.target === revise.step.id) {
        return { ok: false, errors: [{ code: "ROUTING_SELF_TARGET", path: `flows.${flowName}.steps[${revise.index}].gate.on_revise`, message: "routing edge targets itself" }] };
      }
      if (!reaches(adjacency, revise.target, revise.step.id)) {
        return { ok: false, errors: [{ code: "GATE_REVISE_NOT_ANCESTOR", path: `flows.${flowName}.steps[${revise.index}].gate.on_revise`, message: "on_revise must target a strict ancestor" }] };
      }
    }

    const outputRefs = extractReferences(flow.output.from);
    if (!outputRefs || outputRefs.length !== 1 || !outputRefs[0]!.fullValue || outputRefs[0]!.reference.kind !== "step") {
      return { ok: false, errors: [{ code: "REF_INVALID", path: `flows.${flowName}.output.from`, message: "flow output must be a full step-output reference" }] };
    }
    const outputReference = outputRefs[0]!.reference;
    const source = ids.get(outputReference.stepId);
    if (!source) return { ok: false, errors: [{ code: "REF_UNKNOWN_STEP", path: `flows.${flowName}.output.from`, message: "unknown flow output source" }] };
    if (source.step.fanout !== undefined && !source.step.fanout.steps.at(-1)?.out) {
      return { ok: false, errors: [{ code: "FANOUT_OUTPUT_REQUIRES_FINAL_OUT", path: `flows.${flowName}.steps[${source.index}].fanout.steps[${source.step.fanout.steps.length - 1}].out`, message: "fanout output requires final stage out" }] };
    }
    const sourceContract = contractForStep(source.step, flows);
    if (!sourceContract) return { ok: false, errors: [{ code: "REF_OUTPUT_CONTRACT_REQUIRED", path: `flows.${flowName}.output.from`, message: "flow output source has no contract" }] };
    if (source.step.fanout !== undefined) {
      // Same array typing as ordinary refs — and the bare array itself can
      // never satisfy an object flow contract, so it must be indexed here.
      const [head, ...rest] = outputReference.path;
      if (typeof head !== "number" || !containsPathInContract(sourceContract, rest, parsed)) {
        return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: `flows.${flowName}.output.from`, message: "fanout output is an array — index it before using it as flow output" }] };
      }
    } else if (!containsPathInContract(sourceContract, outputReference.path, parsed)) {
      return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: `flows.${flowName}.output.from`, message: "unknown flow output path" }] };
    }
  }

  const calls = new Map<string, Array<{ target: string; path: string }>>();
  for (const [flowName, flow] of Object.entries(flows)) {
    const flowCalls: Array<{ target: string; path: string }> = [];
    for (const [index, step] of flow.steps.entries()) {
      if (step.run === undefined) continue;
      const path = `flows.${flowName}.steps[${index}].run`;
      const callee = flows[step.run];
      if (!callee) return { ok: false, errors: [{ code: "SUBFLOW_UNKNOWN", path, message: `unknown subflow ${step.run}` }] };
      const expected = Object.keys(callee.input).sort();
      const actual = Object.keys(step.with ?? {}).sort();
      if (expected.length !== actual.length || expected.some((key, keyIndex) => key !== actual[keyIndex])) {
        return { ok: false, errors: [{ code: "SUBFLOW_WITH_MISMATCH", path: `flows.${flowName}.steps[${index}].with`, message: "with keys must exactly match callee input" }] };
      }
      flowCalls.push({ target: step.run, path });
    }
    calls.set(flowName, flowCalls);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const walkCalls = (name: string): ValidationError | undefined => {
    visiting.add(name);
    for (const call of calls.get(name) ?? []) {
      if (visiting.has(call.target)) return { code: "SUBFLOW_RECURSIVE", path: call.path, message: "recursive subflow call" };
      if (!visited.has(call.target)) {
        const error = walkCalls(call.target);
        if (error) return error;
      }
    }
    visiting.delete(name);
    visited.add(name);
    return undefined;
  };
  for (const name of Object.keys(flows)) {
    if (!visited.has(name)) {
      const error = walkCalls(name);
      if (error) return { ok: false, errors: [error] };
    }
  }

  // One-level subflow gates are supported by the scoped gate state machine.
  // Fanout and nested run remain forbidden in EVERY non-entry flow, reachable
  // or not, so the v1 depth and fanout bounds stay intact.
  for (const [flowName, flow] of Object.entries(flows)) {
    if (flowName === spec.flows.entry) continue;
    for (const [index, step] of flow.steps.entries()) {
      const kind = step.fanout !== undefined ? "fanout" : step.run !== undefined ? "run" : undefined;
      if (kind !== undefined) {
        return { ok: false, errors: [{
          code: "SUBFLOW_BODY_RESTRICTED",
          path: `flows.${flowName}.steps[${index}].${kind}`,
          message: "non-entry flows may contain task steps only",
        }] };
      }
    }
  }

  return { ok: true, value: spec, contracts, inputs };
}
