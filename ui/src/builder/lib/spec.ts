/**
 * Builder model (STRAT-UI-BUILDER-1). The builder's state IS a Stratum specification
 * document (`ts/src/ir/schema.ts` SpecificationSchema v1), edited in place:
 *
 *  - every step stays in the engine's own shape, ONE kind key per step (`do` | `set` |
 *    `gate` | `fanout` | `run` | `evaluate`, `ir/schema.ts:91-96`), with only that kind's
 *    allowed fields (`:82-89`). The kind is derived from which key is present, never stored;
 *  - import keeps the document as given and export hands it back, so a real spec round-trips
 *    deep-equal (fields the forms do not show are carried untouched);
 *  - layout (node positions) lives beside the document, never in it: the strict schema
 *    rejects unknown keys.
 *
 * Validation is NOT re-implemented here. The host's DataClient runs the engine's
 * `validateSpec()` (`ir/validate.ts:348`); `pinErrors` only maps its `{code, path, message}`
 * errors onto steps by `path`.
 */

export type StepKind = "do" | "set" | "gate" | "fanout" | "run" | "evaluate";
export const KINDS: readonly StepKind[] = ["do", "set", "gate", "fanout", "run", "evaluate"];

/** Allowed agents (`ts/src/connectors/base.ts` AGENT_TYPES). Shown as options, not enforced. */
export const AGENTS = ["claude", "codex", "devin"] as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RawStep = { id: string; after?: string[]; when?: string; [key: string]: unknown };
export interface RawFlow {
  input: Record<string, string>;
  output: { from: string; contract: string };
  max_rounds?: number;
  budget?: Record<string, number>;
  carry?: Record<string, unknown>;
  steps: RawStep[];
  [key: string]: unknown;
}
export interface RawSpec {
  version: 1;
  contracts: Record<string, Record<string, string>>;
  flows: { entry: string; [flowName: string]: RawFlow | string };
}

/** What the builder holds: the document plus which flow is on the canvas. */
export interface BuilderDoc {
  spec: RawSpec;
  flowName: string;
}

export const KIND_META: Record<StepKind, { blurb: string; tone: string }> = {
  do: { blurb: "invoke an agent", tone: "#38bdf8" },
  set: { blurb: "assign values", tone: "#94a3b8" },
  gate: { blurb: "human approval", tone: "#a78bfa" },
  fanout: { blurb: "parallel branches", tone: "#22d3ee" },
  run: { blurb: "nested sub-flow", tone: "#fbbf24" },
  evaluate: { blurb: "run a command", tone: "#34d399" },
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The step's kind, or null when it has zero or several kind keys (the engine's E2_CONSTRUCT_MIX). */
export function stepKind(step: Record<string, unknown>): StepKind | null {
  const kinds = KINDS.filter((kind) => step[kind] !== undefined);
  return kinds.length === 1 ? kinds[0]! : null;
}

export function flowNames(spec: RawSpec): string[] {
  return Object.keys(spec.flows).filter((name) => name !== "entry");
}

export function getFlow(doc: BuilderDoc): RawFlow {
  return doc.spec.flows[doc.flowName] as RawFlow;
}

// ---------------------------------------------------------------- import / export

/**
 * Accept a document (or a run file, whose `spec` is the document). Checks only the envelope
 * the canvas needs to draw; everything else is left for `validateSpec` to judge, and nothing
 * is rewritten.
 */
export function parseImport(input: unknown): BuilderDoc {
  const doc = (input && typeof input === "object" && "spec" in input && !("version" in input))
    ? (input as { spec: unknown }).spec
    : input;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Expected a JSON object");
  const spec = doc as Record<string, unknown>;
  if (spec.version !== 1) throw new Error('Expected "version": 1');
  const flows = spec.flows as Record<string, unknown> | undefined;
  if (!flows || typeof flows !== "object" || Array.isArray(flows)) throw new Error('Expected a "flows" map');
  const entry = flows.entry;
  if (typeof entry !== "string" || !flows[entry] || typeof flows[entry] !== "object") {
    throw new Error(`flows.entry "${String(entry)}" does not name a flow in "flows"`);
  }
  for (const name of Object.keys(flows)) {
    if (name === "entry") continue;
    const steps = (flows[name] as { steps?: unknown }).steps;
    if (!Array.isArray(steps)) throw new Error(`flows.${name}.steps must be an array`);
    steps.forEach((step, index) => {
      if (!step || typeof step !== "object" || typeof (step as { id?: unknown }).id !== "string") {
        throw new Error(`flows.${name}.steps[${index}] needs a string "id"`);
      }
    });
  }
  return { spec: clone(doc) as RawSpec, flowName: entry };
}

