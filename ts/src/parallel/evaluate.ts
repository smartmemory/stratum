import type { ParMergeBounce } from "../engine/state.js";
import { type CertTemplate, validateCertificate } from "./certificate.js";

// Non-pipeline only; pipeline-mode (step_type: pipeline) is a v1 capability
// delta deferred to a follow-up (verified no compose consumer drives it).

/** Wire shape submitted by Compose for one parallel task. */
export interface TaskResult {
  task_id: string;
  status: "complete" | "failed" | "cancelled" | "skipped" | string;
  result?: Record<string, unknown>;
  error?: string;
  cert_violations?: string[];
}

export interface ParallelAggregate {
  tasks: TaskResult[];
  merge_status: string;
  completed: TaskResult[];
  failed: TaskResult[];
  outcome: "complete" | "failed";
}

export interface ParallelEvaluation {
  aggregate: ParallelAggregate;
  per_task_cert_strs: string[];
  bounced_tasks: ParMergeBounce[];
  require: "all" | "any" | number;
  completed: TaskResult[];
  failed: TaskResult[];
  require_satisfied: boolean;
  merge_ok: boolean;
}

export interface EvaluateParallelInput {
  tasks: TaskResult[];
  require: "all" | "any" | number;
  certTemplate: CertTemplate | null;
  agentIsClaude: boolean;
  gateBounces: ParMergeBounce[];
  mergeStatus: string | { status?: string; bounced_tasks?: ParMergeBounce[] };
}

/** Evaluate a non-pipeline parallel_dispatch result without mutating its input. */
export function evaluateParallel(input: EvaluateParallelInput): {
  canAdvance: boolean;
  tasks: TaskResult[];
  evaluation: ParallelEvaluation;
} {
  const [mergeStatusStr, conflictBounces] = normalizeMergeStatus(input.mergeStatus);
  const bouncedTasks = [...input.gateBounces, ...conflictBounces];
  const effectiveCert = input.certTemplate && input.agentIsClaude ? input.certTemplate : null;
  const perTaskCertStrs: string[] = [];

  const tasks = input.tasks.map((task) => {
    if (task.status !== "complete" || effectiveCert === null) return { ...task };
    const violations = validateCertificate(effectiveCert, task.result ?? {});
    if (violations.length === 0) return { ...task };

    perTaskCertStrs.push(`task '${task.task_id}' cert: ${violations.join("; ")}`);
    return {
      ...task,
      status: "failed",
      error: `cert validation: ${violations.join("; ")}`,
      cert_violations: violations,
    };
  });

  const completed = tasks.filter((task) => task.status === "complete");
  // Non-pipeline skipped tasks remain failures so clients cannot bypass require:all.
  const failed = tasks.filter((task) => task.status !== "complete");
  const requireSatisfied = isRequireSatisfied(input.require, completed, failed);
  const mergeOk = mergeStatusStr !== "conflict";

  for (const bounce of bouncedTasks) {
    if (bounce.reason === "gate_failed") {
      perTaskCertStrs.push(
        `task '${bounce.taskId}' failed pre-merge gate \`${bounce.command}\` `
        + `(exit ${pythonValue(bounce.exitCode)}) — diff NOT merged`,
      );
    } else if (bounce.reason === "merge_conflict") {
      const files = bounce.files.join(", ") || "(unknown files)";
      perTaskCertStrs.push(`task '${bounce.taskId}' merge conflict on ${files}`);
    }
  }

  const aggregate: ParallelAggregate = {
    tasks,
    merge_status: mergeStatusStr,
    completed,
    failed,
    outcome: requireSatisfied && mergeOk ? "complete" : "failed",
  };
  const evaluation: ParallelEvaluation = {
    aggregate,
    per_task_cert_strs: perTaskCertStrs,
    bounced_tasks: bouncedTasks,
    require: input.require,
    completed,
    failed,
    require_satisfied: requireSatisfied,
    merge_ok: mergeOk,
  };

  return { canAdvance: requireSatisfied && mergeOk, tasks, evaluation };
}

function normalizeMergeStatus(
  mergeStatus: EvaluateParallelInput["mergeStatus"],
): [string, ParMergeBounce[]] {
  if (typeof mergeStatus === "string") return [mergeStatus, []];
  return [mergeStatus.status ?? "clean", mergeStatus.bounced_tasks ?? []];
}

function isRequireSatisfied(
  require: "all" | "any" | number,
  completed: TaskResult[],
  failed: TaskResult[],
): boolean {
  if (require === "all") return failed.length === 0;
  if (require === "any") return completed.length > 0;
  if (typeof require === "number" && Number.isInteger(require)) return completed.length >= require;
  return failed.length === 0;
}

function pythonValue(value: number | null): number | "None" {
  return value ?? "None";
}
