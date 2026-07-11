import { describe, expect, it } from "vitest";
import type { ParMergeBounce } from "../../src/engine/state.js";
import { evaluateParallel, type TaskResult } from "../../src/parallel/evaluate.js";

function task(taskId: string, status: TaskResult["status"]): TaskResult {
  return { task_id: taskId, status };
}

function evaluate(tasks: TaskResult[], require: "all" | "any" | number) {
  return evaluateParallel({
    tasks,
    require,
    certTemplate: null,
    agentIsClaude: true,
    gateBounces: [],
    mergeStatus: "clean",
  });
}

describe("non-pipeline parallel evaluation require matrix", () => {
  const cases: Array<{
    name: string;
    require: "all" | "any" | number;
    tasks: TaskResult[];
    satisfied: boolean;
  }> = [
    { name: "all complete", require: "all", tasks: [task("a", "complete"), task("b", "complete")], satisfied: true },
    { name: "all with failed task", require: "all", tasks: [task("a", "complete"), task("b", "failed")], satisfied: false },
    { name: "all with skipped task", require: "all", tasks: [task("a", "complete"), task("b", "skipped")], satisfied: false },
    { name: "all with zero tasks", require: "all", tasks: [], satisfied: true },
    { name: "any with one complete", require: "any", tasks: [task("a", "complete"), task("b", "failed")], satisfied: true },
    { name: "any with no completed tasks", require: "any", tasks: [task("a", "failed"), task("b", "skipped")], satisfied: false },
    { name: "any with zero tasks", require: "any", tasks: [], satisfied: false },
    { name: "N with enough completed tasks", require: 2, tasks: [task("a", "complete"), task("b", "complete"), task("c", "failed")], satisfied: true },
    { name: "N with fractional requirement falls back to all semantics", require: 1.5, tasks: [task("a", "complete"), task("b", "complete"), task("c", "failed")], satisfied: false },
    { name: "N with too few completed tasks", require: 2, tasks: [task("a", "complete"), task("b", "skipped")], satisfied: false },
    { name: "N with zero tasks", require: 1, tasks: [], satisfied: false },
  ];

  it.each(cases)("$name", ({ require, tasks, satisfied }) => {
    const result = evaluate(tasks, require);
    expect(result.evaluation.require_satisfied).toBe(satisfied);
    expect(result.canAdvance).toBe(satisfied);
    expect(result.evaluation.aggregate.outcome).toBe(satisfied ? "complete" : "failed");
    if (require === "all" && tasks.some((task) => task.status === "skipped")) {
      expect(result.evaluation.failed.map((task) => task.task_id)).toContain("b");
    }
  });
});

describe("non-pipeline parallel evaluation certificates and merge state", () => {
  const certTemplate = { sections: [{ label: "Conclusion" }] };

  it("flips a cert-invalid complete task without mutating the submitted task", () => {
    const tasks = [task("cert-task", "complete")];
    const result = evaluateParallel({
      tasks,
      require: "all",
      certTemplate,
      agentIsClaude: true,
      gateBounces: [],
      mergeStatus: "clean",
    });

    expect(tasks[0]?.status).toBe("complete");
    expect(result.tasks[0]).toMatchObject({
      status: "failed",
      error: "cert validation: certificate missing section: Conclusion",
      cert_violations: ["certificate missing section: Conclusion"],
    });
    expect(result.evaluation.per_task_cert_strs).toEqual([
      "task 'cert-task' cert: certificate missing section: Conclusion",
    ]);
    expect(result.evaluation.aggregate.tasks).toBe(result.tasks);
  });

  it.each([
    { agentIsClaude: false, certTemplate },
    { agentIsClaude: true, certTemplate: null },
  ])("does not apply the certificate when claude gating is off", ({ agentIsClaude, certTemplate }) => {
    const result = evaluateParallel({
      tasks: [task("cert-task", "complete")],
      require: "all",
      certTemplate,
      agentIsClaude,
      gateBounces: [],
      mergeStatus: "clean",
    });
    expect(result.tasks[0]?.status).toBe("complete");
    expect(result.canAdvance).toBe(true);
  });

  it("blocks advancement on a merge conflict after requirements are satisfied", () => {
    const result = evaluateParallel({
      tasks: [task("a", "complete")],
      require: "all",
      certTemplate: null,
      agentIsClaude: true,
      gateBounces: [],
      mergeStatus: "conflict",
    });
    expect(result.evaluation.merge_ok).toBe(false);
    expect(result.canAdvance).toBe(false);
    expect(result.evaluation.aggregate.outcome).toBe("failed");
  });

  it("aggregates gate bounces before merge-conflict bounces with Python-compatible strings", () => {
    const gateBounce: ParMergeBounce = {
      taskId: "gate-task",
      reason: "gate_failed",
      files: [],
      command: "npm test",
      exitCode: 2,
      excerpt: "failed",
    };
    const conflictBounce: ParMergeBounce = {
      taskId: "merge-task",
      reason: "merge_conflict",
      files: ["a.ts", "b.ts"],
      command: "",
      exitCode: null,
      excerpt: "conflict",
    };
    const result = evaluateParallel({
      tasks: [task("a", "complete")],
      require: "all",
      certTemplate: null,
      agentIsClaude: true,
      gateBounces: [gateBounce],
      mergeStatus: { status: "clean", bounced_tasks: [conflictBounce] },
    });
    expect(result.evaluation.bounced_tasks).toEqual([gateBounce, conflictBounce]);
    expect(result.evaluation.per_task_cert_strs).toEqual([
      "task 'gate-task' failed pre-merge gate `npm test` (exit 2) — diff NOT merged",
      "task 'merge-task' merge conflict on a.ts, b.ts",
    ]);
  });
});