/** The document to hand the engine: exactly the spec, nothing the builder added. */
export function buildExport(doc: BuilderDoc): RawSpec {
  return clone(doc.spec);
}

// ---------------------------------------------------------------- new documents and steps

export function emptySpec(flowName = "main"): RawSpec {
  return {
    version: 1,
    contracts: { Result: { summary: "string" } },
    flows: { entry: flowName, [flowName]: { input: {}, output: { from: "", contract: "Result" }, steps: [] } },
  };
}

/**
 * A fresh step of one kind: exactly one kind key, and the fields the schema REQUIRES for it
 * (gate's three routes, fanout's six, run's `with`, evaluate's command + timeout). Values the
 * user must still choose are left empty so `validateSpec` points at them.
 */
export function defaultStep(kind: StepKind, id: string): RawStep {
  switch (kind) {
    case "do": return { id, do: "", agent: "claude" };
    case "set": return { id, set: {}, out: "" };
    case "gate": return { id, gate: { on_approve: null, on_revise: null, on_kill: null } };
    case "fanout": return { id, fanout: { over: "", steps: [{ do: "" }], concurrency: 2, isolation: "none", require: "all", merge: "sequential" } };
    case "run": return { id, run: "", with: {} };
    case "evaluate": return { id, evaluate: { command: "", timeout_ms: 60000 } };
  }
}

export function nextStepId(kind: StepKind, steps: RawStep[]): string {
  let i = 1;
  while (steps.some((step) => step.id === `${kind}_${i}`)) i += 1;
  return `${kind}_${i}`;
}

// ---------------------------------------------------------------- field editing

export type FieldType = "text" | "textarea" | "number" | "enum" | "target" | "contract" | "flow" | "json" | "list" | "require";
/** `empty`: what clearing the field writes. `delete` drops the key, `null` writes null (gate
 *  routes are required-nullable), `string` keeps "" (a required string the user must fill). */
export interface FieldDef {
  path: string[];
  label: string;
  type: FieldType;
  empty: "delete" | "null" | "string";
  options?: readonly string[];
  hint?: string;
}

const f = (path: string, label: string, type: FieldType, empty: FieldDef["empty"], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ path: path.split("."), label, type, empty, ...extra });

/** Per-kind forms. Every path is a field `STEP_FIELDS` (`ir/schema.ts:82-89`) allows for that kind. */
export const KIND_FIELDS: Record<StepKind, FieldDef[]> = {
  do: [
    f("do", "do (instruction)", "textarea", "string"),
    f("agent", "agent", "enum", "delete", { options: AGENTS }),
    f("out", "out (contract)", "contract", "delete"),
    f("attempts", "attempts", "number", "delete"),
    f("on_fail", "on_fail", "target", "delete"),
    f("ensure", "ensure", "json", "delete", { hint: '[{"expr": "…"}]' }),
    f("iterate", "iterate", "json", "delete", { hint: '{"max": 3, "until": "…"}' }),
    f("budget", "budget", "json", "delete", { hint: '{"usd": 1}' }),
  ],
  set: [
    f("set", "set", "json", "string", { hint: "field → value" }),
    f("out", "out (contract)", "contract", "delete"),
    f("ensure", "ensure", "json", "delete"),
  ],
  gate: [
    f("gate.on_approve", "on_approve", "target", "null"),
    f("gate.on_revise", "on_revise (back-edge)", "target", "null"),
    f("gate.on_kill", "on_kill", "target", "null"),
    f("gate.max_rounds", "max_rounds", "number", "delete"),
  ],
  fanout: [
    f("fanout.over", "over", "text", "string", { hint: "${step.output.list}" }),
    f("fanout.steps", "stages", "json", "string", { hint: '[{"do": "…", "out": "…"}]' }),
    f("fanout.concurrency", "concurrency", "number", "delete"),
    f("fanout.isolation", "isolation", "enum", "delete", { options: ["none", "worktree"] }),
    f("fanout.require", "require", "require", "delete", { hint: "all | any | n" }),
    f("fanout.merge", "merge", "enum", "delete", { options: ["sequential"] }),
    f("fanout.dispatch", "dispatch", "enum", "delete", { options: ["engine", "consumer"] }),
    f("fanout.pre_merge", "pre_merge", "list", "delete"),
    f("attempts", "attempts", "number", "delete"),
    f("on_fail", "on_fail", "target", "delete"),
    f("budget", "budget", "json", "delete"),
  ],
  run: [
    f("run", "run (flow)", "flow", "string"),
    f("with", "with", "json", "string", { hint: "callee input → value" }),
    f("on_fail", "on_fail", "target", "delete"),
    f("budget", "budget", "json", "delete"),
  ],
  evaluate: [
    f("evaluate.command", "command", "text", "string"),
    f("evaluate.in", "in", "text", "delete"),
    f("evaluate.timeout_ms", "timeout_ms", "number", "delete"),
    f("out", "out (contract)", "contract", "delete"),
  ],
};

