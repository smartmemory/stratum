import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { validateSpec } from "../../src/ir/validate.js";
import {
  SpeckitCompileError, buildDependencyGraph, buildSpec, compileSpeckit, criterionToEnsure,
  parseTaskFile, stepIdFromStem, type ParsedTask,
} from "../../src/speckit/compiler.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function tempTasks(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-speckit-"));
  roots.push(root);
  return root;
}

async function taskFile(root: string, name: string, content: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, content);
  return path;
}

function task(stepId: string, isParallel = false): ParsedTask {
  return {
    filename: `${stepId}.md`, stepId, title: stepId, description: "", isParallel,
    ensures: [], judgment: [], needsTestsPass: false, needsLintClean: false,
  };
}

describe("criterionToEnsure", () => {
  it.each([
    ["file src/foo.ts exists", { file_exists: "src/foo.ts" }],
    ["file src/bar.py exist", { file_exists: "src/bar.py" }],
    ["File src/Foo.ts Exists", { file_exists: "src/Foo.ts" }],
    ["file src/foo.ts contains verifyJwt", { file_contains: { path: "src/foo.ts", text: "verifyJwt" } }],
    ['file src/foo.ts contains "some string"', { file_contains: { path: "src/foo.ts", text: "some string" } }],
    ["file src/foo.ts contains 'hello world'", { file_contains: { path: "src/foo.ts", text: "hello world" } }],
    ['file src/x.ts contains with"quotes', { file_contains: { path: "src/x.ts", text: 'with\\"quotes' } }],
    ["tests pass", { expr: "result.tests_pass == true" }],
    ["all tests pass", { expr: "result.tests_pass == true" }],
    ["test passes", { expr: "result.tests_pass == true" }],
    ["no lint errors", { expr: "result.lint_clean == true" }],
    ["lint passes", { expr: "result.lint_clean == true" }],
    ["lint clean", { expr: "result.lint_clean == true" }],
  ])("maps %s", (criterion, expected) => expect(criterionToEnsure(criterion)).toEqual(expected));

  it.each(["Middleware correctly rejects expired tokens", "", "   "])("leaves %j for judgment", (criterion) => {
    expect(criterionToEnsure(criterion)).toBeNull();
  });
});

describe("stepIdFromStem", () => {
  it.each([
    ["01-research", "t01_research"], ["02a-backend", "t02a_backend"], ["research", "research"],
    ["my_task", "my_task"], ["my task", "my_task"], ["MyTask", "mytask"], ["", "task"],
  ])("normalizes %j", (stem, expected) => expect(stepIdFromStem(stem)).toBe(expected));
});

describe("parseTaskFile", () => {
  it("ports title, body, marker, checkbox, criterion, and flag semantics", async () => {
    const root = await tempTasks();
    const path = await taskFile(root, "01-auth.md", [
      "# Task: [p] Implement authentication middleware", "", "Add JWT authentication middleware.", "",
      "## acceptance criteria", "", "- [ ] file src/auth.ts exists", "- [x] tests pass",
      "- [X] no lint errors", "- [ ] Middleware rejects expired tokens", "",
    ].join("\n"));
    expect(await parseTaskFile(path)).toEqual({
      filename: "01-auth.md", stepId: "t01_auth", title: "Implement authentication middleware",
      description: "Add JWT authentication middleware.", isParallel: true,
      ensures: [{ file_exists: "src/auth.ts" }, { expr: "result.tests_pass == true" }, { expr: "result.lint_clean == true" }],
      judgment: ["Middleware rejects expired tokens"], needsTestsPass: true, needsLintClean: true,
    });
  });

  it("parses a minimal task with no criteria", async () => {
    const root = await tempTasks();
    const parsed = await parseTaskFile(await taskFile(root, "quick.md", "# Task: Quick fix\n"));
    expect(parsed).toMatchObject({ title: "Quick fix", ensures: [], judgment: [], needsTestsPass: false, needsLintClean: false });
  });
});

describe("buildDependencyGraph", () => {
  it.each([
    [[task("t1")], { t1: [] }],
    [[task("t1"), task("t2")], { t1: [], t2: ["t1"] }],
    [[task("t1"), task("t2a", true), task("t2b", true)], { t1: [], t2a: ["t1"], t2b: ["t1"] }],
    [[task("t1"), task("t2a", true), task("t2b", true), task("t3")], { t1: [], t2a: ["t1"], t2b: ["t1"], t3: ["t2a", "t2b"] }],
    [[task("t1a", true), task("t1b", true)], { t1a: [], t1b: [] }],
    [[task("t1"), task("t2a", true), task("t2b", true), task("t3"), task("t4")], { t1: [], t2a: ["t1"], t2b: ["t1"], t3: ["t2a", "t2b"], t4: ["t3"] }],
  ])("builds the Python-parity dependency graph", (tasks, expected) => {
    expect(buildDependencyGraph(tasks)).toEqual(expected);
  });
});

