import { z } from "zod";
import { extractReferences, referenceEdges, type PathSegment } from "./refs.js";
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
    return node.optional ? schema.optional() : schema;
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
    return node.optional ? schema.optional() : schema;
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

function referencesInStep(step: Step, base: readonly (string | number)[]): Array<{ value: string; path: string; fanoutStage: boolean }> {
  const result: Array<{ value: string; path: string; fanoutStage: boolean }> = [];
  const add = (value: unknown, path: readonly (string | number)[], fanoutStage = false) => {
    result.push(...leaves(value, path).map((leaf) => ({ ...leaf, fanoutStage })));
  };
  if (step.do !== undefined) add(step.do, [...base, "do"]);
  if (step.when !== undefined) add(step.when, [...base, "when"]);
  if (step.set !== undefined) add(step.set, [...base, "set"]);
  if (step.run !== undefined && step.with !== undefined) add(step.with, [...base, "with"]);
  if (step.fanout !== undefined) {
    add(step.fanout.over, [...base, "fanout", "over"]);
    step.fanout.steps.forEach((stage, index) => {
      add(stage.do, [...base, "fanout", "steps", index, "do"], true);
      if (stage.when !== undefined) add(stage.when, [...base, "fanout", "steps", index, "when"], true);
    });
  }
  return result;
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

function flowEntries(spec: Specification): Array<[string, Flow]> {
  return Object.entries(spec.flows).filter(([name]) => name !== "entry") as Array<[string, Flow]>;
}

function contractForStep(step: Step, flows: Record<string, Flow>): string | undefined {
  if (step.do !== undefined || step.set !== undefined) return step.out;
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
    const add = (edge: Edge): ValidationError | undefined => {
      if (!ids.has(edge.from)) return { code: "ROUTING_UNKNOWN_TARGET", path: edge.path, message: `unknown step ${edge.from}` };
      if (!ids.has(edge.to)) return { code: "ROUTING_UNKNOWN_TARGET", path: edge.path, message: `unknown step ${edge.to}` };
      return addEdge(adjacency, edge);
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

      for (const leaf of referencesInStep(step, base)) {
        const extracted = extractReferences(leaf.value);
        if (!extracted) return { ok: false, errors: [{ code: "REF_INVALID", path: leaf.path, message: "invalid reference syntax" }] };
        for (const extractedReference of extracted) {
          const reference = extractedReference.reference;
          if ((reference.kind === "item" || reference.kind === "prev") && !leaf.fanoutStage) {
            return { ok: false, errors: [{ code: "REF_INVALID_SCOPE", path: leaf.path, message: `${reference.kind} is only available in fanout stages` }] };
          }
          if (reference.kind === "input" && !containsPathInFields(inputFields, reference.path, parsed)) {
            return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: leaf.path, message: "unknown input path" }] };
          }
          if (reference.kind === "step") {
            const source = ids.get(reference.stepId);
            if (!source) return { ok: false, errors: [{ code: "REF_UNKNOWN_STEP", path: leaf.path, message: `unknown step ${reference.stepId}` }] };
            if (source.step.fanout !== undefined && !source.step.fanout.steps.at(-1)?.out) {
              return { ok: false, errors: [{ code: "FANOUT_OUTPUT_REQUIRES_FINAL_OUT", path: `flows.${flowName}.steps[${source.index}].fanout.steps[${source.step.fanout.steps.length - 1}].out`, message: "fanout output requires final stage out" }] };
            }
            const sourceContract = contractForStep(source.step, flows);
            if (!sourceContract) return { ok: false, errors: [{ code: "REF_OUTPUT_CONTRACT_REQUIRED", path: leaf.path, message: "referenced output requires an out contract" }] };
            if (source.step.fanout !== undefined) {
              // A fanout's output is the ARRAY of per-item final-stage outputs:
              // `${fan.output}` is the array itself, `${fan.output[0].field}`
              // indexes an element — a bare field path is a type error.
              const [head, ...rest] = reference.path;
              if (reference.path.length > 0 && (typeof head !== "number" || !containsPathInContract(sourceContract, rest, parsed))) {
                return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: leaf.path, message: "fanout output is an array — index it before accessing fields" }] };
              }
            } else if (!containsPathInContract(sourceContract, reference.path, parsed)) {
              return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: leaf.path, message: "unknown output path" }] };
            }
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

  // The v1 body restriction covers EVERY non-entry flow, reachable or not — an
  // unused flow must not validate with constructs it could never legally run.
  for (const [flowName, flow] of Object.entries(flows)) {
    if (flowName === spec.flows.entry) continue;
    for (const [index, step] of flow.steps.entries()) {
      const kind = step.gate !== undefined ? "gate" : step.fanout !== undefined ? "fanout" : step.run !== undefined ? "run" : undefined;
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