export function getAt(value: unknown, path: string[]): unknown {
  let cur = value as Record<string, unknown> | undefined;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[key] as Record<string, unknown> | undefined;
  }
  return cur;
}

/** Immutable set; `undefined` deletes the key. Parents along the path are copied, not created. */
export function setAt<T extends Record<string, unknown>>(obj: T, path: string[], value: unknown): T {
  const [head, ...rest] = path;
  const copy = { ...obj } as Record<string, unknown>;
  if (!rest.length) {
    if (value === undefined) delete copy[head!];
    else copy[head!] = value;
    return copy as T;
  }
  const child = copy[head!];
  copy[head!] = setAt((child && typeof child === "object" ? child : {}) as Record<string, unknown>, rest, value);
  return copy as T;
}

/** Turn a form input into the value to store, honouring the field's empty rule. */
export function fieldValue(def: FieldDef, raw: unknown): unknown {
  const blank = raw === "" || raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0);
  if (blank) return def.empty === "delete" ? undefined : def.empty === "null" ? null : (def.type === "json" ? {} : "");
  if (def.type === "number") return Number(raw);
  if (def.type === "require") return /^\d+$/.test(String(raw)) ? Number(raw) : String(raw);
  return raw;
}

// ---------------------------------------------------------------- flow edits

function mapFlow(doc: BuilderDoc, update: (flow: RawFlow) => RawFlow): BuilderDoc {
  return { ...doc, spec: { ...doc.spec, flows: { ...doc.spec.flows, [doc.flowName]: update(getFlow(doc)) } } };
}

export function updateFlow(doc: BuilderDoc, patch: Partial<RawFlow>): BuilderDoc {
  return mapFlow(doc, (flow) => {
    const next = { ...flow, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    return next as RawFlow;
  });
}

export function updateSpec(doc: BuilderDoc, patch: Partial<Pick<RawSpec, "contracts">>): BuilderDoc {
  return { ...doc, spec: { ...doc.spec, ...patch } };
}

export function addStep(doc: BuilderDoc, kind: StepKind, after: string[] = []): { doc: BuilderDoc; id: string } {
  const flow = getFlow(doc);
  const id = nextStepId(kind, flow.steps);
  const step = defaultStep(kind, id);
  const { id: _id, ...fields } = step;
  const placed: RawStep = after.length ? { id, after, ...fields } : step;
  return { doc: mapFlow(doc, (fl) => ({ ...fl, steps: [...fl.steps, placed] })), id };
}

export function updateStep(doc: BuilderDoc, id: string, update: (step: RawStep) => RawStep): BuilderDoc {
  return mapFlow(doc, (flow) => ({ ...flow, steps: flow.steps.map((step) => (step.id === id ? update(step) : step)) }));
}

/** Add `from` to `to`'s `after` (a canvas port drag). */
export function connectAfter(doc: BuilderDoc, from: string, to: string): BuilderDoc {
  if (from === to) return doc;
  return updateStep(doc, to, (step) => (step.after ?? []).includes(from) ? step : { ...step, after: [...(step.after ?? []), from] });
}

export function setAfter(doc: BuilderDoc, id: string, after: string[]): BuilderDoc {
  return updateStep(doc, id, (step) => setAt(step, ["after"], after.length ? after : undefined));
}

const ROUTE_KEYS = ["on_approve", "on_revise", "on_kill"] as const;

function rewriteRefs(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.split(`\${${from}.output`).join(`\${${to}.output`);
  if (Array.isArray(value)) return value.map((entry) => rewriteRefs(entry, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteRefs(entry, from, to)]));
  }
  return value;
}