describe("buildSpec and compileSpeckit", () => {
  it("emits the locked v1 contract, do-step shape, intent, ensures, attempts, and flow output", () => {
    const parsed = task("auth");
    parsed.title = "Build auth";
    parsed.description = "Add middleware.";
    parsed.ensures = [{ file_exists: "src/auth.ts" }];
    parsed.judgment = ["Reject expired tokens", "Preserve error details"];
    const spec = buildSpec([parsed], "delivery");
    expect(spec).toEqual({
      version: 1,
      contracts: { TaskResult: { done: "boolean", tests_pass: "boolean?", lint_clean: "boolean?" } },
      flows: { entry: "delivery", delivery: {
        input: { project_context: "string" }, output: { from: "${auth.output}", contract: "TaskResult" },
        steps: [{
          id: "auth", do: "Build auth\nAdd middleware.\nAlso verify: Reject expired tokens; Preserve error details",
          out: "TaskResult", ensure: [{ file_exists: "src/auth.ts" }, { expr: "result.done == true" }], attempts: 3,
        }],
      } },
    });
  });

  it("sorts tasks, preserves parallel dependencies, summarizes criteria, and round-trips through validateSpec", async () => {
    const root = await tempTasks();
    await taskFile(root, "03-final.md", "# Task: Finalize\n");
    await taskFile(root, "01-base.md", "# Task: Base\n\n## Acceptance Criteria\n\n- [ ] tests pass\n");
    await taskFile(root, "02b-docs.md", "# Task: [P] Docs\n");
    await taskFile(root, "02a-api.md", "# Task: [P] API\n\n## Acceptance Criteria\n\n- [ ] API remains compatible\n");
    const compiled = await compileSpeckit(root);
    expect(compiled.steps.map((step) => step.id)).toEqual(["t01_base", "t02a_api", "t02b_docs", "t03_final"]);
    expect(compiled.steps[0]!.ensures).toEqual([{ expr: "result.tests_pass == true" }]);
    expect(compiled.steps[1]!.judgment).toEqual(["API remains compatible"]);
    const document = parse(compiled.yaml) as Record<string, unknown>;
    expect(validateSpec(document).ok).toBe(true);
    const steps = ((document.flows as Record<string, unknown>).tasks as { steps: Array<Record<string, unknown>> }).steps;
    expect(steps.map((step) => step.after)).toEqual([undefined, ["t01_base"], ["t01_base"], ["t02a_api", "t02b_docs"]]);
  });

  it("rejects an empty task directory", async () => {
    const root = await tempTasks();
    await expect(compileSpeckit(root)).rejects.toMatchObject({ kind: "no_tasks", message: expect.stringContaining("No task files") });
  });

  it("rejects normalized step-id collisions and names both files", async () => {
    const root = await tempTasks();
    await taskFile(root, "01-a.md", "# Task: A\n");
    await taskFile(root, "01_a.md", "# Task: B\n");
    await expect(compileSpeckit(root)).rejects.toEqual(expect.objectContaining<Partial<SpeckitCompileError>>({
      kind: "step_id_collision", message: expect.stringMatching(/01-a\.md.*01_a\.md|01_a\.md.*01-a\.md/),
    }));
  });

  it("does not collide distinct normalized stems", async () => {
    const root = await tempTasks();
    await taskFile(root, "01-alpha.md", "# Task: Alpha\n");
    await taskFile(root, "01-beta.md", "# Task: Beta\n");
    await expect(compileSpeckit(root)).resolves.toMatchObject({ flowName: "tasks" });
  });

  it("never returns ok with un-plannable IR when task text carries ${...} template syntax", async () => {
    const root = await tempTasks();
    // The TS engine reads ${...} in `do` as a reference; ordinary shell snippets
    // like ${HOME} are not valid refs, so returning ok here would break compile→plan.
    await taskFile(root, "01-shell.md", "# Task: Print home\n\nRun `echo ${HOME}` to check the env.\n");
    await expect(compileSpeckit(root)).rejects.toMatchObject({ kind: "compile_error", message: expect.stringContaining("template syntax") });
  });

  it("rejects the reserved flow_name 'entry'", async () => {
    const root = await tempTasks();
    await taskFile(root, "01-task.md", "# Task: Build\n");
    await expect(compileSpeckit(root, "entry")).rejects.toMatchObject({ kind: "compile_error", message: expect.stringContaining("reserved") });
  });
});
