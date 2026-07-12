import { readdir, readFile } from "node:fs/promises";
import { basename, join, parse as parsePath } from "node:path";
import { stringify } from "yaml";
import { validateSpec } from "../ir/validate.js";

export type EnsurePredicate =
  | { expr: string }
  | { file_exists: string }
  | { file_contains: { path: string; text: string } };

export interface ParsedTask {
  filename: string;
  stepId: string;
  title: string;
  description: string;
  isParallel: boolean;
  ensures: EnsurePredicate[];
  judgment: string[];
  needsTestsPass: boolean;
  needsLintClean: boolean;
}

export interface SpeckitSpecification {
  version: 1;
  contracts: { TaskResult: { done: "boolean"; tests_pass: "boolean?"; lint_clean: "boolean?" } };
  flows: Record<string, string | SpeckitFlow>;
}

interface SpeckitFlow {
  input: { project_context: "string" };
  output: { from: string; contract: "TaskResult" };
  steps: Array<{ id: string; do: string; out: "TaskResult"; ensure: EnsurePredicate[]; attempts: 3; after?: string[] }>;
}

export type SpeckitErrorKind = "no_tasks" | "step_id_collision" | "compile_error";

export class SpeckitCompileError extends Error {
  readonly kind: SpeckitErrorKind;

  constructor(kind: SpeckitErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "SpeckitCompileError";
  }
}

const FILE_EXISTS_RE = /^file\s+(\S+)\s+exists?$/i;
const FILE_CONTAINS_RE = /^file\s+(\S+)\s+contains?\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/i;
const TESTS_PASS_RE = /\btests?\b.*\bpass/i;
const LINT_RE = /(no lint errors?|lint (passes?|clean))/i;

export function criterionToEnsure(text: string): EnsurePredicate | null {
  const criterion = text.trim();
  const exists = FILE_EXISTS_RE.exec(criterion);
  if (exists?.[1]) return { file_exists: exists[1] };
  const contains = FILE_CONTAINS_RE.exec(criterion);
  if (contains?.[1]) {
    const substring = (contains[2] ?? contains[3] ?? contains[4]!).replaceAll("\"", "\\\"");
    return { file_contains: { path: contains[1], text: substring } };
  }
  if (TESTS_PASS_RE.test(criterion)) return { expr: "result.tests_pass == true" };
  if (LINT_RE.test(criterion)) return { expr: "result.lint_clean == true" };
  return null;
}

export function stepIdFromStem(stem: string): string {
  let slug = stem.toLowerCase().replace(/[^a-z0-9]/g, "_").replace(/^_+|_+$/g, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `t${slug}`;
  return slug || "task";
}

export async function parseTaskFile(path: string): Promise<ParsedTask> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  let titleRaw = "";
  let titleLineIndex = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trimStart().startsWith("#")) {
      titleRaw = line.trim().replace(/^#+\s*(?:Task:\s*)?/, "");
      titleLineIndex = index;
      break;
    }
  }
  const isParallel = /\[P\]/i.test(titleRaw);
  const title = titleRaw.replace(/\s*\[P\]\s*/gi, " ").trim();
  const criteriaStart = lines.findIndex((line) => /^#+\s*Acceptance Criteria/i.test(line));
  const description = lines.slice(titleLineIndex + 1, criteriaStart < 0 ? lines.length : criteriaStart).join("\n").trim();
  const rawCriteria: string[] = [];
  if (criteriaStart >= 0) {
    for (const line of lines.slice(criteriaStart + 1)) {
      const match = /^\s*-\s*\[[ xX]\]\s*(.+)/.exec(line);
      if (match?.[1]) rawCriteria.push(match[1].trim());
    }
  }
  const ensures: EnsurePredicate[] = [];
  const judgment: string[] = [];
  let needsTestsPass = false;
  let needsLintClean = false;
  for (const criterion of rawCriteria) {
    const ensure = criterionToEnsure(criterion);
    if (ensure === null) {
      judgment.push(criterion);
      continue;
    }
    ensures.push(ensure);
    if ("expr" in ensure && ensure.expr.includes("tests_pass")) needsTestsPass = true;
    if ("expr" in ensure && ensure.expr.includes("lint_clean")) needsLintClean = true;
  }
  return {
    filename: basename(path), stepId: stepIdFromStem(parsePath(path).name), title, description, isParallel,
    ensures, judgment, needsTestsPass, needsLintClean,
  };
}