/** Rename a step and every reference to it in this flow: after, on_fail, gate routes, `${id.output…}` strings, output.from. */
export function renameStep(doc: BuilderDoc, from: string, to: string): BuilderDoc {
  const flow = getFlow(doc);
  if (!to || from === to || flow.steps.some((step) => step.id === to)) return doc;
  return mapFlow(doc, (fl) => ({
    ...fl,
    output: { ...fl.output, from: rewriteRefs(fl.output?.from, from, to) as string },
    steps: fl.steps.map((step) => {
      let next = rewriteRefs(step, from, to) as RawStep;
      if (next.id === from) next = { ...next, id: to };
      if (next.after) next = { ...next, after: next.after.map((dep) => (dep === from ? to : dep)) };
      if (next.on_fail === from) next = { ...next, on_fail: to };
      const gate = next.gate as Record<string, unknown> | undefined;
      if (gate) {
        const routed = { ...gate };
        for (const key of ROUTE_KEYS) if (routed[key] === from) routed[key] = to;
        next = { ...next, gate: routed };
      }
      return next;
    }),
  }));
}

/** Delete a step; drop it from `after`, clear routes to it. References inside strings are left for validation to flag. */
export function deleteStep(doc: BuilderDoc, id: string): BuilderDoc {
  return mapFlow(doc, (flow) => ({
    ...flow,
    steps: flow.steps.filter((step) => step.id !== id).map((step) => {
      let next = step;
      if (next.after?.includes(id)) next = setAt(next, ["after"], next.after.filter((dep) => dep !== id).length ? next.after.filter((dep) => dep !== id) : undefined);
      if (next.on_fail === id) next = setAt(next, ["on_fail"], undefined);
      const gate = next.gate as Record<string, unknown> | undefined;
      if (gate && ROUTE_KEYS.some((key) => gate[key] === id)) {
        const routed = { ...gate };
        for (const key of ROUTE_KEYS) if (routed[key] === id) routed[key] = null;
        next = { ...next, gate: routed };
      }
      return next;
    }),
  }));
}

// ---------------------------------------------------------------- validation errors → nodes

export interface ValidationError { code: string; path: string; message: string }
export interface PinnedErrors {
  /** flow name → step id → errors. */
  steps: Record<string, Record<string, ValidationError[]>>;
  /** Errors on the document, a flow's input/output, or contracts (no step in the path). */
  other: ValidationError[];
}

const STEP_PATH = /^flows\.(.+?)\.steps\[(\d+)\]/;

/** Which flow and step an error's `path` names (`flows.<flow>.steps[<i>]…`), or null. */
export function errorTarget(spec: RawSpec, path: string): { flowName: string; stepId: string } | null {
  const match = STEP_PATH.exec(path);
  if (!match) return null;
  const flow = spec.flows[match[1]!];
  if (!flow || typeof flow === "string") return null;
  const step = flow.steps[Number(match[2])];
  return step ? { flowName: match[1]!, stepId: step.id } : null;
}

export function pinErrors(spec: RawSpec, errors: ValidationError[]): PinnedErrors {
  const pinned: PinnedErrors = { steps: {}, other: [] };
  for (const error of errors) {
    const target = errorTarget(spec, error.path);
    if (!target) { pinned.other.push(error); continue; }
    const byStep = (pinned.steps[target.flowName] ??= {});
    (byStep[target.stepId] ??= []).push(error);
  }
  return pinned;
}

/** Input to prefill the dry-plan dialog from the entry flow's input contract. Optional fields are left out. */
export function sampleInput(spec: RawSpec): Record<string, unknown> {
  const flow = spec.flows[spec.flows.entry];
  if (!flow || typeof flow === "string") return {};
  const out: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(flow.input ?? {})) {
    if (typeof type !== "string" || type.endsWith("?")) continue;
    out[field] = type.endsWith("[]") || type === "array" ? [] : type === "object" ? {} : type === "boolean" ? false : type === "number" || type === "integer" ? 0 : "";
  }
  return out;
}

export function stepSummary(step: RawStep): string {
  const s = step as Record<string, any>;
  switch (stepKind(s)) {
    case "do": return [s.agent, s.out && `→ ${s.out}`].filter(Boolean).join(" ") || String(s.do || "").slice(0, 60) || "no instruction";
    case "set": return Object.keys(s.set || {}).join(", ") || "no assignment";
    case "gate": return `approve → ${s.gate?.on_approve || "—"}`;
    case "fanout": return `over ${s.fanout?.over || "—"} · ${(s.fanout?.steps || []).length} stage(s)`;
    case "run": return s.run ? `run ${s.run}` : "no sub-flow";
    case "evaluate": return s.evaluate?.command || "no command";
    default: return "invalid: needs exactly one kind";
  }
}
