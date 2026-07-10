import { parseDocument } from "yaml";

export type CompatStatus = "supported" | "unsupported" | "diagnostic";

export interface CompatFinding {
  id: string;
  python: string;
  v1: string;
  note: string;
  status: CompatStatus;
  paths: string[];
}

export interface CompatReport {
  version?: string;
  findings: CompatFinding[];
}

interface Guidance {
  id: string;
  python: string;
  v1: string;
  note: string;
  status: CompatStatus;
}

// This is intentionally a usage classifier, not a transformation registry. The
// prose mirrors the v0.x -> v1 table in STRAT-TS-PORT/design.md so each report
// remains useful even when a legacy document is only partially valid.
const GUIDANCE: Guidance[] = [
  { id: "function-infer", python: "function decl mode: infer + step", v1: "task (agent from step; inline declaration)", note: "agent-dispatched", status: "supported" },
  { id: "function-compute", python: "function decl mode: compute + step", v1: "task (agent-dispatched)", note: "Python compute is dispatched; do not map it to set", status: "supported" },
  { id: "function-gate", python: "function decl mode: gate + step", v1: "gate construct", note: "carry routing fields", status: "supported" },
  { id: "inline", python: "inline step", v1: "task", note: "", status: "supported" },
  { id: "judge-fold", python: "judge deterministic/judged predicates", v1: "ensures on its single antecedent", note: "zero or multiple antecedents need a diagnostic", status: "diagnostic" },
  { id: "judge-unsupported", python: "judge verified/applied_gate/budgets", v1: "UNSUPPORTED", note: "fold manually or keep on Python", status: "unsupported" },
  { id: "iterate", python: "max_iterations + exit_criterion", v1: "iterate: { max, until }", note: "", status: "supported" },
  { id: "score-accumulate", python: "score_expr/accumulate/accumulate_key", v1: "UNSUPPORTED", note: "", status: "unsupported" },
  { id: "decompose", python: "decompose without task depends_on", v1: "task contract tasks: T[] plus fanout", note: "TaskGraph uses .tasks", status: "supported" },
  { id: "decompose-dependencies", python: "TaskGraph tasks with depends_on", v1: "UNSUPPORTED", note: "v1 fanout has no cross-item dependencies", status: "unsupported" },
  { id: "parallel-dispatch", python: "parallel_dispatch", v1: "fanout", note: "source/intent/concurrency/worktree-none/require/merge map by re-authoring", status: "supported" },
  { id: "parallel-unsupported", python: "branch/manual/reference pre_merge/certificates/timeouts/diff/deferred", v1: "UNSUPPORTED", note: "", status: "unsupported" },
  { id: "pipeline-when", python: "pipeline stages with when", v1: "fanout steps with when", note: "", status: "supported" },
  { id: "pipeline-nested", python: "pipeline stages with nested fanout/join regions", v1: "UNSUPPORTED", note: "flatten the region or keep on Python", status: "unsupported" },
  { id: "pipeline-exit", python: "pipeline exit_when", v1: "UNSUPPORTED", note: "not iterate.until", status: "unsupported" },
  { id: "subflow", python: "flow step", v1: "subflow run", note: "non-recursive", status: "supported" },
  { id: "max-rounds", python: "flow max_rounds", v1: "flow max_rounds", note: "same revise budget", status: "supported" },
  { id: "missing-max-rounds", python: "revise gate without flow max_rounds", v1: "explicit max_rounds", note: "start at 3; v1 forbids unlimited revision", status: "diagnostic" },
  { id: "depends-on", python: "depends_on", v1: "refs plus after", note: "retain dependencies not implied by refs", status: "supported" },
  { id: "skip-if", python: "skip_if", v1: "when", note: "invert its sense", status: "supported" },
  { id: "next", python: "next", v1: "DAG edges and gate routing", note: "irreducible jumps need a diagnostic", status: "diagnostic" },
  { id: "on-fail", python: "on_fail", v1: "on_fail to a topologically later step", note: "backward graphs are unsupported", status: "diagnostic" },
  { id: "ensure-expressions", python: "ensure/exit_criterion expressions", v1: "v1 expression grammar", note: "untranslatable expressions need a diagnostic", status: "diagnostic" },
  { id: "contracts", python: "contracts/output_schema", v1: "contract language", note: "only the enumerated type subset maps", status: "diagnostic" },
  { id: "flow-output", python: "route-dependent final output", v1: "output: { from, contract }", note: "requires a unique static terminal producer", status: "diagnostic" },
];

const guidanceById = new Map(GUIDANCE.map((item) => [item.id, item]));
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTaskDepends(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => record(item) && Array.isArray(item.depends_on) && item.depends_on.length > 0 || collectTaskDepends(item));
  if (!record(value)) return false;
  return Object.entries(value).some(([key, child]) => key !== "depends_on" && collectTaskDepends(child));
}