export function buildDependencyGraph(tasks: readonly ParsedTask[]): Record<string, string[]> {
  const dependencies: Record<string, string[]> = {};
  let lastSequential: string | undefined;
  let currentParallelGroup: string[] = [];
  for (const task of tasks) {
    if (task.isParallel) {
      dependencies[task.stepId] = lastSequential ? [lastSequential] : [];
      currentParallelGroup.push(task.stepId);
      continue;
    }
    const after = currentParallelGroup.length > 0 ? [...currentParallelGroup] : lastSequential ? [lastSequential] : [];
    currentParallelGroup = [];
    dependencies[task.stepId] = after;
    lastSequential = task.stepId;
  }
  return dependencies;
}

export function buildSpec(tasks: readonly ParsedTask[], flowName = "tasks"): SpeckitSpecification {
  if (tasks.length === 0) throw new SpeckitCompileError("no_tasks", "No task files (*.md) supplied");
  // "entry" is the reserved string sentinel that names the entry flow; a computed
  // { entry: name, [name]: flow } would overwrite it with the flow object.
  if (flowName === "entry") throw new SpeckitCompileError("compile_error", "flow_name 'entry' is reserved (it names the entry-flow sentinel); choose another name");
  const dependencies = buildDependencyGraph(tasks);
  const steps: SpeckitFlow["steps"] = tasks.map((task) => {
    const intent = [task.title, ...(task.description ? [task.description] : []), ...(task.judgment.length ? [`Also verify: ${task.judgment.join("; ")}`] : [])].join("\n");
    const after = dependencies[task.stepId] ?? [];
    return {
      id: task.stepId,
      do: intent,
      out: "TaskResult",
      ensure: [...task.ensures, { expr: "result.done == true" }],
      attempts: 3,
      ...(after.length ? { after } : {}),
    };
  });
  const lastTask = tasks.at(-1)!;
  const flow: SpeckitFlow = {
    input: { project_context: "string" },
    output: { from: `\${${lastTask.stepId}.output}`, contract: "TaskResult" },
    steps,
  };
  return {
    version: 1,
    contracts: { TaskResult: { done: "boolean", tests_pass: "boolean?", lint_clean: "boolean?" } },
    flows: { entry: flowName, [flowName]: flow },
  };
}

export async function compileSpeckit(tasksDir: string, flowName = "tasks"): Promise<{ yaml: string; flowName: string; steps: Array<{ id: string; title: string; parallel: boolean; ensures: EnsurePredicate[]; judgment: string[] }> }> {
  const taskFiles = (await readdir(tasksDir)).filter((name) => name.endsWith(".md")).sort();
  if (taskFiles.length === 0) throw new SpeckitCompileError("no_tasks", `No task files (*.md) found in ${tasksDir}`);
  const tasks = await Promise.all(taskFiles.map((filename) => parseTaskFile(join(tasksDir, filename))));
  const seen = new Map<string, string>();
  for (const task of tasks) {
    const first = seen.get(task.stepId);
    if (first) {
      throw new SpeckitCompileError("step_id_collision", `Step ID collision: '${task.stepId}' from '${task.filename}' conflicts with '${first}'. Rename one of the files to produce a distinct step ID.`);
    }
    seen.set(task.stepId, task.filename);
  }
  const spec = buildSpec(tasks, flowName);
  // The tool's contract is "return YAML you pass straight to stratum_plan", so never
  // return `ok` with un-plannable IR. The most common cause is `${...}` in task text:
  // the TS engine interprets it as a reference (there is no literal escape), so
  // ordinary shell/template snippets fail REF_INVALID. Surface that at compile time.
  const validation = validateSpec(spec);
  if (!validation.ok) {
    const first = validation.errors[0];
    const detail = first ? `${first.code} at ${first.path}: ${first.message}` : "unknown validation error";
    throw new SpeckitCompileError("compile_error", `generated spec failed validation (${detail}). Task text containing '\${...}' template syntax is not supported by the TS engine's reference resolver — remove or reword it.`);
  }
  return {
    yaml: stringify(spec),
    flowName,
    steps: tasks.map((task) => ({ id: task.stepId, title: task.title, parallel: task.isParallel, ensures: task.ensures, judgment: task.judgment })),
  };
}