/** Classify a parsed Python-era IR without validating or translating it. */
export function checkLegacySpec(input: unknown): CompatReport {
  const found = new Map<string, string[]>();
  const add = (id: string, path: string) => {
    const paths = found.get(id) ?? [];
    paths.push(path);
    found.set(id, paths);
  };
  if (!record(input)) {
    return { findings: [{ id: "unreadable", python: "legacy document", v1: "none", note: "YAML root must be a mapping", status: "diagnostic", paths: ["root"] }] };
  }
  const version = typeof input.version === "string" || typeof input.version === "number" ? String(input.version) : undefined;
  if (version !== "0.1" && version !== "0.2" && version !== "0.3") add("unreadable", "version");
  if (record(input.contracts)) add("contracts", "contracts");
  const functions = record(input.functions) ? input.functions : {};
  for (const [name, definition] of Object.entries(functions)) {
    if (!record(definition)) continue;
    const mode = definition.mode;
    if (mode === "infer") add("function-infer", `functions.${name}.mode`);
    if (mode === "compute") add("function-compute", `functions.${name}.mode`);
    if (mode === "gate") add("function-gate", `functions.${name}.mode`);
    if (Array.isArray(definition.ensure)) add("ensure-expressions", `functions.${name}.ensure`);
  }
  const flows = record(input.flows) ? input.flows : {};
  for (const [name, flow] of Object.entries(flows)) {
    if (!record(flow)) continue;
    const flowPath = `flows.${name}`;
    if (flow.max_rounds !== undefined) add("max-rounds", `${flowPath}.max_rounds`);
    if (flow.output !== undefined) add("flow-output", `${flowPath}.output`);
    const steps = Array.isArray(flow.steps) ? flow.steps : [];
    for (const [index, step] of steps.entries()) {
      if (!record(step)) continue;
      const stepPath = `${flowPath}.steps[${index}]`;
      const type = step.type;
      if (type === "inline" || step.intent !== undefined && step.function === undefined && step.flow === undefined) add("inline", stepPath);
      if (type === "flow" || step.flow !== undefined) add("subflow", stepPath);
      if (type === "decompose") add(collectTaskDepends(step) ? "decompose-dependencies" : "decompose", stepPath);
      if (type === "parallel_dispatch") {
        add("parallel-dispatch", stepPath);
        if (step.isolation === "branch" || step.merge === "manual" || typeof step.pre_merge_verify === "string" || step.reasoning_template !== undefined || step.task_reasoning_template !== undefined || step.task_timeout !== undefined || step.capture_diff === true || step.defer_advance === true) add("parallel-unsupported", stepPath);
      }
      if (type === "pipeline") {
        const stages = Array.isArray(step.stages) ? step.stages : [];
        if (stages.some((stage) => record(stage) && stage.when !== undefined)) add("pipeline-when", `${stepPath}.stages`);
        if (stages.some((stage) => record(stage) && stage.exit_when !== undefined)) add("pipeline-exit", `${stepPath}.stages`);
        if (stages.some((stage) => record(stage) && (stage.fanout !== undefined || stage.join !== undefined))) add("pipeline-nested", `${stepPath}.stages`);
      }
      if (record(step.judge)) {
        const predicates = Array.isArray(step.judge.predicates) ? step.judge.predicates : [];
        if (predicates.some((predicate) => record(predicate) && (predicate.type === "deterministic" || predicate.type === "judged"))) add("judge-fold", `${stepPath}.judge.predicates`);
        if (step.judge.budget !== undefined || predicates.some((predicate) => record(predicate) && (predicate.type === "verified" || predicate.applied_gate !== undefined))) add("judge-unsupported", `${stepPath}.judge`);
      }
      if (step.max_iterations !== undefined || step.exit_criterion !== undefined) add("iterate", stepPath);
      if (step.exit_criterion !== undefined || Array.isArray(step.ensure)) add("ensure-expressions", stepPath);
      if (step.score_expr !== undefined || step.accumulate !== undefined || step.accumulate_key !== undefined) add("score-accumulate", stepPath);
      if (Array.isArray(step.depends_on) && step.depends_on.length) add("depends-on", `${stepPath}.depends_on`);
      if (step.skip_if !== undefined) add("skip-if", `${stepPath}.skip_if`);
      if (step.next !== undefined) add("next", `${stepPath}.next`);
      if (step.on_fail !== undefined) add("on-fail", `${stepPath}.on_fail`);
      if (step.output_schema !== undefined || step.output_contract !== undefined) add("contracts", stepPath);
      if (step.on_revise !== undefined && flow.max_rounds === undefined) add("missing-max-rounds", `${stepPath}.on_revise`);
    }
  }
  const findings = [...found.entries()].map(([id, paths]) => {
    if (id === "unreadable") return { id, python: "legacy document", v1: "none", note: "expected version 0.1, 0.2, or 0.3", status: "diagnostic" as const, paths };
    const item = guidanceById.get(id)!;
    return { ...item, paths };
  });
  return { ...(version ? { version } : {}), findings };
}

/** Parse YAML only; any parse failure is a report diagnostic, never an exception. */
export function checkLegacyYaml(source: string): CompatReport {
  const document = parseDocument(source, { prettyErrors: false });
  if (document.errors.length > 0) {
    return { findings: [{ id: "unreadable", python: "legacy document", v1: "none", note: document.errors.map((error) => error.message).join("; "), status: "diagnostic", paths: ["root"] }] };
  }
  return checkLegacySpec(document.toJS());
}

export function renderCompatReport(report: CompatReport): string {
  const heading = `stratum migrate --check${report.version ? ` (v${report.version})` : ""}`;
  const lines = [heading, "report-only: no YAML was emitted or translated"];
  if (report.findings.length === 0) lines.push("No mapped legacy constructs found.");
  for (const finding of report.findings) {
    lines.push(`- [${finding.status.toUpperCase()}] ${finding.python} -> ${finding.v1}`);
    if (finding.note) lines.push(`  ${finding.note}`);
    lines.push(`  at: ${finding.paths.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
